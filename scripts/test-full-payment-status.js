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
  roundMoneyValue(value) { return Math.round(Number(value || 0) * 100) / 100; },
  depositPercent(amount, deposit) { return amount ? Math.round(Number(deposit || 0) / amount * 10000) / 100 : 0; },
  syncDepositPresetControl() {}
});
vm.runInContext(extractFunction('updateDepositFieldVisibility'), context);
vm.runInContext(extractFunction('syncDepositFields'), context);

function visibilityField() {
  const classes = new Set();
  return {
    classList: {
      toggle(name, active) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); }
    }
  };
}

const depositOnly = visibilityField();
const depositPaidAmount = visibilityField();
const fullPaymentStatus = visibilityField();
const paymentRow = visibilityField();
const form = {
  elements: {
    amount:{ value:'1000' },
    paidAmount:{ value:'' },
    fullPaymentStatus:{ value:'已付' },
    orderType:{ value:'全款订单' },
    depositAmount:{ value:'' },
    depositPercent:{ value:'' }
  },
  querySelectorAll(selector) {
    return {
      '.deposit-only-field':[depositOnly],
      '.deposit-payment-amount-field':[depositPaidAmount],
      '.full-payment-status-field':[fullPaymentStatus],
      '.payment-compact-row':[paymentRow]
    }[selector] || [];
  }
};
context.testForm = form;

vm.runInContext(`syncDepositFields(testForm, 'payment-status')`, context);
assert.equal(form.elements.paidAmount.value, 1000, '全款订单选择已付时，已付金额必须等于订单总额');
assert.equal(fullPaymentStatus.classList.contains('is-hidden'), false, '全款订单必须显示已付/未付选项');
assert.equal(depositPaidAmount.classList.contains('is-hidden'), true, '全款订单不得显示自由金额输入框');

form.elements.fullPaymentStatus.value = '未付';
form.elements.paidAmount.value = '1000';
vm.runInContext(`syncDepositFields(testForm, 'payment-status')`, context);
assert.equal(form.elements.paidAmount.value, '', '全款订单选择未付时，已付金额必须保存为零');

form.elements.fullPaymentStatus.value = '已付';
vm.runInContext(`syncDepositFields(testForm, 'payment-status')`, context);
form.elements.orderType.value = '定金订单';
vm.runInContext(`syncDepositFields(testForm, 'order-type')`, context);
assert.equal(form.elements.paidAmount.value, '', '从全款订单切换为定金订单时不得残留全额付款');
assert.equal(form.elements.depositAmount.value, '', '从全款订单切换为定金订单时不得残留百分百定金');

form.elements.orderType.value = '定金订单';
form.elements.paidAmount.value = '300';
form.elements.depositAmount.value = '300';
vm.runInContext(`syncDepositFields(testForm, 'paid')`, context);
assert.equal(form.elements.paidAmount.value, 300, '定金订单必须继续支持实际已付金额');
assert.equal(fullPaymentStatus.classList.contains('is-hidden'), true, '定金订单不得显示全款状态选项');
assert.equal(depositPaidAmount.classList.contains('is-hidden'), false, '定金订单必须显示实际已付金额输入框');

console.log('Full payment status tests passed: paid/unpaid mapping, default field visibility, and deposit amount preservation verified.');
