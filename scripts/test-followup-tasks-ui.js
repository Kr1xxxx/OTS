const assert = require('node:assert/strict');
const { launchBrowser, h, html } = require('./helpers/board-page');

// 工作台「待办」处理提醒的整条线，全部用真实鼠标（时间用 page.clock 固定在 2026-11-07 10:00 上海时间）：
// 1. 「今日待办」卡、卡片副标题、待办列表三处同一个数；日期在以后的放在「即将到期」下面，「另有 N 件即将到期」。
// 2. 「已催款 / 已跟进 / 完成」是带文字的按钮，浅色、深色下对背景都超过 3:1。
// 3. 点「已催款」：行消失，弹 6 秒撤销提示；订单记录里留一条，订单的「最近更新」不变；撤销后提醒和记录都回去。
//    「已处理」页签里能看到，「恢复提醒」放回待办。
// 4. 「稍后」：有撤销提示，刷新后还在（跟数据一起保存），「稍后」页签里能取消。
// 5. 待收款卡不再把报价单过发货期限叫「逾期」；金额页按下单日算「下单超 30 天未收」，复制催款不会把它清零。
//    复制催款后收款提醒记成「已催款」；发给客户的金额补两位小数（€700.50）。
// 6. 超过 14 条：底部写明「还有 N 条」，点开全部显示。
// 7. 日历：跟进有自己的颜色，过期的跟进放在今天的格子里；最晚发出日期是「交期」色。
// 8. 客户页「待跟进」和待办里的复购是同一批人；客户动态里未处理的待办不再叫「跟进记录」。
// 9. App 开着跨过午夜：待办、「今日待办」自己刷新，昨天「稍后」的提醒回来，补一次问候。
const TZ = 'Asia/Shanghai';
const pad = n => String(n).padStart(2, '0');
const day = (offset, base = '2026-11-07') => { const [y, m, d] = base.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + offset)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const at = (date, time = '10:00') => new Date(`${date}T${time}:00+08:00`).getTime();
const base = { currency:'USD', logisticsStatus:'未发货', orderMonth:'2026-11', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[], orderType:'定金订单', depositAmount:300 };
const fixture = () => ({
  orders:[
    // 尾款单，下单 40 天、10 天没动：收款提醒 + 跟进提醒；金额页算「下单超 30 天未收」。
    { ...base, id:'b1', num:'K9001', client:'Alpha Hair', amount:1000, paidAmount:300, stage:'balance', createdAt:day(-40), orderMonth:'2026-09', updated:`${day(-10)} 09:00` },
    // 欧元尾款单，金额带小数。
    { ...base, id:'e1', num:'K9002', client:'Euro Wigs', amount:1000.5, paidAmount:300, currency:'EUR', stage:'balance', createdAt:day(-5), updated:`${day(-1)} 09:00` },
    // 报价单，过了最晚发出日期：不能算成「待收款逾期」。
    { ...base, id:'q3', num:'K9003', client:'Quote Co', amount:1000, paidAmount:0, stage:'quote', createdAt:day(-1), updated:`${day(-1)} 09:00`, latestShipDate:day(-2) },
    // 生产中，最晚发出日期在后天：「即将到期」。
    { ...base, id:'l1', num:'K9004', client:'Ship Soon', amount:500, paidAmount:500, orderType:'全款订单', stage:'production', createdAt:day(-1), updated:`${day(-1)} 09:00`, latestShipDate:day(2) },
    // 报价单 5 天没动：跟进提醒，应在 11-05 跟进（已过 2 天）。
    { ...base, id:'f1', num:'K9005', client:'Quiet Lead', amount:800, paidAmount:0, stage:'quote', createdAt:day(-5), updated:`${day(-5)} 09:00` },
    // 复购：Plain Due 40 天前发货，周期 30 天 → 提醒；Busy Buyer 也是，但还有一张生产中的单 → 不提醒复购；
    // Repeat Buyer 以前推迟到 11-02，10 天前又发了一单 → 周期从新单算，不提醒；Stopped 周期是「不提醒」，旧的推迟日期不算。
    { ...base, id:'p1', num:'K9006', client:'Plain Due', amount:300, paidAmount:300, orderType:'全款订单', stage:'done', createdAt:day(-50), shippedAt:day(-40), updated:`${day(-30)} 09:00` },
    { ...base, id:'bb1', num:'K9007', client:'Busy Buyer', amount:300, paidAmount:300, orderType:'全款订单', stage:'done', createdAt:day(-50), shippedAt:day(-40), updated:`${day(-30)} 09:00` },
    { ...base, id:'bb2', num:'K9008', client:'Busy Buyer', amount:300, paidAmount:300, orderType:'全款订单', stage:'production', createdAt:day(-1), updated:`${day(0)} 08:00` },
    { ...base, id:'r1', num:'K9009', client:'Repeat Buyer', amount:300, paidAmount:300, orderType:'全款订单', stage:'done', createdAt:day(-20), shippedAt:day(-10), updated:`${day(-10)} 09:00` },
    { ...base, id:'s1', num:'K9010', client:'Stopped', amount:300, paidAmount:300, orderType:'全款订单', stage:'done', createdAt:day(-80), shippedAt:day(-70), updated:`${day(-70)} 09:00` }
  ],
  customers:{
    'Alpha Hair':{ client:'Alpha Hair', contact:'Ann' },
    'Plain Due':{ client:'Plain Due', repurchaseCycle:30 },
    'Busy Buyer':{ client:'Busy Buyer', repurchaseCycle:30 },
    'Repeat Buyer':{ client:'Repeat Buyer', repurchaseCycle:30, nextFollow:day(-5) },
    'Stopped':{ client:'Stopped', repurchaseCycle:'', nextFollow:day(0) }
  }
});

async function openApp(browser, { time = at(day(0)), install = false, data = fixture(), store = null } = {}) {
  const context = await browser.newContext({ viewport:{ width:1440, height:960 }, timezoneId:TZ });
  const greetDay = new Date(time + 8 * 3600 * 1000).toISOString().slice(0, 10);
  await context.addInitScript(({ greetDay }) => {
    try {
      if (!sessionStorage.getItem('test-init')) {
        sessionStorage.setItem('test-init', '1');
        localStorage.setItem('trade-order-system-theme', 'light');
        localStorage.setItem('ots-greet-v1', greetDay);
      }
    } catch (_) {}
    window.__copied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:text => { window.__copied = text; return Promise.resolve(); } } });
  }, { greetDay });
  const page = await context.newPage();
  if (install) await page.clock.install({ time });
  else await page.clock.setFixedTime(time);
  const saved = store || { current:{ app:'trade-order-system', data:{ doneTasks:{}, demoCleared:true, demoCustomersCleared:true, ...data }, revision:0 } };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    let response = { ok:true };
    if (pathname === '/api/data') response = saved.current;
    if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:saved.current.data.orders.length }, backups:{ sqliteCount:0 } };
    if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
    if (pathname === '/api/track') response = { ok:false, status:'待 API 查询', message:'offline' };
    if (pathname === '/api/save') {
      saved.current = { ...route.request().postDataJSON().state, revision:saved.current.revision + 1 };
      response = { ok:true, revision:saved.current.revision, backup:{ ok:true, skipped:true } };
    }
    return route.fulfill({ json:response });
  });
  await page.goto('http://127.0.0.1:47992/trade-order-system.html');
  if (install) {
    for (let i = 0; i < 60 && !(await page.evaluate(() => window.pendingSaveStatus?.().loaded)); i += 1) await page.clock.runFor(250);
  } else await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  return { page, context, store:saved, errors };
}
const rowIds = page => page.locator('#taskList .task').evaluateAll(rows => rows.map(row => row.dataset.taskId));
const clickIn = async (page, selector) => {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  await target.click();
};
// 浅色 / 深色下，按钮描边对它所在背景的对比度。
const contrast = page => page.evaluate(() => {
  const rgb = color => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const btn = document.querySelector('#taskList .task-tick');
  let el = btn.parentElement;
  let bg = 'rgb(255, 255, 255)';
  while (el) {
    const value = getComputedStyle(el).backgroundColor;
    if (value && !/rgba?\(0, 0, 0, 0\)|transparent/.test(value)) { bg = value; break; }
    el = el.parentElement;
  }
  const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [a, b] = [lum(rgb(getComputedStyle(btn).borderTopColor)), lum(rgb(bg))];
  return { ratio:(Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), text:btn.textContent.trim() };
});

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors } = await openApp(browser);
    await page.evaluate(() => setPage('dashboard'));

    // 1. 三处同一个数；最晚发出日期在后天的那条放在「即将到期」下面。
    const today = await page.evaluate(() => ({ today:todayTaskItems().map(t => t.id), all:buildTaskItems().map(t => t.id) }));
    assert.deepEqual(today.today.slice().sort(), ['follow-b1', 'follow-f1', 'payment-b1', 'payment-e1', 'repurchase-Plain Due', 'ship-q3'].sort(), `今天的待办不对：${today.today}`);
    assert.deepEqual(today.all.filter(id => !today.today.includes(id)), ['ship-l1']);
    assert.equal(await page.locator('#statTasks').innerText(), '6');
    const sub = await page.locator('#statTasksSub').innerText();
    assert.equal(sub, '收款 2 · 跟进 2 · 发货期限 1 · 复购 1 · 另有 1 件即将到期');
    const subTotal = (sub.match(/(收款|跟进|加急|发货期限|物流异常|复购) (\d+)/g) || []).reduce((n, part) => n + Number(part.split(' ')[1]), 0);
    assert.equal(subTotal, 6, '副标题各类加起来等于卡片上的数');
    assert.equal(await page.locator('#taskInboxFilters [data-task-filter="all"] .c').innerText(), '7');
    // 报价单过了最晚发出日期：是「超过最晚发出日期」的发货提醒，不是收款逾期。
    assert.match(await page.locator('#taskList .task[data-task-id="ship-q3"]').innerText(), /超过最晚发出日期 2 天（2026-11-05）/);
    const rows = await rowIds(page);
    assert.equal(rows.at(-1), 'ship-l1', '将来的待办排在最后');
    assert.equal(await page.locator('#taskList .task-group-head').innerText(), '即将到期 · 1');
    const shipRow = page.locator('#taskList .task[data-task-id="ship-l1"]');
    assert.match(await shipRow.innerText(), /最晚发出日期 2026-11-09/);
    assert.equal(await shipRow.locator('.task-icon.tone-orange').count(), 1, '最晚发出日期不再用物流异常的红色警告图标');
    // 行标题用客户显示名；收款行写账龄，不再重复金额。
    const payRow = page.locator('#taskList .task[data-task-id="payment-b1"]');
    assert.match(await payRow.locator('.task-title').innerText(), /^Alpha Hair（Ann）/);
    assert.match(await payRow.locator('.task-sub').innerText(), /K9001 · 尾款 · 下单 40 天/);
    assert.equal(rows.indexOf('payment-b1') < rows.indexOf('payment-e1'), true, '收款按账龄排：欠得久的在前');

    // 2. 带文字的完成按钮，浅色 / 深色都 ≥ 3:1。
    assert.deepEqual(await payRow.locator('.task-tick').innerText(), '已催款');
    assert.deepEqual(await page.locator('#taskList .task[data-task-id="follow-f1"] .task-tick').innerText(), '已跟进');
    let c = await contrast(page);
    assert.ok(c.ratio >= 3, `浅色下完成按钮对比度 ${c.ratio.toFixed(2)} < 3`);
    await clickIn(page, '#themeBtn');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    c = await contrast(page);
    assert.ok(c.ratio >= 3, `深色下完成按钮对比度 ${c.ratio.toFixed(2)} < 3`);
    await clickIn(page, '#themeBtn');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');

    // 3. 「已催款」：行消失、撤销提示、订单记录留痕、「最近更新」不变；撤销全部还原。
    const before = await h.order(page, 'b1');
    await h.clearToasts(page);
    await clickIn(page, '#taskList .task[data-task-id="payment-b1"] .task-tick');
    await page.waitForFunction(() => !document.querySelector('#taskList .task[data-task-id="payment-b1"]'));
    await h.waitToast(page, '已催款：Alpha Hair（Ann） 待收款 $700 USD');
    const toastText = (await h.toasts(page)).find(text => text.includes('已催款：'));
    assert.match(toastText, /11-10 还没解决会再提醒/);
    assert.match(toastText, /撤销/);
    let after = await h.order(page, 'b1');
    assert.equal(after.updated, before.updated, '处理待办不改订单的「最近更新」，看板顺序不变');
    assert.match(after.logs[0].text, /^待办已处理：收款提醒（已催款）· 待收款 \$700 USD，11-10 还没解决会再提醒/);
    assert.deepEqual(await page.evaluate(() => state.doneTasks['payment-b1-300']?.until), day(3));
    assert.equal(await page.locator('#statTasks').innerText(), '5');
    await h.clickUndo(page, '已催款：Alpha Hair');
    await page.waitForSelector('#taskList .task[data-task-id="payment-b1"]');
    after = await h.order(page, 'b1');
    assert.equal(after.logs.length, before.logs.length, '撤销后删掉刚写的订单记录');
    assert.equal(await page.evaluate(() => 'payment-b1-300' in state.doneTasks), false);
    assert.equal(await page.locator('#statTasks').innerText(), '6');

    // 「已处理」页签：再点一次，到「已处理」里恢复。
    await clickIn(page, '#taskList .task[data-task-id="payment-b1"] .task-tick');
    await page.waitForFunction(() => !document.querySelector('#taskList .task[data-task-id="payment-b1"]'));
    await clickIn(page, '#taskInboxFilters [data-task-filter="done"]');
    await page.waitForSelector('#taskList .task[data-task-id="payment-b1"] [data-task-action="undone"]');
    assert.match(await page.locator('#taskList .task[data-task-id="payment-b1"] .task-sub').innerText(), /11-07 10:00 处理 · 11-10 还没解决会再提醒/);
    await clickIn(page, '#taskList .task[data-task-id="payment-b1"] [data-task-action="undone"]');
    await page.waitForFunction(() => !document.querySelector('#taskList .task[data-task-id="payment-b1"]'));
    await h.waitToast(page, '已恢复提醒：Alpha Hair（Ann） 待收款 $700 USD');
    await clickIn(page, '#taskInboxFilters [data-task-filter="all"]');
    await page.waitForSelector('#taskList .task[data-task-id="payment-b1"]');
    assert.match((await h.order(page, 'b1')).logs[0].text, /^待办恢复提醒：收款提醒/);

    // 4. 「稍后」：撤销提示；刷新后还在；「稍后」页签里能取消。
    await h.clearToasts(page);
    await clickIn(page, '#taskList .task[data-task-id="follow-f1"] [data-task-action="snooze"]');
    await page.waitForFunction(() => !document.querySelector('#taskList .task[data-task-id="follow-f1"]'));
    await h.waitToast(page, '已暂缓到明天：Quiet Lead');
    await h.clickUndo(page, '已暂缓到明天：Quiet Lead');
    await page.waitForSelector('#taskList .task[data-task-id="follow-f1"]');
    await clickIn(page, '#taskList .task[data-task-id="follow-f1"] [data-task-action="snooze"]');
    await page.waitForFunction(() => !document.querySelector('#taskList .task[data-task-id="follow-f1"]'));
    await page.evaluate(() => window.flushPendingSave?.());
    assert.deepEqual(store.current.data.snoozedTasks, { 'follow-f1':day(0) }, '「稍后」跟数据一起保存');
    await page.reload();
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('dashboard'));
    assert.equal(await page.locator('#taskList .task[data-task-id="follow-f1"]').count(), 0, '刷新后「稍后」还在');
    assert.equal(await page.locator('#taskInboxFilters [data-task-filter="snoozed"] .c').innerText(), '1');
    await clickIn(page, '#taskInboxFilters [data-task-filter="snoozed"]');
    await clickIn(page, '#taskList .task[data-task-id="follow-f1"] [data-task-action="unsnooze"]');
    await page.waitForFunction(() => !document.querySelector('#taskList .task[data-task-id="follow-f1"]'));
    await clickIn(page, '#taskInboxFilters [data-task-filter="all"]');
    await page.waitForSelector('#taskList .task[data-task-id="follow-f1"]');

    // 5. 待收款卡的副标题：不再有「逾期」，报价单过发货期限不算（「待收 N 笔」是否含报价单是待定口径，照旧）；金额页「下单超 30 天未收」按下单日算。
    const paymentSub = await page.locator('#statPaymentSub').innerText();
    assert.equal(paymentSub, '历史累计 · 待收 4 笔 · 下单超 30 天未收清 1', `待收款副标题：${paymentSub}`);
    await clickIn(page, '.nav-item[data-page="amount"]');
    await page.waitForFunction(() => document.getElementById('page-amount')?.classList.contains('active'));
    const reportLabel = await page.locator('#reportOverdue').evaluate(el => el.closest('.report-stat').innerText.replace(/\s+/g, ' '));
    assert.match(reportLabel, /下单超 30 天未收/);
    assert.doesNotMatch(reportLabel, /逾期/);
    // B1 是 9 月的单：时间范围选「近 6 个月」。
    await page.locator('#chartRange').selectOption('6');
    await page.waitForFunction(() => document.getElementById('reportOverdue').textContent === '$700');
    // 复制催款（真实点击菜单）：金额页不清零，收款提醒记成已催款。
    await clickIn(page, '.nav-item[data-page="dashboard"]');
    await clickIn(page, '#taskList .task[data-task-id="payment-b1"] [data-task-action="open"]');
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    await clickIn(page, '#detailCopyTextBtn');
    await clickIn(page, '#detailCopyMenu [data-copy-text="dunning"]');
    await page.waitForFunction(() => window.__copied);
    assert.match(await page.evaluate(() => window.__copied), /\$700 USD/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    assert.equal(await page.locator('#taskList .task[data-task-id="payment-b1"]').count(), 0, '复制催款 = 催过一次款，收款提醒记成已催款');
    assert.equal(await page.evaluate(() => state.doneTasks['payment-b1-300']?.until), day(3));
    await clickIn(page, '.nav-item[data-page="amount"]');
    await page.waitForFunction(() => document.getElementById('page-amount')?.classList.contains('active'));
    assert.equal(await page.locator('#reportOverdue').innerText(), '$700', '复制催款改了最后更新时间，但「下单超 30 天未收」不受影响');
    // 欧元单：发给客户的金额补两位小数。
    await clickIn(page, '.nav-item[data-page="dashboard"]');
    await clickIn(page, '#taskList .task[data-task-id="payment-e1"] [data-task-action="open"]');
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    await page.evaluate(() => { window.__copied = ''; });
    await clickIn(page, '#detailCopyTextBtn');
    await clickIn(page, '#detailCopyMenu [data-copy-text="dunning"]');
    await page.waitForFunction(() => window.__copied);
    const dunning = await page.evaluate(() => window.__copied);
    assert.match(dunning, /€700\.50 EUR/, dunning);
    assert.match(dunning, /€1,000\.50 EUR/, dunning);
    assert.doesNotMatch(dunning, /€700\.5 EUR/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    // 经营分析「超过最晚发出日期」和待办用同一个口径（报价单 Q3 过了期限、还没发货）。
    assert.deepEqual(await page.evaluate(() => state.orders.filter(o => orderPastShipDeadline(o)).map(o => o.id)), ['q3']);

    // 6. 超过 14 条：写明还有几条，点开全部显示。
    await page.evaluate(day => {
      for (let i = 1; i <= 15; i += 1) state.orders.push({ ...state.orders.find(o => o.id === 'e1'), id:`cap${i}`, num:`K8${String(i).padStart(3, '0')}`, client:`Buyer ${String(i).padStart(2, '0')}`, currency:'USD', amount:1000, paidAmount:300, createdAt:day, updated:`${day} 09:00`, logs:[] });
      render();
    }, day(-2));
    const total = Number(await page.locator('#taskInboxFilters [data-task-filter="all"] .c').innerText());
    assert.equal(await page.locator('#taskList .task').count(), 14);
    assert.equal(await page.locator('#taskList .task-more').innerText(), `还有 ${total - 14} 条 · 全部显示`);
    await clickIn(page, '#taskList .task-more');
    await page.waitForFunction(n => document.querySelectorAll('#taskList .task').length === n, total);
    assert.equal(await page.locator('#taskList .task-more').innerText(), '收起');
    await clickIn(page, '#taskList .task-more');
    await page.waitForFunction(() => document.querySelectorAll('#taskList .task').length === 14);
    await page.evaluate(() => { state.orders = state.orders.filter(o => !o.id.startsWith('cap')); render(); });

    // 7. 日历：跟进有自己的颜色；过期的跟进放在今天的格子里；最晚发出日期是「交期」色。
    await clickIn(page, '.nav-item[data-page="calendar"]');
    await page.waitForFunction(() => document.getElementById('page-calendar')?.classList.contains('active'));
    const cal = await page.evaluate(() => {
      const cell = date => document.querySelector(`.calendar-day[data-calendar-date="${date}"]`) || [...document.querySelectorAll('.calendar-day')].find(el => el.querySelector(`[data-calendar-date="${date}"]`));
      const events = date => [...(cell(date)?.querySelectorAll('.calendar-event') || [])].map(el => `${el.className.replace('calendar-event', '').trim()}|${el.textContent.trim()}`);
      return { today:events('2026-11-07'), ship:events('2026-11-09'), legend:document.querySelector('.calendar-legend').textContent };
    });
    assert.ok(cal.today.some(item => item.startsWith('follow|跟进 Quiet Lead')), `今天的格子里没有过期的跟进：${cal.today}`);
    assert.ok(cal.ship.some(item => item.startsWith('repurchase|发货期限 Ship Soon')), `最晚发出日期应是交期色：${cal.ship}`);
    assert.match(cal.legend, /跟进/);

    // 8. 客户页「待跟进」= 待办里的复购（只有 Plain Due）；客户动态里未处理的待办不叫「跟进记录」。
    await clickIn(page, '.nav-item[data-page="customers"]');
    await page.waitForFunction(() => document.getElementById('page-customers')?.classList.contains('active'));
    const followups = await page.locator('#customerWorkspaceSummary .customer-summary-item', { hasText:'待跟进' }).locator('strong').innerText();
    assert.equal(followups, '1');
    assert.deepEqual(await page.evaluate(() => buildTaskItems().filter(t => t.type === 'repurchase').map(t => t.client)), ['Plain Due']);
    assert.deepEqual(await page.evaluate(() => ['Plain Due', 'Busy Buyer', 'Repeat Buyer', 'Stopped'].map(nextRepurchaseDate)), [day(-10), '', day(20), '']);
    const timeline = await page.evaluate(() => customerRoadmapEvents('Quiet Lead').map(e => e.title));
    assert.ok(timeline.includes('待办（未处理）：跟进'), timeline.join(','));
    assert.equal(timeline.includes('跟进记录'), false);

    assert.deepEqual(errors, [], errors.join('\n'));

    // 9. 跨午夜：11-07 23:59 打开，点「稍后」，时钟走过 00:00 —— 不点任何东西，待办自己刷新。
    const night = await openApp(browser, { time:at(day(0), '23:59'), install:true });
    await night.page.evaluate(() => setPage('dashboard'));
    assert.equal(await night.page.locator('#statTasks').innerText(), '6');
    await night.page.locator('#taskList .task[data-task-id="payment-e1"] [data-task-action="snooze"]').click();
    assert.equal(await night.page.locator('#taskList .task[data-task-id="payment-e1"]').count(), 0);
    assert.equal(await night.page.locator('#statTasks').innerText(), '5');
    await night.page.evaluate(() => document.querySelectorAll('#toast .toast-item').forEach(el => el.remove()));
    // 一秒一秒地走，直到待办按新的一天画过（最多 3 分钟；每分钟检查一次日期），马上看问候（它 4 秒后会消失）。
    for (let i = 0; i < 180 && await night.page.evaluate(() => taskListRenderedDay) !== day(1); i += 1) await night.page.clock.runFor(1000);
    assert.equal(await night.page.evaluate(() => nowText().slice(0, 10)), day(1));
    // 11-08：昨天暂缓的收款回来；Ship Soon 的最晚发出日期（11-09）还在 3 天窗口里但不是今天。
    assert.equal(await night.page.locator('#taskList .task[data-task-id="payment-e1"]').count(), 1, '过了午夜，昨天「稍后」的提醒自己回来');
    const nightCount = await night.page.evaluate(() => todayTaskItems().length);
    assert.equal(await night.page.locator('#statTasks').innerText(), String(nightCount));
    const greet = await night.page.evaluate(() => [...document.querySelectorAll('#toast .toast-item')].map(el => el.textContent.replace(/\s+/g, ' ')).join(' | '));
    assert.match(greet, new RegExp(`今天有 ${nightCount} 件待办`), `跨天后补一次问候：${greet}`);
    assert.deepEqual(night.errors, [], night.errors.join('\n'));
    await night.context.close();

    console.log('Follow-up tasks UI passed: one today count across card / subtitle / list, labelled done buttons with 3:1 contrast, 已催款 with undo + order log + 已处理 restore, persisted 稍后 with undo, honest 逾期 wording, dunning marks the reminder and pads cents, 14-row cap with expand, calendar follow tone, customer 待跟进 = repurchase tasks, midnight rollover refresh.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
