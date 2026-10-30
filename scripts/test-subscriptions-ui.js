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
    { name:'1Password', note:'家庭版', amount:35.88, currency:'USD', cycleMonths:12, startDate:'2022-05-18', category:'工具效率', color:'#4c7d70' },
    { name:'ChatGPT Plus', note:'个人账号', amount:20, currency:'USD', cycleMonths:1, startDate:'2025-11-18', category:'AI', color:'#0f8f81' },
    { name:'阿里云域名', note:'', amount:69, currency:'CNY', cycleMonths:12, startDate:'2025-03-25', category:'其他', color:'#d97730' }
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

async function openApp(browser, store, counters, { viewport = { width:1360, height:900 }, origin = 'http://127.0.0.1:47999' } = {}) {
  const context = await browser.newContext({ viewport, timezoneId:'Asia/Shanghai', locale:'zh-CN' });
  const page = await context.newPage();
  await page.clock.setFixedTime(now);
  page.on('pageerror', error => counters.errors.push(error.message));
  await routeApp(page, store, counters);
  await page.goto(`${origin}/trade-order-system.html#subscriptions`);
  return { context, page };
}

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const store = seededStore();
    const counters = { saves:0, errors:[], subscriptionCalls:[] };
    const { context, page } = await openApp(browser, store, counters);
    const rows = page.locator('#subsList .subs-item');
    await rows.first().waitFor();

    // List: sorted by next charge, converted with the page rate, isolated from order data.
    assert.equal(await page.locator('.page-title').innerText(), '订阅');
    assert.equal(await page.locator('.nav-item[data-page="subscriptions"]').getAttribute('class'), 'nav-item active');
    assert.deepEqual(await rows.locator('.subs-name').allInnerTexts(), ['ChatGPT Plus', '阿里云域名', '1Password']);
    assert.match(await rows.nth(0).innerText(), /今天扣费[\s\S]*3月18日[\s\S]*\$20\.00[\s\S]*\/月 ≈¥142\.00/);
    assert.match(await rows.nth(1).innerText(), /7 天后扣费[\s\S]*3月25日[\s\S]*¥69\.00/);
    assert.equal(await rows.nth(0).locator('.subs-pill').getAttribute('class'), 'subs-pill today');
    await page.waitForFunction(() => document.getElementById('subsHeroMonthly')?.textContent === '168.98');
    assert.match(await page.locator('#subsHero').innerText(), /一年约 ¥2,027\.75[\s\S]*3\s*项[\s\S]*3\s*自动续费[\s\S]*0\s*已取消[\s\S]*未来 30 天要付 · 2 笔[\s\S]*¥211\.00/);
    assert.equal(await page.locator('#subsHero .subs-strip-dot').count(), 2);

    // Category filter and in-page search.
    await page.locator('[data-sub-filter="AI"]').click();
    assert.deepEqual(await rows.locator('.subs-name').allInnerTexts(), ['ChatGPT Plus']);
    assert.match(await page.locator('[data-sub-filter="工具效率"]').innerText(), /工具效率\s*1/);
    await page.locator('[data-sub-filter="all"]').click();
    await page.locator('#subsSearch').fill('家庭');
    assert.deepEqual(await rows.locator('.subs-name').allInnerTexts(), ['1Password']);
    assert.equal(await page.locator('#subsMeta').innerText(), '找到 1 项');
    await page.locator('#subsSearch').fill('');

    // Detail drawer matches the 1Password screenshot numbers.
    await rows.filter({ hasText:'1Password' }).click();
    const drawer = page.locator('#subscriptionDrawer');
    await drawer.locator('.subs-card').first().waitFor();
    assert.equal(await drawer.getAttribute('aria-hidden'), 'false');
    const cards = await drawer.locator('.subs-card').allInnerTexts();
    assert.match(cards[0], /下次扣费\s*2026-05-18\s*61 天后/);
    assert.match(cards[1], /月均\s*¥21\.23\s*一年约 ¥254\.75/);
    assert.match(cards[2], /累计已花费（估算）\s*¥1,018\.99\s*共 4 次扣费/);
    await capture(page, 'detail');

    // Cancel keeps it until the paid-through date; resume restores auto-renewal.
    await drawer.locator('[data-sub-action="toggle"]').click();
    await drawer.locator('.subs-pill.ending').waitFor();
    assert.match(await drawer.locator('.subs-card').first().innerText(), /有效期至\s*2026-05-18\s*不再扣费 · 还剩 61 天/);
    assert.equal(store.list().items.find(item => item.name === '1Password').endsOn, '2026-05-18');
    assert.match(await page.locator('#subsHero').innerText(), /2\s*自动续费[\s\S]*1\s*已取消/);
    await drawer.locator('[data-sub-action="toggle"]').click();
    await drawer.locator('.subs-pill:not(.ending)').waitFor();
    assert.equal(store.list().items.find(item => item.name === '1Password').status, 'active');

    // Releasing early never deletes; holding 1.5 seconds deletes; undo writes the same record back.
    const hold = drawer.locator('.subs-hold');
    const before = store.list().items.find(item => item.name === '1Password');
    await hold.hover();
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.up();
    assert.match(await page.locator('#subscriptionHoldHint').innerText(), /松手太早了/);
    assert.equal(store.list().items.length, 3, 'an early release must not delete');
    await hold.hover();
    await page.mouse.down();
    await page.waitForTimeout(1700);
    await page.mouse.up();
    await page.locator('#toast.show .toast-action').waitFor();
    assert.equal(store.list().items.length, 2);
    assert.equal(await drawer.getAttribute('aria-hidden'), 'true');
    assert.equal(await rows.count(), 2);
    assert.match(await page.locator('#toast').innerText(), /已删除 1Password/);
    await page.locator('#toast .toast-action').click();
    await rows.filter({ hasText:'1Password' }).waitFor();
    const restored = store.list().items.find(item => item.name === '1Password');
    assert.equal(restored.id, before.id, 'undo keeps the id');
    assert.equal(restored.createdAt, before.createdAt, 'undo keeps the creation time');

    // Add: validation first, then a USD yearly AI subscription with a live preview.
    await page.locator('#subsAddBtn').click();
    const modal = page.locator('#subscriptionEditModal');
    await modal.locator('#subscriptionName').waitFor({ state:'visible' });
    await modal.locator('#subscriptionSaveBtn').click();
    assert.equal(await page.locator('#subscriptionEditError').innerText(), '请填写订阅名称');
    await modal.locator('#subscriptionName').fill('Claude Pro');
    await modal.locator('#subscriptionSaveBtn').click();
    assert.equal(await page.locator('#subscriptionEditError').innerText(), '请填写大于 0 的金额');
    await modal.locator('#subscriptionAmount').fill('200');
    await modal.locator('[data-sub-segment="currency"] [data-value="USD"]').click();
    await modal.locator('[data-sub-segment="cycleMonths"] [data-value="12"]').click();
    await modal.locator('[data-sub-segment="category"] [data-value="AI"]').click();
    await modal.locator('[data-sub-color="#bf4a3c"]').click();
    assert.equal(await page.locator('#subscriptionPreviewLogo').innerText(), 'C');
    assert.equal(await page.locator('#subscriptionPreviewPrice').innerText(), '$200.00');
    assert.equal(await page.locator('#subscriptionAmountHint').innerText(), '≈¥1,420.00（1 USD = 7.1 CNY） · 月均 ¥118.33');
    assert.equal(await modal.locator('#subscriptionStart').inputValue(), '2026-03-18', 'the default start date is the local day');
    await capture(page, 'editor');
    await modal.locator('#subscriptionAmount').press('Enter');
    await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
    const added = store.list().items.find(item => item.name === 'Claude Pro');
    assert.deepEqual({ amount:added.amount, currency:added.currency, cycleMonths:added.cycleMonths, category:added.category, color:added.color },
      { amount:200, currency:'USD', cycleMonths:12, category:'AI', color:'#bf4a3c' });
    assert.equal(await rows.count(), 4);

    // Rate edits stay on this page.
    await page.locator('#subsRateBtn').click();
    assert.equal(await page.locator('#confirmInput').inputValue(), '7.1');
    await page.locator('#confirmInput').fill('6.9');
    await page.locator('#confirmOkBtn').click();
    await page.locator('#subsRateBtn', { hasText:'6.9' }).waitFor();
    assert.equal(store.list().usdCnyRate, 6.9);
    assert.match(await rows.filter({ hasText:'ChatGPT Plus' }).innerText(), /≈¥138\.00/);

    // Escape closes the editor first, then the drawer.
    await rows.filter({ hasText:'Claude Pro' }).click();
    await drawer.locator('[data-sub-action="edit"]').click();
    await modal.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.equal(await modal.locator('#subscriptionName').inputValue(), 'Claude Pro');
    await page.keyboard.press('Escape');
    assert.equal(await modal.getAttribute('aria-hidden'), 'true');
    assert.equal(await drawer.getAttribute('aria-hidden'), 'false');
    await page.keyboard.press('Escape');
    assert.equal(await drawer.getAttribute('aria-hidden'), 'true');

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
          const tooWide = [...pageEl.querySelectorAll('.subs-item, .subs-hero, .subs-tools, .subs-filter')]
            .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className);
          return { page:document.documentElement.scrollWidth > window.innerWidth + 1, tooWide };
        });
        assert.deepEqual(overflow, { page:false, tooWide:[] }, `subscriptions must fit at ${width}px in ${theme} theme`);
        await capture(page, `${theme}.${width}`, { fullPage:true });
      }
    }
    await page.locator('.subs-item').first().click();
    await drawer.locator('.subs-card').first().waitFor();
    await capture(page, 'dark.390.detail');
    assert.deepEqual(counters.errors, []);
    await context.close();

    // A browser-opened copy has no local database.
    const browserCounters = { saves:0, errors:[], subscriptionCalls:[] };
    const browserApp = await openApp(browser, seededStore(), browserCounters, { origin:'http://ots.example' });
    await browserApp.page.locator('#subsList .subs-empty').waitFor();
    assert.match(await browserApp.page.locator('#subsList').innerText(), /请在 Mac App 里使用订阅/);
    assert.equal(await browserApp.page.locator('#subsAddBtn').isDisabled(), true);
    assert.deepEqual(browserCounters.subscriptionCalls, []);
    assert.deepEqual(browserCounters.errors, []);
    await browserApp.context.close();

    // An empty database shows the first-use prompt.
    const emptyCounters = { saves:0, errors:[], subscriptionCalls:[] };
    const emptyApp = await openApp(browser, createSubscriptionStore(new DatabaseSync(':memory:')), emptyCounters);
    await emptyApp.page.locator('[data-subs-empty-action="add"]').click();
    await emptyApp.page.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.deepEqual(emptyCounters.errors, []);
    await emptyApp.context.close();

    console.log('Subscriptions UI test passed: list order, hero totals, filter/search, detail numbers, cancel/resume, hold-to-delete with undo, add, rate, Escape, isolation, themes and widths.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
