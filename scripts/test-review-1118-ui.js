#!/usr/bin/env node
// 第七轮 bug 审查（2026-11-18）待办里的三条，在真页面上跑（续费停止日那条在 test-subscription-schedule.js）：
// 1. 带「未发货」或 UPS 批次的单直接移到已完成：订单的发货日当场写上，和重新载入后一样。
// 2. 粘贴识别填进「一起确认客户和订单」的坏单号不算「以前存的单号」，照样拦；打开旧单时存着的坏单号仍只提示。
// 3. 定金单定金没填、已收有数：定金按已收记（用户 2026-11-18 定的）；以前存成 0 的单载入就按已收算，
//    不改直接保存不再改定金、不多一条记录。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const pad = n => String(n).padStart(2, '0');
const dayStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return dayStr(d); };
const order = (id, extra = {}) => ({ ...base, id, num:`R-${id}`, client:`Client ${id}`, amount:650, paidAmount:195, orderType:'定金订单', depositAmount:195, stage:'production', updated:`${daysAgo(2)} 10:00`, ...extra });

(async () => {
  const browser = await launchBrowser();
  try {
    const orders = [
      order('d1', { shipments:[{ id:'s1', trackingNumber:'1234567890', carrier:'DHL', status:'未发货', shippedAt:'' }], trackingNumber:'1234567890', carrier:'DHL' }),
      order('u1', { shipments:[{ id:'s2', trackingNumber:'1Z999AA10123456784', carrier:'UPS', status:'已发货', shippedAt:'' }], trackingNumber:'1Z999AA10123456784', carrier:'UPS' }),
      order('k1', { stage:'balance', shipments:[{ id:'s3', trackingNumber:'1Z12345678', carrier:'UPS', status:'未发货', shippedAt:'' }], trackingNumber:'1Z12345678', carrier:'UPS' }),
      order('z1', { stage:'balance', depositAmount:0, depositPercent:0, paidAmount:100 })
    ];
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { port:freePortSync() });

    // 1. 直接移到已完成：内存里的发货日 = 重新载入后的发货日 = 今天。
    for (const id of ['d1', 'u1']) {
      const got = await page.evaluate(id => {
        moveOrderToStage(id, 'done');
        const o = state.orders.find(x => x.id === id);
        return { stage:o.stage, memory:o.shippedAt, reloaded:normalizeActiveOrder(JSON.parse(JSON.stringify(o))).shippedAt, batch:o.shipments[0].shippedAt };
      }, id);
      assert.equal(got.stage, 'done', `${id} 移到已完成`);
      assert.equal(got.memory, dayStr(new Date()), `${id} 订单的发货日当场写上`);
      assert.equal(got.memory, got.reloaded, `${id} 和重新载入后一样`);
      assert.equal(got.memory, got.batch, `${id} 跟第一批走`);
    }

    // 2. 粘贴识别填进来的坏单号：不算以前存的，要拦。
    const pasted = await page.evaluate(() => {
      openCombinedCustomerOrderModal({ orderFields:{ amount:100, trackingNumber:'1Z12345678' }, customerFields:{ name:'Paste Co' } });
      const problems = shipmentRowProblems(document.getElementById('combinedOrderForm')).map(({ number, kept }) => ({ number, kept }));
      closeCombinedCustomerOrderModal();
      return problems;
    });
    assert.deepEqual(pasted, [{ number:'1Z12345678', kept:false }], '粘贴识别的坏单号照样拦');
    // 对照：打开存着坏单号的旧单，那条仍算以前存的，只提示、能保存。
    const kept = await page.evaluate(() => {
      openOrder('k1');
      const problems = shipmentRowProblems(document.getElementById('orderForm')).map(({ number, kept }) => ({ number, kept }));
      closeOrder();
      return problems;
    });
    assert.deepEqual(kept, [{ number:'1Z12345678', kept:true }], '旧单存着的坏单号照旧放行');

    // 3. 定金没填、已收 100。
    const pay = id => page.evaluate(id => { const o = state.orders.find(x => x.id === id); return { deposit:o.depositAmount, paid:o.paidAmount, logs:o.logs.length }; }, id);
    const z1 = await pay('z1');
    assert.deepEqual([z1.deposit, z1.paid], [100, 100], '以前存成定金 0 的单载入就按已收算');
    await page.evaluate(() => openOrder('z1'));
    await page.waitForSelector('#orderModal.open');
    assert.equal(await page.inputValue('#orderForm [name=depositAmount]'), '100');
    await page.evaluate(() => document.getElementById('orderForm').requestSubmit());
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    const after = await page.evaluate(() => state.orders.find(x => x.id === 'z1'));
    assert.equal(after.depositAmount, 100, '不改直接保存：定金不变');
    assert.ok(!after.logs.some(log => /定金/.test(log.text || '')), '不改直接保存：没有「定金」改动记录');
    // 新填的单：定金框空着、已收 100，存下来定金就是 100。
    const built = await page.evaluate(() => {
      const fresh = { ...state.orders.find(x => x.id === 'd1'), id:'', num:'R-new', stage:'production', shipments:[], trackingNumber:'', carrier:'', logs:[] };
      const data = { ...orderFormDataFromOrder(fresh), depositAmount:'', depositPercent:'', paidAmount:'100' };
      const o = buildOrderFromFormData(data, { isDraft:false });
      return { deposit:o.depositAmount, percent:o.depositPercent, paid:o.paidAmount };
    });
    assert.deepEqual(built, { deposit:100, percent:15.38, paid:100 }, '定金没填：按已收记');

    // 4. 按已收推出来的定金不是谈好的定金：已收清回 0 时跟着清掉，拖进生产中也不会被自动记成已收。
    const cleared = await page.evaluate(() => {
      const seed = { ...state.orders.find(x => x.id === 'd1'), stage:'production', shipments:[], trackingNumber:'', carrier:'', logs:[] };
      const save = (existing, patch) => buildOrderFromFormData({ ...orderFormDataFromOrder(existing), ...patch }, { existing, isDraft:false });
      const pick = o => ({ deposit:o.depositAmount, paid:o.paidAmount, stage:o.stage, derived:o.depositFromPaid === true });
      // 定金没填、已收填成 300 → 再把已收清空。
      const typo = save({ ...seed, id:'t1', depositAmount:0, depositPercent:0, paidAmount:0 }, { depositAmount:'', depositPercent:'', paidAmount:'300' });
      const fixed = save(typo, { paidAmount:'' });
      const moved = { ...fixed };
      adjustPaymentForManualMove(moved, 'quote', 'production');
      // 后来收了尾款再清空，也一样。
      const later = save(save(typo, { paidAmount:'650' }), { paidAmount:'' });
      // 用户自己填的定金 300：已收清空后定金还在，拖进生产中照旧按定金记。
      const agreed = save({ ...seed, id:'t2', depositAmount:300, depositPercent:46.15, paidAmount:300 }, { paidAmount:'' });
      const agreedMoved = { ...agreed };
      adjustPaymentForManualMove(agreedMoved, 'quote', 'production');
      // 推出来的定金被用户改成别的数：算用户填的。
      const retyped = save(typo, { depositAmount:'200', depositPercent:'' });
      // 标记还在、已收已经是 0 的单（比如撤销留下的）：载入时清掉，拖动时也不认。
      const stale = { ...seed, id:'t3', stage:'quote', depositAmount:300, paidAmount:0, depositFromPaid:true };
      const staleMoved = { ...stale };
      adjustPaymentForManualMove(staleMoved, 'quote', 'production');
      return { typo:pick(typo), fixed:pick(fixed), moved:moved.paidAmount, later:pick(later), agreed:pick(agreed), agreedMoved:agreedMoved.paidAmount,
        retyped:pick(retyped), staleMoved:staleMoved.paidAmount, staleLoaded:pick(normalizeActiveOrder(stale)), hasKey:'depositFromPaid' in normalizeActiveOrder(agreed) };
    });
    assert.deepEqual(cleared.typo, { deposit:300, paid:300, stage:'production', derived:true });
    assert.deepEqual(cleared.fixed, { deposit:0, paid:0, stage:'quote', derived:false }, '已收清回 0：推出来的定金跟着清');
    assert.equal(cleared.moved, 0, '再拖进生产中：不会自动记一笔定金');
    assert.deepEqual(cleared.later, { deposit:0, paid:0, stage:'quote', derived:false });
    assert.deepEqual(cleared.agreed, { deposit:300, paid:0, stage:'quote', derived:false }, '用户填的定金不受影响');
    assert.equal(cleared.agreedMoved, 300, '用户填的定金：拖进生产中照旧记为已收');
    assert.deepEqual(cleared.retyped, { deposit:200, paid:300, stage:'production', derived:false });
    assert.equal(cleared.staleMoved, 0);
    assert.deepEqual(cleared.staleLoaded, { deposit:0, paid:0, stage:'quote', derived:false });
    assert.equal(cleared.hasKey, false, '没有推出来的定金就不带这个字段');

    assert.deepEqual(errors, [], '页面没有报错');
    assert.deepEqual(dialogs, [], '没有原生弹窗');
  } finally {
    await browser.close();
  }
  console.log('Review 2026-11-18 UI test passed: done move fills shippedAt, pasted bad numbers are blocked, blank deposit follows paid and leaves with it.');
})().catch(error => { console.error(error); process.exit(1); });
