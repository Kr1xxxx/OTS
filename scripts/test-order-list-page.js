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

const context = vm.createContext({
  console,
  globalSearchText(value, depth = 0) {
    if (value === null || value === undefined || depth > 3) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(item => context.globalSearchText(item, depth + 1)).join(' ');
    if (typeof value === 'object') return Object.values(value).map(item => context.globalSearchText(item, depth + 1)).join(' ');
    return '';
  },
  normalizeSearchText: value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
  normalizeCountry: value => String(value || '').trim(),
  normalizeMonth: value => String(value || '').slice(0, 7),
  normalizeStage: value => String(value || '').trim(),
  cleanTracking: value => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase(),
  isSettledStage: value => value === 'done',
  orderDueValue: order => Math.max(0, Number(order.amount || 0) - Number(order.paidAmount || 0)),
  parseDate: value => new Date(String(value || '').replace(' ', 'T')).getTime() || 0
});

[
  'normalizeSearchText',
  'searchCountryAliasGroups',
  'searchTextDocument',
  'boundedDamerauLevenshtein',
  'searchWordFuzzyMatch',
  'searchTextMatchDetail',
  'searchTextMatches',
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
    productType:'睫毛', paymentChannel:'阿里巴巴', stage:'deposit', createdAt:'2026-08-02', orderMonth:'2026-08', updated:'2026-08-04 10:00'
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

function evaluate(expression) {
  context.orders = orders;
  context.customers = customers;
  return JSON.parse(JSON.stringify(vm.runInContext(expression, context)));
}

assert.deepEqual(evaluate('filterOrdersForList(orders, { quick:"all" }, customers).map(item => item.id)'), ['o1', 'o2', 'o3', 'o4']);
assert.deepEqual(evaluate('filterOrdersForList(orders, { quick:"active" }, customers).map(item => item.id)'), ['o2', 'o3']);
assert.deepEqual(evaluate('filterOrdersForList(orders, { quick:"unpaid" }, customers).map(item => item.id)'), ['o2', 'o4']);
assert.deepEqual(evaluate('filterOrdersForList(orders, { query:"london@example.com" }, customers).map(item => item.id)'), ['o2']);
assert.deepEqual(evaluate('filterOrdersForList(orders, { query:"7700 900127" }, customers).map(item => item.id)'), ['o2']);
assert.deepEqual(evaluate('filterOrdersForList(orders, { query:"7700900" }, customers).map(item => item.id)'), ['o2']);
assert.deepEqual(evaluate('filterOrdersForList(orders, { query:"Untied Kingdom" }, customers).map(item => item.id)'), ['o2']);
assert.deepEqual(evaluate('filterOrdersForList(orders, { stage:"shipment", logistics:"delivered" }, customers).map(item => item.id)'), ['o3']);
assert.deepEqual(evaluate('filterOrdersForList(orders, { country:"🇪🇸 西班牙 Spain", month:"2026-07" }, customers).map(item => item.id)'), ['o3']);
assert.deepEqual(evaluate('filterOrdersForList(orders, { draft:"formal" }, customers).map(item => item.id)'), ['o1', 'o2', 'o3']);
assert.deepEqual(evaluate('sortOrdersForList(orders, "updatedDesc").map(item => item.id)'), ['o4', 'o2', 'o1', 'o3']);
assert.deepEqual(evaluate('sortOrdersForList(orders, "amountDesc").map(item => item.id)'), ['o2', 'o3', 'o1', 'o4']);
assert.deepEqual(evaluate('sortOrdersForList(orders, "paymentDesc").map(item => item.id)'), ['o2', 'o4', 'o1', 'o3']);

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
console.log('Order list page tests passed.');
