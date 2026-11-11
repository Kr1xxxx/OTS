const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

// 订单弹窗三栏和「订单详情」字段：
// - 新建订单：左粘贴识别、中表单、右订单预览排成一行，订单号和创建日期在标题栏；常用字段一屏放下，中栏不用滚；
//   没有分步导航，只有一个「保存订单」，起始焦点在它上面；
// - 订单预览跟着表单走：客户、等级、金额、定金、已收、待收、保存后进哪个阶段；右栏写着的两句说明（定金比例、按收款进哪个阶段）
//   宽屏不再重复占一行，窗口窄到右栏收成按钮条时照常显示；
// - 订单详情：一行一项，保存时去掉空行和首尾空格；抽屉里看得到、改得了，改了写操作记录；搜索搜得到；CSV 有这一列；
// - 编辑已有订单：分区全部展开，复制 / 删除在右栏。
const orders = [
  { ...base, id:'d1', num:'K701', client:'Mila Lash Studio', productType:'睫毛', orderType:'定金订单', amount:1000, depositAmount:300, depositPercent:30, paidAmount:300, stage:'production', orderDetail:'C 卷 0.07 × 100 盒\nD 卷 0.05 × 60 盒', updated:`${day(4)} 09:01` }
];
const customers = {
  'Mila Lash Studio': { client:'Mila Lash Studio', country:base.country, currency:'USD', paymentMethod:'Paypal', level:'D级黄金客户', address:'1 Sample Road, Springfield' }
};

const field = (page, name) => page.locator(`#orderForm [name="${name}"]`);
const preview = page => page.locator('#modalSummary').innerText();
const shown = (page, selector) => page.evaluate(selector => {
  const el = document.querySelector(selector);
  return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}, selector);
const saved = page => page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs } = await openBoard(browser, { orders, customers, orderSettings:{ defaultOrderType:'定金订单' } }, { width:1102, height:912 });

    // ===== 1. 新建订单：三栏、标题栏里的订单号和日期、一屏放下 =====
    await page.locator('#newOrderBtn').click();
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await h.settle(page, '#orderModal .order-modal');
    const layout = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom }; };
      const main = document.querySelector('#orderModal .order-main');
      return {
        modal:rect('#orderModal .order-modal'),
        paste:rect('#orderModal .order-paste-section'),
        main:rect('#orderModal .order-main'),
        rail:rect('#orderModal .order-preview'),
        head:rect('#orderModal .modal-head'),
        num:rect('#orderForm [name="num"]'),
        date:rect('#orderForm [name="createdAt"]'),
        overflow:main.scrollHeight - main.clientHeight,
        nav:document.querySelectorAll('#orderModal .mnav').length,
        submits:[...document.querySelectorAll('#orderModal button[type="submit"]')].filter(el => el.getClientRects().length).map(el => el.textContent.trim())
      };
    });
    assert(layout.paste.right <= layout.main.left && layout.main.right <= layout.rail.left, `三栏从左到右排开：${JSON.stringify(layout)}`);
    assert(Math.abs(layout.paste.top - layout.main.top) < 1 && Math.abs(layout.main.top - layout.rail.top) < 1, '三栏顶部对齐');
    assert(layout.paste.left >= layout.modal.left && layout.rail.right <= layout.modal.right && layout.rail.bottom <= layout.modal.bottom, '三栏都在弹窗里面');
    [layout.num, layout.date].forEach(box => assert(box.top >= layout.head.top && box.bottom <= layout.head.bottom, '订单号和创建日期在标题栏里'));
    assert(layout.overflow <= 1, `新建订单的常用字段一屏放下，中栏不用滚（多出 ${layout.overflow}px）`);
    assert.equal(layout.nav, 0, '订单弹窗没有分步导航');
    assert.deepEqual(layout.submits, ['保存订单'], '只有一个保存按钮');
    await page.waitForFunction(() => document.activeElement?.matches?.('#orderModal button[type="submit"]'));

    // ===== 2. 订单预览跟着表单走 =====
    assert.match(await preview(page), /还没选客户/);
    await field(page, 'client').fill('Mila Lash');
    await field(page, 'client').press('Enter');
    assert.equal(await field(page, 'client').inputValue(), 'Mila Lash Studio');
    assert.match(await preview(page), /Mila Lash Studio[\s\S]*D级黄金客户/);
    assert.match(await page.locator('#orderClientAutofillSummary').innerText(), /1 Sample Road, Springfield/, '客户地址写在客户名称那一行右边');
    await field(page, 'amount').fill('1280');
    await page.evaluate(() => {
      const select = document.getElementById('orderForm').elements.depositPreset;
      select.value = '30';
      select.dispatchEvent(new Event('change', { bubbles:true }));
    });
    assert.equal(await field(page, 'depositAmount').inputValue(), '384');
    assert.match((await preview(page)).replace(/\s+/g, ' '), /\$1,280\.00 定金 30% \$384\.00 已收 \$0\.00 待收 \$1,280\.00/);
    assert.equal(await page.locator('#modalSummary .tag').first().innerText(), '报价', '没收钱：保存后还在报价');
    await field(page, 'paidAmount').fill('384');
    assert.match((await preview(page)).replace(/\s+/g, ' '), /已收 \$384\.00 待收 \$896\.00/);
    assert.equal(await page.locator('#modalSummary .tag').first().innerText(), '生产中', '收到定金：保存后进生产中');
    assert.equal(await page.locator('#orderForm [data-stage-hint]').evaluate(el => el.hidden ? '' : el.textContent), '保存后会按收款自动放到「生产中」');
    assert.equal(await shown(page, '#orderForm [data-stage-hint]'), false, '右栏已经写着保存后进生产中，这一句宽屏不再占一行');
    assert.equal(await shown(page, '#orderForm .deposit-only-field [data-payment-hint]'), false, '定金比例同样只在右栏写一次');
    assert((await page.evaluate(() => { const main = document.querySelector('#orderModal .order-main'); return main.scrollHeight - main.clientHeight; })) <= 1, '填完客户和金额还是一屏');
    // 已付超过订单金额的提醒是红字，照常显示。
    await field(page, 'paidAmount').fill('2000');
    assert.equal(await shown(page, '#orderForm .deposit-payment-amount-field [data-payment-hint].is-warn'), true);
    await field(page, 'paidAmount').fill('384');

    // ===== 3. 订单详情：一行一项，保存、抽屉、操作记录、搜索、CSV =====
    await field(page, 'orderDetail').fill('  C 卷 0.07 × 120 盒  \n\n D 卷 0.05 × 80 盒 ');
    assert.match((await preview(page)).replace(/\s+/g, ' '), /订单详情 2 项/);
    await page.locator('#orderModal [name="sendFeishuNotification"]').uncheck();
    await page.getByRole('button', { name:'保存订单' }).click();
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    await saved(page);
    const created = await page.evaluate(() => { const o = state.orders.find(item => item.client === 'Mila Lash Studio' && item.id !== 'd1'); return { id:o.id, orderDetail:o.orderDetail, stage:o.stage, paidAmount:o.paidAmount }; });
    assert.deepEqual({ orderDetail:created.orderDetail, stage:created.stage, paidAmount:created.paidAmount }, { orderDetail:'C 卷 0.07 × 120 盒\nD 卷 0.05 × 80 盒', stage:'production', paidAmount:384 });
    assert.equal(store.current.data.orders.find(o => o.id === created.id).orderDetail, 'C 卷 0.07 × 120 盒\nD 卷 0.05 × 80 盒', '订单详情写进了保存的数据');

    await page.evaluate(id => openOrderDetail(id), created.id);
    const detailInput = page.locator('#orderDetailBody [data-dedit="orderDetail"]');
    assert.equal(await detailInput.inputValue(), 'C 卷 0.07 × 120 盒\nD 卷 0.05 × 80 盒', '抽屉里能看到、能改订单详情');
    await detailInput.fill('C 卷 0.07 × 120 盒\nD 卷 0.05 × 90 盒\n镊子 × 2');
    await page.locator('#detailSaveBtn').click();
    await page.waitForFunction(id => state.orders.find(o => o.id === id)?.orderDetail.includes('镊子'), created.id);
    await saved(page);
    const edited = await h.order(page, created.id);
    assert.equal(edited.orderDetail, 'C 卷 0.07 × 120 盒\nD 卷 0.05 × 90 盒\n镊子 × 2');
    assert.equal(edited.paidAmount, 384, '抽屉里只改订单详情，收款不动');
    assert(edited.logs.some(log => log.text.includes('订单详情：C 卷 0.07 × 120 盒 / D 卷 0.05 × 80 盒 → C 卷 0.07 × 120 盒 / D 卷 0.05 × 90 盒 / 镊子 × 2')), `改订单详情写进操作记录：${JSON.stringify(edited.logs)}`);
    await page.evaluate(() => closeOrderDetail());

    assert.match(await page.evaluate(id => orderSearchText(state.orders.find(o => o.id === id)), created.id), /镊子 × 2/, '搜索能搜到订单详情里的字');
    const csv = await page.evaluate(() => { let text = ''; window.download = (_name, content) => { text = content; }; exportCsv('all'); return text; });
    assert.match(csv, /"附件数量","订单详情","备注"/);
    assert.match(csv, /"C 卷 0\.07 × 100 盒\nD 卷 0\.05 × 60 盒"/);

    // ===== 4. 编辑已有订单：带出订单详情，分区全部展开，复制 / 删除在右栏 =====
    await page.evaluate(() => openOrder('d1'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    assert.equal(await field(page, 'orderDetail').inputValue(), 'C 卷 0.07 × 100 盒\nD 卷 0.05 × 60 盒');
    assert.equal(await shown(page, '#orderForm [name="note"]'), true, '编辑时备注等分区都展开');
    assert.equal(await shown(page, '#orderForm .order-more-toggle'), false);
    assert.equal(await shown(page, '#orderModal .order-preview #duplicateBtn'), true);
    assert.equal(await shown(page, '#orderModal .order-preview #deleteOrderBtn'), true);
    assert.match((await preview(page)).replace(/\s+/g, ' '), /\$1,000\.00 定金 30% \$300\.00 已收 \$300\.00 待收 \$700\.00 订单详情 2 项 保存后阶段 生产中/);

    // ===== 5. 窗口窄：右栏收成底部按钮条，保存还在；右栏不写的说明回到表单里 =====
    await page.setViewportSize({ width:980, height:800 });
    assert.equal(await shown(page, '#modalSummary'), false, '窄窗口不显示订单预览');
    assert.equal(await shown(page, '#orderModal button[type="submit"]'), true);
    assert.equal(await shown(page, '#orderForm .deposit-only-field [data-payment-hint]'), true, '右栏收起后定金比例回到定金框下面');
    const bar = await page.evaluate(() => {
      const modal = document.querySelector('#orderModal .order-modal').getBoundingClientRect();
      const save = document.querySelector('#orderModal button[type="submit"]').getBoundingClientRect();
      return { inside:save.left >= modal.left && save.right <= modal.right && save.bottom <= modal.bottom && save.top >= modal.top };
    });
    assert.equal(bar.inside, true, '保存按钮在弹窗里面');
    await page.evaluate(() => closeOrder());

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], '不能出现原生 alert / confirm');
    console.log('Order modal layout UI passed: three columns on one screen, live preview, 订单详情 saved / shown in the drawer / logged / searchable / exported, edit mode, narrow window.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
