#!/usr/bin/env node
// 导入、恢复示例、从备份恢复（审查报告 25 P1-1 / P1-2 / P1-4 / P1-5 / P1-6，15 P2-3）：真实 mac-app/server.js（临时数据目录）+ 真实鼠标键盘。
// - 单月「导出备份」再导入：只合并，其他月份的订单一张不少；导入前强制生成「导入前」备份；
// - 整份文件导入：预览列出新增 / 修改 / 删除，默认焦点在「合并导入（不删除）」；要删除数据还得输入「替换」；
//   金额「1,200」「$500」转成数字后存进数据库，不进 500 重试循环；被删的 0 单客户的 WhatsApp 聊天不会挂到新客户名下；6 秒内可撤销；
// - 导入写库失败：页面回到导入前，不重试；
// - 恢复示例只换订单相关的数据，客户档案和设置保留，执行前有「恢复示例前」备份；
// - 设置 →「从备份恢复…」：列出备份，预览对比，恢复后重新加载，提示里有「撤销恢复」；
// - 读库失败（身份标记不符）时导出被拦下，不会导出一份空「备份」；只读保护下照样能从备份恢复。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const token = 'import-restore-ui-test-token';
const base = { currency:'USD', country:'🇺🇸 美国 United States', stage:'production', orderType:'定金订单', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30, logs:[], attachments:[], shipments:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', logisticsStatus:'未发货', updated:'2026-11-01 09:00' };
const order = (id, num, client, month) => ({ ...base, id, num, client, orderMonth:month, createdAt:`${month}-05` });
const fixture = {
  orders:[
    order('u1', 'K26110101', 'Alice Baker', '2026-11'),
    order('u2', 'K26100101', 'Bob Lee', '2026-10'),
    order('u3', 'K26090101', 'Bob Lee', '2026-09'),
    order('u4', 'K26080101', 'Cara Diaz', '2026-08')
  ],
  trashOrders:[], deletedOrders:[],
  customers:{
    'Alice Baker':{ client:'Alice Baker', note:'VIP 永久备注' },
    'Bob Lee':{ client:'Bob Lee' },
    'Cara Diaz':{ client:'Cara Diaz' },
    'Zero Lead':{ client:'Zero Lead', note:'还没下单的潜在客户' }
  },
  performanceTargets:{ '2026-11':20000 },
  paymentMethods:['Paypal', 'TT', '自定义收款A'],
  customerTags:['老客户自定义标签'],
  doneTasks:{}, demoCleared:true, demoCustomersCleared:true
};

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-import-restore-'));
  const exportDir = path.join(dataDir, '__downloads');
  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(exportDir, { recursive:true });
  fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:1, data:fixture }));
  const port = freePortSync();
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', TRADE_EXPORT_DIR:exportDir, TRADE_EXPORT_NO_REVEAL:'1', DHL_API_KEY:'', FEDEX_CLIENT_ID:'', FEDEX_CLIENT_SECRET:'' };
  const url = `http://127.0.0.1:${port}`;
  let server = null;
  const startServer = async () => {
    server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
    for (let i = 0; i < 200; i++) {
      try { const res = await fetch(`${url}/api/health`); if (res.status === 200 || res.status === 500) return; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('server did not start');
  };
  const stopServer = async () => {
    if (!server || server.exitCode !== null) return;
    await new Promise(resolve => { const timer = setTimeout(resolve, 5000); server.once('exit', () => { clearTimeout(timer); resolve(); }); server.kill('SIGTERM'); });
  };
  let browser;
  try {
    await startServer();
    const api = async (route, body) => (await fetch(url + route, { method:body ? 'POST' : 'GET', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) })).json();
    const db = async () => (await api('/api/data')).data;
    const native = (action, payload = {}) => {
      const bytes = Buffer.from(JSON.stringify({ action, payload }));
      const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
      const result = spawnSync(process.execPath, [path.join(root, 'mac-app/whatsapp-native-host.js')], { env, input:Buffer.concat([length, bytes]), timeout:10000 });
      return JSON.parse(result.stdout.subarray(4));
    };
    const chatCount = async name => (await api(`/api/whatsapp/messages?customer=${encodeURIComponent(name)}`)).total;
    const backups = reason => { try { return fs.readdirSync(backupsDir).filter(name => (reason ? name.includes(`-before-${reason}`) : true) && name.endsWith('.sqlite')).sort(); } catch (_) { return []; } };
    // 0 单的潜在客户有一段 WhatsApp 聊天。
    const leadChat = { account:'15550001111@c.us', chatId:'13055550199@c.us', customer:'Zero Lead', title:'Zero Lead' };
    assert.equal(native('bind', leadChat).ok, true);
    assert.equal(native('sync', { ...leadChat, messages:[{ id:'z1', direction:'in', kind:'text', timestamp:'[10:20, 01/11/2026]', text:'私人报价别外传' }] }).inserted, 1);
    // 一小时一次的自动备份刚做过：之后的「导入前」备份只能来自强制的操作前备份。
    assert.equal((await api('/api/manual-backup', {})).ok, true);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:960 } });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    const openSettings = async () => {
      await page.goto(`${url}/trade-order-system.html?token=${token}`);
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded || /只读|失败/.test(document.getElementById('macStorageStatusBadge')?.textContent || ''));
      await page.evaluate(() => setPage('settings'));
      await page.waitForSelector('#exportJsonBtn', { state:'visible' });
    };
    const confirmOpen = async () => {
      await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      await h.settle(page, '#confirmModal .modal');
      return page.evaluate(() => ({ sub:document.getElementById('confirmSub').textContent, message:document.getElementById('confirmMessage').textContent, ok:document.getElementById('confirmOkBtn').textContent, alt:document.getElementById('confirmAltBtn').hidden ? '' : document.getElementById('confirmAltBtn').textContent }));
    };
    const confirmClosed = async () => {
      try { await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'), null, { timeout:15000 }); }
      catch (error) { throw new Error(`confirm box still open: ${await page.evaluate(() => `${document.getElementById('confirmSub').textContent} / ${document.getElementById('confirmMessage').textContent} / ${document.getElementById('confirmError').textContent}`)}`); }
    };
    const chooseFile = async (button, file) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), h.click(page, button)]);
      await chooser.setFiles(file);
    };
    const writeFile = (name, value) => { const file = path.join(dataDir, name); fs.writeFileSync(file, JSON.stringify(value, null, 2)); return file; };
    // 鼠标放到提示上让它停住（6 秒计时暂停），检查完再点「撤销」。
    const holdToast = async text => {
      await h.waitToast(page, text);
      const box = await page.locator('#toast .toast-item:not(.leaving)', { hasText:text }).last().boundingBox();
      await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 3 + 2, box.y + box.height / 2);
    };

    await openSettings();
    // 默认备份目录下「恢复默认目录」按钮是隐藏的（以前 .btn 的 display 盖过了 hidden）。
    assert.equal(await page.locator('#macResetBackupDirBtn').evaluate(el => getComputedStyle(el).display), 'none');

    // ---- 1. 单月「导出备份」再导入：只合并，其他月份的订单都在；导入前有备份 ----
    await page.selectOption('#exportMonth', '2026-10');
    await h.click(page, '#exportJsonBtn');
    const monthFile = path.join(exportDir, 'trade-orders-backup-2026-10.json');
    await page.waitForFunction(() => document.getElementById('exportJsonBtn').textContent.includes('已导出'));
    const monthJson = JSON.parse(fs.readFileSync(monthFile, 'utf8'));
    assert.equal(monthJson.scope, 'month');
    assert.deepEqual(monthJson.data.orders.map(o => o.num), ['K26100101']);
    await h.clearToasts(page);
    await chooseFile('#importJsonBtn', monthFile);
    let dialog = await confirmOpen();
    assert.match(dialog.sub, /只合并/);
    assert.match(dialog.message, /2026-10 单月订单/);
    assert.match(dialog.message, /不删除任何现有数据/);
    assert.equal(dialog.ok, '合并导入');
    await page.waitForFunction(() => document.activeElement?.id === 'confirmCancelBtn');
    await h.click(page, '#confirmOkBtn');
    await confirmClosed();
    await h.waitToast(page, '已合并导入');
    assert.deepEqual((await db()).orders.map(o => o.num).sort(), ['K26080101', 'K26090101', 'K26100101', 'K26110101'], 'importing a one-month file keeps every other month');
    assert.equal(backups('import').length, 1, 'a forced before-import backup is taken even within the hourly window');

    // ---- 2. 整份文件：预览对比、默认合并、替换要输入确认；金额文字转成数字；聊天不搬家；撤销 ----
    const current = (await db());
    const replaceFile = writeFile('old-backup.json', {
      app:'trade-order-system', version:'3.120', exportedAt:'2026-10-01T02:00:00.000Z', scope:'all',
      data:{
        ...current,
        orders:[{ ...current.orders.find(o => o.id === 'u1'), amount:'1,200' }, order('n1', 'K26100901', 'Brand New Buyer', '2026-10')].map((o, i) => i === 1 ? { ...o, amount:'$500', paidAmount:'0' } : o),
        customers:{ 'Alice Baker':current.customers['Alice Baker'], 'Brand New Buyer':{ client:'Brand New Buyer' } }
      }
    });
    await h.clearToasts(page);
    await chooseFile('#previewImportDataFileBtn', replaceFile);
    dialog = await confirmOpen();
    assert.match(dialog.message, /由 V3\.120 导出 · 全部数据/);
    assert.match(dialog.message, /订单（含垃圾箱、已删除）：新增 1、修改 1、删除 3 张（K26100101、K26090101、K26080101）/, dialog.message);
    assert.match(dialog.message, /客户：新增 1、修改 0、删除 3 位/);
    assert.match(dialog.message, /K26110101 金额「1,200」→ 1200/);
    assert.match(dialog.message, /K26100901 金额「\$500」→ 500/);
    assert.equal(dialog.alt, '合并导入（不删除）');
    assert.equal(dialog.ok, '删除 6 项并替换');
    await page.waitForFunction(() => document.activeElement?.id === 'confirmAltBtn', null, { timeout:5000 });
    await h.click(page, '#confirmOkBtn');
    // 第二步：要输入「替换」。先输错一次。
    await page.waitForFunction(() => document.getElementById('confirmSub').textContent === '会删除现有数据');
    await page.waitForFunction(() => document.activeElement?.id === 'confirmInput');
    await page.keyboard.type('好');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('confirmError').textContent.includes('替换'));
    await page.locator('#confirmInput').fill('');
    await page.keyboard.type('替换');
    await page.keyboard.press('Enter');
    await confirmClosed();
    await holdToast('数据文件已导入');
    let saved = (await db());
    assert.deepEqual(saved.orders.map(o => `${o.num}:${o.amount}`).sort(), ['K26100901:500', 'K26110101:1200'], 'amount strings are saved as numbers, not retried forever');
    assert.equal(await page.evaluate(() => window.pendingSaveStatus().error), '');
    assert.equal(await chatCount('Brand New Buyer'), 0, 'a removed customer\'s WhatsApp chat must not be moved to a customer added by the same import');
    assert.equal(await chatCount('Zero Lead'), 1);
    assert.equal(backups('import').length, 2);
    await h.clickUndo(page, '数据文件已导入');
    await h.waitToast(page, '已撤销导入');
    await page.waitForFunction(() => window.pendingSaveStatus().pending === false && !window.pendingSaveStatus().saving);
    // 换数据那次已经整份写进数据库了：侧栏回到「已保存」，不停在「待保存」（以前要等下一次改动才变回来）。
    await page.waitForFunction(() => document.getElementById('savePulse').lastElementChild.textContent === '已保存', null, { timeout:5000 });
    saved = (await db());
    assert.deepEqual(saved.orders.map(o => o.num).sort(), ['K26080101', 'K26090101', 'K26100101', 'K26110101'], 'undo brings the replaced orders back');
    assert.ok(saved.customers['Zero Lead'], 'undo brings the removed customer back');
    assert.equal(await chatCount('Zero Lead'), 1);

    // ---- 3. 导入写库失败：页面回到导入前，不进重试循环 ----
    const addFile = writeFile('add-one.json', { app:'trade-order-system', scope:'all', data:{ ...saved, orders:[...saved.orders, order('n2', 'K26111501', 'Alice Baker', '2026-11')] } });
    let failNext = true;
    let saveRequests = 0;
    await page.route('**/api/save', route => {
      saveRequests += 1;
      if (failNext && (route.request().postData() || '').includes('K26111501')) { failNext = false; return route.fulfill({ status:500, contentType:'application/json', body:JSON.stringify({ ok:false, message:'database is locked' }) }); }
      return route.continue();
    });
    await h.clearToasts(page);
    await chooseFile('#previewImportDataFileBtn', addFile);
    dialog = await confirmOpen();
    assert.equal(dialog.ok, '替换全部');
    await page.waitForFunction(() => document.activeElement?.id === 'confirmAltBtn');
    await page.keyboard.press('Enter');
    await confirmClosed();
    await h.waitToast(page, '导入没有完成，数据保持导入前的样子：database is locked');
    assert.equal(await page.evaluate(() => state.orders.some(o => o.id === 'n2')), false, 'the page goes back to the data before the import');
    const requestsAfterFailure = saveRequests;
    await page.waitForTimeout(3600);
    assert.equal(saveRequests, requestsAfterFailure, 'a failed import is not retried every 3 seconds');
    await page.unroute('**/api/save');

    // ---- 4. 恢复示例：只换订单，客户档案和设置保留，执行前有备份 ----
    await h.clearToasts(page);
    await h.click(page, '#resetBtn');
    dialog = await confirmOpen();
    assert.match(dialog.message, /4 张订单/);
    await h.click(page, '#confirmOkBtn');
    await page.waitForFunction(() => document.getElementById('confirmSub').textContent === '第二步确认');
    dialog = await confirmOpen();
    assert.match(dialog.message, /客户档案、收款方式、客户标签、编号和汇率等设置都会保留/);
    await h.click(page, '#confirmOkBtn');
    await page.waitForFunction(() => document.activeElement?.id === 'confirmInput');
    await page.keyboard.type('13');
    await page.keyboard.press('Enter');
    await confirmClosed();
    await h.waitToast(page, '已恢复示例数据');
    saved = (await db());
    assert.ok(saved.orders.length > 4 && !saved.orders.some(o => o.id === 'u1'), 'demo orders are loaded');
    assert.ok(saved.customers['Zero Lead'] && saved.customers['Alice Baker']?.note === 'VIP 永久备注', 'own customer profiles are kept');
    assert.ok(saved.paymentMethods.includes('自定义收款A') && saved.customerTags.includes('老客户自定义标签'), 'settings are kept');
    assert.equal(backups('reset').length, 1, 'a before-reset backup is taken');

    // ---- 5. 从备份恢复：列表 → 预览对比 → 恢复 → 重新加载，提示带「撤销恢复」 ----
    await h.clearToasts(page);
    await h.click(page, '#macRestoreBackupBtn');
    const row = page.locator('#macRestoreList .backup-restore-item', { hasText:'恢复示例前' });
    await row.waitFor();
    await h.click(page, row.locator('[data-restore-backup]'), 'restore the before-reset backup');
    dialog = await confirmOpen();
    assert.match(dialog.message, /恢复后和现在比/);
    assert.match(dialog.message, /备份里：订单 4/);
    assert.match(dialog.message, /恢复前会先把现在的数据另存为一份「恢复前」备份/);
    await page.waitForFunction(() => document.activeElement?.id === 'confirmCancelBtn');
    await Promise.all([page.waitForNavigation(), h.click(page, '#confirmOkBtn')]);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await h.waitToast(page, '的备份恢复');
    assert.equal(await page.locator('#toast .toast-item:not(.leaving)', { hasText:'的备份恢复' }).locator('.toast-undo').textContent(), '撤销恢复');
    saved = (await db());
    assert.deepEqual(saved.orders.map(o => o.num).sort(), ['K26080101', 'K26090101', 'K26100101', 'K26110101'], 'the data before the reset is back');
    assert.equal(backups('restore').length, 1, 'a before-restore backup is taken');

    // ---- 6. 读库失败：导出被拦下；只读保护下照样能从备份恢复 ----
    await stopServer();
    const markerFile = path.join(dataDir, 'sqlite-storage.json');
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    fs.writeFileSync(markerFile, JSON.stringify({ ...marker, databaseId:'00000000-0000-0000-0000-000000000000' }));
    await startServer();
    await openSettings();
    assert.equal(await page.evaluate(() => window.pendingSaveStatus().loaded), false);
    assert.match(await page.locator('#macStorageStatusText').textContent(), /身份标记对不上.*从备份恢复/);
    const exportsBefore = fs.readdirSync(exportDir).length;
    await h.clearToasts(page);
    await h.click(page, '#exportDataFileBtn');
    await h.waitToast(page, '数据库没有读出来，现在导出的不是你的数据');
    assert.equal(fs.readdirSync(exportDir).length, exportsBefore, 'no export file while the database could not be read');
    await h.click(page, '#macRestoreBackupBtn');
    const newest = page.locator('#macRestoreList .backup-restore-item').first();
    await newest.waitFor();
    await h.click(page, newest.locator('[data-restore-backup]'), 'restore the newest backup');
    dialog = await confirmOpen();
    assert.match(dialog.message, /现在的数据库没有读出来/);
    await Promise.all([page.waitForNavigation(), h.click(page, '#confirmOkBtn')]);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    assert.equal((await (await fetch(`${url}/api/health`)).json()).storageMode, 'sqlite');

    assert.deepEqual(dialogs, [], 'no native dialogs');
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
    console.log('Import / restore UI tests passed: one-month import merges, preview diff and typed confirmation, amount strings, chats stay put, undo, failed import rolls back, demo reset keeps customers, restore from backup (also in read-only mode), export blocked when the database could not be read.');
  } finally {
    await browser?.close();
    await stopServer();
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
