#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function: ${name}`);
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

const context = vm.createContext({
  Date,
  state:{ orderSettings:{}, orders:[] },
  existingCustomerKey() { return ''; },
  defaultOrderSettings:{ defaultPaymentChannel:'Paypal', defaultOwner:'Kris' },
  cleanTracking(value) { return String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase(); },
  carrierHintFromTrackingText() { return ''; },
  detectCarrier(value) { return value ? 'UPS' : 'auto'; },
  normalizeStage(value) { return ['quote', 'production', 'balance', 'shipment', 'done'].includes(value) ? value : 'quote'; },
  normalizeOrderPaymentInput(data, amount, orderType, stage) {
    let paidAmount = Math.min(amount, Math.max(0, Number(data.paidAmount || 0)));
    if (stage === 'shipment' || stage === 'done') paidAmount = amount;
    return {
      paidAmount,
      depositAmount: Math.min(amount, Math.max(0, Number(data.depositAmount || 0))),
      depositPercent: Math.min(100, Math.max(0, Number(data.depositPercent || 0)))
    };
  },
  autoCapitalizeCustomerName(value) { return String(value || '').trim(); },
  preferredOrderPaymentChannel(_client, value) { return value || 'Paypal'; },
  nextOrderNum() { return 'SO26082799'; },
  normalizeDate() { return '2026-08-27'; },
  nowText() { return '2026-08-27 12:00'; },
  normalizeMonth() { return '2026-08'; },
  finalizedOrderAttachments(value) { return value || []; },
  normalizeFeishuNotification(value) { return value || {}; },
  isSettledStage(stage) { return stage === 'shipment' || stage === 'done'; },
  applyOrderStageInvariants() {},
  orderChangeSummary() { return []; }
});
vm.runInContext(extractFunction('inferNewOrderStage'), context);
vm.runInContext(extractFunction('normalizeOrderShipments'), context);
vm.runInContext(extractFunction('buildOrderFromFormData'), context);

function build(data, existing = null) {
  context.testData = data;
  context.testExisting = existing;
  return JSON.parse(JSON.stringify(vm.runInContext('buildOrderFromFormData(testData, { existing:testExisting, isDraft:false })', context)));
}

const base = {
  client:'Stage Test', amount:1000, currency:'USD', paymentChannel:'Paypal', productType:'假发',
  stage:'quote', trackingNumber:'', carrier:'auto', paidAmount:'', depositAmount:'', depositPercent:''
};

assert.equal(build({ ...base, orderType:'定金订单' }).stage, 'quote', '未付定金的新定金订单应保留报价阶段');
assert.equal(build({ ...base, orderType:'定金订单', paidAmount:300 }).stage, 'balance', '已付定金的新订单应进入尾款');
assert.equal(build({ ...base, orderType:'定金订单', paidAmount:1000 }).stage, 'production', '定金订单一次付清应进入生产中');
assert.equal(build({ ...base, orderType:'全款订单', paidAmount:1000 }).stage, 'production', '新订单付清后应进入生产中工作区');
assert.equal(build({ ...base, orderType:'全款订单' }).stage, 'quote', '未付款的全款新订单应保留报价阶段');
assert.equal(build({ ...base, orderType:'定金订单', trackingNumber:'1Z999AA10123456784' }).stage, 'shipment', '有物流单号的新订单应优先进入已发货');
assert.equal(build({ ...base, orderType:'定金订单', stage:'balance', trackingNumber:'1Z999AA10123456784' }).stage, 'shipment', '物流单号必须优先于手动阶段');
assert.equal(build({ ...base, orderType:'定金订单', stage:'balance' }).stage, 'balance', '手动选择的非报价阶段必须保留');
assert.equal(build({ ...base, orderType:'全款订单', paidAmount:1000, stage:'balance' }).stage, 'balance', '手动阶段必须优先于全额付款判断');
assert.equal(
  build({ ...base, orderType:'定金订单', stage:'quote' }, { id:'o-existing', logs:[], stage:'quote' }).stage,
  'quote',
  '编辑已有订单时不能根据订单类型自动改阶段'
);

console.log('New order stage tests passed: payment, order type, tracking, manual stage, and edit precedence verified.');

vm.runInContext(extractFunction('migrateDepositStage'), context);
const migrate = order => { context.testOrder = order; return vm.runInContext('migrateDepositStage(testOrder)', context); };
assert.equal(migrate({ stage:'deposit', paidAmount:300, amount:1000 }), 'balance', '已付定金的旧定金阶段订单应迁到尾款');
assert.equal(migrate({ stage:'deposit', paidAmount:1000, amount:1000 }), 'production', '已付清的旧定金阶段订单应迁到生产中');
assert.equal(migrate({ stage:'deposit', paidAmount:300, amount:1000, orderType:'全款订单' }), 'production', '全款订单没有尾款阶段，付过款进生产中');
assert.equal(migrate({ stage:'deposit', paidAmount:0 }), 'quote', '未付款的旧定金阶段订单应迁回报价');
assert.equal(migrate({ stage:'pi' }), 'quote', '旧 PI 阶段按未付款处理');
assert.equal(migrate({ stage:'balance', paidAmount:300 }), 'balance', '其他阶段保持不变');
console.log('Deposit stage migration verified.');
