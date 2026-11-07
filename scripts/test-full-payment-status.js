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
  normalizeStage(value) { return ['quote', 'production', 'balance', 'shipment', 'done'].includes(value) ? value : 'quote'; },
  cleanTracking(value) { return String(value || '').trim(); },
  renderStageSelect(sel, current, orderType) {
    sel.value = orderType === '全款订单' && current === 'balance' ? 'production' : current;
  },
  syncDepositPresetControl() {},
  syncPaymentHints() {}
});
for (const name of ['updateDepositFieldVisibility', 'syncDepositFields', 'fullPaymentStatusFor', 'inferNewOrderStage', 'applyOrderTypeSwitch']) {
  vm.runInContext(extractFunction(name), context);
}

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
  dataset: {},
  elements: {
    amount:{ value:'1000' },
    paidAmount:{ value:'' },
    fullPaymentStatus:{ value:'已付' },
    orderType:{ value:'全款订单' },
    depositAmount:{ value:'' },
    depositPercent:{ value:'' },
    stage:{ value:'quote' }
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
const run = code => vm.runInContext(code, context);

run(`syncDepositFields(testForm, 'payment-status')`);
assert.equal(form.elements.paidAmount.value, 1000, '全款订单选择已付时，已付金额必须等于订单总额');
assert.equal(fullPaymentStatus.classList.contains('is-hidden'), false, '全款订单必须显示已付/未付选项');
assert.equal(depositPaidAmount.classList.contains('is-hidden'), true, '全款订单选「已付」时不显示自由金额输入框');

form.elements.fullPaymentStatus.value = '未付';
form.elements.paidAmount.value = '1000';
run(`syncDepositFields(testForm, 'payment-status')`);
assert.equal(form.elements.paidAmount.value, '', '全款订单选择未付时，已付金额必须保存为零');

// 全款订单的「部分已付」：显示已收金额框，金额是用户填的，改订单金额、重新同步都不能动它。
form.elements.fullPaymentStatus.value = '部分';
run(`syncDepositFields(testForm, 'payment-status')`);
assert.equal(depositPaidAmount.classList.contains('is-hidden'), false, '部分已付时必须显示已收金额框');
form.elements.paidAmount.value = '500';
run(`syncDepositFields(testForm, 'paid')`);
form.elements.amount.value = '1';
run(`syncDepositFields(testForm, 'amount')`);
form.elements.amount.value = '12';
run(`syncDepositFields(testForm, 'amount')`);
assert.equal(form.elements.paidAmount.value, '500', '部分已付的已收金额不能被逐键输入的订单金额截断');
form.elements.amount.value = '1000';
run(`syncDepositFields(testForm, 'amount')`);
assert.equal(run(`fullPaymentStatusFor(1000, 500)`), '部分');
assert.equal(run(`fullPaymentStatusFor(1000, 1000)`), '已付');
assert.equal(run(`fullPaymentStatusFor(1000, 0)`), '未付');
assert.equal(run(`fullPaymentStatusFor(0, 0)`), '未付');

// 新单默认「全款 + 已付」再切到定金：自动算出的全额已付、100% 定金都不能带过来。
form.elements.fullPaymentStatus.value = '已付';
run(`syncDepositFields(testForm, 'payment-status')`);
form.elements.orderType.value = '定金订单';
run(`applyOrderTypeSwitch(testForm, '全款订单', '定金订单', { keepPaid:false })`);
assert.equal(form.elements.paidAmount.value, '', '从全款订单切换为定金订单时不得残留全额付款');
assert.equal(form.elements.depositAmount.value, '', '从全款订单切换为定金订单时不得残留百分百定金');

// 定金订单：已付款金额逐键输入时原样保留（不夹紧、不吞小数点），超过订单金额也只提示不改写。
form.elements.paidAmount.value = '300';
form.elements.depositAmount.value = '300';
run(`syncDepositFields(testForm, 'paid')`);
assert.equal(form.elements.paidAmount.value, '300', '定金订单必须继续支持实际已付金额');
assert.equal(fullPaymentStatus.classList.contains('is-hidden'), true, '定金订单不得显示全款状态选项');
assert.equal(depositPaidAmount.classList.contains('is-hidden'), false, '定金订单必须显示实际已付金额输入框');
for (const typed of ['1', '12', '120', '1200']) {
  form.elements.amount.value = typed;
  run(`syncDepositFields(testForm, 'amount')`);
}
assert.equal(form.elements.paidAmount.value, '300', '逐键改订单金额时已付款不能被截成 1');
for (const typed of ['3', '37', '370', '370.', '370.3', '370.37']) {
  form.elements.paidAmount.value = typed;
  run(`syncDepositFields(testForm, 'paid')`);
  assert.equal(form.elements.paidAmount.value, typed, `已付款逐键输入 ${typed} 不能被改写`);
}
form.elements.paidAmount.value = '5000';
run(`syncDepositFields(testForm, 'paid')`);
assert.equal(form.elements.paidAmount.value, '5000', '超过订单金额时只提示，保存时再确认，不在输入时截断');

// 误点「全款订单」再点回「定金订单」：已付、定金、比例、阶段原样恢复。（换了一张单，openOrder 会清掉上一张的暂存。）
form._paymentStash = null;
form.elements.amount.value = '1000';
form.elements.paidAmount.value = '300';
form.elements.depositAmount.value = '300';
form.elements.depositPercent.value = '30';
form.elements.stage.value = 'balance';
form.elements.fullPaymentStatus.value = '未付';
form.elements.orderType.value = '全款订单';
run(`applyOrderTypeSwitch(testForm, '定金订单', '全款订单', { keepPaid:true })`);
assert.equal(form.elements.fullPaymentStatus.value, '部分', '带着已收 300 切到全款显示「部分已付」');
assert.equal(form.elements.paidAmount.value, '300', '切到全款时已收金额保留');
assert.equal(form.elements.stage.value, 'quote', '全款没有尾款阶段：没收齐回报价，不能变成生产中');
form.elements.orderType.value = '定金订单';
run(`applyOrderTypeSwitch(testForm, '全款订单', '定金订单', { keepPaid:true })`);
assert.equal(form.elements.paidAmount.value, '300', '切回定金恢复已付');
assert.equal(form.elements.depositAmount.value, '300', '切回定金恢复定金');
assert.equal(form.elements.depositPercent.value, '30', '切回定金恢复比例');
assert.equal(form.elements.stage.value, 'balance', '切回定金恢复尾款阶段');

// 已保存的全款单（收齐 1000、生产中）改成定金：已收的钱保留，定金重新填。
form._paymentStash = null;
form.elements.orderType.value = '全款订单';
form.elements.fullPaymentStatus.value = '已付';
form.elements.stage.value = 'production';
run(`syncDepositFields(testForm, 'amount')`);
form.elements.orderType.value = '定金订单';
run(`applyOrderTypeSwitch(testForm, '全款订单', '定金订单', { keepPaid:true })`);
assert.equal(String(form.elements.paidAmount.value), '1000', '已保存订单的已收金额切到定金后保留');
assert.equal(form.elements.depositAmount.value, '', '全款的 100% 定金不带到定金订单');
assert.equal(form.elements.stage.value, 'production');

console.log('Full payment status tests passed: paid / partial / unpaid mapping, key-by-key paid and amount input untouched, type toggle restores paid, deposit and stage.');
