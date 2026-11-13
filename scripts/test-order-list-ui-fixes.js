#!/usr/bin/env node
// 订单列表页（V3.123）：
// - 搜索框能搜 2 个中文字、英文前 2–3 个字母；输入法组字期间不重算列表；
// - 金额排序按美元换算；排序、搜索词、快捷标签出现在「已选条件」里，点 × 能去掉；
// - 合计 / 待收不含草稿，草稿行没有「收齐 / 推进」；
// - 双击「收齐」只改这一张单，这一行留在原位，鼠标离开后才重排；
// - 唯一那张单没了，国家筛选不悄悄变回「全部」；工作台「全部订单 →」清掉上次的筛选；没有订单时显示「还没有订单」。
// 全程用真实键盘和鼠标；等条件，不用固定 sleep。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base } = require('./helpers/board-page');
const { inputMethod } = require('./helpers/input-method');

const rates = [{ date:'2020-01-01', rates:{ USD:1.1, CNY:7.9, GBP:0.86, EUR:1 } }];
const order = (id, fields) => ({ ...base, id, orderType:'定金订单', paidAmount:0, stage:'quote', ...fields });
// 更新时间写一个一定在过去的日子：以前写的是「本月 1 日 08:00–13:00」，每月 1 日 13:00 前跑时这些时间还在未来，
// 「收齐」之后那张单的更新时间（现在）反而排不到最前面。
const orders = [
  order('o-nor', { num:'K261001001', client:'Nordic Hair', country:'🇳🇴 挪威 Norway', amount:100, updated:'2026-01-01 08:00' }),
  order('o-cny', { num:'K261006056', client:'张三美发用品', country:'🇨🇳 中国 China', currency:'CNY', amount:32652, updated:'2026-01-01 09:00' }),
  order('o-eur', { num:'K261020038', client:'Bella Wigs', currency:'EUR', amount:547, updated:'2026-01-01 10:00' }),
  order('o-usd', { num:'K261020040', client:'Alpha Salon', amount:5000, updated:'2026-01-01 11:00' }),
  order('o-gbp', { num:'K261020041', client:'Crown Lace', currency:'GBP', amount:6035, paidAmount:3000, stage:'production', updated:'2026-01-01 12:00' }),
  order('o-draft', { num:'K261020042', client:'Draft Buyer', currency:'EUR', amount:5758, isDraft:true, updated:'2026-01-01 13:00' })
];

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { ecbRates:rates, port:47991 });
    const rows = () => page.evaluate(() => [...document.querySelectorAll('#orderTableBody [data-order-list-id]')].map(row => row.dataset.orderListId));
    const waitRows = (expected, message) => page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#orderTableBody [data-order-list-id]')].map(row => row.dataset.orderListId)) === JSON.stringify(expected), expected, { timeout:8000 })
      .catch(async () => assert.fail(`${message}: rows are ${JSON.stringify(await rows())}, expected ${JSON.stringify(expected)}`));
    const search = page.locator('#orderListSearch');
    const clearSearch = async () => {
      await search.evaluate(input => { input.focus(); input.setSelectionRange(0, input.value.length); });
      await page.keyboard.press('Backspace');
    };
    const chips = () => page.locator('#orderListActiveFilters .order-list-filter-chip').allInnerTexts();
    const pickSelect = async (selectId, value) => {
      if (!await page.locator('#orderListMoreFilters').evaluate(node => node.open) && await page.locator('#orderListMoreFilters').evaluate((node, id) => node.contains(document.getElementById(id)), selectId)) {
        await page.locator('#orderListMoreFilters summary').click();
      }
      await page.locator(`#${selectId}`).locator('xpath=..').locator('.app-select-button').click();
      await page.locator(`.app-select-popover [data-app-select-value="${value}"]`).click();
      await page.waitForFunction(() => document.querySelector('.app-select-popover')?.hidden !== false);
    };

    await page.locator('.nav-item[data-page="order-list"]').click();
    await waitRows(['o-draft', 'o-gbp', 'o-usd', 'o-eur', 'o-cny', 'o-nor'], 'default order');

    // 1. 两个中文字、英文前缀、中文阶段名。
    await search.click();
    await page.keyboard.type('张三');
    await waitRows(['o-cny'], '张三 finds 张三美发用品');
    assert.deepEqual(await chips(), ['搜索：张三 ×']);
    await clearSearch();
    await page.keyboard.type('Alp');
    await waitRows(['o-usd'], 'Alp finds Alpha Salon');
    await clearSearch();
    await page.keyboard.type('生产中');
    await waitRows(['o-gbp'], 'Chinese stage name');
    // 已选条件里的「搜索」× 清掉搜索词。
    await page.locator('#orderListActiveFilters [data-clear-order-filter="search"]').click();
    await waitRows(['o-draft', 'o-gbp', 'o-usd', 'o-eur', 'o-cny', 'o-nor'], 'search chip cleared');
    assert.equal(await search.inputValue(), '');

    // 2. 输入法组字：拼音 z → zh → zhang 期间列表不重算，上屏后算一次。
    await page.evaluate(() => {
      window.__listRenders = [];
      const original = window.renderOrderListPage;
      window.renderOrderListPage = (...args) => { window.__listRenders.push(document.getElementById('orderListSearch').value); return original(...args); };
    });
    await search.click();
    const ime = await inputMethod(page);
    for (const text of ['z', 'zh', 'zhang']) {
      await ime.compose(text);
      // Proving the list does not redraw while composing: its search runs through debounce() (120 ms by default).
      await h.waitPageTime(page, 200);
    }
    assert.deepEqual(await page.evaluate(() => window.__listRenders), [], 'list re-rendered while composing');
    assert.equal(await page.locator('#orderTableBody .order-table-empty').count(), 0, 'composing must not flash the empty state');
    await ime.commit('张三');
    await waitRows(['o-cny'], 'committed IME text');
    assert.ok(!(await page.evaluate(() => window.__listRenders)).some(value => /[a-z]/.test(value)), 'no render with pinyin letters');
    await clearSearch();
    await waitRows(['o-draft', 'o-gbp', 'o-usd', 'o-eur', 'o-cny', 'o-nor'], 'search cleared');

    // 3. 金额排序按美元换算（CNY 32,652 ≈ $4,546 排在 USD 5,000 后面；GBP 6,035 ≈ $7,719 第一）。
    await pickSelect('orderListSort', 'amountDesc');
    await waitRows(['o-gbp', 'o-draft', 'o-usd', 'o-cny', 'o-eur', 'o-nor'], 'amount sort converts to USD');
    assert.ok((await chips()).some(text => text.startsWith('排序：订单金额')), 'non-default sort shows as a chip');
    await page.locator('#orderListActiveFilters [data-clear-order-filter="orderListSort"]').click();
    await waitRows(['o-draft', 'o-gbp', 'o-usd', 'o-eur', 'o-cny', 'o-nor'], 'sort chip resets the sort');
    if (await page.locator('#orderListMoreFilters').evaluate(node => node.open)) await page.locator('#orderListMoreFilters summary').click();

    // 4. 合计 / 待收不含草稿；草稿行只有「查看」。
    assert.match(await page.locator('#orderListResultCount').innerText(), /另有草稿 1 单未计入/);
    assert.deepEqual(await page.locator('#orderTableBody [data-order-list-id="o-draft"] .col-action button').allInnerTexts(), ['查看']);
    // 「待收款」快捷标签不含草稿；标签出现在已选条件里。
    await page.locator('#orderListQuickFilters [data-order-list-quick="unpaid"]').click();
    await waitRows(['o-gbp', 'o-usd', 'o-eur', 'o-cny', 'o-nor'], 'unpaid quick filter skips drafts');
    assert.deepEqual(await chips(), ['快捷：待收款 ×']);
    await page.locator('#orderListActiveFilters [data-clear-order-filter="quick"]').click();
    await waitRows(['o-draft', 'o-gbp', 'o-usd', 'o-eur', 'o-cny', 'o-nor'], 'quick chip cleared');

    // 5. 双击「收齐」：只改 Bella Wigs 这一张，行不跳走；鼠标离开表格后才按更新时间重排。
    const before = await rows();
    const eurIndex = before.indexOf('o-eur');
    await page.locator('#orderTableBody [data-order-list-id="o-eur"] [data-order-list-quick="paid"]').dblclick();
    await h.waitToast(page, 'K261020038');
    const eur = await h.order(page, 'o-eur');
    assert.equal(eur.paidAmount, 547);
    assert.equal(eur.stage, 'production', 'the second click must not advance it again');
    const usd = await h.order(page, 'o-usd');
    const cny = await h.order(page, 'o-cny');
    assert.deepEqual([usd.paidAmount, usd.stage, cny.paidAmount, cny.stage], [0, 'quote', 0, 'quote'], 'neighbouring orders untouched');
    assert.equal((await rows())[eurIndex], 'o-eur', 'the row stays under the mouse after 收齐');
    await page.mouse.move(5, 5);
    await waitRows(['o-eur', 'o-draft', 'o-gbp', 'o-usd', 'o-cny', 'o-nor'], 'rows re-sort once the mouse leaves');

    // 6. 国家筛选：唯一那张单没了，筛选保留为「挪威（0 单）」，不悄悄变回全部。
    await pickSelect('orderListCountryFilter', '🇳🇴 挪威 Norway');
    await waitRows(['o-nor'], 'country filter');
    await page.evaluate(() => { state.orders = state.orders.filter(item => item.id !== 'o-nor'); render(); });
    await page.waitForFunction(() => document.querySelector('#orderTableBody .order-table-empty'));
    assert.equal(await page.locator('#orderListCountryFilter').inputValue(), '🇳🇴 挪威 Norway');
    assert.ok((await chips()).some(text => text.includes('挪威') && text.includes('0 单')), 'the dropped country stays as a chip');
    if (await page.locator('#orderListMoreFilters').evaluate(node => node.open)) await page.locator('#orderListMoreFilters summary').click();

    // 7. 工作台「全部订单 →」清掉上次的筛选和搜索词。
    await search.click();
    await page.keyboard.type('Alp');
    await page.waitForFunction(() => document.getElementById('orderListActiveFilters').textContent.includes('搜索：Alp'));
    await page.locator('.nav-item[data-page="dashboard"]').click();
    await page.locator('[data-reset-order-list]').click();
    await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'page-order-list');
    await waitRows(['o-eur', 'o-draft', 'o-gbp', 'o-usd', 'o-cny'], 'all orders after 全部订单 →');
    assert.equal(await search.inputValue(), '');
    assert.deepEqual(await chips(), []);

    // 8. 一张单都没有：显示「还没有订单」和新建按钮，不显示分页；按钮打开新建订单。
    await page.evaluate(() => { state.orders = []; render(); });
    await page.waitForFunction(() => document.querySelector('#orderTableBody .order-table-empty')?.textContent.includes('还没有订单'));
    assert.equal(await page.locator('#orderListPagination').isHidden(), true);
    await page.locator('#orderTableBody [data-order-list-new]').click();
    await page.waitForFunction(() => document.getElementById('orderModal')?.classList.contains('open'));

    assert.deepEqual(dialogs, [], 'native dialogs must not appear');
    assert.deepEqual(errors, []);
    console.log('Order list UI fixes passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
