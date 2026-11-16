#!/usr/bin/env node
// 待办类型一张表（taskTypeDefs）+ 承运商报「异常」的包裹进今日待办（用户 2026-11-16 定）。
// 时间用 page.clock 固定在 2026-11-07 10:00 上海时间。
// 1. buildTaskItems 出的每一种 type 在表里都有一行、每一列都不空；「已处理」键的前缀都在 orderDoneTaskKeys 认得的范围里。
// 2. 异常的那一批：一单一条「物流异常：承运商原话」；点完成后同一次异常不再提醒，承运商时间变了再出；变回运输中、订单完成后不出。
//    同一单另一批几天没更新：收在「另有 物流没更新」里；异常的那一批不再另算「几天没更新」。
// 3. 小结：「N 天没更新」叫「物流没更新」，承运商报异常叫「物流异常」。
const assert = require('node:assert/strict');
const { launchBrowser, h, html } = require('./helpers/board-page');

const TZ = 'Asia/Shanghai';
const at = (date, time = '10:00') => new Date(`${date}T${time}:00+08:00`).getTime();
const base = { currency:'USD', logisticsStatus:'未发货', orderMonth:'2026-11', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[], orderType:'定金订单', depositAmount:300, amount:1000 };
const order = (id, extra) => ({ ...base, id, num:`T-${id}`, client:`Client ${id}`, paidAmount:0, stage:'quote', createdAt:'2026-10-18', updated:'2026-11-06 09:00', ...extra });
const issueBatch = { id:'a', trackingNumber:'4444444444', carrier:'DHL', status:'异常', rawStatus:'Shipment on hold', updated:'2026-11-06 08:00', trackOkAt:'2026-11-06 08:00', shippedAt:'2026-11-01' };
const staleBatch = { id:'b', trackingNumber:'5555555555', carrier:'DHL', status:'运输中', updated:'2026-11-01 08:00', trackOkAt:'2026-11-06 08:00', shippedAt:'2026-11-01' };
const orders = [
  order('x1', { stage:'shipment', paidAmount:1000, logisticsStatus:'异常', shippedAt:'2026-11-01', trackingNumber:'4444444444', carrier:'DHL', shipments:[issueBatch, staleBatch] }),
  order('x2', { stage:'shipment', paidAmount:1000, logisticsStatus:'运输中', shippedAt:'2026-11-01', trackingNumber:'6666666666', carrier:'DHL', shipments:[{ ...staleBatch, id:'c', trackingNumber:'6666666666' }] }),
  order('b1', { stage:'balance', paidAmount:300 }),
  order('t1', { stage:'shipment', paidAmount:1000, logisticsStatus:'已发货', shippedAt:'2026-11-03' }),
  order('r1', { stage:'balance', paidAmount:1000 }),
  order('m1', { latestShipDate:'2026-11-05', urgentOrder:true, customerRequiredDate:'2026-11-06', updated:'2026-10-28 09:00' })
];

(async () => {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:960 }, timezoneId:TZ });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', '2026-11-07'); localStorage.setItem('trade-order-system-theme', 'light'); } catch (_) {} });
    const page = await context.newPage();
    await page.clock.setFixedTime(at('2026-11-07'));
    const store = { current:{ app:'trade-order-system', data:{ orders, customers:{}, doneTasks:{}, demoCleared:true, demoCustomersCleared:true }, revision:0 } };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = store.current;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
      if (pathname === '/api/track') response = { ok:false, status:'待 API 查询', message:'offline' };
      if (pathname === '/api/save') { store.current = { ...route.request().postDataJSON().state, revision:store.current.revision + 1 }; response = { ok:true, revision:store.current.revision, backup:{ ok:true, skipped:true } }; }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47993/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('dashboard'));
    const all = () => page.evaluate(() => buildTaskItems().map(t => t.id).sort());
    const shown = () => page.evaluate(() => buildTaskItems({ perOrder:true }).map(t => t.id).sort());
    const edit = (id, patch) => page.evaluate(([id, patch]) => { Object.assign(state.orders.find(o => o.id === id), patch); render(); }, [id, patch]);
    const batches = (a, b) => edit('x1', { shipments:[{ ...issueBatch, ...a }, { ...staleBatch, ...b }] });

    // ---- 1. 表：每一种都齐全 ----
    const table = await page.evaluate(() => {
      const columns = ['label', 'count', 'kind', 'inbox', 'roadmap', 'detailTab', 'look', 'calendar', 'done', 'again'];
      const items = buildTaskItems({ includeDone:true, includeSnoozed:true });
      return {
        missingRows:[...new Set(items.map(item => item.type))].filter(type => !taskTypeDefs[type]),
        emptyCells:Object.entries(taskTypeDefs).flatMap(([type, def]) => columns.filter(column => !def[column] || (Array.isArray(def[column]) && def[column].some(value => !value))).map(column => `${type}.${column}`)),
        noPrefix:Object.entries(taskTypeDefs).filter(([type, def]) => type !== 'repurchase' && !def.prefix).map(([type]) => type),
        // 每一条订单待办的「已处理」键，删订单时都认得出来。
        unknownKeys:items.filter(item => item.orderId && item.type !== 'repurchase').filter(item => {
          state.doneTasks = { [item.doneKey || item.id]:{ at:'2026-11-07 10:00', until:'' } };
          const known = orderDoneTaskKeys(item.orderId).length === 1;
          state.doneTasks = {};
          return !known;
        }).map(item => item.doneKey || item.id),
        types:[...new Set(items.map(item => item.type))].sort()
      };
    });
    assert.deepEqual(table.missingRows, [], 'every task type has a row');
    assert.deepEqual(table.emptyCells, [], 'every row is complete');
    assert.deepEqual(table.noPrefix, [], 'every order task type has a done-key prefix');
    assert.deepEqual(table.unknownKeys, [], 'deleting an order finds every done key of its tasks');
    assert.deepEqual(table.types, ['follow', 'logistics', 'logisticsIssue', 'payment', 'ready', 'ship', 'tracking', 'urgent']);

    // ---- 2. 物流异常：一单一条，另一批的「没更新」收在副标题里 ----
    assert.ok((await all()).includes('logistics-issue-x1') && (await all()).includes('logistics-risk-x1'));
    const x1 = await page.evaluate(() => buildTaskItems({ perOrder:true }).find(t => t.orderId === 'x1'));
    assert.equal(x1.id, 'logistics-issue-x1');
    assert.equal(x1.reason, '物流异常：Shipment on hold');
    assert.equal(x1.detail, 'DHL · 4444444444 · T-x1');
    assert.equal(x1.more, '另有 物流没更新');
    assert.match((await page.evaluate(() => buildTaskItems().find(t => t.id === 'logistics-risk-x1'))).detail, /5555555555/, 'the stale batch is the other one');
    const row = page.locator('#taskList .task[data-task-id="logistics-issue-x1"]');
    await row.waitFor();
    assert.match(await row.innerText(), /物流异常：Shipment on hold/);
    assert.match(await page.locator('#statTasksSub').innerText(), /物流异常 1/);
    assert.match(await page.locator('#statTasksSub').innerText(), /物流没更新 1/, 'the stale-only order x2 is 物流没更新');
    assert.doesNotMatch(await page.locator('#statTasksSub').innerText(), /物流异常 2/);
    assert.equal(await page.evaluate(() => taskDetailTab(buildTaskItems().find(t => t.id === 'logistics-issue-x1'))), 'logistics');
    assert.equal(await page.evaluate(() => customerRoadmapEvents('Client x1').filter(e => /物流异常/.test(e.title)).map(roadmapFilterType).join()), 'logistics');
    // 「物流」页签：x1、x2、t1、r1（m1 的发货期限也在物流页签）。
    assert.equal(await page.locator('#taskInboxFilters [data-task-filter="logistics"] .c').innerText(), '5');

    // 异常的那一批很久没更新：不另出「N 天没更新」。
    await batches({ updated:'2026-10-20 08:00' }, { updated:'2026-11-06 08:00' });
    assert.ok((await all()).includes('logistics-issue-x1'));
    assert.equal((await all()).includes('logistics-risk-x1'), false, 'an exception batch is not also reported as stale');
    await batches({}, {});

    // 点完成：同一次异常不再提醒，同一单的下一条（没更新）出来；订单记录写明。
    await h.clearToasts(page);
    await row.locator('.task-tick').click();
    await page.waitForSelector('#taskList .task[data-task-id="logistics-risk-x1"]');
    assert.equal(await row.count(), 0);
    assert.ok(await page.evaluate(() => state.doneTasks['logistics-issue-x1-4444444444-2026-11-06 08:00']), 'done key carries the batch and the carrier time');
    assert.match(await page.evaluate(() => state.orders.find(o => o.id === 'x1').logs[0].text), /物流异常提醒（完成）· 物流异常：Shipment on hold，承运商再报异常会再提醒/);
    assert.ok((await page.evaluate(() => orderDoneTaskKeys('x1'))).includes('logistics-issue-x1-4444444444-2026-11-06 08:00'));
    // 承运商又报一次异常（时间变了）：再出。
    await batches({ updated:'2026-11-07 08:00' }, {});
    assert.ok((await shown()).includes('logistics-issue-x1'), 'a new exception reminds again');
    // 变回运输中：不出。
    await batches({ status:'运输中', rawStatus:'' }, {});
    assert.equal((await all()).includes('logistics-issue-x1'), false, 'back in transit: no exception task');
    // 订单完成：不出。
    await batches({ updated:'2026-11-07 09:00' }, {});
    assert.ok((await all()).includes('logistics-issue-x1'));
    await edit('x1', { stage:'done' });
    assert.equal((await all()).some(id => id.endsWith('-x1')), false, 'a finished order has no tasks');

    // ---- 3. 只有「没更新」时小结写「物流没更新」 ----
    assert.deepEqual(await page.evaluate(() => taskTypeBreakdown(buildTaskItems({ perOrder:true }).filter(t => t.orderId === 'x2'), { long:true })), ['1 个物流没更新']);

    assert.deepEqual(errors, []);
    console.log('Task types UI passed: one table covers every task type (labels, filters, tabs, done keys); carrier exception is one to-do per order with the carrier words, done per exception, gone when back in transit or done; stale batches are 物流没更新.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
