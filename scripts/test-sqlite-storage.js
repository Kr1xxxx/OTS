#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createWhatsAppStore } = require('../mac-app/whatsapp-store');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'mac-app', 'server.js');
const seedFile = path.join(root, 'trade-order-data.json');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-order-sqlite-test-'));
const port = require('./helpers/free-port').freePortSync();
const baseUrl = `http://127.0.0.1:${port}`;
const apiToken = `sqlite-test-${process.pid}`;
const instanceNonce = `sqlite-instance-${process.pid}`;
let child = null;

main().catch(error => {
  console.error(`SQLite storage test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
});

async function main() {
  fs.copyFileSync(seedFile, path.join(testDir, 'trade-order-data.json'));
  const source = normalizePayload(JSON.parse(fs.readFileSync(seedFile, 'utf8')));
  startServer();
  const health = await waitForHealth();
  assert(health.storageMode === 'sqlite', `expected sqlite mode, got ${health.storageMode}`);
  assert(health.integrity?.ok === true, `integrity failed: ${health.integrity?.message}`);
  assert(health.counts.orders === source.data.orders.length, 'order migration count mismatch');
  assert(fs.existsSync(path.join(testDir, 'trade-order-system.sqlite')), 'database file missing');
  assert(fs.readdirSync(path.join(testDir, 'migration-archive')).some(name => name.endsWith('.json')), 'migration archive missing');

  const payload = await request('/api/data');
  assert(Number.isInteger(payload.revision), 'data response did not include a revision');
  const originalNote = payload.data.orders[0]?.note || '';
  payload.data.orders[0].note = 'SQLITE_AUTOMATION_TEST';
  const imageRelative = 'backup-test/invoice.png';
  const imagePath = path.join(testDir, 'attachments', imageRelative);
  fs.mkdirSync(path.dirname(imagePath), { recursive:true });
  fs.writeFileSync(imagePath, Buffer.from('test-invoice-bytes'));
  fs.utimesSync(imagePath, new Date(0), new Date(0));
  payload.data.orders[0].attachments = [{fileUrl:'/attachments/' + imageRelative}];
  const saved = await request('/api/save', {
    method: 'POST',
    body: { state: payload, baseRevision: payload.revision }
  });
  assert(saved.ok === true && saved.revision >= 2, 'save did not advance revision');
  const afterSave = await request('/api/data');
  assert(afterSave.data.orders[0].note === 'SQLITE_AUTOMATION_TEST', 'saved note missing');

  if (afterSave.data.orders.length > 1) {
    const duplicatePayload = structuredClone(afterSave);
    const originalSecondNumber = duplicatePayload.data.orders[1].num;
    duplicatePayload.data.orders[1].num = duplicatePayload.data.orders[0].num;
    const duplicateResult = await request('/api/save', {
      method: 'POST',
      body: { state: duplicatePayload, baseRevision: afterSave.revision },
      allowError: true
    });
    assert(duplicateResult.status === 422 && /重复/.test(duplicateResult.data?.message || ''), `duplicate order number was not rejected with a readable 422: ${duplicateResult.status} ${JSON.stringify(duplicateResult.data)}`);
    const afterRejectedSave = await request('/api/data');
    assert(afterRejectedSave.data.orders[1].num === originalSecondNumber, 'failed transaction changed stored data');

    const swapPayload = structuredClone(afterRejectedSave);
    const [firstNumber, secondNumber] = [swapPayload.data.orders[0].num, swapPayload.data.orders[1].num];
    swapPayload.data.orders[0].num = secondNumber;
    swapPayload.data.orders[1].num = firstNumber;
    await request('/api/save', { method: 'POST', body: { state: swapPayload, baseRevision: swapPayload.revision } });
    const afterSwap = await request('/api/data');
    assert(afterSwap.data.orders[0].num === secondNumber && afterSwap.data.orders[1].num === firstNumber, 'swapping order numbers must save');

    const reusePayload = structuredClone(afterSwap);
    const removed = reusePayload.data.orders.pop();
    reusePayload.data.orders.push({ ...removed, id: `${removed.id}-reissued`, note: 'REISSUED_NUMBER' });
    await request('/api/save', { method: 'POST', body: { state: reusePayload, baseRevision: reusePayload.revision } });
    const afterReuse = await request('/api/data');
    assert(afterReuse.data.orders.at(-1).num === removed.num && !afterReuse.data.orders.some(order => order.id === removed.id), 'a permanently removed order number must be reusable in the same save');

    const trashPayload = structuredClone(afterReuse);
    const trashed = trashPayload.data.orders.pop();
    trashPayload.data.trashOrders.push(trashed);
    trashPayload.data.orders.push({ ...trashed, id: `${trashed.id}-duplicate` });
    const trashDuplicate = await request('/api/save', { method: 'POST', body: { state: trashPayload, baseRevision: trashPayload.revision }, allowError: true });
    assert(trashDuplicate.status === 422, 'an order number still held by the trash must stay unique');
  }

  const renameSource = (await request('/api/data'));
  const renameOrder = renameSource.data.orders.find(order => renameSource.data.customers[order.client]);
  if (renameOrder) {
    await request(`/api/whatsapp/messages?customer=${encodeURIComponent(renameOrder.client)}`);
    const chatDb = new DatabaseSync(path.join(testDir, 'trade-order-system.sqlite'));
    const chatStore = createWhatsAppStore(chatDb);
    const chat = { account: '15550001111@c.us', chatId: '15551234567@c.us', title: 'Rename test' };
    chatStore.bind({ ...chat, customer: renameOrder.client });
    chatStore.sync({ ...chat, messages: [{ id: 'rename-1', direction: 'in', kind: 'text', text: 'hello', timestamp: '' }] });
    chatDb.close();
    const oldName = renameOrder.client;
    const newName = `${oldName} Renamed`;
    renameSource.data.customers[newName] = renameSource.data.customers[oldName];
    delete renameSource.data.customers[oldName];
    renameSource.data.orders.forEach(order => { if (order.client === oldName) order.client = newName; });
    await request('/api/save', { method: 'POST', body: { state: renameSource, baseRevision: renameSource.revision } });
    const renamedChat = await request(`/api/whatsapp/messages?customer=${encodeURIComponent(newName)}`);
    assert(renamedChat.total === 1, 'WhatsApp chat must follow a renamed customer');
  }

  const backupResult = await request('/api/manual-backup', { method: 'POST', body: {} });
  assert(backupResult.ok === true && fs.existsSync(backupResult.file), 'manual backup missing');
  const backupDb = new DatabaseSync(backupResult.file, { readOnly: true });
  const integrity = backupDb.prepare('PRAGMA integrity_check').get();
  backupDb.close();
  assert(integrity.integrity_check === 'ok', 'backup integrity check failed');
  const copiedImage = path.join(backupResult.file + '.attachments', imageRelative);
  assert(fs.existsSync(copiedImage), 'backup must include referenced attachment bytes');
  assert(fs.readFileSync(copiedImage,'utf8') === 'test-invoice-bytes', 'backup attachment mismatch');
  // The next backup does not write the unchanged attachment again: it clones it (APFS) or shares the previous backup's copy.
  // Staging files of a backup that was interrupted long ago are cleared; a recent one may still be in use and stays.
  const staleStaging = path.join(testDir, 'backups', 'trade-order-data-20200101-000000.sqlite.partial');
  const recentStaging = path.join(testDir, 'backups', 'trade-order-data-20200101-000001.sqlite.partial');
  for (const file of [staleStaging, recentStaging]) {
    fs.writeFileSync(file, 'interrupted');
    fs.mkdirSync(file + '.attachments');
    fs.writeFileSync(path.join(file + '.attachments', 'left.png'), 'left');
  }
  for (const file of [staleStaging, staleStaging + '.attachments']) fs.utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
  const secondBackup = await request('/api/manual-backup', { method: 'POST', body: {} });
  assert(secondBackup.ok === true && secondBackup.file !== backupResult.file, 'second manual backup missing');
  assert(secondBackup.attachmentCount === backupResult.attachmentCount && secondBackup.attachmentCopies.copied === 0, `an unchanged attachment was written again: ${JSON.stringify(secondBackup.attachmentCopies)}`);
  const sharedImage = path.join(secondBackup.file + '.attachments', imageRelative);
  assert(fs.readFileSync(sharedImage,'utf8') === 'test-invoice-bytes', 'second backup attachment mismatch');
  assert(fs.statSync(sharedImage).ino !== fs.statSync(imagePath).ino, 'a backup must never share a file with the live attachments folder');
  if (secondBackup.attachmentCopies.linked) assert(fs.statSync(sharedImage).ino === fs.statSync(copiedImage).ino, 'the unchanged attachment is shared with the previous backup');
  assert(!fs.existsSync(staleStaging) && !fs.existsSync(staleStaging + '.attachments'), 'staging files of an interrupted backup were left behind');
  assert(fs.existsSync(recentStaging) && fs.existsSync(recentStaging + '.attachments'), 'staging files that may still be in use were removed');
  fs.rmSync(recentStaging); fs.rmSync(recentStaging + '.attachments', { recursive:true });
  const backupsBeforeFailure = fs.readdirSync(path.join(testDir,'backups')).filter(name=>name.endsWith('.sqlite')).sort();
  fs.unlinkSync(imagePath);
  // A missing attachment no longer aborts the whole backup (report 25 P1-3): the database is still backed up,
  // the missing images are listed next to it and named in a warning.
  const warnedBackup = await request('/api/manual-backup', {method:'POST',body:{},allowError:true});
  assert(warnedBackup.status === 200 && warnedBackup.data.ok === true && fs.existsSync(warnedBackup.data.file), 'a missing attachment must not block the database backup');
  const missingOrderNum = (await request('/api/data')).data.orders[0].num;
  assert(warnedBackup.data.missingAttachments?.some(item => item.orderNum === missingOrderNum && item.files === 1), 'the backup warning must name the order whose attachment is missing');
  assert(warnedBackup.data.warning.includes(missingOrderNum), 'backup warning must name the order');
  assert(JSON.parse(fs.readFileSync(warnedBackup.data.file + '.missing.json', 'utf8')).count === 1, 'missing attachments are listed next to the backup');
  assert(fs.readdirSync(path.join(testDir,'backups')).filter(name=>name.endsWith('.sqlite')).length === backupsBeforeFailure.length + 1, 'backup with a missing attachment must still be written');
  assert(!fs.readdirSync(path.join(testDir,'backups')).some(name=>name.includes('.partial')), 'backup left partial files');
  fs.copyFileSync(copiedImage,imagePath);
  fs.utimesSync(imagePath,new Date(0),new Date(0));
  const deleteResult = await request('/api/delete-attachments', {method:'POST',body:{urls:['/attachments/' + imageRelative]}});
  assert(deleteResult.deleted === 0 && fs.existsSync(imagePath), 'attachment deletion bypassed snapshot protection');
  const withoutImage = await request('/api/data');
  withoutImage.data.orders[0].attachments = [];
  await request('/api/save', {method:'POST',body:{state:withoutImage,baseRevision:withoutImage.revision}});

  await stopServer();
  startServer();
  await waitForHealth();
  const afterRestart = await request('/api/data');
  assert(fs.existsSync(copiedImage), 'cleanup must not erase backup attachments');
  assert(fs.existsSync(imagePath), 'cleanup must preserve attachments referenced by retained backups');
  const restoreDir = path.join(testDir,'restore-verification');
  fs.mkdirSync(restoreDir);
  fs.copyFileSync(backupResult.file,path.join(restoreDir,'trade-order-system.sqlite'));
  fs.cpSync(backupResult.file + '.attachments',path.join(restoreDir,'attachments'),{recursive:true});
  const restored = new DatabaseSync(path.join(restoreDir,'trade-order-system.sqlite'),{readOnly:true});
  const restoredOrder = JSON.parse(restored.prepare('SELECT data_json FROM orders WHERE id = ?').get(payload.data.orders[0].id).data_json);
  restored.close();
  assert(restoredOrder.attachments[0].fileUrl === '/attachments/' + imageRelative, 'restored order lost attachment reference');
  assert(fs.readFileSync(path.join(restoreDir,'attachments',imageRelative),'utf8') === 'test-invoice-bytes', 'restore did not recover attachment bytes');
  assert(afterRestart.data.orders[0].note === 'SQLITE_AUTOMATION_TEST', 'data did not survive restart');
  afterRestart.data.orders[0].note = originalNote;
  console.log(`SQLite storage test passed: ${source.data.orders.length} orders migrated, saved, backed up, and reloaded.`);
}

function normalizePayload(raw) {
  return raw?.data && Array.isArray(raw.data.orders) ? raw : { data: raw };
}

function startServer() {
  child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      TRADE_APP_DATA_DIR: testDir,
      TRADE_APP_PORT: String(port),
      TRADE_APP_NO_OPEN: '1',
      TRADE_API_TOKEN: apiToken,
      TRADE_INSTANCE_NONCE: instanceNonce
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
    processToStop.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { processToStop.kill('SIGTERM'); } catch (_) {
      clearTimeout(timer);
      resolve();
    }
  });
  assert(processToStop.exitCode === 0, `server did not shut down cleanly: ${processToStop.exitCode}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${apiToken}` }
      });
      if (response.ok) {
        const health = await response.json();
        assert(health.instanceNonce === instanceNonce, 'health nonce mismatch');
        return health;
      }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server health check timed out');
}

async function request(route, { method = 'GET', body, allowError = false } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !allowError) throw new Error(data.message || `${route} HTTP ${response.status}`);
  return allowError ? { status: response.status, data } : data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
