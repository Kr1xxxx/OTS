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
    } catch (_) {
      // Continue until the complete production function compiles.
    }
  }
  throw new Error(`Unclosed function: ${name}`);
}
function extractConst(name) {
  const start = html.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`Missing const: ${name}`);
  const end = html.indexOf('\n];', start);
  return `${html.slice(start, end + 3)}\nthis.${name} = ${name};`;
}

// 只 mock 和这些函数无关的环境（国家、月份格式化、联系人显示名）；阶段、收款、搜索规范化都用正式代码，
// 以前 mock 的 isSettledStage 只认 done、normalizeSearchText 带 NFKC，和正式代码不一致，测试过了实际却不对。
const context = vm.createContext({
  console,
  normalizeCountry: value => String(value || '').trim(),
  normalizeMonth: value => String(value || '').slice(0, 7),
  clientDisplayName: value => String(value || ''),
  ecbHistoricalRates: [{ date:'2026-01-01', rates:{ USD:1, CNY:7.2, GBP:0.8, EUR:1 } }]
});
vm.runInContext(extractConst('stageDefs'), context);
[
  'globalSearchText',
  'normalizeSearchText',
  'searchCountryAliasGroups',
  'searchCountryAliasTable',
  'searchTextDocument',
  'boundedDamerauLevenshtein',
  'searchWordFuzzyMatch',
  'searchHasCjk',
  'searchAmountValue',
  'searchTextMatchDetail',
  'searchTextMatches',
  'stageDef',
  'normalizeStage',
  'isSettledStage',
  'roundMoneyValue',
  'orderAmountValue',
  'orderPaidValue',
  'orderDueValue',
  'cleanTracking',
  'parseDate',
  'ecbUsdRateForOrder',
  'orderAmountUsd',
  'orderPaidUsd',
  'orderDueUsd',
  'orderSearchText',
  'orderListSearchHaystack',
  'orderListQuickMatch',
  'orderListDetailMatch',
  'filterOrdersForList',
  'orderListSortValue',
  'sortOrdersForList',
  'paginateOrdersForList'
].forEach(name => vm.runInContext(extractFunction(name), context));

const orders = [
  {
    id:'o1', num:'SO26080101', client:'Alpha Salon', country:'🇺🇸 美国 United States', amount:100, paidAmount:100,
    productType:'假发', paymentChannel:'Paypal', stage:'done', createdAt:'2026-08-01', orderMonth:'2026-08', updated:'2026-08-03 09:00'
  },
  {
    id:'o2', num:'SO26080201', client:'London Beauty', country:'🇬🇧 英国 United Kingdom', amount:200, paidAmount:50,
    productType:'睫毛', paymentChannel:'阿里巴巴', stage:'production', createdAt:'2026-08-02', orderMonth:'2026-08', updated:'2026-08-04 10:00'
  },
  {
    id:'o3', num:'SO99073101', client:'Madrid Hair', country:'🇪🇸 西班牙 Spain', amount:150, paidAmount:150,
    productType:'假发', paymentChannel:'TT', stage:'shipment', trackingNumber:'1Z999AA10123456784', carrier:'UPS', logisticsStatus:'已签收',
    createdAt:'2026-07-31', orderMonth:'2026-07', updated:'2026-08-02 08:00'
  },
  {
    id:'o4', num:'SO26080501', client:'Draft Client', country:'🇨🇦 加拿大 Canada', amount:80, paidAmount:0,
    productType:'睫毛', paymentChannel:'Zelle', stage:'quote', isDraft:true, createdAt:'2026-08-05', orderMonth:'2026-08', updated:'2026-08-05 11:00'
  }
];
const customers = {
  'London Beauty': { email:'london@example.com', phone:'+44 7700 900127', address:'18 Sample Road, London' }
};

function evaluate(expression, data = orders) {
  context.orders = data;
  context.customers = customers;
  return JSON.parse(JSON.stringify(vm.runInContext(expression, context)));
}
const ids = (filters, data = orders) => evaluate(`filterOrdersForList(orders, ${JSON.stringify(filters)}, customers).map(item => item.id)`, data);

assert.deepEqual(ids({ quick:'all' }), ['o1', 'o2', 'o3', 'o4']);
// 正式代码里已发货和已完成都算「收齐」，「进行中」不含已发货。
assert.deepEqual(ids({ quick:'active' }), ['o2']);
// 「待收款」快捷标签和工作台一致，不含草稿。
assert.deepEqual(ids({ quick:'unpaid' }), ['o2']);
assert.deepEqual(ids({ query:'london@example.com' }), ['o2']);
assert.deepEqual(ids({ query:'7700 900127' }), ['o2']);
assert.deepEqual(ids({ query:'7700900' }), ['o2']);
assert.deepEqual(ids({ query:'Untied Kingdom' }), ['o2']);
assert.deepEqual(ids({ stage:'shipment', logistics:'delivered' }), ['o3']);
assert.deepEqual(ids({ country:'🇪🇸 西班牙 Spain', month:'2026-07' }), ['o3']);
assert.deepEqual(ids({ draft:'formal' }), ['o1', 'o2', 'o3']);

// 搜索：英文前缀、订单号前缀、中文阶段名、全角、小数金额、本地写法电话。
assert.deepEqual(ids({ query:'Alp' }), ['o1'], 'three-letter prefix finds Alpha Salon');
assert.deepEqual(ids({ query:'Lo' }), ['o2'], 'two-letter prefix finds London Beauty');
assert.deepEqual(ids({ query:'SO2608' }), ['o1', 'o2', 'o4'], 'order number prefix');
assert.deepEqual(ids({ query:'生产中' }), ['o2'], 'Chinese stage name is searchable');
assert.deepEqual(ids({ query:'报价' }), ['o4'], 'Chinese stage name is searchable');
assert.deepEqual(ids({ query:'production' }), [], 'internal stage key is not searchable');
assert.deepEqual(ids({ query:'ａｌｐｈａ' }), ['o1'], 'full-width letters match');
assert.deepEqual(ids({ query:'200.00' }), ['o2'], 'amount with decimals matches');
assert.deepEqual(ids({ query:'07700 900127' }), ['o2'], 'UK local phone format matches');
// 内部 id、更新时间里的数字不算命中。
assert.deepEqual(ids({ query:'0300' }), [], 'updated timestamp digits do not match');

const chinese = [
  { id:'c1', num:'K261006056', client:'张三美发用品', amount:100, paidAmount:0, stage:'quote', orderType:'定金订单', note:'黑色 13x4 lace', updated:'2026-10-06 10:00' },
  { id:'c2', num:'K261020038', client:'Bella Wigs', amount:100, paidAmount:0, stage:'quote', orderType:'定金订单', next:'催样品交期', updated:'2026-10-20 10:00' }
];
assert.deepEqual(ids({ query:'张三' }, chinese), ['c1'], 'two Chinese characters');
assert.deepEqual(ids({ query:'美发' }, chinese), ['c1'], 'Chinese substring in the middle');
assert.deepEqual(ids({ query:'定金' }, chinese), ['c1', 'c2'], 'order type substring');
assert.deepEqual(ids({ query:'交期' }, chinese), ['c2'], 'next-step substring');
assert.deepEqual(ids({ query:'K26' }, chinese), ['c1', 'c2'], 'order number prefix K26');

// 近似名只在没有精确结果时才出现。
const fuzzy = [
  { id:'f1', num:'A1', client:'Anna Beauty', amount:1, stage:'quote', updated:'2026-10-01 10:00' },
  { id:'f2', num:'A2', client:'Anne Salon', amount:1, stage:'quote', updated:'2026-10-02 10:00' }
];
assert.deepEqual(ids({ query:'Anna' }, fuzzy), ['f1'], 'exact match hides fuzzy matches');
assert.deepEqual(ids({ query:'Annx' }, fuzzy), ['f1', 'f2'], 'fuzzy matches are a fallback');

// 已收清：金额 0 的单不算。
const zero = [{ id:'z1', num:'Z1', client:'Zero', amount:0, paidAmount:0, stage:'quote', isDraft:true }, ...orders];
assert.deepEqual(ids({ paymentState:'paid' }, zero), ['o1', 'o3'], 'zero-amount draft is not "paid"');

// 排序：按美元换算比较；拿不到汇率的排最后。
const money = [
  { id:'m1', amount:7000, currency:'CNY', paidAmount:0, stage:'quote', createdAt:'2026-08-01', updated:'2026-08-01 10:00' },
  { id:'m2', amount:2000, currency:'USD', paidAmount:0, stage:'quote', createdAt:'2026-08-01', updated:'2026-08-01 10:00' },
  { id:'m3', amount:1000, currency:'GBP', paidAmount:500, stage:'production', createdAt:'2026-08-01', updated:'2026-08-01 10:00' },
  { id:'m4', amount:9999, currency:'XYZ', paidAmount:0, stage:'quote', createdAt:'2026-08-01', updated:'2026-08-01 10:00' }
];
assert.deepEqual(evaluate('sortOrdersForList(orders, "amountDesc").map(item => item.id)', money), ['m2', 'm3', 'm1', 'm4']);
assert.deepEqual(evaluate('sortOrdersForList(orders, "paymentDesc").map(item => item.id)', money), ['m2', 'm1', 'm3', 'm4']);
assert.deepEqual(evaluate('sortOrdersForList(orders, "updatedDesc").map(item => item.id)'), ['o4', 'o2', 'o1', 'o3']);
assert.deepEqual(evaluate('sortOrdersForList(orders, "amountDesc").map(item => item.id)'), ['o2', 'o3', 'o1', 'o4']);

context.manyOrders = Array.from({ length:75 }, (_, id) => ({ id }));
assert.deepEqual(
  JSON.parse(JSON.stringify(vm.runInContext('paginateOrdersForList(manyOrders, 2, 50)', context))),
  { items:Array.from({ length:25 }, (_, index) => ({ id:index + 50 })), currentPage:2, totalPages:2, start:50, total:75 }
);
assert.deepEqual(
  JSON.parse(JSON.stringify(vm.runInContext('paginateOrdersForList(manyOrders, 9, 50)', context))).currentPage,
  2
);

assert.match(html, /data-page="order-list"[^>]*>[\s\S]*?订单列表/);
assert.match(html, /id="page-order-list"/);
assert.match(html, /id="orderListSearch"/);
assert.match(html, /id="orderTableBody"/);
assert.match(html, /id="orderListPagination"/);
assert.match(html, /function renderOrderListPage\(/);

vm.runInContext(extractFunction('orderListActiveFilters'), context);
assert.deepEqual(JSON.parse(JSON.stringify(context.orderListActiveFilters([
  {id:'country', value:'all', label:'全部国家'},
  {id:'payment', value:'Paypal', label:'Paypal'},
  {id:'month', value:'2026-08', label:'2026年8月'}
]))), [{id:'payment',label:'Paypal'}, {id:'month',label:'2026年8月'}]);
assert.deepEqual(JSON.parse(JSON.stringify(context.orderListActiveFilters([]))), []);

// 搜索 1000 单的耗时：别名表和每段文本的分词有缓存，逐字输入时不再整体重算。
const big = Array.from({ length:1000 }, (_, index) => ({
  id:`b${index}`, num:`K26${String(index).padStart(7, '0')}`, client:`Client ${index}`, country:'🇬🇧 英国 United Kingdom',
  amount:100 + index, paidAmount:0, stage:'quote', orderType:'定金订单', note:`note ${index}`, updated:'2026-10-01 10:00'
}));
evaluate('filterOrdersForList(orders, { query:"Client 99" }, customers).length', big);
const started = process.hrtime.bigint();
for (const query of ['Cl', 'Cli', 'Clie', 'Client 9', 'Client 99']) evaluate(`filterOrdersForList(orders, { query:${JSON.stringify(query)} }, customers).length`, big);
const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
assert.ok(elapsed < 1500, `five searches over 1000 orders took ${elapsed.toFixed(0)}ms`);
console.log('Order list page tests passed.');
