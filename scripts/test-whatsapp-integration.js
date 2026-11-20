const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { installWhatsAppFixture } = require('./helpers/whatsapp-fixture');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-whatsapp-test-'));
const port = require('./helpers/free-port').freePortSync();
const base = `http://127.0.0.1:${port}`;
const token = 'isolated-whatsapp-test';
let child, browser;
const env = { ...process.env, TRADE_APP_DATA_DIR:directory, TRADE_APP_PORT:String(port), TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1' };
function native(action, payload = {}) {
  const bytes = Buffer.from(JSON.stringify({ action, payload }));
  const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
  const result = spawnSync(process.execPath, [path.join(root, 'mac-app/whatsapp-native-host.js')], { env, input:Buffer.concat([length, bytes]), timeout:10000 });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout.readUInt32LE(0), result.stdout.length - 4, 'native response framing');
  return JSON.parse(result.stdout.subarray(4));
}
async function request(route, body) {
  const response = await fetch(base + route, { method:body ? 'POST' : 'GET', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) });
  assert.equal(response.status, 200);
  return response.json();
}
(async () => {
  child = spawn(process.execPath, [path.join(root, 'mac-app/server.js')], { env, stdio:'ignore' });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/api/health', { headers:{ Connection:'close' } }); if (r.ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ready, 'isolated server starts');
  const state = await request('/api/data');
  state.data.customers = { Alice:{ phone:'+15551234567' }, Bob:{ phone:'+22222222222' } };
  state.data.orders = []; state.data.trashOrders = []; state.data.deletedOrders = [];
  await request('/api/save', { state, baseRevision:state.revision });
  const marker = path.join(directory, 'sqlite-storage.json');
  const existingMarker = fs.readFileSync(marker);
  fs.writeFileSync(marker, JSON.stringify({ databaseId:'a-different-database' }));
  for (const action of ['status','search','bind','sync']) {
    assert.match(native(action).message, /identity does not match/, `an unrecognized database rejects ${action}`);
  }
  const foreign = new DatabaseSync(path.join(directory, 'trade-order-system.sqlite'), { readOnly:true });
  assert.equal(foreign.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'whatsapp_%'").get().n, 0);
  foreign.close();
  fs.writeFileSync(marker, existingMarker);
  // An installed candidate can already have a matching marker, but recovery may still roll it back.
  const restoring = path.join(directory, 'restore-pending.json');
  fs.writeFileSync(restoring, JSON.stringify({ id:'active-restore' }));
  assert.match(native('bind', { account:'15550001111@c.us', chatId:'15551234567@c.us', customer:'Alice' }).message, /正在恢复备份/);
  fs.unlinkSync(restoring);
  assert.equal(native('status').ok, true);
  assert.equal(native('delete').ok, false);
  assert.equal(native('search', { phone:'+1 5551234567' }).customers[0].name, 'Alice');
  const chat = { account:'15550001111@c.us', chatId:'15551234567@c.us', customer:'Alice', title:'Alice' };
  assert.equal(native('bind', chat).ok, true);
  const messages = [{ id:'fixture-1', direction:'in', kind:'text', timestamp:'[10:20, 21/09/2026]', text:'<img src=x onerror="window.injected=true"> Hello from fixture' }];
  assert.equal(native('sync', { ...chat, messages }).inserted, 1);
  assert.equal(native('sync', { ...chat, messages }).inserted, 0);
  assert.equal((await fetch(base + '/api/whatsapp/messages?customer=Alice')).status, 401);
  assert.equal((await fetch(base + '/api/whatsapp/messages?customer=Alice', { headers:{ Authorization:`Bearer ${token}`, Origin:'https://untrusted.example' } })).status, 403);
  const beforeSave = await request('/api/data');
  await request('/api/save', { state:beforeSave, baseRevision:beforeSave.revision });
  assert.equal((await request('/api/whatsapp/messages?customer=Alice')).total, 1, 'normal save must preserve chats');

  browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport:{ width:1280, height:900 } });
  await page.setExtraHTTPHeaders({ 'X-Trade-Token':token });
  await page.route('**/trade-order-system.html*', route => route.fulfill({ contentType:'text/html', body:fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8') }));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/trade-order-system.html?token=' + token);
  await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  await page.evaluate(() => openCustomerModal('Alice'));
  await page.locator('[data-customer-detail-tab="whatsapp"]').click();
  await page.waitForFunction(() => document.getElementById('customerWhatsAppThread').innerText.includes('Hello from fixture'));
  assert.match(await page.locator('#customerWhatsAppThread').innerText(), /<img src=x/);
  assert.equal(await page.locator('#customerWhatsAppThread img').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  if (process.env.WA_SCREENSHOT) await page.locator('#customerWhatsAppDetails').screenshot({ path:`${process.env.WA_SCREENSHOT}.customer.png`, animations:'disabled' });
  assert.deepEqual(errors, []);

  // Exercise the real content UI with a native bridge into the isolated database.
  const fixture = await browser.newPage({ viewport:{ width:1100, height:820 } });
  await fixture.route('https://web.whatsapp.com/**', route => route.fulfill({ contentType:'text/html', body:'<main id="main"><header>Alice</header></main>' }));
  await fixture.goto('https://web.whatsapp.com/');
  let delaySearch = false, releaseSearch, searchPending = false;
  const syncBytes = [];
  await fixture.exposeFunction('nativeFixture', async ({ action, payload }) => {
    if (action === 'sync') syncBytes.push(Buffer.byteLength(JSON.stringify({ action, payload })));
    if (delaySearch && action === 'search' && payload.chatId === '22222222222@c.us') {
      searchPending = true;
      await new Promise(resolve => { releaseSearch = resolve; });
    }
    return native(action, payload);
  });
  await fixture.setContent(`<html><body style="background:#e9efeb;font:16px sans-serif;padding:40px"><main id="main"><header><span title="Alice">Alice</span></header><div class="message-in" data-id="false_15551234567@c.us_AAA"><div data-pre-plain-text="[10:30, 21/09/2026] Alice: "><span class="selectable-text">Could you send me the order update?</span></div></div></main></body></html>`);
  await installWhatsAppFixture(fixture);
  await fixture.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) { const shadow = attach.call(this, init); window.fixtureShadow = shadow; return shadow; };
    const settings = {};
    const listeners = [];
    window.settingsFixture = { settings, revokeDuringRead:false, notify(changes) { listeners.forEach(fn => fn(changes, 'local')); } };
    window.chrome = { runtime:{ lastError:null, onMessage:{ addListener() {} }, sendMessage(message, callback) { window.nativeFixture(message).then(callback); } }, storage:{ onChanged:{ addListener(fn) { listeners.push(fn); } }, local:{ async get() {
      // Let a peer tab revoke auto-sync after polling read the old value but before a batch is submitted.
      const values = { ...settings };
      if (settingsFixture.revokeDuringRead) {
        settings[settingsFixture.revokeDuringRead] = false;
        settingsFixture.revokeDuringRead = false;
      }
      return values;
    }, async set(next) { Object.assign(settings, next); } } } };
  });
  await fixture.addScriptTag({ path:path.join(root, 'chrome-extension/whatsapp-sync/wa-page.js') });
  await fixture.addScriptTag({ path:path.join(root, 'chrome-extension/whatsapp-sync/collector.js') });
  await fixture.addScriptTag({ path:path.join(root, 'chrome-extension/whatsapp-sync/content.js') });
  await fixture.evaluate(() => { fixtureShadow.querySelector('.launcher').click(); });
  await fixture.waitForFunction(() => fixtureShadow.getElementById('binding').textContent.includes('已关联'));
  assert.equal(await fixture.evaluate(() => fixtureShadow.getElementById('account').value), '15550001111@c.us');
  assert.equal(await fixture.evaluate(() => fixtureShadow.getElementById('account').readOnly), true);
  assert.equal(native('status').messages, 1, 'opening/associating a chat must not sync until asked');
  const beforeSync = await request('/api/backup-before-change', { reason:'import' });
  await fixture.evaluate(() => fixtureShadow.getElementById('sync').click());
  await fixture.waitForFunction(() => fixtureShadow.getElementById('status').textContent.startsWith('已同步'));
  assert.equal(native('status').messages, 2);
  await request('/api/restore-backup', { name:beforeSync.name });
  assert.equal(native('status').messages, 1);
  await fixture.evaluate(async () => { await fixtureShadow.getElementById('sync').onclick(); });
  assert.equal(native('status').messages, 2, 'manual sync restores messages that only the tab remembers');

  // A second tab writing this chat's switch changes the active tab and is checked again before a batch.
  const keepOther = 'tradeWhatsAppAuto:["other-account","other-chat"]';
  const preference = await fixture.evaluate(async other => {
    const {settings, notify} = settingsFixture;
    settings[other] = true;
    const auto = fixtureShadow.getElementById('auto');
    auto.checked = true;
    await auto.onchange();
    const name = 'tradeWhatsAppAuto:' + JSON.stringify([fixtureWA.account, fixtureWA.peer]);
    const ownSetting = settings[name];
    settings[name] = false;
    notify({[name]:{oldValue:true,newValue:false}});
    return [ownSetting, auto.checked, settings[other]];
  }, keepOther);
  assert.deepEqual(preference, [true,false,true], 'tabs observe revocation and leave unrelated settings intact');
  const callsBeforeRevoke = syncBytes.length;
  await fixture.evaluate(() => {
    fixtureWA.messages.push({ ...fixtureWA.messages[0], id:{ ...fixtureWA.messages[0].id, _serialized:'false_15551234567@c.us_IGNORED' } });
    const name = 'tradeWhatsAppAuto:' + JSON.stringify([fixtureWA.account, fixtureWA.peer]);
    settingsFixture.settings[name] = true;
    settingsFixture.revokeDuringRead = name;
    fixtureShadow.querySelector('.launcher').click();
  });
  await fixture.waitForFunction(() => !settingsFixture.revokeDuringRead && !fixtureShadow.getElementById('auto').checked && !fixtureShadow.getElementById('sync').disabled);
  assert.equal(syncBytes.length, callsBeforeRevoke, 'revoking permission between polling and submission prevents the native write');
  await fixture.evaluate(() => fixtureWA.messages.pop());
  if (process.env.WA_SCREENSHOT) await fixture.screenshot({ path:`${process.env.WA_SCREENSHOT}.extension.png`, animations:'disabled' });
  // A message shell may hydrate after its stable ID has already been acknowledged.
  await fixture.evaluate(() => { fixtureWA.messages.push({ id:{ _serialized:'false_15551234567@c.us_LATE', remote:{ _serialized:'15551234567@c.us' }, fromMe:false }, type:'unknown', t:1700000001 }); fixtureShadow.getElementById('sync').click(); });
  await fixture.waitForFunction(() => fixtureShadow.getElementById('status').textContent.includes('新增 1 条') && !fixtureShadow.getElementById('sync').disabled);
  assert.equal(native('status').messages, 3);
  await fixture.evaluate(() => { Object.assign(fixtureWA.messages[1], { type:'chat', body:'Loaded later' }); fixtureShadow.getElementById('sync').click(); });
  await fixture.waitForFunction(() => fixtureShadow.getElementById('status').textContent.includes('补全 1 条'));
  assert.equal((await request('/api/whatsapp/messages?customer=Alice')).messages.some(row => row.text === 'Loaded later'), true);
  // Valid Unicode snapshots can exceed native framing limits when batched only by count.
  syncBytes.length = 0;
  await fixture.evaluate(() => {
    fixtureWA.messages = Array.from({ length:100 }, (_, index) => ({ id:{ _serialized:`false_15551234567@c.us_LARGE${index}`, remote:{ _serialized:'15551234567@c.us' }, fromMe:false }, type:'chat', body:'中'.repeat(15000), t:1700000002 }));
    fixtureShadow.getElementById('sync').click();
  });
  await fixture.waitForFunction(() => !fixtureShadow.getElementById('sync').disabled);
  assert.equal(native('status').messages, 103, 'all accepted Unicode messages must persist');
  assert.ok(syncBytes.length > 1 && syncBytes.every(size => size < 4 * 1024 * 1024), 'native batches fit the byte limit');
  // Changing chats must immediately discard candidates, even while native search waits.
  await fixture.evaluate(() => { fixtureWA.account='15550002222@c.us'; fixtureShadow.querySelector('.launcher').click(); });
  await fixture.waitForFunction(() => !fixtureShadow.getElementById('bind').disabled);
  assert.equal(await fixture.evaluate(() => fixtureShadow.getElementById('customers').value), 'Alice');
  delaySearch = true;
  await fixture.evaluate(() => { fixtureWA.peer='22222222222@c.us'; fixtureWA.title='Bob'; fixtureWA.messages=[]; fixtureShadow.querySelector('.launcher').click(); });
  for (let i = 0; i < 50 && !searchPending; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(searchPending, true);
  assert.equal(await fixture.evaluate(() => fixtureShadow.getElementById('bind').disabled), true);
  assert.equal(await fixture.evaluate(() => fixtureShadow.getElementById('customers').value), '');
  await fixture.evaluate(() => fixtureShadow.getElementById('bind').click());
  assert.equal(native('search', { account:'15550002222@c.us', chatId:'22222222222@c.us' }).binding, null);
  delaySearch = false; releaseSearch();
  await fixture.waitForFunction(() => fixtureShadow.getElementById('customers').value === 'Bob' && !fixtureShadow.getElementById('bind').disabled);
  // The customer disappeared in OTS. Reopening the original chat must expose the rebind controls.
  const withoutAlice = await request('/api/data');
  delete withoutAlice.data.customers.Alice;
  await request('/api/save', { state:withoutAlice, baseRevision:withoutAlice.revision, customerDeletes:['Alice'] });
  await fixture.evaluate(() => {
    fixtureWA.account='15550001111@c.us'; fixtureWA.peer='15551234567@c.us';
    fixtureShadow.querySelector('.launcher').click();
  });
  await fixture.waitForFunction(() => fixtureShadow.getElementById('binding').textContent.includes('已删除'));
  assert.equal(await fixture.evaluate(() => fixtureShadow.getElementById('linkControls').hidden), false);
  await fixture.evaluate(async () => {
    fixtureShadow.getElementById('query').value = 'Bob';
    await fixtureShadow.getElementById('search').onclick();
    fixtureShadow.getElementById('customers').value = 'Bob';
    fixtureShadow.getElementById('customers').onchange();
    await fixtureShadow.getElementById('bind').onclick();
  });
  assert.equal(native('search', chat).binding.customer, 'Bob');
  assert.equal(native('status').messages, 103, 'explicit rebind retains the message history');
  await fixture.emulateMedia({ colorScheme:'dark' });
  await fixture.setViewportSize({ width:390, height:844 });
  await fixture.evaluate(() => { fixtureShadow.querySelector('.panel').hidden = false; });
  if (process.env.WA_SCREENSHOT) await fixture.screenshot({ path:`${process.env.WA_SCREENSHOT}.narrow-dark.png`, animations:'disabled' });
  console.log('WhatsApp integration passed: native protocol, auth, persistence across saves, escaped customer UI, explicit-sync content UI.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  fs.rmSync(directory, { recursive:true, force:true });
});
