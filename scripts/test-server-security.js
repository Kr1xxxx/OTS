#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'mac-app', 'server.js');
const seedFile = path.join(root, 'trade-order-data.json');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-order-security-test-'));
const port = 50000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const apiToken = `security-token-${process.pid}`;
const instanceNonce = `security-instance-${process.pid}`;
const legacyKey = 'LEGACY_TEST_KEY_DO_NOT_USE';
let child = null;

main().catch(error => {
  console.error(`Server security test failed: ${error.stack || error.message}`);
  if (error.cause) console.error(error.cause);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
});

async function main() {
  fs.copyFileSync(seedFile, path.join(testDir, 'trade-order-data.json'));
  fs.writeFileSync(path.join(testDir, 'ai-settings.json'), JSON.stringify({
    enabled: '是',
    provider: 'zhipu',
    apiKey: legacyKey,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.1'
  }));

  startServer();
  const publicHealth = await waitForHealth({ authenticated: false });
  assert.equal(publicHealth.instanceNonce, instanceNonce);
  assert.equal(Object.hasOwn(publicHealth, 'dataFile'), false, 'public health leaked local paths');
  const resourceHtml = path.join(root, 'mac-app', 'TradeOrderSystem.app', 'Contents', 'Resources', 'trade-order-system.html');
  const expectedUpdatedAt = fs.statSync(resourceHtml).mtime.toISOString();
  assert.equal(publicHealth.appUpdatedAt, expectedUpdatedAt, 'update time must come from the built frontend, not server startup');

  const authenticatedHealth = await request('/api/health');
  assert.equal(authenticatedHealth.ok, true);
  assert.equal(authenticatedHealth.storageMode, 'sqlite');
  assert.equal(authenticatedHealth.appUpdatedAt, expectedUpdatedAt);
  const headerAuthenticatedData = await rawRequest('/api/data', {
    authenticated: false,
    headers: { 'X-Trade-Token': apiToken }
  });
  assert.equal(headerAuthenticatedData.status, 200, 'X-Trade-Token authentication failed');

  await expectStatus('/api/data', 401, { authenticated: false });
  await expectStatus('/api/ai-usage', 401, { authenticated: false });
  const emptyAiUsage = await request('/api/ai-usage');
  assert.equal(emptyAiUsage.ok,true);
  assert.equal(emptyAiUsage.totalCalls,0);
  assert.equal(emptyAiUsage.totalCostUsd,0);
  const {createAiUsageStore}=require(path.join(root,'mac-app','ai-usage-store.js'));
  const usageFixture=createAiUsageStore({file:path.join(testDir,'ai-usage.json'),atomicWrite:(file,text)=>fs.writeFileSync(file,text,{mode:0o600})});
  usageFixture.record({baseUrl:'https://openrouter.ai/api/v1',model:'fixture-a',status:'success',data:{usage:{cost:0.01}}});
  usageFixture.record({baseUrl:'https://openrouter.ai/api/v1',model:'fixture-b',status:'success',data:{usage:{cost:0.02}}});
  const selectedUsage=await request('/api/ai-usage?model=fixture-a&host=openrouter.ai');
  assert.equal(selectedUsage.totalCalls,1,'authenticated usage route must apply model/endpoint filters');
  assert.equal(selectedUsage.totalCostUsd,0.01);
  assert.equal(selectedUsage.records[0].model,'fixture-a');
  assert.equal(selectedUsage.models.length,2,'model picker summaries must retain the other model');
  await expectStatus('/api/ai-usage?model=fixture-a&host=openrouter.ai',401,{authenticated:false});
  await expectStatus('/trade-order-system.html', 401, { authenticated: false });
  const wrongHost = await rawHttpRequest('/api/health', { Host: `attacker.example:${port}` });
  assert.equal(wrongHost.status, 421);

  const bootstrap = await rawRequest('/trade-order-system.html?token=' + encodeURIComponent(apiToken), {
    authenticated: false,
    redirect: 'manual'
  });
  assert.equal(bootstrap.status, 303);
  assert.match(bootstrap.headers.get('set-cookie') || '', /HttpOnly/i);
  assert.match(bootstrap.headers.get('set-cookie') || '', /SameSite=Strict/i);
  assert.equal(bootstrap.headers.get('location'), '/trade-order-system.html#dashboard');
  assert.match(bootstrap.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  const sessionCookie = String(bootstrap.headers.get('set-cookie') || '').split(';', 1)[0];
  const appDocument = await rawRequest('/trade-order-system.html', {
    authenticated: false,
    headers: { Cookie: sessionCookie }
  });
  assert.equal(appDocument.status, 200);
  await expectStatus('/api/fedex-rate', 404, { method: 'POST', body: {} });
  const cookieData = await rawRequest('/api/data', {
    authenticated: false,
    headers: { Cookie: sessionCookie }
  });
  assert.equal(cookieData.status, 200);

  const migratedSettings = JSON.parse(fs.readFileSync(path.join(testDir, 'ai-settings.json'), 'utf8'));
  assert.equal(Object.hasOwn(migratedSettings, 'apiKey'), false, 'legacy settings still contained an API key');
  assert.equal(migratedSettings.model, 'glm-5.1', 'legacy key migration changed the selected AI model');
  const secretFile = path.join(testDir, 'secrets', 'ai-api-key');
  assert.equal(fs.readFileSync(secretFile, 'utf8').trim(), legacyKey);
  assert.equal(fs.statSync(path.dirname(secretFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
  const publicSettings = await request('/api/ai-settings');
  assert.equal(Object.hasOwn(publicSettings, 'apiKey'), false);
  assert.equal(JSON.stringify(publicSettings).includes(legacyKey), false);

  await expectStatus('/api/ai-settings', 403, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: { enabled: '是' }
  });
  await expectStatus('/api/ai-settings', 415, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    rawBody: JSON.stringify({ enabled: '是' })
  });

  const changedEndpoint = await request('/api/ai-settings', {
    method: 'POST',
    body: { ...publicSettings, provider: 'custom', baseUrl: 'https://example.invalid/v1', apiKey: '' }
  });
  assert.equal(changedEndpoint.apiKeySaved, false, 'endpoint change retained the old key');
  assert.equal(fs.existsSync(secretFile), false, 'endpoint change did not delete the old key');
  const replacementKey = 'REPLACEMENT_TEST_KEY_DO_NOT_USE';
  const savedReplacement = await request('/api/ai-settings', {
    method: 'POST',
    body: { ...changedEndpoint, apiKey: replacementKey }
  });
  assert.equal(Object.hasOwn(savedReplacement, 'apiKey'), false);
  assert.equal(fs.readFileSync(secretFile, 'utf8').trim(), replacementKey);

  const snapshotA = await request('/api/data');
  const snapshotB = structuredClone(snapshotA);
  snapshotA.data.customers.SECURITY_A = { note: 'must survive' };
  const saveA = await request('/api/save', {
    method: 'POST',
    body: { state: snapshotA, baseRevision: snapshotA.revision }
  });
  assert.equal(saveA.revision, snapshotA.revision + 1);
  snapshotB.data.customers.SECURITY_B = { note: 'stale writer' };
  const stale = await rawRequest('/api/save', {
    method: 'POST',
    body: { state: snapshotB, baseRevision: snapshotB.revision }
  });
  assert.equal(stale.status, 409, 'stale save did not fail with 409');
  const missingRevision = await rawRequest('/api/save', {
    method: 'POST',
    body: { state: { app: snapshotB.app, version: snapshotB.version, exportedAt: snapshotB.exportedAt, data: snapshotB.data } }
  });
  assert.equal(missingRevision.status, 428, 'save without baseRevision did not fail with 428');
  const finalState = await request('/api/data');
  assert.equal(finalState.data.customers.SECURITY_A.note, 'must survive');
  assert.equal(Boolean(finalState.data.customers.SECURITY_B), false);

  const legacyFlatPayload = structuredClone(finalState);
  legacyFlatPayload.data.customers.LEGACY_FLAT = { note: 'backward compatible payload' };
  const flatSave = await request('/api/save', {
    method: 'POST',
    body: { ...legacyFlatPayload, baseRevision: legacyFlatPayload.revision }
  });
  assert.equal(flatSave.revision, legacyFlatPayload.revision + 1, 'legacy flat save payload stopped working');

  assert.equal(saveA.backup?.ok, true, 'post-commit automatic backup was not created');
  const backupDb = new DatabaseSync(saveA.backup.file, { readOnly: true });
  const backupRevision = Number(backupDb.prepare("SELECT value FROM metadata WHERE key = 'revision'").get().value);
  backupDb.close();
  assert.equal(backupRevision, saveA.revision, 'backup did not contain the committed revision');

  await expectStatus('/api/api-status', 413, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    rawBody: JSON.stringify({ kind: 'x'.repeat(2 * 1024 * 1024) })
  });

  await stopServer();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(path.join(testDir, `trade-order-system.sqlite${suffix}`), { force: true });
  }
  startServer();
  const failedHealthResponse = await waitForHealthResponse({ authenticated: true });
  assert.equal(failedHealthResponse.status, 500);
  const failedHealth = await failedHealthResponse.json();
  assert.equal(failedHealth.storageMode, 'error');
  assert.equal(failedHealth.appUpdatedAt, expectedUpdatedAt, 'restart must not reset the release timestamp');
  assert.match(failedHealth.storageError || failedHealth.integrity?.message || '', /missing/i);

  console.log('Server security test passed: auth, secret migration, CAS, post-commit backup, limits, and fail-closed recovery verified.');
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
  assert.equal(processToStop.exitCode, 0, `server did not shut down cleanly: ${processToStop.exitCode}`);
}

async function waitForHealth({ authenticated }) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await rawRequest('/api/health', { authenticated });
      if (response.status === 200) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server health check timed out');
}

async function waitForHealthResponse(options = {}) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { return await rawRequest('/api/health', options); } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not expose a health response');
}

async function expectStatus(route, expected, options = {}) {
  const response = await rawRequest(route, options);
  assert.equal(response.status, expected, `${route} returned ${response.status}, expected ${expected}`);
}

async function request(route, options = {}) {
  const response = await rawRequest(route, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `${route} HTTP ${response.status}`);
  return data;
}

function rawRequest(route, {
  method = 'GET',
  body,
  rawBody,
  headers = {},
  authenticated = true,
  redirect = 'manual'
} = {}) {
  const text = rawBody === undefined && body !== undefined ? JSON.stringify(body) : rawBody;
  return fetch(`${baseUrl}${route}`, {
    method,
    redirect,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${apiToken}` } : {}),
      ...(body !== undefined && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...headers
    },
    body: text
  });
}

function rawHttpRequest(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, headers }, response => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    request.once('error', reject);
    request.end();
  });
}
