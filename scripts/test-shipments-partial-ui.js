#!/usr/bin/env node
// 多批物流 / 部分发货（V3.121）：
// - UPS 满 5 天自动完成只推一次，用户拖回「已发货」后刷新、重画、重启都不再推回去；
// - 订单物流状态按全部批次汇总（列表、「物流异常」筛选、看板标签、英文文案），抽屉「物流」页列出所有批次；
// - 「还有批次没发」（部分发货）时全部签收也不进已完成，看板 / 列表 / 抽屉写明部分发货，跟进提醒继续；
// - 承运商原文状态（On FedEx vehicle for delivery、Not delivered…）换成标准状态再存，刷新后不丢；
// - 编辑已有订单第一次补单号和新建一样进已发货（可以选「只记单号」留在原阶段）；
// - 同单重复单号拦下、承运商随单号重新识别、删光批次清掉旧状态、保存不清空批次的更新时间、已完成订单不再查、CSV 带物流列。
// /api/track 全部是 mock，不请求真实承运商。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { h } = require('./helpers/board-page');

const pad = n => String(n).padStart(2, '0');
const dayStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return dayStr(d); };
const today = dayStr(new Date());
const month = today.slice(0, 7);

async function launch() {
  try { return await chromium.launch({ headless:true }); }
  catch (_) { return chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium' }); }
}

(async () => {
  const browser = await launch();
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
    const base = { currency:'USD', logisticsStatus:'未发货', createdAt:`${month}-01`, orderMonth:month, updated:`${daysAgo(9)} 09:00`, logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States' };
    const orders = [
      // UPS 发货 8 天：启动时按规则自动完成一次。
      { ...base, id:'u1', num:'K3001', client:'Ups Bounce', amount:500, paidAmount:500, orderType:'全款订单', stage:'shipment',
        shipments:[{ id:'ups-1', trackingNumber:'1Z999AA10123456784', carrier:'UPS', status:'已发货', shippedAt:daysAgo(8) }] },
      // 三批：签收 / 在途 / 异常。
      { ...base, id:'m1', num:'K3002', client:'Three Parcels', amount:3000, paidAmount:3000, orderType:'全款订单', stage:'shipment',
        shipments:[
          { id:'p1', trackingNumber:'1234567890', carrier:'DHL', status:'已签收', shippedAt:daysAgo(6), updated:`${daysAgo(1)} 10:00` },
          { id:'p2', trackingNumber:'123456789012', carrier:'FedEx', status:'运输中', shippedAt:daysAgo(3), updated:`${daysAgo(1)} 11:00` },
          { id:'p3', trackingNumber:'2222222222', carrier:'DHL', status:'异常', shippedAt:daysAgo(3), updated:`${daysAgo(1)} 12:00` }
        ] },
      // 只录了第一批，还有一批没发。
      { ...base, id:'pa', num:'K3003', client:'Partial Ship', amount:1500, paidAmount:1500, orderType:'全款订单', stage:'shipment',
        shipments:[{ id:'pa-1', trackingNumber:'3333333333', carrier:'DHL', status:'运输中', shippedAt:daysAgo(2), updated:`${daysAgo(2)} 08:00` }] },
      // 承运商原文：FedEx 派送中、DHL 没送到。
      { ...base, id:'r1', num:'K3004', client:'Raw Status', amount:800, paidAmount:800, orderType:'全款订单', stage:'shipment',
        shipments:[
          { id:'r-1', trackingNumber:'444444444444', carrier:'FedEx', status:'运输中', shippedAt:daysAgo(2) },
          { id:'r-2', trackingNumber:'5555555555', carrier:'DHL', status:'运输中', shippedAt:daysAgo(2) }
        ] },
      // 生产中、还没有单号。
      { ...base, id:'e1', num:'K3005', client:'Edit Track', amount:1000, paidAmount:1000, orderType:'全款订单', stage:'production' },
      { ...base, id:'e2', num:'K3006', client:'Sample Track', amount:1000, paidAmount:1000, orderType:'全款订单', stage:'production' },
      // 已完成、还有一批没签收：自动查询不再查它。
      { ...base, id:'d1', num:'K3007', client:'Done Old', amount:900, paidAmount:900, orderType:'全款订单', stage:'done',
        shipments:[{ id:'dd-1', trackingNumber:'6666666666', carrier:'DHL', status:'运输中', shippedAt:daysAgo(20) }] },
      // 两批，删光后旧的「异常」不能挂在卡片上。
      { ...base, id:'x1', num:'K3008', client:'Delete All', amount:700, paidAmount:700, orderType:'全款订单', stage:'shipment',
        shipments:[
          { id:'x-1', trackingNumber:'7777777777', carrier:'DHL', status:'异常', shippedAt:daysAgo(4), updated:`${daysAgo(1)} 08:00` },
          { id:'x-2', trackingNumber:'8888888888', carrier:'DHL', status:'运输中', shippedAt:daysAgo(4), updated:`${daysAgo(1)} 09:00` }
        ] }
    ];
    let stored = { app:'trade-order-system', data:{ orders, customers:{}, demoCleared:true, demoCustomersCleared:true }, revision:0 };
    const trackCalls = [];
    const trackResults = {};
    const context = await browser.newContext({ viewport:{ width:1440, height:920 } });
    await context.addInitScript(() => {
      try {
        localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10));
      } catch (_) {}
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss(); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
      if (pathname === '/api/track') {
        const number = url.searchParams.get('number');
        trackCalls.push(`${url.searchParams.get('carrier')}:${number}`);
        response = trackResults[number] || { ok:true, status:'运输中' };
      }
      if (pathname === '/api/save') {
        const body = route.request().postDataJSON();
        stored = { ...body.state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      if (pathname.startsWith('/api/') && !['/api/data', '/api/health', '/api/ecb-rates', '/api/track', '/api/save'].includes(pathname)) response = { ok:true };
      return route.fulfill({ json:response });
    });
    const load = async () => {
      await page.goto('http://127.0.0.1:47998/trade-order-system.html');
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
      // 物流 API 开关放在本机设置里，每次载入后打开（请求都由下面的 mock 回答）。
      await page.evaluate(() => saveTrackingApiSettings({ ...getTrackingApiSettings(), dhlApiEnabled:'是', fedexApiEnabled:'是' }));
    };
    await load();
    const order = id => page.evaluate(id => JSON.parse(JSON.stringify(state.orders.find(o => o.id === id))), id);
    const isOpen = id => page.evaluate(id => document.getElementById(id)?.classList.contains('open'), id);
    const flush = () => page.evaluate(() => window.flushPendingSave());
    const storedOrder = id => stored.data.orders.find(o => o.id === id);
    // 订单弹窗保存完：内存里先换成新订单，写进数据库后才关弹窗。等弹窗真的关了再做下一步。
    const modalSaved = () => page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open') && !document.getElementById('orderForm').dataset.saving);
    const waitToast = text => page.waitForFunction(text => [...document.querySelectorAll('#toast .toast-item:not(.leaving)')].some(el => el.textContent.includes(text)), text);
    const openDrawer = (id, tab = 'logistics') => h.openDrawer(page, id, tab);
    const closeDrawer = async () => {
      await page.evaluate(() => closeOrderDetail());
      await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    };

    // ===== 07 P1-1：UPS 满 5 天只推一次，拖回已发货后不再被推回去 =====
    let u1 = await order('u1');
    assert.equal(u1.stage, 'done', 'UPS 发货满 5 天的单启动时自动完成');
    assert.equal(u1.logs.filter(log => /UPS 发货满 5 天/.test(log.text)).length, 1);
    assert.ok(await page.evaluate(() => uiNotifEvents().some(item => item.orderId === 'u1' && /UPS 发货满 5 天/.test(item.title))), 'UPS 自动完成时铃铛里有一条通知');
    await openDrawer('u1', 'info');
    await page.locator('#detailStageBar [data-detail-stage="shipment"]').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'u1').stage === 'shipment');
    // 以前每次 render 都跑 UPS 规则，画面一刷新就被推回已完成。
    await page.evaluate(() => { render(); render(); setPage('order-list'); setPage('dashboard'); checkUpsAutoCompletion(); });
    await closeDrawer();
    await page.evaluate(() => checkUpsAutoCompletion());
    u1 = await order('u1');
    assert.equal(u1.stage, 'shipment', '用户拖回已发货后，重画 / 定时检查都不能再推回已完成');
    assert.equal(u1.autoDoneHold, '1Z999AA10123456784', '记住用户拖回时的批次');
    await flush();
    assert.equal(storedOrder('u1').autoDoneHold, '1Z999AA10123456784', '拖回的记号存进数据库，重启后还在');
    await load();
    u1 = await order('u1');
    assert.equal(u1.stage, 'shipment', '重启后启动检查也不再推回已完成');
    assert.equal(u1.logs.filter(log => /UPS 发货满 5 天/.test(log.text)).length, 1, 'UPS 自动完成只记一次');

    // ===== 07 P1-3：订单物流状态按全部批次汇总 =====
    const m1Summary = await page.evaluate(() => orderLogisticsSummary(state.orders.find(o => o.id === 'm1')));
    assert.equal(m1Summary.status, '异常');
    assert.equal(m1Summary.label, '异常 1/3 批');
    await page.evaluate(() => setPage('order-list'));
    await page.locator('#orderTableBody').waitFor();
    const m1Cell = await page.locator('#orderTableBody tr', { hasText:'K3002' }).locator('.col-logistics').innerText();
    assert.match(m1Cell, /异常 1\/3 批/, '列表物流列按全部批次写「异常 1/3 批」');
    assert.match(m1Cell, /等 3 批/);
    const pickLogisticsFilter = async value => {
      if (!await page.locator('#orderListMoreFilters').evaluate(node => node.open)) await page.locator('#orderListMoreFilters summary').click();
      await page.locator('#orderListLogisticsFilter').locator('xpath=..').locator('.app-select-button').click();
      await page.locator(`.app-select-popover [data-app-select-value="${value}"]`).click();
      await page.waitForFunction(value => document.getElementById('orderListLogisticsFilter').value === value, value);
    };
    await pickLogisticsFilter('exception');
    await page.waitForFunction(() => [...document.querySelectorAll('#orderTableBody tr')].some(row => row.textContent.includes('K3002')));
    const exceptionRows = await page.locator('#orderTableBody tr').allInnerTexts();
    assert.ok(exceptionRows.some(text => text.includes('K3002')), '「物流异常」筛选能筛到第三批异常的单');
    assert.ok(!exceptionRows.some(text => text.includes('K3003')), '没有异常批次的单不在「物流异常」里');
    await pickLogisticsFilter('all');
    await page.keyboard.press('Escape');
    await page.evaluate(() => setPage('dashboard'));
    await page.locator('#pipeline [data-id="m1"]').waitFor();
    assert.match(await page.locator('#pipeline [data-id="m1"]').innerText(), /物流异常/, '看板卡片按汇总挂「物流异常」');
    const statusText = await page.evaluate(() => fillCopyTemplate(copyTemplate('status'), orderCopyVars(state.orders.find(o => o.id === 'm1'))));
    assert.match(statusText, /1234567890/);
    assert.match(statusText, /123456789012/);
    assert.match(statusText, /2222222222/);
    assert.match(statusText, /Exception/, '英文状态文案按汇总写出异常');

    // ===== 07 P1-4：抽屉物流页列出所有批次 =====
    await openDrawer('m1');
    const rows = page.locator('#orderDetailBody [data-detail-shipment]');
    assert.equal(await rows.count(), 3, '抽屉物流页显示全部 3 批');
    const rowText = await rows.allInnerTexts();
    assert.match(rowText[0], /第 1 批[\s\S]*DHL[\s\S]*1234 5678 90[\s\S]*已签收/);
    assert.match(rowText[1], /FedEx[\s\S]*1234 5678 9012[\s\S]*运输中/);
    assert.match(rowText[2], /2222 2222 22[\s\S]*异常/);
    assert.match(rowText[1], new RegExp(`发货 ${daysAgo(3)}`), '每批显示发货日');
    assert.match(rowText[1], new RegExp(`更新 ${daysAgo(1)} 11:00`), '每批显示最近更新');
    assert.equal(await page.locator('#orderDetailBody [data-detail-ship-official]').count(), 3, '每批都有官网入口');
    assert.equal(await page.locator('#orderDetailBody [data-detail-ship-refresh]').count(), 2, '没签收的 DHL / FedEx 批次有「更新」');
    assert.match(await page.locator('#orderDetailBody .detail-ship-summary').innerText(), /异常 1\/3 批/);
    await closeDrawer();

    // ===== 07 P1-2：部分发货 =====
    await openDrawer('pa');
    await page.locator('#orderDetailBody label.detail-switch:has([data-dedit="partialShipment"])').click();
    assert.equal(await page.locator('#orderDetailBody [data-dedit="partialShipment"]').isChecked(), true);
    await page.locator('#detailSaveBtn').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'pa').partialShipment === true);
    let pa = await order('pa');
    assert.equal(pa.shipments[0].updated, `${daysAgo(2)} 08:00`, '抽屉保存不清空批次的最近更新时间');
    assert.equal(pa.shipments[0].id, 'pa-1', '抽屉保存不重编批次 id');
    assert.match(pa.logs[0].text, /部分发货/, '记录写明标了部分发货');
    // 已录的那一批签收：整单不进已完成。
    trackResults['3333333333'] = { ok:true, status:'Delivered', rawStatus:'Delivered' };
    await page.locator('#orderDetailBody [data-detail-ship-refresh="3333333333"]').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'pa').shipments[0].status === '已签收');
    pa = await order('pa');
    assert.equal(pa.stage, 'shipment', '还有批次没发时，已录的批次全部签收也不自动完成');
    assert.match(await page.locator('#detailPills').innerText(), /部分发货/, '抽屉头部写明部分发货');
    await closeDrawer();
    assert.match(await page.locator('#pipeline [data-id="pa"]').innerText(), /部分发货/, '看板卡片写明部分发货');
    await page.evaluate(() => setPage('order-list'));
    assert.match(await page.locator('#orderTableBody tr', { hasText:'K3003' }).innerText(), /部分发货/, '列表写明部分发货');
    await page.evaluate(() => setPage('dashboard'));
    const reminder = await page.evaluate(() => {
      const o = state.orders.find(item => item.id === 'pa');
      return orderFollowReminder({ ...o, updated:'2020-01-01 09:00' }, '2020-01-10');
    });
    assert.match(reminder?.reason || '', /部分发货/, '部分发货的单继续有跟进提醒');
    // 第二批从抽屉补上：逐键输入，回车提交。
    await openDrawer('pa');
    const shipInput = page.locator('#orderDetailBody [data-detail-ship-input]');
    await shipInput.click();
    await page.keyboard.type('9876543210', { delay:5 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'pa').shipments.length === 2);
    pa = await order('pa');
    assert.equal(pa.shipments[1].trackingNumber, '9876543210');
    assert.equal(pa.shipments[1].status, '已发货');
    assert.equal(pa.shipments[1].shippedAt, today);
    assert.equal(await page.locator('#orderDetailBody [data-detail-shipment]').count(), 2, '补上的一批马上出现在物流页');
    assert.match(await page.locator('#orderDetailBody .detail-ship-summary').innerText(), /部分签收 1\/2/);
    // 全部发完：取消「还有批次没发」并保存，第二批签收后整单才完成。
    await page.locator('#orderDetailBody label.detail-switch:has([data-dedit="partialShipment"])').click();
    await page.locator('#detailSaveBtn').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'pa').partialShipment === false);
    trackResults['9876543210'] = { ok:true, status:'已签收' };
    await page.locator('#orderDetailBody [data-detail-ship-refresh="9876543210"]').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'pa').stage === 'done');
    await closeDrawer();

    // ===== 07 P1-5：承运商原文换成标准状态再存 =====
    assert.equal(await page.evaluate(() => normalizeTrackingStatus('Not delivered')), '异常', '"Not delivered" 不能判成已签收');
    assert.equal(await page.evaluate(() => normalizeTrackingStatus('On FedEx vehicle for delivery')), '派送中');
    assert.equal(await page.evaluate(() => normalizeTrackingStatus('Shipment on hold')), '异常');
    trackResults['444444444444'] = { ok:true, status:'On FedEx vehicle for delivery' };
    trackResults['5555555555'] = { ok:true, status:'异常', rawStatus:'Not delivered - recipient not available' };
    await openDrawer('r1');
    await page.locator('#orderDetailBody [data-detail-ship-refresh="444444444444"]').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'r1').shipments[0].status === '派送中');
    await page.locator('#orderDetailBody [data-detail-ship-refresh="5555555555"]').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'r1').shipments[1].status === '异常');
    assert.match(await page.locator('#orderDetailBody [data-detail-shipment="444444444444"]').innerText(), /承运商原文：On FedEx vehicle for delivery/);
    await closeDrawer();
    await flush();
    await load();
    const r1 = await order('r1');
    assert.deepEqual(r1.shipments.map(item => item.status), ['派送中', '异常'], '刷新后仍是派送中 / 异常，不变成已发货');
    assert.equal(r1.shipments[0].rawStatus, 'On FedEx vehicle for delivery');
    assert.equal(r1.logisticsStatus, '异常');
    assert.equal(r1.stage, 'shipment');

    // ===== 07 P1-6：编辑已有订单第一次补单号，和新建一样进已发货 =====
    await page.evaluate(() => openOrder('e1'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    const tracking = page.locator('#orderForm input[name="trackingNumber"]');
    await tracking.click();
    await page.keyboard.type('1122334455', { delay:5 });
    await page.locator('#orderForm [name="note"]').click();
    await page.waitForFunction(() => document.querySelector('#orderForm [name="carrier"]').value === 'DHL');
    await page.waitForFunction(() => /已发货/.test(document.getElementById('modalSummary').textContent));
    await page.getByRole('button', { name:'保存订单' }).click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'e1').stage === 'shipment');
    await modalSaved();
    await waitToast('已按物流单号放到「已发货」');
    const e1 = await order('e1');
    assert.equal(e1.shipments[0].status, '已发货', '包裹状态跟着进已发货');
    assert.equal(e1.shipments[0].shippedAt, today);
    assert.match(e1.logs[0].text, /新增物流第 1 批：DHL 1122334455/);
    await page.evaluate(() => { setPage('logistics'); renderLogistics(); });
    assert.match(await page.locator('#logisticsList').innerText(), /K3005/, '物流页能看到这一单');
    await page.evaluate(() => setPage('dashboard'));
    // 只是样品单号：点「只记单号」留在生产中。
    await page.evaluate(() => openOrder('e2'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await page.locator('#orderForm input[name="trackingNumber"]').click();
    await page.keyboard.type('1Z999AA10123456787', { delay:5 });
    await page.locator('#orderForm [data-stage-keep]').click();
    await page.waitForFunction(() => !document.querySelector('#orderForm [data-stage-keep]'));
    await page.getByRole('button', { name:'保存订单' }).click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'e2').shipments?.length === 1);
    await modalSaved();
    const e2 = await order('e2');
    assert.equal(e2.stage, 'production', '选了「只记单号」就留在生产中');
    assert.equal(e2.shipments[0].carrier, 'UPS');

    // ===== 07 P2：同单重复单号拦下、承运商跟着单号重新识别 =====
    await page.evaluate(() => openOrder('x1'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await page.locator('#orderForm [data-add-shipment]').click();
    await page.keyboard.type('77 7777 7777', { delay:5 });
    await page.locator('#orderForm [name="note"]').click();
    await page.waitForFunction(() => /和第 1 批单号重复/.test(document.querySelector('#orderForm [data-shipment-extra-row]:last-child')?.textContent || ''));
    await page.getByRole('button', { name:'保存订单' }).click();
    await waitToast('和第 1 批重复');
    assert.equal(await isOpen('orderModal'), true, '有重复单号时不保存、弹窗留着');
    // 改正成 UPS 单号：承运商从自动识别的 DHL 换成 UPS。
    const lastNumber = page.locator('#orderForm [data-shipment-extra-row]').last().locator('[data-shipment-number]');
    await lastNumber.click();
    await lastNumber.evaluate(input => input.setSelectionRange(0, input.value.length));
    await page.keyboard.press('Backspace');
    await page.keyboard.type('1Z999AA10123456784', { delay:5 });
    await page.locator('#orderForm [name="note"]').click();
    await page.waitForFunction(() => document.querySelector('#orderForm [data-shipment-extra-row]:last-child [data-shipment-carrier]').value === 'UPS');
    assert.equal(await page.locator('#orderForm [data-shipment-extra-row]').last().locator('.shipment-row-hint').count(), 1, '和别的订单共用单号时有灰色提示');
    assert.match(await page.locator('#orderForm [data-shipment-extra-row]').last().locator('.shipment-row-hint').innerText(), /也在 K3001/);
    // 删光所有批次（第 1 行也能删）：旧的「异常」不能留在没有单号的单上。
    for (let i = 0; i < 3; i += 1) await page.locator('#orderForm [data-shipment-primary-row] [data-remove-shipment]').click();
    assert.equal(await page.locator('#orderForm input[name="trackingNumber"]').inputValue(), '');
    await page.getByRole('button', { name:'保存订单' }).click();
    await page.waitForFunction(() => (state.orders.find(o => o.id === 'x1').shipments || []).length === 0);
    await modalSaved();
    const x1 = await order('x1');
    assert.equal(x1.logisticsStatus, '已发货', '删光批次后物流状态按阶段重置');
    assert.doesNotMatch(await page.locator('#pipeline [data-id="x1"]').innerText(), /物流异常/, '卡片不再挂旧的物流异常');

    // ===== 07 P2：已完成订单不再自动查询；查询不刷新订单「最近更新」 =====
    const targets = await page.evaluate(() => trackingAutoUpdateTargets().map(item => item.clean));
    assert.ok(!targets.includes('6666666666'), '已完成订单里没签收的包裹不再查');
    const beforeUpdated = (await order('m1')).updated;
    trackResults['123456789012'] = { ok:true, status:'运输中' };
    await page.evaluate(async () => { applyTrackingResultToOrder('123456789012', await queryTrackingStatus('123456789012', 'FedEx')); });
    assert.equal((await order('m1')).updated, beforeUpdated, '状态没变的查询不刷新订单「最近更新」');

    // ===== 07 P2：CSV 带物流列 =====
    const csv = await page.evaluate(() => { let text = ''; window.download = (_name, content) => { text = content; }; exportCsv('all'); return text; });
    assert.match(csv, /"物流单号","物流汇总","首批发货日"/);
    assert.match(csv, /DHL 1234567890（已签收）；FedEx 123456789012（运输中）；DHL 2222222222（异常）/);
    assert.match(csv, /异常 1\/3 批/);

    assert.ok(trackCalls.every(call => /^(DHL|FedEx|UPS):/.test(call)), '只调用 mock 的 /api/track');
    assert.deepEqual(errors, []);
    console.log('Multi-shipment / partial shipment UI tests passed: UPS hold, aggregate status, drawer batches, partial shipment, raw carrier status, first tracking on edit, duplicates, carrier re-detect, delete-all, query scope, CSV.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
