#!/usr/bin/env node
// Customer ids in the page, on the path an installed app takes: a database from before ids, the real server
// (which adds the ids on its first start, after a backup), then the real page with keyboard and mouse.
// - opening the app after that saves nothing by itself, and the backup shows up as 「数据升级前」 with nothing to restore;
// - editing a customer, renaming it, deleting it and undoing: the id stays, and the orders carry it;
// - a new customer gets its own id; an order whose customer gets a profile only now takes that id.
// What the server does with those ids (chats following a rename, several renames in one save) is in test-customer-ids.js.
// All names and numbers are made up.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');
const { validCustomerId } = require('../mac-app/customer-ids');

const root = path.resolve(__dirname, '..');
const base = { currency:'USD', logisticsStatus:'未发货', createdAt:'2020-03-02', orderMonth:'2020-03', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', updated:'2020-03-02 09:00', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30, orderType:'定金订单', stage:'production', shipments:[], attachments:[] };
const order = (id, client, extra = {}) => ({ ...base, id, num:`K7${id.toUpperCase()}`, client, ...extra });
const fixture = {
  orders:[order('a1', 'Aster Lash Studio'), order('a2', 'Aster Lash Studio'), order('b1', 'Birch Beauty'), order('w1', 'Passing Buyer')],
  trashOrders:[order('a3', 'Aster Lash Studio', { trashedAt:'2020-03-05 10:00' })],
  deletedOrders:[],
  customers:{
    'Aster Lash Studio':{ client:'Aster Lash Studio', country:'🇬🇧 英国 United Kingdom', emails:['buyer@aster.example'], email:'buyer@aster.example', note:'aster note' },
    'Birch Beauty':{ client:'Birch Beauty', country:'🇺🇸 美国 United States', note:'birch note' },
    'Cedar Wigs':{ client:'Cedar Wigs', country:'🇩🇪 德国 Germany', note:'no orders yet' }
  },
  trackingLookups:[]
};

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-customer-ids-ui-'));
  fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:1, data:{ doneTasks:{}, demoCleared:true, demoCustomersCleared:true, ...fixture } }));
  const port = freePortSync();
  const token = 'customer-ids-ui-test-token';
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', DHL_API_KEY:'', FEDEX_CLIENT_ID:'', FEDEX_CLIENT_SECRET:'' };
  const url = `http://127.0.0.1:${port}`;
  let server = null;
  const startServer = async () => {
    server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${url}/api/health`)).ok; } catch (_) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'server starts');
  };
  const stopServer = async () => {
    if (!server) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
    server = null;
  };
  const api = async (route, body) => (await fetch(url + route, { method:body ? 'POST' : 'GET', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) })).json();
  const native = (action, payload = {}) => {
    const bytes = Buffer.from(JSON.stringify({ action, payload }));
    const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
    const result = spawnSync(process.execPath, [path.join(root, 'mac-app/whatsapp-native-host.js')], { env, input:Buffer.concat([length, bytes]), timeout:10000 });
    return JSON.parse(result.stdout.subarray(4));
  };
  let browser;
  try {
    // The server turns the JSON file into a database; the two id fields are then taken out again, which leaves
    // the database as a version from before ids wrote it.
    await startServer();
    await stopServer();
    const old = new DatabaseSync(path.join(dataDir, 'trade-order-system.sqlite'));
    [['customers', 'name', 'id'], ['orders', 'id', 'customerId']].forEach(([table, key, field]) => {
      old.prepare(`SELECT ${key} AS k, data_json FROM ${table}`).all().forEach(row => {
        const record = JSON.parse(row.data_json);
        delete record[field];
        old.prepare(`UPDATE ${table} SET data_json = ? WHERE ${key} = ?`).run(JSON.stringify(record), row.k);
      });
    });
    old.close();
    await startServer();
    const migrated = await api('/api/data');
    const idOf = Object.fromEntries(Object.entries(migrated.data.customers).map(([name, profile]) => [name, profile.id]));
    assert.ok(Object.values(idOf).every(validCustomerId) && new Set(Object.values(idOf)).size === 3, `the first start gave every customer an id: ${JSON.stringify(idOf)}`);
    const chat = { account:'15550001111@c.us', chatId:'15551230001@c.us', customer:'Aster Lash Studio', title:'Aster' };
    assert.equal(native('bind', chat).ok, true);
    assert.equal(native('sync', { ...chat, messages:[{ id:'m1', direction:'in', kind:'text', timestamp:'[10:20, 02/03/2020]', text:'hello from Aster' }] }).inserted, 1);
    const chatCount = async name => (await api(`/api/whatsapp/messages?customer=${encodeURIComponent(name)}`)).total;

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 } });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${url}/trade-order-system.html?token=${token}`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const flush = async () => assert.equal(await page.evaluate(() => window.flushPendingSave()), true, 'saved to the database');
    const db = async () => (await api('/api/data')).data;
    const settleModal = () => h.settle(page, '#customerModal .modal');
    const saveCustomer = async () => {
      await h.click(page, '#customerHeaderSaveBtn');
      await page.waitForFunction(() => document.getElementById('customerForm').dataset.saving !== 'true');
      await flush();
    };
    // The caret is put at the end by the page's own API: the End key moves it in Chromium and only scrolls in WebKit on macOS.
    const typeAtEnd = async (selector, text) => {
      await page.locator(selector).click();
      await page.locator(selector).evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
      await page.keyboard.type(text, { delay:5 });
    };
    const closeCustomer = async () => {
      if (!await page.evaluate(() => document.getElementById('customerModal').classList.contains('open'))) return;
      await h.click(page, '#closeCustomerModalBtn');
      await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
    };

    // ---- 1. Opening the app on the migrated database: the page has the ids, and writes nothing on its own ----
    await page.evaluate(() => setPage('customers'));
    await page.waitForSelector('.customer-row[data-view-customer="Cedar Wigs"]');
    await h.waitPageTime(page, 700);
    await flush();
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(state.customers).map(([name, profile]) => [name, profile.id]))), idOf);
    assert.equal((await api('/api/data')).revision, migrated.revision, 'opening the app saved nothing');

    // The backup made before the ids were added is in the list under its own name, and restoring it would
    // change nothing the user sees.
    await page.evaluate(() => setPage('settings'));
    await page.waitForSelector('#macRestoreBackupBtn', { state:'visible' });
    await h.click(page, '#macRestoreBackupBtn');
    const row = page.locator('#macRestoreList .backup-restore-item', { hasText:'数据升级前' });
    await row.waitFor();
    assert.equal(await row.count(), 1, 'one backup from before the ids');
    await h.click(page, row.locator('[data-restore-backup]'), 'preview the backup from before the ids');
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await h.settle(page, '#confirmModal .modal');
    const preview = await page.locator('#confirmMessage').textContent();
    assert.match(preview, /数据升级前的快照/);
    assert.match(preview, /订单（含垃圾箱、已删除）：新增 0、修改 0、删除 0/, preview);
    assert.match(preview, /客户：新增 0、修改 0、删除 0/, preview);
    await h.click(page, '#confirmCancelBtn');
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    await page.evaluate(() => setPage('customers'));
    await page.waitForSelector('.customer-row[data-view-customer="Cedar Wigs"]');

    // ---- 2. Editing a customer keeps the id ----
    await page.evaluate(() => openCustomerModal('Birch Beauty', { viewOnly:false }));
    await settleModal();
    await typeAtEnd('#customerForm [name="note"]', ' EDITED');
    await saveCustomer();
    let data = await db();
    assert.match(data.customers['Birch Beauty'].note, /birch note EDITED/);
    assert.equal(data.customers['Birch Beauty'].id, idOf['Birch Beauty'], 'an edit keeps the id');
    await closeCustomer();

    // ---- 3. Renaming keeps it too: the same id under the new name, on every order, and the chats follow ----
    await page.evaluate(() => openCustomerModal('Aster Lash Studio', { viewOnly:false }));
    await settleModal();
    await typeAtEnd('#customerForm [name="name"]', ' Ltd');
    await saveCustomer();
    data = await db();
    assert.equal(Object.hasOwn(data.customers, 'Aster Lash Studio'), false);
    assert.equal(data.customers['Aster Lash Studio Ltd']?.id, idOf['Aster Lash Studio'], 'the renamed customer is the same customer');
    assert.deepEqual([...data.orders, ...data.trashOrders].filter(o => /^a/.test(o.id)).map(o => [o.client, o.customerId]),
      Array(3).fill(['Aster Lash Studio Ltd', idOf['Aster Lash Studio']]), 'its orders, the one in the trash too, carry the new name and the same id');
    assert.deepEqual([await chatCount('Aster Lash Studio Ltd'), await chatCount('Aster Lash Studio')], [1, 0], 'the chat followed');
    await closeCustomer();

    // ---- 4. A new customer gets its own id ----
    await page.evaluate(() => openCustomerModal());
    await settleModal();
    await typeAtEnd('#customerForm [name="name"]', 'Dune Supply');
    await saveCustomer();
    data = await db();
    const duneId = data.customers['Dune Supply']?.id;
    assert.ok(validCustomerId(duneId) && !Object.values(idOf).includes(duneId), `a new customer has an id of its own: ${duneId}`);
    await closeCustomer();

    // ---- 5. An order of a customer without a profile carries no id until the profile is there ----
    assert.equal(Object.hasOwn(data.orders.find(o => o.id === 'w1'), 'customerId'), false);
    await page.evaluate(() => openCustomerModal('Passing Buyer', { viewOnly:false }));
    await settleModal();
    await typeAtEnd('#customerForm [name="note"]', 'profile made later');
    await saveCustomer();
    data = await db();
    const walkInId = data.customers['Passing Buyer']?.id;
    assert.ok(validCustomerId(walkInId) && walkInId !== duneId, `the late profile has an id of its own: ${walkInId}`);
    assert.equal(data.orders.find(o => o.id === 'w1').customerId, walkInId, 'the order takes the id of the profile it now has');
    await closeCustomer();

    // ---- 6. Deleting and undoing brings the same customer back ----
    await h.click(page, '.customer-row[data-view-customer="Cedar Wigs"]');
    await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
    await settleModal();
    await h.click(page, '#customerDeleteBtn');
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await h.settle(page, '#confirmModal .modal');
    await h.click(page, '#confirmOkBtn');
    await h.waitToast(page, '已删除客户 Cedar Wigs');
    await flush();
    assert.equal(Object.hasOwn((await db()).customers, 'Cedar Wigs'), false);
    await h.clickUndo(page, '已删除客户 Cedar Wigs');
    await h.waitToast(page, '已撤销：Cedar Wigs');
    await flush();
    data = await db();
    assert.equal(data.customers['Cedar Wigs']?.id, idOf['Cedar Wigs'], 'the undo brings back the customer, id and all');

    // Every profile has an id, no two share one.
    const finalIds = Object.values(data.customers).map(profile => profile.id);
    assert.ok(finalIds.every(validCustomerId) && new Set(finalIds).size === finalIds.length, JSON.stringify(finalIds));
    await closeCustomer();

    // ---- 7. Old data is the server's to fill, after its backup. When it could not (no backup was possible),
    // the page reads profiles without ids and does not add them behind the server's back ----
    await page.route('**/api/data', async route => {
      const response = await route.fetch();
      const body = await response.json();
      Object.values(body.data.customers).forEach(profile => { delete profile.id; });
      ['orders', 'trashOrders', 'deletedOrders'].forEach(bucket => body.data[bucket].forEach(item => { delete item.customerId; }));
      await route.fulfill({ response, json:body });
    });
    const posted = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/save') posted.push(request.postDataJSON()); });
    await page.reload();
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('customers'));
    await page.waitForSelector('.customer-row[data-view-customer="Cedar Wigs"]');
    await h.waitPageTime(page, 700);
    await flush();
    assert.deepEqual(posted, [], 'reading data without ids saves nothing');
    await page.evaluate(() => openCustomerModal('Birch Beauty', { viewOnly:false }));
    await settleModal();
    await typeAtEnd('#customerForm [name="note"]', ' AGAIN');
    await saveCustomer();
    assert.equal(posted.length, 1);
    const sent = posted[0].state.data || posted[0].state;
    assert.match(sent.customers['Birch Beauty'].note, /EDITED AGAIN/);
    assert.ok(Object.values(sent.customers).every(profile => !Object.hasOwn(profile, 'id')) && sent.orders.every(item => !Object.hasOwn(item, 'customerId')),
      'the save carries the edit and no ids of the page\'s own making');
    assert.deepEqual(errors, []);
    console.log('Customer ids UI test passed: nothing saved on open, the backup from before the ids listed, the id kept through edit, rename and delete + undo, new customers and late profiles get their own.');
  } finally {
    if (browser) await browser.close();
    await stopServer();
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
