#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'mac-app', 'server.js');
const seedFile = path.join(root, 'trade-order-data.json');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-order-feishu-test-'));
const fakeCli = path.join(testDir, 'fake-lark-cli.js');
const cliLog = path.join(testDir, 'fake-lark-calls.jsonl');
const failureMarker = path.join(testDir, 'failed-once');
const port = 51000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const apiToken = `feishu-test-${process.pid}`;
let child = null;

main().catch(error => {
  console.error(`Feishu order notification test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
});

async function main() {
  fs.copyFileSync(seedFile, path.join(testDir, 'trade-order-data.json'));
  writeFakeCli();
  startServer();
  await waitForHealth();

  const image = await request('/api/attachments', {
    method: 'POST',
    body: {
      orderId: 'TEST-FEISHU-001',
      fileName: 'order.png',
      mimeType: 'image/png',
      data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    }
  });
  assert.equal(image.ok, true);

  const payload = await request('/api/data');
  payload.data.customers['Emma Test'] = {
    client: 'Emma Test',
    email: 'emma.test@example.com',
    phone: '+44 7700 900123',
    address: '18 Test Street, London, United Kingdom',
    paymentEmail: 'must-not-use@example.net'
  };
  payload.data.orders.unshift(testOrder('o-feishu-success', 'TEST-FEISHU-001', image.fileUrl));
  payload.data.orders.unshift(testOrder('o-feishu-fail', 'TEST-FAIL-002', ''));
  payload.data.orders.unshift({ ...testOrder('o-feishu-draft', 'TEST-DRAFT-003', ''), isDraft: true });
  await request('/api/save', { method: 'POST', body: { state: payload, baseRevision: payload.revision } });

  const sent = await request('/api/order-notification', { method: 'POST', body: { orderId: 'o-feishu-success' } });
  assert.equal(sent.ok, true);
  assert.equal(sent.status, 'sent');
  assert.ok(sent.sentAt);
  assert.ok(sent.messageId);

  const callsAfterFirstSend = readCliCalls();
  const upload = callsAfterFirstSend.find(args => args.includes('images') && args.includes('create'));
  const messageCalls = callsAfterFirstSend.filter(args => args.includes('+messages-send'));
  assert.ok(upload, 'original image was not uploaded');
  assert.equal(messageCalls.length, 1, 'expected one rich-text send');
  const messageArgs = messageCalls[0];
  assertExplicitBotIdentity(messageArgs);
  assert.equal(valueAfter(messageArgs, '--chat-id'), 'oc_CONFIGURE_TARGET_CHAT_ID');
  const markdown = valueAfter(messageArgs, '--markdown');
  assert.equal(markdown.trimStart().split('\n')[0], '**客户名称：** Emma Test', '客户名称必须是通知第一行');
  assert.ok(
    markdown.indexOf('**客户名称：** Emma Test') < markdown.indexOf('**订单号：** TEST-FEISHU-001'),
    '客户名称必须显示在订单号之前'
  );
  for (const expected of [
    'TEST-FEISHU-001', 'Emma Test',
    'emma.test@example.com', '+44 7700 900123',
    '18 Test Street, London, United Kingdom', 'USD 1,022.00',
    'Bank Transfer', '全部为虚拟资料', 'img_v3_test_order'
  ]) assert.match(markdown, new RegExp(escapeRegExp(expected)), `missing markdown field: ${expected}`);
  for (const forbidden of ['新订单通知', '保存时间', '客户信息', '订单信息', '订单图片', '订单状态', '假发', 'DHL', 'must-not-use@example.net']) {
    assert.equal(markdown.includes(forbidden), false, `forbidden markdown content: ${forbidden}`);
  }

  const savedImagePath = path.join(testDir, 'attachments', decodeURIComponent(new URL(image.fileUrl, baseUrl).pathname.replace(/^\/attachments\//, '')));
  fs.rmSync(savedImagePath, { force: true });
  const duplicate = await request('/api/order-notification', { method: 'POST', body: { orderId: 'o-feishu-success' } });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.alreadySent, true);
  assert.equal(readCliCalls().filter(args => args.includes('+messages-send')).length, 1, 'duplicate request sent another message');

  const refreshed = await request('/api/data');
  const refreshedOrder = refreshed.data.orders.find(order => order.id === 'o-feishu-success');
  assert.equal(refreshedOrder.feishuNotification.status, 'sent');
  assert.equal(refreshedOrder.feishuNotification.messageId, sent.messageId);

  const draft = await rawRequest('/api/order-notification', { method: 'POST', body: { orderId: 'o-feishu-draft' } });
  assert.equal(draft.status, 409);

  const failed = await rawRequest('/api/order-notification', { method: 'POST', body: { orderId: 'o-feishu-fail' } });
  assert.equal(failed.status, 503);
  assert.equal(failed.data.status, 'failed');
  assert.equal(JSON.stringify(failed.data).includes(testDir), false, 'error leaked an absolute path');
  assert.equal(JSON.stringify(failed.data).includes('TEST_AUTH_TOKEN'), false, 'error leaked CLI output');

  const retried = await request('/api/order-notification', { method: 'POST', body: { orderId: 'o-feishu-fail' } });
  assert.equal(retried.status, 'sent');
  assert.equal(readCliCalls().filter(args => args.includes('+messages-send')).length, 3, 'failed send was not retried exactly once');

  console.log('Feishu order notification test passed: fixed rich text, inline image, bot identity, idempotency, failure retry, and redaction verified.');
}

function testOrder(id, num, fileUrl) {
  return {
    id,
    num,
    client: 'Emma Test',
    country: 'United Kingdom',
    createdAt: '2026-08-18',
    amount: 1022,
    currency: 'USD',
    paymentChannel: 'Bank Transfer',
    productType: '假发',
    stage: 'quote',
    trackingNumber: 'DHL-SECRET-TRACKING',
    carrier: 'DHL',
    note: '全部为虚拟资料',
    updated: '2026-08-18 17:45',
    attachments: fileUrl ? [{ name: '订单原图', type: '图片附件', fileUrl, thumbUrl: fileUrl }] : [],
    logs: []
  };
}

function writeFakeCli() {
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LARK_LOG, JSON.stringify(args) + '\\n');
if (args.includes('images') && args.includes('create')) {
  console.log(JSON.stringify({ ok:true, identity:'bot', data:{ image_key:'img_v3_test_order' } }));
  process.exit(0);
}
if (args.includes('+messages-send')) {
  const markdown = args[args.indexOf('--markdown') + 1] || '';
  if (markdown.includes('TEST-FAIL-002') && !fs.existsSync(process.env.FAKE_LARK_FAILURE_MARKER)) {
    fs.writeFileSync(process.env.FAKE_LARK_FAILURE_MARKER, '1');
    console.log(JSON.stringify({ ok:false, error:{ message:'TEST_AUTH_TOKEN /private/tmp/private-profile.json' } }));
    process.exit(3);
  }
  console.log(JSON.stringify({ ok:true, identity:'bot', data:{ chat_id:'oc_test', create_time:'2026-08-18 17:45:00', message_id:'om_test_' + Date.now() } }));
  process.exit(0);
}
console.log(JSON.stringify({ ok:false, error:{ message:'unsupported fake command' } }));
process.exit(2);
`;
  fs.writeFileSync(fakeCli, source, { mode: 0o700 });
}

function assertExplicitBotIdentity(args) {
  assert.equal(valueAfter(args, '--profile'), 'OTS_BOT_CONFIGURE');
  assert.equal(valueAfter(args, '--as'), 'bot');
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function readCliCalls() {
  if (!fs.existsSync(cliLog)) return [];
  return fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function startServer() {
  child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      TRADE_APP_DATA_DIR: testDir,
      TRADE_APP_PORT: String(port),
      TRADE_APP_NO_OPEN: '1',
      TRADE_API_TOKEN: apiToken,
      TRADE_INSTANCE_NONCE: `feishu-instance-${process.pid}`,
      TRADE_LARK_CLI: fakeCli,
      FAKE_LARK_LOG: cliLog,
      FAKE_LARK_FAILURE_MARKER: failureMarker,
      PATH: '/usr/bin:/bin'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function stopServer() {
  if (!child) return;
  const processToStop = child;
  child = null;
  if (processToStop.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2000);
    processToStop.once('exit', () => { clearTimeout(timer); resolve(); });
    try { processToStop.kill('SIGTERM'); } catch (_) { clearTimeout(timer); resolve(); }
  });
  assert.equal(processToStop.exitCode, 0, `server did not stop cleanly: ${processToStop.exitCode}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers: { Authorization: `Bearer ${apiToken}` } });
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server health check timed out');
}

async function request(route, options = {}) {
  const response = await rawRequest(route, options);
  if (!response.ok) throw new Error(response.data.message || `${route} HTTP ${response.status}`);
  return response.data;
}

async function rawRequest(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
