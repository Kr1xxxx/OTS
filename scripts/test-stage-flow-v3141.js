const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

// V3.141 阶段规则（用户 2026-11-10 定）：订单按看板列从左到右走。
// 报价（没收定金）→ 生产中（收到定金或付清）→ 待发货（货做好了，等尾款）→ 已发货 → 已完成。
// 以前是「收到定金 = 待发货，付清 = 生产中」，推进按钮从报价先跳到第三列再回第二列。
// 这里覆盖：推进顺序、按收款定阶段、待发货收齐不退回、报价 → 生产中自动记定金（可撤销）、列副标题、抽屉阶段条顺序。
(async () => {
  const browser = await launchBrowser();
  try {
    const order = (id, extra) => ({ ...base, id, num:`SF-${id}`, client:`Flow ${id}`, amount:1000, paidAmount:0, orderType:'定金订单', stage:'quote', updated:`${day(1)} 09:00`, ...extra });
    const orders = [
      order('q1', { depositAmount:300, depositPercent:30 }),
      order('q2', { orderType:'全款订单', amount:500 }),
      order('p1', { stage:'production', paidAmount:300, depositAmount:300 }),
      order('p2', { stage:'production', amount:800, paidAmount:800 }),
      order('p3', { stage:'production', orderType:'全款订单', amount:600, paidAmount:600 }),
      order('b1', { stage:'balance', paidAmount:300, depositAmount:300 }),
      order('s1', { stage:'shipment', paidAmount:1000, logisticsStatus:'已发货', shippedAt:day(1) })
    ];
    const { page, errors, dialogs } = await openBoard(browser, { orders });

    // 推进顺序 = 看板列顺序；全款单和已经收齐的定金单没有尾款要等，从生产中直接进已发货。
    const next = await page.evaluate(() => Object.fromEntries(state.orders.map(o => [o.id, nextStageFor(o)])));
    assert.deepEqual(next, { q1:'production', q2:'production', p1:'balance', p2:'shipment', p3:'shipment', b1:'shipment', s1:'done' });
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#pipeline .board-column')].map(el => el.dataset.stage)), ['quote', 'production', 'balance', 'shipment']);

    // 按收款定阶段：没收定金 = 报价，收到定金或付清 = 生产中；全款单没付清留在报价。
    const inferred = await page.evaluate(() => {
      const infer = (orderType, amount, paidAmount) => inferNewOrderStage({ selectedStage:'quote', orderType, amount, paidAmount, trackingNumber:'' });
      const edit = (id, paidAmount, more = {}) => {
        const existing = state.orders.find(o => o.id === id);
        return resolveOrderSaveStage({ existing, selectedStage:existing.stage, orderType:existing.orderType, amount:existing.amount, paidAmount, trackingNumber:'', stageTouched:false, ...more });
      };
      return {
        depositNone:infer('定金订单', 1000, 0), depositPaid:infer('定金订单', 1000, 300), depositFull:infer('定金订单', 1000, 1000),
        fullPart:infer('全款订单', 1000, 300), fullPaid:infer('全款订单', 1000, 1000),
        legacyDeposit:migrateDepositStage({ stage:'deposit', amount:1000, paidAmount:300 }),
        legacyUnpaid:migrateDepositStage({ stage:'pi', amount:1000, paidAmount:0 }),
        // 编辑已有订单、只改已收：
        quoteGetsDeposit:edit('q1', 300), quoteNoteOnly:edit('q1', 0),
        productionMore:edit('p1', 600), productionCleared:edit('p1', 0), productionFullType:edit('p3', 200),
        balancePaidOff:edit('b1', 1000), balanceCleared:edit('b1', 0),
        manualStageWins:edit('q1', 300, { selectedStage:'balance', stageTouched:true })
      };
    });
    assert.deepEqual(inferred, {
      depositNone:'quote', depositPaid:'production', depositFull:'production', fullPart:'quote', fullPaid:'production',
      legacyDeposit:'production', legacyUnpaid:'quote',
      quoteGetsDeposit:'production', quoteNoteOnly:'quote',
      productionMore:'production', productionCleared:'quote', productionFullType:'production',
      balancePaidOff:'balance', balanceCleared:'balance',
      manualStageWins:'balance'
    });

    // 列副标题说明每一列在等什么。
    const subs = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#pipeline .board-column')].map(el => [el.dataset.stage, el.querySelector('.board-column-sub')?.textContent.trim()])));
    assert.equal(subs.production, '已收定金 · 生产中');
    assert.equal(subs.balance, '生产完成 · 等尾款');

    // 卡片上的推进按钮写的是下一列的名字。
    const acts = id => page.locator(`#pipeline .board-card[data-id="${id}"] .oc-act`).allTextContents();
    assert.deepEqual(await acts('q1'), ['收齐', '生产中']);
    assert.deepEqual(await acts('p1'), ['收齐', '待发货']);
    assert.deepEqual(await acts('b1'), ['收齐', '已发货']);
    assert.deepEqual(await acts('p3'), ['已发货']);

    // 报价 → 生产中：定金单还没收钱，按约定定金记为已收；撤销退回报价、定金恢复为没收。
    await h.clickQuick(page, 'q1', 'advance');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'q1').stage === 'production');
    let o = await h.order(page, 'q1');
    assert.equal(o.paidAmount, 300, '报价 → 生产中 should record the agreed deposit');
    assert.equal(o.depositAutoPaid, 300);
    await h.waitToast(page, '记为已收');
    await h.clickUndo(page, 'SF-q1');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'q1').stage === 'quote');
    o = await h.order(page, 'q1');
    assert.equal(o.paidAmount, 0, 'undo should clear the auto-recorded deposit');
    assert.equal(o.depositAutoPaid, undefined);
    await h.clearToasts(page);

    // 全款单从报价推进到生产中不自动记钱。
    await page.evaluate(() => { quickAdvanceStage('q2'); });
    await page.waitForFunction(() => state.orders.find(o => o.id === 'q2').stage === 'production');
    assert.equal((await h.order(page, 'q2')).paidAmount, 0);
    await h.clearToasts(page);

    // 生产中 → 待发货：只挪阶段，已收不变。
    await h.clickQuick(page, 'p1', 'advance');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'p1').stage === 'balance');
    assert.equal((await h.order(page, 'p1')).paidAmount, 300);
    await h.clearToasts(page);

    // 待发货收齐尾款：留在待发货等发货，不退回生产中；之后推进进已发货。
    await h.clickQuick(page, 'b1', 'paid');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'b1').paidAmount === 1000);
    o = await h.order(page, 'b1');
    assert.equal(o.stage, 'balance', '收齐 in 待发货 must not move the order back to 生产中');
    assert.match(o.logs[0].text, /收齐尾款/);
    assert.doesNotMatch(o.logs[0].text, /进入生产中/);
    assert.equal((await h.toasts(page)).some(text => text.includes('进入生产中')), false);
    assert.deepEqual(await acts('b1'), ['已发货']);
    await h.clickUndo(page, 'SF-b1');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'b1').paidAmount === 300);
    assert.equal((await h.order(page, 'b1')).stage, 'balance');
    await h.clearToasts(page);

    // 报价单一次收齐全款 = 确认下单，进生产中（不变）。
    await h.clickQuick(page, 'q1', 'paid');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'q1').stage === 'production');
    assert.equal((await h.order(page, 'q1')).paidAmount, 1000);
    await h.clearToasts(page);

    // 抽屉阶段条和看板同一个顺序；全款单没有待发货。
    const bar = async id => {
      await page.evaluate(id => { openOrderDetail(id); }, id);
      await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open') && document.querySelectorAll('#detailStageBar [data-detail-stage]').length > 0);
      const keys = await page.evaluate(() => [...document.querySelectorAll('#detailStageBar [data-detail-stage]')].map(el => el.dataset.detailStage));
      await page.evaluate(() => { closeOrderDetail(); });
      return keys;
    };
    assert.deepEqual(await bar('b1'), ['quote', 'production', 'balance', 'shipment', 'done']);
    assert.deepEqual(await bar('p3'), ['quote', 'production', 'shipment', 'done']);

    // 待收款提醒只催货已做好、等尾款的单（待发货），生产中只收了定金的单不催。
    const paymentTasks = await page.evaluate(() => buildTaskItems().filter(r => r.type === 'payment').map(r => r.orderId).sort());
    assert.deepEqual(paymentTasks, ['b1', 'p1']);

    assert.deepEqual(dialogs, [], 'no native dialogs');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Stage flow V3.141 passed: advance order follows the board, deposit received = 生产中, 收齐 in 待发货 stays, deposit auto-record + undo, subtitles, drawer stage bar.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
