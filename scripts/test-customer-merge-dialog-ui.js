#!/usr/bin/env node
// 合并客户的对照弹窗（真实页面、假的本地服务，浅色和深色）：
// - 两张卡片并排，保留的在左；对调后卡片、按钮、说明一起换，真正合并的方向和最后看到的一致（保留的是对调后的那位）；
// - 两边没有冲突时写「两边没有冲突的资料」，不出空的清单；
// - 取消、×、Esc、点背景都不改数据；搜客户时打字对上就选中，离开搜索框不改写大小写；
// - 合并后 6 秒内能撤销，撤销后两份档案、订单原样回来；
// - 窄窗口两张卡片上下排；底部左边写备份和撤销那句。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

(async () => {
  const browser = await launchBrowser();
  try {
    for (const theme of ['light', 'dark']) {
      const customers = {
        'Nova Wigs': { client:'Nova Wigs', country:'🇬🇧 英国 United Kingdom', contact:'Ann Lee', email:'ann@nova.example' },
        'Nova Wig Shop': { client:'Nova Wig Shop', email:'shop@nova.example' }
      };
      const orders = [
        { ...base, id:'n1', num:'K7001', client:'Nova Wigs', amount:500, stage:'quote' },
        { ...base, id:'n2', num:'K7002', client:'Nova Wigs', amount:600, stage:'quote' },
        { ...base, id:'n3', num:'K7003', client:'Nova Wig Shop', amount:700, stage:'quote' }
      ];
      const { page, context, errors, dialogs } = await openBoard(browser, { orders, customers }, { port:freePortSync(), theme, width:1100, height:820 });
      const snapshot = () => page.evaluate(() => JSON.stringify({ customers:state.customers, clients:state.orders.map(o => [o.id, o.client]) }));
      const isOpen = () => page.evaluate(() => document.getElementById('customerMergeModal').classList.contains('open'));
      const view = () => page.evaluate(() => {
        const shown = id => document.getElementById(id).getClientRects().length > 0;
        const box = id => document.getElementById(id).getBoundingClientRect();
        return {
          keep:document.querySelector('#customerMergeKeep b').textContent,
          keepMeta:document.querySelector('#customerMergeKeep span').textContent,
          drop:document.querySelector('#customerMergeDrop b').textContent,
          go:document.getElementById('customerMergeGoBtn').textContent,
          fine:document.getElementById('customerMergeFine').textContent,
          rowsShown:shown('customerMergeConflicts'),
          noConflicts:shown('customerMergeNoConflicts') ? document.getElementById('customerMergeNoConflicts').textContent : '',
          note:document.getElementById('customerMergeFootInfo').textContent,
          keepBox:box('customerMergeKeep'), dropBox:box('customerMergeDrop'),
          focus:document.activeElement?.id || ''
        };
      });
      const open = () => page.evaluate(() => { window.__merge = mergeDuplicateCustomers('Nova Wigs', 'Nova Wig Shop'); });
      const waitOpen = async () => {
        await page.waitForFunction(() => document.getElementById('customerMergeModal').classList.contains('open'));
        await h.settle(page, '#customerMergeModal .modal');
      };
      const before = await snapshot();

      // ---- 1. 两张卡片并排、没有冲突、底部那句；默认焦点在「取消」 ----
      await open();
      await waitOpen();
      await page.waitForFunction(() => document.activeElement?.id === 'customerMergeCancelBtn');
      let v = await view();
      assert.deepEqual([v.keep, v.drop, v.go], ['Nova Wigs', 'Nova Wig Shop', '合并到 Nova Wigs']);
      assert.match(v.keepMeta, /^2 单 · 🇬🇧 英国 United Kingdom · Ann Lee$/);
      assert.equal(v.rowsShown, false, 'no empty conflict list');
      assert.equal(v.noConflicts, '两边没有冲突的资料。');
      assert.equal(v.note, '合并前自动备份，6 秒内可以撤销');
      assert.ok(v.keepBox.right <= v.dropBox.left && Math.abs(v.keepBox.top - v.dropBox.top) < 1, 'the two cards sit side by side, the kept one on the left');

      // ---- 2. 取消、×、Esc、点背景都不改数据 ----
      await page.click('#customerMergeCancelBtn');
      await page.waitForFunction(() => !document.getElementById('customerMergeModal').classList.contains('open'));
      for (const close of [
        () => page.click('#customerMergeCloseBtn'),
        () => page.keyboard.press('Escape'),
        () => page.mouse.click(8, 8)
      ]) {
        await open();
        await waitOpen();
        await close();
        await page.waitForFunction(() => !document.getElementById('customerMergeModal').classList.contains('open'));
        assert.equal(await page.evaluate(() => window.__merge.then(() => 'done')), 'done');
      }
      assert.equal(await snapshot(), before, 'closing the dialog changes nothing');

      // ---- 3. 对调：卡片、按钮、说明一起换；合并的方向就是对调后的 ----
      await open();
      await waitOpen();
      await page.click('#customerMergeSwapBtn');
      v = await view();
      assert.deepEqual([v.keep, v.drop, v.go], ['Nova Wig Shop', 'Nova Wigs', '合并到 Nova Wig Shop']);
      assert.match(v.fine, /^Nova Wigs 的订单（含垃圾箱和已删除订单）.*会归到 Nova Wig Shop。$/);
      await page.click('#customerMergeGoBtn');
      await h.waitToast(page, '已合并到 Nova Wig Shop');
      assert.equal(await isOpen(), false);
      const merged = await page.evaluate(() => ({ names:Object.keys(state.customers).sort(), clients:[...new Set(state.orders.map(o => o.client))], country:state.customers['Nova Wig Shop'].country }));
      assert.deepEqual(merged.names, ['Nova Wig Shop'], 'the swapped-in customer is the one kept');
      assert.deepEqual(merged.clients, ['Nova Wig Shop'], 'every order went to the kept customer');
      assert.equal(merged.country, '🇬🇧 英国 United Kingdom', 'fields only the other side had are carried over');

      // ---- 4. 撤销照旧 ----
      await h.clickUndo(page, '已合并到 Nova Wig Shop');
      await h.waitToast(page, '已撤销合并');
      const undone = JSON.parse(await snapshot());
      const original = JSON.parse(before);
      assert.deepEqual(Object.keys(undone.customers).sort(), Object.keys(original.customers).sort());
      assert.deepEqual(undone.clients, original.clients, 'orders are back with their customers');

      // ---- 5. 搜客户：打字对上的名字就选中；离开搜索框不把「lena hair」改写成另一位「Lena Hair」 ----
      await page.evaluate(() => {
        state.customers['lena hair'] = { client:'lena hair', country:'🇺🇸 美国 United States' };
        state.customers['Lena Hair'] = { client:'Lena Hair', country:'🇨🇦 加拿大 Canada' };
        window.__merge = mergeCustomerInto('Nova Wig Shop');
      });
      await waitOpen();
      assert.equal(await page.locator('#customerMergeGoBtn').isDisabled(), true);
      await page.click('#customerMergeInput');
      await page.keyboard.type('lena hair');
      await page.waitForFunction(() => document.querySelector('#customerMergeKeep b').textContent === 'lena hair' && !document.getElementById('customerMergeGoBtn').disabled);
      await page.keyboard.press('Escape');
      await page.click('#customerMergeFine');
      await page.waitForFunction(() => document.activeElement?.id !== 'customerMergeInput');
      v = await view();
      assert.equal(await page.locator('#customerMergeInput').inputValue(), 'lena hair', 'the search box is not capitalized on blur');
      assert.deepEqual([v.keep, v.drop], ['lena hair', 'Nova Wig Shop']);
      await page.click('#customerMergeCancelBtn');
      await page.waitForFunction(() => !document.getElementById('customerMergeModal').classList.contains('open'));
      await page.evaluate(() => { delete state.customers['lena hair']; delete state.customers['Lena Hair']; });

      // ---- 6. 窄窗口：两张卡片上下排 ----
      await page.setViewportSize({ width:480, height:820 });
      await open();
      await waitOpen();
      v = await view();
      assert.ok(v.dropBox.top >= v.keepBox.bottom, 'narrow window: the cards stack');
      assert.ok(v.keepBox.right <= 480 && v.dropBox.right <= 480, 'nothing runs off the screen');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('customerMergeModal').classList.contains('open'));

      assert.deepEqual(dialogs, [], 'no native dialogs');
      assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
      await context.close();
    }
    console.log('Customer merge dialog UI passed: side-by-side cards, no-conflict note, cancel / × / Esc / backdrop change nothing, swap decides the kept customer, undo, stacked cards on a narrow window.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
