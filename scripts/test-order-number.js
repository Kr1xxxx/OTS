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

class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : ['2026-08-27T08:00:00+08:00']));
  }
}

const context = vm.createContext({
  Date:FixedDate,
  defaultOrderSettings:{},
  state:{
    orderSettings:{},
    orders:[
      { num:'K26082701' },
      { num:'K26082703' },
      { num:'SO26082799' },
      { num:'K26082608' }
    ]
  }
});
vm.runInContext(extractFunction('nextOrderNum'), context);

assert.equal(vm.runInContext('nextOrderNum()', context), 'K26082704', '默认订单号应使用 K 前缀并延续当天 K 流水号');

console.log('Order number test passed: K prefix, current date, and daily sequence verified.');
