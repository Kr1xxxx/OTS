#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  const bodyStart = html.indexOf('{', start);
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const source = html.slice(start, index + 1);
    try { new vm.Script(source); return source; } catch (_) {}
  }
  throw new Error(`Unclosed function: ${name}`);
}

const context = vm.createContext({ console });
[
  'normalizeCustomerContactMethod',
  'normalizeCustomerContactPreferences',
  'renderCustomerContactMethods'
].forEach(name => vm.runInContext(extractFunction(name), context));

const evaluate = expression => JSON.parse(JSON.stringify(vm.runInContext(expression, context)));

assert.equal(evaluate(`normalizeCustomerContactMethod('whatsapp')`), 'WhatsApp');
assert.equal(evaluate(`normalizeCustomerContactMethod('邮箱')`), '邮件');
assert.equal(evaluate(`normalizeCustomerContactMethod('ali')`), '阿里巴巴');
assert.equal(evaluate(`normalizeCustomerContactMethod('i message')`), 'iMessage');
assert.equal(evaluate(`normalizeCustomerContactMethod('sms')`), '');

assert.deepEqual(
  evaluate(`normalizeCustomerContactPreferences('邮件', ['WhatsApp', 'email', '阿里', 'WhatsApp'])`),
  { primaryContactMethod:'邮件', alternativeContactMethods:['WhatsApp', '阿里巴巴'] },
  '备选联系方式必须规范化、去重并排除主联系方式'
);
assert.deepEqual(
  evaluate(`normalizeCustomerContactPreferences('', [])`),
  { primaryContactMethod:'', alternativeContactMethods:[] },
  '旧客户未设置时不能自动推断或写入 WhatsApp'
);
assert.equal(evaluate(`renderCustomerContactMethods({primaryContactMethod:'WhatsApp',alternativeContactMethods:['邮件','iMessage']})`), 'WhatsApp · 备选：邮件、iMessage');
assert.equal(evaluate(`renderCustomerContactMethods({})`), '未设置');

assert.match(html, /name="primaryContactMethod"/);
assert.match(html, /name="alternativeContactMethods"/);
assert.match(html, /name="permanentNote"/);
assert.match(html, /客户永久备注/);
assert.match(html, /每笔订单显示/);
assert.match(html, /client-permanent-note-banner/);
assert.match(html, /customer\.permanentNote \|\| '未设置永久备注'/);
assert.match(html, /\['primaryContactMethod', '主要联系方式'\]/);
assert.match(html, /\['permanentNote', '客户永久备注'\]/);

const buildStart = html.indexOf('function buildCustomerSavePayload(');
const buildEnd = html.indexOf('function commitCustomerSavePayload(', buildStart);
const buildSource = html.slice(buildStart, buildEnd);
assert.match(buildSource, /primaryContactMethod/);
assert.match(buildSource, /alternativeContactMethods/);
assert.match(buildSource, /permanentNote/);

const orderBuildStart = html.indexOf('function buildOrderFromFormData(');
const orderBuildEnd = html.indexOf('async function saveCombinedCustomerOrder(', orderBuildStart);
const orderBuildSource = html.slice(orderBuildStart, orderBuildEnd);
assert.doesNotMatch(orderBuildSource, /permanentNote\s*:/, '客户永久备注不能复制进订单数据');

console.log('Customer contact preferences passed: normalization, legacy behavior, UI fields, permanent-note display, and order isolation verified.');
