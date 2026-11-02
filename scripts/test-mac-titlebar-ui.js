#!/usr/bin/env node
// Mac App 原生窗口：左上角红黄绿按钮不能压在侧边栏 Logo 上；普通浏览器里侧边栏不变。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
// macOS 透明标题栏里红黄绿按钮：12px 圆，圆心约在 (20/40/60, 14)，最低点约 y=20。
const TRAFFIC_LIGHTS_BOTTOM = 20;

async function open(browser, theme, native) {
  const context = await browser.newContext({ viewport:{ width:1440, height:920 }, locale:'zh-CN', colorScheme:theme });
  const page = await context.newPage();
  await page.addInitScript(({ value, native }) => {
    try { localStorage.setItem('ots-theme', value); } catch (_) {}
    if (native) window.webkit = { messageHandlers: { appUpdate: { postMessage() {} } } };
  }, { value:theme, native });
  await page.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:1, data:{ orders:[], customers:{}, trashOrders:[], deletedOrders:[], demoCleared:true, demoCustomersCleared:true } } });
    return route.fulfill({ json:{} });
  });
  await page.goto('http://127.0.0.1:4173/trade-order-system.html');
  await page.waitForSelector('.sidebar .logo-mark');
  return { context, page };
}

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    for (const theme of ['light', 'dark']) {
      const native = await open(browser, theme, true);
      const box = await native.page.locator('.sidebar .logo-mark').boundingBox();
      assert.ok(box.y >= TRAFFIC_LIGHTS_BOTTOM + 16, `${theme}: logo must clear the window buttons (top ${box.y})`);
      if (process.env.UI_SCREENSHOT) {
        await native.page.evaluate(() => {
          const lights = document.createElement('div');
          lights.style.cssText = 'position:fixed;left:14px;top:8px;display:flex;gap:8px;z-index:99999;pointer-events:none';
          for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
            const dot = document.createElement('span');
            dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color}`;
            lights.append(dot);
          }
          document.body.append(lights);
        });
        await native.page.waitForTimeout(400);
        await native.page.screenshot({ path:`${process.env.UI_SCREENSHOT}.${theme}.png`, clip:{ x:0, y:0, width:280, height:140 } });
      }
      await native.context.close();

      const web = await open(browser, theme, false);
      const plain = await web.page.locator('.sidebar .logo-mark').boundingBox();
      assert.ok(plain.y < box.y, `${theme}: outside the native window the sidebar keeps its normal top padding`);
      await web.context.close();
    }
    console.log('Mac titlebar UI passed: in the native window the sidebar logo sits below the traffic-light buttons, light and dark.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
