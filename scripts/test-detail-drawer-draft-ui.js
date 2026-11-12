#!/usr/bin/env node
// 订单详情抽屉（V3.121）：
// - 草稿点「保存草稿」仍是草稿、不发飞书；转正要点「转为正式订单」，飞书开关沿用用户上次的选择；金额 0 显示成 0；
// - 抽屉叠在没保存的订单弹窗上时，「›」进抽屉、抽屉保存、完整编辑都先用页面内确认框问，不再静默换掉下面那张单；
// - 不在内置列表里的国家 / 币种（阿联酋、Nigeria、AED）加载和保存都保留原文；
// - 保存提示不盖住抽屉按钮、阶段变化写进提示、已付负数拦下、已发货单已付只读、没改动不保存、
//   改币种符号跟着变并记进记录、⌘S / Ctrl+S 保存、阶段条按订单类型画、客户档案不分大小写、定金一行。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { h } = require('./helpers/board-page');

async function launch() {
  try { return await chromium.launch({ headless:true }); }
  catch (_) { return chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium' }); }
}

(async () => {
  const browser = await launch();
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const base = { currency:'USD', logisticsStatus:'未发货', createdAt:`${month}-01`, orderMonth:month, updated:`${month}-01 09:00`, logs:[], productType:'假发', paymentChannel:'Paypal', country:'🇺🇸 美国 United States' };
    const orders = [
      { ...base, id:'dr', num:'K5001', client:'Draft Co', amount:0, paidAmount:0, orderType:'定金订单', stage:'quote', isDraft:true },
      { ...base, id:'q1', num:'K5002', client:'Alice', amount:1000, paidAmount:0, depositAmount:300, depositPercent:30, orderType:'定金订单', stage:'quote' },
      { ...base, id:'b1', num:'K5003', client:'Bob', amount:500, paidAmount:200, depositAmount:200, depositPercent:40, orderType:'定金订单', stage:'balance', note:'b1 note' },
      { ...base, id:'b2', num:'K5004', client:'Bob', amount:800, paidAmount:800, orderType:'全款订单', stage:'production', note:'b2 note' },
      { ...base, id:'s1', num:'K5005', client:'Carl', amount:300, paidAmount:300, orderType:'全款订单', stage:'shipment',
        shipments:[{ id:'s1-1', trackingNumber:'1234567890', carrier:'DHL', status:'运输中', shippedAt:`${month}-02` }] },
      { ...base, id:'uae', num:'K5006', client:'Dubai Co', amount:700, paidAmount:0, orderType:'定金订单', stage:'quote', country:'🇦🇪 阿联酋 United Arab Emirates', currency:'AED' },
      { ...base, id:'ng', num:'K5007', client:'Lagos Co', amount:900, paidAmount:0, orderType:'定金订单', stage:'quote', country:'Nigeria' },
      { ...base, id:'ev', num:'K5008', client:'eve stone', amount:400, paidAmount:0, orderType:'定金订单', stage:'quote', currency:'GBP' }
    ];
    const customers = {
      Bob:{ client:'Bob', country:'🇺🇸 美国 United States' },
      'Eve Stone':{ client:'Eve Stone', country:'🇬🇧 英国 United Kingdom', contact:'Eve', email:'eve@stone.test', phones:['+44 20 7946 0000'], permanentNote:'只收 GBP' }
    };
    let stored = { app:'trade-order-system', data:{ orders, customers, demoCleared:true, demoCustomersCleared:true }, revision:0 };
    const notificationCalls = [];
    const context = await browser.newContext({ viewport:{ width:1294, height:847 } });
    await context.addInitScript(() => {
      try {
        localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10));
        // 用户上次在订单弹窗里选了「不发飞书」。
        localStorage.setItem('ots-feishu-send-v1', '0');
      } catch (_) {}
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss(); });
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
      if (pathname === '/api/order-notification') { notificationCalls.push(route.request().postData() || ''); response = { ok:false, message:'not configured' }; }
      if (pathname === '/api/save') {
        const body = route.request().postDataJSON();
        stored = { ...body.state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47997/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    const order = id => page.evaluate(id => JSON.parse(JSON.stringify(state.orders.find(o => o.id === id))), id);
    const isOpen = id => page.evaluate(id => document.getElementById(id)?.classList.contains('open'), id);
    const flush = () => page.evaluate(() => window.flushPendingSave());
    const storedOrder = id => stored.data.orders.find(o => o.id === id);
    const waitToast = text => page.waitForFunction(text => [...document.querySelectorAll('#toast .toast-item:not(.leaving)')].some(el => el.textContent.includes(text)), text);
    const dedit = name => page.locator(`#orderDetailBody [data-dedit="${name}"]`);
    const openDrawer = (id, tab = 'info') => h.openDrawer(page, id, tab);
    const closeDrawer = async () => {
      await page.evaluate(() => closeOrderDetail());
      await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    };
    // 逐键输入：先把光标放到最后（macOS 上 End 不移光标，用 setSelectionRange）。
    const typeAtEnd = async (locator, text) => {
      await locator.click();
      await locator.evaluate(el => { const end = el.value.length; el.setSelectionRange?.(end, end); });
      await page.keyboard.type(text, { delay:5 });
    };
    const replaceText = async (locator, text) => {
      await locator.click();
      await locator.evaluate(el => el.select());
      await page.keyboard.press('Backspace');
      await page.keyboard.type(text, { delay:5 });
    };
    // 抽屉保存完：写进数据库、按保存后的订单重画、抽屉又是干净的。
    const saveDrawer = async (selector = '#detailSaveBtn') => {
      await page.waitForFunction(() => uiDetailUnsaved());
      await page.locator(selector).click();
      await page.waitForFunction(() => !uiDetailUnsaved() && !document.getElementById('orderForm').dataset.saving
        && !document.getElementById('detailSaveBtn').dataset.morph && !document.getElementById('detailPromoteBtn').dataset.morph);
    };
    const confirmSub = () => page.locator('#confirmSub').innerText();
    const waitConfirm = () => page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    const answer = async ok => {
      await page.locator(ok ? '#confirmOkBtn' : '#confirmCancelBtn').click();
      await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    };

    // ===== 06 P1-3：不在内置列表里的国家 / 币种保留原文 =====
    assert.equal((await order('uae')).country, '🇦🇪 阿联酋 United Arab Emirates', '加载时不再改成「其他」');
    assert.equal((await order('uae')).currency, 'AED', '加载时不再改成 USD');
    assert.equal((await order('ng')).country, 'Nigeria');
    await openDrawer('uae');
    assert.equal(await dedit('country').inputValue(), '🇦🇪 阿联酋 United Arab Emirates', '抽屉国家框显示原文');
    assert.match(await page.locator('#detailChips').innerText(), /阿联酋/);
    assert.match(await page.locator('#detailChips').innerText(), /700 AED/, '金额按原币种显示，不写成 $700 USD');
    await page.locator('[data-detail-tab-btn="payment"]').click();
    assert.equal(await dedit('currency').inputValue(), 'AED', '币种下拉选中 AED');
    await page.locator('[data-detail-tab-btn="info"]').click();
    await typeAtEnd(dedit('note'), 'uae note');
    await saveDrawer();
    await waitToast('订单已保存');
    await closeDrawer();
    await page.evaluate(() => openOrder('ng'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    assert.equal(await page.locator('#orderForm [name="country"]').inputValue(), 'Nigeria');
    await typeAtEnd(page.locator('#orderForm [name="note"]'), 'ng note');
    await page.getByRole('button', { name:'保存订单' }).click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'ng').note === 'ng note' && !document.getElementById('orderModal').classList.contains('open'));
    await flush();
    assert.equal(storedOrder('uae').country, '🇦🇪 阿联酋 United Arab Emirates', '保存后国家原文还在');
    assert.equal(storedOrder('uae').currency, 'AED', '保存后币种还是 AED');
    assert.equal(storedOrder('ng').country, 'Nigeria');
    assert.equal(storedOrder('ng').currency, 'USD');

    // ===== 06 P1-1：草稿在抽屉里保存仍是草稿，转正要明确操作 =====
    await openDrawer('dr');
    assert.equal(await dedit('note').count(), 1);
    await page.locator('[data-detail-tab-btn="payment"]').click();
    assert.equal(await dedit('amount').inputValue(), '0', '金额 0 显示成 0，不是空白');
    await page.locator('[data-detail-tab-btn="info"]').click();
    assert.equal((await page.locator('#detailSaveBtn').innerText()).trim(), '保存草稿');
    assert.equal(await page.locator('#detailPromoteBtn').isVisible(), true, '草稿有单独的「转为正式订单」');
    assert.equal(await page.locator('#detailFeishuToggle').isChecked(), false, '飞书开关沿用上次「不发」的选择');
    await typeAtEnd(dedit('note'), 'draft note only');
    await saveDrawer();
    await waitToast('订单草稿已保存');
    let dr = await order('dr');
    assert.equal(dr.isDraft, true, '草稿点保存仍是草稿');
    assert.equal(dr.note, 'draft note only');
    assert.equal(dr.feishuNotification?.requested, false);
    assert.equal(notificationCalls.length, 0, '草稿保存不发飞书');
    // 转正：飞书开关只跟着这个按钮。
    await typeAtEnd(dedit('next'), '发 PI');
    await saveDrawer('#detailPromoteBtn');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'dr').isDraft === false);
    dr = await order('dr');
    assert.equal(dr.next, '发 PI');
    assert.equal(dr.feishuNotification?.requested, false, '开关没勾就不发');
    assert.equal(notificationCalls.length, 0);
    assert.equal(await page.locator('#detailPromoteBtn').isVisible(), false, '转正后不再显示「转为正式订单」');
    assert.equal((await page.locator('#detailSaveBtn').innerText()).trim(), '保存');
    await closeDrawer();

    // ===== 06 P1-2：抽屉叠在没保存的订单弹窗上 =====
    await page.evaluate(() => openOrder('b1'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await typeAtEnd(page.locator('#orderForm [name="note"]'), ' UNSAVED-MODAL');
    await page.evaluate(() => jumpToCustomerProfile('Bob'));
    await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
    await page.locator('#customerModal [data-customer-detail-order="b2"]').click();
    await waitConfirm();
    assert.equal(await confirmSub(), '查看订单', '档案里点「›」先问下面那张没保存的订单');
    await answer(false);
    assert.equal(await isOpen('orderDetailDrawer'), false, '选了继续编辑就不打开抽屉');
    assert.equal(await isOpen('orderModal'), true);
    assert.equal(await page.locator('#orderForm [name="note"]').inputValue(), 'b1 note UNSAVED-MODAL', '弹窗里的输入还在');
    await page.evaluate(() => closeCustomerModal());
    // 换一条路把抽屉叠上去（搜索等入口），在抽屉里保存。
    await page.evaluate(() => openOrderDetail('b2'));
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    await typeAtEnd(dedit('note'), ' drawer');
    await page.locator('#detailSaveBtn').click();
    await waitConfirm();
    assert.equal(await confirmSub(), '保存订单详情', '抽屉保存会换掉下面的弹窗：先问');
    assert.match(await page.locator('#confirmMessage').innerText(), /K5003/);
    await answer(false);
    assert.equal((await order('b2')).note, 'b2 note', '取消后抽屉没保存');
    assert.equal(await isOpen('orderModal'), true);
    assert.equal(await page.locator('#orderForm [name="note"]').inputValue(), 'b1 note UNSAVED-MODAL', '取消后弹窗里的输入还在');
    assert.equal(await page.evaluate(() => editingId), 'b1');
    // 完整编辑…：抽屉自己有改动先问抽屉，选继续编辑留下。
    await page.locator('#detailEditBtn').click();
    await waitConfirm();
    assert.equal(await confirmSub(), '编辑订单');
    await answer(false);
    assert.equal(await page.locator('#orderForm [name="note"]').inputValue(), 'b1 note UNSAVED-MODAL');
    // 确认放弃下面那张单，再保存抽屉。
    await page.locator('#detailSaveBtn').click();
    await waitConfirm();
    await answer(true);
    await page.waitForFunction(() => state.orders.find(o => o.id === 'b2').note === 'b2 note drawer');
    await page.waitForFunction(() => !document.getElementById('orderForm').dataset.saving);
    assert.equal(await isOpen('orderModal'), false);
    assert.equal(await isOpen('orderDetailDrawer'), true);
    assert.equal((await order('b1')).note, 'b1 note', '放弃的是弹窗里没保存的输入，b1 本身没被改');

    // ===== 06 P2-1：保存提示不盖住抽屉的「取消 / 保存」 =====
    const overlap = await page.evaluate(() => {
      const toastItem = document.querySelector('#toast .toast-item:not(.leaving)');
      if (!toastItem) return 'no toast';
      const t = toastItem.getBoundingClientRect();
      return ['detailSaveBtn', 'detailCancelBtn'].filter(id => {
        const b = document.getElementById(id).getBoundingClientRect();
        return !(t.right < b.left || t.left > b.right || t.bottom < b.top || t.top > b.bottom);
      });
    });
    assert.deepEqual(overlap, [], '提示不盖住抽屉底部按钮');
    await closeDrawer();

    // ===== 06 P2-13：打开抽屉时焦点在当前页签上（不在「复制订单号」小图标上），← / → 切页签 =====
    await page.evaluate(() => openOrderDetail('b1'));
    await page.waitForFunction(() => document.activeElement?.matches?.('#orderDetailDrawer [data-detail-tab-btn][aria-selected="true"]'));
    const tabOrder = await page.evaluate(() => [...document.querySelectorAll('#detailTabs [data-detail-tab-btn]')].map(el => el.dataset.detailTabBtn));
    const startTab = await page.evaluate(() => document.activeElement.dataset.detailTabBtn);
    const nextTab = tabOrder[(tabOrder.indexOf(startTab) + 1) % tabOrder.length];
    const tabShown = tab => page.waitForFunction(tab => document.activeElement?.dataset?.detailTabBtn === tab
      && document.activeElement.getAttribute('aria-selected') === 'true'
      && !document.querySelector(`#orderDetailBody [data-detail-tab="${tab}"]`)?.hidden, tab);
    await page.keyboard.press('ArrowRight');
    await tabShown(nextTab);
    await page.keyboard.press('ArrowLeft');
    await tabShown(startTab);
    await closeDrawer();

    // ===== 06 P2-4：没改动点保存不写记录、不刷新「最近更新」 =====
    await openDrawer('b1');
    const b1Before = await order('b1');
    await page.locator('#detailSaveBtn').click();
    await waitToast('没有修改');
    const b1After = await order('b1');
    assert.equal(b1After.updated, b1Before.updated);
    assert.equal(b1After.logs.length, b1Before.logs.length);

    // ===== 06 P2-13：⌘S / Ctrl+S 保存 =====
    await typeAtEnd(dedit('note'), ' via shortcut');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'b1').note === 'b1 note via shortcut');

    // ===== 06 P2-3：已付负数拦下 =====
    await page.locator('[data-detail-tab-btn="payment"]').click();
    await replaceText(dedit('paidAmount'), '-50');
    await page.locator('#detailSaveBtn').click();
    await waitToast('已付金额要填 0 或以上的数字');
    assert.equal((await order('b1')).paidAmount, 200, '负数已付没有保存');
    assert.equal((await order('b1')).stage, 'balance');
    await replaceText(dedit('paidAmount'), '200');

    // ===== 06 P2-5：改币种，符号和摘要跟着变，记录写明 =====
    const currency = dedit('currency');
    const appSelectButton = currency.locator('xpath=..').locator('.app-select-button');
    if (await appSelectButton.count()) {
      await appSelectButton.click();
      await page.locator('.app-select-popover [data-app-select-value="EUR"]').click();
    } else {
      await currency.selectOption('EUR');
    }
    await page.waitForFunction(() => document.querySelector('#orderDetailBody [data-detail-cur-symbol]')?.textContent === '€');
    assert.match(await page.locator('.order-detail-payment-head').innerText(), /€500 EUR/);
    await saveDrawer();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'b1').currency === 'EUR');
    assert.match((await order('b1')).logs[0].text, /币种：USD → EUR/);
    await closeDrawer();

    // ===== 06 P2-8：报价阶段的定金单催的是定金；称呼用联系人，不拼中文括号 =====
    const dunning = await page.evaluate(() => fillCopyTemplate(copyTemplate('dunning'), orderCopyVars(state.orders.find(o => o.id === 'q1'))));
    assert.match(dunning, /outstanding deposit of \$300 USD/, '没收定金的报价单催定金 $300，不是全款 $1,000');
    const greeting = await page.evaluate(() => fillCopyTemplate(copyTemplate('status'), orderCopyVars(state.orders.find(o => o.id === 'ev'))));
    assert.match(greeting, /^Hi Eve,/, '称呼用联系人');
    assert.doesNotMatch(greeting, /（/, '英文文案里没有全角括号');

    // ===== 06 P2-2 / P2-7：报价定金单填定金，提示写明阶段；定金一行 =====
    await openDrawer('q1', 'payment');
    assert.match(await page.locator('#orderDetailBody .order-detail-deposit').innerText(), /定金：\$300 USD（30%）\s*· 未收/);
    assert.equal(await dedit('paidAmount').getAttribute('placeholder'), '定金 300');
    await replaceText(dedit('paidAmount'), '300');
    await saveDrawer();
    await waitToast('已按收款放到「生产中」');
    assert.equal((await order('q1')).stage, 'production');
    await closeDrawer();

    // ===== 06 P2-3 / P2-6：已发货单已付只读；阶段条按订单类型画、当前阶段不能点 =====
    await openDrawer('s1', 'payment');
    assert.equal(await dedit('paidAmount').evaluate(el => el.readOnly), true, '已发货单的已付只读');
    assert.equal(await page.locator('#detailStageBar [data-detail-stage="balance"]').count(), 0, '全款单没有尾款');
    assert.equal(await page.locator('#detailStageBar [data-detail-stage="shipment"]').isDisabled(), true, '当前阶段不能点');
    await closeDrawer();
    await openDrawer('b2');
    const flow = await page.locator('#detailStageBar [data-detail-stage]').evaluateAll(list => list.map(btn => btn.dataset.detailStage));
    assert.deepEqual(flow, ['quote', 'production', 'shipment', 'done']);
    await closeDrawer();
    await openDrawer('b1');
    const depositFlow = await page.locator('#detailStageBar [data-detail-stage]').evaluateAll(list => list.map(btn => btn.dataset.detailStage));
    assert.deepEqual(depositFlow, ['quote', 'production', 'balance', 'shipment', 'done'], '定金单按看板列的顺序「报价 → 生产中 → 待发货」画');
    await closeDrawer();

    // ===== 06 P2-9：客户档案按名字不分大小写找；电话显示出来 =====
    await openDrawer('ev');
    const info = await page.locator('#orderDetailBody [data-detail-tab="info"]').innerText();
    assert.match(info, /只收 GBP/, '永久备注能显示');
    assert.match(info, /eve@stone\.test/);
    assert.match(info, /\+44 20 7946 0000/);
    assert.equal(await page.evaluate(() => document.getElementById('detailCustomerBtn').dataset.customer), 'Eve Stone');
    await closeDrawer();

    assert.deepEqual(errors, []);
    console.log('Detail drawer tests passed: draft save/promote and Feishu choice, stacked order modal guard, unknown country/currency kept, toast position, initial focus + tab arrows, no-op save, shortcut save, negative paid, currency symbol + log, stage note, deposit line, read-only paid, stage bar flow, case-insensitive customer.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
