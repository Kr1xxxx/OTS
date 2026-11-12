#!/usr/bin/env node
// 设置页、空数据、最小窗口三种平时少看到的状态（真实页面）：
// - 汇率表和等级门槛里的输入框和别的表单栏位一个样，不是系统默认的方框；
// - 设置里内容很短的页签不会多出一截可以滚动的空白；接口状态三项一项挨一项；
// - 一张订单都没有时，订单表格卡片有底边和圆角，表头下边线每一列一样粗，工作台「最近订单」有一句话；
// - 搜一个字母时不说「没有找到」（一个字母本来就不参与匹配）；
// - 窗口缩到最小时，订单筛选栏和客户工具栏各占一行，客户表不用横向滚动，工具栏后面没有白底方块。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const customers = {};
const orders = [];
['Narrow Buyer One', 'Narrow Buyer Two', 'Narrow Buyer Three'].forEach((client, index) => {
  customers[client] = { client, country:'🇺🇸 美国 United States', currency:'USD', contact:`Contact ${index + 1}`, email:`buyer${index + 1}@example.com`, tags:['复购客户'] };
  orders.push({ ...base, id:`n${index + 1}`, num:`K900${index + 1}`, client, stage:index ? 'production' : 'quote', orderType:'定金订单', amount:34300 + index * 1000, depositAmount:10000, paidAmount:index ? 10000 : 0, createdAt:day(2 + index), updated:`${day(2 + index)} 10:00` });
});

(async () => {
  const browser = await launchBrowser();
  try {
    // ---- 没有数据 ----
    const empty = await openBoard(browser, { orders:[] }, { port:47962 });
    let page = empty.page;
    assert.match(await page.locator('#recentOrderList').innerText(), /还没有订单/, 'the recent orders panel says there are none instead of staying blank');

    await page.evaluate(() => setPage('order-list'));
    await page.waitForSelector('#page-order-list .order-table-empty');
    const emptyTable = await page.evaluate(() => {
      const scroll = document.querySelector('#page-order-list .order-table-scroll');
      const style = getComputedStyle(scroll);
      const box = scroll.getBoundingClientRect();
      const cell = document.querySelector('#page-order-list .order-table-empty').getBoundingClientRect();
      return { border:style.borderBottomWidth, radius:parseFloat(style.borderBottomLeftRadius), blank:Math.round(box.bottom - cell.bottom),
        pagination:document.getElementById('orderListPagination').getClientRects().length,
        cellBorder:getComputedStyle(document.querySelector('#page-order-list .order-table-empty')).borderBottomWidth,
        heads:[...new Set([...document.querySelectorAll('#page-order-list .order-table thead th')].map(th => { const s = getComputedStyle(th); return `${s.borderBottomWidth} ${s.boxShadow}`; }))] };
    });
    assert.equal(emptyTable.pagination, 0, 'no pagination bar without orders');
    assert.equal(emptyTable.border, '1px', 'the empty table card has a bottom edge');
    assert.ok(emptyTable.radius >= 12, `the empty table card has rounded bottom corners (${emptyTable.radius}px)`);
    assert.ok(emptyTable.blank <= 2, `the card ends under the empty message, no blank block below it (${emptyTable.blank}px)`);
    assert.equal(emptyTable.cellBorder, '0px', 'no line under the empty message');
    assert.deepEqual(emptyTable.heads, ['1px none'], 'every header cell has the same single bottom line');

    // 搜索：一个字母不说「没有找到」。
    const search = page.locator('#searchInput');
    await h.click(page, search, 'search');
    await page.keyboard.type('a');
    await page.waitForFunction(() => document.querySelector('#globalSearchPanel .global-search-empty'));
    assert.match(await page.locator('#globalSearchPanel .global-search-empty').innerText(), /再输入一个字符/);
    await page.keyboard.type('zz');
    await page.waitForFunction(() => /没有找到相关内容/.test(document.querySelector('#globalSearchPanel .global-search-empty')?.textContent || ''));
    await page.keyboard.press('Escape');

    // ---- 设置 ----
    await page.evaluate(() => setPage('settings'));
    const tab = async name => { await h.click(page, `.settings-menu-item[data-settings-tab="${name}"]`, `settings tab ${name}`); await page.waitForSelector(`.settings-panel.active[data-settings-panel="${name}"]`); };
    const fieldLook = selector => page.evaluate(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return { border:`${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`, radius:style.borderTopLeftRadius, background:style.backgroundColor };
    }, selector);
    await tab('order');
    const reference = await fieldLook('.settings-panel.active .field input[name]');
    await tab('exchange');
    await page.waitForSelector('.manual-rate-item input');
    assert.deepEqual(await fieldLook('.manual-rate-item input'), reference, 'an exchange-rate input looks like any other field');
    await tab('customer');
    await page.waitForSelector('.level-rule-input input');
    assert.deepEqual(await fieldLook('.level-rule-input input'), reference, 'a level threshold input looks like any other field');
    const ruleButtons = await page.evaluate(() => [...document.querySelectorAll('.level-rule-foot .btn, #ownEmailsForm .btn')].map(button => getComputedStyle(button).fontSize));
    assert.equal(new Set(ruleButtons).size, 1, `the buttons of the customer settings are one size (${ruleButtons.join(', ')})`);
    await tab('api');
    const api = await page.evaluate(() => {
      const root = document.documentElement;
      const dots = [...document.querySelectorAll('#apiStatusStrip .api-status-dot')].map(dot => {
        const name = dot.querySelector('.api-status-name').getBoundingClientRect();
        const stateBox = dot.querySelector('.api-status-state').getBoundingClientRect();
        return { top:Math.round(dot.getBoundingClientRect().top), gap:Math.round(stateBox.left - name.right) };
      });
      return { scroll:root.scrollHeight - root.clientHeight, dots };
    });
    assert.equal(api.scroll, 0, 'a short settings tab does not scroll');
    assert.equal(new Set(api.dots.map(dot => dot.top)).size, 1, 'the three API checks sit on one row');
    for (const dot of api.dots) assert.ok(dot.gap >= 0 && dot.gap <= 16, `a status sits right after its name (${dot.gap}px)`);
    assert.deepEqual(empty.errors, []);
    await empty.context.close();

    // ---- 最小窗口（1100×720 的窗口在 85% 缩放下是 1294×847）----
    const narrow = await openBoard(browser, { orders, customers }, { port:47963, width:1294, height:847 });
    page = narrow.page;
    const oneRow = selector => page.evaluate(selector => [...new Set([...document.querySelectorAll(selector)].filter(el => el.getClientRects().length).map(el => { const box = el.getBoundingClientRect(); return Math.round(box.top + box.height / 2); }))], selector);
    await page.evaluate(() => setPage('order-list'));
    await page.waitForSelector('#page-order-list .order-table tbody tr');
    assert.equal((await oneRow('#page-order-list .order-list-controls > *')).length, 1, 'the order filters stay on one row at the smallest window');
    await page.evaluate(() => setPage('customers'));
    await page.waitForSelector('#page-customers .customer-row:not(.head)');
    assert.equal((await oneRow('#page-customers .customer-toolbar > *')).length, 1, 'the customer toolbar stays on one row at the smallest window');
    const table = await page.evaluate(() => {
      const el = document.querySelector('#page-customers .customer-table');
      return { overflow:el.scrollWidth - el.clientWidth, toolbar:getComputedStyle(document.querySelector('#page-customers .customer-toolbar')).backgroundColor };
    });
    assert.ok(table.overflow <= 1, `the customer table needs no horizontal scrolling (${table.overflow}px)`);
    assert.match(table.toolbar, /^(rgba\(0, 0, 0, 0\)|transparent)$/, 'no white block behind the customer toolbar');
    assert.deepEqual(narrow.errors, []);
    assert.deepEqual([...empty.dialogs, ...narrow.dialogs], [], 'no native alert / confirm / prompt');
    console.log('Settings / empty / narrow UI passed: styled rate and threshold inputs, no phantom scroll, API checks in a row, closed empty order table, one-letter search hint, one-row toolbars and no sideways scroll at the smallest window.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
