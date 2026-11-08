#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createSubscriptionStore, defaultUsdCnyRate } = require('../mac-app/subscription-store');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'mac-app', 'server.js');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-order-subscription-test-'));
const port = require('./helpers/free-port').freePortSync();
const baseUrl = `http://127.0.0.1:${port}`;
const apiToken = `subscription-test-${process.pid}`;
const instanceNonce = `subscription-instance-${process.pid}`;
let child = null;

const sample = {
  name:'ChatGPT Plus', note:'个人账号', amount:19.994, currency:'USD', cycleMonths:1,
  startDate:'2024-11-24', category:'AI', color:'#5B3CC4', status:'active'
};

function expectInvalid(fn, message) {
  assert.throws(fn, error => error.status === 400 && error.message === message, message);
}

function storeTests() {
  const db = new DatabaseSync(':memory:');
  const store = createSubscriptionStore(db);
  assert.deepEqual(store.list().items, [], 'a new database starts without subscriptions');
  assert.equal(store.list().usdCnyRate, defaultUsdCnyRate, 'the page rate defaults to 7.1');

  const { item } = store.save(sample);
  assert.match(item.id, /^[0-9a-f-]{36}$/, 'new subscriptions get a UUID');
  assert.equal(item.amount, 19.99, 'amounts are stored with two decimals');
  assert.equal(item.color, '#5b3cc4');
  assert.equal(item.endsOn, '', 'an active subscription has no end date');
  assert.deepEqual(item.extra, {});
  assert.deepEqual([item.cycleUnit, item.cycleCount, item.paymentMethod], ['month', 1, ''], 'old cycleMonths records map to a monthly cycle');
  const fortnightly = store.save({ ...sample, cycleUnit:'day', cycleCount:14, paymentMethod:' 招行信用卡 ' }).item;
  assert.deepEqual([fortnightly.cycleUnit, fortnightly.cycleCount, fortnightly.paymentMethod], ['day', 14, '招行信用卡']);
  assert.equal(store.save({ ...fortnightly, cycleUnit:'month', cycleCount:3 }).item.cycleCount, 3, 'any month count is allowed');
  store.remove({ id:fortnightly.id });

  const renamed = store.save({ ...item, name:'ChatGPT Team', endsOn:'2026-01-01' }).item;
  assert.equal(renamed.createdAt, item.createdAt, 'editing keeps the creation time');
  assert.equal(renamed.endsOn, '', 'active subscriptions ignore a stray end date');
  const cancelled = store.save({ ...renamed, status:'cancelled', endsOn:'2026-11-24' }).item;
  assert.equal(cancelled.endsOn, '2026-11-24');
  expectInvalid(() => store.save({ ...renamed, status:'cancelled', endsOn:'' }), '到期日无效');

  // Per-period prices and a planned stop date round-trip; same period + kind keeps the later entry.
  assert.deepEqual(renamed.priceChanges, [], 'records start without price changes');
  assert.equal(renamed.stopOn, '');
  // A one-off price off the charge days (the 24th) never applies and is dropped; an onward one before the start moves to it.
  const priced = store.save({ ...renamed, stopOn:'2026-12-31', priceChanges:[
    { from:'2026-09-01', amount:25.555 }, { from:'2026-03-24', amount:18, once:true }, { from:'2026-09-01', amount:26 },
    { from:'2026-03-01', amount:99, once:true }, { from:'2024-01-01', amount:'19.99' }
  ] }).item;
  assert.deepEqual(priced.priceChanges, [{ from:'2024-11-24', amount:19.99, once:false }, { from:'2026-03-24', amount:18, once:true }, { from:'2026-09-01', amount:26, once:false }]);
  assert.equal(priced.stopOn, '2026-12-31');
  assert.equal(store.save({ ...priced, stopOn:'' }).item.stopOn, '', 'clearing the planned stop');
  expectInvalid(() => store.save({ ...renamed, stopOn:'2026-13-01' }), '预计停止时间无效');
  expectInvalid(() => store.save({ ...renamed, priceChanges:[{ from:'x', amount:1 }] }), '周期价格日期无效');
  expectInvalid(() => store.save({ ...renamed, priceChanges:[{ from:'2026-01-01', amount:-1 }] }), '周期价格无效');
  expectInvalid(() => store.save({ ...renamed, priceChanges:'nope' }), '周期价格无效');
  const current = store.save({ ...renamed, stopOn:'', priceChanges:[] }).item;

  // Earlier settings (terms) round-trip, must end on or before the current start and follow each other.
  const term = { startDate:'2023-11-24', until:'2024-11-24', amount:15, currency:'USD', cycleUnit:'month', cycleCount:12, paymentMethod:'PayPal', category:'AI', priceChanges:[] };
  const withTerms = store.save({ ...current, terms:[term] }).item;
  assert.deepEqual(withTerms.terms, [term], 'earlier settings are kept with the record');
  assert.equal(store.list().items.find(entry => entry.id === current.id).terms.length, 1);
  expectInvalid(() => store.save({ ...current, terms:[{ ...term, until:'2025-01-01' }] }), '历史设置无效');
  expectInvalid(() => store.save({ ...current, terms:[{ ...term, until:term.startDate }] }), '历史设置无效');
  expectInvalid(() => store.save({ ...current, terms:[term, { ...term }] }), '历史设置无效');
  expectInvalid(() => store.save({ ...current, terms:'x' }), '历史设置无效');
  // Without terms in the request the stored history would be lost: an edit always sends them.
  const plainEdit = store.save({ ...withTerms, terms:[] }).item;
  assert.deepEqual(plainEdit.terms, []);

  // Edits made from an older copy are refused instead of overwriting another window's save.
  const fresh = store.save({ ...plainEdit, note:'A' }).item;
  assert.throws(() => store.save({ ...fresh, note:'B', baseUpdatedAt:'2000-01-01T00:00:00.000Z' }),
    error => error.status === 409 && error.publicDetails.current.note === 'A', 'stale edits get 409 with the current record');
  assert.equal(store.save({ ...fresh, note:'B', baseUpdatedAt:fresh.updatedAt }).item.note, 'B', 'an edit from the latest copy saves');
  const gone = store.save({ ...sample, name:'gone' }).item;
  store.remove({ id:gone.id });
  assert.throws(() => store.save({ ...gone, baseUpdatedAt:gone.updatedAt }), error => error.status === 404, 'editing a deleted record says so');
  assert.equal(store.save({ ...gone, baseUpdatedAt:gone.updatedAt, restore:true }).item.id, gone.id, 'undo of a delete may write it back');
  store.remove({ id:gone.id });

  // Manual renewals record what the user has renewed: new ones start at today, edits keep it, '' means unknown.
  const manualNew = store.save({ ...sample, name:'example.org', autoRenew:false }).item;
  assert.match(manualNew.renewedThrough, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(store.save({ ...manualNew, renewedThrough:undefined }).item.renewedThrough, manualNew.renewedThrough, 'an edit without it keeps it');
  assert.equal(store.save({ ...manualNew, renewedThrough:'2027-01-01' }).item.renewedThrough, '2027-01-01');
  expectInvalid(() => store.save({ ...manualNew, renewedThrough:'2027-02-30' }), '已续费日期无效');
  assert.equal(store.save({ ...sample, name:'auto' }).item.renewedThrough, '', 'auto-renewals do not track it');
  store.remove({ id:manualNew.id });
  store.remove({ id:store.list().items.find(entry => entry.name === 'auto').id });

  // Typing slips: odd years, end dates before the start, text instead of true/false, hex or exponent amounts.
  expectInvalid(() => store.save({ ...sample, startDate:'0202-01-01' }), '开始日期无效');
  expectInvalid(() => store.save({ ...sample, startDate:'2200-01-01' }), '开始日期无效');
  expectInvalid(() => store.save({ ...sample, status:'cancelled', endsOn:'2024-01-01' }), '到期日不能早于开始日期');
  expectInvalid(() => store.save({ ...sample, stopOn:'2024-01-01' }), '预计停止时间不能早于开始日期');
  expectInvalid(() => store.save({ ...sample, autoRenew:'false' }), '续费方式无效');
  expectInvalid(() => store.save({ ...sample, amount:'0x10' }), '金额无效');
  expectInvalid(() => store.save({ ...sample, amount:'1e3' }), '金额无效');
  assert.equal(store.save({ ...sample, name:'Bell\u0007 name\nline' }).item.name, 'Bell  name line', 'control characters become spaces');
  store.remove({ id:store.list().items.find(entry => entry.name.startsWith('Bell')).id });

  expectInvalid(() => store.save({ ...sample, name:'  ' }), '名称无效');
  expectInvalid(() => store.save({ ...sample, name:'x'.repeat(81) }), '名称无效');
  expectInvalid(() => store.save({ ...sample, amount:0 }), '金额无效');
  expectInvalid(() => store.save({ ...sample, amount:'abc' }), '金额无效');
  expectInvalid(() => store.save({ ...sample, currency:'EUR' }), '币种无效');
  expectInvalid(() => store.save({ ...sample, cycleMonths:0 }), '扣费周期无效');
  expectInvalid(() => store.save({ ...sample, cycleUnit:'week', cycleCount:1 }), '扣费周期无效');
  expectInvalid(() => store.save({ ...sample, cycleUnit:'month', cycleCount:121 }), '扣费周期无效');
  expectInvalid(() => store.save({ ...sample, cycleUnit:'day', cycleCount:1.5 }), '扣费周期无效');
  expectInvalid(() => store.save({ ...sample, paymentMethod:'x'.repeat(41) }), '付款方式无效');
  expectInvalid(() => store.save({ ...sample, startDate:'2026-02-30' }), '开始日期无效');
  expectInvalid(() => store.save({ ...sample, category:'' }), '类型无效');
  expectInvalid(() => store.save({ ...sample, category:'x'.repeat(21) }), '类型无效');
  expectInvalid(() => store.save({ ...sample, provider:'x'.repeat(41) }), '服务商无效');
  // Types are free labels (custom ones stay on records after being deleted); the old name maps to the new one.
  const domain = store.save({ ...sample, name:'example.com', category:'域名', provider:' Cloudflare ', autoRenew:false }).item;
  assert.deepEqual([domain.category, domain.provider, domain.autoRenew], ['域名', 'Cloudflare', false]);
  assert.equal(store.save({ ...domain, category:'工具效率', autoRenew:undefined }).item.category, '软件');
  assert.equal(store.list().items.find(item => item.id === domain.id).autoRenew, true, 'auto-renew defaults to on');
  assert.equal(store.save({ ...domain, category:'邮箱' }).item.category, '邮箱');
  store.remove({ id:domain.id });
  expectInvalid(() => store.save({ ...sample, color:'red' }), '颜色无效');
  expectInvalid(() => store.save({ ...sample, status:'paused' }), '状态无效');
  expectInvalid(() => store.save({ ...sample, id:'../x' }), '续费项标识无效');
  expectInvalid(() => store.save(null), '续费内容无效');

  const removedCopy = store.list().items[0];
  assert.equal(store.remove({ id:removedCopy.id }).deleted, 1);
  assert.throws(() => store.remove({ id:removedCopy.id }), error => error.status === 404, 'deleting twice reports not found');
  const restored = store.save(removedCopy).item;
  assert.equal(restored.id, removedCopy.id, 'undo writes the same record back');
  assert.equal(restored.createdAt, removedCopy.createdAt, 'undo keeps the original creation time');

  assert.equal(store.setRate({ usdCnyRate:'6.8966' }).usdCnyRate, 6.8966);
  assert.equal(store.list().usdCnyRate, 6.8966);
  expectInvalid(() => store.setRate({ usdCnyRate:0 }), '汇率无效');
  expectInvalid(() => store.setRate({ usdCnyRate:101 }), '汇率无效');

  assert.deepEqual([store.list().customCycles, store.list().customPaymentMethods], [[], []]);
  assert.ok(store.list().defaultPaymentMethods.includes('支付宝'));
  const options = store.setOptions({
    customCycles:[{ unit:'day', count:14 }, { unit:'day', count:14 }, { unit:'month', count:2 }],
    customPaymentMethods:['招行信用卡', '招行信用卡', '支付宝', ' Wise ']
  });
  assert.deepEqual(options.customCycles, [{ unit:'day', count:14 }, { unit:'month', count:2 }], 'duplicate cycles are dropped');
  assert.deepEqual(options.customPaymentMethods, ['招行信用卡', 'Wise'], 'duplicates and built-in methods are dropped');
  assert.deepEqual(store.list().customPaymentMethods, ['招行信用卡', 'Wise'], 'custom options persist');
  expectInvalid(() => store.setOptions({ customCycles:[{ unit:'hour', count:1 }] }), '扣费周期无效');
  expectInvalid(() => store.setOptions({ customPaymentMethods:['  '] }), '付款方式无效');
  expectInvalid(() => store.setOptions({ customPaymentMethods:Array.from({ length:31 }, (_, i) => `卡${i}`) }), '自定义付款方式最多 30 个，请先删掉不用的');
  const typed = store.setOptions({ customCategories:['邮箱', '邮箱', 'VPS', ' 证书 '] });
  assert.deepEqual(typed.customCategories, ['邮箱', '证书'], 'duplicates and built-in types are dropped');
  assert.deepEqual(typed.customPaymentMethods, ['招行信用卡', 'Wise'], 'a call without a list keeps the saved one');
  assert.deepEqual(store.list().customCategories, ['邮箱', '证书']);
  expectInvalid(() => store.setOptions({ customCategories:['x'.repeat(21)] }), '类型无效');
  db.close();

  // A database created before custom cycles gets the new columns, and old rows stay monthly or yearly.
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`CREATE TABLE subscriptions (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', amount REAL NOT NULL,
    currency TEXT NOT NULL, cycle_months INTEGER NOT NULL, start_date TEXT NOT NULL, category TEXT NOT NULL, color TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, ends_on TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, extra_json TEXT NOT NULL DEFAULT '{}');
    INSERT INTO subscriptions VALUES('legacy-0001', '1Password', '', 35.88, 'USD', 12, '2022-05-18', '工具效率', '#2f6fde', 'active', '', 'x', 'x', '{}');`);
  const migrated = createSubscriptionStore(legacy).list().items[0];
  assert.deepEqual([migrated.cycleUnit, migrated.cycleCount, migrated.paymentMethod], ['month', 12, '']);
  assert.deepEqual([migrated.category, migrated.provider, migrated.autoRenew], ['软件', '', true], 'old 工具效率 rows become 软件, auto-renew on');
  assert.deepEqual([migrated.terms, migrated.renewedThrough], [[], ''], 'old rows get no earlier settings');
  legacy.close();

  // V3.128 database (manual renewals, no terms / renewed_through yet): manual rows count as renewed up to the upgrade day.
  const v128 = new DatabaseSync(':memory:');
  v128.exec(`CREATE TABLE subscriptions (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', amount REAL NOT NULL,
    currency TEXT NOT NULL, cycle_months INTEGER NOT NULL, start_date TEXT NOT NULL, category TEXT NOT NULL, color TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, ends_on TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, extra_json TEXT NOT NULL DEFAULT '{}',
    cycle_unit TEXT NOT NULL DEFAULT 'month', payment_method TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', auto_renew INTEGER NOT NULL DEFAULT 1,
    price_changes_json TEXT NOT NULL DEFAULT '[]', stop_on TEXT NOT NULL DEFAULT '');
    INSERT INTO subscriptions(id, name, amount, currency, cycle_months, start_date, category, status, created_at, updated_at, auto_renew, price_changes_json)
      VALUES('manual-0001', 'example.com', 60, 'CNY', 12, '2020-03-01', '域名', 'active', 'x', 'x', 0, '[{"from":"2023-03-01","amount":70,"once":false}]'),
            ('auto-00001', 'VPS', 5, 'USD', 1, '2024-01-10', 'VPS', 'active', 'x', 'x', 1, '[]');`);
  const upgraded = createSubscriptionStore(v128).list().items;
  const manualRow = upgraded.find(entry => entry.id === 'manual-0001');
  assert.match(manualRow.renewedThrough, /^\d{4}-\d{2}-\d{2}$/, 'manual rows are marked renewed up to the upgrade day');
  assert.deepEqual(manualRow.priceChanges, [{ from:'2023-03-01', amount:70, once:false }], 'existing price changes are kept');
  assert.equal(upgraded.find(entry => entry.id === 'auto-00001').renewedThrough, '');
  // Reopening the upgraded database does not move the date again.
  v128.prepare("UPDATE subscriptions SET renewed_through = '2021-03-01' WHERE id = 'manual-0001'").run();
  assert.equal(createSubscriptionStore(v128).list().items.find(entry => entry.id === 'manual-0001').renewedThrough, '2021-03-01');
  v128.close();
}

async function serverTests() {
  startServer();
  await waitForHealth();

  const anonymous = await fetch(`${baseUrl}/api/subscriptions`);
  assert.equal(anonymous.status, 401, 'subscriptions require the session token');
  const plain = await fetch(`${baseUrl}/api/subscriptions/save`, {
    method:'POST', headers:{ Authorization:`Bearer ${apiToken}`, 'Content-Type':'text/plain' }, body:JSON.stringify({ item:sample })
  });
  assert.equal(plain.status, 415, 'subscription writes require JSON');

  const empty = await request('/api/subscriptions');
  assert.deepEqual(empty.items, [], 'tables are created on first use in an existing database');
  assert.equal(empty.usdCnyRate, 7.1);
  assert.deepEqual(empty.categories, ['软件', 'AI', 'VPS', '域名', '云服务', '其他']);

  const saved = await request('/api/subscriptions/save', { method:'POST', body:{ item:sample } });
  assert.equal(saved.item.name, 'ChatGPT Plus');
  assert.equal(saved.backup.ok, true, 'saving a subscription runs the automatic backup');
  const invalid = await request('/api/subscriptions/save', { method:'POST', body:{ item:{ ...sample, amount:-1 } }, allowError:true });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.message, '金额无效');
  // baseUpdatedAt next to the item: a save from an older copy gets 409 with the current record.
  const stale = await request('/api/subscriptions/save', { method:'POST', body:{ item:{ ...saved.item, note:'stale' }, baseUpdatedAt:'2000-01-01T00:00:00.000Z' }, allowError:true });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.current.note, '个人账号');
  const latest = await request('/api/subscriptions/save', { method:'POST', body:{ item:{ ...saved.item, note:'latest' }, baseUpdatedAt:saved.item.updatedAt } });
  assert.equal(latest.item.note, 'latest');
  assert.equal((await request('/api/subscriptions/rate', { method:'POST', body:{ usdCnyRate:6.9 } })).usdCnyRate, 6.9);
  const options = await request('/api/subscriptions/options', { method:'POST', body:{ customCycles:[{ unit:'day', count:14 }], customPaymentMethods:['Wise'] } });
  assert.deepEqual([options.customCycles, options.customPaymentMethods, options.backup.ok], [[{ unit:'day', count:14 }], ['Wise'], true]);

  const business = JSON.stringify(await request('/api/data'));
  assert.doesNotMatch(business, /ChatGPT Plus|subscriptions|usd_cny_rate/, 'order data must not include subscriptions');

  const backup = await request('/api/manual-backup', { method:'POST' });
  const copy = new DatabaseSync(backup.file, { readOnly:true });
  assert.equal(copy.prepare('SELECT name FROM subscriptions').get().name, 'ChatGPT Plus', 'backups contain the subscription table');
  assert.equal(copy.prepare("SELECT value FROM subscription_settings WHERE key = 'usd_cny_rate'").get().value, '6.9');
  copy.close();

  await stopServer();
  startServer();
  await waitForHealth();
  const reloaded = await request('/api/subscriptions');
  assert.equal(reloaded.items.length, 1, 'subscriptions survive a restart');
  assert.equal(reloaded.usdCnyRate, 6.9);
  assert.deepEqual(reloaded.customPaymentMethods, ['Wise'], 'custom options survive a restart');
  assert.equal((await request('/api/subscriptions/delete', { method:'POST', body:{ id:saved.item.id } })).deleted, 1);
  const missing = await request('/api/subscriptions/delete', { method:'POST', body:{ id:saved.item.id }, allowError:true });
  assert.equal(missing.status, 404);
}

function startServer() {
  child = spawn(process.execPath, [serverFile], {
    env:{ ...process.env, TRADE_APP_DATA_DIR:testDir, TRADE_APP_PORT:String(port), TRADE_APP_NO_OPEN:'1',
      TRADE_API_TOKEN:apiToken, TRADE_INSTANCE_NONCE:instanceNonce },
    stdio:['ignore', 'pipe', 'pipe']
  });
}

async function stopServer() {
  if (!child) return;
  const processToStop = child;
  child = null;
  if (processToStop.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    processToStop.once('exit', () => { clearTimeout(timer); resolve(); });
    processToStop.kill('SIGTERM');
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers:{ Authorization:`Bearer ${apiToken}` } });
      if (response.ok && (await response.json()).instanceNonce === instanceNonce) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server health check timed out');
}

async function request(route, { method = 'GET', body, allowError = false } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers:{ Authorization:`Bearer ${apiToken}`, ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
    body:body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !allowError) throw new Error(data.message || `${route} HTTP ${response.status}`);
  return allowError ? { status:response.status, data } : data;
}

(async () => {
  storeTests();
  await serverTests();
  console.log('Subscription store test passed: validation, custom cycles and payment methods, legacy migration, undo restore, page rate, token/JSON guards, backup copy, restart and isolation from order data.');
})().catch(error => {
  console.error(`Subscription store test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  try { fs.rmSync(testDir, { recursive:true, force:true }); } catch (_) {}
});
