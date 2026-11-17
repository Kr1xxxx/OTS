#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { html, extractFunction } = require('./helpers/page-source');

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

// 订单额只算收了定金之后的单（isRevenueOrder）：用页面里的阶段表和 normalizeStage。
function extractConst(name) {
  const start = html.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`Missing const: ${name}`);
  const end = html.indexOf('\n];', start);
  return `${html.slice(start, end + 3)}\nthis.${name} = ${name};`;
}
const context = vm.createContext({});
vm.runInContext(extractConst('stageDefs'), context);
vm.runInContext(extractFunction('normalizeStage'), context);
vm.runInContext(extractFunction('isRevenueOrder'), context);
vm.runInContext(extractFunction('ecbUsdRateForOrder'), context);
vm.runInContext(extractFunction('orderAmountUsd'), context);
vm.runInContext(extractFunction('orderPaidUsd'), context);
vm.runInContext(extractFunction('businessAnalysisForMonth'), context);
const result = vm.runInContext(`businessAnalysisForMonth(${JSON.stringify([
  { orderMonth:'2026-08', createdAt:'2026-08-28', amount:100, paidAmount:100, currency:'USD', productType:'假发', stage:'done' },
  { orderMonth:'2026-08', createdAt:'2026-08-28', amount:200, paidAmount:50, currency:'USD', productType:'睫毛', stage:'production' },
  { orderMonth:'2026-08', amount:500, paidAmount:0, currency:'USD', productType:'假发', isDraft:true, stage:'production' },
  { orderMonth:'2026-08', createdAt:'2026-08-29', amount:300, paidAmount:300, currency:'EUR', productType:'其他', stage:'shipment' },
  // 报价阶段（含旧数据里的 sample / 认不出的阶段）不算订单额。
  { orderMonth:'2026-08', createdAt:'2026-08-29', amount:700, paidAmount:100, currency:'USD', productType:'假发', stage:'quote' },
  { orderMonth:'2026-08', createdAt:'2026-08-29', amount:40, paidAmount:0, currency:'USD', productType:'睫毛', stage:'sample' },
  { orderMonth:'2026-08', createdAt:'2026-08-29', amount:60, paidAmount:0, currency:'USD', productType:'睫毛' },
  { orderMonth:'2026-07', amount:900, paidAmount:900, currency:'USD', productType:'假发', stage:'done' }
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

// 「超过最晚发出日期」和工作台待办共用 orderPastShipDeadline。
vm.runInContext(extractFunction('isSettledStage'), context);
vm.runInContext(extractFunction('orderPastShipDeadline'), context);
vm.runInContext(extractFunction('analysisDashboardData'), context);
const snapshot = context.analysisDashboardData([
  {id:'old',client:'A',orderMonth:'2026-07',amount:100,paidAmount:100,currency:'USD',productType:'假发',stage:'done'},
  {id:'new',client:'A',orderMonth:'2026-08',amount:200,paidAmount:50,currency:'USD',productType:'睫毛',latestShipDate:'2026-08-01',stage:'production'},
  {id:'b',client:'B',orderMonth:'2026-08',amount:100,paidAmount:100,currency:'USD',productType:'睫毛',stage:'shipment'},
  // B 上个月只报过价：报价不算「下过单」，B 这个月仍是新客户。
  {id:'b-quote',client:'B',orderMonth:'2026-07',amount:100,paidAmount:0,currency:'USD',productType:'睫毛',stage:'quote'},
  // 这个月的报价单：不进订单额、客户排名、新老客户；但没收清，仍在「未收清订单」里。
  {id:'q',client:'Q',orderMonth:'2026-08',amount:500,paidAmount:100,currency:'USD',productType:'睫毛',stage:'quote'},
  {id:'draft',client:'C',orderMonth:'2026-08',amount:900,isDraft:true}
], '2026-08', '睫毛', '2026-09-08', []);
assert.equal(snapshot.current.total,300);
assert.equal(snapshot.current.orderCount,2, '报价单不算订单数');
assert.equal(snapshot.previous.total,0, '上个月只有报价单：订单额为 0');
assert.equal(snapshot.newOrders,1);
assert.equal(snapshot.repeatOrders,1);
assert.equal(snapshot.unknownOrders,0);
assert.equal(snapshot.monthly.length,snapshot.current.orderCount, '新老客户的单数加起来等于订单数');
assert.deepEqual([...snapshot.clients.map(row=>row.name)].sort(),['A','B'], '报价单的客户不进客户贡献');
assert.deepEqual(JSON.parse(JSON.stringify(snapshot.overdue.map(o=>o.id))),['new']);
assert.deepEqual([...snapshot.receivables.map(o=>o.id)].sort(),['b-quote','new','q'], '未收清清单不是订单额，报价单照列（不分月份）');
assert.equal(snapshot.clients[0].name,'A');
assert.equal(context.analysisDashboardData([], '2026-08','all','2026-09-08',[]).current.total,0);
assert.equal(context.analysisDashboardData([{id:'shipped',stage:'shipment',amount:100,paidAmount:0,currency:'USD'}], '2026-08','all','2026-09-08',[]).receivables.length,0, '发货视为收清，不能重复催收');
console.log('Business analysis tests passed.');
