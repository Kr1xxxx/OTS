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
  roundMoneyValue(value) { return Math.round((Number(value) || 0) * 100) / 100; },
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
  normalizePaymentChannelValue(value) { return String(value || '').trim(); },
  nextOrderNum() { return 'SO26082799'; },
  normalizeDate() { return '2026-08-27'; },
  nowText() { return '2026-08-27 12:00'; },
  normalizeMonth() { return '2026-08'; },
  finalizedOrderAttachments(value) { return value || []; },
  normalizeFeishuNotification(value) { return value || {}; },
  isSettledStage(stage) { return stage === 'shipment' || stage === 'done'; },
  applyOrderStageInvariants() {},
  orderChangeSummary() { return []; },
  money(value, currency = 'USD') { return `${currency} ${value}`; },
  stageDef(key) { return { name:key }; }
});
vm.runInContext(extractFunction('finiteMoneyOrNull'), context);
vm.runInContext(extractFunction('restoreAutoPaymentsOnStageExit'), context);
vm.runInContext(extractFunction('normalizeOrderNum'), context);
vm.runInContext(extractFunction('inferNewOrderStage'), context);
vm.runInContext(extractFunction('resolveOrderSaveStage'), context);
vm.runInContext(extractFunction('normalizeOrderShipments'), context);
vm.runInContext(extractFunction('aggregateShipmentStatus'), context);
vm.runInContext(extractFunction('latestShipmentUpdate'), context);
vm.runInContext(extractFunction('orderShipmentSignature'), context);
vm.runInContext(extractFunction('buildOrderFromFormData'), context);

function build(data, existing = null, stageTouched = null) {
  context.testData = data;
  context.testExisting = existing;
  context.testTouched = stageTouched;
  return JSON.parse(JSON.stringify(vm.runInContext('buildOrderFromFormData(testData, { existing:testExisting, isDraft:false, stageTouched:testTouched })', context)));
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
  build({ ...base, orderType:'定金订单', stage:'quote' }, { id:'o-existing', logs:[], stage:'quote', orderType:'定金订单', amount:1000, paidAmount:0 }).stage,
  'quote',
  '编辑已有订单只改别的字段（收款没动）时阶段不动'
);
// 编辑弹窗登记收款时和详情抽屉一样按收款推进：没收定金 = 报价，收到定金 = 尾款，付清 = 生产中。
const existingQuote = { id:'o-existing', logs:[], stage:'quote', orderType:'定金订单', amount:1000, paidAmount:0 };
assert.equal(build({ ...base, orderType:'定金订单', paidAmount:300 }, existingQuote).stage, 'balance', '编辑弹窗填了已收定金应进入尾款');
assert.equal(build({ ...base, orderType:'定金订单', paidAmount:1000 }, existingQuote).stage, 'production', '编辑弹窗一次收齐应进入生产中');
const existingFullQuote = { ...existingQuote, orderType:'全款订单' };
assert.equal(build({ ...base, orderType:'全款订单', paidAmount:1000 }, existingFullQuote).stage, 'production', '全款单在编辑弹窗改成已付应进入生产中');
const existingBalance = { ...existingQuote, stage:'balance', paidAmount:300 };
assert.equal(build({ ...base, orderType:'定金订单', stage:'balance', paidAmount:300, note:'只改备注' }, existingBalance).stage, 'balance', '只改备注时尾款单不动');
assert.equal(build({ ...base, orderType:'定金订单', stage:'balance', paidAmount:1000 }, existingBalance).stage, 'production', '尾款收齐应进入生产中');
assert.equal(build({ ...base, orderType:'定金订单', stage:'quote', paidAmount:300 }, existingQuote, true).stage, 'quote', '用户手动选过阶段时照用户选的');
assert.equal(build({ ...base, orderType:'定金订单', stage:'production', paidAmount:300 }, existingQuote).stage, 'production', '阶段改成了别的（不知道是否手动）时照选的');
const existingProduction = { ...existingQuote, stage:'production', orderType:'全款订单', paidAmount:1000 };
assert.equal(build({ ...base, orderType:'全款订单', stage:'production', paidAmount:0 }, existingProduction).stage, 'production', '生产中及以后的订单改收款不会被自动退回');
assert.equal(build({ ...base, orderType:'定金订单', paidAmount:300 }, { ...existingQuote, isDraft:true }).stage, 'balance', '草稿转正式单按收款推断');
assert.equal(build({ ...base, amount:-100, orderType:'定金订单' }).amount, 0, '负数金额（草稿不经过浏览器校验）收成 0');
assert.equal(build({ ...base, amount:'1000.005', orderType:'定金订单' }).amount, 1000.01, '金额只留两位小数');

console.log('New order stage tests passed: payment, order type, tracking, manual stage, edit-modal payment advance (same as drawer), and amount sanitizing verified.');

vm.runInContext(extractFunction('migrateDepositStage'), context);
const migrate = order => { context.testOrder = order; return vm.runInContext('migrateDepositStage(testOrder)', context); };
assert.equal(migrate({ stage:'deposit', paidAmount:300, amount:1000 }), 'balance', '已付定金的旧定金阶段订单应迁到尾款');
assert.equal(migrate({ stage:'deposit', paidAmount:1000, amount:1000 }), 'production', '已付清的旧定金阶段订单应迁到生产中');
assert.equal(migrate({ stage:'deposit', paidAmount:300, amount:1000, orderType:'全款订单' }), 'production', '全款订单没有尾款阶段，付过款进生产中');
assert.equal(migrate({ stage:'deposit', paidAmount:0 }), 'quote', '未付款的旧定金阶段订单应迁回报价');
assert.equal(migrate({ stage:'pi' }), 'quote', '旧 PI 阶段按未付款处理');
assert.equal(migrate({ stage:'balance', paidAmount:300 }), 'balance', '其他阶段保持不变');
console.log('Deposit stage migration verified.');
