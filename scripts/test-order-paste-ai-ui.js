#!/usr/bin/env node
// 订单弹窗的粘贴识别（V3.120）：本地规则和 AI 两条路径，AI 回复全部用 mock，不连真实网络。
// 没写币种不改已有币种 / 客户币种；编辑已有订单时不静默改订单类型、已付、创建日期、收款方式、阶段；
// 新客户卡片和「确认客户和订单」用 AI 的定金比例和已付；AI 认出的老客户带入国家和币种；
// 等待时能取消、不重复请求；失败提示是中文；结果卡标出来源。所有确认都是页面内的 appConfirm。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
const base = { amount:800, paidAmount:240, depositAmount:240, depositPercent:30, orderType:'定金订单', stage:'balance', productType:'假发', paymentChannel:'Paypal', createdAt:'2025-10-15', orderMonth:'2025-10', updated:'2025-10-15 09:00', logs:[], logisticsStatus:'未发货', shipments:[], attachments:[], note:'' };
const spain = '🇪🇸 西班牙 Spain';
const france = '🇫🇷 法国 France';

async function launch() {
  try {
    return await chromium.launch({ headless:true });
  } catch (error) {
    if (!fs.existsSync('/opt/pw-browsers/chromium')) throw error;
    return chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium' });
  }
}

(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport:{ width:1360, height:900 } });
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    let stored = { app:'trade-order-system', revision:0, data:{
      orders:[
        { ...base, id:'o-eur', num:'K-EUR', client:'Maria Lopez', country:spain, currency:'EUR' },
        { ...base, id:'o-ship', num:'K-SHIP', client:'Euro Ship Buyer', country:spain, currency:'EUR' }
      ],
      customers:{
        'Maria Lopez':{ country:spain, currency:'EUR', phone:'+34 612 345 678', productType:'假发', paymentMethod:'Paypal' },
        'Sophie Martin':{ country:france, currency:'EUR', paymentMethod:'TT', productType:'假发' }
      },
      demoCleared:true, demoCustomersCleared:true
    } };
    // AI 接口：ai.fields 是模型回的字段；ai.fail 是服务端回的失败；ai.deferred 时等测试放行。
    let ai = { fields:{} };
    const aiBodies = [];
    let release = null;
    let handled = Promise.resolve();
    await page.route('**/*', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/ai-chat') {
        aiBodies.push(request.postDataJSON());
        const current = ai;
        let done;
        handled = new Promise(resolve => { done = resolve; });
        if (current.deferred) await new Promise(resolve => { release = resolve; current.arrived(); });
        const json = current.fail || { choices:[{ message:{ role:'assistant', content:JSON.stringify(current.fields) } }] };
        // 取消后浏览器已经放弃了这个请求，回复送不到也正常。
        await route.fulfill({ json }).catch(() => {});
        done();
        return;
      }
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/ai-settings') response = { enabled:'是', provider:'custom', baseUrl:'https://fixture.example/v1', model:'fixture', apiKeySaved:true };
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:2 }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/save') {
        stored = { ...request.postDataJSON().state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    // 记下每次「填入」的结果（true 填了 / false 取消），测试等它而不是等固定时间。
    await page.evaluate(() => {
      window.__fills = [];
      const original = window.fillOrderFieldsFromPaste;
      window.fillOrderFieldsFromPaste = async function (...args) {
        const result = await original.apply(this, args);
        window.__fills.push(result);
        return result;
      };
    });

    // 下一次 AI 请求先挂住：返回的 promise 在请求到达 mock 时完成，release() 放行。
    const holdNextAi = fields => new Promise(resolve => { ai = { deferred:true, fields, arrived:resolve }; });
    const field = name => page.locator(`#orderForm [name="${name}"]`);
    const value = name => field(name).inputValue();
    const results = page.locator('#pasteAssistResults');
    const resultsText = () => results.innerText();
    const aiBtn = page.locator('#pasteAssistAiBtn');
    const confirmOpen = () => page.evaluate(() => document.getElementById('confirmModal').classList.contains('open'));
    const savedOrder = idOrNum => page.evaluate(key => {
      const o = state.orders.find(item => item.id === key || item.num === key);
      return o && { stage:o.stage, amount:o.amount, paidAmount:o.paidAmount, currency:o.currency, country:o.country, orderType:o.orderType, paymentChannel:o.paymentChannel, createdAt:o.createdAt, trackingNumber:o.trackingNumber, productType:o.productType, client:o.client,
        shipments:(o.shipments || []).map(item => `${item.trackingNumber}/${item.carrier}`) };
    }, idOrNum);
    const openExisting = async id => {
      await page.evaluate(id => { delete document.getElementById('orderForm')._cleanFingerprint; openOrder(id); }, id);
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open') && document.getElementById('orderForm')._cleanFingerprint !== undefined);
    };
    const openNew = async () => {
      await page.evaluate(() => { delete document.getElementById('orderForm')._cleanFingerprint; });
      await page.locator('#newOrderBtn').click();
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open') && document.getElementById('orderForm')._cleanFingerprint !== undefined);
      await page.evaluate(() => {
        const box = document.getElementById('orderForm').elements.sendFeishuNotification;
        if (box) box.checked = false;
      });
    };
    const closeOrderModal = () => page.evaluate(() => closeOrder());
    const clickSave = () => page.getByRole('button', { name:'保存订单' }).click();
    const waitSaved = async () => {
      await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
      await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
    };
    const runLocal = async text => {
      await page.locator('#pasteAssistInput').fill(text);
      await page.locator('#pasteAssistAnalyzeBtn').click();
      await results.locator('[data-paste-source="local"]').waitFor();
    };
    const runAi = async (text, fields) => {
      ai = { fields };
      await page.locator('#pasteAssistInput').fill(text);
      await aiBtn.click();
      await results.locator('[data-paste-source="ai"]').waitFor();
      assert.equal(await aiBtn.isEnabled(), true, 'AI button comes back after the result');
    };
    const runAiFailure = async (text, fail) => {
      ai = { fail };
      await page.locator('#pasteAssistInput').fill(text);
      await aiBtn.click();
      await results.locator('.paste-error-card').waitFor();
      return resultsText();
    };
    // 点一个会填表的按钮；confirm 给了就在确认框里点它，返回确认框里的文字。
    const clickFill = async (selector, confirm = null) => {
      const before = await page.evaluate(() => window.__fills.length);
      await results.locator(selector).first().click();
      let message = '';
      if (confirm) {
        await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
        message = await page.locator('#confirmMessage').innerText();
        await page.locator(confirm).click();
      }
      await page.waitForFunction(n => window.__fills.length > n, before);
      assert.equal(await confirmOpen(), false);
      return { filled:await page.evaluate(() => window.__fills.at(-1)), message };
    };

    // 1. 本地识别，编辑 EUR 订单：只贴物流单号，币种不被兜底成 USD，也不弹确认。
    await openExisting('o-ship');
    await runLocal('DHL tracking 1234567890 shipped today');
    assert.match(await resultsText(), /本地规则识别结果，没有用 AI/);
    assert.doesNotMatch(await resultsText(), /币种|给 .* 新建订单/);
    assert.deepEqual(await clickFill('[data-paste-fill-extracted]'), { filled:true, message:'' }, 'only blank fields: no confirm');
    assert.equal(await value('currency'), 'EUR');
    assert.equal(await value('trackingNumber'), '1234567890');
    assert.equal(await value('orderType'), '定金订单');
    assert.equal(await value('paidAmount'), '240');
    await clickSave();
    await waitSaved();
    const shipped = await savedOrder('o-ship');
    assert.equal(shipped.currency, 'EUR', 'a paste without a currency must not turn EUR into USD');
    assert.equal(shipped.trackingNumber, '1234567890');
    assert.equal(shipped.createdAt, '2025-10-15');

    // 已有物流单号的订单再贴一个新单号：加成第二条物流记录，不覆盖第一条；再贴已有的单号不重复加。
    const shipmentRows = () => page.locator('#orderForm [data-shipment-number]').evaluateAll(inputs => inputs.map(input => input.value));
    await openExisting('o-ship');
    await runLocal('second box: DHL 9876543210');
    assert.deepEqual(await clickFill('[data-paste-fill-extracted]'), { filled:true, message:'' }, 'a new tracking number is added, nothing to confirm');
    assert.deepEqual(await shipmentRows(), ['1234567890', '9876543210']);
    assert.equal(await page.locator('#orderForm [data-shipment-extra-row] [data-shipment-carrier]').inputValue(), 'DHL');
    await runLocal('tracking 1234567890');
    assert.deepEqual(await clickFill('[data-paste-fill-extracted]'), { filled:true, message:'' });
    assert.deepEqual(await shipmentRows(), ['1234567890', '9876543210'], 'a number already on the order is not added twice');
    await clickSave();
    await waitSaved();
    assert.deepEqual((await savedOrder('o-ship')).shipments, ['1234567890/DHL', '9876543210/DHL']);

    // 2. AI 识别，编辑定金 EUR 订单：AI 给了全款 / 已付 / 今天 / Zelle / 生产中。改动先列出来（中文字段名），
    //    创建日期、阶段不改也不列；「只补空字段」和「取消」都不动；「全部改」才改类型和收款方式。
    const today = await page.evaluate(() => normalizeDate(new Date().toISOString()));
    const aiEdit = { orderType:'全款订单', fullPaymentStatus:'已付', createdAt:today, paymentChannel:'Zelle', stage:'production' };
    const editText = 'Hola, ya pagué todo por Zelle hoy';
    await openExisting('o-eur');
    await runAi(editText, aiEdit);
    const editCard = await resultsText();
    assert.match(editCard, /AI 识别结果 · 耗时 \d+\.\d 秒/);
    assert.match(editCard, /AI 没确定金额、币种，请自己填/);
    assert.match(editCard, /这张单已有的内容不会被直接改掉/);
    assert.doesNotMatch(editCard, /stage|production|阶段：|给 .* 新建订单/i, 'the AI stage is neither shown nor applied');
    let step = await clickFill('[data-paste-fill-extracted]', '#confirmAltBtn');
    assert.equal(step.filled, true);
    assert.match(step.message, /订单类型：定金订单 → 全款订单/);
    assert.match(step.message, /收款方式：Paypal → Zelle/);
    assert.match(step.message, /付款状态：部分已付 → 已付/);
    assert.match(step.message, /这张单已收 \S*240/);
    assert.match(step.message, /改成全款订单、付款状态「已付」后，保存时已收按订单金额记成 \S*800/);
    assert.doesNotMatch(step.message, /付款状态显示「部分已付」/, 'the notice describes the status after the change');
    assert.match(step.message, /只补空字段/);
    assert.doesNotMatch(step.message.split('\n\n')[0], /创建日期|币种|阶段|stage|orderType|paymentChannel/);
    assert.equal(await value('orderType'), '定金订单');
    assert.equal(await value('paymentChannel'), 'Paypal');
    assert.equal(await value('paidAmount'), '240');
    assert.equal(await value('createdAt'), '2025-10-15');
    assert.equal(await value('stage'), 'balance');
    step = await clickFill('[data-paste-fill-extracted]', '#confirmCancelBtn');
    assert.equal(step.filled, false, 'cancel fills nothing');
    assert.equal(await value('orderType'), '定金订单');
    step = await clickFill('[data-paste-fill-extracted]', '#confirmOkBtn');
    assert.equal(step.filled, true);
    assert.equal(await value('orderType'), '全款订单');
    assert.equal(await value('paymentChannel'), 'Zelle');
    assert.equal(await value('createdAt'), '2025-10-15', 'an existing order keeps its creation date');
    assert.equal(await value('currency'), 'EUR');
    await clickSave();
    await waitSaved();
    const edited = await savedOrder('o-eur');
    assert.equal(edited.orderType, '全款订单');
    assert.equal(edited.paidAmount, 800);
    assert.equal(edited.stage, 'production');
    assert.equal(edited.paymentChannel, 'Zelle');
    assert.equal(edited.createdAt, '2025-10-15');
    assert.equal(edited.currency, 'EUR');
    assert.notEqual(edited.stage, 'balance', 'a full-payment order has no balance stage');

    // 3. 新单先选了 EUR 客户，再贴没写币种的聊天：币种还是 EUR；说了 paid 是「已付」，没说是「未付」→ 报价。
    const input = page.locator('#orderForm .client-picker input[name="client"]');
    const pickMaria = async () => {
      await input.fill('Maria');
      await page.locator('#orderForm .client-menu [data-select-client="Maria Lopez"]').click();
      await page.waitForFunction(() => document.getElementById('orderForm').elements.currency.value === 'EUR');
    };
    await openNew();
    await pickMaria();
    await runLocal('total 450, paid via paypal');
    assert.match(await resultsText(), /生产中（按收款）/);
    assert.equal((await clickFill('[data-paste-fill-extracted]')).filled, true);
    assert.equal(await value('currency'), 'EUR', 'the customer currency stays');
    assert.equal(await value('amount'), '450');
    assert.equal(await value('fullPaymentStatus'), '已付');
    let num = await value('num');
    await clickSave();
    await waitSaved();
    let saved = await savedOrder(num);
    assert.equal(saved.currency, 'EUR');
    assert.equal(saved.amount, 450);
    assert.equal(saved.stage, 'production');

    await openNew();
    await pickMaria();
    await runLocal('total 450 let me know paypal');
    assert.match(await resultsText(), /报价（聊天没提付款）/);
    await clickFill('[data-paste-fill-extracted]');
    assert.equal(await value('fullPaymentStatus'), '未付', 'no payment in the chat: not the new-order default 已付');
    num = await value('num');
    await clickSave();
    await waitSaved();
    saved = await savedOrder(num);
    assert.equal(saved.amount, 450);
    assert.equal(Number(saved.paidAmount || 0), 0);
    assert.equal(saved.stage, 'quote', 'no deposit received = quote');
    assert.equal(saved.currency, 'EUR');

    // 4. 本地认出老客户（电话一致）：「给这个客户新建订单」带入档案的国家、币种、产品。
    await openNew();
    await runLocal('Maria here, my number +34 612 345 678, total 640');
    const existingCard = await resultsText();
    assert.match(existingCard, /给 Maria Lopez 新建订单/);
    assert.match(existingCard, /币种：EUR/);
    assert.match(existingCard, /阶段：报价（聊天没提付款）/);
    assert.equal((await clickFill('[data-paste-use-existing-customer-order]')).filled, true);
    assert.equal(await value('client'), 'Maria Lopez');
    assert.equal(await value('currency'), 'EUR');
    assert.equal(await value('country'), spain);
    assert.equal(await value('productType'), '假发');
    assert.equal(await value('amount'), '640');
    await closeOrderModal();

    // 5. AI 识别新客户：卡片和「确认客户和订单」用 AI 的定金比例和已付，阶段按收款是「生产中」（收到定金），不用 AI 给的「已发货」。
    const newCustomerText = "Hi I'm Ana Torres from Mexico, 2 wigs total 680 usd, I paid 30% deposit 204 by paypal";
    const aiNew = { client:'Ana Torres', country:'Mexico', amount:680, currency:'USD', orderType:'定金订单', paidAmount:204, depositAmount:204, depositPercent:30, paymentChannel:'Paypal', productType:'假发', stage:'shipment' };
    await openNew();
    await runAi(newCustomerText, aiNew);
    const newCard = await resultsText();
    assert.match(newCard, /识别为新客户：Ana Torres/);
    for (const pill of ['订单类型：定金订单', '定金比例：30%', '已付款：204', '阶段：生产中（按收款）']) assert.ok(newCard.includes(pill), `new customer card misses ${pill}:\n${newCard}`);
    assert.doesNotMatch(newCard, /已发货|stage/i);
    await results.locator('[data-paste-create-customer-order]').click();
    await page.waitForFunction(() => document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
    const combined = name => page.locator(`#combinedOrderForm [name="${name}"]`).inputValue();
    assert.equal(await combined('orderType'), '定金订单');
    assert.equal(await combined('amount'), '680');
    assert.equal(await combined('paidAmount'), '204');
    assert.equal(await combined('currency'), 'USD');
    assert.equal(await page.locator('#combinedCustomerForm [name="name"]').inputValue(), 'Ana Torres');
    assert.match(await page.locator('#combinedOrderForm [data-stage-hint]').evaluate(el => el.hidden ? '' : el.textContent), /生产中/);
    await page.evaluate(() => closeCombinedCustomerOrderModal());

    // 同一段 AI 结果直接「填入识别内容」再保存：收到定金 = 生产中。
    await openNew();
    await runAi(newCustomerText, aiNew);
    await clickFill('[data-paste-fill-extracted]');
    assert.equal(await value('orderType'), '定金订单');
    assert.equal(await value('paidAmount'), '204');
    num = await value('num');
    await clickSave();
    await waitSaved();
    saved = await savedOrder(num);
    assert.equal(saved.stage, 'production', 'deposit received = 生产中');
    assert.equal(saved.paidAmount, 204);

    // 新客户走「确认客户和订单」：AI 识别的订单详情填进弹窗、能改，改过的值被保存（以前这一栏没有，存成空的）。
    const detailText = 'Hi dear, I want 3 pcs 13x4 body wave 22inch 180% density, total $540, I will pay 30% deposit by PayPal today\nName: Lena Hart\nEmail: lena.hart@example.test';
    await openNew();
    await runAi(detailText, { client:'Lena Hart', country:'United States', amount:540, currency:'USD', orderType:'定金订单', depositPercent:30, paymentChannel:'Paypal', productType:'假发', orderDetail:['13x4 body wave 22inch 180% density × 3', 'closure 4x4 × 1'] });
    assert.match(await resultsText(), /识别为新客户：Lena Hart/);
    await results.locator('[data-paste-create-customer-order]').click();
    await page.waitForFunction(() => document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
    const detailField = page.locator('#combinedOrderForm [name="orderDetail"]');
    assert.equal(await detailField.isVisible(), true, 'the combined dialog shows 订单详情');
    assert.equal(await detailField.inputValue(), '13x4 body wave 22inch 180% density × 3\nclosure 4x4 × 1', 'one item per line, not joined with commas');
    assert.equal(await page.evaluate(() => uiFormDirty(document.getElementById('combinedOrderForm'))), false);
    await detailField.fill('13x4 body wave 22inch 180% density × 3\nclosure 4x4 × 2');
    assert.equal(await page.evaluate(() => uiFormDirty(document.getElementById('combinedOrderForm'))), true, 'editing 订单详情 counts as an unsaved change');
    const combinedNum = await combined('num');
    await page.evaluate(() => { const box = document.getElementById('combinedOrderForm').elements.sendFeishuNotification; if (box) box.checked = false; });
    await page.locator('#combinedSaveBtn').click();
    await page.waitForFunction(() => !document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
    await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
    const detailSaved = await page.evaluate(num => state.orders.find(o => o.num === num)?.orderDetail, combinedNum);
    assert.equal(detailSaved, '13x4 body wave 22inch 180% density × 3\nclosure 4x4 × 2');
    assert.equal(stored.data.orders.find(o => o.num === combinedNum)?.orderDetail, detailSaved, 'saved to the database too');
    // 再打开一次是空的：上一单的订单详情不留在表单里。
    await page.evaluate(() => openCombinedCustomerOrderModal({ customerFields:{ name:'Nobody Yet' }, orderFields:{ amount:10 } }));
    assert.equal(await detailField.inputValue(), '');
    await page.evaluate(() => closeCombinedCustomerOrderModal());
    if (await page.evaluate(() => document.getElementById('orderModal').classList.contains('open'))) await closeOrderModal();

    // 6. 德语聊天：本地和 AI 都不把 Zwischensumme 当客户名；本地读出欧洲写法 1.280,50 €。
    const german = 'Hallo, hier ist Anna\n2x Body Wave Perücke 24 Zoll\nZwischensumme: 1.180,50 €\nVersand: 100,00 €\nGesamt: 1.280,50 € (ca. 1,390 USD)\nAnzahlung 30% per Überweisung bezahlt\nLieferadresse: Anna Schmidt, Hauptstraße 12, 10115 Berlin';
    await openNew();
    await runLocal(german);
    const germanLocal = await resultsText();
    assert.match(germanLocal, /金额：1280\.5/);
    assert.match(germanLocal, /币种：EUR/);
    assert.doesNotMatch(germanLocal, /Zwischensumme|Peru|秘鲁|1\.15\b/);
    await runAi(german, { client:'Anna Schmidt', country:'Germany', amount:'1.280,50', currency:'EUR', orderType:'定金订单', depositPercent:30, paidAmount:'384,15', paymentChannel:'TT', productType:'假发' });
    const germanAi = await resultsText();
    assert.match(germanAi, /识别为新客户：Anna Schmidt/);
    assert.match(germanAi, /已付款：384\.15/);
    assert.match(germanAi, /阶段：生产中（按收款）/);
    assert.doesNotMatch(germanAi, /Zwischensumme/);
    await closeOrderModal();

    // 7. AI 认出档案里的老客户：带入档案的国家、币种、收款方式；名字倒过来的只提示「可能是同一人」，用了也带入档案。
    await openNew();
    await runAi('Bonjour, c\'est Sophie. 3 perruques, total 900 €', { client:'Sophie Martin', amount:900, currency:'EUR', productType:'假发' });
    assert.match(await resultsText(), /给 Sophie Martin 新建订单/);
    await clickFill('[data-paste-use-existing-customer-order]');
    assert.equal(await value('client'), 'Sophie Martin');
    assert.equal(await value('country'), france);
    assert.equal(await value('currency'), 'EUR');
    assert.equal(await value('paymentChannel'), 'TT');
    await closeOrderModal();

    await openNew();
    await runAi('Lopez Maria, 1 wig total 300', { client:'Lopez Maria', amount:300 });
    const similar = await resultsText();
    assert.match(similar, /匹配客户：Maria Lopez/);
    assert.match(similar, /可能和已有客户 Maria Lopez 是同一人/);
    assert.equal((await clickFill('[data-paste-use-client="Maria Lopez"]')).filled, true);
    assert.equal(await value('country'), spain);
    assert.equal(await value('currency'), 'EUR');
    assert.equal(await value('productType'), '假发');
    await closeOrderModal();

    // 8. 先逐键输入金额 500，AI 识别成 1280：确认框列出「金额：500 → 1280」，只补空字段时金额保留，已付 / 比例不按 1280 算。
    await openNew();
    await field('amount').click();
    await page.keyboard.type('500');
    assert.equal(await value('amount'), '500');
    await runAi('total 1280, 30% deposit 384 paid', { amount:1280, currency:'USD', orderType:'定金订单', paidAmount:384, depositAmount:384, depositPercent:30 });
    step = await clickFill('[data-paste-fill-extracted]', '#confirmAltBtn');
    assert.match(step.message, /金额：500 → 1280/);
    assert.equal(await value('amount'), '500');
    assert.notEqual(await value('paidAmount'), '384');
    assert.doesNotMatch(await page.locator('#orderForm').innerText(), /76\.8%/);
    await closeOrderModal();

    // 9. 等待 AI：只有等待卡片（没有「填入」「AI 识别」），用时在走；再点不会再发请求；取消后显示本地结果，晚到的回复不填。
    await openNew();
    const late = { amount:999, currency:'USD' };
    let arrived = holdNextAi(late);
    let requestsBefore = aiBodies.length;
    await page.locator('#pasteAssistInput').fill('total 450, paid via paypal');
    await aiBtn.click();
    await results.locator('[data-paste-ai-waiting]').waitFor();
    await arrived;
    await page.waitForFunction(() => Number(document.querySelector('#pasteAssistResults [data-paste-ai-clock]')?.textContent || 0) > 0);
    assert.equal(await results.locator('[data-paste-fill-extracted], [data-paste-run-ai]').count(), 0);
    assert.equal(await aiBtn.isDisabled(), true);
    assert.equal(await aiBtn.getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#pasteAssistAnalyzeBtn').isDisabled(), true);
    await page.evaluate(() => runAiPasteAnalysis());
    assert.equal(aiBodies.length, requestsBefore + 1, 'a second AI click while waiting sends no new request');
    await results.locator('[data-paste-ai-cancel]').click();
    await results.locator('[data-paste-source="local"]').waitFor();
    assert.match(await resultsText(), /已取消 AI 识别，下面是本地规则的结果/);
    assert.equal(await aiBtn.isEnabled(), true);
    assert.equal(await aiBtn.innerText(), 'AI 识别');
    release();
    await handled;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.doesNotMatch(await resultsText(), /AI 识别结果|999/, 'a late AI reply after cancel is ignored');

    // 改了粘贴内容 / 关掉弹窗：这次请求作废，按钮恢复，下一张单不会收到旧结果。
    arrived = holdNextAi(late);
    await aiBtn.click();
    await results.locator('[data-paste-ai-waiting]').waitFor();
    await arrived;
    await page.locator('#pasteAssistInput').fill('total 460');
    assert.equal(await results.locator('[data-paste-ai-waiting]').count(), 0);
    assert.equal(await aiBtn.isEnabled(), true);
    release();
    await handled;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.doesNotMatch(await resultsText(), /999/);
    arrived = holdNextAi(late);
    await aiBtn.click();
    await results.locator('[data-paste-ai-waiting]').waitFor();
    await arrived;
    await closeOrderModal();
    await openNew();
    assert.equal(await aiBtn.isEnabled(), true);
    assert.equal(await aiBtn.innerText(), 'AI 识别');
    release();
    await handled;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await resultsText(), '', 'a closed order modal discards the late AI reply');
    assert.equal(await value('amount'), '');

    // 10. 失败提示是中文、给下一步；原始英文报错只在悬停提示里。
    ai = { fields:{} };
    for (const [fail, title] of [
      [{ ok:false, message:'AI 请求失败：getaddrinfo ENOTFOUND api.example.invalid' }, '连不上 AI 服务'],
      [{ ok:false, status:402, message:'Insufficient Balance' }, 'AI 账户余额不足'],
      [{ ok:false, status:401, message:'Authentication Fails, Your api key is invalid' }, 'AI 密钥不对或没保存'],
      [{ ok:false, message:'AI 请求超时，请减少粘贴内容后重试，或稍后再试。' }, 'AI 识别超时'],
      [{ ok:false, status:503, message:'Service Unavailable' }, 'AI 服务暂时不可用']
    ]) {
      const text = await runAiFailure('total 450, paid via paypal', fail);
      assert.match(text, new RegExp(title), `failure title for ${fail.message}`);
      assert.doesNotMatch(text, /ENOTFOUND|getaddrinfo|Insufficient|Authentication|Unavailable/);
      assert.equal(await results.locator('[data-paste-show-local]').count(), 1);
      assert.equal(await aiBtn.isEnabled(), true);
    }
    await results.locator('[data-paste-show-local]').click();
    await results.locator('[data-paste-source="local"]').waitFor();
    assert.match(await resultsText(), /金额：450/);
    // AI 没打开：不发请求，提示去设置。
    requestsBefore = aiBodies.length;
    await page.evaluate(() => safeStorage.setItem(aiSettingsKey, JSON.stringify({ ...getAiSettings(), enabled:'否' })));
    await page.locator('#pasteAssistInput').fill('total 470');
    await aiBtn.click();
    await results.locator('.paste-error-card').waitFor();
    assert.match(await resultsText(), /AI 识别没有打开/);
    assert.equal(await results.locator('[data-ai-open-settings]').count(), 1);
    assert.equal(aiBodies.length, requestsBefore);
    await page.evaluate(() => safeStorage.setItem(aiSettingsKey, JSON.stringify({ ...getAiSettings(), enabled:'是' })));
    await closeOrderModal();

    // 发给 AI 的只有原文，不再夹带本地规则的猜测；也不再让 AI 给阶段。
    assert.ok(aiBodies.length >= 8);
    for (const body of aiBodies) {
      const prompt = body.messages.map(message => message.content).join('\n');
      assert.doesNotMatch(prompt, /本地规则已识别到/);
      assert.doesNotMatch(prompt, /"stage"/);
    }
    assert.deepEqual(dialogs, [], 'only in-page confirms, never window.alert / confirm');
    assert.deepEqual(errors, []);
    console.log('Order paste AI UI passed: currency kept, existing-order changes confirmed in Chinese, AI deposit on new-customer card, payment-based stage, profile country/currency, cancel + no duplicate request, Chinese failures, source label.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
