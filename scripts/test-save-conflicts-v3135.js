#!/usr/bin/env node
// Regression tests for audit 27 (save conflicts and save confirmation), fixed in V3.135. Runs the real
// mac-app/server.js on a free port with a temporary data folder and two page windows on the same database:
// - two windows editing different orders merge instead of going read-only; the same field asks 用我的 / 用那边的;
// - the conflict export holds only the unsaved records and importing it merges them without reverting others;
// - an idle window follows the database; the refresh button saves first and asks when something cannot be saved;
// - a lost response retried with the same save id is not a conflict; /api/data reads the revision from the database;
// - settings forms only say 已保存 after the database confirms; AI / tracking settings failures say so, keys stay
//   out of localStorage, a stale window only sends what it changed;
// - read-only after a failed load does not claim a change was lost, and the reload button exists;
// - save timeout, Chinese storage errors, retry success settles the open form, busy save buttons, quit texts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { freePortSync } = require('./helpers/free-port');
const { h, launchBrowser } = require('./helpers/board-page');

const root = path.resolve(__dirname, '..');
const token = 'audit27-token';
const pad = n => String(n).padStart(2, '0');
const now = new Date();
const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const base = { currency:'USD', logisticsStatus:'未发货', createdAt:`${month}-01`, orderMonth:month, logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[], orderType:'全款订单', stage:'quote', amount:100, paidAmount:0 };
const seedOrders = [1, 2, 3, 4].map(n => ({ ...base, id:`o${n}`, num:`K${n}`, client:`Buyer ${n}`, note:`原备注 o${n}` }));
const seedCustomers = Object.fromEntries([1, 2, 3, 4].map(n => [`Buyer ${n}`, { client:`Buyer ${n}`, note:'' }]));

function startServer(dataDir, port) {
  const child = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], {
    env:{ ...process.env, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', TRADE_APP_DATA_DIR:dataDir, TRADE_APP_PORT:String(port), TRADE_EXPORT_NO_REVEAL:'1', TRADE_EXPORT_DIR:path.join(dataDir, '__downloads') },
    stdio:['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers:{ Authorization:`Bearer ${token}`, ...(body !== undefined ? { 'Content-Type':'application/json' } : {}) }, body:body === undefined ? undefined : JSON.stringify(body) });
    return { status:response.status, data:await response.json().catch(() => ({})) };
  };
  const ready = (async () => {
    const deadline = Date.now() + 15000;
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { headers:{ Authorization:`Bearer ${token}` } })).ok) return; } catch (_) {}
      if (Date.now() > deadline) throw new Error(`server did not start\n${log}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })();
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  };
  return { child, request, ready, stop, port, log:() => log };
}

function serverFunctionTests() {
  const source = fs.readFileSync(path.join(root, 'mac-app', 'server.js'), 'utf8');
  const start = source.indexOf('function friendlySaveError(');
  assert.ok(start >= 0, 'friendlySaveError is missing');
  let code = '';
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] !== '}') continue;
    try { new vm.Script(source.slice(start, index + 1)); code = source.slice(start, index + 1); break; } catch (_) {}
  }
  const context = vm.createContext({});
  vm.runInContext(code, context);
  // P2-8: storage errors in Chinese with a code, the English original stays out of the message.
  assert.equal(context.friendlySaveError(new Error('database or disk is full')).code, 'disk-full');
  assert.match(context.friendlySaveError(Object.assign(new Error('x'), { code:'ENOSPC' })).message, /磁盘空间不足/);
  assert.equal(context.friendlySaveError(new Error('database is locked')).code, 'db-busy');
  assert.equal(context.friendlySaveError(new Error('something else')), null);
  // P2-7: an uncaught exception is logged, the service keeps running.
  assert.match(source, /process\.on\('uncaughtException'/);
}

async function main() {
  serverFunctionTests();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-v3135-'));
  const server = startServer(dataDir, freePortSync());
  let second = null;
  const browser = await launchBrowser();
  try {
    await server.ready;
    const { request } = server;
    // Seed: 4 orders, 4 customers.
    const initial = (await request('/api/data')).data;
    const seeded = await request('/api/save', { method:'POST', body:{ state:{ app:'trade-order-system', version:'3', data:{ ...initial.data, orders:seedOrders, customers:seedCustomers, trashOrders:[], deletedOrders:[], demoCleared:true, demoCustomersCleared:true } }, baseRevision:initial.revision } });
    assert.equal(seeded.status, 200, JSON.stringify(seeded.data));
    const dbOrder = async id => (await request('/api/data')).data.data.orders.find(order => order.id === id);

    // P2-1 (server): the same save id retried after its response was lost returns that save, not a 409.
    {
      const current = (await request('/api/data')).data;
      const body = { state:{ app:current.app, version:current.version, data:current.data }, baseRevision:current.revision, saveId:'retry-test-0001' };
      const first = await request('/api/save', { method:'POST', body });
      assert.equal(first.status, 200);
      const again = await request('/api/save', { method:'POST', body });
      assert.equal(again.status, 200, 'a retried save id must not be a conflict');
      assert.equal(again.data.duplicate, true);
      assert.equal(again.data.revision, first.data.revision);
      const other = await request('/api/save', { method:'POST', body:{ ...body, saveId:'retry-test-0002' } });
      assert.equal(other.status, 409, 'a different save on an old revision is still a conflict');
      assert.equal((await request('/api/revision')).data.revision, first.data.revision);
    }

    const context = await browser.newContext({ viewport:{ width:1440, height:920 } });
    await context.addInitScript(() => { try { localStorage.setItem('trade-order-system-theme', 'light'); localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const errors = [];
    const dialogs = [];
    const openPage = async () => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
      await page.goto(`http://127.0.0.1:${server.port}/trade-order-system.html?token=${token}`);
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
      return page;
    };
    const A = await openPage();
    const B = await openPage();
    const setNote = (page, id, note) => page.evaluate(([id, note]) => {
      const order = state.orders.find(item => item.id === id);
      order.note = note;
      return window.flushPendingSave();
    }, [id, note]);
    const confirmOpen = page => page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    const confirmClosed = page => page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    const status = page => page.evaluate(() => window.pendingSaveStatus());

    // P1-1 / P1-2: A and B change different orders. B merges A's change and saves; nothing goes read-only.
    assert.equal(await setNote(A, 'o1', 'A 改的 o1'), true);
    assert.equal(await setNote(B, 'o2', 'B 改的 o2'), true, 'different orders must merge, not conflict');
    assert.equal((await status(B)).readOnly, false);
    await h.waitToast(B, '已合并另一个窗口的修改');
    assert.equal((await dbOrder('o1')).note, 'A 改的 o1');
    assert.equal((await dbOrder('o2')).note, 'B 改的 o2');
    assert.equal(await B.evaluate(() => state.orders.find(o => o.id === 'o1').note), 'A 改的 o1', 'B now shows A’s change');
    // A background-style change (a tracking lookup added by an idle window) does not block B's edit either.
    await A.evaluate(() => { state.trackingLookups.unshift({ id:'lk-1', trackingNumber:'1234567890', carrier:'DHL', status:'查询失败', events:[] }); return window.flushPendingSave(); });
    assert.equal(await setNote(B, 'o3', 'B 改的 o3'), true);
    assert.equal((await request('/api/data')).data.data.trackingLookups.length, 1);

    // P1-2: an idle window follows the database without saving anything itself.
    assert.equal(await setNote(B, 'o4', 'B 改的 o4'), true);
    assert.equal(await A.evaluate(() => window.macCheckRemoteRevision({ force:true })), true);
    assert.equal(await A.evaluate(() => state.orders.find(o => o.id === 'o4').note), 'B 改的 o4');
    assert.equal((await status(A)).revision, (await request('/api/revision')).data.revision);

    // P1-1: the same field changed in both windows asks which side to keep. 用我的 keeps B's value.
    assert.equal(await setNote(A, 'o3', 'A 版 o3'), true);
    assert.equal(await setNote(B, 'o3', 'B 版 o3'), false);
    await confirmOpen(B);
    assert.equal(await B.locator('#confirmTitle').innerText(), '两个窗口改了同一处');
    assert.match(await B.locator('#confirmMessage').innerText(), /订单 K3 · 备注：那边「A 版 o3」\/ 你的「B 版 o3」/);
    assert.equal(await B.locator('#confirmOkBtn').innerText(), '用那边的');
    assert.equal(await B.locator('#confirmAltBtn').innerText(), '用我的');
    await h.click(B, '#confirmAltBtn', '用我的');
    await B.waitForFunction(() => !window.pendingSaveStatus().readOnly && !window.pendingSaveStatus().pending);
    assert.equal((await dbOrder('o3')).note, 'B 版 o3');
    // 用那边的 keeps A's value in the database and in B.
    await A.evaluate(() => window.macCheckRemoteRevision({ force:true }));
    assert.equal(await setNote(A, 'o4', 'A 版 o4'), true);
    assert.equal(await setNote(B, 'o4', 'B 版 o4'), false);
    await confirmOpen(B);
    await h.click(B, '#confirmOkBtn', '用那边的');
    await B.waitForFunction(() => !window.pendingSaveStatus().readOnly && !window.pendingSaveStatus().pending);
    assert.equal((await dbOrder('o4')).note, 'A 版 o4');
    assert.equal(await B.evaluate(() => state.orders.find(o => o.id === 'o4').note), 'A 版 o4');

    // P1-1: 稍后处理 → read-only. The export holds only the unsaved record and is marked as a conflict export.
    await A.evaluate(() => window.macCheckRemoteRevision({ force:true }));
    assert.equal(await setNote(A, 'o1', 'A 再改 o1'), true);
    assert.equal(await setNote(B, 'o1', 'B 再改 o1'), false);
    await confirmOpen(B);
    await h.click(B, '#confirmCancelBtn', '稍后处理');
    await confirmClosed(B);
    assert.equal((await status(B)).readOnly, true);
    const downloads = path.join(dataDir, '__downloads');
    assert.equal(await B.evaluate(() => exportUnsavedMacState()), true);
    const exportName = fs.readdirSync(downloads).find(name => /^trade-order-unsaved-\d+\.json$/.test(name));
    assert.ok(exportName, 'conflict export file missing');
    const exported = JSON.parse(fs.readFileSync(path.join(downloads, exportName), 'utf8'));
    assert.equal(exported.scope, 'unsaved-conflict');
    assert.deepEqual(exported.data.orders.map(o => o.id), ['o1'], 'only the unsaved order is exported');
    assert.equal(Object.keys(exported.data.customers).length, 0);

    // P2-3: read-only — the order settings form does not claim 已保存.
    await B.evaluate(() => setPage('settings'));
    await B.evaluate(() => document.getElementById('orderSettingsForm').requestSubmit());
    await B.waitForTimeout(400);
    assert.ok(!(await h.toasts(B)).some(text => text.includes('订单设置已保存')), 'read-only settings must not say 已保存');
    if (await B.evaluate(() => document.getElementById('confirmModal').classList.contains('open'))) {
      await h.click(B, '#confirmCancelBtn', '稍后处理');
      await confirmClosed(B);
    }
    // P2-8: quitting while in conflict explains that waiting will not help.
    assert.equal(await B.evaluate(() => window.otsFlushBeforeQuit()), false);
    await B.evaluate(() => { window.__quit = null; window.nativeDialog({ title:'订单数据尚未确认保存', message:'页面报告本次保存没有完成。', sub:'退出软件', confirmText:'仍然退出', cancelText:'返回软件', danger:true }).then(value => { window.__quit = value; }); });
    await confirmOpen(B);
    assert.equal(await B.locator('#confirmTitle').innerText(), '有修改和另一个窗口冲突');
    assert.match(await B.locator('#confirmMessage').innerText(), /导出未保存的修改/);
    await B.waitForFunction(() => document.activeElement?.id === 'confirmCancelBtn');
    await h.click(B, '#confirmCancelBtn', '返回软件');
    await B.waitForFunction(() => window.__quit === false);

    // P1-3: the refresh button asks first when local changes cannot be saved.
    await h.click(B, '#appRefreshBtn', '刷新');
    await confirmOpen(B);
    assert.equal(await B.locator('#confirmTitle').innerText(), '还有修改没存进数据库');
    assert.match(await B.locator('#confirmMessage').innerText(), /订单 K1/);
    assert.equal(await B.locator('#confirmAltBtn').innerText(), '导出后刷新');
    await B.waitForFunction(() => document.activeElement?.id === 'confirmCancelBtn');
    await h.click(B, '#confirmCancelBtn', '取消');
    await confirmClosed(B);
    assert.equal((await status(B)).readOnly, true, '取消 keeps the page');

    // Importing the conflict export into A merges o1 only: A's other saved changes are not reverted.
    await A.evaluate(text => { window.__importDone = previewImportDataFile(new File([text], 'unsaved.json', { type:'application/json' })); }, JSON.stringify(exported));
    await confirmOpen(A);
    assert.match(await A.locator('#confirmMessage').innerText(), /保存冲突时导出的「没存进去的修改」[\s\S]*订单 K1/);
    await h.click(A, '#confirmOkBtn', '合并导入');
    await A.evaluate(() => window.__importDone);
    await A.waitForFunction(() => !window.pendingSaveStatus().pending);
    assert.equal((await dbOrder('o1')).note, 'B 再改 o1');
    assert.equal((await dbOrder('o4')).note, 'A 版 o4', 'the import must not revert other records');
    assert.equal((await dbOrder('o3')).note, 'B 版 o3');
    await B.close();

    // P1-3: deleting and refreshing right away keeps the deletion.
    await A.evaluate(() => window.macCheckRemoteRevision({ force:true }));
    await A.evaluate(() => { const order = state.orders.find(o => o.id === 'o2'); state.orders = state.orders.filter(o => o.id !== 'o2'); state.deletedOrders.unshift({ ...order, deletedAt:nowText() }); saveState(); });
    assert.equal(await A.locator('#savePulse').innerText(), '待保存', 'the pulse says 待保存 during the debounce');
    await Promise.all([A.waitForEvent('load'), h.click(A, '#appRefreshBtn', '刷新')]);
    await A.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    assert.ok((await request('/api/data')).data.data.deletedOrders.some(o => o.id === 'o2'), 'the deletion was lost on refresh');

    // P1-3 + P2-8 + P2-9: a failing save retries; refresh asks; the form message does not say 请重试;
    // when the retry succeeds the open order counts as saved and Esc closes it without 放弃修改.
    let failSave = true;
    await A.route('**/api/save', route => failSave ? route.fulfill({ status:500, json:{ ok:false, message:'Mac 磁盘空间不足，数据没有存进去。清理出空间后会自动继续保存。', code:'disk-full' } }) : route.continue());
    await A.evaluate(() => openOrder('o3'));
    await A.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await A.locator('#orderForm [name="note"]').fill('重试后保存的 o3');
    await h.click(A, A.locator('#orderModal button[type="submit"][form="orderForm"]').first(), '保存订单');
    await A.waitForFunction(() => window.pendingSaveStatus().error);
    await A.waitForTimeout(300);
    const failToasts = await h.toasts(A);
    assert.ok(!failToasts.some(text => text.includes('请重试')), `auto retry must not ask to retry: ${failToasts.join(' / ')}`);
    assert.ok(failToasts.some(text => text.includes('正在自动重试')));
    assert.ok(failToasts.some(text => text.includes('磁盘空间不足')), 'the reason is shown in Chinese');
    // The refresh button sits under the order modal here; call its handler directly.
    await A.evaluate(() => { guardedPageReload({ scrollTop:true }); });
    await confirmOpen(A);
    assert.equal(await A.locator('#confirmTitle').innerText(), '还有修改没存进数据库');
    assert.match(await A.locator('#confirmMessage').innerText(), /订单 K3/);
    await h.click(A, '#confirmCancelBtn', '取消');
    await confirmClosed(A);
    failSave = false;
    await A.waitForFunction(() => !window.pendingSaveStatus().error && !window.pendingSaveStatus().pending, null, { timeout:15000 });
    await h.waitToast(A, '已在后台自动保存到数据库');
    assert.equal((await dbOrder('o3')).note, '重试后保存的 o3');
    await A.keyboard.press('Escape');
    await A.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    assert.equal(await A.evaluate(() => document.getElementById('confirmModal').classList.contains('open')), false, 'no 放弃修改 after the retry saved it');
    assert.equal((await dbOrder('o3')).note, '重试后保存的 o3', 'closing must not undo the saved order');
    await A.unroute('**/api/save');

    // P2-1 (page): the response is lost after the server committed; the retry is not a conflict.
    let dropOnce = true;
    await A.route('**/api/save', async route => {
      if (!dropOnce) return route.continue();
      dropOnce = false;
      await route.fetch();
      return route.abort('connectionreset');
    });
    assert.equal(await setNote(A, 'o1', '响应丢失的 o1'), false);
    await A.waitForFunction(() => !window.pendingSaveStatus().pending && !window.pendingSaveStatus().error, null, { timeout:15000 });
    assert.equal((await status(A)).readOnly, false, 'a lost response must not end in 另一个窗口刚保存过数据');
    assert.equal((await dbOrder('o1')).note, '响应丢失的 o1');
    await A.unroute('**/api/save');

    // P2-6: a save that hangs times out and is retried instead of 保存中… forever.
    let hang = true;
    await A.route('**/api/save', async route => {
      if (!hang) return route.continue();
      await new Promise(resolve => setTimeout(resolve, 2500));
      try { await route.continue(); } catch (_) {}
    });
    await A.evaluate(() => { macSaveRequestTimeoutMs = 800; });
    await setNote(A, 'o4', '超时后重试的 o4');
    assert.match(await A.evaluate(() => window.pendingSaveStatus().error), /没有回应/);
    hang = false;
    await A.waitForFunction(() => !window.pendingSaveStatus().pending && !window.pendingSaveStatus().error, null, { timeout:15000 });
    await A.evaluate(() => { macSaveRequestTimeoutMs = 20000; });
    await A.unroute('**/api/save');
    assert.equal((await status(A)).readOnly, false);
    assert.equal((await dbOrder('o4')).note, '超时后重试的 o4');

    // P2-10: the customer header save shows 保存中…, aria-busy and is disabled while saving.
    await A.route('**/api/save', async route => { await new Promise(resolve => setTimeout(resolve, 900)); try { await route.continue(); } catch (_) {} });
    await A.evaluate(() => openCustomerModal('Buyer 1', { viewOnly:false }));
    await A.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
    await A.locator('#customerForm [name="note"]').fill('慢保存的客户备注');
    await h.click(A, '#customerHeaderSaveBtn', '客户保存');
    await A.waitForFunction(() => document.getElementById('customerHeaderSaveBtn').getAttribute('aria-busy') === 'true');
    assert.equal(await A.evaluate(() => document.getElementById('customerHeaderSaveBtn').disabled), true);
    assert.match(await A.locator('#customerHeaderSaveBtn').innerText(), /保存中/);
    await A.keyboard.press('Escape');
    await A.waitForFunction(() => [...document.querySelectorAll('#toast .toast-item.is-info')].some(el => el.textContent.includes('正在保存，请稍候')) || !document.getElementById('customerModal').classList.contains('open'));
    await A.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'), null, { timeout:10000 });
    await A.unroute('**/api/save');

    // P2-4: tracking / AI settings — a server failure is reported, the key never lands in localStorage.
    await A.evaluate(() => setPage('settings'));
    await A.route('**/api/tracking-settings', route => route.request().method() === 'POST' ? route.fulfill({ status:500, json:{ ok:false, message:'没有权限写入数据目录，请检查文件夹权限。' } }) : route.continue());
    await A.evaluate(() => {
      const form = document.getElementById('trackingApiSettingsForm');
      form.elements.dhlApiKey.value = 'secret-dhl-key-123';
      form.requestSubmit();
    });
    await h.waitToast(A, '物流追踪设置没有保存');
    assert.ok(!(await h.toasts(A)).some(text => text.includes('物流追踪设置已保存')));
    assert.doesNotMatch(await A.evaluate(() => JSON.stringify(localStorage)), /secret-dhl-key-123/);
    await A.unroute('**/api/tracking-settings');
    await A.route('**/api/ai-settings', route => route.request().method() === 'POST' ? route.fulfill({ status:500, json:{ ok:false, message:'EACCES' } }) : route.continue());
    await A.evaluate(() => { const form = document.getElementById('aiSettingsForm'); form.elements.apiKey.value = 'sk-test-ai-key'; form.requestSubmit(); });
    await h.waitToast(A, 'AI 设置没有保存');
    await A.unroute('**/api/ai-settings');
    // Two windows on the tracking settings: A turns auto update off, a stale window C only changes the FedEx environment.
    const C = await openPage();
    await C.evaluate(() => setPage('settings'));
    let trackingPosts = 0;
    await A.route('**/api/tracking-settings', route => { if (route.request().method() === 'POST') trackingPosts += 1; return route.continue(); });
    await A.evaluate(() => { const form = document.getElementById('trackingApiSettingsForm'); form.elements.autoDhlUpdate.value = '否'; form.requestSubmit(); });
    await h.waitToast(A, '物流追踪设置已保存');
    assert.equal(trackingPosts, 1, 'one save posts once');
    await C.evaluate(() => { const form = document.getElementById('trackingApiSettingsForm'); form.elements.fedexEnv.value = 'prod'; form.requestSubmit(); });
    await h.waitToast(C, '物流追踪设置已保存');
    const tracking = (await request('/api/tracking-settings')).data;
    assert.equal(tracking.autoDhlUpdate, '否', 'the stale window turned auto update back on');
    assert.equal(tracking.fedexEnv, 'prod');
    await A.unroute('**/api/tracking-settings');
    await C.close();

    // P2-5: a failed load does not say a change was lost; settings has a working 重新读取数据库.
    const D = await context.newPage();
    D.on('pageerror', error => errors.push(error.message));
    D.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    let failLoad = true;
    await D.route('**/api/data', route => failLoad ? route.fulfill({ status:500, json:{ ok:false, message:'database is locked' } }) : route.continue());
    await D.goto(`http://127.0.0.1:${server.port}/trade-order-system.html?token=${token}`);
    await h.waitToast(D, '数据库读取失败');
    await D.waitForTimeout(800);
    assert.ok(!(await h.toasts(D)).some(text => text.includes('这次修改没有保存')), 'nothing was changed, so nothing was lost');
    await D.evaluate(() => setPage('settings'));
    assert.equal(await D.locator('#macStorageReloadActions').isVisible(), true);
    failLoad = false;
    await h.click(D, '#macStorageReloadBtn', '重新读取数据库');
    await D.waitForFunction(() => window.pendingSaveStatus().loaded && !window.pendingSaveStatus().readOnly);
    assert.equal(await D.locator('#macStorageReloadActions').isVisible(), false);
    await D.close();

    // P2-2: a second server process on the same data folder reports the database revision, not its own stale copy.
    second = startServer(dataDir, freePortSync());
    await second.ready;
    await setNote(A, 'o1', '第二个进程之前');
    const revision = (await request('/api/revision')).data.revision;
    assert.equal((await second.request('/api/data')).data.revision, revision);
    assert.equal((await second.request('/api/health')).data.storageRevision, revision);

    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    assert.deepEqual(dialogs, [], 'native dialogs are not allowed');
  } finally {
    await browser.close();
    if (second) await second.stop();
    await server.stop();
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
  console.log('Save conflicts V3.135 passed: merge of different records, 用我的 / 用那边的, conflict export and merge import, idle window follow-up, guarded refresh, save id retry, timeout, settings confirmations, AI / tracking failures, load failure, busy buttons, quit texts, database revision.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
