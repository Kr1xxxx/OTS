#!/usr/bin/env node
// Regression tests for the V3.117 full audit: paste recognition (amount / currency / tracking),
// AI JSON odd replies, case-variant customers, repeated order numbers (page + server 422),
// drawer validation, stage moves that give back the settle-time payment, shared tracking numbers,
// reminders on finished orders, topmost-layer Esc, settings forms that keep unsaved input,
// search keyboard order, and server-side backup / bad-request handling.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');

function extractFunction(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `Missing production function: ${name}`);
  for (let index = html.indexOf('{', start); index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const candidate = html.slice(start, index + 1);
    try { new vm.Script(candidate); return candidate; } catch (_) {}
  }
  throw new Error(`Could not extract ${name}`);
}

function pureFunctionTests() {
  const context = vm.createContext({
    roundMoneyValue: value => Math.round(Number(value || 0) * 100) / 100,
    currencyDefs: [{ code:'USD' }, { code:'EUR' }, { code:'GBP' }, { code:'CNY' }, { code:'AUD' }, { code:'CAD' }],
    state: { customers: {} }
  });
  ['pasteTotalLabelPattern', 'findAmountInText', 'findCurrencyInText', 'cleanTracking', 'isUpsTrackingNumber', 'carrierHintFromTrackingText', 'detectCarrier',
    'hasTrackingSignalText', 'hasPhoneSignalText', 'trackingCandidatesFromLine', 'findTrackingInText', 'parseAiJson', 'aiMoneyNumber',
    'sameCustomerName', 'customerNameCollision', 'patchOrdersForCustomerRename']
    .forEach(name => vm.runInContext(extractFunction(name), context));
  const call = (name, ...args) => context[name](...args);

  // Amounts stay on one line: the next line's quantity or a phone number is not glued onto the total.
  assert.equal(call('findAmountInText', 'Qty: 12\n500 USD'), 500);
  assert.equal(call('findAmountInText', '+1 555 0100\n300 USD'), 300);
  assert.equal(call('findAmountInText', 'Total: 500\n20 pcs body wave'), 500);
  assert.equal(call('findAmountInText', 'Total: $1,280\n12 bundles'), 1280);
  assert.equal(call('findAmountInText', 'Total: 1 280 USD'), 1280, 'a space thousands separator still reads as one amount');

  // Currency codes match whole words only; A$ / C$ win over the bare $.
  for (const text of ['Academy Beauty LLC, Texas, total 800', 'Hi this is Audrey, total 300', 'Order for Claude, total 450', 'Ship to Fleur Smith, total 250']) {
    assert.equal(call('findCurrencyInText', text), '', `false currency in ${JSON.stringify(text)}`);
  }
  assert.equal(call('findCurrencyInText', 'A$ 500 for lashes'), 'AUD');
  assert.equal(call('findCurrencyInText', 'C$ 900 deposit'), 'CAD');
  assert.equal(call('findCurrencyInText', 'total 900 EUR'), 'EUR');

  // Tracking numbers are not sliced out of longer order numbers, prefixed ids or a phone line.
  assert.equal(call('findTrackingInText', 'Order No.: 270934521876543210\nShipping: DHL'), '');
  assert.equal(call('findTrackingInText', 'Order K2611070101 ship via FedEx'), '');
  assert.equal(call('findTrackingInText', 'Please send by DHL express\nmy number 5551234567'), '');
  assert.equal(call('findTrackingInText', 'DHL tracking: 1234567890'), '1234567890');

  // AI replies that are not a plain object, or wrap the JSON in prose, still give fields (or nothing) without throwing.
  assert.deepEqual(JSON.parse(JSON.stringify(call('parseAiJson', 'null'))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(call('parseAiJson', '[{"amount":5}]'))), { amount:5 });
  assert.deepEqual(JSON.parse(JSON.stringify(call('parseAiJson', 'Sure! ```json\n{"amount": 10}\n``` hope {this} helps'))), { amount:10 });
  assert.equal(call('aiMoneyNumber', '1.280,00'), 1280);
  assert.equal(call('aiMoneyNumber', '1,280.50'), 1280.5);
  assert.equal(call('aiMoneyNumber', '$1,280'), 1280);

  // alice and Alice are two customers: renaming one is a collision, and a rename does not carry the other's orders along.
  const customers = { alice:{}, Alice:{} };
  assert.equal(call('customerNameCollision', customers, 'alice', 'Alice'), 'Alice');
  assert.equal(call('customerNameCollision', customers, 'alice', 'alice'), '', 'an unchanged name is not a collision');
  assert.equal(call('customerNameCollision', { 'Morgan Sample':{} }, 'Morgan Sample', 'MORGAN SAMPLE'), '');
  const renamed = call('patchOrdersForCustomerRename', [{ client:'alice' }, { client:'Alice' }], 'alice', 'Alice Wong', customers);
  assert.deepEqual(renamed.map(order => order.client), ['Alice Wong', 'Alice']);
  const legacy = call('patchOrdersForCustomerRename', [{ client:'ACME' }], 'Acme', 'Acme Ltd', { Acme:{} });
  assert.equal(legacy[0].client, 'Acme Ltd', 'a legacy case variant without its own profile still follows the rename');
}

async function pageTests() {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:920 } });
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const base = { currency:'USD', logisticsStatus:'未发货', createdAt:`${month}-01`, orderMonth:month, updated:`${month}-01 09:00`, logs:[], productType:'假发', paymentChannel:'Paypal' };
    const orders = [
      { ...base, id:'o-full', num:'K1', client:'Acme Ltd', amount:1000, paidAmount:1000, orderType:'全款订单', stage:'production' },
      { ...base, id:'o-dep', num:'K2', client:'Acme Ltd', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30, orderType:'定金订单', stage:'balance' },
      { ...base, id:'o-ship', num:'K3', client:'Beta Co', amount:800, paidAmount:800, orderType:'定金订单', stage:'shipment', trackingNumber:'1234567890', carrier:'DHL', logisticsStatus:'运输中', shipments:[{ trackingNumber:'1234567890', carrier:'DHL', status:'运输中' }] },
      { ...base, id:'o-sample', num:'K4', client:'Beta Co', amount:500, paidAmount:0, orderType:'定金订单', stage:'quote', trackingNumber:'1234567890', carrier:'DHL', logisticsStatus:'运输中', shipments:[{ trackingNumber:'1234567890', carrier:'DHL', status:'运输中' }] },
      { ...base, id:'o-done', num:'K5', client:'Beta Co', amount:200, paidAmount:200, orderType:'定金订单', stage:'done', urgentOrder:true, latestShipDate:`${month}-01` },
      { ...base, id:'o-back', num:'K6', client:'Gamma', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30, orderType:'定金订单', stage:'balance' }
    ];
    const customers = { 'Acme Ltd':{ client:'Acme Ltd' }, 'Beta Co':{ client:'Beta Co' }, Gamma:{ client:'Gamma' }, alice:{ client:'alice', email:'a1@x.com', note:'US alice' }, Alice:{ client:'Alice', email:'a2@uk.example', note:'UK Alice', permanentNote:'Always use DHL' } };
    let stored = { app:'trade-order-system', data:{ orders, customers, trashOrders:[{ ...base, id:'o-trash', num:'K9', client:'Acme Ltd', amount:10, stage:'quote' }], demoCleared:true, demoCustomersCleared:true }, revision:0 };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/save') {
        stored = { ...route.request().postDataJSON().state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47998/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const toastText = () => page.evaluate(() => [...document.querySelectorAll('.toast, .ui-toast, [class*="toast"]')].map(el => el.textContent).join(' | '));

    // A new order cannot reuse a number held by an active or trashed order.
    for (const num of ['K1', 'K9']) {
      await page.evaluate(n => { openOrder(''); const form = document.getElementById('orderForm'); form.elements.client.value = 'New Buyer'; form.elements.amount.value = '50'; form.elements.num.value = n; }, num);
      const before = await page.evaluate(() => state.orders.length);
      await page.evaluate(() => upsertOrder(document.getElementById('orderForm')));
      assert.equal(await page.evaluate(() => state.orders.length), before, `order number ${num} was saved twice`);
      assert.match(await toastText(), new RegExp(`订单号 ${num} 已被`));
      await page.evaluate(() => closeOrder());
    }
    // A blank (spaces only) customer name does not save a formal order.
    await page.evaluate(() => { openOrder(''); const form = document.getElementById('orderForm'); form.elements.client.value = '   '; form.elements.amount.value = '50'; });
    const countBeforeBlank = await page.evaluate(() => state.orders.length);
    await page.evaluate(() => upsertOrder(document.getElementById('orderForm')));
    assert.equal(await page.evaluate(() => state.orders.length), countBeforeBlank, 'a spaces-only customer name saved an order');
    await page.evaluate(() => closeOrder());

    // The detail drawer refuses a negative amount instead of saving it.
    await page.evaluate(() => openOrderDetail('o-dep'));
    await page.evaluate(() => { const el = document.querySelector('#orderDetailBody [data-dedit="amount"]'); el.value = '-500'; el.dispatchEvent(new Event('input', { bubbles:true })); });
    await page.evaluate(() => uiDetailSave());
    assert.deepEqual(await page.evaluate(() => { const o = state.orders.find(x => x.id === 'o-dep'); return [o.amount, o.paidAmount, o.stage]; }), [1000, 300, 'balance']);
    await page.evaluate(() => closeOrderDetail());

    // Board moves: 全款 has no 尾款 stage; leaving 已发货 gives back the 「尾款视为已收齐」 payment.
    await page.evaluate(() => moveOrderToStage('o-full', 'balance'));
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o-full').stage), 'production');
    await page.evaluate(() => moveOrderToStage('o-back', 'shipment'));
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o-back').paidAmount), 1000, 'shipping settles the balance');
    await page.evaluate(() => moveOrderToStage('o-back', 'balance'));
    assert.deepEqual(await page.evaluate(() => { const o = state.orders.find(x => x.id === 'o-back'); return [o.stage, o.paidAmount, o.logisticsStatus, o.shippedAt || '']; }), ['balance', 300, '未发货', '']);
    await page.evaluate(() => document.getElementById('trackingQuickCard')?.remove());

    // A shared tracking number updates every order on it, but only the shipped one completes on delivery.
    await page.evaluate(() => applyTrackingResultToOrder('1234567890', { ok:true, status:'已签收', updatedAt:new Date().toISOString() }));
    const shared = await page.evaluate(() => ['o-ship', 'o-sample'].map(id => { const o = state.orders.find(x => x.id === id); return [o.stage, o.paidAmount, o.logisticsStatus]; }));
    assert.deepEqual(shared, [['done', 800, '已签收'], ['quote', 0, '已签收']]);

    // Finished orders do not keep urgent / ship-by reminders.
    assert.equal(await page.evaluate(() => buildTaskItems({ includeDone:true }).some(task => task.orderId === 'o-done')), false, 'a done order still produces reminders');

    // Esc closes the topmost layer: the confirm box over an open order form, not the form under it.
    await page.evaluate(() => { openOrder('o-dep'); appConfirm({ title:'t', message:'m', confirmText:'ok' }); });
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => ['confirmModal', 'orderModal'].map(id => document.getElementById(id).classList.contains('open'))), [false, true]);
    await page.evaluate(() => closeOrder());

    // Case-variant customers: editing "alice" no longer overwrites the separate "Alice" profile.
    await page.evaluate(() => openCustomerModal('alice', { viewOnly:false }));
    await page.locator('#customerForm [name="note"]').fill('US alice updated');
    await page.evaluate(() => saveCustomer(document.getElementById('customerForm')));
    const people = await page.evaluate(() => Object.fromEntries(['alice', 'Alice'].map(name => [name, state.customers[name] && { note:state.customers[name].note, permanentNote:state.customers[name].permanentNote || '' }])));
    assert.deepEqual(people, { alice:{ note:'US alice updated', permanentNote:'' }, Alice:{ note:'UK Alice', permanentNote:'Always use DHL' } });

    // Saving one settings card keeps unsaved typing in another card.
    await page.evaluate(() => setPage('settings'));
    await page.evaluate(() => { document.querySelector('#copyTemplatesForm [name="copyDunningTemplate"]').value = 'my unsaved reminder'; });
    await page.evaluate(() => { const form = document.getElementById('orderSettingsForm'); form.elements.orderPrefix.value = 'KX'; form.requestSubmit(); });
    assert.equal(await page.inputValue('#copyTemplatesForm [name="copyDunningTemplate"]'), 'my unsaved reminder');
    assert.equal(await page.evaluate(() => state.orderSettings.orderPrefix), 'KX');

    // Search: ↓ highlights the same result Enter opens, even when groups interleave.
    await page.evaluate(() => { const input = document.getElementById('searchInput'); input.value = 'Beta'; renderGlobalSearchPanel({ forceOpen:true }); });
    const order = await page.evaluate(() => [...document.querySelectorAll('[data-global-search-index]')].map(el => Number(el.dataset.globalSearchIndex)));
    assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'result DOM order differs from keyboard order');
    await page.evaluate(() => closeGlobalSearchPanel());

    // At phone width the confirm box still sits above the order form.
    await page.setViewportSize({ width:720, height:640 });
    const zIndex = await page.evaluate(() => ['confirmModal', 'orderModal'].map(id => Number(getComputedStyle(document.getElementById(id)).zIndex)));
    assert.ok(zIndex[0] > zIndex[1], `confirm z-index ${zIndex[0]} not above order modal ${zIndex[1]}`);

    // The snooze ("稍后", until tomorrow) ends on the next day.
    const snooze = await page.evaluate(() => { snoozedTasks.add('x'); const had = snoozedTasks.has('x'); snoozedTasks.days.set('x', '2000-01-01'); return [had, snoozedTasks.has('x'), snoozedTasks.size]; });
    assert.deepEqual(snooze, [true, false, 0]);

    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  } finally { await browser.close(); }
}

async function serverTests() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-audit-'));
  const backupDir = path.join(testDir, 'my-backups');
  fs.mkdirSync(backupDir);
  fs.writeFileSync(path.join(backupDir, 'family-photos.sqlite'), 'not ours');
  const token = 'audit-token';
  const port = 47100 + (process.pid % 700);
  const child = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], {
    env:{ ...process.env, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', TRADE_APP_DATA_DIR:testDir, TRADE_APP_PORT:String(port), TRADE_EXPORT_NO_REVEAL:'1', TRADE_EXPORT_DIR:path.join(testDir, 'exports') },
    stdio:['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const request = async (route, { method = 'GET', body, raw } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers:{ Authorization:`Bearer ${token}`, ...(body !== undefined || raw !== undefined ? { 'Content-Type':'application/json' } : {}) }, body:raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status:response.status, data:await response.json().catch(() => ({})) };
  };
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { headers:{ Authorization:`Bearer ${token}` } })).ok) break; } catch (_) {}
      if (Date.now() > deadline) throw new Error(`server did not start\n${log}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Client mistakes are 400, not a server error.
    assert.equal((await request('/api/save', { method:'POST', raw:'{not json' })).status, 400);
    assert.equal((await request('/api/save', { method:'POST', raw:'null' })).status, 400);
    assert.equal((await request('/attachments/%E0%A4%A')).status, 400);
    assert.equal((await request('/api/open-url', { method:'POST', body:{ url:'not a url' } })).status, 400);

    // A repeated order number is refused with a readable 422 (not retried forever as a 500).
    const current = (await request('/api/data')).data;
    const data = { ...current.data, orders:[{ id:'a', num:'Z1', client:'A', amount:1, stage:'quote' }, { id:'b', num:'Z1', client:'B', amount:1, stage:'quote' }] };
    const duplicate = await request('/api/save', { method:'POST', body:{ state:{ app:current.app, version:current.version, data }, baseRevision:current.revision } });
    assert.equal(duplicate.status, 422);
    assert.match(duplicate.data.message, /订单号 Z1 重复/);

    // A custom backup folder may hold other .sqlite files: they are neither counted nor rotated away.
    const set = await request('/api/backup-settings', { method:'POST', body:{ backupDir } });
    assert.equal(set.status, 200, JSON.stringify(set.data));
    assert.equal(set.data.count, 0, 'a foreign .sqlite was counted as a backup');
    // 30 older OTS backups: the next one pushes the oldest out of the 30-file rotation, and only an OTS one may go.
    for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(backupDir, `trade-order-data-20200101-0000${String(index).padStart(2, '0')}.sqlite`), 'old');
    data.orders[1].num = 'Z2';
    const saved = await request('/api/save', { method:'POST', body:{ state:{ app:current.app, version:current.version, data }, baseRevision:current.revision } });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const backup = await request('/api/manual-backup', { method:'POST', body:{} });
    assert.equal(backup.status, 200, JSON.stringify(backup.data));
    assert.ok(fs.existsSync(path.join(backupDir, 'family-photos.sqlite')), 'the user file in the backup folder was deleted by rotation');
    assert.equal(fs.readdirSync(backupDir).filter(name => name.endsWith('.sqlite') && name.startsWith('trade-order-data-')).length, 30);
    assert.ok(!fs.existsSync(path.join(backupDir, 'trade-order-data-20200101-000000.sqlite')), 'the oldest OTS backup should rotate out');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    fs.rmSync(testDir, { recursive:true, force:true });
  }
}

(async () => {
  pureFunctionTests();
  await pageTests();
  await serverTests();
  console.log('Audit V3.117 regressions passed: recognition, AI JSON, case-variant customers, repeated order numbers, drawer validation, stage moves, shared tracking, reminders, Esc layering, settings forms, search order, snooze, server 400/422 and backup folder.');
})().catch(error => { console.error(error); process.exitCode = 1; });
