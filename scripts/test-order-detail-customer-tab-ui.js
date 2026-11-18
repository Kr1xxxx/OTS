#!/usr/bin/env node
// 订单详情抽屉：订单的归订单，客户的归客户（页面第二轮 PR-A）。
// 1. 六个页签：订单信息 / 收款 / 物流 / 附件 / 客户 / 记录；
// 2. 「客户」页签：三个累计数（从「收款」搬来）、客户资料（没填的行不列）、客户备注（有才出）、历史订单（从「记录」搬来）；
// 3. 「订单信息」只留订单字段；客户设了永久备注时它是第一块，没设就不出；只读订单没写备注时不写「暂无备注」；
// 4. 「记录」最上面是飞书群通知，下面是订单时间线；
// 5. 「物流」没有「交期」；只有一批时不写汇总行；发货 / 更新哪个空就不写哪个；
//    已发货还没填单号时，发货日期写在空白卡的标题里，没发货的不写。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const orders = [
  { ...base, id:'s1', num:'K8101', client:'Sparse Buyer', stage:'production', orderType:'定金订单', amount:1200, depositAmount:400, paidAmount:400, createdAt:day(2), updated:`${day(2)} 10:00`,
    shipments:[{ id:'sh-1', trackingNumber:'1234567890', carrier:'DHL', status:'运输中', shippedAt:day(3) }] },
  { ...base, id:'f1', num:'K8102', client:'Full Buyer', stage:'production', orderType:'定金订单', amount:1000, depositAmount:300, paidAmount:300, createdAt:day(3), updated:`${day(3)} 10:00`,
    feishuNotification:{ requested:true, status:'failed', error:'网络超时', chatName:'外贸订单通知群' },
    shipments:[
      { id:'sh-2', trackingNumber:'9876543210', carrier:'DHL', status:'已签收', shippedAt:day(2), updated:`${day(4)} 09:00` },
      { id:'sh-3', trackingNumber:'5555555555', carrier:'DHL', status:'运输中' }
    ] },
  { ...base, id:'f2', num:'K8103', client:'Full Buyer', stage:'quote', orderType:'全款订单', amount:500, paidAmount:0, createdAt:day(4), updated:`${day(4)} 10:00` },
  { ...base, id:'n1', num:'K8104', client:'Sparse Buyer', stage:'shipment', orderType:'全款订单', amount:800, paidAmount:800, createdAt:day(6), shippedAt:day(5), updated:`${day(5)} 10:00` },
  { ...base, id:'n2', num:'K8105', client:'Sparse Buyer', stage:'production', orderType:'全款订单', amount:900, paidAmount:900, createdAt:day(6), updated:`${day(6)} 10:00` }
];
const customers = {
  'Sparse Buyer':{ client:'Sparse Buyer', contact:'Sam Example', country:base.country, currency:'USD' },
  'Full Buyer':{ client:'Full Buyer', contact:'Fay Example', email:'fay@buyer.test', phone:'+1 555 0199', address:'1 Example Road, Testville', country:base.country, currency:'USD',
    primaryContactMethod:'WhatsApp', permanentNote:'只用无品牌包装', note:'喜欢深色系' }
};
const placeholders = /未填写|未设置|暂无/;

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs, context } = await openBoard(browser, { orders, customers }, { port:47961 });
    const panel = tab => page.locator(`#orderDetailBody [data-detail-tab="${tab}"]`);
    const showTab = async tab => {
      await h.click(page, `#detailTabs [data-detail-tab-btn="${tab}"]`, `drawer tab ${tab}`);
      await page.waitForFunction(tab => !document.querySelector(`#orderDetailBody [data-detail-tab="${tab}"]`)?.hidden, tab);
    };
    const open = async (id, tab) => {
      await page.evaluate(({ id, tab }) => openOrderDetail(id, tab ? { tab } : {}), { id, tab });
      await page.waitForFunction(id => detailOrderId === id && document.getElementById('orderDetailDrawer').classList.contains('open'), id);
    };

    // ---- 1. 六个页签的顺序 ----
    await open('s1');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#detailTabs [data-detail-tab-btn]')].map(el => [el.dataset.detailTabBtn, el.textContent.trim()])),
      [['info', '订单信息'], ['payment', '收款'], ['logistics', '物流'], ['attachments', '附件'], ['customer', '客户'], ['records', '记录']]);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#orderDetailBody [data-detail-tab]')].map(el => el.dataset.detailTab)),
      ['info', 'payment', 'logistics', 'attachments', 'customer', 'records'], 'one panel per tab, same order');

    // ---- 2. 资料只填了联系人的客户 ----
    const sparseInfo = await panel('info').innerText();
    assert.doesNotMatch(sparseInfo, /客户资料|客户永久备注|客户备注|飞书群通知/, `订单信息只留订单字段：${sparseInfo}`);
    assert.equal(await panel('info').locator('[data-detail-permanent-note]').count(), 0, 'no permanent note set: no section');
    await showTab('customer');
    const sparse = await panel('customer').innerText();
    assert.doesNotMatch(sparse, placeholders, `客户页签里没有占位字：${sparse}`);
    const rows = await panel('customer').locator('.order-detail-customer-info-row span').allInnerTexts();
    assert.deepEqual(rows, ['客户等级', '联系人', '交易偏好'], 'only the rows with content are listed');
    assert.ok((await panel('customer').locator('.order-detail-customer-info-row strong').first().innerText()).trim(), 'the level row always has a value');
    assert.match(sparse, /Sam Example/);
    assert.equal(await panel('customer').locator('.order-detail-customer-note').count(), 0, 'no customer note: no section');
    assert.equal(await panel('customer').locator('[data-detail-open-customer]').count(), 1, 'the 客户档案 link is in the customer tab');

    // ---- 5. 物流：一批，没有交期，没有重复的汇总，空的更新时间不写 ----
    await showTab('logistics');
    const logi = await panel('logistics').innerText();
    assert.doesNotMatch(logi, /交期|首批发出|客户要求收到/, `物流页没有交期：${logi}`);
    assert.equal(await panel('logistics').locator('.detail-ship-summary').count(), 0, 'one shipment: no summary line');
    assert.equal(await panel('logistics').locator('.detail-ship-meta').innerText(), `发货 ${day(3)}`, 'an empty update time is left out');
    assert.match(logi, /物流 · 1 批/);

    // ---- 3. 永久备注置顶；收款没有累计数；客户页签的累计数和原来一样 ----
    await open('f1', 'info');
    const firstInfo = page.locator('#orderDetailBody [data-detail-tab="info"] > :first-child');
    assert.equal(await firstInfo.getAttribute('data-detail-permanent-note'), '', 'the permanent note is the first block of 订单信息');
    assert.match(await firstInfo.innerText(), /客户永久备注 · 每笔订单显示[\s\S]*只用无品牌包装/);
    assert.equal(await panel('payment').locator('.order-detail-customer-stats').count(), 0, '收款 no longer shows the customer totals');
    await showTab('customer');
    const expected = await page.evaluate(() => {
      const record = orderDetailCustomerRecord(state.orders.find(o => o.id === 'f1'));
      return [money(record.total, 'USD', 2), `${record.orderCount} 单`, money(record.due, 'USD', 2)];
    });
    assert.equal(expected[1], '2 单');
    assert.deepEqual(await panel('customer').locator('.order-detail-customer-stat strong').allInnerTexts(), expected, 'the three totals are the same numbers as before');
    const full = await panel('customer').innerText();
    assert.doesNotMatch(full, placeholders);
    assert.deepEqual(await panel('customer').locator('.order-detail-customer-info-row span').allInnerTexts(),
      ['客户等级', '联系人', '邮箱', '电话 / WhatsApp', '联系偏好', '地址', '交易偏好']);
    assert.match(await panel('customer').locator('.order-detail-customer-note').innerText(), /喜欢深色系/);
    assert.deepEqual(await panel('customer').locator('[data-order-customer-order]').evaluateAll(list => list.map(el => el.dataset.orderCustomerOrder)).then(ids => ids.sort()), ['f1', 'f2'], 'the history orders moved here');
    assert.match(full, /历史订单\s*最近 2 单/);

    // ---- 4. 记录：飞书块在最上面，历史订单不在这里 ----
    await showTab('records');
    assert.equal(await page.locator('#orderDetailBody [data-detail-tab="records"] > :first-child').getAttribute('data-order-notification-section'), '');
    assert.equal(await panel('records').locator('[data-retry-order-notification="f1"]').count(), 1, 'resend is here');
    assert.equal(await panel('records').locator('.detail-timeline').count(), 1);
    assert.equal(await panel('records').locator('[data-order-customer-order]').count(), 0);
    // 抽屉里换掉飞书块（重新发送之后）仍是就地替换，留在「记录」里。
    await page.evaluate(() => { applyOrderNotificationResult('f1', { status:'sent', sentAt:'2026-01-02 10:00', chatName:'外贸订单通知群' }); refreshOrderNotificationSection('f1'); });
    await page.waitForFunction(() => /发送时间/.test(document.querySelector('#orderDetailBody [data-detail-tab="records"] [data-order-notification-section]')?.textContent || ''));
    assert.equal(await page.evaluate(() => document.querySelectorAll('#orderDetailBody [data-order-notification-section]').length), 1);

    // ---- 5b. 两批：汇总照旧；第二批没有发货和更新时间，那一行不出 ----
    await showTab('logistics');
    assert.match(await panel('logistics').locator('.detail-ship-summary').innerText(), /2 批/);
    assert.deepEqual(await panel('logistics').locator('.detail-ship-row').evaluateAll(list => list.map(row => row.querySelector('.detail-ship-meta')?.textContent || '')),
      [`发货 ${day(2)} · 更新 ${day(4)} 09:00`, '']);

    // ---- 5c. 已发货没填单号：发货日期写在空白卡标题里；没发货的不写日期 ----
    await open('n1', 'logistics');
    assert.equal(await panel('logistics').locator('.detail-ship-row').count(), 0);
    assert.equal(await panel('logistics').locator('.detail-ship-empty strong').innerText(), `已发货 ${day(5)} · 还没填物流单号`);
    await open('n2', 'logistics');
    assert.equal(await panel('logistics').locator('.detail-ship-empty strong').innerText(), '还没发货');

    // ---- 复购待办直达「客户」页签 ----
    assert.equal(await page.evaluate(() => taskDetailTab({ type:'repurchase' })), 'customer');

    // ---- 3b. 只读（已删除）订单没写备注：不写「暂无备注」 ----
    await page.evaluate(() => closeOrderDetail());
    await page.evaluate(() => softDeleteOrder('s1'));
    await page.waitForFunction(() => (state.deletedOrders || []).some(o => o.id === 's1'));
    await open('s1', 'info');
    const readOnly = await panel('info').innerText();
    assert.match(readOnly, /Sparse Buyer/);
    assert.doesNotMatch(readOnly, /订单备注|暂无备注/, `只读订单没有备注时整节不出：${readOnly}`);

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    await context.close();
    console.log('Order detail customer tab tests passed: six tabs, customer tab rows without placeholders, totals moved, permanent note on top, Feishu block in records, logistics without 交期, ship date on the empty card, read-only note.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
