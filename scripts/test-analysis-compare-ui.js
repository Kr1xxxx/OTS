#!/usr/bin/env node
// 经营分析顶上「和上月整月比」的三张卡（订单额 / 订单数 / 平均订单额）：数等于 analysisDashboardData() 的 current / previous；
// 上月不为 0 写幅度和上月的数，上月为 0、两期均为 0 照写；缺汇率时两张金额卡不比、订单数照常；没开始的月份三张都不比；
// 看本月时下面写「当月尚未结束」。也看三个页签能互相切、金额统计没有单独的数字卡月份。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, month } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const shift = (ym, delta) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const m1 = shift(month, -1), m2 = shift(month, -2), m3 = shift(month, -3);
const order = (id, ym, amount, extra = {}) => ({ ...base, id, num:`CMP-${id}`, client:`Buyer ${id}`, stage:'production', amount, paidAmount:0, orderMonth:ym, createdAt:`${ym}-05`, ...extra });
const orders = [
  order('a', m2, 200),
  order('b', m1, 300, { stage:'done' }),
  order('c', m1, 100, { stage:'shipment' }),
  order('d', month, 500),
  // 欧元单：测试里没有欧洲央行汇率，这单折不成美元。
  order('e', month, 400, { currency:'EUR' }),
  // 报价单不算（第 8 节口径）。
  order('q', m1, 900, { stage:'quote' })
];

async function cards(page, ym) {
  return page.evaluate(ym => {
    analysisMonthTouched = true;
    activeBusinessMonth = ym;
    renderAnalysisPage();
    const read = key => {
      const card = document.querySelector(`#analysisCompare [data-compare="${key}"]`);
      return { value:card.querySelector('.report-value').textContent, sub:card.querySelector('.report-sub').textContent.trim(), trend:card.querySelector('.report-sub span')?.className || '' };
    };
    const data = analysisDashboardData(state.orders, ym, 'all', normalizeDate(new Date().toISOString()), ecbHistoricalRates);
    const money = value => summaryMoney(value, 'USD');
    return {
      total:read('total'), count:read('count'), average:read('average'),
      note:document.getElementById('analysisCompareNote').textContent,
      expected:{ total:money(data.current.total), count:`${data.current.orderCount} 单`, average:data.current.convertedOrderCount ? money(data.current.average) : '—', prevTotal:money(data.previous.total), prevAverage:money(data.previous.average), prevCount:data.previous.orderCount }
    };
  }, ym);
}

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { port:freePortSync() });

    // 三个页签互相能切；金额统计只剩图表范围一个时间开关。
    await page.evaluate(() => setPage('amount'));
    assert.equal(await page.locator('#amountMonth').count(), 0);
    for (const target of ['analysis', 'targets', 'amount', 'analysis']) {
      await page.locator('.page.active .insights-tabs [data-page="' + target + '"]').click();
      assert.equal(await page.evaluate(() => document.querySelector('.page.active').id), `page-${target}`);
      assert.equal(await page.locator('.nav-item[data-nav-group="insights"]').evaluate(el => el.classList.contains('active')), true);
    }

    // 上月不为 0：过去的整月（m1 对 m2），不写「当月尚未结束」。
    let c = await cards(page, m1);
    assert.equal(c.total.value, c.expected.total);
    assert.equal(c.count.value, c.expected.count);
    assert.equal(c.average.value, c.expected.average);
    assert.equal(c.total.value, '$400', '报价单不算');
    assert.equal(c.total.sub, `↑ 100.0%上月 ${c.expected.prevTotal}`);
    assert.equal(c.total.trend, 'up');
    assert.equal(c.count.sub, `↑ 1 单上月 ${c.expected.prevCount} 单`);
    assert.equal(c.average.sub, `持平上月 ${c.expected.prevAverage}`);
    assert.equal(c.note, '');

    // 上月为 0。
    c = await cards(page, m2);
    assert.equal(c.total.value, '$200');
    assert.deepEqual([c.total.sub, c.count.sub, c.average.sub], ['上月为 0', '上月为 0', '上月为 0']);

    // 两期均为 0。
    c = await cards(page, m3);
    assert.deepEqual([c.total.value, c.count.value, c.average.value], ['$0', '0 单', '—']);
    assert.deepEqual([c.total.sub, c.count.sub, c.average.sub], ['两期均为 0', '两期均为 0', '两期均为 0']);

    // 本月：欧元单缺汇率，金额两张卡不比，订单数照常比；下面两行说明。
    c = await cards(page, month);
    assert.equal(c.total.value, c.expected.total);
    assert.equal(c.count.value, '2 单');
    assert.equal(c.total.sub, '');
    assert.equal(c.average.sub, '');
    assert.equal(c.count.sub, `持平上月 ${c.expected.prevCount} 单`);
    assert.equal(c.note, '有订单缺少汇率，金额对比暂不展示。 当月尚未结束，不代表最终增减。');

    // 还没开始的月份：三张都不比。
    c = await cards(page, shift(month, 1));
    assert.deepEqual([c.total.sub, c.count.sub, c.average.sub], ['', '', '']);
    assert.equal(c.note, '这个月还没开始，不做环比。');

    // 口径说明在页面最底下一行。
    const foot = await page.evaluate(() => { const el = document.querySelector('#analysisSection .analysis-footnote'); return { last:el === el.parentElement.lastElementChild, text:el.textContent }; });
    assert.equal(foot.last, true);
    assert.match(foot.text, /草稿和报价阶段的订单不计/);
    assert.match(foot.text, /未记录成本，不统计利润/);

    // 窄窗口：三张卡不出框。
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height:900 });
      const fits = await page.locator('#analysisCompare .report-value').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth + 1));
      assert.equal(fits, true, `compare cards fit at ${width}px`);
    }

    assert.deepEqual(errors, [], errors.join('\n'));
    assert.deepEqual(dialogs, []);
    console.log('Analysis compare UI passed: three insight tabs, cards match analysisDashboardData (previous > 0, previous 0, both 0, missing rate, not started), footnote at the bottom, narrow widths.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
