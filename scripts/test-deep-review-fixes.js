#!/usr/bin/env node
// Regression tests for the 2026-10-31 deep review: local date parsing, order copies, draft→formal
// stage inference, customer name matching, repurchase cycles outside the preset list, FX fallback,
// failed-migration retry, attachment order ids, stale Feishu deliveries and WhatsApp renames.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { createWhatsAppStore } = require('../mac-app/whatsapp-store');

const root = path.resolve(__dirname, '..');
const htmlFile = path.join(root, 'trade-order-system.html');
const html = fs.readFileSync(htmlFile, 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function: ${name}`);
  const bodyStart = html.indexOf('{', start);
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const candidate = html.slice(start, index + 1);
    try { new vm.Script(candidate); return candidate; } catch (_) {}
  }
  throw new Error(`Could not extract ${name}`);
}

function pureFunctionTests() {
  // Date-only strings are local dates in every time zone (they used to be UTC midnight, one day early west of UTC).
  const dateCode = ['parseDate', 'normalizeDate', 'normalizeMonth', 'daysBetween'].map(extractFunction).join('\n')
    + "\nconsole.log(JSON.stringify({ date: normalizeDate('2026-10-01'), month: normalizeMonth('2026-10-01'), days: daysBetween('2026-10-30', new Date(2026, 9, 31, 8)) }));";
  for (const tz of ['America/Los_Angeles', 'Asia/Shanghai', 'UTC']) {
    const run = spawnSync(process.execPath, ['-e', dateCode], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { date: '2026-10-01', month: '2026-10', days: 1 }, `date drift in ${tz}`);
  }

  const context = vm.createContext({
    state: { orders: [], orderSettings: { serialDigits: 2, orderPrefix: 'K' }, trashOrders: [], deletedOrders: [] },
    defaultOrderSettings: {},
    orderTypeDefs: [{ value: '定金订单' }, { value: '全款订单' }],
    stageDefs: [{ key: 'quote' }, { key: 'production' }, { key: 'balance' }, { key: 'shipment' }, { key: 'done' }]
  });
  ['normalizeStage', 'cleanTracking', 'inferNewOrderStage', 'nextOrderNum', 'roundMoneyValue', 'depositPercent', 'isSettledStage', 'normalizeOrderPaymentInput', 'isRevenueOrder']
    .forEach(name => vm.runInContext(extractFunction(name), context));
  const call = (name, ...args) => context[name](...args);

  assert.equal(call('inferNewOrderStage', { selectedStage: 'done', orderType: '定金订单', amount: 100, paidAmount: 100, trackingNumber: '1Z999AA10123456784' }), 'done', '已完成 must not be demoted to 已发货 by a tracking number');
  assert.equal(call('inferNewOrderStage', { selectedStage: 'quote', orderType: '定金订单', amount: 100, paidAmount: 30, trackingNumber: '' }), 'balance');

  const d = new Date();
  const day = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  context.state.orders = Array.from({ length: 100 }, (_, i) => ({ num: `K${day}${String(i + 1).padStart(2, '0')}` }));
  const after99 = call('nextOrderNum');
  assert.equal(after99, `K${day}101`, 'serial must keep counting past the 2-digit width');
  context.state.orders.push({ num: after99 });
  assert.equal(call('nextOrderNum'), `K${day}102`, 'the 101st order repeated the previous number');

  const payment = call('normalizeOrderPaymentInput', { paidAmount: 100.555 }, 100.555, '定金订单', 'balance');
  assert.ok(payment.paidAmount <= 100.555, `paid ${payment.paidAmount} exceeds the amount after rounding`);

  assert.equal(call('isRevenueOrder', { stage: 'production', isDraft: true }), false, 'drafts count toward revenue targets');
  assert.equal(call('isRevenueOrder', { stage: 'production' }), true);
}

async function pageTests() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const base = { currency: 'USD', logisticsStatus: '未发货', createdAt: `${month}-02`, orderMonth: month, updated: `${month}-02 09:00`, logs: [] };
    const orders = [
      { ...base, id: 'o-ship', num: 'K1', client: 'Acme Ltd', amount: 1000, paidAmount: 1000, orderType: '定金订单', stage: 'shipment', trackingNumber: '1Z999AA10123456784', carrier: 'UPS', logisticsStatus: '运输中', shipments: [{ trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: '运输中' }], attachments: [{ fileUrl: '/attachments/o-ship/a.png' }] },
      { ...base, id: 'o-draft', num: 'K2', client: 'Acme Ltd', amount: 5000, paidAmount: 1500, orderType: '定金订单', stage: 'quote', isDraft: true },
      { ...base, id: 'o-eur', num: 'K3', client: 'Euro Buyer', amount: 2000, paidAmount: 0, currency: 'EUR', orderType: '定金订单', stage: 'production', createdAt: '2020-01-05', orderMonth: '2020-01' },
      { ...base, id: 'o-note', num: 'K4', client: 'Order Only Co', amount: 300, paidAmount: 0, orderType: '定金订单', stage: 'quote', note: 'ORDER NOTE: pack in 2 boxes' },
      { ...base, id: 'o-balance', num: 'K5', client: 'Acme Ltd', amount: 800, paidAmount: 200, orderType: '定金订单', stage: 'balance', trackingNumber: '1Z999AA10123456785', carrier: 'UPS', shipments: [{ trackingNumber: '1Z999AA10123456785', carrier: 'UPS', status: '未发货' }] }
    ];
    const customers = { 'Acme Ltd': { client: 'Acme Ltd', country: '🇺🇸 美国 United States', repurchaseCycle: 45, note: 'profile note', tags: [] } };
    let stored = { app: 'trade-order-system', data: { orders, customers, deletedOrders: [{ ...base, id: 'o-del', num: 'K9', client: 'Acme Ltd', amount: 10, stage: 'quote', deletedAt: `${month}-03 10:00` }], demoCleared: true, demoCustomersCleared: true }, revision: 0 };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType: 'text/html', body: html });
      let response = { ok: true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok: true, storageMode: 'sqlite', counts: { orders: 5 }, backups: { sqliteCount: 0 } };
      if (pathname === '/api/ecb-rates') response = { ok: true, rates: [{ date: '2024-01-02', rates: { USD: 1.1 } }] };
      if (pathname === '/api/save') {
        const body = route.request().postDataJSON();
        stored = { ...body.state, revision: stored.revision + 1 };
        response = { ok: true, revision: stored.revision, backup: { ok: true, skipped: true } };
      }
      return route.fulfill({ json: response });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    // A copied order is a fresh unshipped order; tracking updates must not land on the copy.
    const copy = await page.evaluate(() => { editingId = 'o-ship'; duplicateOrder(); return state.orders[0]; });
    assert.equal(copy.client, 'Acme Ltd 复制');
    assert.deepEqual([copy.trackingNumber, copy.shipments.length, copy.logisticsStatus, copy.attachments.length, copy.stage], ['', 0, '未发货', 0, 'production']);
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o-ship').shipments.length), 1, 'copy shares the shipments array with the original');

    // A draft saved as a formal order infers its stage from the payment like a new order would.
    const formal = await page.evaluate(() => buildOrderFromFormData({ id: 'o-draft', num: 'K2', client: 'Acme Ltd', amount: 5000, paidAmount: 1500, orderType: '定金订单', stage: 'quote', currency: 'USD' }, { existing: state.orders.find(o => o.id === 'o-draft'), isDraft: false }));
    assert.equal(formal.stage, 'balance', 'draft with a deposit should become 尾款 when saved as a formal order');
    assert.equal(formal.orderMonth, month, 'orderMonth lost on edit');

    // Case / whitespace variants of a customer name resolve to the existing profile.
    const typed = await page.evaluate(() => buildOrderFromFormData({ client: ' ACME LTD ', amount: 10, orderType: '定金订单', stage: 'quote', currency: 'USD' }, { existing: null, isDraft: false }));
    assert.equal(typed.client, 'Acme Ltd', 'order saved under a case variant splits the customer');

    // Rename reaches deleted orders, so restoring one does not bring the old name back.
    await page.evaluate(() => patchAllOrdersForCustomerRename('acme ltd', 'Acme Limited'));
    assert.equal(await page.evaluate(() => state.deletedOrders[0].client), 'Acme Limited');
    assert.equal(await page.evaluate(() => state.orders.filter(o => o.client === 'Acme Limited').length), 3);
    await page.evaluate(() => patchAllOrdersForCustomerRename('Acme Limited', 'Acme Ltd'));

    // An order-only customer does not inherit the order note as its profile note.
    const orderOnly = await page.evaluate(() => clientHistory().find(c => c.client === 'Order Only Co'));
    assert.equal(orderOnly.note, undefined, 'order note leaked into the customer record');
    assert.equal(orderOnly.amount, undefined);

    // A 45-day repurchase cycle survives opening the editor.
    await page.evaluate(() => openCustomerModal('Acme Ltd', { viewOnly: false }));
    assert.equal(await page.locator('#customerForm [name="repurchaseCycle"]').inputValue(), '45', 'non-preset repurchase cycle dropped by the select');
    await page.evaluate(() => document.getElementById('closeCustomerModalBtn').click());

    // Non-USD orders older than the first ECB row still convert instead of counting as $0.
    const eurUsd = await page.evaluate(() => orderAmountUsd(state.orders.find(o => o.id === 'o-eur')));
    assert.ok(Math.abs(eurUsd - 2200) < 0.01, `EUR order converted to ${eurUsd}`);

    // Moving to 已发货 marks the parcel sent, so a reload keeps the status; undo restores the parcel.
    await page.evaluate(() => moveOrderToStage('o-balance', 'shipment'));
    let moved = await page.evaluate(() => { const o = state.orders.find(x => x.id === 'o-balance'); return { stage: o.stage, parcel: o.shipments[0].status, reloaded: normalizeActiveOrder(JSON.parse(JSON.stringify(o))).logisticsStatus }; });
    assert.deepEqual(moved, { stage: 'shipment', parcel: '已发货', reloaded: '已发货' });
    await page.locator('.toast-undo').first().click();
    moved = await page.evaluate(() => { const o = state.orders.find(x => x.id === 'o-balance'); return { stage: o.stage, parcel: o.shipments[0].status }; });
    assert.deepEqual(moved, { stage: 'balance', parcel: '未发货' }, 'undo left the parcel marked as sent');

    // Dashboard label counts every order in the total, drafts stay out of the revenue target.
    await page.evaluate(() => { setPage('dashboard'); render(); });
    assert.match(await page.locator('#statAmountSub').textContent(), /\d+ 个订单/);

    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { await browser.close(); }
}

async function serverTests() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-deep-review-'));
  const port = 48600 + (process.pid % 300);
  const token = `deep-${process.pid}`;
  let child = null;
  const start = () => new Promise(resolve => {
    child = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], {
      env: { ...process.env, TRADE_APP_DATA_DIR: testDir, TRADE_APP_PORT: String(port), TRADE_APP_NO_OPEN: '1', TRADE_API_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    resolve();
  });
  const stop = async () => {
    if (!child) return;
    const proc = child; child = null;
    if (proc.exitCode !== null) return;
    await new Promise(resolve => { const timer = setTimeout(resolve, 3000); proc.once('exit', () => { clearTimeout(timer); resolve(); }); proc.kill('SIGTERM'); });
  };
  const health = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await response.json().catch(() => null);
        if (data) return data;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('health timed out');
  };
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  };
  try {
    // A legacy JSON that cannot be migrated (duplicate order numbers) must not lock the app out: fixing the file and relaunching works.
    const legacy = { app: 'trade-order-system', data: { orders: [{ id: 'a', num: 'K1', client: 'A' }, { id: 'b', num: 'K1', client: 'B' }], customers: {} } };
    fs.writeFileSync(path.join(testDir, 'trade-order-data.json'), JSON.stringify(legacy));
    await start();
    let status = await health();
    assert.equal(status.storageMode, 'error');
    assert.match(String(status.storageError || ''), /UNIQUE|orders\.num/, `first launch should report the migration error, got ${status.storageError}`);
    await stop();
    assert.ok(!fs.existsSync(path.join(testDir, 'trade-order-system.sqlite')), 'failed migration left a database behind');
    legacy.data.orders[1].num = 'K2';
    fs.writeFileSync(path.join(testDir, 'trade-order-data.json'), JSON.stringify(legacy));
    await start();
    status = await health();
    assert.equal(status.storageMode, 'sqlite', `relaunch after fixing the data should migrate, got ${status.storageError}`);
    assert.equal(status.counts.orders, 2);

    // Attachment order ids cannot climb out of the attachments folder.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const upload = await request('/api/attachments', { method: 'POST', body: { orderId: '..', fileName: 'evil', data: png } });
    assert.equal(upload.status, 200, JSON.stringify(upload.data));
    assert.doesNotMatch(String(upload.data.fileUrl || upload.data.attachment?.fileUrl || JSON.stringify(upload.data)), /\.\./, 'orderId ".." escaped the attachments folder');
    assert.ok(!fs.existsSync(path.join(testDir, 'evil.png')), 'file written outside attachments/');

    // A Feishu delivery stuck in "sending" (server died mid-send) is reported as failed so the page can resend.
    const dbFile = path.join(testDir, 'trade-order-system.sqlite');
    const db = new DatabaseSync(dbFile);
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO notification_deliveries(order_id, channel, status, idempotency_key, started_at, sent_at, message_id, last_error, updated_at) VALUES('a', 'feishu_group', 'sending', 'k1', ?, '', '', '', ?)`).run(old, old);
    db.prepare(`INSERT INTO notification_deliveries(order_id, channel, status, idempotency_key, started_at, sent_at, message_id, last_error, updated_at) VALUES('b', 'feishu_group', 'sending', 'k2', ?, '', '', '', ?)`).run(new Date().toISOString(), new Date().toISOString());
    const data = (await request('/api/data')).data;
    const byId = Object.fromEntries(data.data.orders.map(o => [o.id, o.feishuNotification]));
    assert.equal(byId.a.status, 'failed', 'stale sending row should surface as failed');
    assert.equal(byId.b.status, 'sending', 'a fresh sending row stays sending');

    // Renaming a customer that has no orders keeps its WhatsApp chat attached.
    const store = createWhatsAppStore(db);
    const payload = data;
    payload.data.customers = { 'Bob Smith': { client: 'Bob Smith', phones: ['+1 555 000 1111'], tags: [] } };
    let saved = await request('/api/save', { method: 'POST', body: { state: payload, baseRevision: payload.revision } });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const chat = { account: '15550002222@c.us', chatId: '15550001111@c.us', customer: 'Bob Smith', title: 'Bob' };
    assert.equal(store.bind(chat).ok, true);
    payload.data.customers = { 'Robert Smith': { client: 'Robert Smith', phones: ['+1 555 000 1111'], tags: [] } };
    saved = await request('/api/save', { method: 'POST', body: { state: payload, baseRevision: saved.data.revision } });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(store.search({ account: chat.account, chatId: chat.chatId }).binding?.customer, 'Robert Smith', 'profile-only rename lost the WhatsApp binding');
    db.close();
  } finally {
    await stop();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  pureFunctionTests();
  await pageTests();
  await serverTests();
  console.log('Deep review fixes passed: local dates, order copies, draft→formal stage, customer name matching, repurchase cycles, FX fallback, migration retry, attachment ids, stale Feishu rows, WhatsApp rename.');
})().catch(error => { console.error(error); process.exitCode = 1; });
