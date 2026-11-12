#!/usr/bin/env node
// 飞书通知的服务端（真实 mac-app/server.js + 假 lark-cli，绝不连真实飞书）：
// - 假 CLI 按 lark-cli 的约定把错误写到 stderr：缺权限、机器人不在群、凭证失效、App Secret 错、限流、断网各给一句能照着做的中文，
//   不带群 ID、profile、本机路径；只有临时性错误算「可稍后重试」；
// - 超时连同外壳派生的「原生程序」一起结束，之后不会再有消息发出去；超时记成「可能已经发出」；
// - lark-cli 只拿到白名单里的环境变量（没有 TRADE_API_TOKEN 等）；原生程序形式的 lark-cli 直接运行，不再用 node 去跑；
// - AVIF、超过 10 MB、文件丢了的图片跳过，文字照发，末尾写明哪张没附上；
// - 备注 / 地址里的 Markdown 结构（标题、列表、删除线、分割线、表格、假字段行、方向控制符）在群里只是文字；
// - 设置接口：未配置 / 配置有误（带原因）/ 已配置；保存后不重启就能发，文件 0600，profile 和群 ID 不回给页面；测试连接成功和失败。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-feishu-cli-'));
const larkDir = path.join(testDir, 'lark');
const fakeCli = path.join(larkDir, 'lark-cli');
const settings = { profile:'OTS_SECRET_PROFILE', chatName:'Synthetic 订单群', chatId:'oc_secretchat0123456789' };
const apiToken = `feishu-cli-${process.pid}`;
let server = null;
let baseUrl = '';

const fakeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = path.dirname(fs.realpathSync(__filename));
const args = process.argv.slice(2);
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(path.join(dir, 'ctl.json'), 'utf8')); } catch (_) {}
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, env:Object.keys(process.env) }) + '\\n');
const ok = data => { process.stdout.write(JSON.stringify({ ok:true, identity:'bot', data }) + '\\n'); process.exitCode = 0; };
const fail = error => { process.stderr.write('Error: request failed\\n' + JSON.stringify({ ok:false, error }, null, 2) + '\\n'); process.exitCode = 1; };
const errors = {
  scope:{ type:'authorization', subtype:'missing_scope', code:99991672, message:'Access denied. One of the following scopes is required: [im:message:send_as_bot]', missing_scopes:['im:message:send_as_bot'] },
  notInChat:{ type:'api_error', code:230002, message:'Bot/User can NOT be out of the chat. chat_id=oc_secretchat0123456789' },
  token:{ type:'authentication', code:99991663, message:'Invalid access token for authorization. Please make a request with token attached.' },
  secret:{ type:'api_error', code:10014, message:'app secret invalid for profile OTS_SECRET_PROFILE at /Users/someone/.lark-cli/config.json' },
  rate:{ type:'api_error', code:99991400, message:'request trigger frequency limit' },
  offline:{ type:'network', message:'Post "https://open.feishu.cn/open-apis/im/v1/messages": dial tcp: lookup open.feishu.cn: no such host' }
};
if (args.includes('images') && args.includes('create')) {
  const file = args[args.indexOf('--file') + 1] || '';
  const size = fs.statSync(path.resolve(process.cwd(), file)).size;
  if (size > 10 * 1024 * 1024) fail({ type:'api_error', code:234006, message:'image size exceeds limit' });
  else ok({ image_key:'img_v3_' + path.basename(file).replace(/\\W/g, '') });
} else if (args.includes('+messages-send')) {
  if (ctl.mode === 'orphan') {
    // Like the npm wrapper: execFileSync the native program, which sends after a delay.
    spawnSync(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'sent'), 3000)", path.join(dir, 'orphan-delivered')], { stdio:'inherit' });
    ok({ message_id:'om_late' });
  } else if (errors[ctl.mode]) {
    fail(errors[ctl.mode]);
  } else {
    ok({ chat_id:'oc_x', create_time:'2026-11-09 10:00:00', message_id:'om_' + Date.now() });
  }
} else {
  fail({ type:'validation', message:'unsupported fake command' });
}
`;

main().catch(error => {
  console.error(`Feishu CLI error handling test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  try { fs.rmSync(testDir, { recursive:true, force:true }); } catch (_) {}
});

async function main() {
  fs.mkdirSync(larkDir);
  fs.writeFileSync(fakeCli, fakeSource, { mode:0o700 });
  setCtl({});
  fs.writeFileSync(path.join(testDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:'1', data:{
    orders:[], customers:{}, trashOrders:[], deletedOrders:[], doneTasks:{}, demoCleared:true, demoCustomersCleared:true
  } }));

  // ---- Settings API: missing → invalid → saved without a restart ----
  await startServer();
  let status = await request('/api/feishu-settings');
  assert.equal(status.configured, false);
  assert.equal(status.state, 'missing');
  assert.match(status.reason, /还没有配置飞书/);
  assert.equal(status.cli.found, true, 'the fake lark-cli is found');
  const bad = await rawRequest('/api/feishu-settings', { method:'POST', body:{ profile:'OTS_SECRET_PROFILE', chatName:'群', chatId:'chat-123' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.message, /oc_/, 'a wrong chat id says what is wrong');
  assert.equal(fs.existsSync(path.join(testDir, 'feishu-settings.json')), false, 'an invalid form writes nothing');
  await addOrders([order('o-before', 'K-BEFORE')]);
  const unconfigured = await rawRequest('/api/order-notification', { method:'POST', body:{ orderId:'o-before' } });
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.data.errorKind, 'config');
  assert.equal(calls().length, 0, 'nothing is sent without settings');

  status = await request('/api/feishu-settings', { method:'POST', body:settings });
  assert.equal(status.configured, true);
  assert.equal(status.chatName, settings.chatName);
  assert.equal(status.profileSaved, true);
  assert.equal(status.chatIdSaved, true);
  const settingsFile = path.join(testDir, 'feishu-settings.json');
  assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600, 'the settings file stays 0600');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), settings);
  assertNoSecrets(status, 'settings status');
  // Blank profile / chat id keep what is saved (the page never learns them); the group name can change alone.
  status = await request('/api/feishu-settings', { method:'POST', body:{ profile:'', chatId:'', chatName:'外贸订单通知群' } });
  assert.equal(status.chatName, '外贸订单通知群');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).chatId, settings.chatId);
  settings.chatName = '外贸订单通知群';

  // Saved settings work without restarting the app.
  const sent = await request('/api/order-notification', { method:'POST', body:{ orderId:'o-before' } });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.chatName, '外贸订单通知群');
  assert.equal(lastSend().args[lastSend().args.indexOf('--chat-id') + 1], settings.chatId);
  const polled = await request('/api/order-notification?orderId=o-before');
  assert.equal(polled.status, 'sent', 'the status endpoint reports the delivery');
  assert.equal(polled.sentFields.num, 'K-BEFORE', 'the fields that went to the group are remembered');

  // Test message: success and a failure with its reason.
  const test = await request('/api/feishu-test', { method:'POST', body:{} });
  assert.equal(test.ok, true);
  assert.match(lastSend().args[lastSend().args.indexOf('--markdown') + 1], /OTS 测试消息/);
  setCtl({ mode:'notInChat' });
  const testFail = await request('/api/feishu-test', { method:'POST', body:{} });
  assert.equal(testFail.ok, false);
  assert.match(testFail.message, /机器人不在「外贸订单通知群」里/);
  assertNoSecrets(testFail, 'test message failure');
  setCtl({});

  // ---- lark-cli errors are read from stderr and mapped to clear reasons ----
  const expected = {
    scope:[/缺少权限.*im:message:send_as_bot/, false],
    notInChat:[/机器人不在「外贸订单通知群」里.*拉进/, false],
    token:[/凭证失效.*lark-cli config init/, false],
    secret:[/凭证失效|App Secret/, false],
    rate:[/限流/, true],
    offline:[/连不上飞书/, true]
  };
  await addOrders(Object.keys(expected).map(mode => order(`o-${mode}`, `K-${mode}`)));
  for (const [mode, [pattern, retryable]] of Object.entries(expected)) {
    setCtl({ mode });
    const failed = await rawRequest('/api/order-notification', { method:'POST', body:{ orderId:`o-${mode}` } });
    assert.equal(failed.status, 503, mode);
    assert.equal(failed.data.status, 'failed', mode);
    assert.match(failed.data.error, pattern, `${mode}: ${failed.data.error}`);
    assert.equal(failed.data.retryable, retryable, `${mode} retryable`);
    assert.equal(/稍后重试/.test(failed.data.error), false, `${mode} must not tell the user to just retry`);
    assertNoSecrets(failed.data, mode);
  }
  setCtl({});
  const afterReload = (await request('/api/data')).data.orders.find(item => item.id === 'o-scope').feishuNotification;
  assert.match(afterReload.error, /缺少权限/, 'the reason survives a reload');
  assert.equal(afterReload.errorKind, 'permission');
  assertNoSecrets(await request('/api/data'), '/api/data');
  // /api/health lists the data folder by design; only the bot identity and the chat id must stay out.
  assertNoSecrets(await request('/api/health'), '/api/health', { paths:false });

  // ---- Environment allow-list ----
  const envKeys = [...new Set(calls().flatMap(call => call.env))];
  assert.deepEqual(envKeys.filter(key => /^TRADE_|^OTS_/.test(key)), [], 'lark-cli must not see TRADE_API_TOKEN, the port or the data directory');
  assert.ok(envKeys.includes('HOME') && envKeys.includes('PATH'));

  // ---- Images: AVIF, > 10 MB and missing files are skipped, the text still goes out ----
  const imageDir = path.join(testDir, 'attachments', 'o-images');
  fs.mkdirSync(imageDir, { recursive:true });
  fs.writeFileSync(path.join(imageDir, 'ok.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(imageDir, 'photo.avif'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(imageDir, 'huge.png'), Buffer.alloc(11 * 1024 * 1024, 1));
  const attachment = name => ({ name, type:'图片附件', fileUrl:`/attachments/o-images/${name}`, thumbUrl:`/attachments/o-images/${name}` });
  await addOrders([order('o-images', 'K-IMAGES', { attachments:[attachment('ok.png'), attachment('photo.avif'), attachment('huge.png'), attachment('gone.png')] })]);
  const withImages = await request('/api/order-notification', { method:'POST', body:{ orderId:'o-images' } });
  assert.equal(withImages.status, 'sent', 'one bad image no longer blocks the whole message');
  assert.equal(withImages.skippedImages, process.platform === 'darwin' ? withImages.skippedImages : 3);
  const imageMarkdown = markdownOf(lastSend());
  assert.match(imageMarkdown, /!\[附件 1\]\(img_v3_okpng\)/);
  if (process.platform !== 'darwin') {
    assert.match(imageMarkdown, /未能附上的图片：\*\* 附件 2（格式不支持）、附件 3（超过 10 MB）、附件 4（文件不存在）/);
  }

  // ---- Markdown structure from notes and addresses stays plain text ----
  await addCustomer('Inject Co', { client:'Inject Co', email:'a_b@example.com', phone:'+1 415 555 0100', address:'# 12 Orchard Rd\n- Unit 5\n> Singapore' });
  const note = ['客户确认：', '# 已付全款 直接发货', '- 尾款已收 $5,000', '1. 无需等财务', '~~原价 $900~~', '---', '| 品名 | 数量 |', '|---|---|', '订单金额：USD 1.00', '\u202eevil\u202c', '    code block'].join('\n');
  await addOrders([order('o-md', 'K-MD', { client:'Inject Co', note })]);
  await request('/api/order-notification', { method:'POST', body:{ orderId:'o-md' } });
  const md = markdownOf(lastSend());
  const lines = md.split('\n');
  for (const line of lines.filter(item => !/^\*\*[^*]+：\*\* /.test(item))) {
    assert.doesNotMatch(line, /^\s{0,3}(#|[-+*] |\d+[.)] |>|\||-{3,}|={3,})/, `structure at line start: ${JSON.stringify(line)}`);
  }
  assert.equal(md.includes('~~'), false, 'no strikethrough');
  assert.equal(/[\u202a-\u202e\u2066-\u2069]/.test(md), false, 'no direction controls');
  assert.ok(lines.includes('\u3000\u3000订单金额：USD 1.00'), 'a fake field line in the note is indented under the note');
  assert.ok(lines.some(line => line.startsWith('**收货地址：** ＃ 12 Orchard Rd') || line.startsWith('**收货地址：** # 12 Orchard Rd')), 'first address line stays after its label');
  assert.ok(lines.includes('\u3000\u3000－ Unit 5'), 'second address line is not a list item');

  // ---- A native lark-cli (make install / Volta) runs directly, not through node ----
  fs.writeFileSync(fakeCli, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${larkDir}/native-calls.txt"\nprintf '{"ok":true,"identity":"bot","data":{"message_id":"om_native","create_time":"2026-11-09 10:00:00"}}\\n'\n`, { mode:0o700 });
  assert.equal((await request('/api/feishu-settings')).cli.kind, 'native');
  await addOrders([order('o-native', 'K-NATIVE')]);
  const native = await request('/api/order-notification', { method:'POST', body:{ orderId:'o-native' } });
  assert.equal(native.status, 'sent');
  assert.equal(native.messageId, 'om_native');
  fs.writeFileSync(fakeCli, fakeSource, { mode:0o700 });

  // ---- Timeout ends the wrapper and the program it started; recorded as "may have been sent" ----
  await stopServer();
  await startServer({ OTS_LARK_TIMEOUT_MS:'1500' });
  setCtl({ mode:'orphan' });
  await addOrders([order('o-orphan', 'K-ORPHAN')]);
  const timedOut = await rawRequest('/api/order-notification', { method:'POST', body:{ orderId:'o-orphan' } });
  assert.equal(timedOut.status, 503);
  assert.equal(timedOut.data.errorKind, 'timeout');
  assert.match(timedOut.data.error, /可能已经发到群里/);
  // Proving something does not happen: the fake native program writes orphan-delivered 3000 ms after it started
  // (mode 'orphan' above), unless the timeout ended it with its wrapper. Wait that out, with room to spare.
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(fs.existsSync(path.join(larkDir, 'orphan-delivered')), false, 'the native program started by the wrapper must not keep running and send later');
  const timedOutRow = (await request('/api/data')).data.orders.find(item => item.id === 'o-orphan').feishuNotification;
  assert.equal(timedOutRow.errorKind, 'timeout');
  setCtl({});

  // ---- Hand-edited files: BOM is fine, curly quotes and placeholders say why ----
  await stopServer();
  fs.writeFileSync(settingsFile, `\ufeff${JSON.stringify(settings)}`, { mode:0o600 });
  await startServer();
  assert.equal((await request('/api/feishu-settings')).configured, true, 'a BOM at the start is accepted');
  fs.writeFileSync(settingsFile, JSON.stringify(settings).replace(/"/g, '\u201c'), { mode:0o600 });
  status = await request('/api/feishu-settings');
  assert.equal(status.state, 'invalid');
  assert.match(status.reason, /弯引号/);
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, profile:'OTS_BOT_CONFIGURE' }), { mode:0o600 });
  status = await request('/api/feishu-settings');
  assert.equal(status.state, 'invalid');
  assert.match(status.reason, /占位/);
  await addOrders([order('o-invalid', 'K-INVALID')]);
  const invalid = await rawRequest('/api/order-notification', { method:'POST', body:{ orderId:'o-invalid' } });
  assert.match(invalid.data.error, /飞书配置有问题：profile 还是示例占位值/);
  console.log('Feishu CLI error handling passed: settings API (missing / invalid with reason / saved without restart / 0600 / no secrets), test message, stderr error reasons, env allow-list, image skipping, Markdown as text, native CLI, timeout kills the process group.');
}

function order(id, num, extra = {}) {
  return { id, num, client:'Emma Test', country:'United Kingdom', createdAt:'2026-11-09', orderMonth:'2026-11', amount:1000, currency:'USD', paymentChannel:'Paypal', productType:'假发', orderType:'定金订单', stage:'quote', note:'', updated:'2026-11-09 10:00', attachments:[], logs:[], ...extra };
}

async function addOrders(list) {
  const payload = await request('/api/data');
  payload.data.orders.push(...list);
  await request('/api/save', { method:'POST', body:{ state:payload, baseRevision:payload.revision } });
}

async function addCustomer(name, profile) {
  const payload = await request('/api/data');
  payload.data.customers[name] = profile;
  await request('/api/save', { method:'POST', body:{ state:payload, baseRevision:payload.revision } });
}

function assertNoSecrets(value, label, { paths = true } = {}) {
  const text = JSON.stringify(value);
  for (const secret of [settings.profile, settings.chatId, ...(paths ? [testDir, '/Users/someone'] : [])]) {
    assert.equal(text.includes(secret), false, `${label} leaked ${secret}`);
  }
}

function setCtl(ctl) { fs.writeFileSync(path.join(larkDir, 'ctl.json'), JSON.stringify(ctl)); }
function calls() {
  const file = path.join(larkDir, 'calls.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function lastSend() {
  const sends = calls().filter(call => call.args.includes('+messages-send'));
  return sends[sends.length - 1];
}
function markdownOf(call) { return call.args[call.args.indexOf('--markdown') + 1] || ''; }

async function startServer(extraEnv = {}) {
  const port = freePortSync();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], {
    env: { ...process.env, TRADE_APP_DATA_DIR:testDir, TRADE_APP_PORT:String(port), TRADE_APP_NO_OPEN:'1', TRADE_API_TOKEN:apiToken, TRADE_INSTANCE_NONCE:`feishu-cli-${process.pid}`, TRADE_LARK_CLI:fakeCli, OTS_FAKE_MARKER:'must-not-reach-lark', ...extraEnv },
    stdio:['ignore', 'ignore', 'ignore']
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGTERM'); } catch (_) { clearTimeout(timer); resolve(); }
  });
}

async function request(route, options = {}) {
  const response = await rawRequest(route, options);
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${response.data.message || ''}`);
  return response.data;
}

async function rawRequest(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers:{ Authorization:`Bearer ${apiToken}`, ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { ok:response.ok, status:response.status, data:await response.json().catch(() => ({})) };
}
