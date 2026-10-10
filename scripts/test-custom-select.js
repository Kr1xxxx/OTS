#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing production function: ${name}`);
  const bodyStart = html.indexOf('{', start);
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const source = html.slice(start, index + 1);
    try {
      new vm.Script(source);
      return source;
    } catch (_) {}
  }
  throw new Error(`Unclosed function: ${name}`);
}

const context = vm.createContext({
  Event: class Event {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  },
  selectButtonLabel(_select, option) {
    return option.textContent || option.value;
  }
});

['shouldUseAppSelect', 'appSelectOptionModel', 'nextAppSelectIndex', 'commitAppSelectValue', 'normalizeAppSelectKey', 'openAppSelectFromButton']
  .forEach(name => vm.runInContext(extractFunction(name), context));

function classList(...classes) {
  const values = new Set(classes);
  return { contains(name) { return values.has(name); } };
}

function fakeSelect({ classes = [], value = 'all', options = [], disabled = false } = {}) {
  const events = [];
  return {
    value,
    disabled,
    options,
    classList:classList(...classes),
    dispatchEvent(event) { events.push({ type:event.type, bubbles:event.bubbles }); },
    get events() { return events; }
  };
}

[
  fakeSelect({ classes:['inline-select'] }),
  fakeSelect(),
  fakeSelect({ classes:['shipment-select'] }),
  fakeSelect({ classes:['deposit-select'] })
].forEach(select => {
  context.testSelect = select;
  assert.equal(vm.runInContext('shouldUseAppSelect(testSelect)', context), true, '每个可见原生下拉框都应升级为应用下拉组件');
});

[
  fakeSelect({ classes:['binary-native'] }),
  fakeSelect({ classes:['segment-source'] })
].forEach(select => {
  context.testSelect = select;
  assert.equal(vm.runInContext('shouldUseAppSelect(testSelect)', context), false, '已替换为分段按钮的隐藏 select 不应重复生成下拉组件');
});

const select = fakeSelect({
  value:'paid',
  options:[
    { value:'all', textContent:'全部状态', disabled:false },
    { value:'pending', textContent:'暂不可选', disabled:true },
    { value:'paid', textContent:'已收清', disabled:false }
  ]
});
context.testSelect = select;
assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('appSelectOptionModel(testSelect)', context))), [
  { value:'all', label:'全部状态', disabled:false, selected:false },
  { value:'pending', label:'暂不可选', disabled:true, selected:false },
  { value:'paid', label:'已收清', disabled:false, selected:true }
]);

context.options = vm.runInContext('appSelectOptionModel(testSelect)', context);
assert.equal(vm.runInContext('nextAppSelectIndex(options, 0, 1)', context), 2, '向下移动应跳过禁用项');
assert.equal(vm.runInContext('nextAppSelectIndex(options, 2, 1)', context), 0, '末项继续向下应回到首项');
assert.equal(vm.runInContext('nextAppSelectIndex(options, 0, -1)', context), 2, '首项向上应回到末项');

assert.equal(vm.runInContext("commitAppSelectValue(testSelect, 'all')", context), true);
assert.equal(select.value, 'all');
assert.deepEqual(select.events, [
  { type:'input', bubbles:true },
  { type:'change', bubbles:true }
]);
assert.equal(vm.runInContext("commitAppSelectValue(testSelect, 'all')", context), false, '重复选择当前值不应触发额外业务事件');
assert.equal(select.events.length, 2);

const disabledSelect = fakeSelect({ disabled:true, value:'all' });
context.disabledSelect = disabledSelect;
assert.equal(vm.runInContext("commitAppSelectValue(disabledSelect, 'paid')", context), false);
assert.equal(disabledSelect.value, 'all');
assert.equal(disabledSelect.events.length, 0);

context.keys = ['Down', 'Up', 'Return', 'Esc', 'Space', 'ArrowDown', 'Enter'];
assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('keys.map(normalizeAppSelectKey)', context))), [
  'ArrowDown', 'ArrowUp', 'Enter', 'Escape', ' ', 'ArrowDown', 'Enter'
]);

let focusedWith = null;
let openedSelect = null;
const focusableSelect = fakeSelect({ value:'all', options:[{ value:'all', textContent:'全部' }] });
context.activeAppSelect = null;
context.openAppSelectMenu = selected => { openedSelect = selected; };
context.closeAppSelectMenu = () => {};
context.focusableButton = {
  disabled:false,
  focus(options) { focusedWith = options; },
  closest() { return { querySelector() { return focusableSelect; } }; }
};
assert.equal(vm.runInContext('openAppSelectFromButton(focusableButton)', context), true);
assert.equal(focusedWith?.preventScroll, true, '鼠标打开后应主动保留键盘焦点');
assert.equal(openedSelect, focusableSelect);

console.log('Custom select tests passed: enhancement routing, option model, keyboard navigation and value events verified.');
