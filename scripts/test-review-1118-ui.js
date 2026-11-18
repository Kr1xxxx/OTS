#!/usr/bin/env node
// 第七轮 bug 审查（2026-11-18）待办里的两条，在真页面上跑（续费停止日那条在 test-subscription-schedule.js）：
// 1. 带「未发货」或 UPS 批次的单直接移到已完成：订单的发货日当场写上，和重新载入后一样。
// 2. 粘贴识别填进「一起确认客户和订单」的坏单号不算「以前存的单号」，照样拦；打开旧单时存着的坏单号仍只提示。
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
      order('k1', { stage:'balance', shipments:[{ id:'s3', trackingNumber:'1Z12345678', carrier:'UPS', status:'未发货', shippedAt:'' }], trackingNumber:'1Z12345678', carrier:'UPS' })
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

    assert.deepEqual(errors, [], '页面没有报错');
    assert.deepEqual(dialogs, [], '没有原生弹窗');
  } finally {
    await browser.close();
  }
  console.log('Review 2026-11-18 UI test passed: done move fills shippedAt, pasted bad numbers are blocked.');
})().catch(error => { console.error(error); process.exit(1); });
