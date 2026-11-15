#!/usr/bin/env node
// 第三轮 bug 审查（2026-11-15）的四条，在真页面上跑：
// 1. 工作台定过高度的「待办」「最近订单」收起后不再显示（调整中和点「完成」后都是），放回来还是原来定的高度。
// 2. 全款单自动记已收后，在编辑弹窗只改金额：退回报价时已收照样清零；同时改成部分付款、自己填已收的不清零。
// 3. 「补运单号」点完成：提示条、订单记录、「已处理」说明、悬停提示都不说「日期改了」；金额 0 的待发货单不写「尾款」。
// 4. 客户档案时间线：「可以发货」「补运单号」两种待办归在「物流」筛选下。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const pad = n => String(n).padStart(2, '0');
const dayStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return dayStr(d); };
const order = (id, extra = {}) => ({ ...base, id, num:`R-${id}`, client:`Client ${id}`, amount:650, paidAmount:0, orderType:'定金订单', depositAmount:195, stage:'quote', updated:`${daysAgo(2)} 10:00`, ...extra });

(async () => {
  const browser = await launchBrowser();
  try {
    const orders = [
      order('f1', { orderType:'全款订单', depositAmount:650 }),
      order('f2', { orderType:'全款订单', depositAmount:650 }),
      order('t1', { stage:'shipment', paidAmount:650, logisticsStatus:'运输中', shippedAt:daysAgo(4), updated:`${daysAgo(4)} 10:00` }),
      order('r1', { stage:'balance', paidAmount:650 }),
      order('z1', { stage:'balance', amount:0, depositAmount:0 })
    ];
    for (let i = 0; i < 6; i++) orders.push(order(`b${i}`, { stage:'balance', paidAmount:195 }));
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { port:freePortSync() });

    // 1. 定高 + 收起。
    const look = id => page.evaluate(id => { const el = document.getElementById(id); return { hidden:el.hidden, display:getComputedStyle(el).display, h:el.style.getPropertyValue('--dash-h') || getComputedStyle(el).getPropertyValue('--dash-h').trim() }; }, id);
    for (const [id, key] of [['recentOrders', 'recent'], ['tasks', 'tasks']]) {
      await page.click('#dashLayoutBtn');
      await page.focus(`#${id} [data-dash-resize="height"]`);
      await page.keyboard.press('ArrowDown');
      const fixed = await look(id);
      assert.ok(fixed.h, `${id} 定了高度`);
      await page.click(`#${id} [data-dash-hide]`);
      assert.deepEqual(await look(id), { ...fixed, hidden:true, display:'none' }, `${id} 调整中收起：不显示`);
      await page.click('[data-dash-action="done"]');
      assert.equal((await look(id)).display, 'none', `${id} 点完成后：不显示`);
      await page.click('#dashLayoutBtn');
      await page.click(`#dashLayoutTray [data-dash-show="${key}"]`);
      await page.click('[data-dash-action="done"]');
      const back = await look(id);
      assert.equal(back.display, 'flex', `${id} 放回来`);
      assert.equal(back.h, fixed.h, `${id} 放回来还是原来定的高度`);
    }

    // 2. 全款单自动记已收 → 编辑弹窗改金额 → 退回报价。
    const pay = id => page.evaluate(id => { const o = state.orders.find(x => x.id === id); return { paid:o.paidAmount, auto:o.depositAutoPaid }; }, id);
    const editAmount = async (id, amount, { status, paid } = {}) => {
      await page.evaluate(id => openOrder(id), id);
      await page.waitForSelector('#orderModal.open');
      await page.fill('#orderForm [name=amount]', String(amount));
      if (status) await page.evaluate(status => { const el = document.querySelector('#orderForm [name=fullPaymentStatus]'); el.value = status; el.dispatchEvent(new Event('change', { bubbles:true })); }, status);
      if (paid !== undefined) await page.fill('#orderForm [name=paidAmount]', String(paid));
      await page.evaluate(() => document.getElementById('orderForm').requestSubmit());
      await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    };
    await page.evaluate(() => moveOrderToStage('f1', 'production'));
    assert.deepEqual(await pay('f1'), { paid:650, auto:650 }, '全款自动记已收');
    await editAmount('f1', 800);
    assert.deepEqual(await pay('f1'), { paid:800, auto:800 }, '只改金额：已收跟着金额，仍算自动记的');
    await page.evaluate(() => moveOrderToStage('f1', 'quote'));
    assert.equal((await pay('f1')).paid, 0, '退回报价：自动记的全款清零');
    // 对照：改金额的同时改成部分付款、自己填已收，算登记过的收款。
    await page.evaluate(() => moveOrderToStage('f2', 'production'));
    await editAmount('f2', 800, { status:'部分', paid:300 });
    await page.evaluate(() => moveOrderToStage('f2', 'quote'));
    assert.equal((await pay('f2')).paid, 300, '自己填的已收退回报价不清零');

    // 3. 补运单号点完成的文字；金额 0 的待发货单。
    const doneTitle = await page.evaluate(() => [...document.querySelectorAll('#taskList [data-task-action="done"]')].map(b => b.title).find(t => /补运单号/.test(t)));
    assert.equal(doneTitle, '完成：这张单不再提醒补运单号');
    await page.evaluate(() => markTaskDone('tracking-t1'));
    const toastText = await page.evaluate(() => [...document.querySelectorAll('#toast .toast-item:not(.leaving)')].map(el => el.textContent).join(' '));
    assert.match(toastText, /这张单不再提醒补运单号/);
    const log = await page.evaluate(() => state.orders.find(o => o.id === 't1').logs[0].text);
    assert.match(log, /补运单号.*这张单不再提醒补运单号/);
    const note = await page.evaluate(() => taskDoneNote(findTaskItem('tracking-t1')));
    for (const text of [doneTitle, toastText, log, note]) assert.doesNotMatch(text, /日期改了/);
    const reasons = await page.evaluate(() => Object.fromEntries(buildTaskItems().filter(t => t.type === 'ready').map(t => [t.orderId, t.reason])));
    assert.equal(reasons.z1, '可以发货了', '金额 0 不写尾款');
    assert.equal(reasons.r1, '尾款已收齐，可以发货了');

    // 4. 客户时间线筛选。
    await page.evaluate(() => restoreTaskReminder('tracking-t1'));
    const kinds = await page.evaluate(() => ['Client t1', 'Client r1'].flatMap(name => customerRoadmapEvents(name).filter(e => ['ready', 'tracking'].includes(e.type)).map(e => `${e.type}:${roadmapFilterType(e)}`)).sort());
    assert.deepEqual(kinds, ['ready:logistics', 'tracking:logistics']);

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('review 1115 fixes ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
