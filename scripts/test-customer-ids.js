#!/usr/bin/env node
// Customers have a fixed id (mac-app/customer-ids.js). Three parts:
// 1. the module: which records get an id, and which renames are read out of a save;
// 2. the one-time fill of a database from before ids: backup first, all or nothing;
// 3. the server on such databases (first import from the JSON file, a database without ids that still has the
//    two tables dropped in V3.146, a restored old backup), and renames arriving through /api/save.
// All names and numbers here are made up.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { validCustomerId, fillCustomerIds, addCustomerIdsOnce, customerRenamesById } = require('../mac-app/customer-ids');
const { createWhatsAppStore } = require('../mac-app/whatsapp-store');
const { freePortSync } = require('./helpers/free-port');

const serverFile = path.join(__dirname, '..', 'mac-app', 'server.js');
const clone = value => JSON.parse(JSON.stringify(value));
const counter = () => { let n = 0; return () => `cust-${String(++n).padStart(4, '0')}`; };
// The data without the two fields: what a version from before ids would have stored.
function withoutIds(data) {
  const copy = clone(data);
  Object.values(copy.customers || {}).forEach(profile => { delete profile.id; });
  ['orders', 'trashOrders', 'deletedOrders'].forEach(bucket => (copy[bucket] || []).forEach(order => { delete order.customerId; }));
  return copy;
}

function checkModule() {
  const data = {
    customers: { 'Birch Beauty':{ country:'US' }, 'Aster Lash Studio':{ country:'UK', id:'kept-id-1' }, 'Cedar Wigs':{ id:'kept-id-1' }, 'Dune Supply':{ id:'no' } },
    orders: [{ id:'o1', client:'Aster Lash Studio' }, { id:'o2', client:'Birch Beauty', customerId:'stale-id-9' }, { id:'o3', client:'Walk-in Buyer' }],
    trashOrders: [{ id:'t1', client:'Cedar Wigs' }],
    deletedOrders: [{ id:'d1', client:'Aster Lash Studio', customerId:'kept-id-1' }]
  };
  const before = clone(data);
  const counts = fillCustomerIds(data, { newId:counter() });
  assert.deepEqual(counts, { profiles:3, orders:3 });
  assert.equal(data.customers['Aster Lash Studio'].id, 'kept-id-1', 'an id that is there stays');
  assert.equal(data.customers['Birch Beauty'].id, 'cust-0001');
  assert.equal(data.customers['Cedar Wigs'].id, 'cust-0002', 'the second profile with the same id gets its own');
  assert.equal(data.customers['Dune Supply'].id, 'cust-0003', 'an id that is not one is replaced');
  assert.equal(data.orders[0].customerId, 'kept-id-1');
  assert.equal(data.orders[1].customerId, 'cust-0001', 'an order follows the profile its client names');
  assert.equal(Object.hasOwn(data.orders[2], 'customerId'), false, 'a client without a profile has no id to give');
  assert.equal(data.trashOrders[0].customerId, 'cust-0002');
  assert.deepEqual(withoutIds(data), withoutIds(before), 'nothing but the two fields is touched');
  assert.deepEqual(fillCustomerIds(data, { newId:counter() }), { profiles:0, orders:0 }, 'a second pass finds nothing to do');
  const generated = fillCustomerIds({ customers:{ A:{}, B:{} } }).profiles;
  assert.equal(generated, 2);
  const real = {}; fillCustomerIds(real.data = { customers:{ A:{}, B:{} } });
  assert.ok(validCustomerId(real.data.customers.A.id) && real.data.customers.A.id !== real.data.customers.B.id);

  const stored = { Aster:{ id:'id-aster' }, Birch:{ id:'id-birch' }, Cedar:{ id:'id-cedar' }, Old:{} };
  const renames = arriving => customerRenamesById(stored, arriving).map(r => `${r.from}>${r.to}`).sort();
  assert.deepEqual(renames({ Aster:{ id:'id-aster' }, Birch:{ id:'id-birch' }, Cedar:{ id:'id-cedar' }, Old:{} }), []);
  assert.deepEqual(renames({ 'Aster 2':{ id:'id-aster' }, Birch:{ id:'id-birch' }, Cedar:{ id:'id-cedar' } }), ['Aster>Aster 2']);
  assert.deepEqual(renames({ 'Aster 2':{ id:'id-aster' }, 'Birch 2':{ id:'id-birch' }, Cedar:{ id:'id-cedar' }, Fresh:{ id:'id-fresh' } }), ['Aster>Aster 2', 'Birch>Birch 2'],
    'two renames and a new customer in one save');
  assert.deepEqual(renames({ Birch:{ id:'id-aster' }, Aster:{ id:'id-birch' }, Cedar:{ id:'id-cedar' } }), ['Aster>Birch', 'Birch>Aster'], 'two customers took each other\'s name');
  assert.deepEqual(renames({ Birch:{ id:'id-aster' }, Cedar:{ id:'id-birch' }, Dune:{ id:'id-cedar' } }), ['Aster>Birch', 'Birch>Cedar', 'Cedar>Dune'], 'a chain');
  assert.deepEqual(renames({ Aster:{ id:'id-other-copy' }, 'Aster 2':{ id:'id-aster' }, Birch:{ id:'id-birch' }, Cedar:{ id:'id-cedar' } }), [],
    'the old name is still there under an id never seen: an older copy came back beside the current one, no rename');
  assert.deepEqual(renames({ 'Aster 2':{ id:'id-aster' }, 'Aster 3':{ id:'id-aster' }, Birch:{ id:'id-birch' } }), [], 'an id that arrives twice says nothing');
  assert.deepEqual(renames({ Birch:{ id:'id-birch' }, Cedar:{ id:'id-cedar' } }), [], 'a deleted customer is not a rename');
}

function customerTables(db) {
  db.exec(`CREATE TABLE customers (name TEXT PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE orders (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata VALUES('revision', '7');`);
  const customer = db.prepare('INSERT INTO customers VALUES(?, ?)');
  customer.run('Aster Lash Studio', JSON.stringify({ country:'UK', note:'pays by transfer' }));
  customer.run('__proto__', JSON.stringify({ country:'US' }));
  const order = db.prepare('INSERT INTO orders VALUES(?, ?)');
  order.run('o1', JSON.stringify({ id:'o1', client:'Aster Lash Studio', amount:120.5 }));
  order.run('o2', JSON.stringify({ id:'o2', client:'Walk-in Buyer', amount:40 }));
}
const dump = db => JSON.stringify([db.prepare('SELECT * FROM customers ORDER BY name').all(), db.prepare('SELECT * FROM orders ORDER BY id').all(), db.prepare('SELECT * FROM metadata').all()]);

function checkOneTimeFill() {
  const db = new DatabaseSync(':memory:');
  customerTables(db);
  const untouched = dump(db);
  const raise = () => db.prepare("UPDATE metadata SET value = '8' WHERE key = 'revision'").run();

  let asked = 0;
  assert.deepEqual(addCustomerIdsOnce(db, { backup:() => { asked += 1; return { ok:false, message:'the backup folder is full' }; }, insideTransaction:raise }), { ok:false, message:'the backup folder is full' });
  assert.equal(dump(db), untouched, 'no backup, no change');
  assert.throws(() => addCustomerIdsOnce(db, { backup:() => ({ ok:true }), insideTransaction:() => { throw new Error('disk went away'); } }), /disk went away/);
  assert.equal(dump(db), untouched, 'a failure inside the transaction leaves nothing behind');

  const result = addCustomerIdsOnce(db, { backup:() => { asked += 1; return { ok:true }; }, insideTransaction:raise, newId:counter() });
  assert.deepEqual(result, { ok:true, profiles:2, orders:1 });
  assert.equal(asked, 2, 'the backup is asked for before anything is written');
  const profile = name => JSON.parse(db.prepare('SELECT data_json FROM customers WHERE name = ?').get(name).data_json);
  assert.deepEqual(profile('Aster Lash Studio'), { country:'UK', note:'pays by transfer', id:'cust-0001' });
  assert.deepEqual(profile('__proto__'), { country:'US', id:'cust-0002' }, 'a profile called __proto__ is a row like any other');
  assert.deepEqual(JSON.parse(db.prepare("SELECT data_json FROM orders WHERE id = 'o1'").get().data_json), { id:'o1', client:'Aster Lash Studio', amount:120.5, customerId:'cust-0001' });
  assert.deepEqual(JSON.parse(db.prepare("SELECT data_json FROM orders WHERE id = 'o2'").get().data_json), { id:'o2', client:'Walk-in Buyer', amount:40 });
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get().value, '8');

  const filled = dump(db);
  assert.deepEqual(addCustomerIdsOnce(db, { backup:() => { asked += 1; return { ok:true }; }, insideTransaction:raise }), { ok:true, profiles:0, orders:0 });
  assert.equal(asked, 2, 'nothing to do: no second backup');
  assert.equal(dump(db), filled);
  db.close();
}

// ---- the server ----
function server(dataDir) {
  let child = null;
  let port = 0;
  const token = `customer-ids-${process.pid}`;
  const nonce = `customer-ids-nonce-${process.pid}`;
  let output = '';
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers:{ Authorization:`Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type':'application/json' }) }, body:body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${data.message || ''}`);
    return data;
  };
  return {
    request,
    output: () => output,
    async start() {
      port = freePortSync();
      child = spawn(process.execPath, [serverFile], {
        env:{ ...process.env, TRADE_APP_DATA_DIR:dataDir, TRADE_APP_PORT:String(port), TRADE_APP_NO_OPEN:'1', TRADE_API_TOKEN:token, TRADE_INSTANCE_NONCE:nonce },
        stdio:['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`the server stopped (${child.exitCode}):\n${output}`);
        try {
          const health = await request('/api/health');
          if (health.instanceNonce === nonce) return health;
        } catch (_) { /* not up yet */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`the server did not answer in 15 s:\n${output}`);
    },
    async stop() {
      if (!child || child.exitCode !== null) { child = null; return; }
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      child = null;
    }
  };
}

const order = (id, client, fields = {}) => ({
  id, num:`K${id.toUpperCase()}`, client, amount:100, paidAmount:0, currency:'USD', stage:'quote', orderMonth:'2020-03', createdAt:'2020-03-02',
  updated:'2020-03-02 09:00', logs:[{ time:'2020-03-02 09:00', text:'created' }], attachments:[], ...fields
});
const legacyData = {
  orders: [order('o1', 'Aster Lash Studio'), order('o2', 'Birch Beauty', { amount:250.75 }), order('o3', 'Walk-in Buyer')],
  trashOrders: [order('t1', 'Cedar Wigs', { trashedAt:'2020-03-05 10:00' })],
  deletedOrders: [order('d1', 'Aster Lash Studio', { deletedAt:'2020-03-06 10:00' })],
  customers: {
    'Aster Lash Studio': { country:'🇬🇧 英国 United Kingdom', emails:['buyer@aster.example'], tags:['睫毛'], history:[{ time:'2020-03-01 08:00', text:'新建客户档案' }] },
    'Birch Beauty': { country:'🇺🇸 美国 United States', phones:['+1 555 0100'], note:'prefers sea freight' },
    'Cedar Wigs': { country:'🇩🇪 德国 Germany' },
    'Dune Supply': { country:'🇫🇷 法国 France' }
  },
  trackingLookups: [],
  demoCleared: true,
  demoCustomersCleared: true
};
const databaseFile = dir => path.join(dir, 'trade-order-system.sqlite');
const migrateBackups = dir => fs.readdirSync(path.join(dir, 'backups')).filter(name => /-before-migrate(?:-\d+)?\.sqlite$/.test(name));
function assertFilled(data, label) {
  const ids = Object.values(data.customers).map(profile => profile.id);
  assert.ok(ids.every(validCustomerId), `${label}: every profile has an id (${JSON.stringify(ids)})`);
  assert.equal(new Set(ids).size, ids.length, `${label}: the ids differ`);
  ['orders', 'trashOrders', 'deletedOrders'].forEach(bucket => data[bucket].forEach(item => {
    const profile = data.customers[item.client];
    if (profile) assert.equal(item.customerId, profile.id, `${label}: ${item.id} carries the id of ${item.client}`);
    else assert.equal(Object.hasOwn(item, 'customerId'), false, `${label}: ${item.id} has no profile to take an id from`);
  }));
}
// Rows as a version from before ids left them, plus the two tables that version still wrote.
function turnIntoOldDatabase(dir) {
  const db = new DatabaseSync(databaseFile(dir));
  const strip = (table, key, field) => db.prepare(`SELECT ${key} AS k, data_json FROM ${table}`).all().forEach(row => {
    const record = JSON.parse(row.data_json);
    delete record[field];
    db.prepare(`UPDATE ${table} SET data_json = ? WHERE ${key} = ?`).run(JSON.stringify(record), row.k);
  });
  strip('customers', 'name', 'id');
  strip('orders', 'id', 'customerId');
  db.exec(`CREATE TABLE IF NOT EXISTS order_attachments (order_id TEXT, position INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS order_logs (order_id TEXT, position INTEGER, data_json TEXT);
    INSERT INTO order_logs VALUES('o1', 0, '{"text":"created"}');`);
  const revision = Number(db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get().value);
  db.close();
  return revision;
}
function bindChat(dir, customer, chatId) {
  const db = new DatabaseSync(databaseFile(dir));
  const store = createWhatsAppStore(db);
  const chat = { account:'15550001111@c.us', chatId, title:`chat of ${customer}` };
  store.bind({ ...chat, customer });
  store.sync({ ...chat, messages:[{ id:`m-${chatId}`, direction:'in', kind:'text', text:`hello from ${customer}`, timestamp:'' }] });
  db.close();
}

async function checkServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-customer-ids-'));
  const app = server(dir);
  try {
    // --- first start on the JSON file of the oldest versions ---
    fs.writeFileSync(path.join(dir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', data:legacyData }));
    await app.start();
    const imported = await app.request('/api/data');
    assertFilled(imported.data, 'first import');
    assert.deepEqual(withoutIds(imported.data), withoutIds(legacyData), 'first import: the data is the file, plus the two fields');
    assert.deepEqual(migrateBackups(dir), [], 'first import: the file itself is archived, no extra backup');
    await app.stop();

    // --- a database from before ids ---
    const oldRevision = turnIntoOldDatabase(dir);
    bindChat(dir, 'Birch Beauty', '15551230001@c.us');
    bindChat(dir, 'Cedar Wigs', '15551230002@c.us');
    await app.start();
    const migrated = await app.request('/api/data');
    assertFilled(migrated.data, 'old database');
    assert.deepEqual(withoutIds(migrated.data), withoutIds(legacyData), 'old database: nothing else changed');
    assert.equal(migrated.revision, oldRevision + 1, 'a window that was still open would be told its copy is old');
    const [backupName, ...more] = migrateBackups(dir);
    assert.ok(backupName && !more.length, `one backup before the change: ${JSON.stringify(migrateBackups(dir))}`);
    const backup = new DatabaseSync(path.join(dir, 'backups', backupName), { readOnly:true });
    assert.ok(backup.prepare('SELECT data_json FROM customers').all().every(row => !Object.hasOwn(JSON.parse(row.data_json), 'id')), 'the backup holds the data as it was before');
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 5);
    backup.close();
    assert.equal((await app.request('/api/backups')).backups.find(item => item.name === backupName)?.reason, 'migrate', 'the backup is listed with its reason');
    const idsAfterMigration = Object.fromEntries(Object.entries(migrated.data.customers).map(([name, profile]) => [name, profile.id]));
    await app.stop();
    await app.start();
    const again = await app.request('/api/data');
    assert.deepEqual(Object.fromEntries(Object.entries(again.data.customers).map(([name, profile]) => [name, profile.id])), idsAfterMigration, 'a second start gives no new ids');
    assert.equal(again.revision, migrated.revision);
    assert.equal(migrateBackups(dir).length, 1, 'and makes no second backup');

    // --- renames through /api/save: by id, several in one save, the chats follow ---
    const chats = async name => (await app.request(`/api/whatsapp/messages?customer=${encodeURIComponent(name)}`)).messages.map(message => message.text);
    const save = async (state, extra = {}) => {
      const result = await app.request('/api/save', { method:'POST', body:{ state, baseRevision:state.revision, ...extra } });
      return { ...(await app.request('/api/data')), saved:result };
    };
    const rename = (state, from, to) => {
      state.data.customers[to] = state.data.customers[from];
      if (from !== to) delete state.data.customers[from];
      ['orders', 'trashOrders', 'deletedOrders'].forEach(bucket => state.data[bucket].forEach(item => { if (item.client === from) item.client = to; }));
    };
    // Two renames and a new customer in one save: the old rules could not tell who became whom.
    let state = clone(again);
    rename(state, 'Birch Beauty', 'Birch Beauty Inc');
    rename(state, 'Cedar Wigs', 'Cedar Hair');
    state.data.customers['Elm Trading'] = { country:'🇪🇸 西班牙 Spain', id:'elm-trading-id' };
    state = await save(state);
    assert.deepEqual(await chats('Birch Beauty Inc'), ['hello from Birch Beauty']);
    assert.deepEqual(await chats('Cedar Hair'), ['hello from Cedar Wigs']);
    assert.deepEqual(await chats('Elm Trading'), []);
    // The two take each other's name.
    const birch = state.data.customers['Birch Beauty Inc'];
    const cedar = state.data.customers['Cedar Hair'];
    state = clone(state);
    state.data.customers['Birch Beauty Inc'] = cedar;
    state.data.customers['Cedar Hair'] = birch;
    ['orders', 'trashOrders', 'deletedOrders'].forEach(bucket => state.data[bucket].forEach(item => {
      if (item.client === 'Birch Beauty Inc') item.client = 'Cedar Hair';
      else if (item.client === 'Cedar Hair') item.client = 'Birch Beauty Inc';
    }));
    state = await save(state);
    assert.deepEqual(await chats('Cedar Hair'), ['hello from Birch Beauty'], 'the chats stay with the customer, not with the name');
    assert.deepEqual(await chats('Birch Beauty Inc'), ['hello from Cedar Wigs']);
    // A whole-data save with guessing switched off (import): a rename by id is not a guess and still counts.
    state = clone(state);
    rename(state, 'Cedar Hair', 'Birch Beauty');
    state = await save(state, { customerInference:false });
    assert.deepEqual(await chats('Birch Beauty'), ['hello from Birch Beauty']);
    // A deleted customer and a new one in the same save are two people: the chat stays on the deleted name.
    state = clone(state);
    delete state.data.customers['Birch Beauty'];
    state.data.orders = state.data.orders.filter(item => item.client !== 'Birch Beauty');
    state.data.customers['Fir Cosmetics'] = { country:'🇮🇹 意大利 Italy', id:'fir-cosmetics-id' };
    state = await save(state);
    assert.deepEqual(await chats('Fir Cosmetics'), [], 'by id these are two customers; the old rule read "one gone, one new" as a rename');
    // A merge names its own move, and the page keeps the list of chats the server answers with for the undo.
    // Here the kept customer had no profile, so the merged profile carries the id of the one merged in: read as
    // a rename by id first, the named move would find no chat left and answer with an empty list.
    const beforeMerge = clone(state);
    state = clone(state);
    rename(state, 'Birch Beauty Inc', 'Walk-in Buyer');
    state = await save(state, { customerMoves:[{ id:'merge-1', from:'Birch Beauty Inc', to:'Walk-in Buyer' }] });
    const moved = state.saved.movedChats?.find(item => item.id === 'merge-1')?.chats || [];
    assert.deepEqual(moved.map(chat => chat.chatId), ['15551230002@c.us'], 'the merge reports the chat it moved');
    assert.deepEqual(await chats('Walk-in Buyer'), ['hello from Cedar Wigs']);
    const undone = { ...clone(beforeMerge), revision:state.revision };
    state = await save(undone, { customerMoves:[{ id:'merge-1-undo', from:'Walk-in Buyer', to:'Birch Beauty Inc', chats:moved }] });
    assert.deepEqual(await chats('Birch Beauty Inc'), ['hello from Cedar Wigs'], 'the undo gives back the chat the merge moved');
    assert.deepEqual(await chats('Walk-in Buyer'), []);
    await app.stop();

    // --- an old backup restored into the migrated app ---
    const before = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-customer-ids-old-'));
    try {
      fs.copyFileSync(path.join(dir, 'backups', backupName), path.join(before, backupName));
      await app.start();
      fs.copyFileSync(path.join(before, backupName), path.join(dir, 'backups', backupName));
      const restored = await app.request('/api/restore-backup', { method:'POST', body:{ name:backupName } });
      const afterRestore = await app.request('/api/data');
      assertFilled(afterRestore.data, 'restored backup');
      assert.deepEqual(withoutIds(afterRestore.data), withoutIds(legacyData), 'restored backup: the data of the backup, plus the two fields');
      assert.equal(afterRestore.revision, restored.revision, 'the restore answers with the revision the data now has');
    } finally { fs.rmSync(before, { recursive:true, force:true }); }
    assert.doesNotMatch(app.output(), /Customer ids were not added/);
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive:true, force:true });
  }
}

(async () => {
  checkModule();
  checkOneTimeFill();
  await checkServer();
  console.log('Customer ids passed: ids for profiles and their orders only, renames read by id (several at once, swapped names, a chain; not from a copy or a delete), one-time fill with backup first and all or nothing, first import, old database, restored backup, chats follow the customer.');
})().catch(error => { console.error(error); process.exitCode = 1; });
