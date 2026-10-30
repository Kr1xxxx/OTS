const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Opened outside the Mac app's local server, the page must not run a browser-storage copy of the app.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const requests = [];
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      requests.push(url.href);
      return route.fulfill({status:404,body:''});
    });
    await page.goto('http://ots.example.test/trade-order-system.html');
    await page.waitForSelector('.mac-only-notice');
    assert.match(await page.locator('.mac-only-notice h1').innerText(), /Mac App/);
    assert.equal(await page.locator('#pipeline').count(), 0, 'the app UI must not render outside the Mac app');
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key !== 'trade-order-system-theme'));
    assert.deepEqual(stored, [], 'no app data may be written to browser storage');
    assert.deepEqual(requests, [], 'no data or API requests outside the Mac app');
    console.log('Mac-only UI passed: opened outside the Mac app, the page shows a notice and stores or requests nothing.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
