#!/usr/bin/env node
// 设置 → 客户标签 / 客户等级的 ×：
// - 删掉的内置标签，保存、重新加载后不再补回来；全部删光后重新加载回到默认的几个；
// - 内置等级删不掉（自动分级要用这几个名字），提示说实话，不再说「已移除」；自己加的等级照常能删。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h } = require('./helpers/board-page');

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs } = await openBoard(browser, { orders:[], customerLevels:['Z级自定义'] });
    const read = () => page.evaluate(() => ({ tags:[...state.customerTags], levels:[...state.customerLevels], defaults:[...defaultCustomerTags] }));
    const openCustomerSettings = async () => {
      await page.evaluate(() => setPage('settings'));
      await h.click(page, '.settings-menu-item[data-settings-tab="customer"]', 'settings tab customer');
    };
    const remove = async (type, value) => {
      const btn = page.locator(`.settings-chip button[data-settings-remove="${type}"][data-value="${value}"]`);
      await btn.waitFor();
      await h.click(page, btn, `remove ${value}`);
    };
    const saved = async () => {
      assert.equal(await page.evaluate(() => flushPendingSave()), true, 'the save goes through');
    };
    const reload = async () => {
      await page.reload();
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    };

    const { defaults } = await read();
    assert.ok(defaults.includes('月结'));
    await openCustomerSettings();

    // ---- 删一个内置标签：重新加载后还是没有 ----
    await remove('customerTags', '月结');
    await h.waitToast(page, '已移除');
    assert.equal((await read()).tags.includes('月结'), false);
    await saved();
    assert.equal(store.current.data.customerTags.includes('月结'), false, 'the removed tag is not saved');
    await reload();
    assert.deepEqual((await read()).tags, defaults.filter(tag => tag !== '月结'), 'a removed built-in tag stays removed after a reload');

    // ---- 全部删光：重新加载回到默认 ----
    await page.evaluate(() => { state.customerTags = []; render(); });
    await saved();
    await reload();
    assert.deepEqual((await read()).tags, defaults, 'an empty tag list falls back to the defaults');

    // ---- 内置等级删不掉，提示说实话；自己加的等级照常删 ----
    await openCustomerSettings();
    const levelsBefore = (await read()).levels;
    await remove('customerLevels', 'F级青铜客户');
    await h.waitToast(page, '内置等级不能删除');
    assert.deepEqual((await read()).levels, levelsBefore, 'a built-in level is not removed');
    await remove('customerLevels', 'Z级自定义');
    await h.waitToast(page, '已移除');
    assert.equal((await read()).levels.includes('Z级自定义'), false, 'a custom level is removed');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('Settings built-in remove UI passed: removed built-in tag stays removed after reload, empty list falls back to defaults, built-in level not removable with an honest toast, custom level removable.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
