#!/usr/bin/env node
// 页面整理第五轮（made-up data, network stubbed）：
// 1. 订单抽屉「收款」页：没有「已收 N% · 收款方式 · 订单类型」那行，输入框叫「已收」，说明一行；
// 2. 抽屉「订单信息」页：产品类型、订单类型是分段按钮，点了算改动、保存进订单；同一张单就地重画后分段停在没保存的值上；
//    「收款」页的收款方式和币种还是下拉；
// 3. 日历当天抽屉「当天记录」：先写事再写客户，第二行不再写客户名；过了最晚发出日期的那条不再把「最晚发出」和日期写三遍；
// 4. 订单设置没有「默认订单类型 · 固定为全款订单」那格；AI 费用记录只有一页时不出翻页。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const offset = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const order = (id, fields) => ({ ...base, id, orderType:'定金订单', paidAmount:0, stage:'quote', createdAt:offset(-10), orderMonth:offset(-10).slice(0, 7), updated:`${offset(-10)} 10:00`, ...fields });
const orders = [
  order('o1', { num:'R7-0001', client:'Aurora Hair Studio', amount:3100, depositAmount:930, depositPercent:30, paidAmount:930, stage:'balance', latestShipDate:offset(-3) }),
  order('o2', { num:'R7-0002', client:'Bella Lash Co', amount:4200, orderType:'全款订单', paidAmount:4200, stage:'shipment', productType:'睫毛', logisticsStatus:'运输中',
    trackingNumber:'1234567890', carrier:'DHL', shippedAt:offset(-5),
    shipments:[{ id:'s1', trackingNumber:'1234567890', carrier:'DHL', status:'运输中', logisticsStatus:'运输中', shippedAt:offset(-5), updated:`${offset(-3)} 16:20` }] })
];
const customers = {
  'Aurora Hair Studio': { client:'Aurora Hair Studio', contact:'Mia Carter', email:'hello0@customer0.example' },
  'Bella Lash Co': { client:'Bella Lash Co', contact:'Lily Stone', email:'hello1@customer1.example' }
};

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs } = await openBoard(browser, { orders, customers }, { port:freePortSync() });
    const drawerOpen = () => page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));

    // ---- 1. payment tab ----
    await page.evaluate(() => openOrderDetail('o1', { tab:'payment' }));
    await drawerOpen();
    const pay = await page.evaluate(() => {
      const panel = document.querySelector('#orderDetailBody [data-detail-tab="payment"]');
      const label = name => panel.querySelector(`[data-dedit="${name}"]`)?.closest('.field')?.querySelector('label')?.textContent;
      return { meta:!!panel.querySelector('[data-detail-pay-meta]'), paid:label('paidAmount'), amount:label('amount'), hint:panel.querySelector('.detail-edit-hint')?.textContent,
        text:panel.textContent.replace(/\s+/g, ' '), channelNative:panel.querySelector('[data-dedit="paymentChannel"]').classList.contains('binary-native'),
        currencyNative:panel.querySelector('[data-dedit="currency"]').classList.contains('binary-native') };
    });
    assert.equal(pay.meta, false, 'the 已收 N% · 收款方式 · 订单类型 line is gone');
    assert.ok(!/收款方式 Paypal · 定金订单/.test(pay.text), pay.text);
    assert.deepEqual([pay.amount, pay.paid], ['订单金额', '已收'], 'the input is called 已收 like the big number above it');
    assert.equal(pay.hint, '收到钱就把「已收」改成累计收到的总数，付款截图在「附件」页加。');
    assert.ok(/定金：\$930 USD（30%） · 已收/.test(pay.text), `the deposit line stays: ${pay.text}`);
    assert.deepEqual([pay.channelNative, pay.currencyNative], [false, false], 'payment channel and currency stay dropdowns');
    // The summary still follows the inputs before saving.
    await page.fill('#orderDetailBody [data-dedit="paidAmount"]', '3100');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.order-detail-payment-head strong')[2].textContent), '已收全款');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await page.locator('#confirmOkBtn').click();
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));

    // ---- 2. info tab segments ----
    await page.evaluate(() => openOrderDetail('o1', { tab:'info' }));
    await drawerOpen();
    const seg = name => page.evaluate(name => {
      const select = document.querySelector(`#orderDetailBody [data-dedit="${name}"]`);
      const wrap = select.nextElementSibling;
      return { native:select.classList.contains('binary-native'), value:select.value,
        options:[...wrap.querySelectorAll('.binary-option')].map(b => `${b.textContent.trim()}${b.classList.contains('active') ? '*' : ''}`) };
    }, name);
    assert.deepEqual(await seg('productType'), { native:true, value:'假发', options:['假发*', '睫毛'] });
    assert.deepEqual(await seg('orderType'), { native:true, value:'定金订单', options:['全款订单', '定金订单*'] });
    await page.locator('#orderDetailBody [data-dedit="productType"] + .binary-segment [data-binary-value="睫毛"]').click();
    assert.equal((await seg('productType')).value, '睫毛');
    assert.equal(await page.evaluate(() => uiDetailUnsaved()), true, 'a segment click counts as an unsaved change');
    // Same order redrawn in place (e.g. a stage move elsewhere): the unsaved choice comes back on the segment too.
    await page.evaluate(() => openOrderDetail('o1'));
    assert.deepEqual(await seg('productType'), { native:true, value:'睫毛', options:['假发', '睫毛*'] });
    await page.locator('#detailSaveBtn').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'o1').productType === '睫毛' && !uiDetailUnsaved());
    await page.waitForFunction(() => window.pendingSaveStatus?.().pending === 0 || !window.pendingSaveStatus?.().pending);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));

    // ---- 3. calendar day drawer ----
    await page.evaluate(() => setPage('calendar'));
    await page.evaluate(date => openCalendarTaskDrawer(date), offset(-3));
    await page.waitForFunction(() => document.getElementById('calendarTaskDrawer').classList.contains('open'));
    const records = await page.evaluate(() => [...document.querySelectorAll('#calendarTaskBody .calendar-record')].map(row => ({
      what:row.querySelector('.calendar-record-title b')?.textContent || '',
      title:row.querySelector('.calendar-record-title').textContent.trim(),
      sub:row.querySelector('.task-sub').textContent.trim()
    })));
    const ship = records.find(r => r.what === 'DHL 运输中');
    assert.ok(ship, JSON.stringify(records));
    assert.equal(ship.title, 'DHL 运输中 Bella Lash Co', 'what first, then the customer');
    assert.equal(ship.sub, 'DHL 1234567890 · R7-0002', 'the second line does not repeat the customer');
    const late = records.find(r => /最晚发出$/.test(r.what));
    assert.ok(late, JSON.stringify(records));
    assert.equal(late.title, `${late.what} Aurora Hair Studio`);
    assert.equal(late.sub, '过了这天还没发货 · R7-0001', 'no third 最晚发出 and no repeat of the day');
    await page.keyboard.press('Escape');

    // ---- 4. settings ----
    await page.evaluate(() => setPage('settings'));
    await page.evaluate(() => document.querySelector('.settings-menu [data-settings-tab="order"]')?.click());
    const orderSettings = await page.evaluate(() => {
      const panel = document.querySelector('[data-settings-panel="order"]');
      return { note:!!panel.querySelector('.settings-fixed-note'), text:panel.textContent.includes('默认订单类型'), hidden:panel.querySelector('[name="defaultOrderType"]')?.value };
    });
    assert.deepEqual(orderSettings, { note:false, text:false, hidden:'全款订单' }, 'the fixed order-type cell is gone, the value is still sent');
    const pager = pages => page.evaluate(pages => {
      aiUsageSnapshot = { ok:true, page:1, pages, totalCostUsd:0, monthCostUsd:0, totalCalls:0, unknownCostCalls:0, records:[], models:[] };
      renderAiUsage();
      const el = document.querySelector('.ai-usage-pagination');
      return { hidden:el.hidden, shown:getComputedStyle(el).display !== 'none' };
    }, pages);
    assert.deepEqual(await pager(1), { hidden:true, shown:false }, 'one page: no pager');
    assert.deepEqual(await pager(3), { hidden:false, shown:true }, 'more pages: pager as before');

    assert.equal(store.current.data.orders.find(o => o.id === 'o1').productType, '睫毛', 'saved to the server');
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('Pages round 7 UI passed: drawer payment tab without the repeated line, 已收 label and one-line hint; info tab segments save and survive an in-place redraw; calendar day records what-first without repeated customer or day; order settings without the fixed cell; AI usage pager only with more than one page.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
