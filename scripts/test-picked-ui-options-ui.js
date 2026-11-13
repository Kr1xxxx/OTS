#!/usr/bin/env node
// 用户挑定的五处外观（1C 2B 3C 4B 5B），真实页面 + 真实键盘鼠标：
// 1. 通知面板开着时后面轻轻压暗、不模糊；
// 2. 「国家 / 地区」栏的建议列表是 App 自己的菜单：打字筛选（UK 排第一、高亮第一项，回车选它）、↑ ↓ 加回车选中、点一项选中、Esc 只收菜单不关弹窗 / 抽屉，
//    列表外的写法照样能填；外框和下拉框的菜单一样，箭头展开时朝上；
// 3. 订单抽屉里「交期」和「这位客户」的小方块都是灰底、没有边框；
// 4. 订单、客户、已删除订单没有数据时是图标、标题、说明，能新建的带按钮；
// 5. 设置里的等级规则表是灰字白底表头、没有竖线、等级那一列不再是紫底。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const US = '🇺🇸 美国 United States';
const UK = '🇬🇧 英国 United Kingdom';
const DE = '🇩🇪 德国 Germany';
const FR = '🇫🇷 法国 France';
const RO = '🇷🇴 罗马尼亚 Romania';
const orders = [
  { ...base, id:'p1', num:'K7001', client:'Picked Buyer', stage:'production', orderType:'定金订单', amount:2400, depositAmount:800, paidAmount:800, customerRequiredDate:day(20), latestShipDate:day(15), createdAt:day(2), updated:`${day(2)} 10:00` }
];

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs, context } = await openBoard(browser, { orders, customers:{ 'Picked Buyer':{ client:'Picked Buyer', country:US, currency:'USD' } } }, { port:47993 });
    const menu = () => page.evaluate(() => {
      const el = document.getElementById('suggestMenu');
      const options = el ? [...el.querySelectorAll('.app-select-option')] : [];
      return { open:Boolean(el && !el.hidden), items:options.map(o => o.textContent.trim()), active:el?.querySelector('.app-select-option.active')?.textContent.trim() || '',
        selected:el?.querySelector('.app-select-option.selected')?.textContent.trim() || '' };
    });
    const retype = async (locator, text) => {
      await locator.evaluate(el => { el.focus(); el.select(); });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(text, { delay:5 });
    };
    const isOpen = id => page.evaluate(id => document.getElementById(id).classList.contains('open'), id);

    // ---- 1. 通知面板：轻轻压暗，不模糊 ----
    await h.click(page, '#notifBtn', 'bell');
    await page.waitForFunction(() => !document.getElementById('notifPanel').hidden);
    const scrim = await page.evaluate(() => {
      const style = getComputedStyle(document.getElementById('notifScrim'));
      return { color:style.backgroundColor, blur:style.backdropFilter || style.webkitBackdropFilter || 'none' };
    });
    assert.notEqual(scrim.color, 'rgba(0, 0, 0, 0)', 'the page behind the notification panel is dimmed');
    const alpha = Number((scrim.color.match(/[\d.]+(?=\)$)/) || ['1'])[0]);
    assert.ok(alpha > 0 && alpha < 0.2, `the dim is light (${scrim.color})`);
    assert.equal(scrim.blur, 'none', 'no blur behind the notification panel');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('notifPanel').hidden);

    // ---- 2. 新建订单的国家栏 ----
    await page.evaluate(() => openOrder());
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    const orderCountry = page.locator('#orderForm [name="country"]');
    assert.equal(await page.locator('datalist#countryOptions').count(), 0, 'the system suggestion list is gone');
    const closedArrow = await orderCountry.evaluate(el => getComputedStyle(el).backgroundImage);
    await h.click(page, orderCountry, 'order country');
    let state = await menu();
    assert.ok(state.open, 'clicking the country field opens the menu');
    assert.ok(state.items.length > 20, 'an empty or listed value shows every country');
    assert.equal(await orderCountry.getAttribute('aria-expanded'), 'true');
    // 箭头换向有一下淡入淡出（栏位的 background 过渡），等它走完再看。
    await page.waitForFunction(closed => getComputedStyle(document.querySelector('#orderForm [name="country"]')).backgroundImage !== closed, closedArrow, { timeout:2000 })
      .catch(() => assert.fail('the arrow turns up while the menu is open'));
    const frames = await page.evaluate(() => {
      const look = el => { const s = getComputedStyle(el); return { radius:s.borderTopLeftRadius, border:`${s.borderTopWidth} ${s.borderTopColor}`, shadow:s.boxShadow, background:s.backgroundColor }; };
      ensureAppSelectPopover();
      const select = document.querySelector('.app-select-popover');
      select.hidden = false;
      const value = { country:look(document.getElementById('suggestMenu')), select:look(select) };
      select.hidden = true;
      return value;
    });
    assert.deepEqual(frames.country, frames.select, 'the country menu has the same frame as every select menu');

    await retype(orderCountry, 'uk');
    state = await menu();
    assert.equal(state.items[0], UK, 'UK lists the United Kingdom first, not Ukraine');
    assert.equal(state.active, UK, 'typing highlights the first match');
    await page.keyboard.press('ArrowDown');
    assert.notEqual((await menu()).active, UK, '↓ moves on from the first match');
    await page.keyboard.press('ArrowUp');
    assert.equal((await menu()).active, UK);
    await page.keyboard.press('Enter');
    assert.equal(await orderCountry.inputValue(), UK, 'Enter picks the highlighted country');
    assert.equal((await menu()).open, false, 'the menu closes after picking');
    assert.ok(await isOpen('orderModal'), 'Enter on the menu does not submit the order form');
    assert.equal(await page.evaluate(() => document.activeElement?.name), 'country', 'focus stays in the field');

    await retype(orderCountry, 'un');
    state = await menu();
    assert.ok(state.items.includes(US) && state.items.includes(UK), `typing filters the list (${state.items.join(' / ')})`);
    await h.click(page, page.locator('#suggestMenu .app-select-option', { hasText:'United States' }), 'United States option');
    assert.equal(await orderCountry.inputValue(), US, 'clicking an option picks it');
    assert.equal((await menu()).open, false);

    await page.keyboard.press('ArrowDown');
    state = await menu();
    assert.ok(state.open, '↓ opens the menu');
    assert.equal(state.selected, US, 'the current country is marked in the full list');
    assert.equal(state.active, US, '↓ on a closed menu lands on the current country, not the one after it');
    await page.keyboard.press('ArrowDown');
    assert.notEqual((await menu()).active, US, 'the next ↓ moves on');
    await page.keyboard.press('Escape');
    assert.equal((await menu()).open, false, 'Esc closes the menu');
    assert.ok(await isOpen('orderModal'), 'Esc on the menu leaves the order modal open');

    await retype(orderCountry, 'Nigeria');
    assert.equal((await menu()).open, false, 'no menu for a country outside the list');
    assert.equal(await orderCountry.inputValue(), 'Nigeria', 'free text is kept as typed');
    await retype(orderCountry, 'fra');
    await page.keyboard.press('Tab');
    assert.equal((await menu()).open, false, 'Tab closes the menu');
    assert.equal(await orderCountry.inputValue(), 'fra', 'Tab does not pick anything');
    // 只点一下列表外的写法（没在打字）：列出匹配的，但不高亮，回车不会把原来填的换掉。
    await h.click(page, orderCountry, 'order country with an off-list value');
    state = await menu();
    assert.deepEqual([state.open, state.items[0], state.active], [true, FR, ''], 'a click lists the matches without picking one');
    await page.keyboard.press('Escape');
    assert.equal((await menu()).open, false);
    // 半个名字回车：选中筛出来的第一项，不把半个名字当国家、也不提交订单表单。
    await retype(orderCountry, 'germ');
    state = await menu();
    assert.deepEqual([state.items, state.active], [[DE], DE], 'germ leaves Germany, highlighted');
    await page.keyboard.press('Enter');
    assert.equal(await orderCountry.inputValue(), DE, 'Enter on a half-typed name picks the only match');
    assert.ok(await isOpen('orderModal'), 'Enter on the menu does not save the order');
    // 只在词中间出现（oman 在 R-oman-ia 里）：菜单照样列出来但不高亮，回车留下原文，不能存成罗马尼亚；↓ 再回车才选。
    await retype(orderCountry, 'Oman');
    state = await menu();
    assert.deepEqual([state.open, state.items.includes(RO), state.active], [true, true, ''], 'Oman lists Romania without highlighting it');
    await page.keyboard.press('Enter');
    assert.equal(await orderCountry.inputValue(), 'Oman', 'Enter keeps Oman as typed');
    assert.equal((await menu()).open, false, 'Enter closes the menu');
    assert.ok(await isOpen('orderModal'), 'Enter on the country field does not save the order');
    await retype(orderCountry, 'oman');
    await page.keyboard.press('ArrowDown');
    assert.equal((await menu()).active, RO, '↓ highlights Romania');
    await page.keyboard.press('Enter');
    assert.equal(await orderCountry.inputValue(), RO, '↓ then Enter picks Romania');
    await page.evaluate(() => closeOrder());
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));

    // ---- 2. 客户弹窗的国家栏 ----
    await h.click(page, '#topNewCustomerBtn', 'new customer');
    await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
    const customerCountry = page.locator('#customerForm [name="country"]');
    await retype(customerCountry, 'ger');
    assert.equal((await menu()).items[0], DE);
    await page.keyboard.press('Enter');
    assert.equal(await customerCountry.inputValue(), DE);
    await page.keyboard.press('ArrowUp');
    assert.ok((await menu()).open, '↑ opens the menu too');
    await page.keyboard.press('Escape');
    assert.equal((await menu()).open, false);
    assert.ok(await isOpen('customerModal'), 'Esc on the menu leaves the customer modal open');
    await page.evaluate(() => closeCustomerModal());
    await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));

    // ---- 2 + 3. 订单抽屉：国家栏和灰底小方块 ----
    await page.evaluate(() => openOrderDetail('p1'));
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    const drawerCountry = page.locator('#orderDetailBody [data-dedit="country"]');
    await retype(drawerCountry, 'franc');
    assert.equal((await menu()).items[0], FR);
    await page.keyboard.press('Enter');
    assert.equal(await drawerCountry.inputValue(), FR);
    assert.ok(await page.evaluate(() => uiDetailUnsaved()), 'picking a country marks the drawer as changed');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    assert.equal((await menu()).open, false);
    assert.ok(await isOpen('orderDetailDrawer'), 'Esc on the menu leaves the drawer open');

    const tile = selector => page.evaluate(selector => {
      const el = document.querySelector(selector);
      const s = getComputedStyle(el);
      return { background:s.backgroundColor, border:s.borderTopWidth, radius:s.borderTopLeftRadius, padding:s.padding,
        label:getComputedStyle(el.firstElementChild).fontSize, value:getComputedStyle(el.lastElementChild).fontSize };
    }, selector);
    await page.locator('[data-detail-tab-btn="payment"]').click();
    const customerTile = await tile('#orderDetailBody .order-detail-customer-stat');
    await page.locator('[data-detail-tab-btn="logistics"]').click();
    await page.waitForFunction(() => !document.querySelector('#orderDetailBody [data-detail-tab="logistics"]').hidden);
    const deliveryTile = await tile('#orderDetailBody [data-detail-tab="logistics"] .detail-grid > .detail-item');
    assert.deepEqual(deliveryTile, customerTile, 'the delivery tiles look like the customer tiles');
    assert.equal(deliveryTile.border, '0px', 'read-only tiles have no border');
    assert.notEqual(deliveryTile.background, 'rgba(0, 0, 0, 0)');

    // ---- 5. 等级规则表 ----
    await page.evaluate(() => { closeOrderDetail(); setPage('settings'); });
    await h.click(page, '.settings-menu-item[data-settings-tab="customer"]', 'settings tab customer');
    await page.waitForSelector('.level-rule-row.head');
    const table = await page.evaluate(() => {
      const tableStyle = getComputedStyle(document.getElementById('levelRuleTable'));
      const head = getComputedStyle(document.querySelector('.level-rule-row.head'));
      const name = getComputedStyle(document.querySelector('.level-rule-name'));
      const rows = [...document.querySelectorAll('.level-rule-row > div')].map(div => getComputedStyle(div).borderRightWidth);
      const plainText = getComputedStyle(document.querySelector('.level-rule-row:not(.head) > div:last-child')).color;
      return { tableBg:tableStyle.backgroundColor, headBg:head.backgroundColor, headColor:head.color, headWeight:head.fontWeight, nameBg:name.backgroundColor, rightBorders:[...new Set(rows)], plainText };
    });
    assert.equal(table.headBg, table.tableBg, 'the header row has the table background, no tint');
    assert.notEqual(table.headColor, table.plainText, 'the header is grey text');
    assert.equal(table.headWeight, '500');
    assert.equal(table.nameBg, 'rgba(0, 0, 0, 0)', 'the level column is not tinted');
    assert.deepEqual(table.rightBorders, ['0px'], 'no column lines');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    await context.close();

    // ---- 4. 没有数据时的三页 ----
    const empty = await openBoard(browser, { orders:[] }, { port:47994 });
    const emptyPage = empty.page;
    const emptyState = selector => emptyPage.evaluate(selector => {
      const el = document.querySelector(`${selector} .empty-state`);
      return el ? { icon:Boolean(el.querySelector('.empty-state-ic svg')), title:el.querySelector('.empty-state-title')?.textContent, text:el.children[2]?.textContent, button:el.querySelector('button')?.textContent.trim() || '' } : null;
    }, selector);
    await emptyPage.evaluate(() => setPage('order-list'));
    await emptyPage.waitForSelector('#orderTableBody .empty-state');
    assert.deepEqual(await emptyState('#orderTableBody'), { icon:true, title:'还没有订单', text:'新建的订单会按阶段排在这里。', button:'新建订单' });
    await emptyPage.evaluate(() => setPage('customers'));
    await emptyPage.waitForSelector('#customerList .empty-state');
    assert.deepEqual(await emptyState('#customerList'), { icon:true, title:'还没有客户', text:'新建客户，或者保存第一张订单时自动建档。', button:'新建客户' });
    await h.click(emptyPage, '#customerList .empty-state button', 'empty-state new customer');
    await emptyPage.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
    await emptyPage.evaluate(() => closeCustomerModal());
    await emptyPage.evaluate(() => setPage('deleted'));
    await emptyPage.waitForSelector('#deletedOrderList .empty-state');
    assert.deepEqual(await emptyState('#deletedOrderList'), { icon:true, title:'没有已删除的订单', text:'删除后的订单会先保存在这里，可以恢复。', button:'' });
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(empty.dialogs, []);
    await empty.context.close();
    console.log('Picked UI options passed: light dim behind notifications, in-app country menu in the order, customer and drawer forms, grey read-only drawer tiles, full empty states, plain level-rule table.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
