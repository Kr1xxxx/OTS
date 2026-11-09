const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

// 看板真实鼠标拖拽（mouse.down / move / up）：
// - 拖错列再拖回：报价 → 尾款自动记的定金，拖回报价时恢复为没收；已发货 → 生产中恢复「尾款视为已收齐」之前的真实已收；
// - 放不进去的列（全款 → 尾款、草稿 → 已发货）拖过去时画成禁止样式，松手不移动、说明原因、不播落地动画；
// - 拖出去带的是给人看的文字，不是内部 id；
// - 提示写明是哪张单；同一张单只留最新一条撤销，撤销只还原那一次移动、记录只追加；之后又被改过的撤销作废；
// - 运单号小卡正在输入时，下一次拖进已发货不会把它替换掉。
const orders = [
  { ...base, id:'q1', num:'K101', client:'Quote Deposit', amount:1000, paidAmount:0, depositAmount:300, depositPercent:30, orderType:'定金订单', stage:'quote', updated:`${day(1)} 09:01` },
  { ...base, id:'q2', num:'K102', client:'Quote Full', amount:500, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(1)} 09:02` },
  { ...base, id:'d1', num:'K103', client:'Draft Buyer', amount:900, paidAmount:0, depositAmount:270, orderType:'定金订单', stage:'quote', isDraft:true, updated:`${day(1)} 09:03` },
  { ...base, id:'b1', num:'K104', client:'Real Deposit', amount:2000, paidAmount:600, depositAmount:600, orderType:'定金订单', stage:'balance', updated:`${day(1)} 09:04` },
  { ...base, id:'p1', num:'K105', client:'Prod Deposit', amount:1000, paidAmount:300, depositAmount:300, orderType:'定金订单', stage:'production', updated:`${day(1)} 09:05` },
  { ...base, id:'p2', num:'K106', client:'Prod Second', amount:700, paidAmount:700, orderType:'全款订单', stage:'production', updated:`${day(1)} 09:06` },
  { ...base, id:'p3', num:'K107', client:'Prod Third', amount:800, paidAmount:800, orderType:'全款订单', stage:'production', updated:`${day(1)} 09:07` },
  { ...base, id:'w1', num:'K108', client:'Paid Then Edit', amount:1000, paidAmount:0, depositAmount:300, orderType:'定金订单', stage:'quote', updated:`${day(1)} 09:08` }
];

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs } = await openBoard(browser, { orders });
    // 记下每次 drop 时拖拽带的数据（只读，不拦截）。
    await page.evaluate(() => {
      window.__drops = [];
      document.addEventListener('drop', e => { window.__drops.push({ types:[...e.dataTransfer.types], text:e.dataTransfer.getData('text/plain') }); }, true);
    });

    // ===== 08 P1-3：报价 → 尾款自动记定金，拖回报价恢复为没收 =====
    await h.drag(page, 'q1', 'balance');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'q1').stage === 'balance');
    let q1 = await h.order(page, 'q1');
    assert.equal(q1.paidAmount, 300, '报价 → 尾款按约定定金记为已收');
    await h.waitToast(page, 'K101 Quote Deposit 已移动到待发货');
    assert.match((await h.toasts(page)).join('|'), /K101 Quote Deposit 已移动到待发货定金 \$300 USD 记为已收/);
    assert.equal(await page.locator('#pipeline .board-card[data-id="q1"]').evaluate(el => el.classList.contains('just-landed')), true, '移动成功才播落地动画');
    const drop = await page.evaluate(() => window.__drops.at(-1));
    assert(drop.types.includes('application/x-ots-order'), `拖拽用自己的类型传订单：${drop.types}`);
    assert.match(drop.text, /^K101 Quote Deposit \$1,000/, '拖到别的 App 里是给人看的文字');
    assert.doesNotMatch(drop.text, /\bq1\b/, '不再带出内部 id');
    await h.clearToasts(page); // 6 秒撤销已经过去，用户发现拖错了，再拖回来
    await h.drag(page, 'q1', 'quote');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'q1').stage === 'quote');
    q1 = await h.order(page, 'q1');
    assert.equal(q1.paidAmount, 0, '拖回报价：自动记的定金恢复为没收（报价 = 没收定金）');
    assert.equal(q1.depositAutoPaid, undefined);
    assert.match(q1.logs[0].text, /订单阶段从 待发货 调整为 报价，自动记的定金 \$300 USD 恢复为未收/);
    await h.waitToast(page, 'K101 Quote Deposit 已移动到报价');
    assert.match((await h.toasts(page)).join('|'), /已收恢复为 \$0/);
    await h.flush(page);
    assert.equal(store.current.data.orders.find(o => o.id === 'q1').paidAmount, 0, '恢复后的已收存进了数据库');

    // 手工登记的真实定金拖回报价：不清零，提示里说清楚。
    await h.drag(page, 'b1', 'quote');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'b1').stage === 'quote');
    assert.equal((await h.order(page, 'b1')).paidAmount, 600);
    await h.waitToast(page, 'K104 Real Deposit 已移动到报价');
    assert.match((await h.toasts(page)).join('|'), /已收 \$600 USD 是登记过的收款，没有清零/);

    // ===== 09 P1-1：生产中（实收 300）→ 已发货 → 拖回生产中，恢复 300 =====
    await h.drag(page, 'p1', 'shipment');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'p1').stage === 'shipment');
    let p1 = await h.order(page, 'p1');
    assert.equal(p1.paidAmount, 1000);
    assert.equal(p1.paidBeforeSettle, 300);
    await h.waitToast(page, '尾款 $700 USD 视为已收齐');
    await page.waitForSelector('#trackingQuickCard');
    await page.locator('#trackingQuickCard [data-track-skip]').click();
    await page.waitForFunction(() => !document.getElementById('trackingQuickCard'));
    await h.drag(page, 'p1', 'production');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'p1').stage === 'production');
    p1 = await h.order(page, 'p1');
    assert.equal(p1.paidAmount, 300, '退回生产中也恢复真实已收（以前一直是 $1,000）');
    assert.equal(p1.paidBeforeSettle, undefined);
    assert.equal(p1.logisticsStatus, '未发货', '没有单号的单退回后不再标成已发货');

    // ===== 08 P2-4 / P2-2：放不进去的列 =====
    await h.clearToasts(page);
    await h.drag(page, 'q2', 'balance', { beforeUp:async () => {
      const cls = await page.locator('#pipeline .board-column[data-stage="balance"]').getAttribute('class');
      assert.match(cls, /drag-invalid/, '全款单拖到尾款：列画成禁止样式');
      assert.doesNotMatch(cls, /drag-over/, '不再高亮成可以放');
    } });
    assert.equal((await h.order(page, 'q2')).stage, 'quote');
    await h.waitToast(page, 'K102 Quote Full 没有移动');
    assert.match((await h.toasts(page)).join('|'), /全款订单没有待发货阶段/);
    assert.equal(await page.locator('#pipeline .board-card[data-id="q2"]').evaluate(el => el.classList.contains('just-landed')), false, '被拒绝时不播落地动画');
    await h.drag(page, 'd1', 'shipment', { beforeUp:async () => {
      assert.match(await page.locator('#pipeline .board-column[data-stage="shipment"]').getAttribute('class'), /drag-invalid/);
    } });
    const d1 = await h.order(page, 'd1');
    assert.equal(d1.stage, 'quote', '草稿不能直接拖到已发货');
    assert.equal(d1.paidAmount, 0, '草稿没有被记成全额已收');
    assert.equal(d1.isDraft, true);
    await h.waitToast(page, '草稿还没转成正式订单');
    // 同列松手：什么都不变，也不播落地动画。
    const q2Logs = (await h.order(page, 'q2')).logs.length;
    await h.drag(page, 'q2', 'quote');
    assert.equal((await h.order(page, 'q2')).logs.length, q2Logs);
    assert.equal(await page.locator('#pipeline .board-card[data-id="q2"]').evaluate(el => el.classList.contains('just-landed')), false);

    // ===== 08 P1-4：同一张单连拖两次，只留最新一条撤销；撤销只还原那一次 =====
    await h.clearToasts(page);
    await h.drag(page, 'q2', 'production');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'q2').stage === 'production');
    await h.drag(page, 'q2', 'shipment');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'q2').stage === 'shipment');
    await page.locator('#trackingQuickCard [data-track-skip]').click();
    await page.waitForFunction(() => !document.getElementById('trackingQuickCard'));
    const q2Toasts = (await h.toasts(page)).filter(text => text.includes('K102'));
    assert.equal(q2Toasts.length, 1, `同一张单只留最新一条提示：${q2Toasts}`);
    assert.match(q2Toasts[0], /K102 Quote Full 已移动到已发货/);
    const q2Before = (await h.order(page, 'q2')).logs.length;
    await h.clickUndo(page, 'K102 Quote Full 已移动到已发货');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'q2').stage === 'production');
    const q2 = await h.order(page, 'q2');
    assert.equal(q2.paidAmount, 0, '撤销「进已发货」：回到生产中、已收回到 0（只还原那一次移动）');
    assert.equal(q2.logisticsStatus, '未发货');
    assert.equal(q2.logs.length, q2Before + 1, '撤销只追加一条记录');
    assert.match(q2.logs[0].text, /撤销阶段调整：恢复为 生产中/);
    await h.waitToast(page, '已撤销：K102 Quote Full 回到生产中');

    // 两张单各拖一次：两条提示都在，各撤各的。
    await h.clearToasts(page);
    await h.drag(page, 'p2', 'shipment');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'p2').stage === 'shipment');
    await page.locator('#trackingQuickCard [data-track-skip]').click();
    await page.waitForFunction(() => !document.getElementById('trackingQuickCard'));
    await h.drag(page, 'p3', 'shipment');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'p3').stage === 'shipment');
    await page.locator('#trackingQuickCard [data-track-skip]').click();
    await page.waitForFunction(() => !document.getElementById('trackingQuickCard'));
    await h.clickUndo(page, 'K106 Prod Second');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'p2').stage === 'production');
    assert.equal((await h.order(page, 'p3')).stage, 'shipment', '撤销 K106 不影响 K107');

    // 之后又被改过（编辑弹窗把阶段改了）：较早的「收齐」撤销作废，不动数据、不删记录。
    await h.clearToasts(page);
    await h.clickQuick(page, 'w1', 'paid');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'w1').stage === 'production');
    await h.waitToast(page, 'K108 Paid Then Edit 已收齐');
    await h.rightClick(page, 'w1');
    await page.locator('.board-menu [data-board-menu="edit"]').click();
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await page.locator('#orderForm [data-binary-value="shipment"]').click();
    await page.getByRole('button', { name:'保存订单' }).click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'w1').stage === 'shipment');
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    const w1Before = await h.order(page, 'w1');
    await h.clickUndo(page, 'K108 Paid Then Edit 已收齐');
    await h.waitToast(page, 'K108 Paid Then Edit 之后又改动过，这条撤销已失效');
    const w1After = await h.order(page, 'w1');
    assert.equal(w1After.stage, 'shipment', '作废的撤销不能把阶段退回报价');
    assert.equal(w1After.paidAmount, w1Before.paidAmount);
    assert.equal(w1After.logisticsStatus, w1Before.logisticsStatus);
    assert.deepEqual(w1After.logs, w1Before.logs, '作废的撤销不改、不删操作记录');

    // ===== 08 P2-11：运单号小卡正在输入时，下一次进已发货不替换它 =====
    await page.evaluate(() => { document.getElementById('trackingQuickCard')?.remove(); });
    await h.drag(page, 'p2', 'shipment');
    await page.waitForSelector('#trackingQuickCard[data-order-id="p2"]');
    await page.locator('#trackingQuickCard input').click();
    await page.keyboard.type('1Z999AA10123456784', { delay:5 });
    await h.drag(page, 'p1', 'shipment');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'p1').stage === 'shipment');
    assert.equal(await page.locator('#trackingQuickCard').getAttribute('data-order-id'), 'p2', '正在填的小卡没被替换');
    assert.equal(await page.locator('#trackingQuickCard input').inputValue(), '1Z999AA10123456784', '已经输入的单号还在');
    await page.locator('#trackingQuickCard input').press('Enter');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'p2').trackingNumber === '1Z999AA10123456784');
    await page.waitForSelector('#trackingQuickCard[data-order-id="p1"]');

    await h.flush(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], '不能出现原生 alert / confirm');
    console.log('Board drag UI passed: real-mouse drag back restores the auto deposit / settled payment, invalid columns refuse with a reason, human-readable drag payload, per-order undo with order number, stale undo refused, tracking card queue.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
