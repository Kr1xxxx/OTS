#!/usr/bin/env node
// Pages round 3 (round 5 of the tidy-ups): 经营分析, 业绩目标, 金额统计 and two colours. Only what is shown changes:
// 1. 经营分析「现在需要关注」: one line per order (client, then the order number); a long client name is cut, the number is not
// 2. the new / returning customer cells: no「客户信息不全」cell when it would say 0, the other two share the width
// 3. 业绩目标 has no goal / actual / gap / count cells; a month without a goal says「… 还没设目标 · 已完成 $X · N 单」
// 4. 待收 in the time summary and in the order drawer's customer tab is amber, like everywhere else
// 5. the client contribution bars follow the accent colour
// 6. the time summary leaves 客单价 empty for a single order
// 7. the amount bar chart has no SVG <title>; the app's own tooltip shows the same text, and each group carries it as aria-label
// The clock is fixed in the page (Asia/Shanghai); customers and orders are made up.
const assert = require('node:assert/strict');
const { launchBrowser } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

const at = text => new Date(`${text}+08:00`);
const base = { currency:'USD', logisticsStatus:'未发货', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[], orderType:'定金订单', depositAmount:300 };
let seq = 0;
const order = extra => { seq += 1; return { ...base, id:`o${seq}`, num:`T-26110${seq}`, paidAmount:300, amount:1000, stage:'production', createdAt:'2026-11-03', orderMonth:'2026-11', updated:'2026-11-06 09:00', ...extra }; };
const LONG = 'Sample Extremely Long Wholesale Hair Company International Trading Limited Partnership';
const orders = [
  order({ client:LONG, amount:9000, paidAmount:2700 }),
  order({ client:'Sample Beta', amount:4000, paidAmount:1200, createdAt:'2026-11-05' }),
  order({ client:'Sample Beta', amount:2000, paidAmount:600, createdAt:'2026-10-05', orderMonth:'2026-10' }),
  order({ client:'Sample Gamma', amount:1500, paidAmount:1500, stage:'shipment', createdAt:'2026-11-08' })
];

async function open(browser, extra = {}) {
  const context = await browser.newContext({ viewport:{ width:1440, height:900 }, timezoneId:'Asia/Shanghai' });
  await context.clock.setFixedTime(at('2026-11-17T11:00:00'));
  await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  const store = { app:'trade-order-system', data:{ orders, deletedOrders:[], customers:{}, doneTasks:{}, demoCleared:true, demoCustomersCleared:true, ...extra }, revision:0 };
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    let response = { ok:true };
    if (pathname === '/api/data') response = store;
    if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
    if (pathname === '/api/ecb-rates') response = { ok:true, rates:[{ date:'2026-11-02', rates:{ CNY:7.7, USD:1.08 } }] };
    if (pathname === '/api/usd-cny-rate') response = { ok:false };
    if (pathname === '/api/save') {
      store.data = route.request().postDataJSON().state;
      store.revision += 1;
      response = { ok:true, revision:store.revision, backup:{ ok:true, skipped:true } };
    }
    return route.fulfill({ json:response });
  });
  await page.goto('http://127.0.0.1:47993/trade-order-system.html');
  await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  return { page, context, errors };
}

// The colour a CSS variable resolves to on this page, for comparing with computed colours.
const varColor = (page, name, prop = 'color') => page.evaluate(([name, prop]) => {
  const probe = document.createElement('span');
  probe.style[prop] = `var(${name})`;
  document.querySelector('.content').appendChild(probe);
  const value = getComputedStyle(probe)[prop];
  probe.remove();
  return value;
}, [name, prop]);

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, context, errors } = await open(browser);

    // ---- 1. 现在需要关注 ----
    await page.evaluate(() => { setPage('analysis'); activeBusinessMonth = '2026-11'; analysisMonthTouched = true; renderAnalysisPage(); });
    await page.waitForSelector('#analysisAttention .analysis-action-row');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#analysisAttention [data-attention-group="receivables"] .analysis-action-row')].map(row => {
      const client = row.querySelector('.analysis-action-client');
      const num = row.querySelector('span:first-child > small');
      return {
        height:row.getBoundingClientRect().height,
        client:client.textContent, clientTitle:client.title,
        clientCut:client.scrollWidth > client.clientWidth,
        num:num.textContent, numWhole:num.scrollWidth <= num.clientWidth + 1,
        sameLine:Math.abs(client.getBoundingClientRect().bottom - num.getBoundingClientRect().bottom) < 4
      };
    }));
    assert.equal(rows.length, 3, JSON.stringify(rows));
    rows.forEach(row => {
      assert.ok(row.height <= 44, `one line per order (${row.height}px)`);
      assert.ok(row.sameLine, `${row.client}: the order number sits on the client's line`);
      assert.ok(row.numWhole, `${row.num} is never cut`);
      assert.equal(row.clientTitle, row.client);
    });
    assert.ok(rows.find(row => row.client === LONG).clientCut, 'the long client name is the part that is cut');

    // ---- 2. new / returning cells ----
    const mix = () => page.evaluate(() => [...document.querySelectorAll('#analysisCustomerMix .analysis-rank')].map(cell => ({ text:cell.innerText.replace(/\s+/g, ' ').trim(), width:Math.round(cell.getBoundingClientRect().width) })));
    let cells = await mix();
    assert.deepEqual(cells.map(cell => cell.text.split(' ')[0]), ['新客户订单', '老客户订单'], 'no 客户信息不全 cell at 0');
    assert.ok(Math.abs(cells[0].width - cells[1].width) <= 1, 'the two cells share the width');
    await page.evaluate(() => { state.orders.push({ ...state.orders[0], id:'nameless', num:'T-NONAME', client:'' }); renderAnalysisPage(); });
    cells = await mix();
    assert.deepEqual(cells.map(cell => cell.text.split(' ')[0]), ['新客户订单', '老客户订单', '客户信息不全']);
    assert.match(cells[2].text, /^客户信息不全 1 单 25%$/);
    await page.evaluate(() => { state.orders = state.orders.filter(o => o.id !== 'nameless'); renderAnalysisPage(); });

    // ---- 5. contribution bars follow the accent ----
    const accent = await varColor(page, '--accent', 'backgroundColor');
    const bars = await page.evaluate(() => [...document.querySelectorAll('#analysisClients .analysis-rank-bar b')].map(b => getComputedStyle(b).backgroundColor));
    assert.ok(bars.length >= 2);
    bars.forEach(color => assert.equal(color, accent));

    // ---- 3. targets ----
    await page.evaluate(() => setPage('targets'));
    await page.waitForFunction(() => document.getElementById('page-targets')?.classList.contains('active'));
    assert.equal(await page.locator('#page-targets .target-metrics, #page-targets .target-metric').count(), 0);
    assert.equal(await page.locator('#targetProgressText').innerText(), '11 月还没设目标 · 已完成 $14,500 · 3 单');
    assert.equal(await page.locator('#clearTargetBtn').isVisible(), false, 'no 清除 link without a goal');
    await page.locator('#targetMonth').selectOption('2026-12');
    assert.equal(await page.locator('#targetProgressText').innerText(), '12 月还没设目标', 'a month without orders says only that');
    await page.locator('#targetMonth').selectOption('2026-11');

    // ---- 4 + 6. time summary ----
    await page.evaluate(() => setPage('amount'));
    await page.waitForSelector('#monthReportTable .amount-time-row:not(.head)');
    const amber = await varColor(page, '--s-amber');
    const table = await page.evaluate(() => [...document.querySelectorAll('#monthReportTable .amount-time-row:not(.head)')].map(row => {
      const cells = [...row.children];
      const due = row.querySelector('.balance-amount');
      return { count:cells[1].textContent, avg:cells[5].textContent, dueColor:due ? getComputedStyle(due).color : '', dueWeight:due ? getComputedStyle(due).fontWeight : '' };
    }));
    assert.ok(table.length >= 2, JSON.stringify(table));
    table.forEach(row => {
      if (row.count === '1单') assert.equal(row.avg, '', 'one order: no 客单价');
      else assert.match(row.avg, /^\$[\d,]+$/);
      if (row.dueColor) assert.deepEqual([row.dueColor, row.dueWeight], [amber, '500'], '待收 is amber');
    });
    assert.ok(table.some(row => row.count === '1单') && table.some(row => row.dueColor), 'the fixture has a one-order row and a 待收 cell');

    // ---- 7. chart tooltip ----
    assert.equal(await page.locator('#amountChart title').count(), 0, 'no SVG title, so no system tooltip');
    const group = page.locator('#amountChart g[data-chart-tip]').filter({ has:page.locator('rect.chart-bar') }).first();
    const tip = await group.getAttribute('data-chart-tip');
    assert.match(tip, /：订单总额 \$[\d,]+ · 已收 \$[\d,]+$/);
    assert.equal(await group.getAttribute('aria-label'), tip);
    // The bars grow in when the page opens; measure them once they stand still, or the pointer lands beside a moving bar.
    await page.waitForFunction(() => [...document.querySelectorAll('#amountChart rect.chart-bar')].every(rect => !rect.getAnimations().length));
    let barBox = null;
    for (const rect of await page.locator('#amountChart g[data-chart-tip] rect.chart-bar:not(.paid)').all()) {
      const box = await rect.boundingBox();
      if (box && box.height > 4) { barBox = box; break; }
    }
    assert.ok(barBox, 'a bar with a height to hover');
    await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
    await page.waitForFunction(() => document.querySelector('.level-tooltip.show'));
    assert.match(await page.locator('.level-tooltip.show').innerText(), /：订单总额 \$[\d,]+ · 已收 \$[\d,]+$/);
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => !document.querySelector('.level-tooltip.show'));

    // ---- 4. drawer, customer tab ----
    await page.evaluate(() => openOrderDetail('o2', { tab:'customer' }));
    await page.waitForSelector('#orderDetailDrawer.open .order-detail-related-amount small.customer-due-amount');
    const drawerDue = await page.locator('.order-detail-related-amount small.customer-due-amount').first().evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).fontWeight]);
    assert.deepEqual(drawerDue, [amber, '500']);

    assert.deepEqual(errors, []);
    await context.close();
    console.log('Analysis / targets round 5 UI passed: attention rows on one line, no empty 客户信息不全 cell, accent contribution bars, targets without the four cells, amber 待收, no 客单价 for one order, app tooltip on the bar chart.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
