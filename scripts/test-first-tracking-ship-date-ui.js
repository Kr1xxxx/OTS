#!/usr/bin/env node
// 已发货的单过几天才补第一个运单号：第一批沿用订单原来的发货日，不记成补单号那天。
// 三条路（抽屉「补运单号」、编辑弹窗加一行、运单号小卡）结果一致，重载（normalizeActiveOrder）后也不变。
// 对照：订单没有发货日 → 今天；已经有一批再加第二批 → 第二批是今天，订单发货日不变。
// 日期都按今天往前推，不写死。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');
const { pickConfirmChoice } = require('./helpers/confirm-dialog');

const pad = n => String(n).padStart(2, '0');
const dayStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return dayStr(d); };
const order = (id, extra = {}) => ({ ...base, id, num:`F-${id}`, client:`Client ${id}`, amount:650, paidAmount:650, orderType:'全款订单', stage:'shipment', logisticsStatus:'已发货', shippedAt:daysAgo(6), updated:`${daysAgo(6)} 10:00`, ...extra });

(async () => {
  const browser = await launchBrowser();
  try {
    const orders = [
      order('a1'),
      order('a2'),
      order('a3'),
      // 生产中、没有发货日：补单号选「只记单号」，这一批是今天。
      order('c1', { stage:'production', logisticsStatus:'未发货', shippedAt:'' }),
      // 已经有一批（6 天前），再加第二批：第二批今天，订单发货日不变。
      order('c2', { trackingNumber:'1234567890', shipments:[{ id:'s1', trackingNumber:'1234567890', carrier:'DHL', status:'已发货', shippedAt:daysAgo(6) }] })
    ];
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { port:freePortSync() });
    const get = id => page.evaluate(id => { const o = state.orders.find(x => x.id === id); return { shippedAt:o.shippedAt, batches:normalizeOrderShipments(o).map(s => s.shippedAt) }; }, id);
    const reloaded = id => page.evaluate(id => normalizeActiveOrder(JSON.parse(JSON.stringify(state.orders.find(x => x.id === id)))).shippedAt, id);
    const sixAgo = daysAgo(6);
    const today = page.evaluate(() => nowText().slice(0, 10));

    // 抽屉「物流」页补运单号。
    const drawerAdd = async (id, number) => {
      await page.evaluate(id => openOrderDetail(id, { tab:'logistics' }), id);
      await page.fill('[data-detail-ship-input]', number);
      await page.keyboard.press('Enter');
    };
    await drawerAdd('a1', '1Z999AA10123456784');
    await page.waitForFunction(() => normalizeOrderShipments(state.orders.find(o => o.id === 'a1')).length === 1);
    assert.deepEqual(await get('a1'), { shippedAt:sixAgo, batches:[sixAgo] }, '抽屉补第一个单号：沿用订单的发货日');
    assert.equal(await reloaded('a1'), sixAgo, '重载后订单发货日不变');
    await page.evaluate(() => closeOrderDetail());

    // 编辑弹窗加一行物流再保存。
    await page.evaluate(() => openOrder('a2'));
    await page.waitForSelector('#orderModal.open');
    if (!await page.$('#orderForm [data-shipment-editor] .shipment-row input')) await page.click('#orderForm [data-add-shipment]');
    await page.fill('#orderForm [data-shipment-editor] .shipment-row input', '1Z999AA10123456785');
    await page.evaluate(() => document.getElementById('orderForm').requestSubmit());
    await page.waitForFunction(() => normalizeOrderShipments(state.orders.find(o => o.id === 'a2')).length === 1);
    assert.deepEqual(await get('a2'), { shippedAt:sixAgo, batches:[sixAgo] }, '编辑弹窗补第一个单号：沿用订单的发货日');
    assert.equal(await reloaded('a2'), sixAgo);

    // 运单号小卡（原来就对，一起守住）。
    await page.evaluate(() => uiTrackingQuickCard('a3'));
    await page.fill('#trackingQuickCard input', '1Z999AA10123456786');
    await page.click('#trackingQuickCard [data-track-save]');
    await page.waitForFunction(() => normalizeOrderShipments(state.orders.find(o => o.id === 'a3')).length === 1);
    assert.deepEqual(await get('a3'), { shippedAt:sixAgo, batches:[sixAgo] });

    // 对照一：订单没有发货日。
    await drawerAdd('c1', '1Z999AA10123456787');
    await pickConfirmChoice(page, 1);
    assert.equal(await page.locator('#confirmOkBtn').innerText(), '只记单号');
    await page.click('#confirmOkBtn');
    await page.waitForFunction(() => normalizeOrderShipments(state.orders.find(o => o.id === 'c1')).length === 1);
    const c1 = await get('c1');
    assert.equal(c1.batches[0], await today, '订单没有发货日：这一批记今天');
    assert.equal((await page.evaluate(() => state.orders.find(o => o.id === 'c1').stage)), 'production', '只记单号，阶段不变');
    await page.evaluate(() => closeOrderDetail());

    // 对照二：第二批是今天。
    await drawerAdd('c2', '1Z999AA10123456788');
    await page.waitForFunction(() => normalizeOrderShipments(state.orders.find(o => o.id === 'c2')).length === 2);
    assert.deepEqual(await get('c2'), { shippedAt:sixAgo, batches:[sixAgo, await today] }, '第二批记今天，订单发货日不变');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('first tracking keeps the ship date ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
