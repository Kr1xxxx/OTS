#!/usr/bin/env node
// Close guard, audit 04 (V3.119): saving and quitting.
// - A save that did not reach the database stays in memory (auto retry, conflict export), but 放弃修改 really
//   discards it: memory goes back and the retry never writes it (new order, edited order, customer rename,
//   new customer + order, detail drawer). The drawer keeps the typed values after a failed save.
// - Esc / × while a save is running does not offer 放弃 (it used to turn into a save).
// - Quit / close window / update restart: otsFlushBeforeQuit returns false while a form is unsaved and the
//   page's own confirm says which form; an update is cancelled with a page toast.
// - A second confirm (Mac shell prompt) over an open discard confirm no longer leaves the first one hanging.
// - 续费: Esc on the discard confirm closes it once; Esc while saving keeps the editor; price editor asks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { createSubscriptionStore } = require('../mac-app/subscription-store');

async function launch() {
  try { return await chromium.launch({ headless:true }); }
  catch (_) { return chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium' }); }
}

(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:920 } });
    const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const base = { currency:'USD', logisticsStatus:'未发货', createdAt:`${month}-01`, orderMonth:month, updated:`${month}-01 09:00`, logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', orderType:'全款订单', paidAmount:0, stage:'quote' };
    const orders = [
      { ...base, id:'o1', num:'K1001', client:'Demo Beauty Supply', country:'🇺🇸 美国 United States', amount:600, note:'saved note o1' },
      { ...base, id:'o2', num:'K1002', client:'Carl Diaz', country:'🇩🇪 德国 Germany', amount:800, note:'' },
      { ...base, id:'o3', num:'K1003', client:'Carl Diaz', country:'🇩🇪 德国 Germany', amount:300, note:'drawer saved' }
    ];
    const customers = {
      'Demo Beauty Supply':{ client:'Demo Beauty Supply', country:'🇺🇸 美国 United States', note:'old note' },
      'Carl Diaz':{ client:'Carl Diaz', country:'🇩🇪 德国 Germany', note:'carl note' }
    };
    let stored = { app:'trade-order-system', data:{ orders, customers, demoCleared:true, demoCustomersCleared:true }, revision:0 };
    let failSave = false;
    // 保存请求挂住，直到测试放行：以前固定延迟 1.5 秒，机器忙时后面几步还没做完保存就回来、弹窗已经关了。
    let saveGate = null;
    let failSubscriptionSave = false;
    const store = createSubscriptionStore(new DatabaseSync(':memory:'));
    store.save({ name:'VPS', note:'', amount:20, currency:'USD', cycleMonths:1, startDate:`${month}-01`, category:'工具效率', color:'#2f6fde' });
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
    await page.route('**/*', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/save') {
        if (saveGate) await saveGate.promise;
        if (failSave) return route.fulfill({ status:500, json:{ ok:false, message:'TEST disk unavailable' } });
        stored = { ...request.postDataJSON().state, revision:stored.revision + 1 };
        return route.fulfill({ json:{ ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } } });
      }
      if (pathname.startsWith('/api/subscriptions')) {
        const body = request.postData() ? JSON.parse(request.postData()) : {};
        if (pathname === '/api/subscriptions/save' && failSubscriptionSave) {
          await new Promise(resolve => setTimeout(resolve, 1200));
          return route.fulfill({ status:500, json:{ ok:false, message:'TEST 续费保存失败' } });
        }
        try {
          const result = pathname === '/api/subscriptions' ? store.list()
            : pathname === '/api/subscriptions/save' ? store.save(body.item)
            : pathname === '/api/subscriptions/delete' ? store.remove(body)
            : pathname === '/api/subscriptions/options' ? store.setOptions(body)
            : store.setRate(body);
          return route.fulfill({ json:result });
        } catch (error) {
          return route.fulfill({ status:error.status || 500, json:{ ok:false, message:error.message } });
        }
      }
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => window.flushPendingSave());
    const isOpen = id => page.evaluate(id => document.getElementById(id).classList.contains('open'), id);
    const settle = (ms = 250) => page.waitForTimeout(ms);
    const type = async (locator, text) => { await locator.click(); await locator.pressSequentially(text, { delay:5 }); };
    const waitSaveError = () => page.waitForFunction(() => window.pendingSaveStatus().error);
    // After the disk is back the 3 s auto retry runs; wait until everything queued is written.
    const waitWritten = () => page.waitForFunction(() => !window.pendingSaveStatus().pending && !window.pendingSaveStatus().error, null, { timeout:15000 });
    const orderSave = page.locator('#orderModal button[type="submit"][form="orderForm"]').first();
    const discardViaConfirm = async () => {
      await settle();
      assert.equal(await isOpen('confirmModal'), true, 'closing after a failed save must ask');
      await page.locator('#confirmOkBtn').click();
      await settle(300);
    };

    // P1-3 new order: the failed save stays in memory (for the retry / export) until 放弃修改 takes it back,
    // and the retry after the disk recovers does not write it.
    await page.evaluate(() => openOrder(''));
    await settle();
    await type(page.locator('#orderForm [name="client"]'), 'Zed Discard Test');
    await page.keyboard.press('Escape');
    await type(page.locator('#orderForm [name="amount"]'), '999');
    await page.locator('#orderModal [name="sendFeishuNotification"]').uncheck();
    failSave = true;
    await orderSave.click();
    await waitSaveError();
    await settle();
    assert.equal(await isOpen('orderModal'), true, 'a failed save keeps the form open');
    assert.equal(await page.evaluate(() => state.orders.some(o => o.client === 'Zed Discard Test')), true, 'the failed save stays in memory for the retry / export');
    await page.locator('#closeModalBtn').click();
    await discardViaConfirm();
    assert.equal(await isOpen('orderModal'), false);
    assert.equal(await page.evaluate(() => state.orders.some(o => o.client === 'Zed Discard Test')), false, '放弃修改 must take the order back out of memory');
    failSave = false;
    await waitWritten();
    assert.equal(stored.data.orders.some(o => o.client === 'Zed Discard Test'), false, 'the retry must not write a discarded order');
    assert.equal(stored.data.orders.length, 3);

    // P1-3 edited order: discard restores the saved note in memory and on disk.
    await page.evaluate(() => openOrder('o1'));
    await settle();
    const note = page.locator('#orderForm [name="note"]');
    await note.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' EDIT-FAILED', { delay:5 });
    failSave = true;
    await orderSave.click();
    await waitSaveError();
    await settle();
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o1').note), 'saved note o1 EDIT-FAILED');
    await page.keyboard.press('Escape');
    await discardViaConfirm();
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o1').note), 'saved note o1');
    failSave = false;
    await waitWritten();
    assert.equal(stored.data.orders.find(o => o.id === 'o1').note, 'saved note o1');
    // A failed save followed by a successful one keeps a single order and clears the pending undo.
    await page.evaluate(() => openOrder(''));
    await settle();
    await type(page.locator('#orderForm [name="client"]'), 'Retry Buyer');
    await page.keyboard.press('Escape');
    await type(page.locator('#orderForm [name="amount"]'), '120');
    await page.locator('#orderModal [name="sendFeishuNotification"]').uncheck();
    failSave = true;
    await orderSave.click();
    await waitSaveError();
    failSave = false;
    await orderSave.click();
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    await waitWritten();
    assert.equal(stored.data.orders.filter(o => o.client === 'Retry Buyer').length, 1, 'retry must not duplicate the order');

    // P1-3 customer rename that failed: 放弃 brings back the old profile and the orders' customer name.
    await page.evaluate(() => openCustomerModal('Carl Diaz', { viewOnly:false }));
    await settle();
    const customerName = page.locator('#customerForm [name="name"]');
    await customerName.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' GmbH', { delay:5 });
    await type(page.locator('#customerForm [name="note"]'), ' CUSTOMER-FAILED');
    failSave = true;
    await page.locator('#customerHeaderSaveBtn').click();
    await waitSaveError();
    await settle();
    assert.equal(await isOpen('customerModal'), true);
    assert.equal(await page.evaluate(() => Boolean(state.customers['Carl Diaz GmbH'])), true, 'the failed rename stays in memory until discarded');
    await page.locator('#closeCustomerModalBtn').click();
    await discardViaConfirm();
    assert.deepEqual(await page.evaluate(() => [Boolean(state.customers['Carl Diaz GmbH']), state.customers['Carl Diaz']?.note, state.orders.filter(o => o.client === 'Carl Diaz').length]), [false, 'carl note', 2]);
    failSave = false;
    await waitWritten();
    assert.equal(stored.data.customers['Carl Diaz GmbH'], undefined, 'the discarded rename must not reach the database');
    assert.equal(stored.data.customers['Carl Diaz'].note, 'carl note');
    assert.equal(stored.data.orders.filter(o => o.client === 'Carl Diaz').length, 2);
    // 取消编辑 after a failed save also takes the change back.
    await page.evaluate(() => openCustomerModal('Carl Diaz', { viewOnly:false }));
    await settle();
    await type(page.locator('#customerForm [name="note"]'), ' CANCEL-FAILED');
    failSave = true;
    await page.locator('#customerHeaderSaveBtn').click();
    await waitSaveError();
    await page.locator('#customerEditCancelBtn').click();
    await discardViaConfirm();
    assert.equal(await page.evaluate(() => state.customers['Carl Diaz'].note), 'carl note');
    assert.match(await page.locator('#customerForm [name="note"]').inputValue(), /^carl note$/, 'read-only view shows the saved note');
    failSave = false;
    await page.evaluate(() => closeCustomerModal());
    await waitWritten();

    // P1-3 new customer + order: discard removes both.
    await page.evaluate(() => openCombinedCustomerOrderModal({ customerFields:{ name:'Combo Discard' }, orderFields:{ amount:200 } }));
    await settle();
    await page.locator('#combinedOrderForm [name="sendFeishuNotification"]').uncheck();
    failSave = true;
    await page.locator('#combinedSaveBtn').click();
    await waitSaveError();
    await settle();
    assert.equal(await page.evaluate(() => Boolean(state.customers['Combo Discard'])), true);
    await page.keyboard.press('Escape');
    await discardViaConfirm();
    assert.deepEqual(await page.evaluate(() => [Boolean(state.customers['Combo Discard']), state.orders.some(o => o.client === 'Combo Discard')]), [false, false]);
    failSave = false;
    await waitWritten();
    assert.equal(stored.data.customers['Combo Discard'], undefined);

    // P1-3 detail drawer: a failed save keeps the typed note on screen and unsaved (it used to redraw as if saved);
    // closing asks, 放弃 restores memory and the retry does not write it.
    await page.evaluate(() => openOrderDetail('o3'));
    await settle();
    const drawerNote = page.locator('#orderDetailBody [data-dedit="note"]');
    await drawerNote.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' DRAWER-FAILED', { delay:5 });
    failSave = true;
    await page.locator('#detailSaveBtn').click();
    await waitSaveError();
    await page.waitForFunction(() => document.getElementById('detailSaveBtn').dataset.mode !== 'busy');
    await settle();
    assert.equal(await drawerNote.inputValue(), 'drawer saved DRAWER-FAILED');
    assert.equal(await page.evaluate(() => uiDetailUnsaved()), true, 'a failed drawer save is still unsaved');
    await page.keyboard.press('Escape');
    await discardViaConfirm();
    assert.equal(await isOpen('orderDetailDrawer'), false);
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o3').note), 'drawer saved');
    failSave = false;
    await waitWritten();
    assert.equal(stored.data.orders.find(o => o.id === 'o3').note, 'drawer saved');

    // P2-1: Esc / × while the save is running only says it is saving; the save then closes the form.
    await page.evaluate(() => openOrder('o2'));
    await settle();
    await type(page.locator('#orderForm [name="note"]'), 'SAVED-WHILE-ESC');
    saveGate = {};
    saveGate.promise = new Promise(resolve => { saveGate.release = resolve; });
    await orderSave.click();
    await page.waitForFunction(() => document.getElementById('orderForm').dataset.saving);
    await page.keyboard.press('Escape');
    await settle(200);
    assert.equal(await isOpen('confirmModal'), false, 'no 放弃修改 offer while saving');
    assert.match(await page.locator('#toast').innerText(), /正在保存/);
    await page.locator('#closeModalBtn').click();
    await settle(200);
    assert.equal(await isOpen('confirmModal'), false);
    assert.equal(await isOpen('orderModal'), true, 'the form stays open until the save finishes');
    const release = saveGate.release;
    saveGate = null;
    release();
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'), null, { timeout:8000 });
    await waitWritten();
    assert.equal(stored.data.orders.find(o => o.id === 'o2').note, 'SAVED-WHILE-ESC');

    // P1-4: quit / close window / update with an unsaved form. The page saves what it can and reports false;
    // the Mac shell's prompt (drawn by nativeDialog) names the form and defaults to 继续编辑.
    await page.evaluate(() => openOrder('o1'));
    await settle();
    await type(page.locator('#orderForm [name="note"]'), ' QUIT');
    assert.equal(await page.evaluate(() => window.otsFlushBeforeQuit()), false, 'quit must be held while the order is unsaved');
    assert.deepEqual(await page.evaluate(() => window.otsUnsavedForms()), ['订单 K1001']);
    await page.evaluate(() => {
      window.__quit = null;
      window.nativeDialog({ title:'订单数据尚未确认保存', message:'页面报告本次保存没有完成。', sub:'退出软件', confirmText:'仍然退出', cancelText:'返回软件', danger:true }).then(value => { window.__quit = value; });
    });
    await settle();
    assert.equal(await page.locator('#confirmTitle').innerText(), '还有没保存的修改');
    assert.match(await page.locator('#confirmMessage').innerText(), /订单 K1001 里改的内容还没保存/);
    assert.equal(await page.locator('#confirmOkBtn').innerText(), '不保存，退出');
    assert.equal(await page.locator('#confirmCancelBtn').innerText(), '继续编辑');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'confirmCancelBtn');
    await page.keyboard.press('Enter');
    await settle();
    assert.equal(await page.evaluate(() => window.__quit), false, '继续编辑 cancels the quit');
    assert.equal(await isOpen('orderModal'), true);
    assert.match(await page.locator('#orderForm [name="note"]').inputValue(), /QUIT$/);
    // Asking again is possible (nothing stuck); 不保存，退出 lets the shell quit.
    assert.equal(await page.evaluate(() => window.otsFlushBeforeQuit()), false);
    await page.evaluate(() => { window.nativeDialog({ title:'x', message:'x', sub:'退出软件', confirmText:'仍然退出', cancelText:'返回软件', danger:true }).then(value => { window.__quit = value; }); });
    await settle();
    await page.locator('#confirmOkBtn').click();
    await settle();
    assert.equal(await page.evaluate(() => window.__quit), true);
    // Update restart: the shell cancels the update; the page toast says which form is unsaved.
    assert.equal(await page.evaluate(() => window.otsFlushBeforeQuit()), false);
    await page.evaluate(() => window.otsAppUpdateStatus({ state:'error', message:'数据还没确认保存，已取消本次更新，请稍后再试。' }));
    await settle();
    assert.match(await page.locator('#toast').innerText(), /订单 K1001 里还有没保存的修改，已取消本次更新/);
    // The same prompt from a clean page is the shell's own text, and a clean page may quit.
    await page.evaluate(() => closeOrder());
    await settle();
    assert.equal(await page.evaluate(() => window.otsFlushBeforeQuit()), true, 'nothing unsaved: quit goes ahead');

    // P2-4: a shell prompt over an open discard confirm. The first confirm resolves as 继续编辑, so the order
    // modal can still be closed afterwards (it used to stay stuck with _discardPending = true).
    await page.evaluate(() => openOrder('o1'));
    await settle();
    await type(page.locator('#orderForm [name="note"]'), ' STACK');
    await page.locator('#closeModalBtn').click();
    await settle();
    assert.equal(await page.locator('#confirmTitle').innerText(), '放弃未保存的修改？');
    await page.evaluate(() => { window.__update = null; window.nativeDialog({ title:'发现新版本 3.119', message:'要现在更新吗？', confirmText:'更新', cancelText:'稍后' }).then(value => { window.__update = value; }); });
    await settle();
    assert.equal(await page.locator('#confirmTitle').innerText(), '发现新版本 3.119');
    assert.equal(await page.evaluate(() => document.getElementById('orderForm')._discardPending), false, 'the replaced confirm must have answered');
    await page.locator('#confirmCancelBtn').click();
    await settle();
    assert.equal(await page.evaluate(() => window.__update), false);
    assert.equal(await isOpen('orderModal'), true, 'the replaced discard confirm counts as 继续编辑');
    await page.locator('#closeModalBtn').click();
    await settle();
    assert.equal(await isOpen('confirmModal'), true, '× asks again instead of being stuck');
    await page.locator('#confirmOkBtn').click();
    await settle();
    assert.equal(await isOpen('orderModal'), false);

    // 续费 P2-2: Esc on the discard confirm closes it once (it used to open a second confirm straight away).
    await page.evaluate(() => {
      window.__confirms = 0;
      const original = window.appConfirm;
      window.appConfirm = options => { window.__confirms += 1; return original(options); };
      setPage('subscriptions');
    });
    await settle(600);
    await page.locator('#subsAddBtn').click();
    await settle(400);
    await type(page.locator('#subscriptionName'), 'Test Sub');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('confirmModal'), true);
    await page.keyboard.press('Escape');
    await settle(300);
    assert.equal(await isOpen('confirmModal'), false, 'Esc must close the discard confirm');
    assert.equal(await isOpen('subscriptionEditModal'), true);
    assert.equal(await page.evaluate(() => window.__confirms), 1, 'one Esc on the confirm must not ask a second time');
    // P2-3: Esc while the save request runs keeps the editor; the failure is shown in it, input kept.
    await type(page.locator('#subscriptionAmount'), '12');
    failSubscriptionSave = true;
    await page.locator('#subscriptionSaveBtn').click();
    await settle(200);
    await page.keyboard.press('Escape');
    await settle(200);
    assert.equal(await isOpen('subscriptionEditModal'), true, 'Esc while saving must not close the editor');
    assert.equal(await isOpen('confirmModal'), false);
    await page.waitForFunction(() => /TEST 续费保存失败/.test(document.getElementById('subscriptionEditError').textContent), null, { timeout:8000 });
    assert.equal(await page.locator('#subscriptionName').inputValue(), 'Test Sub');
    failSubscriptionSave = false;
    await page.keyboard.press('Escape');
    await settle();
    await page.locator('#confirmOkBtn').click();
    await settle(300);
    assert.equal(await isOpen('subscriptionEditModal'), false);
    // P2-10: the period price editor asks before dropping a typed price.
    await page.locator('#subsList .subs-row').first().click();
    await settle(500);
    await page.locator('#subscriptionDrawer [data-sub-period]').first().click();
    await settle(300);
    const price = page.locator('#subscriptionPriceAmount');
    await price.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('25', { delay:5 });
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('confirmModal'), true, 'a typed price must ask before closing');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('subscriptionPriceModal'), true);
    assert.equal(await price.inputValue(), '25');
    await page.keyboard.press('Escape');
    await settle();
    await page.locator('#confirmOkBtn').click();
    await settle();
    assert.equal(await isOpen('subscriptionPriceModal'), false);

    assert.deepEqual(dialogs, [], 'native alert / confirm dialogs are not allowed');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Close guard save UI passed: failed-save discard really discards (order, edit, customer rename, combined, drawer), no discard offer while saving, quit / update held by unsaved forms, stacked confirms, 续费 Esc and saving, price editor.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
