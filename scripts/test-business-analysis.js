#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');

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

assert.doesNotMatch(html, /data-page="orders"/, 'navigation still exposes the duplicate order tracking page');
assert.doesNotMatch(html, /id="page-orders"/, 'duplicate order tracking page is still rendered');
assert.match(html, /data-page="order-list"[^>]*>[\s\S]*?订单列表/, 'order list must remain the primary order page');

[
  'businessMonthTitle',
  'businessTrendChart',
  'businessPaymentStructure',
  'businessProductContribution'
].forEach(id => assert.match(html, new RegExp(`id="${id}"`), `missing business analysis output: ${id}`));
['reportUsd','reportPaid','reportDue','reportCount'].forEach(id => assert.match(html, new RegExp(`id="${id}"`), `merged page must keep the amount KPI: ${id}`));
assert.doesNotMatch(html, /id="businessRevenue"/, 'analysis KPI grid duplicated the 金额统计 数字卡 and was removed');

const context = vm.createContext({});
vm.runInContext(extractFunction('ecbUsdRateForOrder'), context);
vm.runInContext(extractFunction('orderAmountUsd'), context);
vm.runInContext(extractFunction('orderPaidUsd'), context);
vm.runInContext(extractFunction('businessAnalysisForMonth'), context);
const result = vm.runInContext(`businessAnalysisForMonth(${JSON.stringify([
  { orderMonth:'2026-08', createdAt:'2026-08-28', amount:100, paidAmount:100, currency:'USD', productType:'假发' },
  { orderMonth:'2026-08', createdAt:'2026-08-28', amount:200, paidAmount:50, currency:'USD', productType:'睫毛' },
  { orderMonth:'2026-08', amount:500, paidAmount:0, currency:'USD', productType:'假发', isDraft:true },
  { orderMonth:'2026-08', createdAt:'2026-08-29', amount:300, paidAmount:300, currency:'EUR', productType:'其他' },
  { orderMonth:'2026-07', amount:900, paidAmount:900, currency:'USD', productType:'假发' }
])}, '2026-08', ${JSON.stringify([
  { date:'2026-08-28', rates:{ USD:1.2, EUR:1, GBP:0.8 } }
])})`, context);

assert.deepEqual(JSON.parse(JSON.stringify(result)), {
  month:'2026-08',
  orderCount:3,
  convertedOrderCount:3,
  missingRateCount:0,
  total:660,
  paid:510,
  due:150,
  average:220,
  collectionRate:77,
  products:[
    { name:'其他', count:1, amount:360 },
    { name:'睫毛', count:1, amount:200 },
    { name:'假发', count:1, amount:100 }
  ]
});

assert.ok(Math.abs(vm.runInContext(`ecbUsdRateForOrder({ currency:'GBP', createdAt:'2026-08-29' }, ${JSON.stringify([
  { date:'2026-08-28', rates:{ USD:1.2, GBP:0.8 } }
])})`, context) - 1.5) < 1e-9, '周末订单必须使用之前最近一个 ECB 工作日汇率');

vm.runInContext(extractFunction('analysisDashboardData'), context);
const snapshot = context.analysisDashboardData([
  {id:'old',client:'A',orderMonth:'2026-07',amount:100,paidAmount:100,currency:'USD',productType:'假发'},
  {id:'new',client:'A',orderMonth:'2026-08',amount:200,paidAmount:50,currency:'USD',productType:'睫毛',latestShipDate:'2026-08-01',stage:'production'},
  {id:'b',client:'B',orderMonth:'2026-08',amount:100,paidAmount:100,currency:'USD',productType:'睫毛',stage:'shipment'},
  {id:'draft',client:'C',orderMonth:'2026-08',amount:900,isDraft:true}
], '2026-08', '睫毛', '2026-09-08', []);
assert.equal(snapshot.current.total,300);
assert.equal(snapshot.previous.total,0);
assert.equal(snapshot.newOrders,1);
assert.equal(snapshot.repeatOrders,1);
assert.deepEqual(JSON.parse(JSON.stringify(snapshot.overdue.map(o=>o.id))),['new']);
assert.equal(snapshot.receivables.length,1);
assert.equal(snapshot.clients[0].name,'A');
assert.equal(context.analysisDashboardData([], '2026-08','all','2026-09-08',[]).current.total,0);
assert.equal(context.analysisDashboardData([{id:'shipped',stage:'shipment',amount:100,paidAmount:0,currency:'USD'}], '2026-08','all','2026-09-08',[]).receivables.length,0, '发货视为收清，不能重复催收');
console.log('Business analysis tests passed.');
