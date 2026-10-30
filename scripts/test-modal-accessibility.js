#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');

function extractFunction(name, { optional = false } = {}) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) {
    if (optional) return '';
    throw new Error(`Missing production function: ${name}`);
  }
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

const modalIds = [...html.matchAll(/<div class="[^"]*modal-backdrop[^"]*" id="([^"]+)" aria-hidden="true">/g)].map(match => match[1]);
assert.deepEqual(modalIds, [
  'orderModal',
  'orderDetailDrawer',
  'calendarTaskDrawer',
  'trackingDetailDrawer',
  'boardCardSettingsModal',
  'customerModal',
  'combinedCustomerOrderModal',
  'confirmModal',
  'attachmentPreviewModal',
  'subscriptionDrawer',
  'subscriptionEditModal'
]);

const helperSource = extractFunction('setModalOpenState', { optional:true });
assert.ok(helperSource, '缺少统一同步弹窗视觉状态和 aria-hidden 的生产函数');

const fakeModal = {
  open:false,
  attributes:{ 'aria-hidden':'true' },
  classList:{ toggle(_name, enabled) { fakeModal.open = enabled; } },
  setAttribute(name, value) { this.attributes[name] = value; }
};
const context = vm.createContext({ document:{ getElementById() { return null; } } });
vm.runInContext(helperSource, context);
context.fakeModal = fakeModal;
vm.runInContext('setModalOpenState(fakeModal, true)', context);
assert.equal(fakeModal.open, true);
assert.equal(fakeModal.attributes['aria-hidden'], 'false', '打开弹窗时辅助功能必须能读取内容');
vm.runInContext('setModalOpenState(fakeModal, false)', context);
assert.equal(fakeModal.open, false);
assert.equal(fakeModal.attributes['aria-hidden'], 'true', '关闭弹窗时辅助功能必须忽略内容');

[
  'appConfirm',
  'openAttachmentPreview', 'closeAttachmentPreview',
  'openOrderDetail', 'closeOrderDetail',
  'openBoardCardSettings', 'closeBoardCardSettings',
  'openTrackingDetail', 'closeTrackingDetail',
  'openCalendarTaskDrawer', 'closeCalendarTaskDrawer',
  'openCustomerModal', 'closeCustomerModal',
  'openCombinedCustomerOrderModal', 'closeCombinedCustomerOrderModal',
  'openOrder', 'closeOrder',
  'openSubscriptionDetail', 'closeSubscriptionDetail',
  'openSubscriptionEditor', 'closeSubscriptionEditor'
].forEach(name => {
  assert.match(extractFunction(name), /setModalOpenState\(/, `${name} 必须同步视觉状态和 aria-hidden`);
});

console.log('Modal accessibility tests passed: all modal open/close paths synchronize aria-hidden.');
