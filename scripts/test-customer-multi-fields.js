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

const context = vm.createContext({ clientDisplayName: value => String(value || '').trim() });
[
  'decodePasteEntities',
  'decodeCustomerNameEntities',
  'normalizeCustomerEmail',
  'normalizeCustomerPhoneDigits',
  'normalizeCustomerPhone',
  'normalizeCustomerValueList',
  'normalizeCustomerContactFields',
  'normalizeCustomerContactMethod',
  'normalizeCustomerContactPreferences',
  'customerAddressCopyText',
  'customerDetailCopyText',
  'globalSearchText'
].forEach(name => vm.runInContext(extractFunction(name), context));

const normalize = profile => JSON.parse(JSON.stringify(vm.runInContext(
  `normalizeCustomerContactFields(${JSON.stringify(profile)})`,
  context
)));
assert.equal(context.customerDetailCopyText({alibabaId:'  0012AbC  '},'alibabaId'),'0012AbC');
Object.assign(context, {autoCapitalizeCustomerName:v=>v, normalizePaymentChannelValue:v=>v, productTypeDefs:[{value:'睫毛'}],defaultOrderSettings:{defaultProductType:'睫毛'},normalizeTags:()=>[],normalizeCountry:v=>v,cleanContactValue:v=>v,nowText:()=> '2026-09-10',customerChangeSummary:()=> '更新'});
vm.runInContext(extractFunction('buildCustomerSavePayload'),context);
assert.equal(context.buildCustomerSavePayload({name:'Buyer',alibabaId:'  0012AbC  '}).nextProfile.alibabaId,'0012AbC');
assert.equal(context.buildCustomerSavePayload({name:'Buyer'},{alibabaId:'old-id'}).nextProfile.alibabaId,'old-id');
assert.equal(context.buildCustomerSavePayload({name:'Buyer',alibabaId:''},{alibabaId:'old-id'}).nextProfile.alibabaId,'');
Object.assign(context,{paymentChannelDefs:[],orderTypeDefs:[]});
vm.runInContext(extractFunction('normalizeOrderSettings'),context);
assert.equal(context.normalizeOrderSettings({defaultProductType:'假发'}).defaultProductType,'睫毛');
assert.equal(context.normalizeOrderSettings({defaultProductType:'假发',productDefaultRevision:1}).defaultProductType,'假发');

const migrated = normalize({
  client: 'Legacy Buyer',
  contact: 'Jill Sample',
  phone: '+1 702 555 0100',
  email: 'mailto:Buyer@example.com',
  address: '123 Sample Lane #7, Las Vegas, NV 89183'
});
assert.deepEqual(migrated.contacts, ['Jill Sample']);
assert.deepEqual(migrated.phones, ['+1 702 555 0100']);
assert.deepEqual(migrated.emails, ['Buyer@example.com']);
assert.deepEqual(migrated.addresses, ['123 Sample Lane #7, Las Vegas, NV 89183']);
assert.equal(migrated.email, 'Buyer@example.com');

const multiple = normalize({
  contacts: ['Jill Sample', 'Sales Team', 'Jill Sample'],
  phones: ['+1 702 555 0100', '+1 702 555 0101'],
  emails: ['mailto:Buyer@example.com', 'orders@example.com', 'buyer@example.com'],
  addresses: ['Address One', 'Address Two'],
  contact: 'Ignored Legacy',
  phone: '+1 702 555 0199',
  email: 'legacy@example.com',
  address: 'Legacy Address'
});
assert.deepEqual(multiple.contacts, ['Jill Sample', 'Sales Team']);
assert.deepEqual(multiple.phones, ['+1 702 555 0100', '+1 702 555 0101']);
assert.deepEqual(multiple.emails, ['Buyer@example.com', 'orders@example.com']);
assert.deepEqual(multiple.addresses, ['Address One', 'Address Two']);
assert.equal(multiple.contact, 'Jill Sample');
assert.equal(multiple.phone, '+1 702 555 0100');
assert.equal(multiple.email, 'Buyer@example.com');
assert.equal(multiple.address, 'Address One');

const copyText = vm.runInContext(`customerAddressCopyText(${JSON.stringify({ client:'Legacy Buyer', ...multiple })})`, context);
assert.equal(copyText, 'Legacy Buyer\nAddress One\n电话：+1 702 555 0100\n邮箱：Buyer@example.com');

const searchable = vm.runInContext(`globalSearchText(${JSON.stringify(multiple)})`, context);
assert.match(searchable, /orders@example\.com/);
assert.match(searchable, /Address Two/);

assert.equal(
  vm.runInContext(`customerDetailCopyText(${JSON.stringify({ ...multiple, paymentEmail:'pay@example.com' })}, 'paymentEmail')`, context),
  'pay@example.com',
  '点击付款邮箱标题必须复制付款邮箱内容'
);
assert.equal(
  vm.runInContext(`customerDetailCopyText(${JSON.stringify(multiple)}, 'addresses')`, context),
  'Address One\nAddress Two',
  '点击详细地址标题必须复制全部地址内容'
);
assert.equal(vm.runInContext(`customerDetailCopyText({}, 'paymentEmail')`, context), '', '空内容不能复制占位文字');

console.log('Customer multi-field tests passed: migration, normalization, primary mirrors, copy, and search verified.');
