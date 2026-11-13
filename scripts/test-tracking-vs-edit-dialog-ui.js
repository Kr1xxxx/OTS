#!/usr/bin/env node
// 物流更新还在跑的时候打开订单编辑弹窗，更新查到「已签收」把单移到已完成，再点弹窗里的「保存」：
// 用户没动过的阶段和物流状态以这张单现在的为准，不能被打开时的「已发货 / 运输中」盖回去；
// 用户自己改过的（物流状态改成异常、阶段选回待发货）以用户为准。
// /api/track 由测试放行：第一个查询到了以后才打开弹窗，放行后等订单状态变化（不把更新的 promise 从 evaluate 里交出来）。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, h } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');
const { freePortSync } = require('./helpers/free-port');

const DONE_LOG = '物流已签收，订单自动移动到已完成';
const shippedOrder = (extra = {}) => ({
  ...base,
  id:'t1',
  num:'T9001',
  client:'Track Buyer',
  amount:500,
  paidAmount:500,
  orderType:'全款订单',
  stage:'shipment',
  logisticsStatus:'运输中',
  trackingNumber:'1234567890',
  carrier:'DHL',
  shippedAt:base.createdAt,
  updated:`${base.createdAt} 09:00`,
  shipments:[{ id:'s1', trackingNumber:'1234567890', carrier:'DHL', status:'运输中', updated:'', shippedAt:base.createdAt }],
  ...extra
});

// 打开看板、开 DHL 查询、开始一轮手动更新；第一个查询到了就打开 t1 的编辑弹窗改备注，然后放行查询，等单被移到已完成。
// edit(page) 在更新跑完之后、保存之前，模拟用户在弹窗里再做的改动。
async function runScenario(browser, order, edit = async () => {}) {
  const { page, context, store, errors, dialogs } = await openBoard(browser, { orders:[order] }, { port:freePortSync() });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let trackCalls = 0;
  await page.unroute('**/*');
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    let response = { ok:true };
    if (pathname === '/api/data') response = store.current;
    if (pathname === '/api/track') {
      trackCalls += 1;
      await gate;
      const now = new Date().toISOString();
      response = { ok:true, status:'Delivered', carrier:'DHL', updatedAt:now, checkedAt:now };
    }
    if (pathname === '/api/save') {
      const body = route.request().postDataJSON();
      store.current = { ...body.state, revision:store.current.revision + 1 };
      store.saves += 1;
      response = { ok:true, revision:store.current.revision, backup:{ ok:true, skipped:true } };
    }
    return route.fulfill({ json:response });
  });
  await page.evaluate(() => saveTrackingApiSettings({ ...getTrackingApiSettings(), dhlApiEnabled:'是' }));
  await page.evaluate(() => { runTrackingAutoUpdate('manual'); });
  for (let i = 0; i < 100 && !trackCalls; i += 1) await page.waitForTimeout(50);
  assert.ok(trackCalls > 0, 'the tracking run asked for the parcel');

  await page.evaluate(id => openOrder(id), order.id);
  await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
  await page.evaluate(() => {
    const note = document.getElementById('orderForm').elements.note;
    note.value = 'edited while tracking runs';
    note.dispatchEvent(new Event('input', { bubbles:true }));
  });
  release();
  await page.waitForFunction(id => state.orders.find(o => o.id === id)?.stage === 'done', order.id, { timeout:10000 });
  assert.ok(await page.evaluate(() => document.getElementById('orderModal').classList.contains('open')), 'the dialog stays open through the run');
  const form = await page.evaluate(() => {
    const f = document.getElementById('orderForm');
    return { stage:f.elements.stage.value, status:f.elements.shipmentStatus.value };
  });
  assert.deepEqual(form, { stage:'shipment', status:'运输中' }, 'the open dialog still shows the values it was opened with');
  await edit(page);
  await h.click(page, '#orderSaveBtn', 'save order');
  await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'), null, { timeout:5000 });
  const saved = await h.order(page, order.id);
  const toasts = await h.toasts(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(dialogs, []);
  await context.close();
  return { saved, toasts };
}

const setSelect = (page, selector, value) => page.evaluate(([selector, value]) => {
  const field = document.querySelector(selector);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles:true }));
  field.dispatchEvent(new Event('change', { bubbles:true }));
}, [selector, value]);

(async () => {
  const browser = await launchBrowser();
  try {
    // 1. 只改了备注：保存后仍是已完成 / 已签收，备注是新的，自动完成的记录还在。
    {
      const { saved, toasts } = await runScenario(browser, shippedOrder());
      assert.equal(saved.stage, 'done', 'the order stays in 已完成');
      assert.deepEqual(saved.shipments.map(item => item.status), ['已签收'], 'the parcel stays 已签收');
      assert.equal(saved.logisticsStatus, '已签收');
      assert.equal(saved.note, 'edited while tracking runs', 'the note the user typed is saved');
      assert.ok(saved.logs.some(log => log.text === DONE_LOG), 'the auto-completion log is kept');
      assert.ok(!toasts.some(text => /已按(收款|物流单号)放到/.test(text)), `no "moved by payment" note for a stage nobody moved (${toasts.join(' / ')})`);
    }
    // 2. 用户在弹窗里把物流状态改成「异常」：以用户为准；阶段没动，留在已完成。
    {
      const { saved } = await runScenario(browser, shippedOrder(), page => setSelect(page, '#orderForm [name="shipmentStatus"]', '异常'));
      assert.deepEqual(saved.shipments.map(item => item.status), ['异常'], 'a status the user picked wins');
      assert.equal(saved.stage, 'done');
      assert.equal(saved.note, 'edited while tracking runs');
    }
    // 3. 定金单，用户在弹窗里把阶段选回「待发货」：以用户为准，没收的尾款按退回规则恢复。
    {
      const deposit = shippedOrder({ orderType:'定金订单', amount:2400, paidAmount:2400, depositAmount:800, depositPercent:33, paidBeforeSettle:800 });
      const { saved } = await runScenario(browser, deposit, page => setSelect(page, '#orderForm [name="stage"]', 'balance'));
      assert.equal(saved.stage, 'balance', 'a stage the user picked wins');
      assert.equal(saved.paidAmount, 800, 'going back to 待发货 restores what was really paid');
      assert.equal(saved.note, 'edited while tracking runs');
    }
    // 4. 还有尾款的定金单只改备注：已完成，已收按收齐记，真实已收（paidBeforeSettle）还在。
    {
      const deposit = shippedOrder({ orderType:'定金订单', amount:2400, paidAmount:2400, depositAmount:800, depositPercent:33, paidBeforeSettle:800 });
      const { saved } = await runScenario(browser, deposit);
      assert.equal(saved.stage, 'done');
      assert.deepEqual(saved.shipments.map(item => item.status), ['已签收']);
      assert.equal(saved.paidAmount, 2400, 'the balance still counts as received');
      assert.equal(saved.paidBeforeSettle, 800, 'the real paid amount is kept');
      assert.equal(saved.note, 'edited while tracking runs');
    }
    console.log('Tracking vs edit dialog passed: an untouched stage and parcel status follow the order, what the user changed wins.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
