#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');

function pageMarkup(id) {
  const start = html.indexOf(`<section class="page" id="page-${id}">`);
  if (start < 0) throw new Error(`Missing page: ${id}`);
  const next = html.indexOf('<section class="page" id="page-', start + 1);
  return html.slice(start, next < 0 ? html.length : next);
}

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  const bodyStart = html.indexOf('{', start);
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const candidate = html.slice(start, index + 1);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error(`Unclosed function: ${name}`);
}

assert.doesNotMatch(html, /data-page="freight"/, 'navigation still exposes the retired freight page');
assert.doesNotMatch(html, /id="page-freight"/, 'retired freight page is still rendered');
assert.match(html, /data-page="calendar"[^>]*>[\s\S]*?<span class="nav-text">日历<\/span>/, 'calendar navigation entry is missing');
// 分析 merged into the 金额统计 page (PM review P1 #13): no separate tab or page any more.
assert.doesNotMatch(html, /data-page="analysis"/, 'analysis must not keep a separate navigation entry');
assert.doesNotMatch(html, /id="page-analysis"/, 'analysis must not keep a separate page');

const calendarPage = pageMarkup('calendar');
const analysisPage = pageMarkup('amount');
assert.match(analysisPage, /id="analysisSection"/, '金额统计 page must host the 经营分析 section');
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
