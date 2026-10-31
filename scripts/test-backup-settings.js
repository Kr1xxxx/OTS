#!/usr/bin/env node
// Backup directory is configurable (e.g. iCloud Drive) and the server reports the last backup time:
// GET /api/backup-settings shows the default dir, POST moves backups to a new writable dir and
// persists it across restarts, manual backups land in the chosen dir, an invalid dir is rejected,
// and '' restores the default.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'mac-app', 'server.js');
const seedFile = path.join(root, 'trade-order-data.json');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-order-backup-test-'));
const altDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-order-backup-alt-'));
const port = 49000 + (process.pid % 900);
const baseUrl = `http://127.0.0.1:${port}`;
const apiToken = `backup-test-${process.pid}`;
let child = null;

main().catch(error => {
  console.error(`Backup settings test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  for (const dir of [testDir, altDir]) { try { fs.rmSync(dir, { recursive:true, force:true }); } catch (_) {} }
});

async function main() {
  fs.copyFileSync(seedFile, path.join(testDir, 'trade-order-data.json'));
  startServer();
  await waitForHealth();
  const initial = await request('/api/backup-settings');
  assert(initial.ok === true && initial.isDefault === true, 'fresh install must use the default backup dir');
  assert(initial.dir === path.join(testDir, 'backups'), `default dir should live under the data dir, got ${initial.dir}`);
  assert(initial.lastBackupAt === 0 || typeof initial.lastBackupAt === 'number', 'lastBackupAt must be a number');

  const rejected = await request('/api/backup-settings', { method:'POST', body:{ backupDir:'relative/path' }, allowError:true });
  assert(rejected.status === 400, `relative dir must be rejected, got ${rejected.status}`);
  const insideAttachments = await request('/api/backup-settings', { method:'POST', body:{ backupDir:path.join(testDir, 'attachments', 'x') }, allowError:true });
  assert(insideAttachments.status === 400, 'attachments dir must be rejected');

  const target = path.join(altDir, 'iCloud', 'OTS 备份');
  const moved = await request('/api/backup-settings', { method:'POST', body:{ backupDir:target } });
  assert(moved.ok === true && moved.isDefault === false && moved.dir === target, `dir should move to ${target}`);
  assert(fs.existsSync(target), 'new backup dir must be created');

  const before = Date.now();
  const backup = await request('/api/manual-backup', { method:'POST' });
  assert(backup.ok === true && backup.file.startsWith(target), `manual backup must land in the chosen dir, got ${backup.file}`);
  const after = await request('/api/backup-settings');
  assert(after.sqliteCount === 1 && after.lastBackupAt >= before, 'summary must count the new backup and report its time');
  const health = await request('/api/health');
  assert(health.backups.dir === target && health.backups.lastBackupAt >= before, 'health must carry the backup dir and last backup time');

  await stopServer();
  startServer();
  await waitForHealth();
  const reloaded = await request('/api/backup-settings');
  assert(reloaded.dir === target && reloaded.sqliteCount === 1, 'backup dir must survive a restart');

  const reset = await request('/api/backup-settings', { method:'POST', body:{ backupDir:'' } });
  assert(reset.isDefault === true && reset.dir === path.join(testDir, 'backups'), 'empty value restores the default dir');
  assert(!fs.existsSync(path.join(testDir, 'backup-settings.json')), 'reset removes the settings file');

  const unauthorized = await fetch(`${baseUrl}/api/backup-settings`);
  assert(unauthorized.status === 401, 'backup settings need the session token');
  console.log('Backup settings test passed: default dir, validation, move + manual backup, restart persistence, reset, auth.');
}

function startServer() {
  child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, TRADE_APP_DATA_DIR:testDir, TRADE_APP_PORT:String(port), TRADE_APP_NO_OPEN:'1', TRADE_API_TOKEN:apiToken },
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
    processToStop.kill('SIGTERM');
  });
}
async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { cache:'no-store', headers:{ Authorization:`Bearer ${apiToken}` } });
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy');
}
async function request(route, { method = 'GET', body, allowError = false } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { Authorization:`Bearer ${apiToken}`, ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !allowError) throw new Error(data.message || `${route} HTTP ${response.status}`);
  return allowError ? { status:response.status, data } : data;
}
function assert(condition, message) { if (!condition) throw new Error(message); }
