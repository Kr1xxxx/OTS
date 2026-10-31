#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');

function extractFunction(name) {
  const plainStart = html.indexOf(`function ${name}(`);
  if (plainStart < 0) throw new Error(`Missing function: ${name}`);
  const asyncStart = html.lastIndexOf('async ', plainStart);
  const start = asyncStart >= 0 && asyncStart + 6 === plainStart ? asyncStart : plainStart;
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

let saveSucceeds = true;
let notificationCalls = [];
const context = vm.createContext({
  console,
  canSubmitStoredData() { return true; },
  normalizeDate: value => String(value || '').slice(0, 10),
  normalizeMonth: value => String(value || '').slice(0, 7),
  isSettledStage: () => false,
  document:{ getElementById:() => ({ dataset:{} }) },
  isMacAppMode: () => true,
  flushPendingSave: async () => saveSucceeds,
  requestOrderNotification: async orderId => {
    notificationCalls.push(orderId);
    return { ok:true, status:'sent', sentAt:'2026-08-18 18:00:00', messageId:'om_test', chatName:'订单通知群（待配置）' };
  },
  escapeAttr: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  editingId: 'o-source',
  state: { orders:[{ id:'o-source', num:'SO-OLD', client:'Source', feishuNotification:{ requested:true, status:'sent', messageId:'om_old' } }] },
  nextOrderNum: () => 'SO-COPY',
  nowText: () => '2026-08-18 18:00',
  closeOrder() {},
  render() {},
  toast() {}
});

[
  'shouldRequestOrderNotification',
  'persistOrderBeforeNotification',
  'normalizeFeishuNotification',
  'renderFeishuNotificationBadge',
  'renderOrderDetailNotification',
  'duplicateOrder'
].forEach(name => vm.runInContext(extractFunction(name), context));

function evaluate(expression) {
  return vm.runInContext(expression, context);
}

const checkboxMatches = [...html.matchAll(/<input[^>]+name="sendFeishuNotification"[^>]*>/g)].map(match => match[0]);
assert.equal(checkboxMatches.length, 2, 'both remaining formal creation entries need a Feishu checkbox');
checkboxMatches.forEach(markup => assert.match(markup, /\bchecked\b/, 'Feishu checkbox must default checked'));
assert.match(html, /保存后发送到飞书群/);
assert.match(html, /id="orderFeishuNotificationField"/);

assert.equal(evaluate('shouldRequestOrderNotification(null, false, true)'), true, 'new formal order should send');
assert.equal(evaluate('shouldRequestOrderNotification(null, false, false)'), false, 'unchecked new order should not send');
assert.equal(evaluate('shouldRequestOrderNotification(null, true, true)'), false, 'draft should not send');
assert.equal(evaluate('shouldRequestOrderNotification({ isDraft:true }, false, true)'), true, 'first formal save of a draft should send');
assert.equal(evaluate('shouldRequestOrderNotification({ isDraft:false }, false, true)'), false, 'editing a formal order should not send');
evaluate('duplicateOrder()');
assert.equal(context.state.orders[0].num, 'SO-COPY');
assert.equal(context.state.orders[0].feishuNotification.status, 'skipped', 'duplicated order must not inherit sent status');
assert.equal(context.state.orders[0].feishuNotification.requested, false);

(async () => {
  notificationCalls = [];
  saveSucceeds = false;
  const unsaved = await evaluate("persistOrderBeforeNotification('o-unsaved', true)");
  assert.equal(unsaved, null);
  assert.deepEqual(notificationCalls, [], 'failed SQLite save must not call Feishu');

  saveSucceeds = true;
  const sent = await evaluate("persistOrderBeforeNotification('o-sent', true)");
  assert.equal(sent.status, 'sent');
  assert.deepEqual(notificationCalls, ['o-sent'], 'saved order should call Feishu exactly once');

  notificationCalls = [];
  const skipped = await evaluate("persistOrderBeforeNotification('o-skipped', false)");
  assert.equal(skipped, null);
  assert.deepEqual(notificationCalls, [], 'unchecked order must not call Feishu');

  const sentBadge = evaluate(`renderFeishuNotificationBadge({ feishuNotification:{ status:'sent', sentAt:'2026-08-18 18:00' } })`);
  const failedBadge = evaluate(`renderFeishuNotificationBadge({ feishuNotification:{ status:'failed', error:'暂时不可用' } })`);
  const sendingBadge = evaluate(`renderFeishuNotificationBadge({ feishuNotification:{ status:'sending' } })`);
  const skippedBadge = evaluate(`renderFeishuNotificationBadge({ feishuNotification:{ status:'skipped' } })`);
  assert.match(sentBadge, /群消息已发送/);
  assert.match(sentBadge, /tag-green/);
  assert.match(failedBadge, /群消息发送失败/);
  assert.match(failedBadge, /tag-orange/);
  assert.match(sendingBadge, /群消息发送中/);
  assert.match(sendingBadge, /tag-gray/);
  assert.equal(skippedBadge, '');

  const sentDetail = evaluate(`renderOrderDetailNotification({ id:'o1', feishuNotification:{ status:'sent', sentAt:'2026-08-18 18:00', chatName:'订单通知群（待配置）' } })`);
  const failedDetail = evaluate(`renderOrderDetailNotification({ id:'o2', feishuNotification:{ status:'failed', error:'服务暂时不可用 <secret>', chatName:'订单通知群（待配置）' } })`);
  assert.match(sentDetail, /订单通知群（待配置）/);
  assert.match(sentDetail, /2026-08-18 18:00/);
  assert.doesNotMatch(sentDetail, /data-retry-order-notification/);
  assert.match(failedDetail, /data-retry-order-notification="o2"/);
  assert.match(failedDetail, /&lt;secret&gt;/, 'detail error must be escaped');

  assert.match(html, /renderFeishuNotificationBadge\(order\)/, 'order list must render notification status');
  assert.match(html, /renderOrderDetailNotification\(order\)/, 'order detail must render notification status');
  assert.match(html, /data-retry-order-notification/, 'order detail needs failed-send retry handling');

  console.log('Feishu order UI tests passed: eligibility, save-before-send, default checkboxes, list/detail status, and retry UI verified.');
})().catch(error => {
  console.error(`Feishu order UI test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
