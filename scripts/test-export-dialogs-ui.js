#!/usr/bin/env node
// 导出弹窗和卡片设置弹窗（真实页面 + 内存里的 /api/data、/api/save，真实鼠标键盘）：
// - 导出：两张卡片切换后按钮的字和下面的区块跟着变；副标题的笔数跟着范围变；列的计数、「只留常用」「全选 / 全不选」；
//   勾掉的列不进 CSV 表头和数据；一列都不选时按钮不能按；选过的列记在本机，下次打开还是那几列，坏值回到全选；
// - 订单列表的「导出」：带「只导出当前筛选的结果」，说明行写当前筛选和笔数，CSV 里只有筛出来的订单；选「备份」时开关置灰；
// - 卡片设置：「已选 n / 7」和全选，全不选也算改动（Esc 先问），底部「保存」存进数据，两个开关照旧存成 redDueAmount / productTint；
//   「按产品给卡片加色条」开着时卡片左边有色条，关掉就没有。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, day, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

(async () => {
  const browser = await launchBrowser();
  try {
    const order = (id, extra = {}) => ({ ...base, id, num:`K${id}`, client:`Client ${id}`, amount:500, paidAmount:100, stage:'production', updated:`${day(2)} 10:00`, ...extra });
    const lastMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
    const orders = [
      order('101', { productType:'假发', note:'=SUM(A1)' }),
      order('102', { productType:'睫毛' }),
      order('103', { productType:'假发', stage:'shipment' }),
      order('104', { productType:'假发', orderMonth:lastMonth, createdAt:`${lastMonth}-05` })
    ];
    const { page, store, errors, dialogs } = await openBoard(browser, { orders, customers:{ 'Client 101':{ client:'Client 101' } } }, { port:freePortSync() });
    // 导出走 download()：在页面里接住文件名和内容，不真的下载。
    await page.evaluate(() => { window.__exports = []; window.download = async (name, text) => { window.__exports.push({ name, text }); return true; }; });
    const lastExport = () => page.evaluate(() => window.__exports[window.__exports.length - 1] || null);
    const csvHeader = text => text.replace(/^\uFEFF/, '').split('\n')[0];
    const modalOpen = id => page.evaluate(id => document.getElementById(id).classList.contains('open'), id);
    const text = selector => page.locator(selector).first().textContent();

    // ---- 1. 设置页「导出…」：表格 / 备份两张卡片 ----
    await page.evaluate(() => { setPage('settings'); uiSettingsTab('data'); });
    await h.click(page, '#openExportBtn', '导出…');
    await page.waitForFunction(() => document.getElementById('exportModal').classList.contains('open'));
    assert.equal(await text('#exportSub'), '4 笔订单 · 全部月份');
    assert.equal(await text('#exportGoBtn'), '导出表格');
    assert.equal(await text('#exportColumnsCount'), '已选 23 / 23');
    assert.equal(await text('#exportColumnsAll'), '全不选');
    assert.equal(await page.locator('#exportFilterRow').isVisible(), false, 'the filter switch is only there when opened from the order list');
    assert.equal(await page.locator('#exportBackupField').isVisible(), false);
    await h.click(page, '#exportModal .pick-option:has(input[value="json"])', '备份');
    assert.equal(await text('#exportGoBtn'), '导出备份');
    assert.equal(await page.locator('#exportColumnsField').isVisible(), false, 'no column picker for a backup');
    assert.equal(await page.locator('#exportBackupField').isVisible(), true);
    assert.equal(await page.locator('#exportBackupMonthNote').isVisible(), false);
    await page.selectOption('#exportMonth', lastMonth);
    assert.match(await text('#exportSub'), /^1 笔订单 · /);
    assert.equal(await page.locator('#exportBackupMonthNote').isVisible(), true, 'a one-month backup says it only merges when imported');
    await page.selectOption('#exportMonth', 'all');
    // 键盘：在卡片上按 ← 回到「表格」。
    await page.locator('#exportModal input[value="json"]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.getElementById('exportGoBtn').textContent === '导出表格');

    // ---- 2. 挑列：只留常用、全不选（按钮不能按）、全选；勾掉的列不进 CSV ----
    await h.click(page, '#exportColumnsCommon', '只留常用');
    assert.equal(await text('#exportColumnsCount'), '已选 12 / 23');
    assert.equal(await text('#exportColumnsAll'), '全选');
    await h.click(page, '#exportColumnsAll', '全选');
    assert.equal(await text('#exportColumnsCount'), '已选 23 / 23');
    await h.click(page, '#exportColumnsAll', '全不选');
    assert.equal(await text('#exportColumnsCount'), '已选 0 / 23');
    assert.equal(await page.locator('#exportGoBtn').isDisabled(), true, 'nothing to export without a column');
    await h.click(page, '#exportColumns .pick-check:has(input[value="num"])', '订单号');
    await h.click(page, '#exportColumns .pick-check:has(input[value="note"])', '备注');
    await h.click(page, '#exportColumns .pick-check:has(input[value="amount"])', '金额');
    assert.equal(await text('#exportColumnsCount'), '已选 3 / 23');
    await h.click(page, '#exportGoBtn', '导出表格');
    await page.waitForFunction(() => !document.getElementById('exportModal').classList.contains('open'));
    let file = await lastExport();
    assert.equal(file.name, 'trade-orders-all.csv');
    // 列按表格里的固定顺序排（不按点的先后），公式防护照旧。
    assert.equal(csvHeader(file.text), '"订单号","金额","备注"');
    assert.match(file.text, /"K101","500","'=SUM\(A1\)"/);
    assert.equal(file.text.trim().split('\n').length, 5);
    // 不传列时还是 23 列（其他调用 exportCsv 的地方不变）。
    const fullHeader = await page.evaluate(async () => { await exportCsv('all'); return window.__exports[window.__exports.length - 1].text; });
    assert.equal(csvHeader(fullHeader).split(',').length, 23);

    // ---- 3. 选过的列记在本机：再打开还是这三列；坏值回到全选 ----
    await h.click(page, '#openExportBtn', '导出…');
    await page.waitForFunction(() => document.getElementById('exportModal').classList.contains('open'));
    assert.equal(await text('#exportColumnsCount'), '已选 3 / 23');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ots-export-columns-v1'))), ['num', 'amount', 'note']);
    await h.click(page, '#exportCancelBtn', '取消');
    await page.waitForFunction(() => !document.getElementById('exportModal').classList.contains('open'));
    await page.evaluate(() => localStorage.setItem('ots-export-columns-v1', '{"bad":1}'));
    await h.click(page, '#openExportBtn', '导出…');
    await page.waitForFunction(() => document.getElementById('exportModal').classList.contains('open'));
    assert.equal(await text('#exportColumnsCount'), '已选 23 / 23', 'an unreadable choice falls back to every column');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('exportModal').classList.contains('open'));

    // ---- 4. 订单列表「导出」：只导出当前筛选的结果 ----
    await page.evaluate(() => setPage('order-list'));
    await page.selectOption('#orderListProductFilter', '假发');
    await page.selectOption('#orderListStageFilter', 'production');
    await h.click(page, '#orderListExportBtn', '导出');
    await page.waitForFunction(() => document.getElementById('exportModal').classList.contains('open'));
    assert.equal(await page.locator('#exportFilterToggle').isChecked(), true);
    assert.equal(await text('#exportSub'), '2 笔订单 · 订单列表当前筛选');
    assert.match(await text('#exportFilterDesc'), /订单列表现在筛的是：.*生产中.*假发.*，2 笔/);
    assert.equal(await page.locator('#exportMonthField').isVisible(), false, 'the month range does not apply to the filtered list');
    await h.click(page, '#exportGoBtn', '导出表格');
    await page.waitForFunction(() => !document.getElementById('exportModal').classList.contains('open'));
    file = await lastExport();
    assert.equal(file.name, 'trade-orders-filtered.csv');
    const nums = file.text.trim().split('\n').slice(1).map(line => line.split(',')[0]).sort();
    assert.deepEqual(nums, ['"K101"', '"K104"']);
    // 选「备份」：开关置灰并说明原因，备份照月份导出全部。
    await h.click(page, '#orderListExportBtn', '导出');
    await page.waitForFunction(() => document.getElementById('exportModal').classList.contains('open'));
    await h.click(page, '#exportModal .pick-option:has(input[value="json"])', '备份');
    assert.equal(await page.locator('#exportFilterToggle').isDisabled(), true);
    assert.match(await text('#exportFilterDesc'), /只能导出成表格/);
    assert.equal(await text('#exportSub'), '4 笔订单 · 全部月份');
    await h.click(page, '#exportGoBtn', '导出备份');
    await page.waitForFunction(() => !document.getElementById('exportModal').classList.contains('open'));
    file = await lastExport();
    assert.equal(file.name, 'trade-orders-backup-all.json');
    assert.equal(JSON.parse(file.text).data.orders.length, 4);
    // 关掉开关：按月份导出。
    await h.click(page, '#orderListExportBtn', '导出');
    await page.waitForFunction(() => document.getElementById('exportModal').classList.contains('open'));
    await h.click(page, '#exportFilterRow', '只导出当前筛选的结果');
    assert.equal(await text('#exportSub'), '4 笔订单 · 全部月份');
    assert.equal(await page.locator('#exportMonthField').isVisible(), true);
    await h.click(page, '#exportCloseBtn', '×');
    await page.waitForFunction(() => !document.getElementById('exportModal').classList.contains('open'));

    // ---- 5. 卡片设置：计数、全选、改动保护、底部保存、两个开关 ----
    await page.evaluate(() => { setPage('dashboard'); document.querySelector('.board-panel')?.scrollIntoView({ block:'start' }); });
    // 色条是 inset 3px 的阴影（卡片本来的阴影里也有一条 1px 的 inset 高光，不算）。
    const stripe = id => page.evaluate(id => getComputedStyle(document.querySelector(`#pipeline .board-card[data-id="${id}"]`)).boxShadow.includes(' 3px 0px 0px 0px inset'), id);
    assert.equal(await stripe('101'), true, 'product colour stripe is shown while 按产品给卡片加色条 is on');
    await h.click(page, '#boardCardSettingsBtn', '卡片设置');
    await page.waitForFunction(() => document.getElementById('boardCardSettingsModal').classList.contains('open'));
    assert.equal(await text('#boardCardShowCount'), '已选 7 / 7');
    assert.equal(await text('#boardCardShowAllBtn'), '全不选');
    assert.deepEqual(await page.locator('#boardCardSettingsFields .pick-check').allTextContents(), ['客户等级图标', '订单号', '下单时间', '产品标签', '付款标签', '加急标签', '金额胶囊']);
    assert.equal(await page.locator('#boardCardSettingsSwitches input[role="switch"]').count(), 2);
    await h.click(page, '#boardCardShowAllBtn', '全不选');
    assert.equal(await text('#boardCardShowCount'), '已选 0 / 7');
    assert.equal(await text('#boardCardShowAllBtn'), '全选');
    // 全不选也是改动：Esc 先问「放弃修改？」，选继续编辑留在弹窗里。
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await h.click(page, '#confirmCancelBtn', '继续编辑');
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await modalOpen('boardCardSettingsModal'), true);
    await h.click(page, '#boardCardShowAllBtn', '全选');
    await h.click(page, '#boardCardSettingsFields .pick-check:has(input[name="showOrderDate"])', '下单时间');
    await h.click(page, '#boardCardSettingsSwitches .pick-switch:has(input[name="productTint"])', '按产品给卡片加色条');
    const savesBefore = store.saves;
    await h.click(page, '#boardCardSettingsSaveBtn', '保存');
    await page.waitForFunction(() => !document.getElementById('boardCardSettingsModal').classList.contains('open'));
    await h.flush(page);
    await page.waitForFunction(() => window.pendingSaveStatus().pending === false);
    assert.ok(store.saves > savesBefore, 'the card settings were saved');
    const saved = store.current.data.boardCardSettings;
    assert.equal(saved.showOrderDate, false);
    assert.equal(saved.productTint, false);
    assert.equal(saved.redDueAmount, true);
    assert.equal(saved.showOrderNumber, true);
    assert.equal(await stripe('101'), false, 'no stripe once 按产品给卡片加色条 is off');
    // 「取消」：没改过就直接关。
    await h.click(page, '#boardCardSettingsBtn', '卡片设置');
    await page.waitForFunction(() => document.getElementById('boardCardSettingsModal').classList.contains('open'));
    assert.equal(await text('#boardCardShowCount'), '已选 6 / 7');
    await h.click(page, '#boardCardSettingsCancelBtn', '取消');
    await page.waitForFunction(() => !document.getElementById('boardCardSettingsModal').classList.contains('open'));

    assert.deepEqual(dialogs, [], 'no native dialogs');
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
    console.log('Export / card settings dialogs UI passed: format cards, column picker + memory, CSV columns, filtered export from the order list, card settings count / select all / guard / save / switches.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
