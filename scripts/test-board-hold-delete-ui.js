const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

// 右键菜单 / 详情抽屉里的「按住删除」，全部用真实鼠标按住：
// - 按住中按 Esc、窗口失焦、指针移出按钮（指针捕获下也算）、抽屉被关掉：都取消，到点也不删；
// - 在按钮里抖几个像素照样能删；Control+点按（Mac 的右键）不算按住；只点一下提示要按住；
// - 删除提示写明是哪张单，撤销后「最近更新」时间和「已处理」标记都还原；「已处理」按订单精确清理；
// - 删掉的单的运单号小卡一起关掉；旧垃圾箱列的 × 删除也能撤销。
const orders = [
  { ...base, id:'a1', num:'K201', client:'Hold Esc', amount:100, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(1)} 09:01` },
  { ...base, id:'a2', num:'K202', client:'Hold Ctrl', amount:100, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(1)} 09:02` },
  { ...base, id:'a3', num:'K203', client:'Hold Drawer', amount:100, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(1)} 09:03` },
  { ...base, id:'a4', num:'K204', client:'Ship Me', amount:100, paidAmount:100, orderType:'全款订单', stage:'production', updated:`${day(1)} 09:04` },
  { ...base, id:'o1-import-1', num:'K205', client:'Import One', amount:100, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(1)} 09:05` },
  { ...base, id:'o1-import-10', num:'K206', client:'Import Ten', amount:100, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(1)} 09:06` }
];
const trashOrders = [{ ...base, id:'t1', num:'K299', client:'Old Trash', amount:50, paidAmount:0, orderType:'全款订单', stage:'quote', trashedAt:`${day(1)} 08:00`, updated:`${day(1)} 08:00` }];
// 「已处理」记录：{ at:处理时间, until:哪天再提醒 }（until 远在以后，加载时不会当成过期清掉）。
const doneRecord = { at:`${day(1)} 10:00`, until:'2999-01-01' };
const doneTasks = { 'follow-o1-import-1':doneRecord, 'follow-o1-import-10':doneRecord };

const inOrders = (page, id) => page.evaluate(id => state.orders.some(o => o.id === id), id);

// 按住删除要按满 1.5 秒（uiStartHold，按钮没写 data-hold 时 1500ms）。下面的「等页面时间 1600 / 1700ms」都是在证明
// 按住被取消之后、过了这个时长也没有删除；按下后等的 400ms 是「按到一半」这个场景本身。
// 右键卡片，鼠标按在「按住删除」上，等进度真正开始。返回按钮中心。
async function pressMenuDelete(page, id) {
  await h.rightClick(page, id);
  const btn = await h.center(page, '.board-menu [data-board-menu="delete"]');
  await page.mouse.move(btn.x, btn.y);
  await page.mouse.down();
  await page.waitForFunction(() => document.querySelector('.board-menu [data-board-menu="delete"]')?.dataset.holding === '1');
  await h.waitPageTime(page, 400);
  return btn;
}

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs } = await openBoard(browser, { orders, trashOrders, doneTasks });

    // 1. 按住 0.4 秒后按 Esc：菜单关掉，过了 1.5 秒也不删。
    await pressMenuDelete(page, 'a1');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.board-menu'));
    await h.waitPageTime(page, 1700);
    assert.equal(await inOrders(page, 'a1'), true, '按住时按 Esc，菜单没了，订单不能被删');
    await page.mouse.up();

    // 2. 按住时窗口失焦（切到别的窗口）：取消。
    await pressMenuDelete(page, 'a1');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForFunction(() => !document.querySelector('.board-menu'));
    await h.waitPageTime(page, 1700);
    assert.equal(await inOrders(page, 'a1'), true, '窗口失焦后不能删');
    await page.mouse.up();

    // 3. 按住后把真实鼠标移出按钮（按钮做了指针捕获，收不到 pointerleave）：取消，菜单还在。
    const btn = await pressMenuDelete(page, 'a1');
    await page.mouse.move(btn.x + 250, btn.y + 120, { steps:6 });
    await page.waitForFunction(() => !document.querySelector('.board-menu [data-board-menu="delete"]')?.dataset.holding);
    await h.waitPageTime(page, 1600);
    assert.equal(await inOrders(page, 'a1'), true, '指针移出按钮后继续按着，不能删');
    assert.equal(await page.locator('.board-menu').count(), 1);
    await page.mouse.up();
    await page.keyboard.press('Escape');

    // 4. 只点一下：抖一下并提示要按住。
    await h.rightClick(page, 'a1');
    await page.locator('.board-menu [data-board-menu="delete"]').click();
    await h.waitToast(page, '要按住不放 1.5 秒才会删除');
    assert.match(await page.locator('.board-menu-note').textContent(), /按住 1\.5 秒 · 6 秒内可撤销/, '菜单里写明要按多久、能撤销');
    await page.keyboard.press('Escape');

    // 5. Control+点按（Mac 上就是右键）：不开始按住。
    await h.rightClick(page, 'a2');
    const ctrlBtn = await h.center(page, '.board-menu [data-board-menu="delete"]');
    await page.keyboard.down('Control');
    await page.mouse.move(ctrlBtn.x, ctrlBtn.y);
    await page.mouse.down();
    assert.equal(await page.evaluate(() => document.querySelector('.board-menu [data-board-menu="delete"]')?.dataset.holding || ''), '', 'Control+按下不算按住');
    await page.mouse.up();
    await page.keyboard.up('Control');
    await page.keyboard.press('Escape');

    // 6. 正常按住（中间在按钮里抖 2px）：删除，提示写明是哪张单；撤销后「最近更新」和「已处理」标记还原。
    await h.clearToasts(page);
    const before = await h.order(page, 'o1-import-1');
    const hold = await pressMenuDelete(page, 'o1-import-1');
    await page.mouse.move(hold.x + 2, hold.y + 1);
    await page.waitForFunction(() => !state.orders.some(o => o.id === 'o1-import-1'));
    await page.mouse.up();
    assert.equal(await h.deleted(page, 'o1-import-1'), true);
    await h.waitToast(page, '已删除 K205 Import One');
    let marks = await page.evaluate(() => Object.keys(state.doneTasks));
    assert.deepEqual(marks, ['follow-o1-import-10'], '只清这张单的「已处理」标记，id 是它前缀的单不受影响');
    await h.flush(page);
    assert(store.current.data.deletedOrders.some(o => o.id === 'o1-import-1'), '删除已保存');
    await h.clickUndo(page, '已删除 K205 Import One');
    await page.waitForFunction(() => state.orders.some(o => o.id === 'o1-import-1'));
    const restored = await h.order(page, 'o1-import-1');
    assert.equal(restored.updated, before.updated, '恢复后保留原来的「最近更新」，卡片回到原位置');
    assert.equal(restored.deletedDoneTasks, undefined);
    marks = await page.evaluate(() => JSON.parse(JSON.stringify(state.doneTasks)));
    assert.deepEqual(marks, doneTasks, '撤销删除后「已处理」标记连同处理时间、再提醒日期原样放回去');
    await h.waitToast(page, '已恢复 K205 Import One');

    // 7. 详情抽屉里按住删除时按 Esc：抽屉关掉，订单不删。
    await page.locator('#pipeline .board-card[data-id="a3"]').click();
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    const drawerBtn = await h.center(page, '#detailDeleteBtn');
    await page.mouse.move(drawerBtn.x, drawerBtn.y);
    await page.mouse.down();
    await page.waitForFunction(() => document.getElementById('detailDeleteBtn').dataset.holding === '1');
    await h.waitPageTime(page, 400);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    await h.waitPageTime(page, 1700);
    assert.equal(await inOrders(page, 'a3'), true, '抽屉关掉后不能再删');
    await page.mouse.up();

    // 8. 删掉的单的运单号小卡一起关掉。
    await h.rightClick(page, 'a4');
    await page.locator('.board-menu [data-board-menu="advance"]').click();
    await page.waitForSelector('#trackingQuickCard[data-order-id="a4"]');
    // 小卡弹出后 60ms 才把焦点给运单号框：这之前已经右键打开了菜单，就不能再抢焦点把菜单关掉（以前 focusin 关菜单，macOS CI 偶发）。
    //    小卡重新弹一次（和进已发货时同一个函数），紧接着打开菜单，时序固定，不看机器快慢。
    assert.equal(await page.evaluate(() => {
      uiTrackingQuickCard('a4');
      uiOpenBoardMenu(document.querySelector('#pipeline .board-card[data-id="a4"]'), { x:200, y:200 });
      return new Promise(resolve => setTimeout(() => resolve(!!document.querySelector('.board-menu') && document.activeElement !== document.querySelector('#trackingQuickCard input')), 200));
    }), true, '运单号小卡迟到的自动聚焦不能关掉刚打开的右键菜单');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.board-menu'));
    await pressMenuDelete(page, 'a4');
    await page.waitForFunction(() => !state.orders.some(o => o.id === 'a4'));
    await page.mouse.up();
    await page.waitForFunction(() => !document.getElementById('trackingQuickCard'));

    // 9. 旧「垃圾箱」列：× 删除可以撤销。
    await page.locator('#trashDrop [data-delete-trash="t1"]').click();
    await page.waitForFunction(() => (state.deletedOrders || []).some(o => o.id === 't1'));
    await h.waitToast(page, '已删除 K299 Old Trash');
    await h.clickUndo(page, '已删除 K299 Old Trash');
    await page.waitForFunction(() => (state.trashOrders || []).some(o => o.id === 't1') && !(state.deletedOrders || []).some(o => o.id === 't1'));

    await h.flush(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], '不能出现原生 alert / confirm');
    console.log('Board hold-to-delete UI passed: Esc, window blur, pointer leaving (with capture) and closing the drawer cancel; jitter still deletes; Ctrl+click and short clicks do not; delete toast names the order, undo restores updated and done marks; exact done-mark cleanup; tracking card closes; legacy trash × is undoable.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
