#!/usr/bin/env node
// 界面大小：Mac App 里设置页可以选 75%–100%，按钮把缩放发给原生（pageZoom），侧栏顶部留白按缩放补偿，Logo 仍在红黄绿按钮下面；
// 普通浏览器里不显示这一项。原生默认 85%（原型在浏览器里被缩小显示，所以看着更紧凑）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');
const swift = fs.readFileSync(path.join(root, 'mac-app', 'native', 'Sources', 'TradeOrderSystemNative', 'main.swift'), 'utf8');

assert.match(swift, /uiZoomDefault = 0\.85/, 'native default zoom is 85%');
assert.match(swift, /webView\.pageZoom = CGFloat\(uiZoom\)/, 'native applies the saved zoom to the web view');
assert.match(swift, /add\(self, name: "uiZoom"\)/, 'native listens for zoom changes from the settings page');
assert.match(swift, /cssX \* zoom/, 'window drag regions are converted from CSS pixels with the zoom');

async function open(browser, native) {
  const context = await browser.newContext({ viewport:{ width:1440, height:920 }, locale:'zh-CN' });
  const page = await context.newPage();
  await page.addInitScript(native => {
    if (!native) return;
    window.__zoomMessages = [];
    window.__otsUiZoom = 0.85;
    window.webkit = { messageHandlers: { appUpdate: { postMessage() {} }, uiZoom: { postMessage(body) { window.__zoomMessages.push(body); } } } };
  }, native);
  await page.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:1, data:{ orders:[], customers:{}, trashOrders:[], deletedOrders:[], demoCleared:true, demoCustomersCleared:true } } });
    return route.fulfill({ json:{} });
  });
  await page.goto('http://127.0.0.1:4173/trade-order-system.html#settings');
  await page.waitForSelector('.sidebar .logo-mark');
  return { context, page };
}

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const { context, page } = await open(browser, true);
    const state = () => page.evaluate(() => ({
      zoom:getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim(),
      pressed:[...document.querySelectorAll('[data-ui-zoom-choice][aria-pressed="true"]')].map(b => b.textContent),
      padding:parseFloat(getComputedStyle(document.querySelector('.sidebar')).paddingTop),
      shown:getComputedStyle(document.querySelector('.ui-zoom-card')).display !== 'none'
    }));
    let s = await state();
    assert.equal(s.zoom, '0.85');
    assert.deepEqual(s.pressed, ['85%']);
    assert.ok(s.shown, 'zoom setting shows in the Mac app');
    assert.ok(Math.abs(s.padding * 0.85 - 44) < 0.5, `sidebar top keeps 44pt on screen at 85% (got ${s.padding}px)`);

    await page.evaluate(() => document.querySelector('[data-ui-zoom-choice="0.8"]').click());
    s = await state();
    assert.deepEqual(await page.evaluate(() => window.__zoomMessages), [{ zoom:0.8 }]);
    assert.deepEqual(s.pressed, ['80%']);
    assert.ok(Math.abs(s.padding * 0.8 - 44) < 0.5, 'sidebar padding follows the new zoom');

    await page.evaluate(() => window.otsUiZoomChanged(1));
    s = await state();
    assert.deepEqual(s.pressed, ['100%'], 'menu shortcut changes are reflected in settings');
    assert.equal(s.padding, 44);
    await context.close();

    const web = await open(browser, false);
    const webShown = await web.page.evaluate(() => getComputedStyle(document.querySelector('.ui-zoom-card')).display !== 'none');
    assert.equal(webShown, false, 'browser build hides the zoom setting');
    await web.context.close();
    console.log('UI zoom passed: Mac app defaults to 85%, settings switch zoom via native, sidebar padding compensates, hidden in the browser.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
