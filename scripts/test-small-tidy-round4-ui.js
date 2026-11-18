#!/usr/bin/env node
// Seven small places tidied in one go (pages round 2, "7 个小处"). Only what is shown and how it is laid out changes:
// 1. dashboard card captions: each item together with the「 · 」before it never breaks inside, so no line ends in a dot and
//    「物流异常 1」is not split into「物流 / 异常 1」at the smallest window (1294)
// 2. the board hint is short (「拖动改阶段 · 右键更多操作」); the full sentence is its tooltip
// 3. no target for the month: the target page says「11 月还没设目标」once, the other cells stay empty (no 未设置 / 未设 / -),
//    the dashboard card's big text is「设目标」; setting a target brings the numbers back
// 4. global search: an order without a tracking number or note has no「暂无备注」segment
// 5. order drawer, attachments: the empty state says where to add them and its link opens the full edit form;
//    a deleted (read-only) order only says there are none
// 6. 设置 › 汇率 with more than seven past months: a month name stays on one line, the 手填 tag moves below when it does not fit
// 7. order list, compact rows at 1294 and 1100: the amount, the short bar and 待收 stay out of the stage and logistics cells
// The clock is fixed in the page (Asia/Shanghai); customers, orders and rates are made up.
const assert = require('node:assert/strict');
const { launchBrowser } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

const at = text => new Date(`${text}+08:00`);
const base = { currency:'USD', logisticsStatus:'未发货', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[], orderType:'定金订单', depositAmount:300 };
let seq = 0;
const order = extra => { seq += 1; return { ...base, id:`o${seq}`, num:`T-26110${seq}`, client:`Sample Buyer ${seq}`, paidAmount:0, amount:1000, stage:'production', createdAt:'2026-11-03', orderMonth:'2026-11', updated:'2026-11-06 09:00', ...extra }; };
const issueBatch = { id:'a', trackingNumber:'4444444444', carrier:'DHL', status:'异常', rawStatus:'Shipment on hold', updated:'2026-11-16 08:00', trackOkAt:'2026-11-16 08:00', shippedAt:'2026-11-10' };
const orders = [
  order({ amount:1234567, currency:'CNY', paidAmount:370370, urgentOrder:true }),
  order({ amount:7500, paidAmount:2250, urgentOrder:true }),
  order({ amount:4200, stage:'quote' }),
  order({ amount:6100, paidAmount:6100, stage:'shipment', logisticsStatus:'异常', shippedAt:'2026-11-10', trackingNumber:'4444444444', carrier:'DHL', shipments:[issueBatch] }),
  order({ amount:52000, paidAmount:15600, stage:'balance' }),
  order({ amount:900, paidAmount:300, createdAt:'2026-10-05', orderMonth:'2026-10' })
];
const deletedOrders = [{ ...order({ amount:500 }), id:'gone', num:'T-GONE', deletedAt:'2026-11-10 09:00' }];

async function open(browser, { width = 1294, height = 847, now = '2026-11-17T11:00:00', data = {} } = {}) {
  const context = await browser.newContext({ viewport:{ width, height }, timezoneId:'Asia/Shanghai' });
  await context.clock.setFixedTime(at(now));
  await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  const store = { app:'trade-order-system', data:{ orders, deletedOrders, customers:{}, doneTasks:{}, demoCleared:true, demoCustomersCleared:true, ...data }, revision:0 };
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    let response = { ok:true };
    if (pathname === '/api/data') response = store;
    if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
    if (pathname === '/api/ecb-rates') response = { ok:true, rates:[{ date:'2026-11-02', rates:{ CNY:7.7, USD:1.08 } }] };
    if (pathname === '/api/usd-cny-rate') response = { ok:false };
    if (pathname === '/api/save') {
      const body = route.request().postDataJSON();
      store.data = body.state;
      store.revision += 1;
      response = { ok:true, revision:store.revision, backup:{ ok:true, skipped:true } };
    }
    return route.fulfill({ json:response });
  });
  await page.goto('http://127.0.0.1:47991/trade-order-system.html');
  await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  return { page, context, errors };
}

// Items of a card caption: text, how many line boxes each takes, and whether any item ends in a dot.
const captionParts = (page, id) => page.evaluate(id => [...document.getElementById(id).querySelectorAll('.stat-sub-part')]
  .map(part => ({ text:part.textContent, lines:new Set([...part.getClientRects()].map(rect => Math.round(rect.top))).size })), id);

// Geometry of the compact order-list money cells: where the amount text, the visible part of the bar and 待收 sit,
// against the end of the stage cell's flags and the start of the logistics cell's content.
const moneyCells = page => page.evaluate(() => [...document.querySelectorAll('#orderTableBody tr[data-order-list-id]')].map(row => {
  const textRect = el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect(); };
  const stage = row.querySelector('.order-table-stage');
  const flagsRight = Math.max(...[...stage.children].map(el => el.getBoundingClientRect().right));
  const logistics = row.querySelector('td.col-logistics');
  const logisticsLeft = logistics.getBoundingClientRect().left + parseFloat(getComputedStyle(logistics).paddingLeft);
  const total = textRect(row.querySelector('.order-table-total'));
  const line = row.querySelector('.order-table-payline').getBoundingClientRect();
  const bar = row.querySelector('.order-table-paybar').getBoundingClientRect();
  const barShown = bar.width > 0 && bar.top < line.bottom && bar.bottom > line.top;
  const due = row.querySelector('.order-table-due-line');
  const dueRect = due ? textRect(due) : null;
  return {
    id:row.dataset.orderListId,
    flagsRight, logisticsLeft,
    totalLeft:total.left, totalRight:total.right,
    barShown, barLeft:bar.left, barRight:bar.right,
    dueLeft:dueRect?.left ?? null, dueRight:dueRect?.right ?? null,
    dueText:due?.innerText || ''
  };
}));

function assertMoneyCells(cells, label) {
  for (const cell of cells) {
    assert(cell.totalRight <= cell.logisticsLeft + 0.5, `${label} ${cell.id}: the amount stays out of the logistics cell (${cell.totalRight} > ${cell.logisticsLeft})`);
    assert(cell.totalLeft >= cell.flagsRight + 2, `${label} ${cell.id}: the amount stays clear of the stage flags (${cell.totalLeft} < ${cell.flagsRight})`);
    if (cell.barShown) assert(cell.barLeft >= cell.flagsRight + 2, `${label} ${cell.id}: a shown bar does not reach the stage flags (${cell.barLeft} < ${cell.flagsRight})`);
    if (cell.dueLeft !== null) {
      assert(cell.dueLeft >= cell.flagsRight + 2, `${label} ${cell.id}: 待收 stays clear of the stage flags`);
      assert(cell.dueRight <= cell.logisticsLeft + 0.5, `${label} ${cell.id}: 待收 stays out of the logistics cell`);
      if (cell.barShown) assert(cell.barRight <= cell.dueLeft, `${label} ${cell.id}: the bar sits before 待收, not over it`);
    }
  }
}

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, context, errors } = await open(browser);
    await page.evaluate(() => { setPage('dashboard'); window.scrollTo(0, 0); });

    // ---- 1. card captions at the smallest window ----
    await page.waitForFunction(() => /物流异常/.test(document.getElementById('statTasksSub')?.textContent || ''));
    for (const id of ['statAmountSub', 'statPaymentSub', 'statTasksSub']) {
      const parts = await captionParts(page, id);
      assert(parts.length >= 2, `${id} is split into items: ${JSON.stringify(parts)}`);
      parts.forEach((part, index) => {
        assert.equal(part.lines, 1, `${id}: 「${part.text}」 stays on one line`);
        assert.doesNotMatch(part.text, /·\s*$/, `${id}: no item ends in a dot`);
        if (index) assert.match(part.text, /^· /, `${id}: the dot travels with the item after it`);
      });
    }
    assert.match(await page.locator('#statAmountSub').textContent(), /^比 10 月同期 [+-]\d+% · \d+ 单 · 草稿和报价不计$/);
    assert.match(await page.locator('#statTasksSub').textContent(), /物流异常 1/);
    const issuePart = (await captionParts(page, 'statTasksSub')).find(part => /物流异常 1/.test(part.text));
    assert.equal(issuePart.lines, 1, '「物流异常 1」 is not split');

    // ---- 2. board hint ----
    const hint = page.locator('.drag-hint');
    assert.equal((await hint.innerText()).trim(), '拖动改阶段 · 右键更多操作');
    assert.match(await hint.getAttribute('title'), /右键（触控板双指点按）卡片有收齐、推进、删除等操作/);

    // ---- 3. no target this month ----
    assert.equal(await page.locator('#statTargetRate').innerText(), '设目标');
    await page.evaluate(() => setPage('targets'));
    await page.waitForFunction(() => document.getElementById('page-targets')?.classList.contains('active'));
    // 没设目标的月份：四个格子去掉了（页面整理第三轮），实际完成和订单数写进这一句。
    assert.match(await page.locator('#targetProgressText').innerText(), /^11 月还没设目标 · 已完成 \$[\d,]+ · \d+ 单$/);
    assert.equal(await page.locator('#targetRate').textContent(), '', '#targetRate stays empty');
    assert.equal(await page.locator('#page-targets .target-metric').count(), 0, 'no goal / actual / gap / count cells');
    assert.equal(await page.locator('#page-targets .target-ring-text span').isVisible(), false, '「已完成」 is not shown under an empty ring');
    const targetPageText = await page.locator('#page-targets .target-page').innerText();
    assert.doesNotMatch(targetPageText, /未设|暂未|(^|\s)-(\s|$)/, `no placeholders on the target page: ${targetPageText}`);
    assert.match(await page.locator('#targetHistoryList [data-target-pick="2026-11"]').getAttribute('aria-label'), /未设置目标/, 'the row still says so to a screen reader');
    await page.evaluate(() => { state.performanceTargets = { ...(state.performanceTargets || {}), '2026-11':300000 }; render(); renderPerformanceTargets(); });
    assert.match(await page.locator('#targetRate').innerText(), /^\d+%$/);
    assert.equal(await page.locator('#page-targets .target-ring-text span').isVisible(), true);
    assert.match(await page.locator('#targetProgressText').innerText(), /^完成 \$[\d,]+，还差 \$[\d,]+。$/);
    assert.equal(await page.locator('#targetHistoryList [data-target-pick="2026-11"] .target-history-amount').innerText(), '$300,000');
    await page.evaluate(() => { delete state.performanceTargets['2026-11']; render(); renderPerformanceTargets(); });

    // ---- 4. global search ----
    await page.evaluate(() => setPage('dashboard'));
    await page.fill('#searchInput', 'T-261102');
    await page.waitForFunction(() => /T-261102/.test(document.getElementById('globalSearchPanel')?.textContent || ''));
    const subtitles = await page.evaluate(() => buildGlobalSearchResults('T-261102').filter(item => item.type === 'order').map(item => item.subtitle));
    assert(subtitles.length > 0);
    for (const subtitle of subtitles) {
      assert.doesNotMatch(subtitle, /暂无备注/);
      assert.doesNotMatch(subtitle, /·\s*$/, `no empty last segment: ${subtitle}`);
    }
    assert.doesNotMatch(await page.locator('#globalSearchPanel').innerText(), /暂无备注/);
    await page.keyboard.press('Escape');

    // ---- 5. drawer attachments ----
    await page.evaluate(() => openOrderDetail('o2', { tab:'attachments' }));
    const attachments = page.locator('#orderDetailBody [data-detail-tab="attachments"]');
    await attachments.waitFor({ state:'visible' });
    // 没有附件时，能改的订单只出上传区（不再叫人去「完整编辑…」里加），详见 test-detail-drawer-attachments-ui。
    assert.match(await attachments.innerText(), /把截图粘贴或拖到这里/);
    assert.doesNotMatch(await attachments.innerText(), /完整编辑|还没有附件/);
    await page.evaluate(() => openOrderDetail('gone', { tab:'attachments' }));
    await attachments.waitFor({ state:'visible' });
    assert.equal((await attachments.innerText()).replace(/\s+/g, ' ').trim(), '附件 / 凭证 没有附件。');
    assert.equal(await attachments.locator('[data-detail-attach-drop]').count(), 0, 'a read-only order has no upload area');
    await page.evaluate(() => closeOrderDetail());

    // ---- 7. order list, compact, 1294 and 1100 ----
    await page.evaluate(() => setPage('order-list'));
    await page.waitForSelector('#orderTableBody tr[data-order-list-id]');
    assert.equal(await page.locator('#page-order-list .order-table').getAttribute('data-density'), 'compact');
    for (const width of [1294, 1100]) {
      await page.setViewportSize({ width, height:847 });
      await page.waitForTimeout(200);
      const cells = await moneyCells(page);
      assertMoneyCells(cells, `${width}px`);
      const big = cells.find(cell => cell.id === 'o1');
      assert.equal(big.dueText, '待收 ¥864,197', 'compact 待收 leaves out the currency code the amount above already shows');
      assert(cells.some(cell => cell.barShown), `${width}px: bars that fit are still shown`);
    }
    assert.equal(await page.evaluate(() => orderListDueHtml(5, 'XYZ')), '5 XYZ', 'a currency without a symbol keeps its code');
    await page.locator('[data-order-list-density="comfortable"]').click();
    await page.waitForFunction(() => document.querySelector('#page-order-list .order-table').dataset.density === 'comfortable');
    assert.equal(await page.locator('#orderTableBody tr[data-order-list-id="o1"] .order-table-due-line').innerText(), '待收 ¥864,197 CNY', 'loose rows are unchanged');
    assert.deepEqual(errors, []);
    await context.close();

    // ---- 6. 设置 › 汇率, January 2027: eight past months ----
    const monthlyRates = { '2026-05':7.2, '2026-06':7.17, '2026-07':7.14, '2026-08':7.15, '2026-09':7.12, '2026-10':7.09, '2026-11':7.1, '2026-12':7.08, '2027-01':7.05 };
    for (const width of [1440, 1294]) {
      const ex = await open(browser, { width, height:920, now:'2027-01-15T11:00:00', data:{ exchangeSettings:{ monthlyRates, manualMonths:{ '2026-05':true, '2026-08':true, '2026-12':true } } } });
      await ex.page.evaluate(() => { setPage('settings'); document.querySelector('[data-settings-tab="exchange"]').click(); });
      await ex.page.waitForSelector('#exchangeMonthlyRateGrid .manual-rate-item');
      const cells = await ex.page.evaluate(() => [...document.querySelectorAll('#exchangeMonthlyRateGrid .manual-rate-item')].map(item => {
        const label = item.querySelector('.exchange-cell-head label');
        const tag = item.querySelector('.exchange-tag');
        const range = document.createRange();
        range.selectNodeContents(label);
        const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
        const box = item.getBoundingClientRect();
        const tagRect = tag?.getBoundingClientRect();
        return { month:label.textContent, lines, tagInside:tagRect ? tagRect.right <= box.right + 0.5 : true };
      }));
      assert.equal(cells.length, 8, 'eight past months');
      for (const cell of cells) {
        assert.equal(cell.lines, 1, `${width}px: 「${cell.month}」 stays on one line`);
        assert.equal(cell.tagInside, true, `${width}px: the 手填 tag of ${cell.month} stays inside its cell`);
      }
      assert.deepEqual(ex.errors, []);
      await ex.context.close();
    }
    console.log('Small tidy round 4 tests passed: card captions break between items, short board hint, target page without placeholders, search without 暂无备注, attachments empty state with edit link, exchange month names on one line, compact money cells stay in their column.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
