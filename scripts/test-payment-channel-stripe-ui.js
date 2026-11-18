#!/usr/bin/env node
// 收款方式「信用卡」改名叫「Stripe」：旧数据里存的「信用卡」（订单、回收站、客户资料、订单默认收款方式、设置里的收款方式列表）
// 读进来都显示成 Stripe，筛选、统计按 Stripe 算，下次保存写回去的也是 Stripe；订单一张不少、别的收款方式不受影响。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, day } = require('./helpers/board-page');

const orders = [
  { ...base, id:'card1', num:'S100', client:'Card Buyer', paymentChannel:'信用卡', stage:'production', amount:800, paidAmount:800, orderType:'全款订单', createdAt:day(2), updated:`${day(2)} 10:00` },
  { ...base, id:'card2', num:'S101', client:'Card Buyer', paymentChannel:'信用卡', stage:'balance', amount:500, paidAmount:200, orderType:'定金订单', createdAt:day(3), updated:`${day(3)} 10:00` },
  { ...base, id:'pp', num:'S102', client:'Paypal Buyer', paymentChannel:'Paypal', stage:'production', amount:300, paidAmount:300, orderType:'全款订单', createdAt:day(4), updated:`${day(4)} 10:00` }
];
const data = {
  orders,
  trashOrders:[{ ...base, id:'old', num:'S099', client:'Card Buyer', paymentChannel:'信用卡', stage:'quote', amount:100, trashedAt:`${day(1)} 09:00` }],
  customers:{
    'Card Buyer':{ id:'cust-card-0001', client:'Card Buyer', paymentMethod:'信用卡' },
    'Paypal Buyer':{ id:'cust-paypal-0002', client:'Paypal Buyer', paymentMethod:'Paypal' }
  },
  orderSettings:{ defaultPaymentChannel:'信用卡', productDefaultRevision:1 },
  paymentMethods:['T/T 银行转账', '信用卡', 'Stripe', 'PayPal']
};

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs } = await openBoard(browser, data);
    const loaded = await page.evaluate(() => ({
      orders:state.orders.map(o => [o.id, o.paymentChannel]),
      trash:state.trashOrders.map(o => o.paymentChannel),
      customers:Object.values(state.customers).map(c => [c.client, c.paymentMethod]),
      defaultChannel:state.orderSettings.defaultPaymentChannel,
      paymentMethods:state.paymentMethods,
      options:paymentChannelDefs.map(item => item.value)
    }));
    assert.deepEqual(loaded.orders, [['card1', 'Stripe'], ['card2', 'Stripe'], ['pp', 'Paypal']], '旧订单的信用卡读成 Stripe，别的不动，一张不少');
    assert.deepEqual(loaded.trash, ['Stripe'], '回收站里的也一样');
    assert.deepEqual(loaded.customers, [['Card Buyer', 'Stripe'], ['Paypal Buyer', 'Paypal']], '客户资料里的付款方式');
    assert.equal(loaded.defaultChannel, 'Stripe', '订单默认收款方式选的是信用卡的，还是这一项（不退回 Paypal）');
    assert.deepEqual(loaded.paymentMethods, ['T/T 银行转账', 'Stripe', 'PayPal'], '设置里的收款方式列表：改名、去重、顺序不变');
    assert.deepEqual(loaded.options, ['阿里巴巴', 'Paypal', '西联', 'Zelle', 'Stripe', 'TT'], '下拉里是 Stripe，没有信用卡');

    // 看板卡片上的收款标签
    const cardText = await page.locator('#pipeline .board-card[data-id="card1"]').innerText();
    assert.match(cardText, /Stripe/);
    assert.doesNotMatch(await page.locator('#pipeline').innerText(), /信用卡/);

    // 订单页：按 Stripe 筛选只剩那两张；统计「按收款方式」里是 Stripe
    await page.evaluate(() => setPage('order-list'));
    await page.waitForFunction(() => document.querySelectorAll('#orderListPaymentFilter option').length > 1);
    const filterOptions = await page.locator('#orderListPaymentFilter option').evaluateAll(list => list.map(o => o.value));
    assert(filterOptions.includes('Stripe') && !filterOptions.includes('信用卡'), `筛选项：${filterOptions}`);
    await page.locator('#orderListPaymentFilter').evaluate(sel => { sel.value = 'Stripe'; sel.dispatchEvent(new Event('change', { bubbles:true })); });
    await page.waitForFunction(() => document.querySelectorAll('#orderTableBody tr[data-order-list-id]').length === 2);
    const shown = await page.locator('#orderTableBody tr[data-order-list-id]').evaluateAll(rows => rows.map(r => r.dataset.orderListId).sort());
    assert.deepEqual(shown, ['card1', 'card2'], '按 Stripe 筛选');
    assert.match(await page.locator('#orderTableBody').innerText(), /Stripe/);

    // 新建订单弹窗：默认收款方式是 Stripe
    await page.click('#newOrderBtn');
    assert.equal(await page.locator('#orderForm [name="paymentChannel"]').inputValue(), 'Stripe');

    // 下一次随便改点别的保存：写回去的全是 Stripe（只读进来不保存，见 queueCurrentMacState）
    const before = store.saves;
    await page.evaluate(() => { state.orders.find(o => o.id === 'pp').note = 'made-up note'; saveState(); return window.flushPendingSave(); });
    await page.waitForFunction(() => !window.pendingSaveStatus().saving && !window.pendingSaveStatus().pending);
    assert(store.saves > before, '保存过');
    const saved = store.current.data;
    assert.equal(JSON.stringify(saved).includes('信用卡'), false, '保存的数据里不再有「信用卡」');
    assert.deepEqual(saved.orders.map(o => [o.id, o.paymentChannel]), [['card1', 'Stripe'], ['card2', 'Stripe'], ['pp', 'Paypal']]);
    assert.deepEqual(saved.trashOrders.map(o => o.paymentChannel), ['Stripe']);
    assert.equal(saved.customers['Card Buyer'].paymentMethod, 'Stripe');
    assert.equal(saved.orderSettings.defaultPaymentChannel, 'Stripe');
    assert.deepEqual(saved.paymentMethods, ['T/T 银行转账', 'Stripe', 'PayPal']);

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('payment channel 信用卡 → Stripe: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
