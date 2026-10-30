#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { createSubscriptionStore } = require('../mac-app/subscription-store');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
async function capture(page, name, options = {}) {
  if (!process.env.UI_SCREENSHOT) return;
  await page.waitForTimeout(700);
  await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.${name}.png`, ...options });
}
// 07:00 in UTC+8 is still the previous day in UTC; the page must use the local date.
const now = new Date('2026-03-18T07:00:00+08:00');

function seededStore() {
  const store = createSubscriptionStore(new DatabaseSync(':memory:'));
  [
    { name:'1Password', note:'家庭版', amount:35.88, currency:'USD', cycleMonths:12, startDate:'2022-05-18', category:'工具效率', color:'#2f6fde' },
    { name:'ChatGPT Plus', note:'个人账号', amount:20, currency:'USD', cycleMonths:1, startDate:'2025-11-18', category:'AI', color:'#5b3cc4' },
    { name:'阿里云域名', note:'', amount:69, currency:'CNY', cycleMonths:12, startDate:'2025-03-25', category:'其他', color:'#e8590c' }
  ].forEach(item => store.save(item));
  return store;
}

async function routeApp(page, store, counters) {
  await page.route('**/*', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:1, data:{ orders:[], customers:{}, trashOrders:[], deletedOrders:[], demoCleared:true, demoCustomersCleared:true } } });
    if (pathname === '/api/save') counters.saves += 1;
    if (pathname.startsWith('/api/subscriptions')) {
      counters.subscriptionCalls.push(pathname);
      try {
        const body = request.postData() ? JSON.parse(request.postData()) : {};
        const result = pathname === '/api/subscriptions' ? store.list()
          : pathname === '/api/subscriptions/save' ? store.save(body.item)
          : pathname === '/api/subscriptions/delete' ? store.remove(body)
          : store.setRate(body);
        return route.fulfill({ json:result });
      } catch (error) {
        return route.fulfill({ status:error.status || 500, json:{ ok:false, message:error.message } });
      }
    }
    return route.fulfill({ json:{ ok:true } });
  });
}

async function openApp(browser, store, counters, { viewport = { width:1360, height:900 } } = {}) {
  const context = await browser.newContext({ viewport, timezoneId:'Asia/Shanghai', locale:'zh-CN' });
  const page = await context.newPage();
  await page.clock.setFixedTime(now);
  page.on('pageerror', error => counters.errors.push(error.message));
  await routeApp(page, store, counters);
  await page.goto('http://127.0.0.1:47999/trade-order-system.html#subscriptions');
  return { context, page };
}

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const store = seededStore();
    const counters = { saves:0, errors:[], subscriptionCalls:[] };
    const { context, page } = await openApp(browser, store, counters);
    const rows = page.locator('#subsList .subs-row');
    const toasts = page.locator('#subscriptionToasts .subs-toast');
    await rows.first().waitFor();

    // List: sorted by next charge, converted with the page rate, isolated from order data.
    assert.equal(await page.locator('.page-title').innerText(), '订阅');
    assert.equal(await page.locator('.nav-item[data-page="subscriptions"]').getAttribute('class'), 'nav-item active');
    assert.deepEqual(await rows.locator('.subs-name').allInnerTexts(), ['ChatGPT Plus', '阿里云域名', '1Password']);
    assert.match(await rows.nth(0).innerText(), /ChatGPT Plus[\s\S]*个人账号[\s\S]*AI[\s\S]*\$20\.00[\s\S]*月付 · ≈¥142\.00[\s\S]*今天扣费/);
    assert.match(await rows.nth(1).innerText(), /阿里云域名[\s\S]*其他[\s\S]*¥69\.00[\s\S]*年付[\s\S]*7天后扣费/);
    assert.deepEqual(await rows.locator('.subs-pill').evaluateAll(pills => pills.map(pill => pill.className)),
      ['subs-pill red solid', 'subs-pill accent', 'subs-pill line']);
    assert.deepEqual(await rows.locator('.subs-ic').allInnerTexts(), ['Ch', '阿', '1P']);
    await page.waitForFunction(() => document.getElementById('subsHeroMonthly')?.getAttribute('aria-label') === '168.98');
    assert.equal(await page.locator('#subsHeroMonthly .subs-wh').count(), 5, 'every digit of 168.98 is a rolling strip');
    assert.equal(await page.locator('#subsHeroYear').innerText(), '一年约 ¥2,028 · 美元按 7.1 折算');
    assert.match(await page.locator('#subsHeroSide').innerText(), /3 项订阅[\s\S]*3 项自动续费 · 0 项已取消[\s\S]*未来 30 天要付 ¥211\.00 · 2 笔[\s\S]*7 天内扣费 2 项/);

    // Category filter with a sliding highlight, and in-page search.
    await page.locator('[data-sub-filter="AI"]').click();
    assert.deepEqual(await rows.locator('.subs-name').allInnerTexts(), ['ChatGPT Plus']);
    assert.equal(await page.locator('[data-sub-filter="AI"]').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => {
      const glide = document.querySelector('#subsFilter .subs-glide').getBoundingClientRect();
      const active = document.querySelector('[data-sub-filter="AI"]').getBoundingClientRect();
      return Math.abs(glide.left - active.left) < 1 && Math.abs(glide.width - active.width) < 1;
    });
    assert.match(await page.locator('[data-sub-filter="工具效率"]').innerText(), /工具效率\s*1/);
    await page.locator('[data-sub-filter="all"]').click();
    await page.locator('#subsSearch').fill('家庭');
    assert.deepEqual(await rows.locator('.subs-name').allInnerTexts(), ['1Password']);
    assert.equal(await page.locator('#subsMeta').innerText(), '找到 1 项');
    await page.locator('#subsSearch').fill('');
    assert.equal(await page.locator('#subsMeta').isVisible(), false);
    await capture(page, 'list');

    // Detail drawer matches the 1Password screenshot numbers.
    await rows.filter({ hasText:'1Password' }).click();
    const drawer = page.locator('#subscriptionDrawer');
    await drawer.locator('.subs-card').first().waitFor();
    assert.equal(await drawer.getAttribute('aria-hidden'), 'false');
    assert.equal(await page.locator('#subscriptionDrawerTitle').innerText(), '1Password');
    const cards = await drawer.locator('.subs-card').allInnerTexts();
    assert.match(cards[0], /下次扣费\s*2026-05-18\s*61天后扣费/);
    assert.match(cards[1], /月均花费\s*¥21\.23\s*年度约 ¥254\.75/);
    assert.match(cards[2], /累计已花费（估算）\s*\$143\.52\s*按当前价格估算，已扣费 4 次，约 ¥1,018\.99/);
    assert.match(await drawer.locator('.subs-kv').innerText(), /币种\s*美元 · 1 USD = 7\.1 CNY/);
    await capture(page, 'detail');

    // Cancel keeps it until the paid-through date; the toast can undo it; resume restores auto-renewal.
    await drawer.locator('[data-sub-action="toggle"]').click();
    await drawer.locator('.subs-dh .subs-pill.amber').waitFor();
    assert.match(await drawer.locator('.subs-card').first().innerText(), /有效期至\s*2026-05-18\s*61天后到期，不再扣费/);
    assert.equal(store.list().items.find(item => item.name === '1Password').endsOn, '2026-05-18');
    assert.match(await page.locator('#subsHeroSide').innerText(), /2 项自动续费 · 1 项已取消/);
    assert.equal(await rows.filter({ hasText:'1Password' }).locator('.subs-pill').innerText(), '61天后到期');
    const cancelToast = toasts.filter({ hasText:'1Password 已取消订阅' });
    assert.match(await cancelToast.innerText(), /2026-05-18 到期后不再续费/);
    await cancelToast.locator('.subs-undo').click();
    await drawer.locator('.subs-dh .subs-pill.green').waitFor();
    assert.deepEqual((({ status, endsOn }) => ({ status, endsOn }))(store.list().items.find(item => item.name === '1Password')), { status:'active', endsOn:'' });
    await drawer.locator('[data-sub-action="toggle"]').click();
    await drawer.locator('.subs-dh .subs-pill.amber').waitFor();
    await drawer.locator('[data-sub-action="toggle"]').click();
    await drawer.locator('.subs-dh .subs-pill.green').waitFor();
    assert.equal(store.list().items.find(item => item.name === '1Password').status, 'active');

    // Releasing early only shakes the button; holding 1.5 seconds deletes; undo writes the same record back.
    const hold = drawer.locator('.subs-hold');
    const before = store.list().items.find(item => item.name === '1Password');
    await hold.hover();
    await page.mouse.down();
    await page.waitForTimeout(400);
    assert.equal(await hold.innerText(), '继续按住…');
    await page.mouse.up();
    await drawer.locator('.subs-hold.shake').waitFor();
    assert.equal(await hold.innerText(), '按住删除');
    assert.equal(store.list().items.length, 3, 'an early release must not delete');
    await hold.hover();
    await page.mouse.down();
    await page.waitForTimeout(1700);
    await page.mouse.up();
    const deletedToast = toasts.filter({ hasText:'已删除 1Password' });
    await deletedToast.waitFor();
    assert.equal(store.list().items.length, 2);
    assert.equal(await drawer.getAttribute('aria-hidden'), 'true');
    await page.waitForFunction(() => document.querySelectorAll('#subsList .subs-row').length === 2);
    await deletedToast.locator('.subs-undo').click();
    await rows.filter({ hasText:'1Password' }).waitFor();
    await toasts.filter({ hasText:'已恢复 1Password' }).waitFor();
    const restored = store.list().items.find(item => item.name === '1Password');
    assert.equal(restored.id, before.id, 'undo keeps the id');
    assert.equal(restored.createdAt, before.createdAt, 'undo keeps the creation time');

    // Add: validation first, then a USD yearly AI subscription with a live preview.
    await page.locator('#subsAddBtn').click();
    const modal = page.locator('#subscriptionEditModal');
    await modal.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.equal(await modal.locator('#subscriptionSaveBtn').innerText(), '添加订阅');
    await modal.locator('#subscriptionSaveBtn').click();
    assert.equal(await page.locator('#subscriptionEditError').innerText(), '请填写订阅名称');
    assert.match(await modal.locator('#subscriptionName').evaluate(el => el.closest('.subs-field').className), /\berr\b/);
    await modal.locator('#subscriptionName').fill('Claude Pro');
    await modal.locator('#subscriptionSaveBtn').click();
    assert.equal(await page.locator('#subscriptionEditError').innerText(), '请填写大于 0 的金额');
    await modal.locator('#subscriptionAmount').fill('200');
    await modal.locator('[data-sub-segment="currency"] [data-value="USD"]').click();
    await modal.locator('[data-sub-segment="cycleMonths"] [data-value="12"]').click();
    await modal.locator('[data-sub-segment="category"] [data-value="AI"]').click();
    await modal.locator('[data-sub-color="#e0336f"]').click();
    assert.equal(await page.locator('#subscriptionCurrencySymbol').innerText(), '$');
    assert.equal(await page.locator('#subscriptionPreviewLogo').innerText(), 'Cl');
    assert.equal(await page.locator('#subscriptionPreviewPrice').innerText(), '$200.00');
    assert.equal(await page.locator('#subscriptionPreviewCycle').innerText(), '年付 · ≈¥1,420.00');
    assert.equal(await page.locator('#subscriptionPreviewWhen').innerText(), '今天扣费');
    assert.equal(await page.locator('#subscriptionAmountHint').innerText(), '≈¥1,420.00（1 USD = 7.1 CNY） · 月均 ¥118.33');
    assert.equal(await modal.locator('#subscriptionStart').inputValue(), '2026-03-18', 'the default start date is the local day');
    await capture(page, 'editor');
    await modal.locator('#subscriptionAmount').press('Enter');
    await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
    const added = store.list().items.find(item => item.name === 'Claude Pro');
    assert.deepEqual({ amount:added.amount, currency:added.currency, cycleMonths:added.cycleMonths, category:added.category, color:added.color },
      { amount:200, currency:'USD', cycleMonths:12, category:'AI', color:'#e0336f' });
    assert.equal(await rows.count(), 4);
    assert.equal(await drawer.getAttribute('aria-hidden'), 'false', 'saving opens the detail');
    assert.equal(await page.locator('#subscriptionDrawerTitle').innerText(), 'Claude Pro');
    await toasts.filter({ hasText:'Claude Pro 已添加' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await drawer.getAttribute('aria-hidden'), 'true');

    // Rate edits stay on this page: inline in the hero, Enter saves, Escape cancels.
    await page.locator('#subsRateBtn').click();
    const rateInput = page.locator('#subsRateInput');
    assert.equal(await rateInput.inputValue(), '7.1');
    await rateInput.fill('abc');
    await rateInput.press('Enter');
    await toasts.filter({ hasText:'汇率要在 0 到 100 之间' }).waitFor();
    await rateInput.fill('6.9');
    await rateInput.press('Enter');
    await page.locator('#subsRateBtn', { hasText:'6.9' }).waitFor();
    assert.equal(store.list().usdCnyRate, 6.9);
    assert.match(await rows.filter({ hasText:'ChatGPT Plus' }).innerText(), /≈¥138\.00/);
    await page.waitForFunction(() => document.getElementById('subsHeroMonthly')?.getAttribute('aria-label') === '279.38');
    await page.locator('#subsRateBtn').click();
    await page.locator('#subsRateInput').fill('9');
    await page.locator('#subsRateInput').press('Escape');
    await page.locator('#subsRateBtn', { hasText:'6.9' }).waitFor();
    assert.equal(store.list().usdCnyRate, 6.9);

    // Escape closes the editor first, then the drawer.
    await rows.filter({ hasText:'Claude Pro' }).click();
    await drawer.locator('[data-sub-action="edit"]').click();
    await modal.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.equal(await modal.locator('#subscriptionName').inputValue(), 'Claude Pro');
    assert.equal(await page.locator('#subscriptionEditTitle').innerText(), '编辑订阅');
    assert.equal(await modal.locator('#subscriptionSaveBtn').innerText(), '保存');
    await page.keyboard.press('Escape');
    assert.equal(await modal.getAttribute('aria-hidden'), 'true');
    assert.equal(await drawer.getAttribute('aria-hidden'), 'false');
    await page.keyboard.press('Escape');
    assert.equal(await drawer.getAttribute('aria-hidden'), 'true');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('subscriptionDrawer')).visibility === 'hidden');

    // Subscriptions never reach order data or global search records; only the page entry is searchable.
    await page.locator('#searchInput').fill('ChatGPT');
    await page.waitForTimeout(250);
    assert.match(await page.locator('#globalSearchPanel').innerText(), /共 0 条结果/, 'subscription records are not search results');
    await page.locator('#searchInput').fill('订阅');
    await page.locator('#globalSearchPanel', { hasText:'订阅' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => JSON.stringify(state).includes('ChatGPT')), false);
    assert.equal(counters.saves, 0, 'subscription changes must not save order data');

    // Dark mode and narrow screens fit without horizontal scrolling.
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => applyTheme(value), theme);
      for (const width of [1360, 900, 390]) {
        await page.setViewportSize({ width, height:900 });
        await page.waitForTimeout(120);
        const overflow = await page.evaluate(() => {
          const pageEl = document.getElementById('page-subscriptions');
          const tooWide = [...pageEl.querySelectorAll('.subs-row, .subs-hero, .subs-toolbar, .subs-seg')]
            .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className);
          return { page:document.documentElement.scrollWidth > window.innerWidth + 1, tooWide };
        });
        assert.deepEqual(overflow, { page:false, tooWide:[] }, `subscriptions must fit at ${width}px in ${theme} theme`);
        await capture(page, `${theme}.${width}`, { fullPage:true });
      }
    }
    await rows.first().click();
    await drawer.locator('.subs-card').first().waitFor();
    await capture(page, 'dark.390.detail');
    await page.keyboard.press('Escape');
    await page.locator('#subsAddBtn').click();
    await modal.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.equal(await modal.locator('.subs-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'the editor fits a phone screen');
    await capture(page, 'dark.390.editor');
    assert.deepEqual(counters.errors, []);
    await context.close();

    // An expired subscription is re-subscribed from today instead of resumed.
    const expiredStore = createSubscriptionStore(new DatabaseSync(':memory:'));
    expiredStore.save({ name:'Notion', amount:10, currency:'USD', cycleMonths:1, startDate:'2025-12-05', category:'工具效率', color:'#1f1f23', status:'cancelled', endsOn:'2026-02-05' });
    const expiredCounters = { saves:0, errors:[], subscriptionCalls:[] };
    const expiredApp = await openApp(browser, expiredStore, expiredCounters);
    const expiredRow = expiredApp.page.locator('#subsList .subs-row');
    await expiredRow.first().waitFor();
    assert.match(await expiredRow.first().getAttribute('class'), /\bis-ended\b/);
    assert.equal(await expiredRow.first().locator('.subs-pill').innerText(), '已到期');
    await expiredRow.first().click();
    await expiredApp.page.locator('[data-sub-action="resubscribe"]').click();
    await expiredApp.page.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.equal(await expiredApp.page.locator('#subscriptionEditTitle').innerText(), '重新订阅');
    assert.equal(await expiredApp.page.locator('#subscriptionStart').inputValue(), '2026-03-18');
    await expiredApp.page.locator('#subscriptionSaveBtn').click();
    await expiredApp.page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
    const renewed = expiredStore.list().items[0];
    assert.deepEqual({ status:renewed.status, endsOn:renewed.endsOn, startDate:renewed.startDate }, { status:'active', endsOn:'', startDate:'2026-03-18' });
    assert.deepEqual(expiredCounters.errors, []);
    await expiredApp.context.close();

    // An empty database shows the first-use prompt.
    const emptyCounters = { saves:0, errors:[], subscriptionCalls:[] };
    const emptyApp = await openApp(browser, createSubscriptionStore(new DatabaseSync(':memory:')), emptyCounters);
    await emptyApp.page.locator('[data-subs-empty-action="add"]').click();
    await emptyApp.page.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.deepEqual(emptyCounters.errors, []);
    await emptyApp.context.close();

    console.log('Subscriptions UI test passed: list order, hero wheel and totals, filter glide/search, detail numbers, cancel with undo, resume, hold-to-delete with undo, add, inline rate, Escape, re-subscribe, isolation, themes and widths.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
