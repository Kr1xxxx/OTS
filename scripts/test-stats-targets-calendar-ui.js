// 工作台统计卡、业绩目标、金额页区间、日历：真实 mac-app/server.js（临时数据目录）+ 真实鼠标键盘。
// 时间用 page.clock 固定在 2026-11-07 10:00（上海时间）。
// 1. 读库还没回来：统计卡显示「—」和「正在读取数据…」，不出现示例数字；读库失败写「没读到数据库」。
// 2. 点工作台目标卡：跳到目标页、停在同一个月、焦点在目标输入框。
// 3. 目标输入：「5万」= $50,000（比平时大 10 倍先用应用内确认框问一次）；「-500」「空」不保存、红字说明；
//    99.6% 显示 99%，刚好完成写「刚好完成目标。」；输入框里没保存的数不会被重画盖掉；换月份时先问。
// 4. 金额页：0 元单不算单数并写明；「近 6 个月」= 到本月为止连续 6 个月，区间写成「2026年6月–11月」。
// 5. 日历：将来的最晚发出日期上日历；已发货的生产单不再出发货提醒；只有档案的新客户上日历；
//    键盘：方向键移动、回车打开当天抽屉；「+N 更多」打开的抽屉里件数和格子上的数一致；点色块打开订单。
// 6. App 开着跨过月底：日历自己跟到新的一个月。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');

const root = path.resolve(__dirname, '..');
const TZ = 'Asia/Shanghai';
const at = (date, time = '10:00') => new Date(`${date}T${time}:00+08:00`).getTime();
const base = { currency:'USD', logisticsStatus:'未发货', orderMonth:'2026-11', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[], orderType:'定金订单', depositAmount:300 };
const fixture = {
  orders:[
    { ...base, id:'a1', num:'K7001', client:'Alpha Hair', amount:1000, paidAmount:300, stage:'balance', createdAt:'2026-11-02', updated:'2026-11-06 09:00', customerRequiredDate:'2026-11-12' },
    { ...base, id:'b1', num:'K7002', client:'Beta Wigs', amount:2000, paidAmount:2000, orderType:'全款订单', stage:'production', createdAt:'2026-11-03', updated:'2026-11-06 09:00', latestShipDate:'2026-11-20', customerRequiredDate:'2026-11-12' },
    // 0 元单（免费补发）：不算单数。
    { ...base, id:'z1', num:'K7003', client:'Zero Sample', amount:0, paidAmount:0, orderType:'全款订单', stage:'production', createdAt:'2026-11-04', updated:'2026-11-06 09:00', latestShipDate:'2026-11-12', customerRequiredDate:'2026-11-12' },
    // 生产中但已经发了货：不再提醒「临近发货期限」，日历上也没有发货期限。
    { ...base, id:'s1', num:'K7004', client:'Shipped Late', amount:500, paidAmount:500, orderType:'全款订单', stage:'production', orderMonth:'2026-10', createdAt:'2026-10-10', updated:'2026-11-06 09:00', latestShipDate:'2026-11-08', shippedAt:'2026-11-01' },
    // 上月的报价单，客户要求 11-12 到货：让 11-12 这天超过 3 件。
    { ...base, id:'d1', num:'K7006', client:'Delta Quote', amount:800, paidAmount:0, stage:'quote', orderMonth:'2026-10', createdAt:'2026-10-20', updated:'2026-11-06 09:00', customerRequiredDate:'2026-11-12' },
    { ...base, id:'o1', num:'K7005', client:'Old Buyer', amount:1500, paidAmount:1500, orderType:'全款订单', stage:'done', orderMonth:'2026-10', createdAt:'2026-10-05', updated:'2026-10-20 09:00', shippedAt:'2026-10-15' }
  ],
  customers:{
    'Alpha Hair':{ client:'Alpha Hair', createdAt:'2026-10-01 09:00' },
    'New Lead':{ client:'New Lead', createdAt:'2026-11-06 09:00' }
  }
};

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-stats-targets-'));
  fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:1, data:{ doneTasks:{}, demoCleared:true, demoCustomersCleared:true, ...fixture } }));
  const port = await freePort();
  const token = 'stats-targets-calendar-test-token';
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', DHL_API_KEY:'', FEDEX_CLIENT_ID:'', FEDEX_CLIENT_SECRET:'' };
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${url}/api/health`)).ok; } catch (_) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'server starts');
    browser = await launchBrowser();

    // 打开页面。dataRoute：拦住 /api/data（延迟或失败），其余请求都走真实服务器。
    const open = async ({ time = at('2026-11-07'), install = false, dataRoute = null } = {}) => {
      const context = await browser.newContext({ viewport:{ width:1440, height:960 }, timezoneId:TZ });
      await context.addInitScript(() => {
        try {
          localStorage.setItem('trade-order-system-theme', 'light');
          localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10));
        } catch (_) {}
      });
      const page = await context.newPage();
      if (install) await page.clock.install({ time });
      else await page.clock.setFixedTime(time);
      const errors = [];
      const dialogs = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
      if (dataRoute) await page.route('**/api/data', dataRoute);
      await page.goto(`${url}/trade-order-system.html?token=${token}`);
      return { page, context, errors, dialogs };
    };
    const loaded = async page => {
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
      await page.evaluate(() => document.querySelectorAll('#toast .toast-item').forEach(el => el.remove()));
    };
    // 真实鼠标点：量中心点，确认那一点上就是这个元素（没被挡住），再点。
    const click = async (page, selector) => {
      let hit = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const point = await h.center(page, selector);
        hit = await page.locator(selector).first().evaluate((el, p) => { const top = document.elementFromPoint(p.x, p.y); return top === el || el.contains(top) ? '' : (top?.outerHTML || 'nothing').slice(0, 160); }, point);
        if (!hit) return page.mouse.click(point.x, point.y);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      assert.fail(`${selector} 被挡住了：${hit}`);
    };
    const confirmOpen = async page => {
      await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      await h.settle(page, '#confirmModal .modal');
      return page.evaluate(() => ({ title:document.getElementById('confirmTitle').textContent, ok:document.getElementById('confirmOkBtn').textContent, alt:document.getElementById('confirmAltBtn').hidden ? '' : document.getElementById('confirmAltBtn').textContent, cancel:document.getElementById('confirmCancelBtn').textContent }));
    };
    const confirmClosed = page => page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    const text = (page, selector) => page.locator(selector).first().innerText();

    // 1a. 读库慢：卡片是骨架，不是示例数据，也不是 0。
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const slow = await open({ dataRoute:async route => { await gate; await route.continue(); } });
    await slow.page.waitForSelector('#dashboard.is-loading');
    for (const id of ['statAmount', 'statPayment', 'statActive', 'statTasks', 'statTargetRate']) {
      assert.equal(await text(slow.page, `#${id}`), '—', `${id} 读库前显示「—」`);
    }
    assert.equal(await text(slow.page, '#statAmountSub'), '正在读取数据…');
    assert.equal(await slow.page.getAttribute('#dashboard', 'aria-busy'), 'true');
    release();
    await loaded(slow.page);
    await slow.page.waitForFunction(() => !document.getElementById('dashboard').classList.contains('is-loading'));
    await slow.page.waitForFunction(() => document.getElementById('statAmount').textContent === '$3,000');
    // 本月 2 张有金额的单 + 1 张 0 元单：单数只数 2 张。环比和上月同期（1–7 日：Old Buyer $1,500）比。
    assert.equal(await text(slow.page, '#statAmountSub'), '比 10 月同期 +100% · 2 单 · 草稿不计');
    assert.deepEqual(slow.errors, [], slow.errors.join('\n'));
    await slow.context.close();

    // 1b. 读库失败：写明没读到，不显示 0。
    const failed = await open({ dataRoute:route => route.abort() });
    await failed.page.waitForSelector('#dashboard.is-failed', { timeout:20000 });
    assert.equal(await text(failed.page, '#statAmount'), '—');
    assert.equal(await text(failed.page, '#statAmountSub'), '没读到数据库 · 数据未显示');
    await failed.context.close();

    // 2. 目标卡 → 目标页（本月），焦点在输入框。
    const { page, context, errors, dialogs } = await open();
    await loaded(page);
    await page.evaluate(() => setPage('dashboard'));
    assert.equal(await text(page, '#statTargetRate'), '未设');
    await click(page, '#targetStat');
    await page.waitForFunction(() => document.getElementById('page-targets')?.classList.contains('active'));
    await page.waitForFunction(() => document.activeElement?.id === 'targetAmountInput');
    assert.equal(await page.locator('#targetMonth').inputValue(), '2026-11', '目标页停在工作台目标卡的月份');

    // 3a. 空 / 负数：不保存，红字说明。
    await page.keyboard.press('Enter');
    assert.match(await text(page, '#targetInputHint'), /请填写目标金额/);
    assert.equal(await page.getAttribute('#targetAmountInput', 'aria-invalid'), 'true');
    await page.keyboard.type('-500');
    await page.keyboard.press('Enter');
    assert.match(await text(page, '#targetInputHint'), /不能是负数/);
    assert.equal(await page.evaluate(() => state.performanceTargets?.['2026-11'] || 0), 0, '负数不保存');

    // 3b. 「5万」= $50,000：比上月实际（$2,000）大 10 倍以上，应用内确认框先问；确认后保存，有撤销。
    await page.locator('#targetAmountInput').fill('');
    await page.keyboard.type('5万');
    await page.keyboard.press('Enter');
    const big = await confirmOpen(page);
    assert.equal(big.title, '目标比平时大很多');
    await click(page, '#confirmOkBtn');
    await confirmClosed(page);
    await h.waitToast(page, '2026年11月目标已设为 $50,000');
    assert.equal(await page.evaluate(() => state.performanceTargets['2026-11']), 50000);
    assert.equal(await text(page, '#targetGoal'), '$50,000');

    // 3c. 「50,000」照样认；99.6% 显示 99%（以前四舍五入成 100%，看着像完成了）。
    await page.locator('#targetAmountInput').fill('3,012.05');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.performanceTargets['2026-11'] === 3012.05);
    assert.equal(await text(page, '#targetRate'), '99%');
    await page.locator('#targetAmountInput').fill('3000');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.performanceTargets['2026-11'] === 3000);
    assert.equal(await text(page, '#targetRate'), '100%');
    assert.equal(await text(page, '#targetProgressText'), '刚好完成目标。');

    // 3d. 打了数没保存：后台重画不覆盖；换月份先问，「继续编辑」留在原月份。
    await page.locator('#targetAmountInput').fill('');
    await page.keyboard.type('4500');
    await page.evaluate(() => render());
    assert.equal(await page.locator('#targetAmountInput').inputValue(), '4500', '重画不覆盖没保存的数');
    await page.locator('#targetMonth').selectOption('2026-12');
    const ask = await confirmOpen(page);
    assert.deepEqual([ask.ok, ask.alt, ask.cancel], ['保存后切换', '放弃修改', '继续编辑']);
    await click(page, '#confirmCancelBtn');
    await confirmClosed(page);
    assert.equal(await page.locator('#targetMonth').inputValue(), '2026-11');
    assert.equal(await page.locator('#targetAmountInput').inputValue(), '4500');
    await page.locator('#targetMonth').selectOption('2026-12');
    await confirmOpen(page);
    await click(page, '#confirmAltBtn');
    await confirmClosed(page);
    assert.equal(await page.locator('#targetMonth').inputValue(), '2026-12');
    assert.equal(await page.evaluate(() => state.performanceTargets['2026-11']), 3000, '放弃修改：原目标不变');

    // 工作台目标卡：$3,000 / $3,000。
    await click(page, '.nav-item[data-page="dashboard"]');
    await page.waitForFunction(() => document.getElementById('statTargetRate').textContent === '100%');
    assert.equal(await page.getAttribute('#targetStat', 'data-target-month'), '2026-11');

    // 4. 金额页：0 元单不算单数；近 6 个月连续、写成「2026年6月–11月」。
    await click(page, '.nav-item[data-page="amount"]');
    await page.waitForFunction(() => document.getElementById('page-amount')?.classList.contains('active'));
    assert.equal(await text(page, '#reportCount'), '2');
    assert.match(await text(page, '#reportCountSub'), /另有 1 张 0 元单不计/);
    await page.locator('#chartRange').selectOption('6');
    await page.waitForFunction(() => document.getElementById('amountRangeText').textContent.includes('2026年6月–11月'));
    assert.deepEqual(await page.evaluate(() => chartMonths()), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);

    // 分组超过 6 项：前 5 项 + 「其他 N 项」，合计不少钱（以前只列前 6 项，合计对不上订单额）。
    const folded = await page.evaluate(() => {
      const rows = Array.from({ length:9 }, (_, i) => ({ name:`P${i}`, amount:(9 - i) * 100, count:1 }));
      const out = foldGroupedStats(rows);
      return { names:out.map(r => r.name), sum:out.reduce((t, r) => t + r.amount, 0), count:out.reduce((t, r) => t + r.count, 0) };
    });
    assert.deepEqual(folded, { names:['P0', 'P1', 'P2', 'P3', 'P4', '其他 4 项'], sum:4500, count:9 });

    // 5. 日历。
    assert.deepEqual(await page.evaluate(() => buildTaskItems().filter(t => t.orderId === 's1' && ['ship', 'urgent'].includes(t.type)).map(t => t.id)), [], '已发货的生产单不再提醒发货期限');
    await click(page, '.nav-item[data-page="calendar"]');
    await page.waitForFunction(() => document.getElementById('page-calendar')?.classList.contains('active'));
    const chips = date => page.locator(`#calendarGrid .calendar-day[data-calendar-date="${date}"] .calendar-event`).evaluateAll(els => els.map(el => el.textContent.trim()));
    assert.ok((await chips('2026-11-20')).some(label => label.startsWith('Beta Wigs')), `将来的最晚发出日期上日历：${await chips('2026-11-20')}`);
    assert.ok((await chips('2026-11-06')).some(label => label.includes('New Lead')), `只有档案的新客户上日历：${await chips('2026-11-06')}`);
    assert.equal((await chips('2026-11-08')).filter(label => label.includes('Shipped Late')).length, 0, '已发货的单没有发货期限');

    // 键盘：今天的格子 tabindex=0，→ 到 11-08，回车打开当天抽屉。
    await page.locator('#calendarGrid .calendar-day[data-calendar-date="2026-11-07"]').focus();
    assert.equal(await page.getAttribute('#calendarGrid .calendar-day[data-calendar-date="2026-11-07"]', 'tabindex'), '0');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.activeElement?.dataset?.calendarDate === '2026-11-08');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('calendarTaskDrawer').classList.contains('open'));
    assert.match(await text(page, '#calendarTaskTitle'), /^11 月 8 日 · 周日/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('calendarTaskDrawer').classList.contains('open'));

    // 「+N 更多」：抽屉里的件数和格子上的数一样（以前点开是「当天暂无任务」）。
    const crowded = '#calendarGrid .calendar-day[data-calendar-date="2026-11-12"]';
    const cellCount = Number(await text(page, `${crowded} .calendar-count`));
    assert.ok(cellCount > 3, `11-12 应有 3 件以上：${cellCount}`);
    await click(page, `${crowded} .calendar-more`);
    await page.waitForFunction(() => document.getElementById('calendarTaskDrawer').classList.contains('open'));
    assert.match(await text(page, '#calendarTaskTitle'), new RegExp(`· ${cellCount} 件$`));
    const drawerRows = await page.locator('#calendarTaskBody .calendar-record, #calendarTaskBody .calendar-task-list [data-task-id]').count();
    assert.equal(drawerRows, cellCount, '抽屉列出当天全部事项');
    // 抽屉里「打开订单」→ 订单详情。
    await click(page, '#calendarTaskBody [data-calendar-order-id="b1"]');
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    assert.equal(await page.evaluate(() => document.getElementById('calendarTaskDrawer').classList.contains('open')), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    // 点格子上的订单色块也打开订单详情。
    await click(page, '#calendarGrid .calendar-day[data-calendar-date="2026-11-20"] [data-calendar-order-id="b1"]');
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    await page.keyboard.press('Escape');

    assert.deepEqual(errors, [], errors.join('\n'));
    assert.deepEqual(dialogs, [], `不能出现原生弹窗：${dialogs}`);
    await context.close();

    // 6. 11-30 23:59 打开日历，时钟走过午夜：日历自己跟到 12 月。
    const night = await open({ time:at('2026-11-30', '23:59'), install:true });
    for (let i = 0; i < 60 && !(await night.page.evaluate(() => window.pendingSaveStatus?.().loaded)); i += 1) await night.page.clock.runFor(250);
    await night.page.evaluate(() => setPage('calendar'));
    assert.equal(await night.page.evaluate(() => activeCalendarMonth), '2026-11');
    for (let i = 0; i < 180 && await night.page.evaluate(() => activeCalendarMonth) !== '2026-12'; i += 1) await night.page.clock.runFor(1000);
    assert.equal(await night.page.evaluate(() => activeCalendarMonth), '2026-12', '跨月后日历跟到新的一个月');
    assert.match(await text(night.page, '#calendarMonthTitle'), /12/);
    assert.equal(await night.page.locator('#calendarGrid .calendar-day.today').getAttribute('data-calendar-date'), '2026-12-01');
    assert.deepEqual(night.errors, [], night.errors.join('\n'));
    await night.context.close();

    console.log('Stats / targets / calendar UI passed: skeleton and failed-load stats without demo numbers, target card jump + focus, target parsing (5万, negatives, empty) with in-app confirm, 99% floor, drafts kept across render and month switch, 0-value orders excluded, contiguous 近 6 个月, calendar future deadlines / new profiles / shipped orders, keyboard navigation, +N drawer completeness, chip and drawer drill-down, month rollover.');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
