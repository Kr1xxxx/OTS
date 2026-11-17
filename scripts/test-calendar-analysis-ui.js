#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { html, extractFunction } = require('./helpers/page-source');

function pageMarkup(id) {
  const start = html.indexOf(`<section class="page" id="page-${id}">`);
  if (start < 0) throw new Error(`Missing page: ${id}`);
  const next = html.indexOf('<section class="page" id="page-', start + 1);
  return html.slice(start, next < 0 ? html.length : next);
}

assert.doesNotMatch(html, /data-page="freight"/, 'navigation still exposes the retired freight page');
assert.doesNotMatch(html, /id="page-freight"/, 'retired freight page is still rendered');
assert.match(html, /data-page="calendar"[^>]*>[\s\S]*?<span class="nav-text">日历<\/span>/, 'calendar navigation entry is missing');
// 数据与目标拆成三个页签（金额统计 / 经营分析 / 业绩目标）：经营分析是自己的一页，侧栏仍只有「数据与目标」一项。
assert.doesNotMatch(html, /class="nav-item"[^>]*data-page="analysis"/, 'analysis must not get its own sidebar entry');
assert.match(html, /id="page-analysis"/, '经营分析 has its own page');
for (const page of ['amount', 'analysis', 'targets']) {
  assert.deepEqual([...pageMarkup(page).matchAll(/role="tab" data-page="(\w+)"/g)].map(m => m[1]), ['amount', 'analysis', 'targets'], `${page} page shows the three insight tabs`);
}
assert.doesNotMatch(html, /id="amountMonth"/, '金额统计 keeps one time control (the 数字卡 month is gone)');

const calendarPage = pageMarkup('calendar');
const analysisPage = pageMarkup('analysis');
assert.match(analysisPage, /id="analysisSection"/, '经营分析 page hosts the analysis section');
assert.doesNotMatch(pageMarkup('amount'), /id="analysisSection"/, '金额统计 no longer carries the analysis section');
assert.match(calendarPage, /id="calendarGrid"/, 'calendar page must own the month grid');
assert.match(calendarPage, /id="calendarAgenda"/, 'calendar page must own the monthly agenda');
assert.doesNotMatch(calendarPage, /id="customerGrowthChart"/, 'calendar page still contains customer analysis');
assert.match(analysisPage, /id="analysisCustomerMix"/, 'analysis page must show new and returning customer orders');
assert.match(analysisPage, /id="analysisAttention"/, 'analysis page must show actionable orders');
assert.match(analysisPage, /id="analysisClients"/, 'analysis page must show customer contribution');

// 目标金额解析和完成率：没到目标不显示 100%；「5万」「50,000」「$5w」都认；空、负数、0、乱填不保存。
const context = vm.createContext({});
vm.runInContext(extractFunction('targetRate'), context);
vm.runInContext(extractFunction('parseTargetAmount'), context);
const run = code => JSON.parse(JSON.stringify(vm.runInContext(code, context)));
assert.deepEqual(run('[targetRate(996, 1000), targetRate(999.9, 1000), targetRate(1000, 1000), targetRate(1500, 1000), targetRate(5, 0)]'), [99, 99, 100, 150, 0]);
assert.deepEqual(run(`['5万', '50,000', ' $50000 ', '５００００', '50k', '5w', '12.5', '50000 USD'].map(t => parseTargetAmount(t).value)`), [50000, 50000, 50000, 50000, 50000, 50000, 12.5, 50000]);
for (const bad of ['', '-500', '0', 'abc', '5万5']) assert.equal(run(`parseTargetAmount(${JSON.stringify(bad)}).ok`), false, `「${bad}」不应保存`);

console.log('Calendar and analysis UI tests passed: retired freight flow, split navigation, page ownership, target parsing and completion rate verified.');
