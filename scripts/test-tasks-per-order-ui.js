const assert = require('node:assert/strict');
const { launchBrowser, h, html } = require('./helpers/board-page');

// 待办新规则（用户 2026-11-13 定），时间用 page.clock 固定在 2026-11-07 10:00 上海时间：
// 1. 工作台待办每张单只显示最要紧的一条，收起的类型写在副标题末尾「另有 …」；计数、「今日待办」、问候按收起后的数。
//    「完成」只处理显示的那一条，之后出同一张单的下一条；「稍后」整单暂缓，「取消稍后」整单放回。
//    日历、「已处理」、找提醒用全量，交期和加急不会从日历上消失。
// 2. 生产中的单不再提醒跟进；报价、待发货照常。
// 3. 新增三种：待发货收齐 →「可以发货」；已发货没有运单号 →「补运单号」；只填了要求收到日期 → 提前 7 天提醒发货。
const TZ = 'Asia/Shanghai';
const pad = n => String(n).padStart(2, '0');
const day = (offset, base = '2026-11-07') => { const [y, m, d] = base.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + offset)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const at = (date, time = '10:00') => new Date(`${date}T${time}:00+08:00`).getTime();
const base = { currency:'USD', logisticsStatus:'未发货', orderMonth:'2026-11', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[], orderType:'定金订单', depositAmount:300, amount:1000 };
const order = (id, extra) => ({ ...base, id, num:`T-${id}`, client:`Client ${id}`, paidAmount:0, stage:'quote', createdAt:day(-20), updated:`${day(-1)} 09:00`, ...extra });
const orders = [
  // 报价单：过了最晚发出日期 + 加急（客户要求昨天收到）+ 10 天没动 → 发货期限、加急、跟进三条，只显示发货期限。
  order('m1', { latestShipDate:day(-2), urgentOrder:true, customerRequiredDate:day(-1), updated:`${day(-10)} 09:00` }),
  // 生产中 30 天没动：不提醒跟进。
  order('p1', { stage:'production', paidAmount:300, updated:`${day(-30)} 09:00` }),
  // 待发货、钱已收齐、30 天没动：「可以发货」，跟进收在它下面。
  order('r1', { stage:'balance', paidAmount:1000, updated:`${day(-30)} 09:00` }),
  // 待发货、还有欠款：仍是「收款」。
  order('b1', { stage:'balance', paidAmount:300 }),
  // 已发货、没有运单号：「补运单号」。
  order('t1', { stage:'shipment', paidAmount:1000, logisticsStatus:'已发货', shippedAt:day(-4) }),
  // 部分发货、有一批带单号：不出「补运单号」。
  order('t2', { stage:'shipment', paidAmount:1000, logisticsStatus:'已发货', shippedAt:day(-4), partialShipment:true, trackingNumber:'1234567890', shipments:[{ id:'s1', trackingNumber:'1234567890', carrier:'DHL', status:'已发货', shippedAt:day(-4) }] }),
  // 只填了客户要求收到日期：15 天后不提醒；6 天后（提醒日 = 昨天）今天提醒。
  order('d15', { stage:'production', paidAmount:300, customerRequiredDate:day(15) }),
  order('d6', { stage:'production', paidAmount:300, customerRequiredDate:day(6) }),
  // 已发货的单有要求收到日期：不出第 3 种。
  order('d6s', { stage:'shipment', paidAmount:1000, logisticsStatus:'已发货', shippedAt:day(-1), customerRequiredDate:day(6), trackingNumber:'9876543210', shipments:[{ id:'s2', trackingNumber:'9876543210', carrier:'DHL', status:'已发货', shippedAt:day(-1) }] })
];

(async () => {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:960 }, timezoneId:TZ });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', '2026-11-07'); localStorage.setItem('trade-order-system-theme', 'light'); } catch (_) {} });
    const page = await context.newPage();
    await page.clock.setFixedTime(at(day(0)));
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
    await page.goto('http://127.0.0.1:47994/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('dashboard'));
    const all = () => page.evaluate(() => buildTaskItems().map(t => t.id).sort());
    const shown = () => page.evaluate(() => buildTaskItems({ perOrder:true }).map(t => t.id).sort());
    const edit = (id, patch) => page.evaluate(([id, patch]) => { Object.assign(state.orders.find(o => o.id === id), patch); render(); }, [id, patch]);
    const rowIds = () => page.locator('#taskList .task').evaluateAll(rows => rows.map(row => row.dataset.taskId).sort());

    // 全量：每种提醒都在（日历、「已处理」用它）；生产中不提醒跟进。
    assert.deepEqual(await all(), ['follow-m1', 'follow-r1', 'payment-b1', 'ready-r1', 'ship-d6', 'ship-m1', 'tracking-t1', 'urgent-m1'].sort());
    // 一单一条。
    assert.deepEqual(await shown(), ['payment-b1', 'ready-r1', 'ship-d6', 'ship-m1', 'tracking-t1'].sort());
    assert.deepEqual(await rowIds(), await shown());
    assert.equal(await page.locator('#statTasks').innerText(), '5');
    assert.equal(await page.locator('#taskInboxFilters [data-task-filter="all"] .c').innerText(), '5');
    assert.equal(await page.locator('#taskInboxFilters [data-task-filter="logistics"] .c').innerText(), '4', '物流页签收发货期限、可以发货、补运单号');
    assert.equal(await page.locator('#taskInboxFilters [data-task-filter="follow"] .c').innerText(), '0');
    assert.equal(await page.locator('#taskInboxFilters [data-task-filter="urgent"] .c').innerText(), '0');
    assert.equal(await page.locator('#statTasksSub').innerText(), '收款 1 · 发货期限 2 · 可以发货 1 · 补运单号 1');
    const m1Row = page.locator('#taskList .task[data-task-id="ship-m1"]');
    assert.match(await m1Row.locator('.task-sub').innerText(), / · 另有 加急、跟进$/);
    assert.match(await page.locator('#taskList .task[data-task-id="ready-r1"]').innerText(), /尾款已收齐，可以发货了[\s\S]*T-r1 · 待发货 · 另有 跟进/);
    assert.match(await page.locator('#taskList .task[data-task-id="tracking-t1"]').innerText(), /已发货，还没填运单号[\s\S]*T-t1 · 发货 4 天/);
    const d6 = await page.evaluate(() => buildTaskItems().find(t => t.id === 'ship-d6'));
    assert.equal(d6.reason, '客户要求 11-13 收到，该发货了');
    assert.equal(d6.doneKey, `ship-d6-req-${day(6)}`);
    assert.equal(d6.date, day(-1), '提醒日 = 要求收到日期往前 7 天');
    // 日历：提醒日过了、要求收到日期还没到，不写「逾期」；过了要求收到日期才写。
    const d6Cal = await page.evaluate(() => calendarEventsInRange('2026-11-07', '2026-11-07').find(e => e.taskId === 'ship-d6'));
    assert.equal(d6Cal.label, 'Client D6 发货期限');
    assert.equal(d6Cal.tone, 'repurchase');
    assert.deepEqual(await page.evaluate(() => ['ready', 'tracking', 'ship', 'logistics'].map(type => taskDetailTab({ type }))), ['logistics', 'logistics', 'logistics', 'logistics']);

    // 完成显示的那条：同一张单的下一条（加急）出来。
    await h.clearToasts(page);
    await page.locator('#taskList .task[data-task-id="ship-m1"] .task-tick').click();
    await page.waitForSelector('#taskList .task[data-task-id="urgent-m1"]');
    assert.equal(await page.locator('#taskList .task[data-task-id="ship-m1"]').count(), 0);
    assert.match(await page.locator('#taskList .task[data-task-id="urgent-m1"] .task-sub').innerText(), / · 另有 跟进$/);
    // 日历当天仍有这张单：过了期的交期（已处理的提醒不画，交期色块从订单取）。
    const calendar = await page.evaluate(() => calendarEventsInRange('2026-11-05', '2026-11-07').filter(e => e.orderId === 'm1').map(e => `${e.date}|${e.type}`));
    assert.ok(calendar.includes('2026-11-05|deadline'), `日历上没有 m1 的交期：${calendar}`);
    assert.ok(calendar.some(item => /2026-11-07\|(urgent|follow)/.test(item)), `日历上 m1 的提醒没了：${calendar}`);

    // 稍后：整张单今天的提醒都暂缓，不会点一下又冒出下一条。
    await h.clearToasts(page);
    await page.locator('#taskList .task[data-task-id="urgent-m1"] [data-task-action="snooze"]').click();
    await page.waitForFunction(() => !document.querySelector('#taskList .task[data-order-id="m1"]'));
    assert.deepEqual(await page.evaluate(() => Object.keys(state.snoozedTasks).sort()), ['follow-m1', 'ship-m1', 'urgent-m1']);
    assert.equal(await page.locator('#taskInboxFilters [data-task-filter="snoozed"] .c').innerText(), '1', '「稍后」页签里这张单也只算一条');
    await h.clickUndo(page, '已暂缓到明天');
    await page.waitForSelector('#taskList .task[data-task-id="urgent-m1"]');
    assert.deepEqual(await page.evaluate(() => Object.keys(state.snoozedTasks)), []);
    await page.locator('#taskList .task[data-task-id="urgent-m1"] [data-task-action="snooze"]').click();
    await page.waitForFunction(() => !document.querySelector('#taskList .task[data-order-id="m1"]'));
    await page.locator('#taskInboxFilters [data-task-filter="snoozed"]').click();
    await page.locator('#taskList .task[data-task-id="urgent-m1"] [data-task-action="unsnooze"]').click();
    await page.locator('#taskInboxFilters [data-task-filter="all"]').click();
    await page.waitForSelector('#taskList .task[data-task-id="urgent-m1"]');
    assert.deepEqual(await page.evaluate(() => Object.keys(state.snoozedTasks)), [], '取消稍后整单放回');

    // 补运单号：补了单号就消失；点完成后不再提醒。
    await edit('t1', { trackingNumber:'5555555555', shipments:[{ id:'s3', trackingNumber:'5555555555', carrier:'DHL', status:'已发货', shippedAt:day(-4) }] });
    assert.equal((await all()).includes('tracking-t1'), false, '补了运单号后不再提醒');
    await edit('t1', { trackingNumber:'', shipments:[] });
    assert.equal((await all()).includes('tracking-t1'), true);
    await page.locator('#taskList .task[data-task-id="tracking-t1"] .task-tick').click();
    await page.waitForFunction(() => !document.querySelector('#taskList .task[data-task-id="tracking-t1"]'));
    assert.deepEqual(await page.evaluate(() => state.doneTasks['tracking-t1']?.until), '', '补运单号点完成后不再提醒');
    await page.clock.setFixedTime(at(day(30)));
    assert.equal((await shown()).includes('tracking-t1'), false);
    await page.clock.setFixedTime(at(day(0)));

    // 可以发货：点完成后 3 天还在待发货再提醒。
    await page.locator('#taskList .task[data-task-id="ready-r1"] .task-tick').click();
    await page.waitForSelector('#taskList .task[data-task-id="follow-r1"]');
    assert.equal(await page.evaluate(() => state.doneTasks['ready-r1']?.until), day(3));

    // 要求收到日期：填了最晚发出日期就按最晚发出日期提醒（还远就不提醒）。
    await edit('d6', { latestShipDate:day(20) });
    assert.equal((await all()).includes('ship-d6'), false);
    await edit('d6', { latestShipDate:day(2) });
    assert.equal(await page.evaluate(() => buildTaskItems().find(t => t.id === 'ship-d6')?.reason), `最晚发出日期 ${day(2)}`);
    // 过了要求收到日期还没发。
    await edit('d15', { customerRequiredDate:day(-3) });
    assert.equal(await page.evaluate(() => buildTaskItems().find(t => t.id === 'ship-d15')?.reason), '已过客户要求收到日期 3 天（11-04）');
    assert.match((await page.evaluate(() => calendarEventsInRange('2026-11-07', '2026-11-07').find(e => e.taskId === 'ship-d15'))).label, /发货期限 · 逾期 3 天$/);

    // 一单一条选哪条：今天该处理的先于以后才到期的。待发货有欠款的加急单（要求收到日期在 20 天后）显示今天的收款，加急收在「另有」里。
    await edit('b1', { urgentOrder:true, customerRequiredDate:day(20), latestShipDate:day(15) });
    assert.equal((await all()).includes('urgent-b1'), true);
    assert.equal((await shown()).includes('urgent-b1'), false);
    assert.equal(await page.evaluate(() => buildTaskItems({ perOrder:true }).find(t => t.id === 'payment-b1')?.more), '另有 加急');

    // 删除订单时新类型的「已处理」标记也一起清掉。
    assert.deepEqual(await page.evaluate(() => orderDoneTaskKeys('t1')), ['tracking-t1']);

    assert.deepEqual(errors, [], errors.join('\n'));
    console.log('Tasks per order UI passed: one row per order with 另有 note, done shows the next one, 稍后 / 取消稍后 cover the whole order, calendar keeps deadlines, no follow-up in 生产中, 可以发货 / 补运单号 / required-date ship reminders.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
