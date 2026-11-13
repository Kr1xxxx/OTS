#!/usr/bin/env node
// 小字和彩色标签加深一档（外观画布 2 的 1B）：亮色下这些字都不低于 4.5:1。
// 灰底上的说明字（--gray-500）、「待发货」「生产中」标签、白底上的「待收」金额、客户等级标签；
// 「紫字压淡紫底」用 --accent-ink（下拉菜单选中项、六种配色下的客户等级标签），红色淡底的「删除客户」用 --danger-ink；
// 暗色下 --accent-ink 就是 --accent，不变。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, day } = require('./helpers/board-page');
const { contrastHelpers, contrast } = require('./helpers/contrast');

const US = '🇺🇸 美国 United States';
const orders = [
  { ...base, id:'c1', num:'C1001', client:'Contrast Buyer', stage:'production', amount:1200, paidAmount:400, orderType:'定金订单', createdAt:day(2), updated:`${day(2)} 10:00` },
  { ...base, id:'c2', num:'C1002', client:'Contrast Buyer', stage:'balance', amount:800, paidAmount:200, orderType:'定金订单', createdAt:day(3), updated:`${day(3)} 10:00` }
];
const customers = {
  'Contrast Buyer':{ client:'Contrast Buyer', country:US, currency:'USD', level:'A 级' },
  'No Orders Ltd':{ client:'No Orders Ltd', country:US, currency:'USD' }
};
const accents = ['violet', 'blue', 'teal', 'orange', 'rose', 'ink'];

(async () => {
  const browser = await launchBrowser();
  try {
    for (const theme of ['light', 'dark']) {
      const { page, context, errors } = await openBoard(browser, { orders, customers }, { width:1694, height:1082, theme, port:47997 });
      await page.evaluate(contrastHelpers);
      const checks = [];
      // 看板列的灰底（--surface-soft）上的副标题是 --gray-500。
      checks.push(['看板列副标题（灰底上的 --gray-500）', await contrast(page, '#pipeline .board-column[data-stage="quote"] .board-column-sub')]);
      await page.evaluate(() => setPage('order-list'));
      await page.waitForSelector('#orderTableBody .order-table-due-line');
      checks.push(['「待发货」标签', await contrast(page, '#orderTableBody .tag-orange')]);
      checks.push(['「生产中」标签', await contrast(page, '#orderTableBody .tag-cyan')]);
      checks.push(['白底上的「待收」金额', await contrast(page, '#orderTableBody .order-table-due-line')]);
      // 下拉菜单里选中的那项：强调色淡底上的字。
      await page.evaluate(() => openAppSelectMenu(document.getElementById('orderListPaymentStateFilter')));
      await page.waitForSelector('.app-select-option.selected');
      checks.push(['下拉菜单选中项', await contrast(page, '.app-select-option.selected')]);
      await page.keyboard.press('Escape');
      await page.evaluate(() => setPage('customers'));
      await page.waitForSelector('.customer-level-pill');
      for (const accent of accents) {
        await page.evaluate(accent => uiApplyAccent(accent), accent);
        checks.push([`客户等级标签（${accent}）`, await contrast(page, '.customer-level-pill')]);
      }
      // 客户档案的「删除客户」：红色淡底上的字（--danger-ink）。
      await page.evaluate(() => openCustomerModal('No Orders Ltd'));
      await page.waitForFunction(() => getComputedStyle(document.getElementById('customerDeleteBtn')).display !== 'none');
      checks.push(['「删除客户」按钮', await contrast(page, '#customerDeleteBtn')]);
      await page.keyboard.press('Escape');
      for (const [label, { ratio }] of checks) assert(ratio >= 4.5, `${theme}: ${label} 只有 ${ratio}:1`);
      await page.evaluate(() => uiApplyAccent('violet'));
      const ink = await page.evaluate(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const read = name => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
        const result = { ink:read('--accent-ink'), accent:read('--accent') };
        probe.remove();
        return result;
      });
      if (theme === 'dark') assert.equal(ink.ink, ink.accent, '暗色下 --accent-ink 就是 --accent');
      else assert.notEqual(ink.ink, ink.accent, '亮色下 --accent-ink 比 --accent 深');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Darker text passed: gray captions on gray, the 待发货 / 生产中 tags, the due amount, the selected menu item, the delete-customer button and the customer level pill (all six accents) reach 4.5:1 in light; dark keeps --accent-ink = --accent.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
