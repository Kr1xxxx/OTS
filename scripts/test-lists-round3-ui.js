const assert = require('node:assert/strict');
const { launchBrowser, html } = require('./helpers/board-page');

// 页面第一轮（列表）里的三处，时间用 page.clock 固定在 2026-11-16 10:00 上海时间：
// 1. 工作台待办：第一行只有客户名，第二行事由开头；1440 宽默认布局下事由不被截，客户名太长时被截的是客户名。
// 2. 客户列表：第一格是客户名本身（联系人只在第二行出现一次），空着的项不写「未填写」「未设提醒」，没设复购的只写「更新 MM-DD」。
// 3. 日历日程：本月从今天排起，之前的收在「本月更早 · N 件」里，点开后顺序和以前一样；每行先写事、再写客户；
//    别的月份照旧从 1 号排；今天没有事也有今天那组。
const TZ = 'Asia/Shanghai';
const at = (date, time = '10:00') => new Date(`${date}T${time}:00+08:00`).getTime();
const LONG = 'Kora Hair Johannesburg Wholesale Imports and Beauty Supply Ltd';
const base = { currency:'USD', logisticsStatus:'未发货', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[] };
const fixture = () => ({
  orders:[
    { ...base, id:'a1', num:'K7001', client:'Aurora Hair Studio', orderType:'全款订单', amount:2000, paidAmount:2000, stage:'production', createdAt:'2026-11-03', orderMonth:'2026-11', updated:'2026-11-03 09:00', latestShipDate:'2026-11-19', urgentOrder:true },
    // 下单 27 天还没收尾款：今天的收款提醒，客户名很长。
    { ...base, id:'k1', num:'K7002', client:LONG, orderType:'定金订单', depositAmount:300, amount:4690, paidAmount:300, stage:'balance', createdAt:'2026-10-20', orderMonth:'2026-10', updated:'2026-11-14 09:00' },
    { ...base, id:'h1', num:'K7003', client:'Halo Extensions', orderType:'全款订单', amount:1610, paidAmount:1610, stage:'production', createdAt:'2026-11-10', orderMonth:'2026-11', updated:'2026-11-10 09:00', latestShipDate:'2026-11-22' },
    { ...base, id:'k2', num:'K7004', client:LONG, orderType:'全款订单', amount:900, paidAmount:900, stage:'production', createdAt:'2026-11-12', orderMonth:'2026-11', updated:'2026-11-12 09:00' }
  ],
  customers:{
    'Aurora Hair Studio':{ client:'Aurora Hair Studio', contact:'Mia Carter', email:'mia@example.com', country:'🇺🇸 美国 United States', address:'1200 Example Ave, Austin', repurchaseCycle:45, updated:'2026-11-05 09:00' },
    [LONG]:{ client:LONG, contact:'Thandi M.', country:'🇿🇦 南非 South Africa', updated:'2026-11-14 09:00' },
    'Halo Extensions':{ client:'Halo Extensions', updated:'2026-11-05 09:00' },
    'Plain Profile':{ client:'Plain Profile', createdAt:'2025-12-30', updated:'2025-12-30 09:00' },
    // 存下来的名字没整理过（小写、带 &amp; 和末尾区号）：列表里照别处的写法显示。
    'tom &amp; lily hair +86':{ client:'tom &amp; lily hair +86', contact:'lily stone', createdAt:'2025-12-30', updated:'2025-12-30 09:00' }
  }
});

async function openApp(browser, { width = 1440, height = 920 } = {}) {
  const context = await browser.newContext({ viewport:{ width, height }, timezoneId:TZ });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('trade-order-system-theme', 'light');
      localStorage.setItem('ots-greet-v1', '2026-11-16');
    } catch (_) {}
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(at('2026-11-16'));
  const saved = { current:{ app:'trade-order-system', data:{ doneTasks:{}, demoCleared:true, demoCustomersCleared:true, ...fixture() }, revision:0 } };
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
  await page.goto('http://127.0.0.1:47994/trade-order-system.html');
  await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  return { page, context, errors };
}

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, context, errors } = await openApp(browser);

    // ---- 1. 待办 ----
    await page.evaluate(() => setPage('dashboard'));
    await page.waitForSelector('#taskList .task');
    const tasks = await page.evaluate(() => [...document.querySelectorAll('#taskList .task')].map(row => {
      const item = buildTaskItems({ perOrder:true }).find(t => t.id === row.dataset.taskId);
      const title = row.querySelector('.task-title');
      const sub = row.querySelector('.task-sub');
      const reason = sub.querySelector('.task-reason');
      return {
        id:row.dataset.taskId, itemTitle:item.title, itemReason:item.reason,
        title:title.textContent, sub:sub.textContent, reason:reason?.textContent || '',
        reasonFits:reason.getBoundingClientRect().right <= sub.getBoundingClientRect().right + 0.5,
        titleCut:title.scrollWidth > title.clientWidth + 1,
        hover:row.querySelector('.task-main').title,
        reasonWeight:getComputedStyle(reason).fontWeight
      };
    }));
    assert.ok(tasks.length >= 2, `fixture should give at least two to-dos, got ${tasks.map(t => t.id)}`);
    for (const task of tasks) {
      assert.equal(task.title, task.itemTitle, `${task.id}: first line is only the client`);
      assert.equal(task.reason, task.itemReason, `${task.id}: the reason opens the second line`);
      assert.ok(task.sub.startsWith(task.itemReason), `${task.id}: second line starts with the reason, got ${task.sub}`);
      assert.ok(task.reasonFits, `${task.id}: the reason is cut at 1440 px`);
      assert.equal(task.reasonWeight, '500');
      assert.ok(task.hover.startsWith(`${task.itemTitle} · ${task.itemReason}`), `${task.id}: the full text is on hover, got ${task.hover}`);
    }
    const long = tasks.find(task => task.itemTitle.startsWith(LONG));
    assert.ok(long, 'the long-named customer has a to-do');
    assert.ok(long.titleCut, 'a client name too long for the row is the part that gets cut');
    assert.ok(long.reasonFits, 'the reason of the long-named row is still whole');

    // ---- 2. 客户列表 ----
    await page.evaluate(() => setPage('customers'));
    await page.waitForSelector('.customer-row[data-view-customer="Plain Profile"]');
    const list = await page.evaluate(() => {
      const rowOf = name => document.querySelector(`.customer-row[data-view-customer="${CSS.escape(name)}"]`);
      const text = name => rowOf(name).innerText.replace(/\s+/g, ' ').trim();
      const nameEl = name => rowOf(name).querySelector('.customer-name-line strong');
      return {
        all:document.getElementById('customerList').innerText,
        aurora:text('Aurora Hair Studio'), plain:text('Plain Profile'), halo:text('Halo Extensions'),
        auroraName:nameEl('Aurora Hair Studio').textContent,
        auroraNameFits:nameEl('Aurora Hair Studio').scrollWidth <= nameEl('Aurora Hair Studio').clientWidth,
        auroraLabel:rowOf('Aurora Hair Studio').getAttribute('aria-label'),
        plainUpdatedTitle:rowOf('Plain Profile').querySelector('.customer-updated')?.title || ''
      };
    });
    for (const placeholder of ['联系人未填写', '邮箱未填写', '国家未填写', '地址未填写', '产品未设', '收款未设', '暂无订单', '未设提醒']) {
      assert.ok(!list.all.includes(placeholder), `customer list still writes ${placeholder}`);
    }
    assert.equal(list.auroraName, 'Aurora Hair Studio', 'the first line is the customer name itself');
    assert.ok(list.auroraNameFits, 'the customer name is not cut at 1440 px');
    assert.equal(await page.evaluate(() => document.querySelector('.customer-row[data-view-customer^="tom "] .customer-name-line strong').textContent), 'Tom & Lily Hair', 'a stored name is shown tidied, as everywhere else, without the contact');
    assert.equal(list.auroraLabel, '查看客户 Aurora Hair Studio（Mia Carter）', 'the row label still names the contact');
    assert.equal(list.aurora.split('Mia Carter').length - 1, 1, `the contact appears once in the row: ${list.aurora}`);
    assert.match(list.aurora, /Mia Carter · mia@example\.com/);
    assert.match(list.aurora, /每 45 天复购/);
    assert.match(list.plain, /暂无成交 更新 2025-12-30$/, `a profile from another year shows the full date: ${list.plain}`);
    assert.equal(list.plainUpdatedTitle, '更新 2025-12-30 09:00');
    assert.match(list.halo, /更新 11-05$/, `this year's update shows MM-DD: ${list.halo}`);

    // ---- 3. 日历日程 ----
    await page.evaluate(() => setPage('calendar'));
    await page.waitForSelector('#calendarAgenda .agenda-today');
    const agenda = () => page.evaluate(() => {
      const box = document.getElementById('calendarAgenda');
      const toggle = box.querySelector('[data-agenda-earlier]');
      const firstGroup = box.querySelector(':scope > .agenda-group');
      const visibleRows = [...box.querySelectorAll('.agenda-row')].filter(row => row.offsetParent !== null);
      return {
        toggle:toggle ? { text:toggle.querySelector('span').textContent, expanded:toggle.getAttribute('aria-expanded') } : null,
        first:firstGroup?.querySelector('.agenda-date').textContent.trim() || '',
        todayMarks:box.querySelectorAll('.agenda-today-mark').length,
        // 订单号不占一列了，写在悬停提示里。
        rows:visibleRows.map(row => [row.querySelector('.agenda-what').textContent, row.querySelector('.agenda-who').textContent, state.orders.map(o => o.num).find(num => num && row.title.includes(num)) || '']),
        nums:box.querySelectorAll('.agenda-num').length,
        allRows:box.querySelectorAll('.agenda-row').length,
        toggleBeforeToday:Boolean(toggle && firstGroup && (toggle.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING))
      };
    });
    const expected = await page.evaluate(() => {
      const month = calendarEventsInRange('2026-11-01', '2026-11-30');
      const num = event => (event.orderId ? state.orders.find(o => o.id === event.orderId)?.num : '') || '';
      return {
        labelsSplit:month.every(event => event.label === `${event.who} ${event.what}`),
        before:month.filter(event => event.date < '2026-11-16').length,
        all:month.map(event => [`${event.badge || ''}${event.what}`, event.who, num(event)]),
        fromToday:month.filter(event => event.date >= '2026-11-16').map(event => [`${event.badge || ''}${event.what}`, event.who, num(event)])
      };
    });
    assert.ok(expected.labelsSplit, 'every event label is still「who what」');
    assert.ok(expected.before > 0, 'fixture has events before today');
    let now = await agenda();
    assert.deepEqual(now.toggle, { text:`本月更早 · ${expected.before} 件`, expanded:'false' });
    assert.ok(now.toggleBeforeToday, '「本月更早」 comes before the today group');
    assert.match(now.first, /^今天\s*11 月 16 日 · 周一$/, `the first group is today: ${now.first}`);
    assert.equal(now.todayMarks, 1);
    assert.deepEqual(now.rows, expected.fromToday, 'collapsed: today and later, what first');
    assert.equal(now.allRows, expected.all.length, 'every entry is still in the agenda');
    assert.equal(now.nums, 0, 'no order number column');
    // 长客户名：事完整，截的是客户名。
    const cut = await page.evaluate(name => {
      const row = [...document.querySelectorAll('#calendarAgenda .agenda-row')].find(r => r.querySelector('.agenda-who').textContent.startsWith(name.slice(0, 20)) && r.offsetParent !== null);
      const what = row.querySelector('.agenda-what');
      const who = row.querySelector('.agenda-who');
      return { whatWhole:what.scrollWidth <= what.clientWidth, whoCut:who.scrollWidth > who.clientWidth };
    }, LONG);
    assert.deepEqual(cut, { whatWhole:true, whoCut:true });

    await page.locator('#calendarAgenda [data-agenda-earlier]').click();
    now = await agenda();
    assert.equal(now.toggle.expanded, 'true');
    assert.deepEqual(now.rows, expected.all, 'expanded: the same order as the whole month');
    await page.evaluate(() => render());
    assert.equal((await agenda()).toggle.expanded, 'true', 'a redraw keeps it open');
    // 键盘：「本月更早」能用回车收起。
    await page.locator('#calendarAgenda [data-agenda-earlier]').focus();
    await page.keyboard.press('Enter');
    assert.equal((await agenda()).toggle.expanded, 'false');
    await page.keyboard.press('Enter');

    // 别的月份：没有「今天」，没有「本月更早」，照旧从 1 号排。
    await page.locator('#calendarNextBtn').click();
    now = await agenda();
    assert.equal(now.toggle, null);
    assert.equal(now.todayMarks, 0);
    const dec = await page.evaluate(() => calendarEventsInRange('2026-12-01', '2026-12-31').length);
    assert.equal(now.allRows, dec);
    await page.locator('#calendarTodayBtn').click();
    now = await agenda();
    assert.equal(now.toggle.expanded, 'false', 'back to this month: collapsed again');

    // 今天没有事：今天那组照样画，写「今天没有安排」。
    await page.evaluate(() => { state.orders = []; state.customers = { 'Plain Profile':state.customers['Plain Profile'] }; renderCalendarPage(); });
    const empty = await page.evaluate(() => {
      const group = document.querySelector('#calendarAgenda > .agenda-group');
      return { date:group.querySelector('.agenda-date').textContent.trim(), text:group.textContent.replace(/\s+/g, ' ').trim(), rows:group.querySelectorAll('.agenda-row').length };
    });
    assert.equal(empty.rows, 0, 'no events today in the emptied data');
    assert.match(empty.date, /^今天/);
    assert.match(empty.text, /今天没有安排$/);

    assert.deepEqual(errors, []);
    await context.close();
    console.log('Lists round 3 UI passed: to-do reason opens line two and is never cut, customer list without repeats or placeholders, agenda starts today with the earlier days folded and what before who.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
