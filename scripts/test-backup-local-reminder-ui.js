#!/usr/bin/env node
// 备份目录还是默认目录（备份和数据库在同一块硬盘上）时提醒一句：
// - 设置 → 数据管理，备份信息那一行末尾一句提醒；左下角保存状态的悬停提示带「（只在这台电脑上）」；
// - 通知面板一张常驻卡「备份只在这台电脑上」，算一条未读；点它去设置的数据页签、标成已读，卡还在；
// - 选了备份目录：两处都没有（不用刷新）；「恢复默认目录」：两处回来，已读的不再算未读；刷新后照旧；
// - 服务端没说 isDefault（测试桩的 /api/health 只回 sqliteCount）：两处都没有，不报错。
// 真实 mac-app/server.js（临时数据目录）；「选择备份目录…」的系统选择框换成直接改服务端设置。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, openBoard, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-backup-local-'));
  const altDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-backup-alt-'));
  const chosen = path.join(altDir, 'iCloud', 'OTS 备份');
  fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:1, data:{ orders:[], customers:{}, trashOrders:[], deletedOrders:[], doneTasks:{}, demoCleared:true, demoCustomersCleared:true } }));
  const port = freePortSync();
  const token = `backup-local-${process.pid}`;
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', DHL_API_KEY:'', FEDEX_CLIENT_ID:'', FEDEX_CLIENT_SECRET:'' };
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${url}/api/health`)).ok; } catch (_) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'server starts');

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, locale:'zh-CN' });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    await context.route('**/api/ecb-rates**', route => route.fulfill({ json:{ ok:true, rates:[] } }));
    // 系统的「选择文件夹」框在测试里打不开：直接把服务端的备份目录改到 chosen，回服务端的原话。
    await context.route('**/api/choose-backup-folder', async route => {
      const res = await fetch(`${url}/api/backup-settings`, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Trade-Token':token }, body:JSON.stringify({ backupDir:chosen }) });
      return route.fulfill({ status:res.status, json:await res.json() });
    });
    const errors = [];
    const dialogs = [];
    const open = async () => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
      await page.goto(`${url}/trade-order-system.html?token=${token}`);
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
      await page.waitForFunction(() => macBackupSummary);
      return page;
    };
    let page = await open();
    const look = () => page.evaluate(() => {
      const badge = document.getElementById('notifBadge');
      const card = uiNotifItems().find(item => item.id === 'backup-local');
      return {
        hint:document.querySelector('#macBackupInfo .backup-local-hint')?.textContent || '',
        pulse:document.getElementById('savePulse').title,
        card:card ? card.title : '',
        badge:badge.hidden ? '' : badge.textContent
      };
    });
    const openSettingsData = () => page.evaluate(() => { setPage('settings'); uiSettingsTab('data'); });

    // 默认目录：两处都有，算一条未读。
    let now = await look();
    assert.match(now.hint, /只在这台电脑上.*选择备份目录/, 'settings line says backups are only on this Mac');
    assert.match(now.pulse, /（只在这台电脑上）$/, 'save dot tooltip says so too');
    assert.equal(now.card, '备份只在这台电脑上', 'notification card is there');
    assert.equal(now.badge, '1', 'it counts as one unread');
    // 提醒句用提醒色（琥珀），不是正文灰。
    await openSettingsData();
    const colors = await page.evaluate(() => {
      const hint = document.querySelector('#macBackupInfo .backup-local-hint');
      const plain = document.querySelector('#macBackupInfo > span');
      return { hint:getComputedStyle(hint).color, plain:getComputedStyle(plain).color, shown:hint.getClientRects().length > 0 };
    });
    assert.ok(colors.shown, 'the hint is visible on the data tab');
    assert.notEqual(colors.hint, colors.plain, 'the hint is in the warning colour');

    // 点卡片：去设置的数据页签，标成已读，卡还在。
    await page.evaluate(() => setPage('dashboard'));
    await h.click(page, '#notifBtn', 'bell');
    await page.waitForFunction(() => !document.getElementById('notifPanel').hidden);
    await page.waitForSelector('#notifList [data-notif-id="backup-local"]');
    await h.click(page, '#notifList [data-notif-id="backup-local"]', 'backup card');
    await page.waitForFunction(() => document.getElementById('notifPanel').hidden);
    const where = await page.evaluate(() => ({
      page:document.querySelector('.page.active')?.id || document.querySelector('.nav-item.active')?.dataset.page,
      tab:document.querySelector('[data-settings-panel].active')?.dataset.settingsPanel,
      inView:(() => { const r = document.getElementById('macBackupInfo').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()
    }));
    assert.match(String(where.page), /settings/, 'card opens the settings page');
    assert.equal(where.tab, 'data', 'on the data tab');
    assert.ok(where.inView, 'backup line is scrolled into view');
    now = await look();
    assert.equal(now.badge, '', 'read after clicking');
    assert.equal(now.card, '备份只在这台电脑上', 'card stays after it was read');

    // 选了备份目录：两处都没有，不用刷新。
    await h.click(page, '#macChooseBackupDirBtn', 'choose backup dir');
    await page.waitForFunction(() => macBackupSummary?.isDefault === false);
    now = await look();
    assert.equal(now.hint, '', 'no hint once a folder is chosen');
    assert.doesNotMatch(now.pulse, /只在这台电脑上/, 'no tooltip half-sentence once a folder is chosen');
    assert.equal(now.card, '', 'no card once a folder is chosen');
    assert.ok(await page.evaluate(() => !document.getElementById('macResetBackupDirBtn').hidden), 'reset button shows');
    // 选过目录以后刷新：照样没有。
    await page.close();
    page = await open();
    now = await look();
    assert.deepEqual([now.hint, now.card, now.badge], ['', '', ''], 'nothing after reload with a chosen folder');

    // 恢复默认目录：两处回来；已经看过的不再算未读。
    await openSettingsData();
    await h.click(page, '#macResetBackupDirBtn', 'reset backup dir');
    await page.waitForFunction(() => macBackupSummary?.isDefault === true);
    now = await look();
    assert.match(now.hint, /只在这台电脑上/, 'hint is back after resetting to the default folder');
    assert.equal(now.card, '备份只在这台电脑上', 'card is back');
    assert.equal(now.badge, '', 'already read, stays read');

    // 已读记录要留住：备份信息还没读到时存一次已读集合，也不能把它丢掉（不然下次又变未读）。
    const kept = await page.evaluate(() => {
      const saved = macBackupSummary;
      macBackupSummary = null;
      uiNotifMarkRead(['something-else']);
      macBackupSummary = saved;
      return uiNotifRead().has('backup-local');
    });
    assert.ok(kept, 'read mark of the backup card survives a save while backup info is unknown');
    assert.deepEqual(errors, [], 'no page errors in app mode');
    assert.deepEqual(dialogs, [], 'no native dialogs');
    await page.close();
    await context.close();

    // 服务端没说 isDefault（测试桩的 /api/health 只回 sqliteCount）：两处都没有。
    const board = await openBoard(browser, { orders:[] }, { port:freePortSync() });
    const stub = await board.page.evaluate(() => ({
      hint:document.querySelector('#macBackupInfo .backup-local-hint')?.textContent || '',
      card:uiNotifItems().some(item => item.id === 'backup-local'),
      pulse:document.getElementById('savePulse').title
    }));
    assert.deepEqual([stub.hint, stub.card], ['', false], 'nothing without isDefault from the server');
    assert.doesNotMatch(stub.pulse, /只在这台电脑上/, 'no tooltip half-sentence without isDefault');
    assert.deepEqual(board.errors, [], 'no page errors without backup info');
    await board.context.close();

    console.log('Backup-only-on-this-Mac reminder test passed');
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    for (const dir of [dataDir, altDir]) { try { fs.rmSync(dir, { recursive:true, force:true }); } catch (_) {} }
  }
})().catch(error => {
  console.error(`Backup-only-on-this-Mac reminder test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
