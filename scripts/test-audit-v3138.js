#!/usr/bin/env node
// Regression tests for the V3.138 full audit:
// - a copied order no longer inherits the source order's settle / auto-deposit markers,
// - local paste rules read AUD / CAD / CNY amounts (A$1,500 AUD, CAD$ 980, 1899 AUD, 12800元) and keep amount and currency in step,
// - converted USD totals show at most two decimals (customer list, drawer customer stats),
// - ECB rates are retried after a failed load and the dashboard says how many orders are not converted,
// - day counts stay right across daylight-saving changes,
// - a card's date is never shown half cut ("11-1" for 11-10) next to a tag on a narrow board,
// - a new order's log is 「新建订单」 (not 「新建订单：新建订单」), undoing 「已处理」 removes its log after a state reload,
// - keyboard focus: the drawer tab ring is not clipped to a stray bar, the notification panel has no ring around it,
// - the renewal editor's reminder dropdown is not drawn as a box inside a box with two arrows.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { launchBrowser, openBoard, h, base, day, month, html } = require('./helpers/board-page');

function extractFunction(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `Missing production function: ${name}`);
  for (let index = html.indexOf('{', start); index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const candidate = html.slice(start, index + 1);
    try { new vm.Script(candidate); return candidate; } catch (_) {}
  }
  throw new Error(`Could not extract ${name}`);
}

function pasteAmountTests() {
  const context = vm.createContext({
    roundMoneyValue: value => Math.round(Number(value || 0) * 100) / 100,
    currencyDefs: [{ code:'USD' }, { code:'EUR' }, { code:'GBP' }, { code:'CNY' }, { code:'AUD' }, { code:'CAD' }]
  });
  ['pasteTotalLabelPattern', 'findAmountInText', 'findCurrencyInText', 'aiMoneyNumber'].forEach(name => vm.runInContext(extractFunction(name), context));
  const read = text => ({ amount:context.findAmountInText(text), currency:context.findCurrencyInText(text) });
  const cases = [
    // The app's own display format, and the common ways customers write these currencies.
    ['A$1,500 AUD', 1500, 'AUD'],
    ['C$2,480 CAD', 2480, 'CAD'],
    ['She paid AUD 1,899 for the 13x6 frontal wig 24inch', 1899, 'AUD'],
    ['total is 1899 AUD', 1899, 'AUD'],
    ['invoice total CAD$ 980', 980, 'CAD'],
    ['price is 45 each, CA$900 in total', 900, 'CAD'],
    ['2 x AU$ 350', 350, 'AUD'],
    ['定金 30%，总金额 1000 澳元', 1000, 'AUD'],
    ['12800元', 12800, 'CNY'],
    ['12,800 RMB', 12800, 'CNY'],
    ['合计：￥12,800', 12800, 'CNY'],
    // Two currencies in one message: the amount follows the currency that was recognised.
    ['A$1,500 (about $980 USD)', 1500, 'AUD'],
    // "Order amount" is a total label even without a currency.
    ['Deposit 30% received 300 usd, order amount 1000, balance before shipping', 1000, 'USD'],
    // Unchanged behaviour.
    ['total USD 1,280', 1280, 'USD'],
    ['EUR 560 paid', 560, 'EUR'],
    ['GBP 1,250.00 total', 1250, 'GBP'],
    ['3500 美元', 3500, 'USD'],
    ['Audrey wants 20 pcs, 300 usd', 300, 'USD'],
    ['Grand total $1,499.99 (incl. shipping $60)', 1499.99, 'USD']
  ];
  for (const [text, amount, currency] of cases) {
    assert.deepEqual(read(text), { amount, currency }, `paste amount / currency for ${JSON.stringify(text)}`);
  }
  // A shipping line is still not the order amount, and a number without a currency or a total label is not an amount.
  assert.equal(context.findAmountInText('shipping A$45'), '');
  assert.equal(context.findAmountInText('I am from Canada, budget 500'), '');
  assert.equal(context.findCurrencyInText('3500 美元'), 'USD', '美元 is not read as 元');
}

// One row per day, newest first, the way /api/ecb-rates returns them.
const rates = [{ date:`${month}-01`, rates:{ EUR:1, USD:1.0837, GBP:0.8431, AUD:1.6519, CAD:1.4963, CNY:7.7112 } }];

async function copyTests(browser) {
  const orders = [
    // Really received 300; 已完成 counts the rest as collected and remembers the 300.
    { ...base, id:'o-src', num:'SRC-1', client:'Copy Source', amount:1000, paidAmount:1000, paidBeforeSettle:300, paidBeforeDeposit:0, depositAutoPaid:300,
      autoDoneHold:true, partialShipment:true, orderType:'定金订单', depositAmount:300, depositPercent:30, stage:'done', updated:`${day(1)} 09:00`,
      shipments:[{ id:'sh1', trackingNumber:'1234567890', carrier:'DHL', status:'已签收', shippedAt:day(1), updated:`${day(1)} 09:00` }] }
  ];
  const { page, context, errors, dialogs } = await openBoard(browser, { orders }, { port:47981 });
  try {
    const copy = await page.evaluate(() => {
      openOrder('o-src');
      duplicateOrder();
      closeOrder();
      const c = state.orders.find(o => o.id !== 'o-src');
      return JSON.parse(JSON.stringify(c));
    });
    for (const key of ['paidBeforeSettle', 'paidBeforeDeposit', 'depositAutoPaid', 'autoDoneHold', 'deletedAt', 'trashedAt']) {
      assert.equal(Object.hasOwn(copy, key), false, `the copy must not inherit ${key}`);
    }
    assert.equal(copy.partialShipment === true, false, 'the copy is not a partial shipment');
    assert.equal(copy.stage, 'quote');
    assert.equal(copy.paidAmount, 0);
    // Record 600 on the copy, ship it, move it back: the 600 must come back (the source's 300 used to).
    const paidAfterRoundTrip = await page.evaluate(id => {
      const c = state.orders.find(o => o.id === id);
      c.paidAmount = 600;
      c.stage = 'production';
      moveOrderToStage(id, 'shipment');
      const settled = state.orders.find(o => o.id === id).paidAmount;
      moveOrderToStage(id, 'production');
      return { settled, back:state.orders.find(o => o.id === id).paidAmount };
    }, copy.id);
    assert.deepEqual(paidAfterRoundTrip, { settled:1000, back:600 }, 'moving the copy out of 已发货 restores what was really received on the copy');
    // A deposit typed by hand on the copy is not "an automatically recorded deposit" of the source order.
    const paidInQuote = await page.evaluate(id => {
      const c = state.orders.find(o => o.id === id);
      c.paidAmount = 300;
      c.stage = 'balance';
      moveOrderToStage(id, 'quote');
      return state.orders.find(o => o.id === id).paidAmount;
    }, copy.id);
    assert.equal(paidInQuote, 300, 'a manually recorded 300 stays when the copy goes back to 报价');
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
  } finally { await context.close(); }
}

async function moneyAndRateTests(browser) {
  const orders = [
    { ...base, id:'o-gbp', num:'GBP-1', client:'Pound Buyer', country:'🇬🇧 英国 United Kingdom', currency:'GBP', amount:350.5, paidAmount:100, orderType:'全款订单', stage:'production', createdAt:day(2), updated:`${day(2)} 09:00` },
    { ...base, id:'o-usd', num:'USD-1', client:'Dollar Buyer', amount:200, paidAmount:200, orderType:'全款订单', stage:'production', createdAt:day(2), updated:`${day(2)} 09:00` }
  ];
  const customers = { 'Pound Buyer':{ country:'🇬🇧 英国 United Kingdom' }, 'Dollar Buyer':{} };
  // 1. With rates: converted totals carry at most two decimals.
  {
    const { page, context, errors } = await openBoard(browser, { orders, customers }, { ecbRates:rates, port:47982 });
    try {
      await page.waitForFunction(() => ecbHistoricalRates.length > 0);
      await page.evaluate(() => setPage('customers'));
      const cells = await page.locator('#customerList .customer-cell-money').allInnerTexts();
      const amounts = cells.join(' ').match(/[\d,]+\.\d+/g) || [];
      assert.ok(amounts.length >= 2, `expected converted amounts in the customer list, got ${JSON.stringify(cells)}`);
      amounts.forEach(text => assert.ok(text.split('.')[1].length <= 2, `customer list amount ${text} must have at most 2 decimals`));
      await page.evaluate(() => { setPage('dashboard'); openOrderDetail('o-gbp'); });
      await page.waitForSelector('#orderDetailDrawer.open');
      const stats = await page.locator('#orderDetailBody').innerText();
      (stats.match(/\$[\d,]+\.\d+ USD/g) || []).forEach(text => assert.ok(text.match(/\.(\d+)/)[1].length <= 2, `drawer amount ${text} must have at most 2 decimals`));
      assert.equal(await page.locator('#statAmountSub').innerText().then(text => text.includes('缺汇率')), false, 'no missing-rate note when every order converts');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  // 2. The first /api/ecb-rates call fails: a retry is scheduled, the dashboard says one order is not converted,
  //    and the retry brings the rates in.
  {
    const context = await browser.newContext({ viewport:{ width:1440, height:920 } });
    await context.addInitScript(() => {
      try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {}
      // Record long timers instead of waiting for them; everything else runs as usual.
      window.__longTimers = [];
      const realSetTimeout = window.setTimeout;
      window.setTimeout = (fn, ms, ...args) => {
        if (Number(ms) >= 15000 && typeof fn === 'function' && fn.name === 'loadEcbHistoricalRates') { window.__longTimers.push({ fn, ms }); return 0; }
        return realSetTimeout(fn, ms, ...args);
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let stored = { app:'trade-order-system', data:{ orders, customers, doneTasks:{}, demoCleared:true, demoCustomersCleared:true }, revision:0 };
    let rateCalls = 0;
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/ecb-rates') {
        rateCalls += 1;
        return rateCalls === 1 ? route.fulfill({ status:500, json:{ ok:false, message:'ECB unreachable' } }) : route.fulfill({ json:{ ok:true, rates, updatedAt:new Date().toISOString() } });
      }
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:2 }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/save') {
        stored = { ...route.request().postDataJSON().state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    try {
      await page.goto('http://127.0.0.1:47983/trade-order-system.html');
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
      await page.waitForFunction(() => window.__longTimers.length === 1);
      const first = await page.evaluate(() => ({ ms:window.__longTimers[0].ms, loaded:ecbHistoricalRates.length, sub:document.getElementById('statAmountSub').textContent }));
      assert.equal(first.loaded, 0);
      assert.equal(first.ms, 15000, 'the first retry comes 15 seconds after a failed load');
      assert.match(first.sub, /2 单 · 草稿不计 · 1 单缺汇率未计入/, 'the dashboard says one order is not converted');
      assert.deepEqual(await page.evaluate(() => [1, 2, 3, 8, 20].map(ecbRatesRetryDelay)), [15000, 30000, 60000, 1800000, 1800000], 'retries back off and stop growing at 30 minutes');
      await page.evaluate(() => window.__longTimers.shift().fn());
      await page.waitForFunction(() => ecbHistoricalRates.length > 0);
      assert.equal(rateCalls, 2);
      const after = await page.evaluate(() => ({ sub:document.getElementById('statAmountSub').textContent, next:window.__longTimers.map(item => item.ms) }));
      assert.equal(after.sub.includes('缺汇率'), false, 'the note goes away once the rates are in');
      assert.deepEqual(after.next, [12 * 60 * 60000], 'fresh rates are refreshed again after 12 hours');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
}

async function dstTests(browser) {
  // America/Los_Angeles: clocks go forward on 2026-03-08 and back on 2026-11-01.
  const context = await browser.newContext({ viewport:{ width:1200, height:800 }, timezoneId:'America/Los_Angeles' });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', data:{ orders:[], customers:{}, demoCleared:true, demoCustomersCleared:true }, revision:0 } });
    return route.fulfill({ json:{ ok:true, rates:[] } });
  });
  try {
    await page.goto('http://127.0.0.1:47984/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const result = await page.evaluate(() => {
      const RealDate = Date;
      const at = iso => { const fixed = new RealDate(iso).getTime(); return class extends RealDate { constructor(...args) { if (args.length) super(...args); else super(fixed); } static now() { return fixed; } }; };
      const out = { across:daysBetween('2026-03-01', new RealDate(2026, 2, 31)), same:daysBetween('2026-03-08', new RealDate(2026, 2, 9)), back:daysBetween('2026-10-25', new RealDate(2026, 10, 8)) };
      // daysUntil reads "today" from the clock: stand on 2026-10-25 (before the clocks go back) and on 2026-03-01.
      globalThis.Date = at('2026-10-25T19:00:00Z');
      out.untilAfterFallBack = daysUntil('2026-11-08');
      globalThis.Date = at('2026-03-01T20:00:00Z');
      out.untilAfterSpring = daysUntil('2026-03-31');
      globalThis.Date = RealDate;
      return out;
    });
    assert.deepEqual(result, { across:30, same:1, back:14, untilAfterFallBack:14, untilAfterSpring:30 }, 'day counts across daylight-saving changes');
  } finally { await context.close(); }
}

async function boardAndLogTests(browser) {
  const orders = [
    { ...base, id:'o-urgent', num:'K26111001', client:'Urgent Buyer', amount:120, paidAmount:0, orderType:'定金订单', depositAmount:36, stage:'quote', urgentOrder:true, createdAt:day(10), updated:`${day(10)} 09:00` },
    { ...base, id:'o-shipped', num:'K26110950', client:'Shipped Buyer', amount:350, paidAmount:350, orderType:'全款订单', stage:'shipment', urgentOrder:true, createdAt:day(9), updated:`${day(9)} 09:00`, logisticsStatus:'已发货', shippedAt:day(9),
      shipments:[{ id:'sh1', trackingNumber:'1Z999AA10123456784', carrier:'UPS', status:'已发货', shippedAt:day(9), updated:`${day(9)} 09:00` }, { id:'sh2', trackingNumber:'1Z999AA10123456785', carrier:'UPS', status:'未发货', shippedAt:'', updated:'' }], partialShipment:true },
    { ...base, id:'o-plain', num:'K26110851', client:'Plain Buyer', amount:899, paidAmount:899, orderType:'全款订单', stage:'production', createdAt:day(8), updated:`${day(8)} 09:00` },
    { ...base, id:'o-long', num:'K26110799999999999999999', client:'Long Number', amount:10, paidAmount:10, orderType:'全款订单', stage:'production', urgentOrder:true, createdAt:day(7), updated:`${day(7)} 09:00` },
    { ...base, id:'o-task', num:'TASK-1', client:'Task Buyer', amount:500, paidAmount:500, orderType:'全款订单', stage:'production', urgentOrder:true, latestShipDate:day(1), customerRequiredDate:day(1), createdAt:day(1), updated:`${day(1)} 09:00` },
    // A trashed order keeps the old 垃圾箱 column on the board, which makes the stage columns narrower.
  ];
  const trashOrders = [{ ...base, id:'t1', num:'KT1', client:'Trash', amount:1, stage:'quote', trashedAt:`${day(1)} 09:00`, updated:`${day(1)} 09:00` }];
  for (const width of [1694, 1440, 1294]) {
    const { page, context, errors } = await openBoard(browser, { orders, trashOrders }, { width, port:47985 });
    try {
      const rows = await page.evaluate(() => [...document.querySelectorAll('#pipeline .board-card .oc-r1')].map(row => {
        const card = row.closest('.board-card');
        const date = row.querySelector('.oc-date');
        const num = row.querySelector('.oc-num');
        const rowBox = row.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        const dateBox = date.getBoundingClientRect();
        const numBox = num.getBoundingClientRect();
        const onFirstLine = dateBox.top < rowBox.bottom - 4;
        return { id:card.dataset.id, height:rowBox.height, dateState:!onFirstLine ? 'hidden' : dateBox.right <= cardBox.right - 4 && dateBox.left >= numBox.right - 0.5 ? 'whole' : 'cut', numInside:numBox.right <= cardBox.right - 4 && numBox.width > 20 };
      }));
      assert.ok(rows.length >= 5);
      rows.forEach(row => {
        assert.notEqual(row.dateState, 'cut', `width ${width}: the date on ${row.id} is shown whole or not at all`);
        assert.ok(row.height <= 21, `width ${width}: the first row of ${row.id} stays one line high`);
        assert.ok(row.numInside, `width ${width}: the order number of ${row.id} stays inside the card`);
      });
      assert.equal(rows.find(row => row.id === 'o-plain').dateState, 'whole', `width ${width}: a card without a tag keeps its date`);
      if (width === 1694) assert.equal(rows.find(row => row.id === 'o-urgent').dateState, 'whole', 'at the Mac app default zoom an urgent card still shows its date');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  const { page, context, errors, dialogs } = await openBoard(browser, { orders, customers:{ 'Plain Buyer':{} } }, { port:47986 });
  try {
    // New order through the real form: the log reads 「新建订单」.
    await page.evaluate(() => openOrder(''));
    await page.waitForSelector('#orderModal.open');
    await page.fill('#orderForm input[name="client"]', 'Plain Buyer');
    await page.keyboard.press('Escape');
    await page.fill('#orderForm input[name="amount"]', '250');
    // Only start the save: handing upsertOrder's promise back to Playwright now and then ends in
    // "Resulting promise was garbage collected". The next lines wait until the order is really in the state and saved.
    await page.evaluate(() => { upsertOrder(document.getElementById('orderForm')); });
    await page.waitForFunction(() => state.orders.some(o => o.client === 'Plain Buyer' && Number(o.amount) === 250) && !document.getElementById('orderModal').classList.contains('open'));
    const firstLog = await page.evaluate(() => state.orders.find(o => o.client === 'Plain Buyer' && Number(o.amount) === 250).logs.at(-1).text);
    assert.equal(firstLog, '新建订单', 'a new order is logged once, without repeating itself');

    // 「已处理」 then a state reload (new log objects), then undo: the 「待办已处理」 log is removed again.
    await h.clearToasts(page);
    const taskId = await page.evaluate(() => buildTaskItems().find(item => item.orderId === 'o-task')?.id);
    assert.ok(taskId, 'the overdue order has a task');
    await page.evaluate(id => markTaskDone(id), taskId);
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o-task').logs.filter(item => item.text.startsWith('待办已处理')).length), 1);
    await page.evaluate(() => { state.orders = JSON.parse(JSON.stringify(state.orders)); });
    await h.clickUndo(page, 'Task Buyer');
    await page.waitForFunction(() => !state.orders.find(o => o.id === 'o-task').logs.some(item => item.text.startsWith('待办已处理')));

    // Keyboard focus on the drawer tabs: the ring is drawn inside the tab (the strip clips anything outside it).
    await page.evaluate(() => { document.querySelectorAll('#toast .toast-item').forEach(el => el.remove()); openOrderDetail('o-plain'); });
    await page.waitForSelector('#orderDetailDrawer.open');
    await page.locator('#detailTabs [data-detail-tab-btn="info"]').focus();
    await page.keyboard.press('ArrowRight');
    const ring = await page.evaluate(() => {
      const tab = document.activeElement;
      const style = getComputedStyle(tab);
      return { isTab:tab.matches('#detailTabs [data-detail-tab-btn]'), visible:tab.matches(':focus-visible'), width:parseFloat(style.outlineWidth), offset:parseFloat(style.outlineOffset), style:style.outlineStyle };
    });
    assert.equal(ring.isTab && ring.visible, true, 'arrow keys move keyboard focus along the drawer tabs');
    assert.equal(ring.style, 'solid');
    assert.ok(ring.offset + ring.width <= 0, `the tab focus ring stays inside the tab (offset ${ring.offset}, width ${ring.width})`);
    await page.evaluate(() => closeOrderDetail?.());

    // Opening the notification panel from the keyboard does not draw a ring around the whole panel.
    await page.evaluate(() => { document.querySelectorAll('.modal-backdrop.open').forEach(el => el.classList.remove('open')); });
    const bell = page.locator('#notifBtn');
    await bell.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('notifPanel')?.hidden === false);
    await page.evaluate(() => document.getElementById('notifPanel').focus());
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('notifPanel')).outlineStyle), 'none', 'the notification panel itself has no focus ring');

    // 续费编辑框的「提前提醒」下拉：一层边框、一个箭头（外层和里面的按钮以前各画一遍）。
    await page.evaluate(() => { uiToggleNotifs(false); setPage('subscriptions'); openSubscriptionEditor(); });
    await page.waitForSelector('#subscriptionEditModal.open');
    const remind = await page.evaluate(() => {
      const wrap = document.getElementById('subscriptionRemind').closest('.app-select');
      if (!wrap) return null;
      const w = getComputedStyle(wrap);
      const b = getComputedStyle(wrap.querySelector('.app-select-button'));
      return { wrapBorder:parseFloat(w.borderTopWidth), buttonBorder:parseFloat(b.borderTopWidth), wrapArrow:w.backgroundImage, wrapPadding:w.paddingLeft, chevrons:wrap.querySelectorAll('.app-select-chevron').length };
    });
    assert.deepEqual(remind, { wrapBorder:1, buttonBorder:0, wrapArrow:'none', wrapPadding:'0px', chevrons:1 }, 'the reminder dropdown is drawn once');
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
  } finally { await context.close(); }
}

(async () => {
  pasteAmountTests();
  const browser = await launchBrowser();
  try {
    await copyTests(browser);
    await moneyAndRateTests(browser);
    await dstTests(browser);
    await boardAndLogTests(browser);
  } finally { await browser.close(); }
  console.log('V3.138 audit tests passed: clean order copies, AUD / CAD / CNY paste amounts, two-decimal converted totals, ECB retry + missing-rate note, DST-safe day counts, whole-or-hidden card dates, single 新建订单 log, task undo after reload, focus rings, single-box reminder dropdown.');
})().catch(error => { console.error(error); process.exit(1); });
