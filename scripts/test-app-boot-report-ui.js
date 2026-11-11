#!/usr/bin/env node
// 更新成功的判定：页面要告诉 Mac 壳「主脚本跑完了，并且读库后画出了界面」（appBooted）。
// 更新器只认这一句；页面加载完但主脚本启动就报错的版本收不到它，会被退回旧版本。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
const emptyData = { app:'trade-order-system', revision:1, data:{ orders:[], customers:{}, trashOrders:[], deletedOrders:[], demoCleared:true, demoCustomersCleared:true } };

// The report is the last thing the main script does; anything after it would not be covered.
const tail = html.slice(html.lastIndexOf('window.otsAppUpdateStatus = otsAppUpdateStatus;'));
assert.match(tail.replace(/\/\/[^\n]*\n/g, ''), /^window\.otsAppUpdateStatus = otsAppUpdateStatus;\s*appScriptCompleted = true;\s*reportAppBooted\(\);\s*<\/script>\s*<\/body>\s*<\/html>\s*$/,
  'appScriptCompleted is set by the last statement of the main script');

async function open(browser, { body = html, data } = {}) {
  const context = await browser.newContext({ viewport:{ width:1440, height:920 }, locale:'zh-CN' });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__booted = [];
    window.webkit = { messageHandlers:{
      appUpdate:{ postMessage() {} },
      appBooted:{ postMessage(message) { window.__booted.push(message); } }
    } };
  });
  await page.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body });
    if (pathname === '/api/data') return data ? data(route) : route.fulfill({ json:emptyData });
    if (pathname === '/api/health') return route.fulfill({ json:{ ok:true, storageMode:'sqlite', counts:{ orders:0 }, backups:{ sqliteCount:0 } } });
    return route.fulfill({ json:{} });
  });
  await page.goto('http://127.0.0.1:4173/trade-order-system.html');
  return { context, page };
}
const booted = page => page.evaluate(() => window.__booted.length);

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    // 1. Normal start: reported once, and reading the database again does not report again.
    {
      const { context, page } = await open(browser);
      await page.waitForFunction(() => window.__booted.length === 1);
      await page.evaluate(() => loadMacAppState());
      assert.equal(await booted(page), 1, 'reported once per page');
      await context.close();
    }

    // 2. Not before the database answered and the app was drawn from it.
    {
      let release;
      const held = new Promise(resolve => { release = resolve; });
      const { context, page } = await open(browser, { data: async route => { await held; return route.fulfill({ json:emptyData }); } });
      await page.waitForSelector('.sidebar .logo-mark');
      await page.waitForTimeout(600);
      assert.equal(await booted(page), 0, 'a page still waiting for its data has not booted');
      release();
      await page.waitForFunction(() => window.__booted.length === 1);
      await context.close();
    }

    // 3. The database cannot be read: the page protects itself (read-only) and is still a working app.
    {
      const { context, page } = await open(browser, { data: route => route.fulfill({ status:500, json:{ ok:false, message:'database is missing' } }) });
      await page.waitForFunction(() => window.__booted.length === 1);
      assert.equal(await page.evaluate(() => macStorageMode), 'load-failed');
      await context.close();
    }

    // 4. A version whose script throws while starting never reports, wherever it throws.
    const brokenPages = {
      'throws near the end of the script': html.replace('window.otsAppUpdateStatus = otsAppUpdateStatus;', 'window.otsAppUpdateStatus = otsAppUpdateStatus;\nthrow new Error("broken build");'),
      'throws before the first read': html.replace('\nloadMacAppState();\nloadEcbHistoricalRates();', '\nthrow new Error("broken build");\nloadMacAppState();\nloadEcbHistoricalRates();'),
      'cannot draw what it read': html.replace('\nfunction render() {', '\nfunction render() {\n  if (macStateReady) throw new Error("broken build");')
    };
    for (const [label, body] of Object.entries(brokenPages)) {
      assert.notEqual(body, html, `${label}: the page was changed`);
      const { context, page } = await open(browser, { body });
      await page.waitForTimeout(1500);
      assert.equal(await booted(page), 0, `${label}: must not report a working app`);
      await context.close();
    }
    console.log('App boot report passed: reported once after the script finished and the app was drawn from the database; not while waiting for data; not by a page whose script throws on start.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
