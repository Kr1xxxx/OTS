#!/usr/bin/env node
// Close guard, audit 04 (V3.119): every way out of an edited order / customer form or the detail drawer asks first.
// Typed key by key: extra shipment / phone / email rows count as edits; the confirm box focuses 继续编辑 (Esc then
// Enter keeps the form); drawer stage bar / 编辑订单 / 客户档案 / 复制 / 关联订单 ask, a same-order refresh keeps the
// typed note; customer edit「＋新建订单」, paste「打开订单」and customer paste「新建客户 + 订单」ask; order modal backdrop click; a lowercase legacy
// customer name is not an edit; Tab stays inside the top layer; board card settings ask; unadded attachment input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

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
    const base = { currency:'USD', logisticsStatus:'未发货', createdAt:`${month}-01`, orderMonth:month, updated:`${month}-01 09:00`, logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配' };
    const orders = [
      { ...base, id:'o1', num:'K1001', client:'Demo Beauty Supply', country:'🇺🇸 美国 United States', amount:6000, paidAmount:1800, depositAmount:1800, orderType:'定金订单', stage:'balance', note:'saved note o1',
        trackingNumber:'1Z999AA10123456784', carrier:'UPS', logisticsStatus:'运输中',
        shipments:[{ id:'s1', trackingNumber:'1Z999AA10123456784', carrier:'UPS', status:'运输中' }, { id:'s2', trackingNumber:'9183352620', carrier:'DHL', status:'已发货' }] },
      { ...base, id:'o2', num:'K1002', client:'alice smith', country:'🇺🇸 美国 United States', amount:1200, paidAmount:0, orderType:'定金订单', stage:'quote', note:'legacy lowercase' },
      { ...base, id:'o3', num:'K1003', client:'Demo Beauty Supply', country:'🇺🇸 美国 United States', amount:500, paidAmount:0, orderType:'全款订单', stage:'quote', note:'' }
    ];
    const customers = {
      'Demo Beauty Supply':{ client:'Demo Beauty Supply', country:'🇺🇸 美国 United States', phones:['+1 202 555 0101', '+1 202 555 0102'], emails:['a@demo.test', 'b@demo.test'], contacts:['Ann'], note:'old note' },
      'alice smith':{ client:'alice smith', country:'🇺🇸 美国 United States', note:'lowercase legacy' },
      'Carl Diaz':{ client:'Carl Diaz', country:'🇩🇪 德国 Germany' }
    };
    let stored = { app:'trade-order-system', data:{ orders, customers, demoCleared:true, demoCustomersCleared:true }, revision:0 };
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
      if (pathname === '/api/save') {
        stored = { ...route.request().postDataJSON().state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const isOpen = id => page.evaluate(id => document.getElementById(id).classList.contains('open'), id);
    const settle = (ms = 250) => page.waitForTimeout(ms);
    const type = async (locator, text) => { await locator.click(); await locator.pressSequentially(text, { delay:5 }); };
    const activeId = () => page.evaluate(() => document.activeElement?.id || '');
    const orderDirty = () => page.evaluate(() => uiFormDirty(document.getElementById('orderForm')));
    const customerDirty = () => page.evaluate(() => uiFormDirty(document.getElementById('customerForm')));
    const reset = async () => {
      await page.evaluate(() => {
        if (document.getElementById('confirmModal').classList.contains('open')) document.getElementById('confirmCancelBtn').click();
        closeOrder(); closeCustomerModal(); closeOrderDetail(); closeCombinedCustomerOrderModal(); closeBoardCardSettings();
      });
      await settle(150);
    };

    // P1-1: a second tracking number typed into a new row is an edit. Esc asks; the confirm focuses 继续编辑,
    // so Esc followed by Enter keeps the form (P1-5), and the right-hand × is labelled as 继续编辑 (P2-8).
    await page.evaluate(() => openOrder('o1'));
    await settle();
    await page.locator('#orderForm [data-add-shipment]').click();
    const added = page.locator('#orderForm [data-shipment-extra-row] [data-shipment-number]').last();
    await type(added, '1Z12345E0205271688');
    assert.equal(await orderDirty(), true, 'a typed extra tracking number must count as an edit');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('confirmModal'), true, 'Esc with an extra tracking number typed must ask');
    assert.equal(await activeId(), 'confirmCancelBtn', 'the discard confirm must focus 继续编辑');
    assert.equal(await page.locator('#confirmCloseBtn').getAttribute('aria-label'), '继续编辑', 'the × on the confirm means 继续编辑');
    assert.equal((await page.locator('#confirmCloseBtn').innerText()).trim(), '', 'the confirm × is an icon, not the word 关闭');
    await page.keyboard.press('Enter');
    await settle();
    assert.equal(await isOpen('confirmModal'), false);
    assert.equal(await isOpen('orderModal'), true, 'Esc then Enter must not throw the order away');
    assert.equal(await added.inputValue(), '1Z12345E0205271688');
    await reset();
    // Editing or removing the existing second shipment is an edit too.
    await page.evaluate(() => openOrder('o1'));
    await settle();
    const second = page.locator('#orderForm [data-shipment-extra-row] [data-shipment-number]').first();
    await second.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('1', { delay:5 });
    assert.equal(await orderDirty(), true, 'editing the second tracking number must count');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('0', { delay:5 });
    assert.equal(await orderDirty(), false, 'typing the second tracking number back is clean again');
    await page.locator('#orderForm [data-remove-shipment]').first().click();
    assert.equal(await orderDirty(), true, 'removing the second shipment must count');
    await reset();

    // P1-1: a second phone / an edited second email on the customer profile are edits; × asks.
    await page.evaluate(() => openCustomerModal('Carl Diaz', { viewOnly:false }));
    await settle();
    await page.locator('#customerForm [data-add-customer-value="phones"]').click();
    await type(page.locator('#customerForm [data-customer-multi-kind="phones"] [data-customer-extra-row] input').last(), '+49 151 23456789');
    assert.equal(await customerDirty(), true, 'a typed second phone must count as an edit');
    await page.locator('#closeCustomerModalBtn').click();
    await settle();
    assert.equal(await isOpen('confirmModal'), true, 'closing with a second phone typed must ask');
    await page.locator('#confirmCancelBtn').click();
    await settle();
    assert.equal(await isOpen('customerModal'), true);
    await reset();
    await page.evaluate(() => openCustomerModal('Demo Beauty Supply', { viewOnly:false }));
    await settle();
    const secondEmail = page.locator('#customerForm [data-customer-multi-kind="emails"] [data-customer-extra-row] input').first();
    await secondEmail.click();
    await page.keyboard.press('End');
    await page.keyboard.type('x', { delay:5 });
    assert.equal(await customerDirty(), true, 'editing the second email must count');
    // P1-6a: in edit mode with unsaved changes,「＋新建订单」asks instead of dropping the edit.
    await page.locator('#customerNewOrderBtn').click();
    await settle();
    assert.equal(await isOpen('confirmModal'), true, '＋新建订单 on an edited profile must ask');
    assert.equal(await page.locator('#confirmSub').innerText(), '新建订单');
    await page.locator('#confirmCancelBtn').click();
    await settle();
    assert.equal(await isOpen('customerModal'), true);
    assert.equal(await isOpen('orderModal'), false);
    await page.locator('#customerNewOrderBtn').click();
    await settle();
    await page.locator('#confirmOkBtn').click();
    await settle(400);
    assert.equal(await isOpen('customerModal'), false);
    assert.equal(await isOpen('orderModal'), true, '放弃修改 then opens the new order');
    assert.deepEqual(await page.evaluate(() => state.customers['Demo Beauty Supply'].emails), ['a@demo.test', 'b@demo.test'], 'the discarded email edit is not saved');
    await reset();
    // 取消编辑 says what happens (back to read-only, nothing saved), not「关闭后」.
    await page.evaluate(() => openCustomerModal('Carl Diaz', { viewOnly:false }));
    await settle();
    await type(page.locator('#customerForm [name="note"]'), 'typed');
    await page.locator('#customerEditCancelBtn').click();
    await settle();
    assert.match(await page.locator('#confirmMessage').innerText(), /取消后，这次改的内容不会保存/);
    await reset();

    // The combined new customer + order form counts its extra rows as well.
    await page.evaluate(() => openCombinedCustomerOrderModal({ customerFields:{ name:'Combo Buyer' }, orderFields:{ amount:200 } }));
    await settle();
    await page.locator('#combinedCustomerForm [data-add-customer-value="emails"]').click();
    await type(page.locator('#combinedCustomerForm [data-customer-multi-kind="emails"] [data-customer-extra-row] input').last(), 'two@combo.test');
    assert.equal(await page.evaluate(() => uiFormDirty(document.getElementById('combinedCustomerForm'))), true);
    await page.locator('#combinedOrderForm [data-add-shipment]').click();
    await type(page.locator('#combinedOrderForm [data-shipment-extra-row] [data-shipment-number]').last(), '9183352621');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('confirmModal'), true, 'the combined form must ask on Esc');
    await reset();

    // P1-6b: paste recognition「打开订单」on a new order with a typed amount asks first.
    await page.evaluate(() => openOrder(''));
    await settle();
    await type(page.locator('#orderForm [name="amount"]'), '4321');
    await type(page.locator('#pasteAssistInput'), 'Hi, about order K1003, when will it ship?');
    await page.locator('#pasteAssistAnalyzeBtn').click();
    await settle();
    await page.locator('#pasteAssistResults [data-paste-open-order]').first().click();
    await settle();
    assert.equal(await isOpen('confirmModal'), true, '打开订单 with a typed order must ask');
    assert.equal(await page.locator('#confirmSub').innerText(), '打开订单');
    await page.locator('#confirmCancelBtn').click();
    await settle();
    assert.equal(await isOpen('orderModal'), true);
    assert.equal(await page.locator('#orderForm [name="amount"]').inputValue(), '4321');
    await page.locator('#pasteAssistResults [data-paste-open-order]').first().click();
    await settle();
    await page.locator('#confirmOkBtn').click();
    await settle(400);
    assert.equal(await isOpen('orderModal'), false);
    assert.equal(await isOpen('orderDetailDrawer'), true, '放弃修改 opens the matched order');
    await reset();

    // P1-6c: the customer paste「新建客户 + 订单」. A new profile holding only what「填入」put there moves on without a
    // question (the combined form re-reads the same paste); a note typed by hand afterwards makes it ask.
    const customerPaste = 'Nora Field\n+1 2025550177\nnora@field.test\n12 Lake Road, Austin, TX 78701, United States\nUSD 300 Paypal';
    const pasteAndFill = async () => {
      await page.evaluate(() => openCustomerModal(''));
      await settle();
      await type(page.locator('#customerPasteInput'), customerPaste);
      await page.locator('#customerPasteAnalyzeBtn').click();
      await settle(400);
      await page.locator('#customerPasteResults [data-customer-paste-fill]').click();
      await settle();
      assert.equal(await customerDirty(), true, '填入 changes the profile form');
    };
    await pasteAndFill();
    await page.locator('#customerPasteResults [data-customer-paste-create-customer-order]').click();
    await settle(400);
    assert.equal(await isOpen('confirmModal'), false, 'a profile holding only the filled-in paste must not ask');
    assert.equal(await isOpen('combinedCustomerOrderModal'), true);
    assert.equal(await page.locator('#combinedCustomerForm [name="name"]').inputValue(), 'Nora Field');
    await reset();
    await pasteAndFill();
    await type(page.locator('#customerForm [name="note"]'), 'gate code 4410');
    await page.locator('#customerPasteResults [data-customer-paste-create-customer-order]').click();
    await settle();
    assert.equal(await isOpen('confirmModal'), true, 'a note typed after 填入 must ask before 新建客户 + 订单');
    assert.equal(await page.locator('#confirmSub').innerText(), '新建客户 + 订单');
    await page.locator('#confirmCancelBtn').click();
    await settle();
    assert.equal(await isOpen('combinedCustomerOrderModal'), false);
    assert.equal(await page.locator('#customerForm [name="note"]').inputValue(), 'gate code 4410', '继续编辑 keeps the typed note');
    await reset();

    // P2-9: an attachment name typed but not added (no 「添加」) is an edit.
    await page.evaluate(() => { openOrder('o3'); uiOrderCompact(document.getElementById('orderForm'), false); });
    await settle();
    await type(page.locator('#attachmentName'), 'deposit screenshot');
    assert.equal(await orderDirty(), true, 'an attachment name typed but not added must count');
    await reset();

    // P2-7: the order modal closes on a backdrop click like the other drawers; with edits it asks first.
    await page.evaluate(() => openOrder('o3'));
    await settle(400);
    await page.mouse.click(8, 460);
    await settle();
    assert.equal(await isOpen('orderModal'), false, 'a clean order modal closes on a backdrop click');
    await page.evaluate(() => openOrder('o3'));
    await settle(400);
    await type(page.locator('#orderForm [name="note"]'), 'backdrop');
    await page.mouse.click(8, 460);
    await settle();
    assert.equal(await isOpen('confirmModal'), true, 'a backdrop click on an edited order must ask');
    await page.locator('#confirmCancelBtn').click();
    await settle();
    assert.equal(await isOpen('orderModal'), true);
    await reset();

    // P2-5: an old lowercase customer name is not touched by focusing in and out: no edit, payment stays Paypal.
    await page.evaluate(() => openOrder('o2'));
    await settle();
    await page.locator('#orderForm [name="client"]').click();
    await page.keyboard.press('Escape');
    await page.locator('#orderForm [name="note"]').click();
    await settle();
    assert.equal(await page.locator('#orderForm [name="client"]').inputValue(), 'alice smith');
    assert.equal(await page.locator('#orderForm [name="paymentChannel"]').inputValue(), 'Paypal', 'focusing the customer must not swap the payment method');
    assert.equal(await orderDirty(), false, 'focus in / out of a lowercase customer is not an edit');
    // Typing the same customer in another case still is an edit, but keeps the order's payment method.
    const client = page.locator('#orderForm [name="client"]');
    await client.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Delete');
    await page.keyboard.type('A', { delay:5 });
    await page.keyboard.press('Escape');
    await page.locator('#orderForm [name="note"]').click();
    await settle();
    assert.equal(await client.inputValue(), 'Alice Smith', 'a typed name is still capitalized');
    assert.equal(await page.locator('#orderForm [name="paymentChannel"]').inputValue(), 'Paypal', 'the same customer in another case keeps the payment method');
    await reset();

    // P1-2: drawer with an unsaved note. Stage bar, 编辑订单, 客户档案, 复制订单 and a related order all ask.
    const drawerNote = page.locator('#orderDetailBody [data-dedit="note"]');
    await page.evaluate(() => openOrderDetail('o1'));
    await settle();
    await drawerNote.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' + UNSAVED', { delay:5 });
    for (const [selector, sub] of [
      ['#detailStageBar [data-detail-stage="production"]', '切换阶段'],
      ['#detailEditBtn', '编辑订单'],
      ['#detailCustomerBtn', '客户档案'],
      ['#detailDuplicateBtn', '复制订单']
    ]) {
      await page.locator(selector).click();
      await settle();
      assert.equal(await isOpen('confirmModal'), true, `${sub} with an unsaved drawer must ask`);
      assert.equal(await page.locator('#confirmSub').innerText(), sub);
      assert.equal(await activeId(), 'confirmCancelBtn');
      await page.keyboard.press('Enter');
      await settle();
      assert.equal(await isOpen('orderDetailDrawer'), true, `${sub}: 继续编辑 keeps the drawer`);
      assert.equal(await isOpen('orderModal'), false);
      assert.equal(await isOpen('customerModal'), false);
      assert.equal(await page.evaluate(() => detailOrderId), 'o1');
      assert.equal(await drawerNote.inputValue(), 'saved note o1 + UNSAVED', `${sub}: the typed note must stay`);
    }
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o1').stage), 'balance', 'the stage did not move while the user kept editing');
    assert.equal(await page.evaluate(() => state.orders.length), 3, 'nothing was duplicated');
    await page.evaluate(() => uiDetailTab('info', true));
    await page.evaluate(() => document.querySelector('#orderDetailBody [data-order-customer-order="o3"]').click());
    await settle();
    assert.equal(await isOpen('confirmModal'), true, 'a related order with an unsaved drawer must ask');
    await page.locator('#confirmCancelBtn').click();
    await settle();
    assert.equal(await page.evaluate(() => detailOrderId), 'o1');
    // A same-order refresh (toast 撤销, tracking card, 收齐尾款, 重新发送 all call openOrderDetail(id)) keeps the typed note.
    await page.evaluate(() => openOrderDetail('o1'));
    await settle();
    assert.equal(await drawerNote.inputValue(), 'saved note o1 + UNSAVED', 'a refresh of the same order must keep the typed note');
    assert.equal(await page.evaluate(() => uiDetailDirty()), true, 'and it still counts as unsaved');
    // 放弃修改 on the stage bar moves the stage and drops the note.
    await page.locator('#detailStageBar [data-detail-stage="production"]').click();
    await settle();
    await page.locator('#confirmOkBtn').click();
    await settle(400);
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o1').stage), 'production');
    assert.equal(await drawerNote.inputValue(), 'saved note o1');
    assert.equal(await page.evaluate(() => uiDetailDirty()), false);
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('orderDetailDrawer'), false, 'a clean drawer closes without asking');
    assert.equal(await isOpen('confirmModal'), false);
    // 编辑订单 after 放弃修改 opens the editor with the saved values.
    await page.evaluate(() => openOrderDetail('o3'));
    await settle();
    await type(page.locator('#orderDetailBody [data-dedit="note"]'), 'drawer only');
    await page.locator('#detailEditBtn').click();
    await settle();
    await page.locator('#confirmOkBtn').click();
    await settle(400);
    assert.equal(await isOpen('orderModal'), true);
    assert.equal(await page.locator('#orderForm [name="note"]').inputValue(), '');
    await reset();

    // P2-6: Tab stays inside the edited customer profile (it used to reach the list behind and open another customer).
    await page.evaluate(() => setPage('customers'));
    await settle(400);
    await page.evaluate(() => openCustomerModal('Demo Beauty Supply', { viewOnly:false }));
    await settle(400);
    await type(page.locator('#customerForm [name="note"]'), ' tab');
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('#customerModal'));
      assert.equal(inside, true, `Tab #${i + 1} left the customer modal`);
    }
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#customerModal')), true, 'Shift+Tab stays inside too');
    // Re-opening another customer in the already open modal takes a fresh snapshot (no stale「放弃修改？」).
    await page.evaluate(() => { closeCustomerModal(); openCustomerModal('Demo Beauty Supply', { viewOnly:true }); });
    await settle(300);
    await page.evaluate(() => openCustomerModal('alice smith', { viewOnly:true }));
    await settle(300);
    await page.locator('#customerDetailEditBtn').click();
    await settle();
    await page.locator('#closeCustomerModalBtn').click();
    await settle();
    assert.equal(await isOpen('confirmModal'), false, 'an untouched profile opened in place must close without asking');
    assert.equal(await isOpen('customerModal'), false);
    await page.evaluate(() => setPage('dashboard'));
    await settle(300);

    // P2-10: board card settings ask before throwing away a changed toggle.
    await page.evaluate(() => openBoardCardSettings());
    await settle();
    await page.locator('#boardCardSettingsForm input[type="checkbox"]').first().click({ force:true });
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('confirmModal'), true, 'card settings with a changed toggle must ask on Esc');
    await page.locator('#confirmOkBtn').click();
    await settle();
    assert.equal(await isOpen('boardCardSettingsModal'), false);
    await page.evaluate(() => openBoardCardSettings());
    await settle();
    await page.locator('#boardCardSettingsCloseBtn').click();
    await settle();
    assert.equal(await isOpen('boardCardSettingsModal'), false, 'untouched card settings close straight away');

    // Other danger confirms also start on the safe button.
    await page.evaluate(() => { window.__dangerResult = null; appConfirm({ title:'删除附件', message:'x', confirmText:'删除附件', danger:true }).then(r => { window.__dangerResult = r.confirmed; }); });
    await settle(200);
    assert.equal(await activeId(), 'confirmCancelBtn');
    await page.keyboard.press('Enter');
    await settle();
    assert.equal(await page.evaluate(() => window.__dangerResult), false, 'Enter on a danger confirm must not confirm');

    assert.deepEqual(dialogs, [], 'native alert / confirm dialogs are not allowed');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Close guard paths UI passed: extra shipment / phone / email rows, confirm focus + Esc→Enter, drawer stage / edit / customer / duplicate / related ask, refresh keeps typing, customer ＋新建订单, paste 打开订单 / 新建客户 + 订单, order backdrop, lowercase customer, Tab trap, card settings.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
