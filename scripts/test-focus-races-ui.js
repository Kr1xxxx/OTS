#!/usr/bin/env node
// Focus that background work must not take away (both seen as random CI failures, both real for a fast typist):
// - 续费编辑框 / 改价框 give their default field focus 60 ms after opening. Someone who already clicked into 备注
//   kept typing into 名称 instead (CI: '这边写的' !== '这边写的备注').
// - A background render() (a save coming back, data refresh) rebuilt an open client menu: back to all customers,
//   focus dropped to the page, Esc no longer returned to the input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { h } = require('./helpers/board-page');

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:920 }, reducedMotion:'reduce' });
    const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
    const customers = Object.fromEntries(Array.from({ length:12 }, (_, i) => [`Buyer ${String(i + 1).padStart(2, '0')}`, { country:'美国 United States' }]).concat([['Zed Imports', { country:'英国 United Kingdom' }]]));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:0, data:{ orders:[], customers, demoCleared:true, demoCustomersCleared:true } } });
      if (pathname === '/api/health') return route.fulfill({ json:{ ok:true, storageMode:'sqlite', counts:{ orders:0 }, backups:{ sqliteCount:0 } } });
      if (pathname === '/api/subscriptions') return route.fulfill({ json:{ ok:true, items:[], settings:{} } });
      return route.fulfill({ json:{ ok:true } });
    });
    await page.goto('http://127.0.0.1:47997/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    // 1. Clicked into 备注 right after the editor opened: the delayed default focus leaves it there.
    await page.evaluate(() => {
      openSubscriptionEditor('');
      document.getElementById('subscriptionNote').focus();
    });
    // The editor's default focus runs 60 ms after it opens (setTimeout in openSubscriptionEditor): let that pass, then
    // the cursor must still be in 备注.
    await h.waitPageTime(page, 100);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'subscriptionNote', 'the editor pulled focus back to 名称');
    await page.keyboard.type('这边写的备注');
    assert.deepEqual(await page.evaluate(() => [document.getElementById('subscriptionNote').value, document.getElementById('subscriptionName').value]), ['这边写的备注', '']);
    // Opened without touching anything: 名称 still gets the cursor.
    await page.evaluate(() => { setModalOpenState('subscriptionEditModal', false); document.body.focus(); openSubscriptionEditor(''); });
    await page.waitForFunction(() => document.activeElement?.id === 'subscriptionName');
    await page.evaluate(() => setModalOpenState('subscriptionEditModal', false));

    // 2. An open, filtered client menu survives a background render(), and Esc still goes back to the input.
    await page.locator('#newOrderBtn').click();
    const input = page.locator('#orderForm .client-picker input[name="client"]');
    const menu = page.locator('#orderForm .client-menu');
    await input.fill('Zed');
    await page.waitForFunction(() => document.querySelector('#orderForm .client-menu')?.classList.contains('open'));
    await menu.locator('[data-open-client="Zed Imports"]').focus();
    await page.evaluate(() => render());
    assert.deepEqual(await page.evaluate(() => {
      const box = document.querySelector('#orderForm .client-menu');
      return { open:box.classList.contains('open'), rows:[...box.querySelectorAll('.client-option[data-client]')].map(row => row.dataset.client), focus:document.activeElement?.dataset?.openClient || document.activeElement?.tagName };
    }), { open:true, rows:['Zed Imports'], focus:'Zed Imports' }, 'render() rebuilt the open client menu');
    await page.keyboard.press('Escape');
    assert.equal(await input.evaluate(el => document.activeElement === el), true, 'Esc returns to the client input');
    assert.equal(await menu.isVisible(), false);
    // Closed menus still follow new data on the next render.
    await page.evaluate(() => { state.customers['Aaron New'] = { country:'美国 United States' }; render(); });
    await input.fill('Aaron');
    await page.waitForFunction(() => [...document.querySelectorAll('#orderForm .client-option[data-client]')].some(row => row.dataset.client === 'Aaron New'));

    assert.deepEqual(errors, []);
    console.log('Focus races passed: 续费 editor keeps a field clicked during its open delay; an open client menu survives render().');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
