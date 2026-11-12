#!/usr/bin/env node
// 客户只读档案（左档案栏 + 右侧数字卡和标签页）：地址不再被挤在窄列里，标签页可点可用键盘切换。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const address = 'Carrer de les Taronges, 5, 5 Carrer de les Taronges, 17310, Lloret de Mar, Catalunya, Spain';
const data = {
  orders:[
    { ...base, id:'v1', num:'K26102001', client:'Vanessa Kroon', amount:1502, paidAmount:1502, stage:'production', createdAt:day(3) },
    { ...base, id:'v2', num:'K26091502', client:'Vanessa Kroon', amount:1479, paidAmount:1479, stage:'done', createdAt:day(2) },
    { ...base, id:'e1', num:'K26100009', client:'Empty Co', amount:0, paidAmount:0, stage:'quote', createdAt:day(4) },
    { ...base, id:'n1', num:'K26110902', client:'Long Note Co', amount:775.6, paidAmount:775.6, stage:'production', createdAt:day(5) },
    { ...base, id:'n2', num:'S026081002', client:'Long Note Co', amount:523, paidAmount:523, stage:'done', createdAt:day(1) }
  ],
  customers:{
    'Vanessa Kroon':{
      client:'Vanessa Kroon', country:'🇪🇸 西班牙 Spain', emails:['vanessa@example.com', 'second@example.com'], email:'vanessa@example.com',
      phones:['+34 600 000 000'], phone:'+34 600 000 000', addresses:[address], address, currency:'USD', paymentMethod:'阿里巴巴',
      level:'C级白金客户', tags:['批发'], owner:'Kris', note:'普通备注', permanentNote:'只用无品牌包装'
    },
    // 用户实际反馈的那类客户：十行备注 + 两笔订单，在 1102×912 的窗口（Mac App 85% 缩放下的常见大小）里要一屏看完。
    'Long Note Co':{
      client:'Long Note Co', country:'🇺🇸 美国 United States', addresses:['1030 slater road apartment 111 Durham NC 27703'], address:'1030 slater road apartment 111 Durham NC 27703',
      currency:'USD', paymentMethod:'阿里巴巴', level:'D级黄金客户', owner:'Kris',
      note:'20inch 135\n22inch 148\n24inch 195\nShipping 30 alibaba fee 15\nTotal 523\n\n接发\n\nLong Note Co\n1030 slater road apartment 111 Durham NC 27703'
    }
  }
};

const box = (page, selector) => page.locator(selector).first().evaluate(node => {
  const rect = node.getBoundingClientRect();
  return { left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom, width:rect.width };
});
const openProfile = async (page, name) => {
  await page.evaluate(client => openCustomerModal(client), name);
  await page.locator('#customerModal.open').waitFor();
  await h.quiet(page);
};

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, data, { width:1440, height:920 });
    await openProfile(page, 'Vanessa Kroon');

    // 头部：客户名 + 编号 + 只读说明 + 标签，原来重复的大卡片不再出现。
    assert.equal(await page.locator('#customerModalTitle').innerText(), 'Vanessa Kroon');
    assert.match(await page.locator('#customerModalSub').innerText(), /^C\d+/);
    assert.equal(await page.locator('#customerModalState').innerText(), '客户完整档案 · 只读');
    assert.match(await page.locator('#customerModalDesc').innerText(), /C级白金客户[\s\S]*批发/);
    assert.equal(await page.locator('#customerDetailHero').count(), 0);

    // 左档案栏在左、内容在右；地址有整栏宽度，不再是一百来像素的窄列。
    const rail = await box(page, '#customerDetailInfoGrid');
    const main = await box(page, '.customer-detail-main');
    assert.ok(rail.right <= main.left, '左档案栏应在右侧内容的左边');
    assert.ok(Math.abs(rail.top - main.top) < 2, '两栏顶部对齐');
    const addressBox = await box(page, '.customer-rail-address');
    assert.ok(addressBox.width >= 240, `地址宽度太窄：${addressBox.width}`);
    assert.equal(await page.locator('.customer-rail-address').innerText(), address);
    assert.equal(await page.locator('#customerDetailInfoGrid [data-copy-customer-address]').count(), 1);
    assert.match(await page.locator('#customerDetailInfoGrid').innerText(), /未填写：联系人、联系方式、阿里 ID/);
    assert.match(await page.locator('#customerDetailInfoGrid').innerText(), /主要/);
    assert.match(await page.locator('#customerDetailPermanentNote').innerText(), /只用无品牌包装/);
    assert.match(await page.locator('#customerDetailNote').innerText(), /普通备注/);
    assert.equal(await page.locator('#customerProfileMetrics .customer-metric-card').count(), 6);

    // 订单少的客户一屏看完，任何情况下都不出现横向滚动。
    const scroll = await page.locator('#customerForm').evaluate(form => ({ extraY:form.scrollHeight - form.clientHeight, extraX:form.scrollWidth - form.clientWidth }));
    assert.ok(scroll.extraY <= 1, `不应出现纵向滚动：多出 ${scroll.extraY}px`);
    assert.ok(scroll.extraX <= 1, `不应出现横向滚动：多出 ${scroll.extraX}px`);

    // 复制按钮：点一下只换成对勾，不改文字，1.5 秒后恢复。
    await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.copiedText = text; }; });
    const copy = page.locator('#customerDetailInfoGrid [data-copy-customer-value]').first();
    await copy.click();
    await page.waitForFunction(() => window.copiedText === '+34 600 000 000');
    assert.ok(await copy.evaluate(node => node.classList.contains('is-copied')));

    // 标签页：默认关联订单，点击和方向键都能切换，面板与右上角说明跟着换。
    const tab = name => page.locator(`[data-customer-detail-tab="${name}"]`);
    const shown = () => page.evaluate(() => [...document.querySelectorAll('[data-customer-detail-panel]')].filter(panel => !panel.hidden).map(panel => panel.dataset.customerDetailPanel));
    assert.deepEqual(await shown(), ['orders']);
    assert.equal(await tab('orders').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#customerDetailOrdersCount').innerText(), '2');
    assert.equal(await page.locator('#customerDetailOrders [data-customer-detail-order]').count(), 2);
    await tab('activity').click();
    assert.deepEqual(await shown(), ['activity']);
    assert.equal(await tab('activity').getAttribute('aria-selected'), 'true');
    assert.equal(await tab('orders').getAttribute('tabindex'), '-1');
    assert.ok(await page.locator('[data-customer-detail-meta="orders"]').isHidden());
    assert.ok(await page.locator('#customerHistoryList').isVisible());
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await shown(), ['whatsapp']);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.customerDetailTab), 'whatsapp');
    await page.keyboard.press('Home');
    assert.deepEqual(await shown(), ['orders']);
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await shown(), ['whatsapp']);

    // 换一个客户再打开：回到关联订单，空资料合并成一行「未填写」。
    await page.evaluate(() => closeCustomerModal());
    await openProfile(page, 'Empty Co');
    assert.deepEqual(await shown(), ['orders']);
    assert.match(await page.locator('#customerDetailInfoGrid').innerText(), /未填写：联系人、电话、邮箱、联系方式、阿里 ID/);
    assert.match(await page.locator('#customerDetailPermanentNote').innerText(), /未设置/);

    // 进入编辑再取消：头部说明恢复，不残留只读标签。
    await page.locator('#customerDetailEditBtn').click();
    assert.equal(await page.locator('#customerModalState').innerText(), '');
    assert.equal(await page.locator('#customerModalSub').innerText(), '编辑客户档案');
    assert.ok(await page.locator('#customerDetailView').isHidden());
    await page.evaluate(() => closeCustomerModal());

    // 弹窗比订单弹窗大一号（1040×920），窗口不够高时上下各留 12px。
    await openProfile(page, 'Long Note Co');
    const shell = await box(page, '#customerModal .modal');
    assert.equal(Math.round(shell.width), 1040);
    assert.equal(Math.round(shell.bottom - shell.top), 896);
    await page.evaluate(() => closeCustomerModal());

    // 备注很长、订单两笔的客户：标签页卡片只占两行订单的高度，整份档案不用滚动，两笔订单都看得见。
    await page.setViewportSize({ width:1102, height:912 });
    await openProfile(page, 'Long Note Co');
    const longNote = await page.locator('#customerForm').evaluate(form => ({ extraY:form.scrollHeight - form.clientHeight, extraX:form.scrollWidth - form.clientWidth }));
    assert.ok(longNote.extraY <= 1, `长备注客户不应出现纵向滚动：多出 ${longNote.extraY}px`);
    assert.ok(longNote.extraX <= 1);
    const ordersPanel = await page.locator('#customerDetailOrdersPanel').evaluate(panel => ({ extra:panel.scrollHeight - panel.clientHeight, rows:panel.querySelectorAll('.customer-detail-order-row').length }));
    assert.deepEqual(ordersPanel, { extra:0, rows:2 }, '两笔订单应完整显示在卡片里');
    const lastRow = await box(page, '#customerDetailOrders .customer-detail-order-row:last-child');
    const formBox = await box(page, '#customerForm');
    assert.ok(lastRow.bottom <= formBox.bottom, '最后一笔订单应在可见范围内');
    await page.evaluate(() => closeCustomerModal());

    // 窄窗口：改成上下一栏，仍然没有横向滚动。
    await page.setViewportSize({ width:700, height:800 });
    await openProfile(page, 'Vanessa Kroon');
    const narrowRail = await box(page, '#customerDetailInfoGrid');
    const narrowMain = await box(page, '.customer-detail-main');
    assert.ok(narrowRail.bottom <= narrowMain.top, '窄窗口下档案栏应排在内容上方');
    assert.ok(await page.locator('#customerForm').evaluate(form => form.scrollWidth - form.clientWidth) <= 1);

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('Customer profile layout UI passed: left rail, wide address, one-screen fit (also with a long note at 1102×912), larger shell, copy feedback, tabs by click and keyboard, edit header reset, narrow layout verified.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
