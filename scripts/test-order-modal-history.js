#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
const historyListIndex = html.indexOf('id="historyList"');
const historySectionOpenings = [...html.slice(0, historyListIndex).matchAll(/<section\b[^>]*>/g)];
assert.match(
  historySectionOpenings.at(-1)?.[0] || '',
  /id="orderHistorySection"/,
  '隐藏开关必须属于包含历史列表的操作记录区域'
);

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

const markupIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const elements = {};
const formFields = [
  'id', 'num', 'client', 'country', 'createdAt', 'amount', 'paidAmount', 'currency', 'orderMonth',
  'productType', 'paymentChannel', 'orderType', 'depositAmount', 'depositPercent', 'stage', 'next',
  'owner', 'trackingNumber', 'carrier', 'urgentOrder', 'customerRequiredDate', 'latestShipDate', 'note',
  'sendFeishuNotification'
].reduce((fields, name) => ({ ...fields, [name]:{ value:'', checked:false } }), {});
const form = { elements:formFields, dataset:{} };

function fakeElement(id) {
  if (!markupIds.has(id)) return null;
  if (id === 'orderForm') return form;
  if (!elements[id]) {
    elements[id] = {
      id,
      hidden:false,
      innerHTML:'',
      textContent:'',
      style:{ display:'' },
      attributes:{ 'aria-hidden':'true' },
      classList:{ add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; }
    };
  }
  return elements[id];
}

const context = vm.createContext({
  editingId:null,
  document:{ getElementById:fakeElement },
  state:{ orders:[], orderSettings:{} },
  defaultOrderSettings:{
    defaultCountry:'', defaultCurrency:'USD', defaultProductType:'假发', defaultPaymentChannel:'Paypal',
    defaultOrderType:'定金订单', defaultDepositPercent:30, defaultStage:'quote', defaultOwner:'Kris',
    defaultUrgentOrder:'否'
  },
  clearPasteAssist() {},
  clearOrderImageUploads() {},
  fillStageSelects() {},
  nextOrderNum() { return 'SO99082701'; },
  normalizeDate() { return '2026-08-27'; },
  normalizeMonth() { return '2026-08'; },
  normalizeStage(value) { return value || 'quote'; },
  cleanTracking(value) { return String(value || '').replace(/\s/g, ''); },
  depositPercent() { return 0; },
  renderOrderAttachments() {},
  renderStageSelect(sel, current) { sel.value = current; },
  syncStageOptionsForForm() {},
  syncDepositFields() {},
  enhanceBinarySelects() {},
  customerDataForName() { return {}; },
  renderOrderClientAutofillSummary() {},
  setOrderShipmentFields() {},
  syncCarrierFromTracking() {},
  stageDef() { return { name:'报价', tag:'tag-blue' }; },
  money(amount, currency) { return `${currency || 'USD'} ${amount || 0}`; },
  updateOrderModalSummary() {},
  normalizeLog(item, fallback) { return typeof item === 'string' ? { text:item, time:fallback } : item; },
  nowText() { return '2026-08-27 10:00'; },
  escapeAttr(value) { return String(value || ''); },
  resetModalScroll() {}
});
vm.runInContext(extractFunction('setModalOpenState'), context);
vm.runInContext(extractFunction('openOrder'), context);

vm.runInContext(`openOrder('')`, context);
assert.equal(elements.orderHistorySection?.style.display, 'none', '新建订单时应隐藏整个操作记录区域');

context.state.orders = [{
  id:'o-existing', num:'SO99082601', client:'Taylor Morgan', country:'United States', createdAt:'2026-08-26',
  amount:1000, paidAmount:300, currency:'USD', productType:'假发', paymentChannel:'Paypal',
  orderType:'定金订单', depositAmount:300, depositPercent:30, stage:'deposit', owner:'Kris',
  urgentOrder:false, logs:[{ time:'2026-08-26 11:00', text:'新建订单' }]
}];
vm.runInContext(`openOrder('o-existing')`, context);
assert.equal(elements.orderHistorySection.style.display, '', '编辑已有订单时应继续显示操作记录');
assert.match(elements.historyList.innerHTML, /新建订单/, '已有订单的历史内容应正常展示');

console.log('Order modal history tests passed: hidden for new orders and visible for saved orders.');
