const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// 待办的「完成」之后什么时候再提醒（时间用 page.clock 固定在 2026-11-07 10:00 上海时间，再往后拨）：
// - 跟进：假发 3 天、睫毛 7 天没动静就提醒；「已跟进」后按同一个周期再提醒，不是一张单只提醒一次。
// - 收款：「已催款」后 3 天还没收齐再提醒；改备注（最后更新时间变了）不会让它提前冒出来；收到一笔钱立刻按新欠款提醒。
// - 最晚发出日期 / 加急：点完成后改了日期就重新提醒，不再永久静音。
// - 旧数据里的 true 记录：对得上当前版本的换成新记录，对不上的死键清掉。
// - 已发货 / 已完成不提醒跟进；铃铛里不放任何待办。
const TZ = 'Asia/Shanghai';
const pad = n => String(n).padStart(2, '0');
const day = (offset, base = '2026-11-07') => { const [y, m, d] = base.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + offset)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
// 上海没有夏令时，固定 +08:00。
const at = (date, time = '10:00') => new Date(`${date}T${time}:00+08:00`).getTime();

(async () => {
  let browser;
  try { browser = await chromium.launch({ headless:true }); }
  catch (_) { browser = await chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium' }); }
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, timezoneId:TZ });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', '2026-11-07'); } catch (_) {} });
    const page = await context.newPage();
    await page.clock.setFixedTime(at(day(0)));
    const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
    const order = (id, productType, daysAgo, extra = {}) => ({ id, num:id, client:`客户${id}`, country:'', productType, amount:100, paidAmount:0, currency:'USD', orderType:'定金订单', stage:'quote', logisticsStatus:'未发货', createdAt:day(-daysAgo), orderMonth:day(-daysAgo).slice(0, 7), updated:`${day(-daysAgo)} 09:00`, logs:[], ...extra });
    const orders = [
      order('wig2', '假发', 2),
      order('wig3', '假发', 3),
      order('lash6', '睫毛', 6),
      order('lash7', '睫毛', 7),
      order('done30', '假发', 30, { stage:'done' }),
      order('ship30', '假发', 30, { stage:'shipment', trackingNumber:'', logisticsStatus:'已发货' }),
      order('due', '假发', 1, { stage:'balance', amount:500, paidAmount:200 }),
      order('late', '假发', 1, { stage:'production', amount:100, paidAmount:100, latestShipDate:day(2) }),
      order('rush', '假发', 1, { stage:'production', amount:100, paidAmount:100, urgentOrder:true, customerRequiredDate:day(5) }),
      // 旧数据：完成记录是 true。old 的键和当前版本对得上，stale 的对不上（订单后来又改过）。
      order('old', '假发', 1, { stage:'balance', amount:300, paidAmount:100 }),
      order('stale', '假发', 1, { stage:'balance', amount:300, paidAmount:100 })
    ];
    const legacyDone = {
      [`payment-old-100-${day(-1)} 09:00`]:true,
      'payment-stale-100-2026-01-01 08:00':true,
      'follow-wig2-2026-01-01 08:00':true,
      'ship-late':true
    };
    let stored = { app:'trade-order-system', data:{ orders, customers:{}, doneTasks:legacyDone, demoCleared:true, demoCustomersCleared:true }, revision:0 };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
      if (pathname === '/api/save') { stored = { ...route.request().postDataJSON().state, revision:stored.revision + 1 }; response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } }; }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const ids = type => page.evaluate(type => buildTaskItems().filter(t => t.type === type).map(t => t.id).sort(), type);
    const done = id => page.evaluate(id => handleTaskAction('done', { dataset:{ taskId:id } }), id);
    const travel = async date => { await page.clock.setFixedTime(at(date)); };
    const edit = (id, patch) => page.evaluate(([id, patch]) => { Object.assign(state.orders.find(o => o.id === id), patch); }, [id, patch]);

    // 0. 旧记录迁移：对得上的换成「今天处理过」，对不上的死键清掉；ship-<id> 换成带日期的键。
    const migrated = await page.evaluate(() => JSON.parse(JSON.stringify(state.doneTasks)));
    assert.deepEqual(Object.keys(migrated).sort(), ['payment-old-100', `ship-late-${day(2)}`], `旧的完成记录迁移不对：${JSON.stringify(migrated)}`);
    assert.equal(migrated['payment-old-100'].until, day(3), '迁移过来的收款记录按「今天已催款」算，3 天后再提醒');
    assert.equal(migrated[`ship-late-${day(2)}`], true);
    assert.deepEqual(await ids('payment'), ['payment-due', 'payment-stale'], '对不上当前版本的旧记录不再挡住提醒');

    // 1. 跟进：3 / 7 天规则；已发货 / 已完成不提醒。
    assert.deepEqual(await ids('follow'), ['follow-lash7', 'follow-wig3'], 'only orders idle for 3 (假发) / 7 (睫毛) days get a follow-up, never done / shipped ones');
    const task = await page.evaluate(() => buildTaskItems().find(t => t.id === 'follow-wig3'));
    assert.match(task.reason, /3 天没有新动态/);
    assert.equal(task.date, day(0), 'due date is the idle threshold, not today + another cycle');

    // 2. 「已跟进」后按周期（假发 3 天）再提醒，不是只提醒一次。
    await done('follow-wig3');
    assert.deepEqual(await ids('follow'), ['follow-lash7']);
    const record = await page.evaluate(() => state.doneTasks['follow-wig3']);
    assert.equal(record.until, day(3), '已跟进记下 3 天后再提醒');
    assert.match(record.at, new RegExp(`^${day(0)} 10:00`));
    await travel(day(2));
    assert.equal((await ids('follow')).includes('follow-wig3'), false, '还没到再提醒那天');
    await travel(day(3));
    assert.equal((await ids('follow')).includes('follow-wig3'), true, '3 天后订单还没动静，再提醒一次');
    // 订单有了新动态就重新计时。
    await edit('wig3', { updated:`${day(3)} 09:00` });
    assert.equal((await ids('follow')).includes('follow-wig3'), false, 'a freshly updated order is not nagged');
    await travel(day(35));
    assert.equal((await ids('follow')).includes('follow-wig3'), true, '35 天后仍然没动静：照样提醒');
    await travel(day(0));

    // 3. 收款：已催款后 3 天再提醒；改备注不会让它提前回来；收到一笔钱马上按新欠款提醒。
    await done('payment-due');
    assert.equal((await ids('payment')).includes('payment-due'), false);
    await edit('due', { note:'客户说下周付', updated:`${day(0)} 10:00` });
    assert.equal((await ids('payment')).includes('payment-due'), false, '改备注（最后更新时间变了）不应该让收款提醒冒出来');
    await travel(day(2));
    assert.equal((await ids('payment')).includes('payment-due'), false);
    await travel(day(3));
    assert.equal((await ids('payment')).includes('payment-due'), true, '3 天后还欠着：再提醒');
    await travel(day(30));
    assert.equal((await ids('payment')).includes('payment-due'), true, '欠款不会被永久静音');
    await travel(day(0));
    assert.equal((await ids('payment')).includes('payment-due'), false);
    await edit('due', { paidAmount:300 });
    assert.equal((await ids('payment')).includes('payment-due'), true, '收到一笔钱（已收变了）：按新的欠款马上提醒');
    const paymentTask = await page.evaluate(() => buildTaskItems().find(t => t.id === 'payment-due'));
    assert.equal(paymentTask.reason, '待收款 $200 USD');
    assert.match(paymentTask.detail, /下单 1 天/, '收款提醒显示账龄（按下单日）');

    // 4. 最晚发出日期：完成后改日期会重新提醒。
    await edit('late', { latestShipDate:day(1) });
    assert.deepEqual(await ids('ship'), ['ship-late'], '最晚发出日期改了：旧的完成记录不再挡住');
    await done('ship-late');
    assert.deepEqual(await ids('ship'), []);
    await travel(day(5));
    assert.deepEqual(await ids('ship'), [], '同一个日期点过完成：过期后也不再重复提醒');
    await travel(day(0));
    await edit('late', { latestShipDate:day(31) });
    assert.deepEqual(await ids('ship'), [], '新日期还没进 3 天窗口');
    await travel(day(29));
    assert.deepEqual(await ids('ship'), ['ship-late'], '新日期到了 3 天窗口：重新提醒');
    await travel(day(33));
    const overdue = await page.evaluate(() => buildTaskItems().find(t => t.id === 'ship-late'));
    assert.equal(overdue.reason, `超过最晚发出日期 2 天（${day(31)}）`);
    await travel(day(0));

    // 5. 加急：完成后客户改了要求日期就重新提醒。
    assert.deepEqual(await ids('urgent'), ['urgent-rush']);
    await done('urgent-rush');
    assert.deepEqual(await ids('urgent'), []);
    await edit('rush', { customerRequiredDate:day(3) });
    assert.deepEqual(await ids('urgent'), ['urgent-rush'], '要求日期改了：重新提醒');

    // 6. 重新加载：记录跟数据一起保存，过期记录在加载时清掉。
    await page.evaluate(() => window.flushPendingSave?.());
    await travel(day(10));
    await page.reload();
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const afterReload = await page.evaluate(() => Object.keys(state.doneTasks).sort());
    assert.equal(afterReload.includes('follow-wig3'), false, '过了再提醒日期的记录加载时清掉，doneTasks 不再只增不减');
    assert.equal(afterReload.includes(`ship-late-${day(1)}`), true, '带日期的完成记录保留');

    // 7. 待办列表里有跟进；铃铛里不放任何待办。
    await page.evaluate(() => render());
    assert.ok(await page.locator('#taskList [data-task-id="follow-lash7"]').count(), 'follow-up missing from the task list');
    const notif = await page.evaluate(() => uiNotifItems().filter(i => i.id.startsWith('task-')).map(i => i.id));
    assert.deepEqual(notif, [], `notifications must not carry tasks, got ${notif.join(',')}`);

    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Follow reminder passed: 3/7-day idle rule, 已跟进 / 已催款 remind again after their cycle, notes do not revive payment reminders, date changes revive ship / urgent reminders, legacy marks migrate, notifications carry no tasks.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
