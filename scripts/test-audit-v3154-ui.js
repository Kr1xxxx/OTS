#!/usr/bin/env node
// 第二轮审计（V3.154）修掉的几处，真实页面 + 真实键盘鼠标：
// 1. 抽屉里日期没打完就按 ⌘S / Ctrl+S：认不出的不保存、改回这张单自己的日期（以前存进上一张单的日期，或者把原来的清空）；
//    认得出的写法（2030/12/2）照常落定后保存；
// 2. 订单弹窗中栏放不下四列的「物流记录」和「附件」：没有横向滚动，＋物流单号、× 和物流状态都点得到；
// 3. 续费编辑弹窗里下拉开着按 Esc 只收起下拉，弹窗还在、不问「放弃修改？」；
// 5. 日历上下都放不下（界面 100%、最小窗口）时不跑出窗口、不盖住自己的输入框；
// 6. 两位都没建过档案的客户合并后马上撤销，撤得回来。
// （4. 国家框半个名字回车选中唯一一项，在 test-picked-ui-options-ui.js 里。）
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const orders = [
  { ...base, id:'a1', num:'K8101', client:'Date Buyer A', stage:'production', orderType:'全款订单', amount:900, paidAmount:900, latestShipDate:'2030-12-01', updated:`${day(3)} 09:00` },
  { ...base, id:'b1', num:'K8102', client:'Date Buyer B', stage:'production', orderType:'全款订单', amount:800, paidAmount:800, updated:`${day(3)} 09:01` },
  { ...base, id:'c1', num:'K8103', client:'Date Buyer C', stage:'production', orderType:'全款订单', amount:700, paidAmount:700, customerRequiredDate:'2030-12-20', updated:`${day(3)} 09:02` },
  { ...base, id:'s1', num:'K8104', client:'Ship Buyer', stage:'shipment', orderType:'全款订单', amount:600, paidAmount:600, updated:`${day(3)} 09:03`,
    shipments:[{ id:'sa', trackingNumber:'1Z999AA10123456784', carrier:'UPS', status:'运输中' }, { id:'sb', trackingNumber:'9188335262', carrier:'DHL', status:'已发货' }] },
  { ...base, id:'m1', num:'K8105', client:'Plain Buyer One', stage:'production', orderType:'全款订单', amount:500, paidAmount:500, updated:`${day(3)} 09:04` },
  { ...base, id:'m2', num:'K8106', client:'Plain Buyer Two', stage:'production', orderType:'全款订单', amount:400, paidAmount:400, updated:`${day(3)} 09:05` }
];

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs, context } = await openBoard(browser, { orders }, { port:freePortSync() });
    const saved = () => page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
    const drawerOpen = id => page.waitForFunction(id => detailOrderId === id && document.getElementById('orderDetailDrawer').classList.contains('open'), id);
    const isOpen = id => page.evaluate(id => document.getElementById(id).classList.contains('open'), id);

    // ===== 1. 抽屉里日期没打完就按 ⌘S =====
    // 上一次有人点过订单表单里「最晚发出日期」的框（订单 A 的 2030-12-01）：以前抽屉保存借这个表单时，认不出的日期会改回它。
    await page.evaluate(() => openOrder('a1'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await page.locator('#orderForm [name="latestShipDate"]').focus();
    await page.evaluate(() => closeOrder());
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));

    await page.evaluate(() => openOrderDetail('b1'));
    await drawerOpen('b1');
    const shipDate = page.locator('#orderDetailBody [data-dedit="latestShipDate"]');
    await h.click(page, shipDate, 'drawer latest ship date');
    await page.keyboard.type('12月');
    const savesBefore = store.saves;
    await page.keyboard.press('ControlOrMeta+s');
    await h.waitToast(page, '「12月」不是有效日期，已改回空白');
    assert.equal(await shipDate.inputValue(), '', 'the field goes back to this order\'s own (empty) date');
    assert.equal((await h.order(page, 'b1')).latestShipDate || '', '', 'B does not get A\'s date');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.dedit), 'latestShipDate', 'the focus stays on the date field');
    assert.equal(await page.evaluate(() => document.querySelector('#orderDetailBody [data-dedit="latestShipDate"]').closest('.field').classList.contains('ui-err')), true, 'the field is marked');
    await saved();
    assert.equal(store.saves, savesBefore, 'nothing was saved');

    // 认得出的写法：落定成 YYYY-MM-DD 再保存。
    await page.keyboard.type('2030/12/2');
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'b1').latestShipDate === '2030-12-02');
    await saved();
    assert.equal(store.current.data.orders.find(o => o.id === 'b1').latestShipDate, '2030-12-02', 'a typed date that parses is saved');
    await h.clearToasts(page);

    // 已有日期后面多打了一个字：不清空、不保存。
    await page.evaluate(() => openOrderDetail('c1'));
    await drawerOpen('c1');
    const arrive = page.locator('#orderDetailBody [data-dedit="customerRequiredDate"]');
    await h.click(page, arrive, 'drawer required date');
    await page.keyboard.press('End');
    await page.keyboard.type('9');
    const savesBeforeC = store.saves;
    await page.keyboard.press('ControlOrMeta+s');
    await h.waitToast(page, '已改回 2030-12-20');
    assert.equal(await arrive.inputValue(), '2030-12-20');
    assert.equal((await h.order(page, 'c1')).customerRequiredDate, '2030-12-20', 'the date is not cleared');
    await saved();
    assert.equal(store.saves, savesBeforeC, 'nothing was saved');
    await page.evaluate(() => closeOrderDetail());
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    await h.clearToasts(page);

    // ===== 6. 两位无档案客户合并后撤销 =====
    assert.equal(await page.evaluate(() => Object.keys(state.customers || {}).length), 0, 'neither customer has a profile');
    await page.evaluate(() => { setPage('customers'); mergeDuplicateCustomers('Plain Buyer Two', 'Plain Buyer One'); });
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open') && /保留：Plain Buyer Two/.test(document.getElementById('confirmMessage').textContent));
    await h.click(page, '#confirmOkBtn', 'confirm merge');
    await h.waitToast(page, '已合并到 Plain Buyer Two');
    assert.equal((await h.order(page, 'm1')).client, 'Plain Buyer Two');
    await h.clickUndo(page, '已合并到 Plain Buyer Two');
    await h.waitToast(page, '已撤销合并');
    assert.deepEqual(await h.toasts(page).then(list => list.filter(text => text.includes('撤销已失效'))), [], 'the undo still works');
    assert.equal((await h.order(page, 'm1')).client, 'Plain Buyer One', 'the order goes back to its customer');
    assert.equal(await page.evaluate(() => Object.hasOwn(state.customers || {}, 'Plain Buyer Two')), false, 'the merged profile is gone again');
    await saved();
    await h.clearToasts(page);
    await page.evaluate(() => setPage('dashboard'));

    // ===== 2. 订单弹窗的物流记录和附件放得下 =====
    for (const viewport of [{ width:1294, height:847 }, { width:1694, height:1082 }]) {
      await page.setViewportSize(viewport);
      for (const mode of ['edit', 'new']) {
        if (mode === 'edit') await page.evaluate(() => openOrder('s1'));
        else {
          await page.evaluate(() => openOrder());
          await page.evaluate(() => uiOrderCompact(document.getElementById('orderForm'), false));
        }
        await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
        await h.settle(page, '#orderModal .order-modal');
        const label = `${mode} ${viewport.width}×${viewport.height}`;
        for (const selector of ['#orderForm [data-add-shipment]', '#orderForm [data-remove-shipment]', '#orderForm [data-shipment-status] + .app-select-button, #orderForm .app-select:has([data-shipment-status]) .app-select-button', '#addAttachmentBtn', '#attachmentLink']) {
          const hit = await page.locator(selector).first().evaluate(el => {
            el.scrollIntoView({ block:'center', inline:'nearest' });
            // 用户不会去横着拖中栏：放回最左边再看这一点能不能点到。
            document.querySelector('#orderModal .order-main').scrollLeft = 0;
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.right - 4, r.top + r.height / 2);
            return top === el || el.contains(top);
          });
          assert.ok(hit, `${label}: the right edge of ${selector} can be clicked`);
        }
        const overflow = await page.evaluate(() => { const main = document.querySelector('#orderModal .order-main'); return { scroll:main.scrollWidth - main.clientWidth, left:main.scrollLeft }; });
        assert.deepEqual(overflow, { scroll:0, left:0 }, `${label}: the middle column does not scroll sideways`);
        await page.evaluate(() => closeOrder());
        await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
      }
    }

    // ===== 3 + 5. 续费编辑弹窗：下拉开着按 Esc；最小窗口、界面 100% 的日历 =====
    await page.setViewportSize({ width:1100, height:720 });
    await page.evaluate(() => setPage('subscriptions'));
    await h.click(page, '#subsAddBtn', 'new renewal');
    await page.waitForFunction(() => document.getElementById('subscriptionEditModal').classList.contains('open'));
    await h.settle(page, '#subscriptionEditModal .subs-modal');
    const remindButton = '#subscriptionEditModal .app-select:has(#subscriptionRemind) .app-select-button';
    const escOnOpenSelect = async label => {
      await h.click(page, remindButton, 'remind select');
      await page.waitForFunction(() => activeAppSelect?.id === 'subscriptionRemind');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !activeAppSelect);
      assert.ok(await isOpen('subscriptionEditModal'), `${label}: Esc on the open dropdown leaves the dialog open`);
      assert.equal(await isOpen('confirmModal'), false, `${label}: no "discard changes?" question`);
    };
    await escOnOpenSelect('empty form');
    await page.locator('#subscriptionName').fill('Audit Cloud');
    await escOnOpenSelect('edited form');

    const popover = page.locator('#datePickerPopover');
    for (const id of ['subscriptionStart', 'subscriptionNext']) {
      await h.click(page, `#${id}`, id);
      await popover.waitFor({ state:'visible' });
      await h.settle(page, '#datePickerPopover');
      const box = await page.evaluate(id => {
        const field = document.getElementById(id).getBoundingClientRect();
        const pop = document.getElementById('datePickerPopover').getBoundingClientRect();
        return { field:{ top:field.top, bottom:field.bottom, left:field.left, right:field.right }, pop:{ top:pop.top, bottom:pop.bottom, left:pop.left, right:pop.right }, vw:innerWidth, vh:innerHeight };
      }, id);
      assert.ok(box.pop.top >= 0 && box.pop.left >= 0 && box.pop.bottom <= box.vh && box.pop.right <= box.vw, `${id}: the calendar stays inside the window ${JSON.stringify(box)}`);
      const overlaps = box.pop.left < box.field.right && box.pop.right > box.field.left && box.pop.top < box.field.bottom && box.pop.bottom > box.field.top;
      assert.equal(overlaps, false, `${id}: the calendar does not cover its own field ${JSON.stringify(box)}`);
      await page.keyboard.press('Escape');
      await popover.waitFor({ state:'hidden' });
    }

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    await context.close();
    console.log('Audit V3.154 fixes passed: drawer dates settle before ⌘S, shipment and attachment rows fit the order modal, Esc on a renewal dropdown, calendar inside a short window, undo of a merge of two plain customers.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
