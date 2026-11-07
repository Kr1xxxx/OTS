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
vm.runInContext(extractFunction('normalizeOrderNum'), context);
vm.runInContext(extractFunction('nextOrderNum'), context);
const next = () => vm.runInContext('nextOrderNum()', context);

assert.equal(next(), 'K26082704', '默认订单号应使用 K 前缀并延续当天 K 流水号');

context.state.trashOrders = [{ num:'K26082705' }];
context.state.deletedOrders = [{ num:'K26082707' }];
assert.equal(next(), 'K26082708', '回收站和已删除订单仍占用订单号，新订单号必须跳过');
context.state.orders = [];
context.state.trashOrders = [{ num:'K26082701' }];
context.state.deletedOrders = [];
assert.equal(next(), 'K26082702', '当天唯一订单删到回收站后，新建订单不能复用该号');

// 规范化：大小写、全角、空格、零宽字符不同的写法是同一个号；手工号里的 - 保留。
const normalize = value => vm.runInContext(`normalizeOrderNum(${JSON.stringify(value)})`, context);
assert.equal(normalize('k26082701'), 'K26082701');
assert.equal(normalize('Ｋ26082701'), 'K26082701', '全角 K');
assert.equal(normalize('K26082701​'), 'K26082701', '零宽空格（从聊天里复制常带）');
assert.equal(normalize(' K260827 01 '), 'K26082701', '中间空格');
assert.equal(normalize('k-manual-1'), 'K-MANUAL-1', '手工号的 - 保留');
assert.equal(normalize(null), '');

// 小写的旧号也算当天流水：存在 k26082701 时不能再生成 K26082701。
context.state = { orderSettings:{}, orders:[{ num:'k26082701' }], trashOrders:[], deletedOrders:[] };
assert.equal(next(), 'K26082702', '小写旧号也要跳过');

// 手工录入的超长号不参与流水计算：以前 Number 丢精度，连续两次生成同一个号。
context.state.orders = [{ num:'K26082701' }, { num:'K26082799999999999999999' }];
const first = next();
assert.equal(first, 'K26082702', '超长手工号不能把流水推到丢精度的大数');
context.state.orders.push({ num:first });
assert.notEqual(next(), first, '连续两次生成不能是同一个号');

// 位数设置坏掉（导入的旧数据）时不能每次都生成同一个号。
context.state = { orderSettings:{ serialDigits:'abc' }, orders:[{ num:'K26082701' }], trashOrders:[], deletedOrders:[] };
assert.equal(next(), 'K26082702', '位数不是 2/3/4 时按 2 位');

// 当天把位数从 2 改成 3：接着已有的号往后排，不倒回 001。
context.state = { orderSettings:{ serialDigits:3 }, orders:[{ num:'K26082701' }, { num:'K26082702' }], trashOrders:[], deletedOrders:[] };
assert.equal(next(), 'K260827003', '位数改大后流水接着排');

// 中间带空格的旧号也按规范化后的流水算。
context.state = { orderSettings:{}, orders:[{ num:'K26082701' }, { num:'K260827 02' }], trashOrders:[], deletedOrders:[] };
assert.equal(next(), 'K26082703', '带空格的旧号也占流水');

console.log('Order number test passed: K prefix, current date, daily sequence, normalized variants and generator edge cases verified.');
