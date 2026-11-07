#!/usr/bin/env node
// 全局搜索（V3.123），全程真实键盘和鼠标：
// - ↑↓ 选中项和鼠标悬停有看得见的底色，悬停的那条就是 Enter 打开的那条；第一次按 ↑ 选最后一条；
// - 运单号、金额 Enter 打开那张订单（关联了订单的物流记录打开订单的物流页签），不是客户档案 / 物流抽屉；
// - 逐字输入邮箱每一步都有结果；第 2 批运单号的副标题写「第 2 批」；
// - 输入法组字期间面板不重算；⌘K 先收起通知面板；搜「订单」第一条是订单页；「新建订单」是操作；
// - 0 结果不显示「查看全部搜索结果」；面板背景不透明。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const order = (id, fields) => ({ ...base, id, orderType:'定金订单', paidAmount:0, stage:'quote', ...fields });
const orders = [
  order('o-acme', {
    num:'SO-2024-0105', client:'Acme Beauty LLC', amount:1022.5, note:'3 月 10 日前发货', stage:'shipment', paidAmount:1022.5,
    trackingNumber:'1Z999AA10123456784', carrier:'UPS', logisticsStatus:'运输中',
    shipments:[{ trackingNumber:'1Z999AA10123456784', carrier:'UPS', status:'运输中' }, { trackingNumber:'9400100000000000000001', carrier:'auto', status:'已发货' }],
    updated:`${day(1)} 09:00`
  }),
  order('o-elite', { num:'K261022000', client:'Elite Extensions', amount:5762, note:'黑色 13x4 lace', trackingNumber:'7700112233', carrier:'DHL', updated:`${day(1)} 10:00` }),
  order('o-acme2', { num:'K261022001', client:'Acme Beauty LLC', amount:300, updated:`${day(1)} 11:00` })
];
const customers = {
  'Acme Beauty LLC': { client:'Acme Beauty LLC', contact:'John Doe', email:'john.doe@acme-beauty.com', phone:'+44 7700 900127', address:'221B Baker Street, London' },
  'Elite Extensions': { client:'Elite Extensions', email:'buyer@elite.example' }
};
const trackingLookups = [{ id:'t1', trackingNumber:'1Z999AA10123456784', carrier:'UPS', orderId:'o-acme', client:'Acme Beauty LLC', orderNum:'SO-2024-0105', status:'运输中', checkedAt:`${day(1)} 12:00` }];
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders, customers, trackingLookups }, { port:47992 });
    const input = page.locator('#searchInput');
    const panelOpen = () => page.waitForFunction(() => document.getElementById('globalSearchPanel').classList.contains('open'));
    // 等面板按当前输入算完（输入有 100ms 防抖）。
    const settled = () => page.waitForFunction(() => document.getElementById('globalSearchPanel').classList.contains('open') && globalSearchRenderedQuery === document.getElementById('searchInput').value.trim());
    const typeQuery = async text => {
      await input.evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length); });
      if (await input.inputValue()) await page.keyboard.press('Backspace');
      await page.keyboard.type(text);
      await settled();
    };
    const results = () => page.evaluate(() => currentGlobalSearchResults.map(item => `${item.type}:${item.id || item.page || item.action}`));
    const closeDrawer = async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    };
    const background = selector => page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor);

    // 1. ⌘K 打开；↓ 两次，第 2 条有底色（以前 --teal-100 未定义，看不出选中了哪条）。
    await page.locator('body').click({ position:{ x:5, y:400 } });
    await page.keyboard.press(`${mod}+k`);
    await page.waitForFunction(() => document.activeElement?.id === 'searchInput');
    await panelOpen();
    await typeQuery('acme');
    const idle = await background('#global-search-result-0');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.getElementById('global-search-result-1')?.classList.contains('active'));
    const active = await background('#global-search-result-1');
    assert.notEqual(active, idle, 'the active result needs a visible background');
    assert.notEqual(active, 'rgba(0, 0, 0, 0)');
    // 鼠标悬停的那条成为选中项，Enter 打开它。
    const list = await results();
    const acmeOrder = list.indexOf('order:o-acme');
    assert.ok(acmeOrder >= 0, `acme order in results: ${list}`);
    await page.locator(`#global-search-result-${acmeOrder}`).hover();
    await page.waitForFunction(index => globalSearchActiveIndex === index && document.getElementById(`global-search-result-${index}`).classList.contains('active'), acmeOrder);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open') && document.getElementById('detailNum').textContent === 'SO-2024-0105');
    await closeDrawer();

    // 2. 第一次按 ↑ 选最后一条。
    await page.keyboard.press(`${mod}+k`);
    await typeQuery('acme');
    await page.keyboard.press('ArrowUp');
    const count = (await results()).length;
    await page.waitForFunction(last => globalSearchActiveIndex === last, count - 1);

    // 3. 运单号（有物流查询记录）→ 打开订单的物流页签，不是物流抽屉。
    await typeQuery('1Z999AA10123456784');
    assert.equal((await results())[0], 'order:o-acme', 'exact tracking number puts the order first');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open') && detailOrderId === 'o-acme' && uiDetailTab.current === 'logistics');
    assert.equal(await page.evaluate(() => document.getElementById('trackingDetailDrawer')?.classList.contains('open') || false), false);
    await closeDrawer();

    // 4. 金额、订单备注 → Enter 打开那张订单（以前客户排在前面，打开客户档案）。
    for (const [query, id] of [['5762', 'o-elite'], ['黑色 13x4', 'o-elite'], ['1022.50', 'o-acme'], ['3 月 10 日前', 'o-acme']]) {
      await page.keyboard.press(`${mod}+k`);
      await typeQuery(query);
      assert.equal((await results())[0], `order:${id}`, `${query} ranks the order first: ${await results()}`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(id => document.getElementById('orderDetailDrawer').classList.contains('open') && detailOrderId === id, id);
      assert.equal(await page.evaluate(() => document.getElementById('customerModal')?.classList.contains('open')), false);
      await closeDrawer();
    }

    // 5. 逐字输入邮箱：每一步都有结果。
    await page.keyboard.press(`${mod}+k`);
    await input.evaluate(el => { el.setSelectionRange(0, el.value.length); });
    await page.keyboard.press('Backspace');
    const email = 'john.doe@acme-beauty.co';
    for (const char of email) {
      await page.keyboard.type(char);
      await settled();
      if ((await input.inputValue()).length >= 3) assert.ok((await results()).length > 0, `no results for ${await input.inputValue()}`);
    }
    // 6. 第 2 批运单号：副标题写第 2 批。
    await typeQuery('9400100000000000000001');
    assert.match(await page.locator('#global-search-result-0 .global-search-sub').innerText(), /第 2 批 · 9400100000000000000001/);

    // 7. 输入法组字期间面板不重算。
    await typeQuery('Eli');
    const cdp = await page.context().newCDPSession(page);
    for (const text of ['z', 'zh', 'zhang']) {
      await cdp.send('Input.imeSetComposition', { text, selectionStart:text.length, selectionEnd:text.length });
      await h.waitPageTime(page, 150);
    }
    assert.equal(await page.evaluate(() => globalSearchRenderedQuery), 'Eli', 'panel re-rendered while composing');
    await cdp.send('Input.insertText', { text:'' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('globalSearchPanel').classList.contains('open'));

    // 8. 通知面板开着按 ⌘K：通知先收起，结果能点中。
    await page.locator('#notifBtn').click();
    await page.waitForFunction(() => !document.getElementById('notifPanel').hidden);
    await page.keyboard.press(`${mod}+k`);
    await page.waitForFunction(() => document.getElementById('notifPanel').hidden && document.activeElement?.id === 'searchInput');
    await typeQuery('Elite');
    const box = await page.locator('#global-search-result-0').boundingBox();
    const hit = await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest('.global-search-result')?.id || '', { x:box.x + box.width / 2, y:box.y + box.height / 2 });
    assert.equal(hit, 'global-search-result-0', 'nothing covers the search results');

    // 9. 搜「订单」：第一条是侧栏的「订单」页；面板背景不透明。
    await typeQuery('订单');
    assert.equal((await results())[0], 'page:order-list');
    const panelStyle = await page.locator('#globalSearchPanel').evaluate(el => ({ bg:getComputedStyle(el).backgroundColor, filter:getComputedStyle(el).backdropFilter }));
    assert.ok(!/rgba\(.*,\s*0?\.\d+\)$/.test(panelStyle.bg) && panelStyle.bg !== 'rgba(0, 0, 0, 0)', `panel background is see-through: ${panelStyle.bg}`);
    assert.ok(['none', ''].includes(panelStyle.filter), `panel keeps a backdrop filter: ${panelStyle.filter}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'page-order-list');
    // 跳转后焦点还在搜索框：⌘K 重新展开面板。
    await page.keyboard.press(`${mod}+k`);
    await panelOpen();

    // 10. 0 结果：不显示「查看全部搜索结果」，文案不说「完全匹配」。
    await typeQuery('zzqqxxww');
    assert.equal(await page.locator('#globalSearchPanel [data-open-full-search]').count(), 0);
    assert.match(await page.locator('#globalSearchPanel .global-search-empty').innerText(), /没有找到相关内容/);

    // 11. 「新建订单」是操作，Enter 打开新建订单。
    await typeQuery('新建订单');
    assert.equal((await results())[0], 'action:new-order');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('orderModal')?.classList.contains('open'));

    await page.evaluate(() => closeOrder());
    // 12. 「全部搜索结果」页的分类条不超出卡片。
    await page.keyboard.press(`${mod}+k`);
    await typeQuery('acme');
    await page.locator('#globalSearchPanel [data-open-full-search]').click();
    await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'page-search-results');
    const edges = await page.evaluate(() => [document.getElementById('fullSearchTypeFilters').getBoundingClientRect().right, document.querySelector('.full-search-page').getBoundingClientRect().right]);
    assert.ok(edges[0] <= edges[1], `category bar overflows the card: ${edges}`);

    assert.deepEqual(dialogs, [], 'native dialogs must not appear');
    assert.deepEqual(errors, []);
    console.log('Global search UI tests passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
