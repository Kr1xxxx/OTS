#!/usr/bin/env node
// 订单额口径（2026-11 用户定的「都不算报价」）：凡是叫订单额 / 订单数的月度统计，只算收了定金之后的单（isRevenueOrder：
// 不是草稿，阶段是 生产中 / 待发货 / 已发货 / 已完成）。同一份数据下，工作台订单额卡、金额统计、经营分析、业绩目标
// 四处的订单额和单数相等；报价单推进到生产中后四处一起加上它；工作台「已收 · RMB」照旧算全部非草稿订单收到的钱。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, day, month } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const orders = [
  { ...base, id:'quote', num:'SCOPE-Q', client:'Quote Buyer', stage:'quote', amount:300, paidAmount:100 },
  { ...base, id:'prod', num:'SCOPE-P', client:'Prod Buyer', stage:'production', amount:200, paidAmount:50 },
  { ...base, id:'ship', num:'SCOPE-S', client:'Ship Buyer', stage:'shipment', amount:500, paidAmount:500 },
  { ...base, id:'done', num:'SCOPE-D', client:'Done Buyer', stage:'done', amount:100, paidAmount:100 },
  { ...base, id:'draft', num:'SCOPE-R', client:'Draft Buyer', stage:'production', amount:900, paidAmount:0, isDraft:true }
].map(order => ({ ...order, createdAt:day(1), orderMonth:month }));

const number = text => Number(String(text).replace(/[^\d.]/g, ''));

async function readAll(page) {
  return page.evaluate(m => {
    const text = id => document.getElementById(id).textContent;
    document.getElementById('totalRange').value = m;
    setPage('dashboard');
    render();
    const dashboard = { amount:text('statAmount'), sub:text('statAmountSub'), target:text('statTargetSub') };
    setPage('amount');
    renderAmountReport();
    const amount = { amount:text('reportUsd'), count:text('reportCount'), sub:text('reportUsd').length && document.querySelector('#reportUsd + .report-sub').textContent };
    setPage('analysis');
    activeBusinessMonth = m;
    analysisMonthTouched = true;
    renderAnalysisPage();
    const card = key => document.querySelector(`#analysisCompare [data-compare="${key}"] .report-value`).textContent;
    const analysis = { amount:card('total'), count:card('count'), clients:document.querySelectorAll('#analysisClients .analysis-rank').length };
    setPage('targets');
    renderPerformanceTargets();
    // 业绩目标页的四个格子去掉了：实际完成和订单数看近月目标记录里这个月那一行。
    const row = document.querySelector(`#targetHistoryList [data-target-pick="${m}"]`);
    const targets = { actual:row.querySelector('.target-history-values span').textContent, count:row.querySelector('.target-history-count').textContent };
    setPage('dashboard');
    return { dashboard, amount, analysis, targets };
  }, month);
}

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders, performanceTargets:{ [month]:5000 } }, { port:freePortSync() });

    const before = await readAll(page);
    // 生产中 200 + 已发货 500 + 已完成 100；报价 300 和草稿 900 都不算。
    assert.equal(number(before.dashboard.amount), 800, `工作台订单额：${before.dashboard.amount}`);
    assert.match(before.dashboard.sub, /3 单 · 草稿和报价不计/);
    assert.equal(number(before.amount.amount), 800, `金额统计订单额：${before.amount.amount}`);
    assert.equal(before.amount.count, '3');
    assert.equal(before.amount.sub, '草稿和报价不计');
    assert.equal(number(before.analysis.amount), 800, `经营分析订单额：${before.analysis.amount}`);
    assert.equal(before.analysis.count, '3 单');
    assert.equal(before.analysis.clients, 3, '报价单的客户不进客户贡献');
    assert.equal(number(before.targets.actual), 800, `业绩目标实际完成：${before.targets.actual}`);
    assert.equal(before.targets.count, '3');
    assert.match(before.dashboard.target, /已完成 \$800/);
    assert.match(await page.locator('#analysisSection .analysis-footnote').textContent(), /草稿和报价阶段的订单不计/);
    assert.match(await page.locator('#page-targets .target-setup-head .section-meta').innerText(), /草稿和报价不计入/);

    // 「已收 · RMB」：收到的钱照算，报价单收的 100 也在里面（和改之前一样，用全部非草稿、有金额的单）。
    const paid = await page.evaluate(() => {
      amountStatMode = 'paidRmb';
      renderStats();
      const expected = rmbMoney(usdPaidTotalRmb(state.orders.filter(o => !o.isDraft && orderAmountValue(o) > 0)));
      const result = { shown:document.getElementById('statAmount').textContent, expected, sub:document.getElementById('statAmountSub').textContent };
      amountStatMode = 'totalUsd';
      renderStats();
      return result;
    });
    assert.equal(paid.shown, paid.expected);
    assert.match(paid.sub, /^4 单有收款/, '报价单收到的定金照样算进已收');

    // 报价单收了定金推进到生产中：四处同时加上 300。
    await page.evaluate(() => moveOrderToStage('quote', 'production'));
    const after = await readAll(page);
    assert.equal(number(after.dashboard.amount), 1100);
    assert.match(after.dashboard.sub, /4 单 · 草稿和报价不计/);
    assert.equal(number(after.amount.amount), 1100);
    assert.equal(after.amount.count, '4');
    assert.equal(number(after.analysis.amount), 1100);
    assert.equal(after.analysis.count, '4 单');
    assert.equal(after.analysis.clients, 4);
    assert.equal(number(after.targets.actual), 1100);
    assert.equal(after.targets.count, '4');

    assert.deepEqual(errors, [], errors.join('\n'));
    assert.deepEqual(dialogs, []);
    console.log('Order amount scope UI passed: dashboard, amount report, business analysis and targets agree (drafts and quotes excluded), a quote moved to production joins all four, paid RMB unchanged.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
