const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../trade-order-system.html'), 'utf8');
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  for (let end = html.indexOf('{', start); end < html.length; end++) {
    if (html[end] !== '}') continue;
    try { return new vm.Script(html.slice(start, end + 1)); } catch {}
  }
  throw Error(name);
}
const calls = [];
const context = vm.createContext({});
context.renderDeletedOrders = () => calls.push('renderDeletedOrders');
for (const name of ['renderStats','renderPipeline','renderTrash','renderRecentOrders','renderTasks','renderOrderListPage','renderFullSearchResults','renderLogistics','renderPriceHistory','renderTrackingApiMiniStatus','renderAmountReport','renderPerformanceTargets','renderCalendarPage','renderAnalysisPage','renderCustomers','renderSettings','renderExchangeSettings','renderMonthSelects']) context[name] = () => calls.push(name);
extract('renderPageContent').runInContext(context);
vm.runInContext("renderPageContent('customers')", context);
assert.deepEqual(calls, ['renderCustomers']);
calls.length = 0;
vm.runInContext("renderPageContent('order-list')", context);
assert.deepEqual(calls, ['renderOrderListPage']);
extract('paginateOrdersForList').runInContext(context);
extract('paginateSearchResults').runInContext(context);
context.rows = Array.from({length:123}, (_, id) => ({id}));
const page = JSON.parse(JSON.stringify(vm.runInContext('paginateSearchResults(rows, 3)', context)));
assert.equal(page.items.length, 23);
assert.equal(page.items[0].id, 100);
assert.equal(page.total, 123);
extract('backupSaveFeedback').runInContext(context);
assert.equal(vm.runInContext("backupSaveFeedback({ok:false}, '').warning", context), true);
assert.equal(vm.runInContext("backupSaveFeedback({ok:true,skipped:true}, 'previous failure').warning", context), true);
assert.equal(vm.runInContext("backupSaveFeedback({ok:true}, 'previous failure').warning", context), false);
console.log('Refresh, backup feedback and pagination tests passed.');
