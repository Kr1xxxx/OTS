#!/usr/bin/env node
// 改名以后，另一份还按旧名字的数据（另一个窗口、改名前导出的文件）不再把订单搬回旧名字：
// - 那边改了名，这边给旧名字建单：合并后新单在新名字下，编号和档案对得上，没有旧名字的档案；
// - 那边改了名，这边改了同一位客户的备注：自动合并，不弹冲突框，新名字和备注都在；
// - 这边改了名，那边先给旧名字建了单：反过来一样；
// - 冲突框里整份档案只有一边还在时，说是哪边删了，不显示一段原始数据；
// - 「合并导入」改名之前导出的单月文件：订单留在新名字下，不多出一位「新客户」。
// 真实 mac-app/server.js（临时数据目录、真实 SQLite），两个窗口开同一个数据库。数据都是编的。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const pad = n => String(n).padStart(2, '0');
const now = new Date();
const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const ids = { acme:'cacme000000000000001', beta:'cbeta000000000000002' };
const order = (id, client, extra = {}) => ({
  id, num:`K${id}`, client, customerId:client === 'Acme Hair' ? ids.acme : ids.beta, amount:650, paidAmount:0, orderType:'全款订单', stage:'quote',
  currency:'USD', logisticsStatus:'未发货', createdAt:`${month}-01`, orderMonth:month, logs:[], productType:'假发', paymentChannel:'Paypal',
  owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[], ...extra
});
const profile = (client, id) => ({ client, id, country:'🇺🇸 美国 United States', phones:[], emails:[], addresses:[], contacts:[], tags:[], note:'', permanentNote:'', history:[] });

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-rename-windows-'));
  const port = freePortSync();
  const token = `rename-windows-${process.pid}`;
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', DHL_API_KEY:'', FEDEX_CLIENT_ID:'', FEDEX_CLIENT_SECRET:'' };
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${url}/api/health`)).ok; } catch (_) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'server starts');
    const api = async (route, body) => {
      const response = await fetch(url + route, { method:body ? 'POST' : 'GET', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) });
      return { status:response.status, data:await response.json() };
    };
    const db = async () => (await api('/api/data')).data.data;
    // Every scenario starts from the same two customers with fixed ids and three orders.
    const seed = async () => {
      const current = (await api('/api/data')).data;
      const saved = await api('/api/save', { state:{ app:current.app, version:current.version, data:{
        ...current.data,
        orders:[order('x1', 'Acme Hair'), order('x2', 'Acme Hair'), order('y1', 'Beta Wigs')], trashOrders:[], deletedOrders:[],
        customers:{ 'Acme Hair':profile('Acme Hair', ids.acme), 'Beta Wigs':profile('Beta Wigs', ids.beta) },
        doneTasks:{}, customerDuplicateIgnores:[], demoCleared:true, demoCustomersCleared:true
      } }, baseRevision:current.revision });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
    };

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 } });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const errors = [];
    const dialogs = [];
    const openPage = async () => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
      await page.goto(`${url}/trade-order-system.html?token=${token}`);
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
      return page;
    };
    // Page-side async work is started and its outcome polled for (see test-save-conflicts-v3135.js on macOS CI).
    const run = async (page, start, arg) => {
      await page.evaluate(() => {
        window.__otsOutcome = null;
        window.__otsTrack = promise => Promise.resolve(promise).then(value => { window.__otsOutcome = { value }; }, error => { window.__otsOutcome = { error:String(error?.message || error) }; });
      });
      await page.evaluate(start, arg);
      const outcome = await (await page.waitForFunction(() => window.__otsOutcome)).jsonValue();
      if (outcome.error) throw new Error(outcome.error);
      return outcome.value;
    };
    const flush = page => run(page, () => { __otsTrack(window.flushPendingSave()); });
    const settled = page => page.waitForFunction(() => !window.pendingSaveStatus().pending && !window.pendingSaveStatus().readOnly);
    const confirmShown = page => page.evaluate(() => document.getElementById('confirmModal').classList.contains('open'));
    const rename = (page, from, to) => run(page, ([from, to]) => {
      openCustomerModal(from, { viewOnly:false });
      const form = document.getElementById('customerForm');
      form.elements.name.value = to;
      __otsTrack(saveCustomer(form).then(() => window.flushPendingSave()));
    }, [from, to]);
    const addOrderFor = (page, client, id) => page.evaluate(([client, id]) => {
      const copy = JSON.parse(JSON.stringify(state.orders.find(o => o.client === client)));
      Object.assign(copy, { id, num:`K${id}` });
      state.orders.unshift(copy);
      saveState();
      render();
    }, [client, id]);
    const view = async page => page.evaluate(() => ({
      customers:Object.fromEntries(Object.entries(state.customers).map(([name, p]) => [name, p.id])),
      orders:Object.fromEntries(state.orders.map(o => [o.id, `${o.client}#${o.customerId || ''}`]))
    }));
    const dbView = async () => {
      const data = await db();
      return {
        customers:Object.fromEntries(Object.entries(data.customers).map(([name, p]) => [name, p.id])),
        orders:Object.fromEntries(data.orders.map(o => [o.id, `${o.client}#${o.customerId || ''}`]))
      };
    };
    const renamedOrders = extra => ({ ...extra, x1:`Acme Hair Ltd#${ids.acme}`, x2:`Acme Hair Ltd#${ids.acme}`, y1:`Beta Wigs#${ids.beta}` });
    const renamedCustomers = { 'Acme Hair Ltd':ids.acme, 'Beta Wigs':ids.beta };

    // ---- 1. A renames; stale B adds an order for the old name ----
    await seed();
    let A = await openPage();
    let B = await openPage();
    await rename(A, 'Acme Hair', 'Acme Hair Ltd');
    await addOrderFor(B, 'Acme Hair', 'x9');
    await flush(B);
    await settled(B);
    assert.equal(await confirmShown(B), false, 'no conflict dialog');
    await h.waitToast(B, '已合并另一个窗口的修改');
    const expectedA = { customers:renamedCustomers, orders:renamedOrders({ x9:`Acme Hair Ltd#${ids.acme}` }) };
    assert.deepEqual(await view(B), expectedA, 'the new order follows the rename, its id stays');
    assert.deepEqual(await dbView(), expectedA);
    await A.close(); await B.close();

    // ---- 2. A renames; stale B edits the same customer's note: merged, no dialog ----
    await seed();
    A = await openPage();
    B = await openPage();
    await rename(A, 'Acme Hair', 'Acme Hair Ltd');
    await run(B, () => {
      openCustomerModal('Acme Hair', { viewOnly:false });
      const form = document.getElementById('customerForm');
      form.elements.note.value = 'made-up note from B';
      __otsTrack(saveCustomer(form).then(() => window.flushPendingSave()));
    });
    await settled(B);
    assert.equal(await confirmShown(B), false, 'two windows changing different fields of one profile merge without asking');
    assert.deepEqual(await dbView(), { customers:renamedCustomers, orders:renamedOrders() });
    const merged = (await db()).customers['Acme Hair Ltd'];
    assert.equal(merged.note, 'made-up note from B');
    assert.equal(merged.client, 'Acme Hair Ltd');
    assert.equal(merged.history.length, 2, 'both history entries are kept');
    await A.close(); await B.close();

    // ---- 3. The other way round: A adds an order for the old name first, then B renames ----
    await seed();
    A = await openPage();
    B = await openPage();
    await addOrderFor(A, 'Acme Hair', 'x8');
    await flush(A);
    await rename(B, 'Acme Hair', 'Acme Hair Ltd');
    await settled(B);
    assert.equal(await confirmShown(B), false);
    const expectedC = { customers:renamedCustomers, orders:renamedOrders({ x8:`Acme Hair Ltd#${ids.acme}` }) };
    assert.deepEqual(await view(B), expectedC, 'the other window’s new order moves with this window’s rename');
    assert.deepEqual(await dbView(), expectedC);
    await A.close(); await B.close();

    // ---- 4. Conflict text: a profile kept on one side only says who deleted it ----
    B = await openPage();
    const line = await B.evaluate(() => [
      macConflictLine({ path:['customers', 'Gamma Lashes'], mine:{ client:'Gamma Lashes', note:'x' }, theirs:undefined }),
      macConflictLine({ path:['customers', 'Gamma Lashes'], mine:undefined, theirs:{ client:'Gamma Lashes', note:'x' } })
    ]);
    assert.deepEqual(line, ['客户 Gamma Lashes：那边删除了这位客户，本窗口改了资料', '客户 Gamma Lashes：本窗口删除了这位客户，那边改了资料']);
    await B.close();

    // ---- 5. 合并导入 a month file exported before a rename ----
    await seed();
    A = await openPage();
    const fileJson = await A.evaluate(month => {
      const orders = ordersByMonth(month);
      const names = new Set(orders.map(o => o.client));
      const customers = Object.fromEntries(Object.entries(state.customers).filter(([name]) => names.has(name)));
      return JSON.stringify(dataFilePayload({ orders, customers, trashOrders:[], deletedOrders:[] }, { scope:'month', month }));
    }, month);
    await rename(A, 'Acme Hair', 'Acme Hair Ltd');
    await A.evaluate(json => { previewImportDataFile(new File([json], 'month.json', { type:'application/json' })); }, fileJson);
    await A.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    const preview = await A.locator('#confirmMessage').innerText();
    assert.match(preview, /新客户 0 位/, `no new customer in the preview: ${preview}`);
    await h.click(A, '#confirmOkBtn', '合并导入');
    await h.waitToast(A, '已合并导入');
    await flush(A);
    assert.deepEqual(await dbView(), { customers:renamedCustomers, orders:renamedOrders() }, 'orders stay with the renamed customer');
    await A.close();

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], 'no native dialogs');
    console.log('Customer rename across windows UI test passed: stale window adds an order / edits the profile after a rename elsewhere, the reverse, conflict text, merge import of a file from before the rename, real server.');
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => {
  console.error(`Customer rename across windows UI test failed: ${error.stack || error.message}`);
  process.exit(1);
});
