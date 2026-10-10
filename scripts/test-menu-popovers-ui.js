#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless:true });
  const failures = [];
  const check = (name, run) => { try { run(); } catch (error) { failures.push(`${name}: ${error.message}`); } };
  try {
    const page = await browser.newPage({ viewport:{ width:1200, height:800 }, reducedMotion:'reduce' });
    const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
    const customers = Object.fromEntries(Array.from({ length:35 }, (_, i) => [`Buyer ${String(i + 1).padStart(2, '0')}`, { country:i % 2 ? '英国 United Kingdom' : '美国 United States' }]));
    const errors = [];
    let saves = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:0, data:{ orders:[], customers, demoCleared:true, demoCustomersCleared:true } } });
      if (pathname === '/api/health') return route.fulfill({ json:{ ok:true, storageMode:'sqlite', counts:{ orders:0 }, backups:{ sqliteCount:0 } } });
      if (pathname === '/api/save') saves++;
      return route.fulfill({ json:{ ok:true } });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    // Controlled placement of a real select exercises the same production enhancement used by every form.
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'menu-fixture';
      fixture.style.cssText = 'position:fixed;left:72px;top:490px;width:300px;z-index:200';
      fixture.innerHTML = '<button id="before-select">前一项</button><select id="menu-test-select" aria-label="菜单测试">' + Array.from({ length:25 }, (_, i) => `<option value="${i}" ${i === 22 ? 'selected' : ''}>选项 ${i + 1}</option>`).join('') + '<optgroup label="暂不可用" disabled><option value="blocked" title="需要先完成账号配置">禁用分组选项</option></optgroup></select><button id="after-select">后一项</button>';
      document.body.append(fixture);
      enhanceAppSelects(fixture);
    });
    const trigger = page.locator('#menu-fixture .app-select-button');
    await page.locator('#before-select').focus();
    await page.keyboard.press('Tab');
    const firstFocus = await trigger.evaluate(el => document.activeElement === el);
    check('Tab直接进入可见控件', () => assert.equal(firstFocus, true));
    await trigger.click();
    const menu = page.locator('.app-select-popover');
    const geometry = await menu.boundingBox();
    check('长列表不越过底边', () => assert.ok(geometry.y >= 8 && geometry.y + geometry.height <= 792, JSON.stringify(geometry)));
    const selectedVisible = await menu.locator('[aria-selected="true"]').evaluate(el => {
      const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect();
      return r.top >= p.top && r.bottom <= p.bottom;
    });
    check('展开时当前选项可见', () => assert.equal(selectedVisible, true));
    const groupDisabled = await menu.locator('[data-app-select-value="blocked"]').isDisabled();
    check('禁用分组不可选择', () => assert.equal(groupDisabled, true));
    const blockedCommit = await page.evaluate(() => commitAppSelectValue(document.getElementById('menu-test-select'), 'blocked'));
    assert.equal(blockedCommit, false);
    assert.equal(await page.locator('#menu-test-select').inputValue(), '22');
    if (process.env.UI_SCREENSHOT) {
      await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.select-light.png` });
      await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.select-dark.png` });
      await page.evaluate(() => document.documentElement.dataset.theme = 'light');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await trigger.press('Home');
    await trigger.press('ArrowDown');
    await trigger.press('Enter');
    assert.equal(await page.locator('#menu-test-select').inputValue(), '1');
    assert.equal(await menu.isVisible(), false);
    await trigger.click();
    await trigger.press('Escape');
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
    assert.equal(await menu.isVisible(), false);
    await trigger.press('Tab');
    assert.equal(await page.locator('#after-select').evaluate(el => document.activeElement === el), true);
    await page.evaluate(() => document.getElementById('menu-fixture').remove());

    await page.locator('#newOrderBtn').click();
    const input = page.locator('#orderForm .client-picker input[name="client"]');
    await input.fill('Buyer');
    const clientMenu = page.locator('#orderForm .client-menu');
    const customerBox = await clientMenu.boundingBox();
    check('客户菜单不超出视口', () => assert.ok(customerBox.y >= 8 && customerBox.y + customerBox.height <= 792, JSON.stringify(customerBox)));
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await input.press('Enter');
    const selectedName = await input.inputValue();
    check('客户回车选中第二个结果', () => assert.equal(selectedName, 'Buyer 02'));
    const closedAfterSelect = await clientMenu.evaluate(el => !el.classList.contains('open'));
    check('客户选中后收起', () => assert.equal(closedAfterSelect, true));
    // Escape closes only the picker, never the order form.
    await input.fill('Buyer');
    await input.press('Escape');
    const escaped = await clientMenu.evaluate(el => !el.classList.contains('open'));
    check('客户Escape关闭', () => assert.equal(escaped, true));
    assert.equal(await page.locator('#orderForm').isVisible(), true);

    await input.fill('');
    await input.fill('Buyer');
    await input.dispatchEvent('keydown', { key:'ArrowDown', isComposing:true, bubbles:true });
    await input.dispatchEvent('keydown', { key:'Enter', isComposing:true, bubbles:true });
    const composedName = await input.inputValue();
    const composingMenuOpen = await clientMenu.isVisible();
    check('输入法保留输入', () => assert.equal(composedName, 'Buyer'));
    check('输入法保留菜单', () => assert.equal(composingMenuOpen, true));
    await input.press('Tab');
    await page.keyboard.press('Tab');
    const letterHasFocus = await clientMenu.locator('[data-client-letter="all"]').evaluate(el => document.activeElement === el);
    check('Tab可访问字母筛选', () => assert.equal(letterHasFocus, true));
    if (letterHasFocus) {
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      assert.equal(await clientMenu.locator('[data-open-client]').first().evaluate(el => document.activeElement === el), true, 'Tab可访问客户资料入口');
      await page.keyboard.press('Escape');
      assert.equal(await input.evaluate(el => document.activeElement === el), true);
      assert.equal(await clientMenu.isVisible(), false);
    }

    for (const [theme, width, height] of [['light', 1200, 800], ['dark', 1200, 800], ['light', 720, 640]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await input.fill('');
      await input.fill('Buyer');
      const bounds = await clientMenu.boundingBox();
      check(`${theme}-${width}菜单边界`, () => assert.ok(bounds.x >= 7 && bounds.x + bounds.width <= width - 7 && bounds.y >= 7 && bounds.y + bounds.height <= height - 7, JSON.stringify(bounds)));
      // Wheel at the list edge must not move its parent form.
      await clientMenu.evaluate(el => { el.scrollTop = el.scrollHeight; });
      const before = await page.locator('#orderForm').evaluate(el => el.scrollTop);
      await clientMenu.hover();
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(100);
      const after = await page.locator('#orderForm').evaluate(el => el.scrollTop);
      check(`${theme}-${width}滚动隔离`, () => assert.equal(after, before));
      if (process.env.UI_SCREENSHOT) {
        await clientMenu.evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.${theme}-${width}.png` });
      }
      await input.press('Escape');
    }
    check('读取和选择不保存订单', () => assert.equal(saves, 0));
    check('无浏览器错误', () => assert.deepEqual(errors, []));
    assert.deepEqual(failures, [], failures.join('\n'));
    console.log('Menu popovers UI passed: viewport edges, selected visibility, keyboard, disabled groups, scroll isolation and themes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
