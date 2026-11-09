#!/usr/bin/env node
// 通知面板（铃铛）：
// - 自己的操作（换阶段、保存）不算未读、不摇铃；App 自己发现的事（物流异常）算未读、摇一下；
// - 一件事一张卡（物流变化不再多一张标题过时的订单动态卡）；同一天「异常 → 运输中 → 异常」记 3 条，卡片时间是发现时间；
// - 接口错误连查只留一张卡（×3），没开启的接口不算异常，恢复后收尾；保存失败恢复后收尾；升级后旧的「发现新版本」不显示；
// - 接口 / 飞书 / 新版本卡点了去能处理的地方（飞书失败去「订单信息」页签的「重新发送」）；
// - 超过 40 条有「显示更多」，红点和未读数按全部算，去年的事件带年份；已读集合截断不让旧卡复活；
// - 重开不停在空筛选上；Tab 留在面板里；搜索结果在打开通知时收起；提示框不压在面板上；另一个窗口的已读会同步过来。
// 真实 mac-app/server.js（临时数据目录）+ 真实鼠标键盘；点击用 h.click（重新定位、等动画、elementFromPoint 确认）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const pad = n => String(n).padStart(2, '0');
const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return localDate(d); };

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-notif-panel-'));
  const C = { currency:'USD', country:'🇺🇸 美国 United States', orderType:'定金订单', productType:'假发', paymentChannel:'TT' };
  const log = (time, text) => ({ time, text });
  const old = `${daysAgo(10)} 10:00`;
  const orders = [
    { ...C, id:'N1', num:'K3001', client:'Alpha Hair', stage:'production', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30, createdAt:daysAgo(20), orderMonth:daysAgo(20).slice(0, 7), updated:old, logs:[log(old, '新建订单')] },
    { ...C, id:'N2', num:'K3002', client:'Gamma Lashes', stage:'shipment', amount:500, paidAmount:500, depositAmount:150, depositPercent:30, createdAt:daysAgo(20), orderMonth:daysAgo(20).slice(0, 7), updated:old, logisticsStatus:'已发货', trackingNumber:'1234567890', carrier:'DHL', shippedAt:daysAgo(10),
      shipments:[{ id:'s-n2', trackingNumber:'1234567890', carrier:'DHL', status:'已发货', shippedAt:daysAgo(10) }], logs:[log(old, '订单阶段从 生产中 调整为 已发货')] }
  ];
  const customers = Object.fromEntries(orders.map(o => [o.client, { client:o.client, country:o.country }]));
  fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:1, data:{ orders, customers, trashOrders:[], deletedOrders:[], doneTasks:{}, demoCleared:true, demoCustomersCleared:true } }));
  const port = freePortSync();
  const token = `notif-panel-${process.pid}`;
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
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, locale:'zh-CN' });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    // 只拦 DHL 的检测（模拟限流）；FedEx 走真实服务端：没开启，回 disabled。
    let dhlReply = { ok:false, label:'DHL', message:'DHL API 调用次数超限，请稍后再试' };
    await context.route('**/api/api-status', async route => {
      const body = route.request().postDataJSON() || {};
      if (body.kind === 'dhl') return route.fulfill({ json:{ ...dhlReply, checkedAt:new Date().toISOString() } });
      return route.continue();
    });
    await context.route('**/api/ecb-rates**', route => route.fulfill({ json:{ ok:true, rates:[] } }));
    const errors = [];
    const dialogs = [];
    const open = async () => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
      await page.goto(`${url}/trade-order-system.html?token=${token}`);
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
      // 数铃铛摇了几次（.ring 加上去一次算一次）。
      await page.evaluate(() => {
        window.__rings = 0;
        const bell = document.getElementById('notifBtn');
        let had = bell.classList.contains('ring');
        new MutationObserver(() => { const has = bell.classList.contains('ring'); if (has && !had) window.__rings += 1; had = has; }).observe(bell, { attributes:true, attributeFilter:['class'] });
      });
      return page;
    };
    const page = await open();
    const click = (selector, label) => h.click(page, selector, label);
    const badge = () => page.evaluate(() => { const b = document.getElementById('notifBadge'); return b.hidden ? '' : b.textContent; });
    const rings = () => page.evaluate(() => window.__rings);
    const events = () => page.evaluate(() => uiNotifEvents());
    const openBell = async () => {
      if (await page.evaluate(() => document.getElementById('notifPanel').hidden)) await click('#notifBtn', 'bell');
      await page.waitForFunction(() => !document.getElementById('notifPanel').hidden);
    };
    const closeBell = async () => {
      if (await page.evaluate(() => !document.getElementById('notifPanel').hidden)) await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.getElementById('notifPanel').hidden);
    };
    assert.equal(await badge(), '', 'nothing unread at start');

    // ---- 1. Own actions: a stage move and a saved edit are listed, but are not unread and do not ring ----
    await page.evaluate(() => { moveOrderToStage('N1', 'balance'); });
    await page.evaluate(() => window.flushPendingSave?.());
    assert.equal(await badge(), '', 'own stage move does not light the badge');
    assert.equal(await rings(), 0, 'own stage move does not ring the bell');
    await openBell();
    const own = page.locator('#notifList .notif-card[data-order-id="N1"]');
    await own.waitFor();
    assert.deepEqual(await own.evaluate(el => [el.classList.contains('is-quiet'), el.classList.contains('is-read'), el.querySelector('.notif-pill').textContent]), [true, true, '订单']);
    assert.match(await own.locator('small').innerText(), /K3001 · 待发货/, 'the stage moves into the subtitle');
    assert.equal(await page.locator('#notifReadAll').isDisabled(), true, 'nothing to mark read');
    // The read look keeps full opacity (contrast), the unread dot is gone.
    await h.settle(page, '#notifList .notif-card[data-order-id="N1"]');
    assert.equal(await own.evaluate(el => getComputedStyle(el).opacity), '1');
    await closeBell();

    // ---- 2. A logistics exception found by the app: unread, rings, one card for the order, timed when found ----
    const carrierTime = `${daysAgo(2)} 14:00`;
    await page.evaluate(at => applyTrackingResultToOrder('1234567890', { ok:true, status:'异常', updatedAt:at, checkedAt:nowText() }, 'DHL'), carrierTime);
    await page.waitForFunction(() => window.__rings >= 1);
    assert.equal(await badge(), '1');
    const n2Items = await page.evaluate(() => uiNotifItems().filter(item => item.orderId === 'N2'));
    assert.equal(n2Items.length, 1, `one card per event, got ${JSON.stringify(n2Items.map(item => item.title))}`);
    assert.equal(n2Items[0].time.slice(0, 10), localDate(), 'card time is when the app found it');
    assert.match(n2Items[0].sub, new RegExp(`承运商时间 ${carrierTime.slice(5)}`));
    // Same day 异常 → 运输中 → 异常: three events, the last one is not swallowed.
    await page.evaluate(day => {
      applyTrackingResultToOrder('1234567890', { ok:true, status:'运输中', updatedAt:`${day} 08:30`, checkedAt:nowText() }, 'DHL');
      applyTrackingResultToOrder('1234567890', { ok:true, status:'异常', updatedAt:`${day} 09:40`, checkedAt:nowText() }, 'DHL');
    }, daysAgo(1));
    assert.deepEqual((await events()).filter(e => e.pill === '物流').map(e => e.title), ['物流从「已发货」变为「异常」', '物流从「异常」变为「运输中」', '物流从「运输中」变为「异常」']);

    // ---- 3. API status: three 429s are one card ×3, FedEx not enabled is no error, recovery closes the card ----
    await click('.nav-item[data-page="settings"]', 'settings nav');
    await click('.settings-menu [data-settings-tab="api"]', 'api tab');
    for (let i = 0; i < 3; i++) {
      await click('[data-settings-panel="api"] [data-api-check="dhl"]', 'dhl light');
      await page.waitForFunction(n => (uiNotifEvents().find(e => e.id.startsWith('api-dhl-'))?.count || 1) >= n && !document.querySelector('[data-api-check="dhl"]').classList.contains('checking'), i + 1);
    }
    await click('[data-settings-panel="api"] [data-api-check="fedex"]', 'fedex light');
    await page.waitForFunction(() => document.querySelector('[data-api-check="fedex"] .api-status-state').textContent === '未开启');
    const apiEvents = (await events()).filter(e => e.pill === '接口');
    assert.equal(apiEvents.length, 1, `one DHL card, no FedEx card: ${JSON.stringify(apiEvents)}`);
    assert.equal(apiEvents[0].count, 3);
    assert.equal(await page.locator('[data-api-check="fedex"]').evaluate(el => el.classList.contains('bad')), false, 'not enabled is not red');
    assert.equal(apiEvents[0].time.slice(0, 10), localDate(), 'server ISO time shown as local time');
    // Clicking the API card goes to 接口状态 with the DHL light focused.
    await click('.nav-item[data-page="dashboard"]', 'dashboard nav');
    await openBell();
    await click('#notifList .notif-card[data-notif-id^="api-dhl-"]', 'api card');
    await page.waitForFunction(() => document.getElementById('notifPanel').hidden && document.activeElement?.dataset?.apiCheck === 'dhl');
    assert.equal(await page.evaluate(() => document.querySelector('.settings-panel.active')?.dataset.settingsPanel), 'api');
    // Recovery: the card says 已恢复 and is read.
    dhlReply = { ok:true, label:'DHL', message:'DHL API 可连接' };
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => uiNotifEvents().find(e => e.id.startsWith('api-dhl-'))?.resolvedAt);

    // ---- 4. Feishu failure card opens 订单信息 with 重新发送 focused ----
    await page.evaluate(() => applyOrderNotificationResult('N1', { status:'failed', error:'网络超时' }));
    await openBell();
    await click('#notifList .notif-card[data-notif-id^="feishu-N1-failed"]', 'feishu card');
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open') && document.activeElement?.dataset?.retryOrderNotification === 'N1');
    assert.equal(await page.evaluate(() => uiDetailTab.current), 'info');
    await page.evaluate(() => closeOrderDetail());
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));

    // ---- 5. Save failure, then the automatic retry succeeds: the red card is closed and no longer unread ----
    await page.route('**/api/save', route => route.fulfill({ status:500, json:{ ok:false, message:'database is locked' } }));
    await page.evaluate(() => { moveOrderToStage('N1', 'production'); window.flushPendingSave?.(); });
    await page.waitForFunction(() => uiNotifEvents().some(e => e.id.startsWith('save-') && !e.resolvedAt));
    const unreadWhileFailing = await page.evaluate(() => { const r = uiNotifRead(); return uiNotifItems().some(i => i.id.startsWith('save-') && !r.has(i.id)); });
    assert.equal(unreadWhileFailing, true, 'save failure is unread');
    await page.unroute('**/api/save');
    await page.waitForFunction(() => uiNotifEvents().some(e => e.id.startsWith('save-') && e.resolvedAt), null, { timeout:15000 });
    assert.equal(await page.evaluate(() => { const r = uiNotifRead(); return uiNotifItems().some(i => i.id.startsWith('save-') && !r.has(i.id)); }), false, 'recovered save failure is read');

    // ---- 6. New version: an older version than this one is not shown; a newer one focuses 更新 ----
    await page.evaluate(() => { otsAppUpdateStatus({ state:'available', version:'3.0' }); otsAppUpdateStatus({ state:'available', version:'99.0' }); otsAppUpdateStatus({ state:'idle' }); });
    const updates = await page.evaluate(() => uiNotifItems().filter(i => i.id.startsWith('update-')).map(i => i.id));
    assert.deepEqual(updates, ['update-99.0']);
    await openBell();
    await click('#notifList .notif-card[data-notif-id="update-99.0"]', 'update card');
    await page.waitForFunction(() => document.getElementById('notifPanel').hidden);
    assert.ok(await page.evaluate(() => document.activeElement?.id === 'appUpdateBtn' || [...document.querySelectorAll('#toast .toast-item')].some(el => el.textContent.includes('更新'))), 'update card leads to the update button');

    // ---- 7. Over 40: badge and unread count cover everything, 显示更多 shows the rest, last year's event has its year ----
    await page.evaluate(() => {
      const list = uiNotifEvents();
      const year = new Date().getFullYear() - 1;
      list.unshift({ id:'syn-last-year', kind:'info', title:'去年的事件', sub:'', pill:'物流', time:`${year}-03-05 09:00` });
      for (let i = 0; i < 45; i++) list.push({ id:`syn-${i}`, kind:'info', title:`批量事件 ${i}`, sub:'', pill:'物流', time:`${new Date(Date.now() - (i + 2) * 3600000).toISOString()}` });
      localStorage.setItem('ots-notif-events-v1', JSON.stringify(list));
      uiRenderNotifs();
    });
    const totalUnread = await page.evaluate(() => { const r = uiNotifRead(); return uiNotifItems().filter(i => !i.quiet && !r.has(i.id)).length; });
    assert.ok(totalUnread > 40, `fixture has more than 40 unread, got ${totalUnread}`);
    await openBell();
    assert.equal(await page.locator('#notifUnread').innerText(), `${totalUnread} 条未读`);
    assert.equal(await page.locator('#notifList .notif-card').count(), 40);
    assert.ok(await page.locator('#notifList .notif-group').count() >= 2, 'today / earlier headings');
    const more = page.locator('#notifList [data-notif-more]');
    assert.match(await more.innerText(), /还有 \d+ 条更早的通知/);
    await click('#notifList [data-notif-more]', 'show more');
    await page.waitForFunction(() => !document.querySelector('#notifList [data-notif-more]'));
    const lastYear = page.locator('#notifList .notif-card[data-notif-id="syn-last-year"] time');
    assert.equal(await lastYear.innerText(), `${new Date().getFullYear() - 1}-03-05 09:00`);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('notif-card')), true, 'focus moves onto the newly shown cards');
    await closeBell();

    // ---- 8. Read set: a card read long ago stays read after 500 other reads ----
    await page.evaluate(() => {
      uiNotifMarkRead(['syn-last-year']);
      for (let i = 0; i < 500; i++) uiNotifMarkRead([`log-gone-${i}`, `syn-${i % 45}`]);
    });
    assert.equal(await page.evaluate(() => uiNotifRead().has('syn-last-year')), true);

    // ---- 9. Reopening never lands on an empty filter; the empty filter says so ----
    await openBell();
    assert.equal(await page.evaluate(() => uiNotifItems().filter(i => i.kind === 'success').length), 0, 'fixture has no success items');
    await click('#notifTabs [data-notif-tab="success"]', 'success tab');
    await page.locator('#notifList .notif-empty', { hasText:'「成功」里没有通知' }).waitFor();
    assert.equal(await page.locator('#notifTabs [data-notif-tab="success"]').getAttribute('aria-pressed'), 'true');
    await closeBell();
    await openBell();
    assert.equal(await page.evaluate(() => uiNotifTab()), 'all', 'reopen falls back to 全部');
    await click('#notifTabs [data-notif-tab="success"]', 'success tab');
    await click('#notifList [data-notif-show-all]', '查看全部');
    await page.waitForFunction(() => uiNotifTab() === 'all' && document.querySelectorAll('#notifList .notif-card').length > 0);

    // ---- 10. Keyboard: Tab stays inside the panel; ↓ moves between cards; the bell's name carries the unread count ----
    await page.evaluate(() => document.getElementById('notifPanel').focus());
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#notifPanel'))), true, `Tab ${i + 1} left the panel`);
    }
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#notifPanel'))), true);
    await page.locator('#notifList .notif-card').first().focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll('#notifList .notif-card')[1]), true, '↓ moves to the next card');
    assert.match(await page.locator('#notifBtn').getAttribute('aria-label'), /^通知，\d+ 条未读$/);

    // ---- 11. 全部已读's toast sits beside the panel, not on it; another window's badge follows ----
    const other = await open();
    await other.waitForFunction(() => !document.getElementById('notifBadge').hidden);
    await click('#notifReadAll', '全部已读');
    await h.waitToast(page, '已全部标为已读');
    const overlap = await page.evaluate(() => {
      const panel = document.getElementById('notifPanel').getBoundingClientRect();
      return [...document.querySelectorAll('#toast .toast-item')].some(el => { const r = el.getBoundingClientRect(); return r.right > panel.left && r.left < panel.right && r.bottom > panel.top && r.top < panel.bottom; });
    });
    assert.equal(overlap, false, 'toast must not cover the panel');
    await other.waitForFunction(() => document.getElementById('notifBadge').hidden, null, { timeout:3000 });
    await other.close();
    await closeBell();

    // ---- 12. Opening the bell from the keyboard closes the search results ----
    await click('#searchInput', 'search');
    await page.keyboard.type('K30');
    await page.waitForFunction(() => document.getElementById('globalSearchPanel')?.classList.contains('open'));
    await page.locator('#notifBtn').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('notifPanel').hidden);
    assert.equal(await page.evaluate(() => document.getElementById('globalSearchPanel').classList.contains('open')), false, 'search results close when the bell opens');
    await closeBell();

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], 'no native dialogs');
    console.log('Notification panel UI test passed: own actions quiet, one card per event, discovery time, API / save dedupe and recovery, card targets (API, Feishu 重新发送, update), 40+ with 显示更多 and year labels, read-set pruning, empty filter fallback, keyboard trap and arrows, toast beside the panel, cross-window sync, search closes, real server.');
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => {
  console.error(`Notification panel UI test failed: ${error.stack || error.message}`);
  process.exit(1);
});
