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
const port = 49000 + (process.pid % 1000);
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

  const renamed = store.save({ ...item, name:'ChatGPT Team', endsOn:'2026-01-01' }).item;
  assert.equal(renamed.createdAt, item.createdAt, 'editing keeps the creation time');
  assert.equal(renamed.endsOn, '', 'active subscriptions ignore a stray end date');
  const cancelled = store.save({ ...renamed, status:'cancelled', endsOn:'2026-11-24' }).item;
  assert.equal(cancelled.endsOn, '2026-11-24');
  expectInvalid(() => store.save({ ...renamed, status:'cancelled', endsOn:'' }), '到期日无效');

  expectInvalid(() => store.save({ ...sample, name:'  ' }), '名称无效');
  expectInvalid(() => store.save({ ...sample, name:'x'.repeat(81) }), '名称无效');
  expectInvalid(() => store.save({ ...sample, amount:0 }), '金额无效');
  expectInvalid(() => store.save({ ...sample, amount:'abc' }), '金额无效');
  expectInvalid(() => store.save({ ...sample, currency:'EUR' }), '币种无效');
  expectInvalid(() => store.save({ ...sample, cycleMonths:3 }), '扣费周期无效');
  expectInvalid(() => store.save({ ...sample, startDate:'2026-02-30' }), '开始日期无效');
  expectInvalid(() => store.save({ ...sample, category:'影音' }), '分类无效');
  expectInvalid(() => store.save({ ...sample, color:'red' }), '颜色无效');
  expectInvalid(() => store.save({ ...sample, status:'paused' }), '状态无效');
  expectInvalid(() => store.save({ ...sample, id:'../x' }), '订阅标识无效');
  expectInvalid(() => store.save(null), '订阅内容无效');

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
  db.close();
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
  assert.deepEqual(empty.categories, ['工具效率', 'AI', '其他']);

  const saved = await request('/api/subscriptions/save', { method:'POST', body:{ item:sample } });
  assert.equal(saved.item.name, 'ChatGPT Plus');
  assert.equal(saved.backup.ok, true, 'saving a subscription runs the automatic backup');
  const invalid = await request('/api/subscriptions/save', { method:'POST', body:{ item:{ ...sample, amount:-1 } }, allowError:true });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.message, '金额无效');
  assert.equal((await request('/api/subscriptions/rate', { method:'POST', body:{ usdCnyRate:6.9 } })).usdCnyRate, 6.9);

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
  console.log('Subscription store test passed: validation, undo restore, page rate, token/JSON guards, backup copy, restart and isolation from order data.');
})().catch(error => {
  console.error(`Subscription store test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  try { fs.rmSync(testDir, { recursive:true, force:true }); } catch (_) {}
});
