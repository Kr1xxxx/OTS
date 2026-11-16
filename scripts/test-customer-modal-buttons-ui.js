#!/usr/bin/env node
// 客户弹窗和「一起确认客户和订单」的按钮（弹窗第二轮第 4 处）：
// - 编辑时头部只剩「＋ 新建订单」和关闭，保存只在右下角，整个弹窗只有它一个实心紫色按钮；
// - 粘贴区和订单弹窗同名、同顺序：清空 · AI 识别 · 识别，「识别」和订单弹窗的一样是淡紫色；
// - 底部「取消」：编辑已有客户时回到只读（改了没保存先问），新建客户时关掉弹窗；
// - 只读时头部是「＋ 新建订单」「编辑资料」「⋯」，「删除客户」不再常驻（「⋯」菜单本身见 test-customer-merge-delete-ui.js）；
// - 「一起确认客户和订单」：头部只有标题和关闭，「取消」「保存客户和订单」在底部按钮栏，窗口矮时按钮栏也看得见。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, day, h } = require('./helpers/board-page');

const US = '🇺🇸 美国 United States';
const orders = [
  { ...base, id:'b1', num:'B1001', client:'Button Buyer', stage:'production', amount:1200, paidAmount:400, orderType:'定金订单', createdAt:day(2), updated:`${day(2)} 10:00` }
];
const customers = {
  'Button Buyer':{ client:'Button Buyer', country:US, currency:'USD', emails:['buyer@example.com'], email:'buyer@example.com' },
  'Second Buyer':{ client:'Second Buyer', country:US, currency:'USD' }
};

// 弹窗里看得见的按钮（文字或 aria-label），按页面顺序。
const visibleButtons = (page, selector) => page.evaluate(selector => [...document.querySelectorAll(`${selector} button`)]
  .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
  .map(el => el.textContent.trim() || el.getAttribute('aria-label')), selector);
const paint = (page, selector) => page.locator(selector).first().evaluate(el => {
  const s = getComputedStyle(el);
  return { background:s.backgroundColor, color:s.color, border:s.borderTopColor, weight:s.fontWeight };
});

(async () => {
  const browser = await launchBrowser();
  try {
    for (const theme of ['light', 'dark']) {
      const { page, errors } = await openBoard(browser, { orders, customers }, { width:1440, height:920, theme, port:47984 });
      const modalOpen = () => page.evaluate(() => document.getElementById('customerModal').classList.contains('open'));
      const mode = () => page.evaluate(() => document.getElementById('customerForm').classList.contains('customer-view-mode') ? 'view' : 'edit');
      const settleModal = async () => { await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open')); await h.settle(page, '#customerModal .modal'); };

      // ---- 只读：「＋ 新建订单」「编辑资料」「⋯」和关闭，没有常驻的「删除客户」，底部按钮栏不显示 ----
      await page.evaluate(() => openCustomerModal('Button Buyer'));
      await settleModal();
      assert.deepEqual(await visibleButtons(page, '#customerModal .modal-head-actions'), ['＋ 新建订单', '编辑资料', '更多操作', '关闭'], `${theme}: 只读头部`);
      assert.equal(await page.locator('#customerModal .modal-head-actions .btn-danger').count(), 0, '头部没有红色按钮');
      assert.equal(await page.locator('#customerModal .customer-modal-foot').isVisible(), false, '只读时没有底部按钮栏');
      assert.equal(await page.locator('#customerMoreBtn').getAttribute('aria-haspopup'), 'menu');

      // ---- 编辑：头部只剩「＋ 新建订单」和关闭；只有一个实心紫色按钮（右下角「保存客户」） ----
      await h.click(page, '#customerDetailEditBtn');
      await page.waitForFunction(() => document.getElementById('customerForm').classList.contains('customer-edit-mode'));
      assert.deepEqual(await visibleButtons(page, '#customerModal .modal-head-actions'), ['＋ 新建订单', '关闭'], `${theme}: 编辑头部`);
      assert.deepEqual(await visibleButtons(page, '#customerModal .customer-modal-foot'), ['取消', '保存客户'], `${theme}: 编辑底部`);
      assert.deepEqual(await visibleButtons(page, '#customerEditWorkspace .paste-assist-actions'), ['清空', 'AI 识别', '识别'], '粘贴区和订单弹窗同名、同顺序');
      const save = await paint(page, '#customerFooterSaveBtn');
      // 看得见的主按钮只有「识别」和「保存客户」，「识别」画成淡紫色（下面和订单弹窗的比），实心的只有「保存客户」。
      const primaries = await page.evaluate(() => [...document.querySelectorAll('#customerModal .btn-primary')]
        .filter(el => el.getClientRects().length).map(el => el.id));
      assert.deepEqual(primaries, ['customerPasteAiBtn', 'customerFooterSaveBtn'], `${theme}: 编辑时看得见的主按钮`);
      const customerRecognize = await paint(page, '#customerPasteAiBtn');
      const customerAi = await paint(page, '#customerPasteAnalyzeBtn');
      assert.notEqual(customerRecognize.background, save.background, '「识别」不是实心紫色');
      assert.notEqual(customerRecognize.color, save.color, '「识别」是紫字，不是实心按钮的白字');

      // ---- 底部「取消」：没改动直接回到只读；改了先问，选「继续编辑」留在编辑，选「放弃修改」回到只读、改动撤回 ----
      await h.click(page, '#customerFooterCancelBtn');
      await page.waitForFunction(() => document.getElementById('customerForm').classList.contains('customer-view-mode'));
      assert.equal(await modalOpen(), true, '取消编辑不关弹窗');
      await h.click(page, '#customerDetailEditBtn');
      await page.waitForFunction(() => document.getElementById('customerForm').classList.contains('customer-edit-mode'));
      await page.locator('#customerForm [name="note"]').fill('这次改了没保存');
      await h.click(page, '#customerFooterCancelBtn');
      await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      assert.equal(await page.locator('#confirmTitle').textContent(), '放弃未保存的修改？');
      await page.waitForFunction(() => document.activeElement?.id === 'confirmCancelBtn');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
      assert.equal(await mode(), 'edit', '继续编辑');
      assert.equal(await page.locator('#customerForm [name="note"]').inputValue(), '这次改了没保存');
      await h.click(page, '#customerFooterCancelBtn');
      await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      await h.settle(page, '#confirmModal .modal');
      await h.click(page, '#confirmOkBtn');
      await page.waitForFunction(() => document.getElementById('customerForm').classList.contains('customer-view-mode'));
      assert.equal(await modalOpen(), true);
      assert.equal(await page.evaluate(() => state.customers['Button Buyer'].note || ''), '', '放弃的改动没进档案');

      // ---- 保存在右下角：⌘S 和点「保存客户」一样，忙碌态显示在这个按钮上（test-save-conflicts-v3135 看保存中…） ----
      await h.click(page, '#customerDetailEditBtn');
      await page.waitForFunction(() => document.getElementById('customerForm').classList.contains('customer-edit-mode'));
      await page.locator('#customerForm [name="note"]').fill('右下角保存');
      await h.click(page, '#customerFooterSaveBtn');
      await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
      assert.equal(await page.evaluate(() => state.customers['Button Buyer'].note), '右下角保存');

      // ---- 新建客户：底部「取消」关掉弹窗 ----
      await page.evaluate(() => openCustomerModal(''));
      await settleModal();
      assert.deepEqual(await visibleButtons(page, '#customerModal .modal-head-actions'), ['关闭'], '新建客户时头部只有关闭');
      await h.click(page, '#customerFooterCancelBtn');
      await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));

      // ---- 订单弹窗的「识别」：和客户弹窗的同一个样子（淡紫底、紫字），「AI 识别」也一样 ----
      await page.evaluate(() => openOrder(''));
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
      await h.settle(page, '#orderModal .modal');
      assert.deepEqual(await paint(page, '#pasteAssistAnalyzeBtn'), customerRecognize, `${theme}: 两个弹窗的「识别」样子一样`);
      assert.deepEqual(await paint(page, '#pasteAssistAiBtn'), customerAi, `${theme}: 两个弹窗的「AI 识别」样子一样`);
      await page.evaluate(() => closeOrder());
      await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));

      // ---- 一起确认客户和订单：保存在底部，窗口矮也看得见；「取消」没改动直接关 ----
      await page.setViewportSize({ width:1280, height:640 });
      await page.evaluate(country => openCombinedCustomerOrderModal({ customerFields:{ name:'Harbor Hair Ltd', country }, orderFields:{ amount:1200, currency:'USD', productType:'假发' } }), US);
      await page.waitForFunction(() => document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
      await h.settle(page, '#combinedCustomerOrderModal .modal');
      assert.deepEqual(await visibleButtons(page, '#combinedCustomerOrderModal .modal-head'), ['关闭'], '头部只有关闭');
      assert.deepEqual(await visibleButtons(page, '#combinedCustomerOrderModal .combined-modal-foot'), ['取消', '保存客户和订单']);
      assert.match(await page.locator('#combinedCustomerOrderModal .combined-modal-foot').innerText(), /左边客户、右边订单，一次保存/);
      const fit = await page.evaluate(() => {
        const modal = document.querySelector('#combinedCustomerOrderModal .modal').getBoundingClientRect();
        const btn = document.getElementById('combinedSaveBtn').getBoundingClientRect();
        return { inModal:btn.bottom <= modal.bottom + 0.5, inWindow:btn.bottom <= innerHeight };
      });
      assert.deepEqual(fit, { inModal:true, inWindow:true }, '窗口矮时底部按钮栏仍在弹窗里看得见');
      await h.click(page, '#combinedCancelBtn');
      await page.waitForFunction(() => !document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
      await page.setViewportSize({ width:1440, height:920 });

      assert.deepEqual(errors, [], `${theme}: no page errors`);
      await page.context().close();
    }
    console.log('customer modal buttons UI test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
