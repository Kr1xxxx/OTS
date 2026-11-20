#!/usr/bin/env node
// 备份、轮转、从备份恢复、写库校验（审查报告 25 P1-3 / P1-6 / P1-7，29 P2-4）：真实 mac-app/server.js + 临时数据目录。
// - 明显的客户端错误回 4xx（页面不会每 3 秒重试）：数组正文、深嵌套、金额「1,200」、物流记录 id 重复、__proto__ 客户、坏图片、坏附件地址；
// - 分级保留：48 小时内全留，30 天内每天一份，12 周内每周一份；操作前快照留 90 天 / 至少 20 份；别的 Mac 的备份不动；
// - 从备份恢复：先做「恢复前」快照，数据和附件回来，版本号变大（旧窗口再保存得到 409）；
// - 换电脑 / 手动放回备份导致身份标记不符时，只读保护下也能从备份恢复，之后重启正常。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const token = 'backup-restore-test-token';
const pad = n => String(n).padStart(2, '0');
const stamp = date => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
const base = { currency:'USD', country:'🇺🇸 美国 United States', stage:'production', orderType:'定金订单', amount:1000, paidAmount:300, logs:[], attachments:[], shipments:[] };
const fixture = () => ({
  orders:[
    { ...base, id:'o1', num:'K26110101', client:'Alice Baker', orderMonth:'2026-11', attachments:[{ name:'pay.png', fileUrl:'/attachments/o1/pay.png' }] },
    { ...base, id:'o2', num:'K26100101', client:'Bob Lee', orderMonth:'2026-10' },
    { ...base, id:'o3', num:'K26090101', client:'Bob Lee', orderMonth:'2026-09' }
  ],
  trashOrders:[], deletedOrders:[],
  customers:{ 'Alice Baker':{ client:'Alice Baker', note:'VIP' }, 'Bob Lee':{ client:'Bob Lee' }, 'Zero Lead':{ client:'Zero Lead', note:'0 单' } },
  doneTasks:{}, demoCleared:true, demoCustomersCleared:true, paymentMethods:['自定义收款A']
});

function startServer(dataDir, port, nodeArgs = []) {
  return spawn(process.execPath, [...nodeArgs, path.join(root, 'mac-app', 'server.js')], {
    env:{ ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', TRADE_EXPORT_DIR:path.join(dataDir, '__downloads'), TRADE_EXPORT_NO_REVEAL:'1' },
    stdio:'ignore'
  });
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
}
function client(port) {
  return async (route, { method = 'GET', body, raw, headers = {} } = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method,
          headers:{ Authorization:`Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type':'application/json' } : {}), ...headers },
          ...(method === 'POST' ? { body:raw !== undefined ? raw : JSON.stringify(body ?? {}) } : {})
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch (_) { data = { raw:text }; }
        return { status:res.status, data };
      } catch (error) {
        if (attempt > 100) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  };
}
async function waitForHealth(request) {
  for (let i = 0; i < 200; i++) {
    try { const res = await request('/api/health'); if (res.status === 200 || res.status === 500) return res; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}
function seedDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:'1', data:fixture() }));
  fs.mkdirSync(path.join(dir, 'attachments', 'o1'), { recursive:true });
  fs.writeFileSync(path.join(dir, 'attachments', 'o1', 'pay.png'), 'pay-bytes');
  return dir;
}

async function validationTests(request) {
  const current = (await request('/api/data')).data;
  const save = (data, extra = {}) => request('/api/save', { method:'POST', body:{ state:{ app:'trade-order-system', version:'t', data }, baseRevision:current.revision, ...extra } });
  // 正文是数组、嵌套 5000 层：400，不是 500。
  assert.equal((await request('/api/save', { method:'POST', raw:'[]' })).status, 400, 'array body');
  const deepJson = `${'{"x":'.repeat(5000)}{}${'}'.repeat(5000)}`;
  const deepRes = await request('/api/save', { method:'POST', raw:`{"state":{"data":{"orders":[{"id":"d","nested":${deepJson}}]}},"baseRevision":${current.revision}}` });
  assert.equal(deepRes.status, 400, `deep nesting: ${JSON.stringify(deepRes.data).slice(0, 120)}`);
  assert.equal((await request('/api/save', { method:'POST', body:{ state:{ data:{} }, baseRevision:current.revision } })).status, 400, 'missing orders');
  // 金额写成文字：422，说出订单号和字段，数据库不变。
  const bad = JSON.parse(JSON.stringify(current.data));
  bad.orders[1].amount = '1,200';
  const amount = await save(bad);
  assert.equal(amount.status, 422, JSON.stringify(amount.data));
  assert.match(amount.data.message, /K26100101 的金额（amount）不是数字：1,200/);
  assert.equal(amount.data.orderNum, 'K26100101');
  assert.equal((await request('/api/data')).data.revision, current.revision, 'a refused save must not change the database');
  const lookups = JSON.parse(JSON.stringify(current.data));
  lookups.trackingLookups = [{ id:'lk', trackingNumber:'1' }, { id:'lk', trackingNumber:'2' }];
  assert.equal((await save(lookups)).status, 422, 'duplicate tracking lookup id');
  const proto = JSON.parse(JSON.stringify(current.data));
  const protoBody = JSON.stringify({ state:{ data:proto }, baseRevision:current.revision }).replace('"customers":{', '"customers":{"__proto__":{"client":"x"},');
  const protoRes = await request('/api/save', { method:'POST', raw:protoBody });
  assert.equal(protoRes.status, 422, JSON.stringify(protoRes.data));
  assert.equal((await request('/api/attachments', { method:'POST', body:{ orderId:'o1', data:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } })).status, 415, 'svg upload');
  assert.equal((await request('/api/open-attachment-folder', { method:'POST', body:{ fileUrl:'/attachments/%2e%2e/%2e%2e/etc' } })).status, 400, 'attachment url outside the folder');
  assert.equal((await request('/api/api-status', { method:'POST', body:{ kind:{ a:1 } } })).status, 400, 'object kind');
  // 导出文件：方向控制符去掉，按字节限长，正文必须是文字。
  const bidi = await request('/api/export-file', { method:'POST', body:{ name:'ok‮vsc.json', text:'{}' } });
  assert.equal(bidi.status, 200);
  assert.equal(bidi.data.name, 'okvsc.json');
  assert.equal((await request('/api/export-file', { method:'POST', body:{ name:`${'中'.repeat(100)}.csv`, text:'a' } })).status, 400, 'long CJK name');
  assert.equal((await request('/api/export-file', { method:'POST', body:{ name:'a.json', text:{ a:1 } } })).status, 400, 'object text');
}

async function rotationTests(dataDir, request) {
  const backupDir = path.join(dataDir, 'backups');
  const manual = await request('/api/manual-backup', { method:'POST' });
  assert.equal(manual.status, 200, JSON.stringify(manual.data));
  const tag = /-([0-9a-f]{6})\.sqlite$/.exec(manual.data.name)?.[1];
  assert.ok(tag, `backup names carry the database id: ${manual.data.name}`);
  // 100 天、每天 5 份（9–17 点）的旧备份；另一台 Mac 的 40 份；26 份 100 天前的「导入前」快照和 1 份 10 天前的。
  const now = new Date();
  const write = name => fs.writeFileSync(path.join(backupDir, name), 'old');
  for (let day = 1; day <= 100; day++) {
    for (const hour of [9, 11, 13, 15, 17]) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day, hour, 0, 0);
      write(`trade-order-data-${stamp(date)}-${tag}.sqlite`);
      if (day % 3 === 0 && hour === 9) write(`trade-order-data-${stamp(date)}-ffffff.sqlite`);
    }
  }
  for (let i = 0; i < 26; i++) write(`trade-order-data-${stamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 100 - i, 12, 0, 0))}-${tag}-before-import.sqlite`);
  write(`trade-order-data-${stamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10, 12, 0, 0))}-${tag}-before-import.sqlite`);
  const foreignBefore = fs.readdirSync(backupDir).filter(name => name.includes('-ffffff')).length;
  assert.equal((await request('/api/manual-backup', { method:'POST' })).status, 200);
  const left = fs.readdirSync(backupDir).filter(name => name.endsWith('.sqlite'));
  const parse = name => { const m = /^trade-order-data-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(name); return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); };
  const ageDays = name => (now - parse(name)) / 86400000;
  const own = left.filter(name => name.includes(`-${tag}`) && !name.includes('-before-'));
  assert.equal(left.filter(name => name.includes('-ffffff')).length, foreignBefore, 'another Mac\'s backups in the same folder must not be rotated');
  assert.ok(own.every(name => ageDays(name) < 84), 'regular backups older than 12 weeks rotate out');
  for (let day = 3; day < 29; day++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
    assert.ok(own.some(name => name.startsWith(`trade-order-data-${stamp(date).slice(0, 8)}-`)), `one backup kept for ${day} days ago`);
  }
  const perDay = new Map();
  own.filter(name => ageDays(name) > 7 && ageDays(name) < 29).forEach(name => perDay.set(name.slice(17, 25), (perDay.get(name.slice(17, 25)) || 0) + 1));
  assert.ok([...perDay.values()].every(count => count === 1), 'older days keep exactly one backup');
  const weekly = own.filter(name => ageDays(name) > 31);
  assert.ok(weekly.length >= 7 && weekly.length <= 9, `one backup per week between 30 days and 12 weeks: ${weekly.length}`);
  assert.equal(left.filter(name => name.includes('-before-import')).length, 20, 'snapshots: the newest 20 (incl. the recent one) are kept');
  assert.ok(left.some(name => name.includes('-before-import') && ageDays(name) < 11), 'a recent snapshot is kept');
  const summary = (await request('/api/backup-settings')).data;
  assert.ok(summary.oldestBackupAt && now - summary.oldestBackupAt > 80 * 86400000, 'settings can say how far back the backups go');
  // 清掉测试用的假备份（内容不是 SQLite），只留真的。
  left.filter(name => fs.readFileSync(path.join(backupDir, name)).length < 10).forEach(name => fs.rmSync(path.join(backupDir, name)));
}

async function restoreTests(dataDir, request) {
  const attachment = path.join(dataDir, 'attachments', 'o1', 'pay.png');
  // 一份有 3 张单和附件的备份 →（误操作）只剩 1 张单、附件被删。
  const good = await request('/api/backup-before-change', { method:'POST', body:{ reason:'import' } });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.match(good.data.name, /-before-import\.sqlite$/);
  const current = (await request('/api/data')).data;
  const damaged = JSON.parse(JSON.stringify(current.data));
  damaged.orders = damaged.orders.filter(order => order.id === 'o2');
  delete damaged.customers['Zero Lead'];
  const damageSave = { state:{ data:damaged }, baseRevision:current.revision, customerInference:false, saveId:'restore-retry-001' };
  const saved = await request('/api/save', { method:'POST', body:damageSave });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  fs.rmSync(attachment);
  const list = (await request('/api/backups')).data;
  assert.ok(list.backups.some(item => item.name === good.data.name && item.reason === 'import' && item.mine), 'the backup is listed with its reason');
  const preview = (await request('/api/backup-preview', { method:'POST', body:{ name:good.data.name } })).data;
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual([preview.counts.orders, preview.current.orders], [3, 1]);
  assert.equal(preview.diff.orders.added, 2);
  assert.equal(preview.diff.orders.removed, 0);
  assert.equal(preview.diff.customers.added, 1);
  assert.equal((await request('/api/backup-preview', { method:'POST', body:{ name:'../trade-order-system.sqlite' } })).status, 400, 'only backup files in the backup folder');
  assert.equal((await request('/api/restore-backup', { method:'POST', body:{ name:'trade-order-data-20200101-000000.sqlite' } })).status, 404);
  // An existing native writer must finish before its connection's database can be replaced.
  const writer = new DatabaseSync(path.join(dataDir, 'trade-order-system.sqlite'));
  try {
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare("UPDATE metadata SET value=? WHERE key='app'").run('trade-order-system');
    const busy = await request('/api/restore-backup', { method:'POST', body:{ name:good.data.name } });
    assert.equal(busy.status, 409, JSON.stringify(busy.data));
    writer.exec('COMMIT');
    assert.equal((await request('/api/data')).data.revision, saved.data.revision);
    assert.equal(fs.existsSync(path.join(dataDir, 'restore-pending.json')), false);
  } finally { writer.close(); }
  const staleRevision = saved.data.revision;
  const restored = await request('/api/restore-backup', { method:'POST', body:{ name:good.data.name } });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.match(restored.data.safetyBackup, /-before-restore\.sqlite$/, 'the current data is backed up before the restore');
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', restored.data.safetyBackup)));
  const after = (await request('/api/data')).data;
  assert.deepEqual(after.data.orders.map(order => order.num).sort(), ['K26090101', 'K26100101', 'K26110101']);
  assert.ok(after.data.customers['Zero Lead'], 'customers come back');
  assert.ok(after.revision > staleRevision, 'revision moves forward');
  assert.equal(fs.readFileSync(attachment, 'utf8'), 'pay-bytes', 'attachments come back from the backup');
  const stale = await request('/api/save', { method:'POST', body:{ state:{ data:damaged }, baseRevision:staleRevision } });
  assert.equal(stale.status, 409, 'a window still on the old revision is switched to read-only');
  // 撤销恢复 = 恢复那份「恢复前」快照。
  const undo = await request('/api/restore-backup', { method:'POST', body:{ name:restored.data.safetyBackup } });
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal((await request('/api/data')).data.data.orders.length, 1);
  // The safety backup includes damageSave's receipt, but restoring it starts a new revision.
  const retry = await request('/api/save', { method:'POST', body:damageSave });
  assert.equal(retry.status, 409, 'a receipt from a restored snapshot cannot confirm a save at the new revision');
  assert.equal((await request('/api/revision')).data.revision, undo.data.revision);
  return good.data.name;
}

async function newMacTests(sourceDir, backupName) {
  // 「新 Mac」：全新数据目录，App 第一次打开生成自己的数据库和身份标记。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-restore-newmac-'));
  const port = freePortSync();
  // Fail the first staging-file rename after the old database has already been closed and moved.
  const fault = path.join(dir, 'fail-restore-rename.cjs');
  fs.writeFileSync(fault, `
    const fs = require('node:fs');
    const path = require('node:path');
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (path.basename(from).startsWith('.restore-') && path.basename(to) === 'trade-order-system.sqlite') {
        fs.renameSync = rename;
        throw new Error('simulated staging rename failure');
      }
      return rename(from, to);
    };
  `);
  let child = startServer(dir, port, ['--require', fault]);
  const request = client(port);
  try {
    await waitForHealth(request);
    const backupPath = path.join(dir, 'backups', backupName);
    fs.copyFileSync(path.join(sourceDir, 'backups', backupName), backupPath);
    const restore = () => request('/api/restore-backup', { method:'POST', body:{ name:backupName } });
    const original = (await request('/api/data')).data;
    const markerPath = path.join(dir, 'sqlite-storage.json');
    const originalId = JSON.parse(fs.readFileSync(markerPath)).databaseId;
    async function assertOriginal() {
      assert.equal((await request('/api/health')).data.storageMode, 'sqlite', 'original database must reopen after a failed restore');
      assert.deepEqual((await request('/api/data')).data.data, original.data);
      assert.equal((await request('/api/revision')).data.revision, original.revision);
      assert.equal(JSON.parse(fs.readFileSync(markerPath)).databaseId, originalId);
    }
    const failedInstall = await restore();
    assert.equal(failedInstall.status, 500);
    assert.match(failedInstall.data.message, /simulated staging rename failure/);
    await assertOriginal();

    // A stale diagnostic path that cannot be removed makes restoration fail after switching database ids.
    const diagnosticPath = path.join(dir, 'migration-error.json');
    fs.mkdirSync(diagnosticPath);
    const failedFinalize = await restore();
    assert.equal(failedFinalize.status, 500);
    await assertOriginal();
    fs.rmdirSync(diagnosticPath);
    await stopServer(child);
    child = startServer(dir, port);
    await waitForHealth(request);
    await assertOriginal();
    await stopServer(child);
    // 手动把备份放回去（报告 P1-6 (b)）：身份标记对不上，只读保护。
    fs.copyFileSync(path.join(sourceDir, 'backups', backupName), path.join(dir, 'trade-order-system.sqlite'));
    ['-wal', '-shm'].forEach(suffix => fs.rmSync(path.join(dir, `trade-order-system.sqlite${suffix}`), { force:true }));
    fs.mkdirSync(path.join(dir, 'backups'), { recursive:true });
    fs.copyFileSync(path.join(sourceDir, 'backups', backupName), path.join(dir, 'backups', backupName));
    fs.cpSync(path.join(sourceDir, 'backups', `${backupName}.attachments`), path.join(dir, 'backups', `${backupName}.attachments`), { recursive:true });
    child = startServer(dir, port);
    const health = await waitForHealth(request);
    assert.equal(health.data.storageMode, 'error');
    assert.match(health.data.storageError, /identity does not match/);
    // 只读保护下照样能列出、预览和恢复；恢复前先把现在那份文件原样拷一份。
    assert.ok((await request('/api/backups')).data.backups.some(item => item.name === backupName));
    const preview = (await request('/api/backup-preview', { method:'POST', body:{ name:backupName } })).data;
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.current, null);
    const restored = await request('/api/restore-backup', { method:'POST', body:{ name:backupName } });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.match(restored.data.safetyBackup, /-before-restore\.sqlite$/);
    assert.equal((await request('/api/health')).data.storageMode, 'sqlite');
    assert.equal((await request('/api/data')).data.data.orders.length, 3);
    assert.equal(fs.readFileSync(path.join(dir, 'attachments', 'o1', 'pay.png'), 'utf8'), 'pay-bytes');
    // 重启后照常打开，不再被身份标记拦下。
    await stopServer(child);
    child = startServer(dir, port);
    const reopened = await waitForHealth(request);
    assert.equal(reopened.data.storageMode, 'sqlite', JSON.stringify(reopened.data));
    const db = new DatabaseSync(path.join(dir, 'trade-order-system.sqlite'), { readOnly:true });
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key = 'restored_from'").get().value, backupName);
    db.close();
  } finally {
    await stopServer(child);
    fs.rmSync(dir, { recursive:true, force:true });
  }
}

async function interruptedRestore(sourceDir, backupName, point) {
  const dir = seedDir('ots-restore-crash-');
  const port = freePortSync();
  const request = client(port);
  const fault = path.join(dir, 'interrupt-restore.cjs');
  fs.writeFileSync(fault, `
    const fs = require('node:fs');
    const path = require('node:path');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      const displaced = path.basename(from) === 'trade-order-system.sqlite' && to.includes('.replaced-');
      const installed = path.basename(from).startsWith('.restore-') && path.basename(to) === 'trade-order-system.sqlite';
      const committed = path.basename(to) === 'restore-committed.json';
      if ({ displaced, installed, committed }[${JSON.stringify(point)}]) process.kill(process.pid, 'SIGKILL');
      return result;
    };
  `);
  let child = startServer(dir, port, ['--require', fault]);
  try {
    await waitForHealth(request);
    const current = (await request('/api/data')).data;
    current.data.orders = [];
    const saved = await request('/api/save', { method:'POST', body:{ state:current, baseRevision:current.revision } });
    assert.equal(saved.status, 200);
    const marker = path.join(dir, 'sqlite-storage.json');
    const originalId = JSON.parse(fs.readFileSync(marker)).databaseId;
    const source = path.join(sourceDir, 'backups', backupName);
    fs.copyFileSync(source, path.join(dir, 'backups', backupName));
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/restore-backup`, {
      method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, body:JSON.stringify({ name:backupName })
    }));
    assert.equal((await exit).signal, 'SIGKILL');
    child = startServer(dir, port);
    assert.equal((await waitForHealth(request)).data.storageMode, 'sqlite', point);
    const loaded = (await request('/api/data')).data;
    if (point === 'committed') {
      assert.equal(loaded.data.orders.length, 3);
      assert.ok(loaded.revision > saved.data.revision);
      assert.notEqual(JSON.parse(fs.readFileSync(marker)).databaseId, originalId);
    } else {
      assert.deepEqual(loaded.data, current.data, point);
      assert.equal(loaded.revision, saved.data.revision, point);
      assert.equal(JSON.parse(fs.readFileSync(marker)).databaseId, originalId, point);
    }
    assert.ok(!fs.readdirSync(dir).some(file => /^(?:restore-(pending|committed)\.json|\.restore-)|\.replaced-/.test(file)));
  } finally {
    if (child.signalCode === null) await stopServer(child);
    fs.rmSync(dir, { recursive:true, force:true });
  }
}

async function partialAttachmentRestore() {
  const dir = seedDir('ots-restore-attachments-');
  const src = path.join(dir, 'trade-order-data.json');
  const seed = JSON.parse(fs.readFileSync(src));
  const folder = path.join(dir, 'attachments', 'o1');
  for (const name of ['missing.png', 'other.png', 'same-size.png', 'linked/inside.png', 'linked/absent.png']) seed.data.orders[0].attachments.push({ name, fileUrl:`/attachments/o1/${name}` });
  fs.writeFileSync(src, JSON.stringify(seed));
  fs.writeFileSync(path.join(folder, 'other.png'), 'another image');
  fs.writeFileSync(path.join(folder, 'same-size.png'), 'abcd');
  fs.mkdirSync(path.join(folder, 'linked'));
  for (const name of ['inside.png', 'absent.png']) fs.writeFileSync(path.join(folder, 'linked', name), 'image');
  const port = freePortSync();
  const request = client(port);
  const child = startServer(dir, port);
  try {
    await waitForHealth(request);
    const backup = (await request('/api/backup-before-change', { method:'POST', body:{ reason:'import' } })).data;
    assert.equal(backup.ok, true);
    const current = (await request('/api/data')).data;
    current.data.orders = [];
    assert.equal((await request('/api/save', { method:'POST', body:{ state:current, baseRevision:current.revision } })).status, 200);
    fs.unlinkSync(path.join(folder, 'pay.png'));
    fs.unlinkSync(path.join(folder, 'other.png'));
    // A conflicting local path must not stop the remaining attachments from being copied.
    fs.mkdirSync(path.join(folder, 'pay.png'));
    fs.writeFileSync(path.join(folder, 'same-size.png'), 'wxyz');
    fs.renameSync(path.join(folder, 'linked'), path.join(folder, 'neighbor'));
    fs.unlinkSync(path.join(folder, 'neighbor', 'absent.png'));
    fs.symlinkSync('neighbor', path.join(folder, 'linked'), 'dir');
    const result = await request('/api/restore-backup', { method:'POST', body:{ name:backup.name } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.databaseRestored, true);
    assert.equal((await request('/api/data')).data.data.orders.length, 3);
    assert.deepEqual(result.data.attachmentFailures.map(item => item.file).sort(), ['o1/linked/absent.png', 'o1/linked/inside.png', 'o1/missing.png', 'o1/pay.png', 'o1/same-size.png']);
    assert.equal(fs.existsSync(path.join(folder, 'neighbor', 'absent.png')), false);
    assert.equal(fs.readFileSync(path.join(folder, 'same-size.png'), 'utf8'), 'wxyz');
    assert.equal(result.data.restoredAttachments, 1);
    assert.equal(fs.readFileSync(path.join(folder, 'other.png'), 'utf8'), 'another image');
  } finally {
    await stopServer(child);
    fs.rmSync(dir, { recursive:true, force:true });
  }
}

async function restoreWalBackup(dataDir, request, backupName) {
  const mainFile = path.join(dataDir, 'wal-fixture.sqlite');
  const rawName = 'trade-order-data-20260101-121212-before-restore.sqlite';
  const rawFile = path.join(dataDir, 'backups', rawName);
  fs.copyFileSync(path.join(dataDir, 'backups', backupName), mainFile);
  const db = new DatabaseSync(mainFile);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    db.prepare('DELETE FROM orders WHERE id = ?').run('o3');
    // As in the recovery path for a database that could not open, retain the main file and WAL together.
    fs.copyFileSync(mainFile, rawFile);
    fs.copyFileSync(mainFile + '-wal', rawFile + '-wal');
  } finally { db.close(); }
  const preview = await request('/api/backup-preview', { method:'POST', body:{ name:rawName } });
  assert.equal(preview.data.counts.orders, 2);
  const restored = await request('/api/restore-backup', { method:'POST', body:{ name:rawName } });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const after = (await request('/api/data')).data;
  assert.deepEqual(after.data.orders.map(order => order.id).sort(), ['o1', 'o2'], 'restore must include the committed WAL changes shown in the preview');
}

(async () => {
  const dataDir = seedDir('ots-backup-restore-');
  const port = freePortSync();
  const child = startServer(dataDir, port);
  const request = client(port);
  try {
    const health = await waitForHealth(request);
    assert.equal(health.data.storageMode, 'sqlite', JSON.stringify(health.data));
    await validationTests(request);
    await rotationTests(dataDir, request);
    const backupName = await restoreTests(dataDir, request);
    for (const point of ['displaced', 'installed', 'committed']) await interruptedRestore(dataDir, backupName, point);
    await partialAttachmentRestore();
    await restoreWalBackup(dataDir, request, backupName);
    await newMacTests(dataDir, backupName);
    console.log('Backup and restore tests passed: 4xx validation, tiered retention, restore with a safety snapshot and attachments, restore after an identity mismatch.');
  } finally {
    await stopServer(child);
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
