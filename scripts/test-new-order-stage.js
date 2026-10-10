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
  state:{ orderSettings:{} },
  defaultOrderSettings:{ defaultPaymentChannel:'Paypal', defaultOwner:'Kris' },
  cleanTracking(value) { return String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase(); },
  carrierHintFromTrackingText() { return ''; },
  detectCarrier(value) { return value ? 'UPS' : 'auto'; },
  normalizeStage(value) { return ['quote', 'deposit', 'production', 'balance', 'shipment', 'done'].includes(value) ? value : 'quote'; },
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

assert.equal(build({ ...base, orderType:'定金订单' }).stage, 'deposit', '新建定金订单应进入定金工作区');
assert.equal(build({ ...base, orderType:'全款订单', paidAmount:1000 }).stage, 'production', '新订单付清后应进入生产中工作区');
assert.equal(build({ ...base, orderType:'全款订单' }).stage, 'quote', '未付款的全款新订单应保留报价阶段');
assert.equal(build({ ...base, orderType:'定金订单', trackingNumber:'1Z999AA10123456784' }).stage, 'shipment', '有物流单号的新订单应优先进入已发货');
assert.equal(build({ ...base, orderType:'定金订单', stage:'balance', trackingNumber:'1Z999AA10123456784' }).stage, 'shipment', '物流单号必须优先于手动阶段');
assert.equal(build({ ...base, orderType:'定金订单', stage:'balance' }).stage, 'balance', '手动选择的非报价阶段必须保留');
assert.equal(build({ ...base, orderType:'全款订单', paidAmount:1000, stage:'deposit' }).stage, 'deposit', '手动阶段必须优先于全额付款判断');
assert.equal(
  build({ ...base, orderType:'定金订单', stage:'quote' }, { id:'o-existing', logs:[], stage:'quote' }).stage,
  'quote',
  '编辑已有订单时不能根据订单类型自动改阶段'
);

console.log('New order stage tests passed: payment, order type, tracking, manual stage, and edit precedence verified.');
