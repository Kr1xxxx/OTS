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
  document: {
    createElement() {
      return { className:'', style:{ setProperty() {} }, innerHTML:'' };
    }
  },
  selectButtonLabel(_select, option) { return option.textContent; },
  escapeAttr(value) { return String(value); }
});
vm.runInContext(extractFunction('roundMoneyValue'), context);
vm.runInContext(extractFunction('depositPresetOptions'), context);
vm.runInContext(extractFunction('depositPresetSelection'), context);
vm.runInContext(extractFunction('enhanceBinarySelects'), context);

function evaluate(expression) {
  return JSON.parse(JSON.stringify(vm.runInContext(expression, context)));
}

assert.deepEqual(evaluate(`depositPresetOptions(1000, 'USD')`), [
  { percent:30, amount:300, label:'USD 300.00 (30%)' },
  { percent:50, amount:500, label:'USD 500.00 (50%)' },
  { percent:70, amount:700, label:'USD 700.00 (70%)' },
  { percent:100, amount:1000, label:'USD 1,000.00 (100%)' }
]);
assert.deepEqual(evaluate(`depositPresetOptions(1021, 'EUR')`), [
  { percent:30, amount:306.3, label:'EUR 306.30 (30%)' },
  { percent:50, amount:510.5, label:'EUR 510.50 (50%)' },
  { percent:70, amount:714.7, label:'EUR 714.70 (70%)' },
  { percent:100, amount:1021, label:'EUR 1,021.00 (100%)' }
]);
assert.deepEqual(evaluate(`depositPresetOptions('', 'USD')`), [
  { percent:30, amount:0, label:'30%' },
  { percent:50, amount:0, label:'50%' },
  { percent:70, amount:0, label:'70%' },
  { percent:100, amount:0, label:'100%' }
]);
assert.deepEqual(evaluate(`depositPresetSelection(1021, 50)`), { depositAmount:510.5, depositPercent:50 });
assert.deepEqual(evaluate(`depositPresetSelection(1000, 120)`), { depositAmount:1000, depositPercent:100 });
assert.deepEqual(evaluate(`depositPresetSelection('', 30)`), { depositAmount:0, depositPercent:30 });

let nativePickerPreserved = false;
const fakeSelect = {
  name:'depositPreset',
  id:'',
  value:'',
  options:[30, 50, 70, 100].map(percent => ({ value:String(percent), textContent:`${percent}%` })),
  classList:{
    contains() { return false; },
    remove(className) { if (className === 'binary-native') nativePickerPreserved = true; },
    add() {}
  },
  closest(selector) { return selector === '.deposit-combo'; },
  nextElementSibling:null,
  insertAdjacentElement(_position, element) { this.nextElementSibling = element; }
};
context.depositRoot = { querySelectorAll() { return [fakeSelect]; } };
vm.runInContext('enhanceBinarySelects(depositRoot)', context);
assert.equal(nativePickerPreserved, true, 'deposit preset must remain a native dropdown inside the amount control');

console.log('Deposit picker tests passed: editable amount and 30/50/70/100 percent presets verified.');
