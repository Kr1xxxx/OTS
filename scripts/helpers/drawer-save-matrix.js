// What saving from the order detail drawer does, recorded as a baseline: for every pair of
// (order, edit made in the drawer) the saved order, the toasts, the confirm dialogs, the group-message request,
// whether the drawer still counts as unsaved, and where the focus is. Plus the failed saves (500, 409).
//
// The baseline file was written on main before the drawer stopped borrowing the hidden order form, so a change
// to how the drawer saves has to reproduce it exactly. Regenerate it (`--update`) only on unmodified main, or
// when a change of business rules is meant to change what a drawer save does; say which in the pull request.
//
// Edits are typed into the drawer's own fields ([data-dedit]) with input / change events, and saving goes through
// uiDetailSave, which is what the 保存 / 转为正式订单 buttons and ⌘S call. Confirm dialogs are answered by a
// stand-in for appConfirm that records what was asked; the group message is not sent (completeOrderNotification
// is recorded instead). Clock values (update times, log times, today's date) are replaced by placeholders.
//
// The cases are split over two test files by order (scripts/test-detail-drawer-save-matrix-{1,2}-ui.js), each with
// its own baseline in scripts/fixtures, so the two halves run side by side.
// Usage: node scripts/test-detail-drawer-save-matrix-1-ui.js [--update] [filter]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---- made-up data ----
const day = d => `2025-03-${String(d).padStart(2, '0')}`;
const base = {
  currency:'USD', productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States',
  createdAt:day(1), orderMonth:'2025-03', updated:`${day(1)} 09:00`, logs:[{ time:`${day(1)} 09:00`, text:'新建订单' }],
  shipments:[], attachments:[], trackingNumber:'', carrier:'auto', logisticsStatus:'未发货', logisticsUpdated:'', shippedAt:'',
  urgentOrder:false, customerRequiredDate:'', latestShipDate:'', next:'', note:'', orderDetail:'', isDraft:false,
  feishuNotification:{ requested:false, status:'skipped' }
};
const customers = {
  'Alice Wigs':{ id:'cust-alice-01', client:'Alice Wigs', country:'🇺🇸 美国 United States', currency:'USD', paymentMethod:'Paypal', productType:'假发', owner:'Amy' },
  'Bob Hair':{ id:'cust-bob-0002', client:'Bob Hair', country:'🇩🇪 德国 Germany', currency:'EUR', paymentMethod:'阿里巴巴', productType:'睫毛', owner:'Ben' },
  'Zoe Lashes':{ id:'cust-zoe-0003', client:'Zoe Lashes', country:'🇬🇧 英国 United Kingdom', currency:'GBP', paymentMethod:'西联', productType:'睫毛', owner:'Zed' }
};
const shipment = (id, trackingNumber, carrier, status, shippedAt, updated = '') => ({ id, trackingNumber, carrier, status, shippedAt, updated });
const orders = [
  { ...base, id:'dq', num:'K25030101', client:'Alice Wigs', orderType:'定金订单', stage:'quote', amount:1000, paidAmount:0, depositAmount:0, depositPercent:0 },
  { ...base, id:'dqp', num:'K25030102', client:'Alice Wigs', orderType:'定金订单', stage:'quote', amount:1000, paidAmount:0, depositAmount:300, depositPercent:30 },
  { ...base, id:'dp', num:'K25030103', client:'Alice Wigs', orderType:'定金订单', stage:'production', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30,
    urgentOrder:true, customerRequiredDate:'2025-04-10', latestShipDate:'2025-04-01', orderDetail:'BW-20 x 10\nHD lace x 2', next:'催尾款', note:'old note' },
  { ...base, id:'dbd', num:'K25030104', client:'Bob Hair', country:'🇩🇪 德国 Germany', currency:'EUR', paymentChannel:'阿里巴巴', productType:'睫毛', orderType:'定金订单', stage:'balance', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30 },
  { ...base, id:'dbf', num:'K25030105', client:'Alice Wigs', orderType:'定金订单', stage:'balance', amount:1000, paidAmount:1000, depositAmount:300, depositPercent:30 },
  { ...base, id:'ds', num:'K25030106', client:'Alice Wigs', orderType:'定金订单', stage:'shipment', amount:1000, paidAmount:1000, depositAmount:300, depositPercent:30, paidBeforeSettle:300,
    shipments:[shipment('ship-ds-1', '1234567890', 'DHL', '运输中', day(5), `${day(6)} 08:00`)], trackingNumber:'1234567890', carrier:'DHL', logisticsStatus:'运输中', logisticsUpdated:`${day(6)} 08:00`, shippedAt:day(5) },
  { ...base, id:'dd', num:'K25030107', client:'Alice Wigs', orderType:'定金订单', stage:'done', amount:1000, paidAmount:1000, depositAmount:300, depositPercent:30,
    shipments:[shipment('ship-dd-1', '2234567890', 'DHL', '已签收', day(3), `${day(8)} 08:00`)], trackingNumber:'2234567890', carrier:'DHL', logisticsStatus:'已签收', logisticsUpdated:`${day(8)} 08:00`, shippedAt:day(3) },
  { ...base, id:'fp', num:'K25030108', client:'Alice Wigs', orderType:'全款订单', stage:'production', amount:800, paidAmount:800, depositAmount:800, depositPercent:100 },
  { ...base, id:'fu', num:'K25030109', client:'Walk In Buyer', orderType:'全款订单', stage:'quote', amount:800, paidAmount:0, depositAmount:800, depositPercent:100 },
  { ...base, id:'fpart', num:'K25030110', client:'Alice Wigs', orderType:'全款订单', stage:'production', amount:800, paidAmount:200, depositAmount:800, depositPercent:100 },
  { ...base, id:'fs', num:'K25030111', client:'Alice Wigs', orderType:'全款订单', stage:'shipment', amount:800, paidAmount:800, depositAmount:800, depositPercent:100,
    shipments:[shipment('ship-fs-1', '771234567890', 'FedEx', '运输中', day(7))], trackingNumber:'771234567890', carrier:'FedEx', logisticsStatus:'运输中', shippedAt:day(7) },
  { ...base, id:'drc', num:'K25030112', client:'Alice Wigs', orderType:'定金订单', stage:'quote', amount:500, paidAmount:0, depositAmount:0, depositPercent:0, isDraft:true },
  { ...base, id:'drn', num:'K25030113', client:'', orderType:'定金订单', stage:'quote', amount:300, paidAmount:0, depositAmount:0, depositPercent:0, isDraft:true },
  { ...base, id:'drs', num:'K25030114', client:'Bob Hair', country:'🇩🇪 德国 Germany', currency:'EUR', paymentChannel:'阿里巴巴', orderType:'定金订单', stage:'quote', amount:700, paidAmount:0, depositAmount:0, depositPercent:0, isDraft:true,
    feishuNotification:{ requested:true, status:'sent', chatName:'测试群', sentAt:`${day(2)} 10:00`, messageId:'om_test_1' } },
  { ...base, id:'ship2', num:'K25030115', client:'Zoe Lashes', country:'🇬🇧 英国 United Kingdom', currency:'GBP', paymentChannel:'西联', productType:'睫毛', orderType:'定金订单', stage:'shipment', amount:1000, paidAmount:1000, depositAmount:400, depositPercent:40, paidBeforeSettle:400, partialShipment:true,
    shipments:[shipment('ship-2a', '3234567890', 'DHL', '已签收', day(4), `${day(9)} 08:00`), shipment('ship-2b', '779876543210', 'FedEx', '运输中', day(6), `${day(9)} 09:00`)],
    trackingNumber:'3234567890', carrier:'DHL', logisticsStatus:'运输中', logisticsUpdated:`${day(9)} 09:00`, shippedAt:day(4) },
  { ...base, id:'att', num:'K25030116', client:'Alice Wigs', orderType:'定金订单', stage:'production', amount:1200, paidAmount:400, depositAmount:400, depositPercent:33.33,
    attachments:[
      { name:'付款截图.jpg', type:'付款截图', fileUrl:'/attachments/test/pay.jpg', thumbUrl:'/attachments/test/pay-thumb.jpg', time:`${day(2)} 11:00`, size:12345 },
      { name:'PI 链接', type:'PI', link:'https://example.com/pi/123', time:`${day(2)} 11:05` }
    ] },
  { ...base, id:'aed', num:'K25030117', client:'Walk In Buyer', country:'阿联酋', currency:'AED', orderType:'定金订单', stage:'production', amount:2000, paidAmount:500, depositAmount:500, depositPercent:25 },
  { ...base, id:'dep0', num:'K25030118', client:'Alice Wigs', orderType:'定金订单', stage:'production', amount:1000, paidAmount:400, depositAmount:'', depositPercent:'' },
  { ...base, id:'flags', num:'K25030119', client:'Alice Wigs', orderType:'定金订单', stage:'production', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30, depositAutoPaid:true, paidBeforeDeposit:0 },
  { ...base, id:'copy', num:'K25030120', client:'Alice Wigs', orderType:'定金订单', stage:'quote', amount:600, paidAmount:0, depositAmount:0, depositPercent:0,
    logs:[{ time:`${day(3)} 09:00`, text:'由订单 K25030101 复制生成' }] },
  { ...base, id:'noowner', num:'K25030121', client:'Walk In Buyer', owner:'', orderType:'定金订单', stage:'quote', amount:900, paidAmount:0, depositAmount:0, depositPercent:0 }
];
const byId = Object.fromEntries(orders.map(o => [o.id, o]));
const settled = o => ['shipment', 'done'].includes(o.stage);
const paidOf = o => Number(o.paidAmount || 0);

// ---- edits ----
// Each case: { name, values (drawer field → typed value), promote, answers (confirm answers in order), feishu (draft toggle) }.
const cases = [];
const add = (order, name, values = {}, extra = {}) => cases.push({ order:order.id, name, values, ...extra });
orders.forEach(o => {
  const otherClient = o.client === 'Zoe Lashes' ? 'Bob Hair' : 'Zoe Lashes';
  const toType = (o.orderType || '定金订单') === '定金订单' ? '全款订单' : '定金订单';
  const typeAsks = !o.isDraft && paidOf(o) > 0;
  add(o, 'nothing');
  add(o, 'client other customer', { client:otherClient });
  add(o, 'client other customer, lower case', { client:otherClient.toLowerCase() });
  add(o, 'client new name', { client:'New Buyer Ltd' });
  add(o, 'client blank', { client:'   ' });
  add(o, 'country', { country:'🇫🇷 法国 France' });
  add(o, 'productType', { productType:o.productType === '睫毛' ? '假发' : '睫毛' });
  add(o, 'orderType', { orderType:toType }, typeAsks ? { answers:[true] } : {});
  if (typeAsks) add(o, 'orderType, answer 不改', { orderType:toType }, { answers:[false] });
  add(o, 'customerRequiredDate', { customerRequiredDate:'2025-05-20' });
  add(o, 'latestShipDate', { latestShipDate:'2025-05-10' });
  add(o, 'orderDetail', { orderDetail:'  A款 x 3 \n\n B款 x 1 ' });
  add(o, 'next', { next:'发 PI' });
  add(o, 'note only', { note:'只改备注' });
  add(o, 'urgentOrder', { urgentOrder:!o.urgentOrder });
  add(o, 'partialShipment', { partialShipment:!o.partialShipment });
  add(o, 'amount up', { amount:String(Number(o.amount) + 500) });
  add(o, 'paymentChannel', { paymentChannel:o.paymentChannel === 'TT' ? 'Zelle' : 'TT' });
  add(o, 'currency', { currency:o.currency === 'EUR' ? 'USD' : 'EUR' });
  add(o, 'note and next', { note:'备注 2', next:'下一步 2' });
  add(o, 'amount empty', { amount:'' });
  add(o, 'amount negative', { amount:'-5' });
  if (o.id === 'aed') add(o, 'currency to a listed one and back', { currency:'AED', note:'AED 不变' });
  if (settled(o)) return;
  // Payment edits: only where the paid field can be typed into (已发货 / 已完成 show it read-only).
  const amount = Number(o.amount);
  const paid = paidOf(o);
  add(o, 'amount down', { amount:String(Math.round(amount * 0.6)) });
  if (paid > 0) {
    add(o, 'amount below paid, 按订单金额保存', { amount:String(Math.round(paid / 2)) }, { answers:[true] });
    add(o, 'amount below paid, 回去修改', { amount:String(Math.round(paid / 2)) }, { answers:[false] });
  }
  add(o, 'paid cleared', { paidAmount:'' });
  add(o, 'paid zero', { paidAmount:'0' });
  add(o, 'paid partial', { paidAmount:String(Math.round(amount * 0.5)) });
  add(o, 'paid deposit-sized', { paidAmount:String(Math.round(amount * 0.3)) });
  add(o, 'paid in full', { paidAmount:String(amount) });
  add(o, 'paid over, 按订单金额保存', { paidAmount:String(amount + 200) }, { answers:[true] });
  add(o, 'paid over, 回去修改', { paidAmount:String(amount + 200) }, { answers:[false] });
  add(o, 'paid negative', { paidAmount:'-50' });
  add(o, 'orderType and amount', { orderType:toType, amount:String(amount + 300) }, typeAsks ? { answers:[true] } : {});
  add(o, 'orderType and paid', { orderType:toType, paidAmount:String(Math.round(amount * 0.4)) }, typeAsks ? { answers:[true] } : {});
  add(o, 'orderType and paid in full', { orderType:toType, paidAmount:String(amount) }, typeAsks ? { answers:[true] } : {});
  add(o, 'amount and paid', { amount:String(amount + 100), paidAmount:String(Math.round(amount * 0.2)) });
  add(o, 'paid and note', { paidAmount:String(Math.round(amount * 0.5)), note:'收到一半' });
  add(o, 'paid via 收齐 button', {}, { paidFull:true });
});
// Drafts: 保存 keeps a draft; 转为正式订单 with the group message on / off; promoting with no edit.
['drc', 'drn', 'drs'].forEach(id => {
  const o = byId[id];
  add(o, 'promote, no edit, feishu on', {}, { promote:true, feishu:true });
  add(o, 'promote, no edit, feishu off', {}, { promote:true, feishu:false });
  add(o, 'promote with note, feishu on', { note:'转正' }, { promote:true, feishu:true });
  add(o, 'promote with paid, feishu on', { paidAmount:String(Math.round(o.amount * 0.3)) }, { promote:true, feishu:true });
  add(o, 'promote with client, feishu off', { client:'Zoe Lashes' }, { promote:true, feishu:false });
});
// A copy made from another order and not saved yet (its first save counts as a new order).
add(byId.copy, 'pending copy, note', { note:'复制后改备注' }, { pendingCopy:true });
add(byId.copy, 'pending copy, paid', { paidAmount:'200' }, { pendingCopy:true });
add(byId.copy, 'pending copy, nothing', {}, { pendingCopy:true });
// The same with the remembered group-message choice switched off before.
add(byId.drc, 'promote, remembered choice off', { note:'记住不发' }, { promote:true, rememberedChoice:'0' });
add(byId.copy, 'pending copy, remembered choice off', { note:'记住不发' }, { pendingCopy:true, rememberedChoice:'0' });

// ---- clock values → placeholders ----
const pad = n => String(n).padStart(2, '0');
function scrubber(nowDates) {
  return function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, scrub(value[key])]));
    if (typeof value !== 'string') return value;
    let text = value;
    nowDates.forEach(date => {
      text = text.replace(new RegExp(`${date} \\d{2}:\\d{2}`, 'g'), '<now>').replace(new RegExp(date, 'g'), '<today>');
    });
    return text;
  };
}

// Top-level keys of `after` that differ from `before`, and the keys it no longer has.
function changesFrom(before, after) {
  if (!after) return null;
  const changed = {};
  Object.keys(after).forEach(key => {
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) changed[key] = after[key];
  });
  const removed = Object.keys(before).filter(key => !(key in after));
  return removed.length ? { changed, removed } : { changed };
}

async function runCase(page, store, kase) {
  return page.evaluate(async ({ kase, fixture }) => {
    const clone = value => JSON.parse(JSON.stringify(value));
    // Start from the same data every time; nothing of the previous case stays in the drawer or in memory.
    closeOrderDetail();
    document.querySelectorAll('#toast .toast-item').forEach(el => el.remove());
    state.orders = clone(fixture.orders);
    state.trashOrders = [];
    state.deletedOrders = [];
    state.customers = clone(fixture.customers);
    feishuPendingCopies.clear();
    if (kase.rememberedChoice) safeStorage.setItem('ots-feishu-send-v1', kase.rememberedChoice);
    else safeStorage.removeItem('ots-feishu-send-v1');
    render();
    await flushPendingSave();
    if (kase.pendingCopy) feishuPendingCopies.add(kase.order);

    const log = { toasts:[], confirms:[], notifications:[] };
    const answers = [...(kase.answers || [])];
    window.__matrixLog = log;
    window.__matrixAnswers = answers;

    openOrderDetail(kase.order, { tab:'info' });
    const body = document.getElementById('orderDetailBody');
    for (const [name, value] of Object.entries(kase.values)) {
      const field = body.querySelector(`[data-dedit="${name}"]`);
      if (!field) { log.missingField = name; continue; }
      if (field.type === 'checkbox') field.checked = !!value;
      else {
        // A currency outside the list is already an option of the drawer's select (it shows the stored one).
        field.value = value;
        if (field.tagName === 'SELECT' && field.value !== value) log.unselectable = `${name}=${value}`;
      }
      field.dispatchEvent(new Event('input', { bubbles:true }));
      field.dispatchEvent(new Event('change', { bubbles:true }));
    }
    if (kase.paidFull) body.querySelector('[data-detail-paid-full]')?.click();
    if (kase.feishu !== undefined) {
      const toggle = document.getElementById('detailFeishuToggle');
      if (toggle) toggle.checked = kase.feishu;
    }
    const before = { unsaved:uiDetailUnsaved() };
    await uiDetailSave({ promote:!!kase.promote });
    await flushPendingSave();
    const order = state.orders.find(o => o.id === kase.order);
    const active = document.activeElement;
    return {
      before,
      order:order ? clone(order) : null,
      toasts:log.toasts,
      confirms:log.confirms,
      unansweredConfirms:answers.length,
      notifications:log.notifications,
      unsaved:uiDetailUnsaved(),
      drawerOpen:document.getElementById('orderDetailDrawer').classList.contains('open'),
      drawerOrder:detailOrderId,
      orderModalOpen:document.getElementById('orderModal').classList.contains('open'),
      focus:active?.dataset?.dedit ? `drawer:${active.dataset.dedit}` : (body.contains(active) ? 'drawer' : null),
      customers:Object.keys(state.customers).sort(),
      orderCount:state.orders.length,
      feishuChoice:safeStorage.getItem('ots-feishu-send-v1'),
      pendingCopy:feishuPendingCopies.has(kase.order),
      missingField:log.missingField || null,
      unselectable:log.unselectable || null
    };
  }, { kase, fixture:{ orders, customers } });
}

// Stand-ins installed once: toasts and confirms are recorded, confirms answered from the case's list,
// the group message is not sent.
async function installRecorders(page) {
  await page.evaluate(() => {
    const realToast = uiToast;
    window.uiToast = (text, options = {}) => {
      window.__matrixLog?.toasts.push({ text:String(text), desc:options.desc || '', tone:options.tone || '', action:typeof options.undo === 'function' ? (options.undoText || '撤销') : '' });
      return realToast(text, options);
    };
    window.appConfirm = async (options = {}) => {
      const answer = window.__matrixAnswers?.length ? window.__matrixAnswers.shift() : null;
      window.__matrixLog?.confirms.push({ title:options.title || '', sub:options.sub || '', message:options.message || '', confirmText:options.confirmText || '', cancelText:options.cancelText || '', answer });
      return { confirmed:answer === true };
    };
    window.completeOrderNotification = async (orderId, requested, successText) => {
      window.__matrixLog?.notifications.push({ orderId, requested, successText });
      return null;
    };
  });
}

// Failed saves: the drawer keeps what was typed and still counts as unsaved; closing it takes the change back
// out of memory; a later background save that gets through marks it saved. 409: the page merges and saves again.
async function runFailures(page, control) {
  const results = {};
  const prepare = (id, values) => page.evaluate(async ({ id, values, fixture }) => {
    const clone = value => JSON.parse(JSON.stringify(value));
    closeOrderDetail();
    document.querySelectorAll('#toast .toast-item').forEach(el => el.remove());
    state.orders = clone(fixture.orders);
    state.customers = clone(fixture.customers);
    feishuPendingCopies.clear();
    safeStorage.removeItem('ots-feishu-send-v1');
    render();
    await flushPendingSave();
    // Each step starts as if no save error was shown in the last 10 s. The page holds back a second
    // save-error toast for 10 s and the "已排队" toast for 1.5 s after one; without this reset, which
    // toasts a step shows depends on how long the steps before it took (a slow WebKit run got one more).
    macSaveErrorToastAt = 0;
    window.__matrixLog = { toasts:[], confirms:[], notifications:[] };
    window.__matrixAnswers = [];
    openOrderDetail(id, { tab:'info' });
    const body = document.getElementById('orderDetailBody');
    Object.entries(values).forEach(([name, value]) => {
      const field = body.querySelector(`[data-dedit="${name}"]`);
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles:true }));
      field.dispatchEvent(new Event('change', { bubbles:true }));
    });
  }, { id, values, fixture:{ orders, customers } });
  const snapshot = id => page.evaluate(id => ({
    order:JSON.parse(JSON.stringify(state.orders.find(o => o.id === id) || null)),
    toasts:window.__matrixLog.toasts.splice(0),
    unsaved:uiDetailUnsaved(),
    drawerOpen:document.getElementById('orderDetailDrawer').classList.contains('open'),
    drawerValues:document.getElementById('orderDetailDrawer').classList.contains('open') ? uiDetailEditValues() : null,
    orderModalOpen:document.getElementById('orderModal').classList.contains('open')
  }), id);
  const save = () => page.evaluate(() => uiDetailSave());
  const storedOrder = id => JSON.parse(JSON.stringify(control.store.current.data.orders.find(o => o.id === id) || null));

  // 500, then the drawer is closed: memory goes back to the saved order and the retry writes nothing new.
  await prepare('dp', { note:'没存进去', paidAmount:'500' });
  control.fail = { status:500 };
  await save();
  results['500 then close: after save'] = await snapshot('dp');
  await page.evaluate(() => closeOrderDetail());
  results['500 then close: after close'] = await snapshot('dp');
  control.fail = null;
  await page.evaluate(() => flushPendingSave());
  results['500 then close: stored'] = storedOrder('dp');

  // 500, then the background retry gets through with the drawer untouched: it counts as saved.
  await prepare('dqp', { note:'后台重试', paidAmount:'300' });
  control.fail = { status:500 };
  await save();
  results['500 then retry: after save'] = await snapshot('dqp');
  control.fail = null;
  await page.evaluate(() => flushPendingSave());
  await page.waitForFunction(() => !document.getElementById('orderDetailBody')._failedSave);
  results['500 then retry: after retry'] = await snapshot('dqp');
  results['500 then retry: stored'] = storedOrder('dqp');

  // 500, then 保存 again after the server is back: saved normally.
  await prepare('fu', { paidAmount:'400', note:'再点一次保存' });
  control.fail = { status:500 };
  await save();
  results['500 then save again: after save'] = await snapshot('fu');
  control.fail = null;
  await save();
  results['500 then save again: after second save'] = await snapshot('fu');
  results['500 then save again: stored'] = storedOrder('fu');

  // 409 once: another window saved first (it changed another order's note); the page merges and saves again.
  await prepare('dbd', { note:'冲突后合并', amount:'1200' });
  control.fail = { status:409, once:true, other:{ id:'fp', note:'另一个窗口改的' } };
  await save();
  await page.evaluate(() => flushPendingSave());
  results['409 once: after save'] = await snapshot('dbd');
  results['409 once: stored'] = storedOrder('dbd');
  results['409 once: other order in memory'] = await page.evaluate(() => state.orders.find(o => o.id === 'fp').note);
  control.fail = null;
  return results;
}

// Orders of each half; the failed saves run with the second.
const parts = {
  1:['dq', 'dqp', 'dp', 'dbd', 'dbf', 'ds', 'dd', 'fp', 'fu', 'fpart'],
  2:['fs', 'drc', 'drn', 'drs', 'ship2', 'att', 'aed', 'dep0', 'flags', 'copy', 'noowner']
};

async function runMatrix({ part, launchBrowser, openBoard, port }) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', `detail-drawer-save-matrix-${part}.json`);
  const update = process.argv.includes('--update');
  const filter = process.argv.slice(2).find(arg => !arg.startsWith('--')) || '';
  const withFailures = part === 2 && !filter;
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs } = await openBoard(browser, { orders, customers }, { port });
    const control = { fail:null, store };
    // Failure modes for /api/save; otherwise the board helper's in-memory store answers.
    await page.route('**/api/save', async route => {
      const fail = control.fail;
      if (!fail) return route.fallback();
      if (fail.status === 409) {
        if (fail.once) control.fail = null;
        const current = store.current;
        const data = JSON.parse(JSON.stringify(current.data));
        const other = data.orders.find(o => o.id === fail.other.id);
        if (other) other.note = fail.other.note;
        store.current = { ...current, data, revision:current.revision + 1 };
        return route.fulfill({ status:409, json:{ ok:false, conflict:true, message:'revision conflict', revision:store.current.revision, state:store.current } });
      }
      return route.fulfill({ status:fail.status, json:{ ok:false, message:'TEST disk unavailable' } });
    });
    await installRecorders(page);
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const tomorrow = new Date(now.getTime() + 86400000);
    const scrub = scrubber([today, `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`]);

    const selected = cases.filter(kase => parts[part].includes(kase.order) && (!filter || `${kase.order} / ${kase.name}`.includes(filter)));
    const names = new Set();
    const results = {};
    const started = Date.now();
    for (const kase of selected) {
      const key = `${kase.order} / ${kase.name}`;
      assert.ok(!names.has(key), `duplicate case ${key}`);
      names.add(key);
      const result = await runCase(page, store, kase);
      // What reached the in-memory server must be what the page holds.
      const stored = store.current.data.orders.find(o => o.id === kase.order) || null;
      result.storedMatchesMemory = JSON.stringify(scrub(stored)) === JSON.stringify(scrub(result.order));
      // The saved order is kept as what changed against the fixture order (the fixture is above).
      const { order, ...rest } = scrub(result);
      results[key] = { ...rest, order:changesFrom(scrub(byId[kase.order]), order) };
    }
    const failures = withFailures ? scrub(await runFailures(page, control)) : {};
    const ms = Date.now() - started;
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(dialogs.length, 0, `native dialogs: ${dialogs.join(' | ')}`);

    if (update) {
      if (filter) throw new Error('--update writes the whole baseline; run it without a filter');
      fs.mkdirSync(path.dirname(fixturePath), { recursive:true });
      // One line per case: a change shows up in a diff as the cases it touched.
      const lines = Object.entries(results).map(([key, value]) => `  ${JSON.stringify(key)}:${JSON.stringify(value)}`);
      fs.writeFileSync(fixturePath, `{"cases":{\n${lines.join(',\n')}\n},\n"failures":${JSON.stringify(failures, null, 1)}}\n`);
      console.log(`Wrote ${Object.keys(results).length} cases and ${Object.keys(failures).length} failure steps to ${path.relative(process.cwd(), fixturePath)} in ${(ms / 1000).toFixed(1)} s.`);
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const mismatches = [];
    for (const key of Object.keys(results)) {
      if (!(key in baseline.cases)) { mismatches.push(`${key}: not in the baseline`); continue; }
      try { assert.deepStrictEqual(results[key], baseline.cases[key]); }
      catch (error) { mismatches.push(`${key}:\n${error.message.split('\n').slice(1, 40).join('\n')}`); }
    }
    if (!filter) {
      Object.keys(baseline.cases).filter(key => !(key in results)).forEach(key => mismatches.push(`${key}: in the baseline but not run`));
      try { assert.deepStrictEqual(failures, baseline.failures); }
      catch (error) { mismatches.push(`failed saves:\n${error.message.split('\n').slice(1, 60).join('\n')}`); }
    }
    assert.equal(mismatches.length, 0, `${mismatches.length} drawer saves differ from the baseline:\n\n${mismatches.slice(0, 8).join('\n\n')}`);
    console.log(`Detail drawer save matrix ${part} passed: ${Object.keys(results).length} cases${withFailures ? ' and the failed saves (500, 409)' : ''} match the baseline (${(ms / 1000).toFixed(1)} s).`);
  } finally { await browser.close(); }
}

module.exports = { runMatrix, orders, customers, parts };
