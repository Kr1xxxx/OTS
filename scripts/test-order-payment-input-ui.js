#!/usr/bin/env node
// 金额与收款（V3.118）：全部用键盘逐键输入，不直接赋值。
// 改订单金额时已付款不被截断；已付款能输小数；超过订单金额只提示、保存时用页面内确认框问；
// 新单 / 编辑弹窗按收款推进阶段并提前显示；全款单的部分收款不被清零；误点订单类型能恢复；
// 定金框够宽并显示比例；粘贴识别不被隐藏的自动值挡住；选了比例后改金额定金跟着比例走。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
const month = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
const base = { country:'🇺🇸 美国 United States', currency:'USD', amount:1000, paidAmount:0, depositAmount:0, depositPercent:0, orderType:'定金订单', stage:'quote', productType:'睫毛', paymentChannel:'Paypal', createdAt:`${month}-01`, orderMonth:month, updated:`${month}-01 09:00`, logs:[], logisticsStatus:'未发货', shipments:[], attachments:[], note:'' };
const deposit = { orderType:'定金订单', depositAmount:300, depositPercent:30 };
const full = { orderType:'全款订单', depositAmount:1000, depositPercent:100 };
const PASTE_FORCE_KEYS = ['createdAt', 'currency', 'paymentChannel', 'productType', 'orderType', 'trackingNumber', 'carrier', 'fullPaymentStatus', 'urgentOrder', 'shipmentStatus', 'stage'];

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1280, height:900 } });
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
    let stored = { app:'trade-order-system', revision:0, data:{
      orders:[
        { ...base, ...deposit, id:'o-bal', num:'K-BAL', client:'Balance Buyer', paidAmount:300, stage:'balance' },
        { ...base, ...deposit, id:'o-eur', num:'K-EUR', client:'Euro Buyer', currency:'EUR', amount:2000, depositAmount:600, paidAmount:600, stage:'balance' },
        { ...base, ...deposit, id:'o-quote', num:'K-QUOTE', client:'Quote Buyer' },
        { ...base, ...deposit, id:'o-quote2', num:'K-QUOTE2', client:'Manual Stage Buyer' },
        { ...base, ...full, id:'o-full-quote', num:'K-FULLQ', client:'Full Quote Buyer' },
        { ...base, ...full, id:'o-full-drawer', num:'K-FULLD', client:'Drawer Buyer' },
        { ...base, ...full, id:'o-full-partial', num:'K-FULLP', client:'Partial Buyer', paidAmount:500, stage:'production' },
        { ...base, ...deposit, id:'o-toggle', num:'K-TOGGLE', client:'Toggle Buyer', paidAmount:300, stage:'balance' }
      ],
      customers:{}, demoCleared:true, demoCustomersCleared:true
    } };
    await page.route('**/*', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:8 }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/save') {
        stored = { ...request.postDataJSON().state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    const field = name => page.locator(`#orderForm [name="${name}"]`);
    const value = name => field(name).inputValue();
    const order = id => page.evaluate(id => {
      const o = state.orders.find(item => item.id === id || item.client === id);
      return o && { stage:o.stage, amount:o.amount, paidAmount:o.paidAmount, depositAmount:o.depositAmount, depositPercent:o.depositPercent, orderType:o.orderType };
    }, id);
    const stageHint = () => page.locator('#orderForm [data-stage-hint]').evaluate(el => el.hidden ? '' : el.textContent);
    const headerStage = () => page.locator('#modalSummary .tag').first().innerText();
    const fieldHint = name => page.locator(`#orderForm [name="${name}"]`).evaluate(el => el.closest('.field').querySelector('.field-hint')?.textContent || '');
    const confirmOpen = () => page.evaluate(() => document.getElementById('confirmModal').classList.contains('open'));
    const openExisting = async id => {
      await page.evaluate(id => openOrder(id), id);
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    };
    const openNew = async client => {
      await page.locator('#newOrderBtn').click();
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
      await page.evaluate(client => {
        const form = document.getElementById('orderForm');
        form.elements.client.value = client;
        if (form.elements.sendFeishuNotification) form.elements.sendFeishuNotification.checked = false;
      }, client);
    };
    const typeInto = async (name, text, { replace = true } = {}) => {
      await field(name).click(replace ? { clickCount:3 } : {});
      await page.keyboard.type(text);
    };
    const clickSave = () => page.getByRole('button', { name:'保存订单' }).click();
    const waitSaved = async () => {
      await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
      await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
    };
    const closeWithoutSaving = () => page.evaluate(() => closeOrder());
    const pickPreset = async percent => {
      await page.locator('#orderForm .deposit-combo .app-select-button').click();
      await page.locator(`[data-app-select-value="${percent}"]`).click();
    };

    // P0-1：定金单已收 300，全选金额逐键改成 1200，已付款不被中间值「1」截断；保存后已收还是 300。
    await openExisting('o-bal');
    await typeInto('amount', '1200');
    assert.equal(await value('amount'), '1200');
    assert.equal(await value('paidAmount'), '300', 'paid must not be clamped while the amount is typed key by key');
    assert.equal(await value('depositAmount'), '300');
    assert.equal(await fieldHint('depositAmount'), '占订单金额 25%', 'deposit shows its share of the amount');
    await clickSave();
    await waitSaved();
    assert.deepEqual(await order('o-bal'), { stage:'balance', amount:1200, paidAmount:300, depositAmount:300, depositPercent:25, orderType:'定金订单' });

    // P0-1：退格改错字（2000 → 2500），EUR 单已收 600 不变。
    await openExisting('o-eur');
    await field('amount').click();
    await page.keyboard.press('End');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Backspace');
    await page.keyboard.type('500');
    assert.equal(await value('amount'), '2500');
    assert.equal(await value('paidAmount'), '600', 'backspacing the amount must not clamp paid');
    await closeWithoutSaving();

    // P0-2：新建定金单 1234.56，选 30%（370.37），已付款逐键输入 370.37，保存后是生产中（收到定金）、已收 370.37，不是全款付清。
    await openNew('Decimal Buyer');
    await page.locator('#orderForm [data-binary-value="定金订单"]').click();
    await typeInto('amount', '1234.56', { replace:false });
    await pickPreset(30);
    assert.equal(await value('depositAmount'), '370.37');
    assert.equal(await fieldHint('depositAmount'), '占订单金额 30%', 'the chosen ratio is visible without opening the menu');
    await field('paidAmount').click();
    const seen = [];
    for (const ch of '370.37') {
      await page.keyboard.type(ch);
      seen.push(await value('paidAmount'));
    }
    assert.equal(seen.at(-1), '370.37', `decimal paid must survive key-by-key typing (saw ${seen.join(' → ')})`);
    assert.ok(!seen.includes('1234.56'), `paid must never jump to the full amount (saw ${seen.join(' → ')})`);
    assert.equal(await stageHint(), '保存后会按收款自动放到「生产中」');
    assert.equal(await headerStage(), '生产中');
    await clickSave();
    await waitSaved();
    assert.deepEqual(await order('Decimal Buyer'), { stage:'production', amount:1234.56, paidAmount:370.37, depositAmount:370.37, depositPercent:30, orderType:'定金订单' });

    // P0-2：先填已付款、后填金额，已付款不被清空。超过订单金额只提示；保存时问，选「回去修改」不保存。
    await openNew('Overflow Buyer');
    await page.locator('#orderForm [data-binary-value="定金订单"]').click();
    await typeInto('paidAmount', '300', { replace:false });
    assert.equal(await value('paidAmount'), '300', 'paid typed before the amount must stay');
    await typeInto('amount', '1000', { replace:false });
    assert.equal(await value('paidAmount'), '300');
    await typeInto('paidAmount', '1500');
    assert.equal(await value('paidAmount'), '1500', 'over-amount paid is not rewritten while typing');
    assert.equal(await fieldHint('paidAmount'), '已付款超过订单金额 $1,000 USD');
    await clickSave();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.locator('#confirmTitle').innerText(), '已付款超过订单金额');
    assert.match(await page.locator('#confirmMessage').innerText(), /已付款填的是 \$1,500 USD。继续保存会按订单金额记为 \$1,000 USD/);
    assert.equal(await page.locator('#confirmCancelBtn').innerText(), '回去修改');
    await page.locator('#confirmCancelBtn').click();
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.evaluate(() => document.getElementById('orderModal').classList.contains('open')), true, '「回去修改」 keeps the order open');
    assert.equal(await order('Overflow Buyer'), undefined, '「回去修改」 must not save');
    assert.equal(await field('paidAmount').evaluate(el => el.closest('.field').classList.contains('ui-err') && document.activeElement === el), true, 'the over-amount field is marked and focused');
    await clickSave();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await page.locator('#confirmOkBtn').click();
    await waitSaved();
    assert.deepEqual(await order('Overflow Buyer'), { stage:'production', amount:1000, paidAmount:1000, depositAmount:0, depositPercent:0, orderType:'定金订单' });

    // P1-1：新单默认「全款 + 已付」，阶段框还是报价，但头部标签和提示提前说出保存后进生产中，保存的提示也写明。
    await openNew('Default Buyer');
    await typeInto('amount', '1000', { replace:false });
    assert.equal(await value('stage'), 'quote');
    assert.equal(await stageHint(), '保存后会按收款自动放到「生产中」');
    assert.equal(await headerStage(), '生产中', 'the header tag shows the stage the order will be saved in');
    await page.locator('#orderForm [data-binary-value="未付"]').click();
    assert.equal(await stageHint(), '', 'unpaid full-payment order stays in 报价: no hint');
    assert.equal(await headerStage(), '报价');
    await page.locator('#orderForm [data-binary-value="已付"]').click();
    await clickSave();
    await waitSaved();
    assert.equal((await order('Default Buyer')).stage, 'production');
    assert.match(await page.locator('#toast').innerText(), /订单已创建，已按收款放到「生产中」/);

    // P1-2：编辑弹窗登记收款也推进阶段（和详情抽屉一致）。
    await openExisting('o-quote');
    await typeInto('paidAmount', '300');
    assert.equal(await stageHint(), '保存后会按收款自动放到「生产中」');
    await clickSave();
    await waitSaved();
    assert.equal((await order('o-quote')).stage, 'production', 'recording the deposit in the edit modal moves 报价 → 生产中');
    await openExisting('o-full-quote');
    await page.locator('#orderForm [data-binary-value="已付"]').click();
    await clickSave();
    await waitSaved();
    assert.deepEqual(await order('o-full-quote'), { stage:'production', amount:1000, paidAmount:1000, depositAmount:1000, depositPercent:100, orderType:'全款订单' });
    // 用户自己点了阶段：照用户选的。
    await openExisting('o-quote2');
    await typeInto('paidAmount', '300');
    await page.locator('#orderForm [data-binary-value="quote"]').click();
    assert.equal(await stageHint(), '', 'a stage the user picked is kept: no hint');
    await clickSave();
    await waitSaved();
    assert.equal((await order('o-quote2')).stage, 'quote');

    // P1-3：全款单只收了 500：打开显示「部分已付」和 500，只改备注保存，已收 500 不被清零。
    await openExisting('o-full-partial');
    assert.equal(await value('fullPaymentStatus'), '部分');
    assert.equal(await field('paidAmount').isVisible(), true, 'partial payment shows the paid field');
    assert.equal(await value('paidAmount'), '500');
    await field('note').click();
    await page.keyboard.type('只改备注');
    await clickSave();
    await waitSaved();
    assert.deepEqual(await order('o-full-partial'), { stage:'production', amount:1000, paidAmount:500, depositAmount:1000, depositPercent:100, orderType:'全款订单' });
    // 抽屉里给全款单填已收 500，保存后还是 500。
    await page.evaluate(() => openOrderDetail('o-full-drawer', { tab:'payment' }));
    const drawerPaid = page.locator('#orderDetailBody [data-dedit="paidAmount"]').first();
    await drawerPaid.click({ clickCount:3 });
    await page.keyboard.type('500');
    await page.locator('#detailSaveBtn').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'o-full-drawer').paidAmount === 500);
    await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
    assert.equal((await order('o-full-drawer')).paidAmount, 500, 'drawer partial payment on a full-payment order is kept');
    await page.evaluate(() => closeOrderDetail());

    // P1-4：待发货单误点「全款订单」：先问（选「不改」什么都不变）；确认后已收保留为部分已付，全款单没有待发货，
    // 货已做好的单放回前一列生产中（V3.141 起不再退回报价）；再点回「定金订单」不再问，已付、定金、比例、待发货原样恢复，保存后数据不变。
    await openExisting('o-toggle');
    await page.locator('#orderForm [data-binary-value="全款订单"]').click();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.locator('#confirmTitle').innerText(), '改成全款订单？');
    assert.match(await page.locator('#confirmMessage').innerText(), /已收 \$300 USD.*已收金额保留.*部分已付.*阶段改为「生产中」/);
    await page.locator('#confirmCancelBtn').click();
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await value('orderType'), '定金订单', '「不改」 keeps the order type');
    assert.equal(await page.locator('#orderForm [data-binary-value="定金订单"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await value('paidAmount'), '300');
    await page.locator('#orderForm [data-binary-value="全款订单"]').click();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await page.locator('#confirmOkBtn').click();
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await value('fullPaymentStatus'), '部分');
    assert.equal(await value('paidAmount'), '300');
    assert.equal(await value('stage'), 'production', '全款 has no 待发货: the goods are made, so the order goes back one column to 生产中, not to 报价');
    await page.locator('#orderForm [data-binary-value="定金订单"]').click();
    assert.equal(await confirmOpen(), false, 'switching back to the saved type restores without asking');
    assert.equal(await value('paidAmount'), '300');
    assert.equal(await value('depositAmount'), '300');
    assert.equal(await value('stage'), 'balance');
    await clickSave();
    await waitSaved();
    assert.deepEqual(await order('o-toggle'), { stage:'balance', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30, orderType:'定金订单' });
    // 详情抽屉里改订单类型且已收过钱：和订单弹窗一样先用页面内确认框说明（V3.121，审查 06 P2-2）。
    // 选「不改」什么都不存；确认后已收 300 保留为全款的部分已付，全款单没有待发货，阶段放回生产中。
    await page.evaluate(() => openOrderDetail('o-toggle', { tab:'payment' }));
    await page.locator('#orderDetailBody [data-dedit="orderType"]').evaluate(select => {
      select.value = '全款订单';
      select.dispatchEvent(new Event('change', { bubbles:true }));
    });
    await page.locator('#detailSaveBtn').click();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.locator('#confirmTitle').innerText(), '改成全款订单？');
    assert.match(await page.locator('#confirmMessage').innerText(), /已收 \$300 USD.*阶段改为「生产中」/s);
    await page.locator('#confirmCancelBtn').click();
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal((await order('o-toggle')).orderType, '定金订单', '「不改」 saves nothing');
    await page.locator('#detailSaveBtn').click();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await page.locator('#confirmOkBtn').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'o-toggle').orderType === '全款订单');
    await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
    assert.deepEqual(await order('o-toggle'), { stage:'production', amount:1000, paidAmount:300, depositAmount:1000, depositPercent:100, orderType:'全款订单' });
    await page.evaluate(() => closeOrderDetail());

    // P1-5：定金框单独一行，输入框够宽，金额不被截断。
    await openNew('Layout Buyer');
    await page.locator('#orderForm [data-binary-value="定金订单"]').click();
    await typeInto('amount', '1234.56', { replace:false });
    await pickPreset(30);
    const geometry = await field('depositAmount').evaluate(el => ({ width:el.getBoundingClientRect().width, fits:el.scrollWidth <= el.clientWidth + 1 }));
    assert.ok(geometry.width >= 120, `deposit input is wide enough (${geometry.width}px)`);
    assert.equal(geometry.fits, true, 'deposit amount is not clipped');
    // P2-2：选了 30% 再改金额，定金跟着比例变，不会悄悄变成 15%。
    await typeInto('amount', '2000');
    assert.equal(await value('depositAmount'), '600');
    assert.equal(await fieldHint('depositAmount'), '占订单金额 30%');
    // 手动改了定金金额之后，再改订单金额就保持定金金额不变。
    await typeInto('depositAmount', '500');
    await typeInto('amount', '2500');
    assert.equal(await value('depositAmount'), '500');
    await closeWithoutSaving();

    // P1-7：先填金额（全款 + 已付会自动算出隐藏的已付 / 定金），再用识别结果填「定金订单、已付 300、定金 300」。
    await openNew('Paste Buyer');
    await typeInto('amount', '1000', { replace:false });
    await page.evaluate(keys => fillOrderFieldsFromPaste({ amount:1000, orderType:'定金订单', paidAmount:300, depositAmount:300 }, { forceKeys:keys }), PASTE_FORCE_KEYS);
    assert.equal(await value('orderType'), '定金订单');
    assert.equal(await value('paidAmount'), '300', 'hidden auto-filled paid must not block the recognized value');
    assert.equal(await value('depositAmount'), '300');
    assert.equal(await stageHint(), '保存后会按收款自动放到「生产中」');
    await clickSave();
    await waitSaved();
    assert.deepEqual(await order('Paste Buyer'), { stage:'production', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30, orderType:'定金订单' });

    // 新客户 + 订单的合并表单：同一套规则，已付款逐键输入小数不被改写，超额会提示。
    await page.evaluate(() => openCombinedCustomerOrderModal({}));
    await page.waitForFunction(() => document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
    await page.locator('#combinedOrderForm [data-binary-value="定金订单"]').click();
    await page.locator('#combinedOrderForm input[name="amount"]').click();
    await page.keyboard.type('1000');
    await page.locator('#combinedOrderForm input[name="paidAmount"]').click();
    await page.keyboard.type('300.5');
    assert.equal(await page.locator('#combinedOrderForm input[name="paidAmount"]').inputValue(), '300.5');
    assert.equal(await page.locator('#combinedOrderForm [data-stage-hint]').evaluate(el => el.hidden ? '' : el.textContent), '保存后会按收款自动放到「生产中」');

    assert.deepEqual(dialogs, [], 'native dialogs are not allowed');
    assert.deepEqual(errors, []);
    console.log('Order payment input passed: key-by-key amount / paid / decimals untouched, save-time over-amount confirm, stage preview + edit-modal advance, partial full-payment kept, type toggle restores, deposit width + ratio, paste fill, preset follows amount.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
