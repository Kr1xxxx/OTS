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
assert.match(html, /data-page="analysis"[^>]*>[\s\S]*?<span class="nav-text">分析<\/span>/, 'analysis navigation entry is missing');

const calendarPage = pageMarkup('calendar');
const analysisPage = pageMarkup('analysis');
assert.match(calendarPage, /id="calendarGrid"/, 'calendar page must own the month grid');
assert.match(calendarPage, /id="calendarAgenda"/, 'calendar page must own the monthly agenda');
assert.doesNotMatch(calendarPage, /id="customerGrowthChart"/, 'calendar page still contains customer analysis');
assert.match(analysisPage, /id="analysisCustomerMix"/, 'analysis page must show new and returning customer orders');
assert.match(analysisPage, /id="analysisAttention"/, 'analysis page must show actionable orders');
assert.match(analysisPage, /id="analysisClients"/, 'analysis page must show customer contribution');

const context = vm.createContext({});
vm.runInContext(extractFunction('groupCalendarEvents'), context);
const grouped = vm.runInContext(`groupCalendarEvents(${JSON.stringify([
  { type: 'order' },
  { type: 'urgent' },
  { type: 'due' },
  { type: 'payment' },
  { type: 'logistics' },
  { type: 'logistics' },
  { type: 'repurchase' },
  { type: 'customer' },
  { type: 'unknown' }
])})`, context);
assert.deepEqual(
  JSON.parse(JSON.stringify(grouped)),
  { order: 1, due: 3, logistics: 2, repurchase: 1, customer: 1, other: 1, total: 9 }
);

console.log('Calendar and analysis UI tests passed: retired freight flow, split navigation, page ownership, and event grouping verified.');
