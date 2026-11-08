#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { createSubscriptionStore } = require('../mac-app/subscription-store');
const { h } = require('./helpers/board-page');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
async function capture(page, name, options = {}) {
  if (!process.env.UI_SCREENSHOT) return;
  await page.waitForTimeout(700);
  await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.${name}.png`, ...options });
}
// 弹窗底部按钮（保存 / 取消 / 确认）：等弹窗弹入停稳，确认那一点上最上层就是这个按钮（没有被提示条之类盖住），再用真鼠标点。
// 以前直接 locator.click()：先出了开机问候提示、再开续费弹窗时，提示条（z-index 比弹窗高）留在窗口底部，
// 盖住「重新续费」按钮的下半截；macOS 字体下按钮中心也被盖住，点击一直被提示挡着、鼠标停在提示上又让它不消失，等到超时。
async function clickFooterButton(page, selector) {
  const point = await h.center(page, selector);
  const hit = await page.evaluate(({ selector, x, y }) => {
    const target = document.querySelector(selector);
    const top = document.elementFromPoint(x, y);
    return target && top && target.contains(top) ? '' : (top?.outerHTML || 'nothing').slice(0, 160);
  }, { selector, x:point.x, y:point.y });
  assert.equal(hit, '', `${selector} must be the topmost element at its center, found ${hit}`);
  await page.mouse.click(point.x, point.y);
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
          : pathname === '/api/subscriptions/options' ? store.setOptions(body)
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
    const toasts = page.locator('#toast .toast-item');
    await rows.first().waitFor();

    // List: sorted by next charge, converted with the page rate, isolated from order data.
    assert.equal(await page.locator('.page-title').innerText(), '续费');
    assert.equal(await page.locator('.nav-item[data-page="subscriptions"]').getAttribute('class'), 'nav-item active');
    assert.deepEqual(await rows.locator('.subs-name').allInnerTexts(), ['ChatGPT Plus', '阿里云域名', '1Password']);
    assert.match(await rows.nth(0).innerText(), /ChatGPT Plus[\s\S]*AI[\s\S]*个人账号[\s\S]*\$20\.00[\s\S]*月付 · ≈¥142\.00[\s\S]*今天扣费/);
    assert.match(await rows.nth(1).innerText(), /阿里云域名[\s\S]*其他[\s\S]*¥69\.00[\s\S]*年付[\s\S]*7天后扣费/);
    assert.deepEqual(await rows.locator('.subs-pill').evaluateAll(pills => pills.map(pill => pill.className)),
      ['subs-pill red solid', 'subs-pill amber', 'subs-pill line']);
    assert.deepEqual(await rows.locator('.subs-ic').allInnerTexts(), ['Ch', '阿', '1P']);
    await page.waitForFunction(() => document.getElementById('subsHeroMonthly')?.getAttribute('aria-label') === '168.98');
    assert.equal(await page.locator('#subsHeroMonthly .subs-wh').count(), 5, 'every digit of 168.98 is a rolling strip');
    assert.equal(await page.locator('#subsHeroYear').innerText(), '一年约 ¥2,028 · 美元按 7.1 折算');
    assert.match(await page.locator('#subsHeroSide').innerText(), /3 项续费[\s\S]*3 项续费中 · 0 项不再续费[\s\S]*未来 30 天要付 ¥211\.00 · 2 笔[\s\S]*2 项快到续费日/);

    // Category filter with a sliding highlight, and in-page search.
    await page.locator('[data-sub-filter="AI"]').click();
    assert.deepEqual(await rows.locator('.subs-name').allInnerTexts(), ['ChatGPT Plus']);
    assert.equal(await page.locator('[data-sub-filter="AI"]').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => {
      const glide = document.querySelector('#subsFilter .subs-glide').getBoundingClientRect();
      const active = document.querySelector('[data-sub-filter="AI"]').getBoundingClientRect();
      return Math.abs(glide.left - active.left) < 1 && Math.abs(glide.width - active.width) < 1;
    });
    // Old 工具效率 records show as 软件; only types in use get a filter button.
    assert.match(await page.locator('[data-sub-filter="软件"]').innerText(), /软件\s*1/);
    assert.equal(await page.locator('[data-sub-filter="VPS"]').count(), 0);
    assert.equal(await page.locator('#subsList .subs-meta .subs-type use').first().getAttribute('href'), '#i-spark');

    // Renewals due soon show up in the bell; clicking one opens that record.
    await page.locator('#notifBtn').click();
    const renewCards = page.locator('#notifList .notif-card[data-sub-id]:not([data-sub-id=""])');
    await renewCards.first().waitFor();
    assert.deepEqual((await renewCards.locator('b').allInnerTexts()).sort(), ['ChatGPT Plus 今天扣费 · 续费', '阿里云域名 7天后扣费 · 续费']);
    await renewCards.filter({ hasText:'阿里云域名' }).click();
    await page.waitForFunction(() => document.getElementById('subscriptionDrawer').classList.contains('open'));
    assert.equal(await page.locator('#subscriptionDrawerTitle').innerText(), '阿里云域名');
    await page.keyboard.press('Escape');
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
    assert.match(cards[2], /累计已花费\s*\$143\.52\s*已扣费 4 次，每期按当期价格计，约 ¥1,018\.99/);
    assert.match(await drawer.locator('.subs-kv').innerText(), /币种\s*美元 · 1 USD = 7\.1 CNY/);
    await capture(page, 'detail');

    // Cancel keeps it until the paid-through date; the toast can undo it; resume restores auto-renewal.
    await drawer.locator('[data-sub-action="toggle"]').click();
    await drawer.locator('.subs-dh .subs-pill.amber').waitFor();
    assert.match(await drawer.locator('.subs-card').first().innerText(), /有效期至\s*2026-05-18\s*61天后到期，不再扣费/);
    assert.equal(store.list().items.find(item => item.name === '1Password').endsOn, '2026-05-18');
    assert.match(await page.locator('#subsHeroSide').innerText(), /2 项续费中 · 1 项不再续费/);
    assert.equal(await rows.filter({ hasText:'1Password' }).locator('.subs-pill').innerText(), '61天后到期');
    const cancelToast = toasts.filter({ hasText:'1Password 已停止续费' });
    assert.match(await cancelToast.innerText(), /2026-05-18 到期后不再扣费/);
    await cancelToast.locator('.toast-undo').click();
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
    await deletedToast.locator('.toast-undo').click();
    await rows.filter({ hasText:'1Password' }).waitFor();
    await toasts.filter({ hasText:'已恢复 1Password' }).waitFor();
    const restored = store.list().items.find(item => item.name === '1Password');
    assert.equal(restored.id, before.id, 'undo keeps the id');
    assert.equal(restored.createdAt, before.createdAt, 'undo keeps the creation time');

    // Add: validation first, then a USD yearly AI subscription with a live preview.
    await page.locator('#subsAddBtn').click();
    const modal = page.locator('#subscriptionEditModal');
    await modal.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.equal(await modal.locator('#subscriptionSaveBtn').innerText(), '添加');
    await clickFooterButton(page, '#subscriptionSaveBtn');
    await page.waitForFunction(text => document.getElementById('subscriptionEditError').textContent === text, '请填写名称', { timeout:5000 });
    assert.match(await modal.locator('#subscriptionName').evaluate(el => el.closest('.subs-field').className), /\berr\b/);
    await modal.locator('#subscriptionName').fill('Claude Pro');
    await clickFooterButton(page, '#subscriptionSaveBtn');
    await page.waitForFunction(text => document.getElementById('subscriptionEditError').textContent === text, '请填写大于 0 的金额', { timeout:5000 });
    await modal.locator('#subscriptionAmount').fill('200');
    await modal.locator('[data-sub-segment="currency"] [data-value="USD"]').click();
    // Custom cycle: 每 2 周 is saved as a reusable option and selected.
    const cycleOpts = modal.locator('[data-sub-opts="cycle"]');
    assert.deepEqual(await cycleOpts.locator('[data-opt-value]').allInnerTexts(), ['周付', '月付', '季付', '半年付', '年付']);
    await cycleOpts.locator('[data-opt-add="cycle"]').click();
    await modal.locator('[name="subCycleCount"]').fill('2');
    await capture(page, 'cycle-add');
    await modal.locator('[data-sub-opt-save="cycle"]').click();
    await cycleOpts.locator('[data-opt-value="day:14"][aria-pressed="true"]').waitFor();
    assert.equal(await page.locator('#subscriptionPreviewCycle').innerText(), '每2周 · ≈¥1,420.00');
    assert.deepEqual(store.list().customCycles, [{ unit:'day', count:14 }], 'the custom cycle is saved for next time');
    await cycleOpts.locator('[data-opt-value="month:12"]').click();
    // Custom payment method, added with Enter.
    const paymentOpts = modal.locator('[data-sub-opts="payment"]');
    await paymentOpts.locator('[data-opt-add="payment"]').click();
    await modal.locator('[name="subPaymentCustom"]').fill('招行信用卡');
    await modal.locator('[name="subPaymentCustom"]').press('Enter');
    await paymentOpts.locator('[data-opt-value="招行信用卡"][aria-pressed="true"]').waitFor();
    assert.equal(await modal.locator('[data-sub-opt-add="payment"]').isHidden(), true);
    assert.deepEqual(store.list().customPaymentMethods, ['招行信用卡']);
    // Type: built-in chips with icons plus a custom type; provider and manual renewal.
    const typeOpts = modal.locator('[data-sub-opts="category"]');
    assert.deepEqual(await typeOpts.locator('[data-opt-value]').allInnerTexts(), ['软件', 'AI', 'VPS', '域名', '云服务', '其他']);
    await typeOpts.locator('[data-opt-add="category"]').click();
    await modal.locator('[name="subCategoryCustom"]').fill('邮箱');
    await modal.locator('[name="subCategoryCustom"]').press('Enter');
    await typeOpts.locator('[data-opt-value="邮箱"][aria-pressed="true"]').waitFor();
    assert.deepEqual(store.list().customCategories, ['邮箱']);
    await typeOpts.locator('[data-opt-value="AI"]').click();
    await modal.locator('#subscriptionProvider').fill('Anthropic');
    await modal.locator('.subs-renew').click();
    assert.equal(await page.locator('#subscriptionPreviewWhen').innerText(), '今天到期');
    assert.match(await page.locator('#subscriptionAutoRenewText').innerText(), /手动续费/);
    await modal.locator('.subs-renew').click();
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
    assert.deepEqual({ amount:added.amount, currency:added.currency, cycleUnit:added.cycleUnit, cycleCount:added.cycleCount, paymentMethod:added.paymentMethod, category:added.category, color:added.color },
      { amount:200, currency:'USD', cycleUnit:'month', cycleCount:12, paymentMethod:'招行信用卡', category:'AI', color:'#e0336f' });
    assert.equal(await rows.count(), 4);
    assert.equal(await drawer.getAttribute('aria-hidden'), 'false', 'saving opens the detail');
    assert.equal(await page.locator('#subscriptionDrawerTitle').innerText(), 'Claude Pro');
    await toasts.filter({ hasText:'Claude Pro 已添加' }).waitFor();
    assert.match(await page.locator('#subscriptionDrawerBody').innerText(), /付款方式\s+招行信用卡/);
    assert.match(await rows.filter({ hasText:'Claude Pro' }).locator('.subs-meta').innerText(), /AI · Anthropic · 招行信用卡/);
    assert.deepEqual([added.provider, added.autoRenew], ['Anthropic', true]);
    assert.match(await page.locator('#subscriptionDrawerBody').innerText(), /服务商\s+Anthropic/);
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
    assert.equal(await page.locator('#subscriptionEditTitle').innerText(), '编辑续费项');
    assert.equal(await modal.locator('#subscriptionSaveBtn').innerText(), '保存');
    // Typed changes are not thrown away silently: Escape asks, 继续编辑 keeps them, 放弃修改 closes.
    await modal.locator('#subscriptionName').fill('Claude Max');
    await page.keyboard.press('Escape');
    await page.locator('#confirmModal.open').waitFor();
    assert.match(await page.locator('#confirmTitle').innerText(), /放弃未保存的修改/);
    await clickFooterButton(page, '#confirmCancelBtn');
    assert.equal(await modal.getAttribute('aria-hidden'), 'false');
    assert.equal(await modal.locator('#subscriptionName').inputValue(), 'Claude Max');
    await clickFooterButton(page, '#subscriptionEditCancelBtn');
    await page.locator('#confirmModal.open').waitFor();
    await clickFooterButton(page, '#confirmOkBtn');
    await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
    assert.equal(store.list().items.some(item => item.name === 'Claude Max'), false);
    await drawer.locator('[data-sub-action="edit"]').click();
    await modal.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.equal(await modal.locator('#subscriptionName').inputValue(), 'Claude Pro');
    // Untouched: Escape closes right away.
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
    await page.locator('#searchInput').fill('续费');
    await page.locator('#globalSearchPanel', { hasText:'续费' }).waitFor();
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
    // 先等开机问候提示出来再开抽屉和弹窗：这就是 macOS CI 上偶发超时的顺序（提示先出、弹窗后开，提示条盖住「重新续费」）。
    // 固定成这个顺序，每次都检查弹窗打开后提示条会让到按钮条上方。
    await expiredApp.page.locator('#toast .toast-item:not(.leaving)').first().waitFor();
    assert.match(await expiredRow.first().getAttribute('class'), /\bis-ended\b/);
    assert.equal(await expiredRow.first().locator('.subs-pill').innerText(), '已到期');
    await expiredRow.first().click();
    await expiredApp.page.locator('[data-sub-action="resubscribe"]').click();
    await expiredApp.page.locator('#subscriptionName').waitFor({ state:'visible' });
    assert.equal(await expiredApp.page.locator('#subscriptionEditTitle').innerText(), '重新续费');
    assert.equal(await expiredApp.page.locator('#subscriptionStart').inputValue(), '2026-03-18');
    // 提示条在弹窗一打开就让到按钮条上方（按弹窗停稳后的位置量），不是等弹入动画结束才挪。
    const toastBottom = await expiredApp.page.evaluate(() => {
      const item = document.querySelector('#toast .toast-item:not(.leaving)');
      return item ? item.getBoundingClientRect().bottom : null;
    });
    assert.notEqual(toastBottom, null, 'the greeting toast is still showing when the editor opens');
    await h.settle(expiredApp.page, '#subscriptionEditModal .subs-modal');
    const footTop = (await expiredApp.page.locator('#subscriptionEditModal .subs-df').boundingBox()).y;
    assert.ok(toastBottom <= footTop, `the toast (bottom ${toastBottom}) must sit above the editor's buttons (top ${footTop})`);
    await clickFooterButton(expiredApp.page, '#subscriptionSaveBtn');
    await expiredApp.page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
    // Re-subscribing adds a new record; the expired one stays so its past charges keep counting in 历史 / 分析.
    const [oldNotion, renewed] = expiredStore.list().items;
    assert.equal(expiredStore.list().items.length, 2);
    assert.deepEqual({ status:oldNotion.status, startDate:oldNotion.startDate, endsOn:oldNotion.endsOn }, { status:'cancelled', startDate:'2025-12-05', endsOn:'2026-02-05' });
    assert.notEqual(renewed.id, oldNotion.id);
    assert.deepEqual({ status:renewed.status, endsOn:renewed.endsOn, startDate:renewed.startDate, amount:renewed.amount, priceChanges:renewed.priceChanges }, { status:'active', endsOn:'', startDate:'2026-03-18', amount:10, priceChanges:[] });
    await expiredApp.page.locator('.toast-item', { hasText:'Notion 已重新续费' }).waitFor();
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
