const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

// 「进已发货 = 尾款视为收齐」这条规则本身不动（口径待用户定），这里只测每个入口都记下真实已收、退回时还原：
// - 编辑弹窗选「已发货」：提示写明没收的尾款按已收齐记、退回时恢复为多少；保存提示写出金额；
// - 已发货时只在抽屉里改备注保存：记下的真实已收不丢，之后拖回生产中照样还原；
// - 编辑弹窗第一次补单号自动进已发货：同样记下真实已收；
// - 载入时就在已发货、已收没满的单：载入补记真实已收，编辑弹窗改回「尾款」时已收还原、发货状态清掉；
// - 抽屉阶段条从已完成点回生产中：还原；
// - 卡片上的「收齐」马上撤销：已收、阶段还原，操作记录只追加不删除。
const deposit = { orderType:'定金订单', amount:1000, depositAmount:300 };
const orders = [
  { ...base, ...deposit, id:'e1', num:'K501', client:'Modal Ship', paidAmount:300, stage:'production', updated:`${day(4)} 09:01` },
  { ...base, ...deposit, id:'e2', num:'K502', client:'Loaded Ship', paidAmount:300, stage:'shipment', logisticsStatus:'已发货', shippedAt:day(2), updated:`${day(4)} 09:02` },
  { ...base, ...deposit, id:'e3', num:'K503', client:'Done Back', amount:800, depositAmount:200, paidAmount:200, stage:'done', logisticsStatus:'已签收', shippedAt:day(2), updated:`${day(4)} 09:03` },
  { ...base, id:'e4', num:'K504', client:'Paid Undo', amount:500, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(4)} 09:04`, logs:[{ time:`${day(1)} 08:00`, text:'创建订单' }] },
  { ...base, ...deposit, id:'e5', num:'K505', client:'First Tracking', paidAmount:300, stage:'production', updated:`${day(4)} 09:05` },
  // 导入文件里阶段写成中文名 / 大小写不同的英文：认得出来，不再一律放进报价。
  { ...base, ...deposit, id:'e6', num:'K506', client:'Chinese Stage', paidAmount:300, stage:'尾款', updated:`${day(4)} 09:06` },
  { ...base, id:'e7', num:'K507', client:'Cased Stage', amount:600, paidAmount:600, orderType:'全款订单', stage:' Production ', updated:`${day(4)} 09:07` }
];

const field = (page, name) => page.locator(`#orderForm [name="${name}"]`);
const stageHint = page => page.locator('#orderForm [data-stage-hint]').evaluate(el => el.hidden ? '' : el.textContent.trim());
async function openEdit(page, id) {
  await h.rightClick(page, id);
  await page.locator('.board-menu [data-board-menu="edit"]').click();
  await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
}
async function saveModal(page) {
  await page.getByRole('button', { name:'保存订单' }).click();
  await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
  await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
}
async function skipTrackingCard(page) {
  if (await page.locator('#trackingQuickCard [data-track-skip]').count()) {
    await page.locator('#trackingQuickCard [data-track-skip]').click();
    await page.waitForFunction(() => !document.getElementById('trackingQuickCard'));
  }
}

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs } = await openBoard(browser, { orders }, { width:1440, height:920 });

    // 载入：已发货但只收了 300 的单，已收按全额显示，真实的 300 记下来。
    let e2 = await h.order(page, 'e2');
    assert.equal(e2.paidAmount, 1000);
    assert.equal(e2.paidBeforeSettle, 300, '载入已发货的单时记下真实已收');
    assert.equal((await h.order(page, 'e6')).stage, 'balance', '阶段写成「尾款」的单放进尾款');
    assert.equal((await h.order(page, 'e7')).stage, 'production', '阶段写成「 Production 」的单放进生产中');
    assert.equal(await page.locator('#pipeline .board-column[data-stage="balance"] .board-card[data-id="e6"]').count(), 1);

    // 1. 编辑弹窗选「已发货」：提示写明尾款按已收齐记、退回时恢复为多少。
    await openEdit(page, 'e1');
    await page.locator('#orderForm [data-binary-value="shipment"]').click();
    assert.equal(await stageHint(page), '保存后还没收的 $700 USD 会按已收齐记，退回前面的阶段时恢复为已收 $300 USD');
    await h.clearToasts(page);
    await saveModal(page);
    let e1 = await h.order(page, 'e1');
    assert.equal(e1.stage, 'shipment');
    assert.equal(e1.paidAmount, 1000);
    assert.equal(e1.paidBeforeSettle, 300, '编辑弹窗进已发货也记下真实已收');
    await h.waitToast(page, '还没收的 $700 USD 按已收齐记');
    await skipTrackingCard(page);

    // 2. 已发货时只在抽屉里改备注保存：真实已收不丢。（没单号的已发货卡片单击是先补单号，这里用右键「打开订单」进详情。）
    await h.rightClick(page, 'e1');
    await page.locator('.board-menu [data-board-menu="open"]').click();
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    await page.locator('#orderDetailBody [data-dedit="note"]').click();
    await page.keyboard.type('only note');
    await page.locator('#detailSaveBtn').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'e1').note === 'only note');
    // 等保存真正结束（按钮不再是「保存中」、没有待保存的数据），再按 Esc 关抽屉。
    await page.waitForFunction(() => !document.getElementById('detailSaveBtn').dataset.morph && !window.pendingSaveStatus().pending && !window.pendingSaveStatus().saving);
    e1 = await h.order(page, 'e1');
    assert.equal(e1.paidBeforeSettle, 300, '已发货时保存别的字段，记下的真实已收不能丢');
    assert.equal(e1.stage, 'shipment');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));

    // 3. 真实鼠标拖回生产中：已收恢复为 300，没有物流单号的话发货状态清掉。
    await h.drag(page, 'e1', 'production');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'e1').stage === 'production');
    e1 = await h.order(page, 'e1');
    assert.equal(e1.paidAmount, 300, '拖回生产中恢复真实已收');
    assert.equal(e1.paidBeforeSettle, undefined);
    assert.equal(e1.logisticsStatus, '未发货');
    assert.match(e1.logs[0].text, /已付款恢复为 \$300 USD/);

    // 4. 编辑弹窗第一次补单号，按单号进已发货：也记下真实已收。
    await openEdit(page, 'e5');
    await field(page, 'trackingNumber').click();
    await page.keyboard.type('1Z999AA10123456784');
    await page.waitForFunction(() => /按物流单号自动放到「已发货」/.test(document.querySelector('#orderForm [data-stage-hint]')?.textContent || ''));
    assert.match(await stageHint(page), /还没收的 \$700 USD 会按已收齐记，退回前面的阶段时恢复为已收 \$300 USD/);
    await saveModal(page);
    const e5 = await h.order(page, 'e5');
    assert.equal(e5.stage, 'shipment');
    assert.equal(e5.paidBeforeSettle, 300, '补单号进已发货也记下真实已收');

    // 5. 载入时就在已发货的单：编辑弹窗改回「尾款」，已收恢复为 300，没有物流记录的发货状态清掉。
    await openEdit(page, 'e2');
    await page.locator('#orderForm [data-binary-value="balance"]').click();
    await saveModal(page);
    e2 = await h.order(page, 'e2');
    assert.equal(e2.stage, 'balance', '用户选的阶段照用');
    assert.equal(e2.paidAmount, 300, '退回尾款恢复真实已收，不再一直显示已收齐');
    assert.equal(e2.paidBeforeSettle, undefined);
    assert.equal(e2.logisticsStatus, '未发货');
    assert.equal(e2.shippedAt, '');
    assert(e2.logs.some(log => /阶段从 已发货 退回 尾款.*已付款恢复为 \$300 USD/.test(log.text)), `退回写进操作记录：${JSON.stringify(e2.logs.slice(0, 2))}`);

    // 6. 抽屉阶段条：已完成 → 生产中，还原载入时记下的 200。
    assert.equal((await h.order(page, 'e3')).paidBeforeSettle, 200);
    await page.evaluate(() => openOrderDetail('e3'));
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    await page.locator('#detailStageBar [data-detail-stage="production"]').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'e3').stage === 'production');
    const e3 = await h.order(page, 'e3');
    assert.equal(e3.paidAmount, 200, '阶段条退回也恢复真实已收');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));

    // 7. 卡片上的「收齐全款」马上撤销：已收、阶段还原；操作记录只追加，原来的和「收齐」那条都还在。
    await h.clearToasts(page);
    await h.clickQuick(page, 'e4', 'paid');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'e4').paidAmount === 500);
    await h.clickUndo(page, 'K504 Paid Undo 已收齐');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'e4').paidAmount === 0);
    const e4 = await h.order(page, 'e4');
    assert.equal(e4.stage, 'quote');
    const texts = e4.logs.map(log => log.text);
    assert(texts.includes('创建订单'), '原来的记录不能被删');
    assert(texts.some(text => /^收齐全款/.test(text)), `「收齐」那条记录保留：${texts}`);
    assert(/撤销/.test(texts[0]), `最新一条是撤销：${texts}`);

    // 8. 金额页「阶段金额构成」：每个阶段的颜色和看板列圆点一样（以前按排第几配色，生产中用了报价的颜色……）。
    await page.locator('.nav-item[data-page="amount"]').click();
    await page.waitForSelector('#amountSideChart .side-dot');
    const colors = await page.evaluate(() => {
      const byName = Object.fromEntries(stageDefs.map(s => [s.name, s.key]));
      return [...document.querySelectorAll('#amountSideChart .side-bar-row')].map(row => {
        const name = row.querySelector('.side-bar-head span').textContent.split(' · ')[0].trim();
        const key = byName[name];
        const head = document.querySelector(`#pipeline .board-column[data-stage="${key}"] .board-column-title`);
        return { name, dot:getComputedStyle(row.querySelector('.side-dot')).backgroundColor, board:head ? getComputedStyle(head, '::before').backgroundColor : '' };
      });
    });
    assert(colors.filter(item => item.board && item.board !== 'rgba(0, 0, 0, 0)').length >= 3, `阶段金额里至少有生产中、尾款、已发货，并能量到看板圆点颜色：${JSON.stringify(colors)}`);
    colors.filter(item => item.board).forEach(item => assert.equal(item.dot, item.board, `「${item.name}」环图颜色和看板圆点不一样`));
    assert.equal(new Set(colors.map(item => item.dot)).size, colors.length, '每个阶段颜色不同');

    await h.flush(page);
    const saved = store.current.data.orders.find(o => o.id === 'e1');
    assert.equal(saved.paidAmount, 300, '还原后的已收已保存');
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], '不能出现原生 alert / confirm');
    console.log('Stage settle restore UI passed: modal 已发货, first tracking and load all record the real paid amount; a drawer note save keeps it; drag back, modal back to 尾款 and the drawer stage bar restore it and clear the shipping status; 收齐 undo restores and only appends logs; Chinese / cased stage names load into the right column; the stage donut uses the board stage colours.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
