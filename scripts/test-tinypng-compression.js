#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'mac-app', 'server.js');
const seedFile = path.join(root, 'trade-order-data.json');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-order-tinypng-test-'));
const tradePort = 53000 + (process.pid % 500);
const tinifyPort = 53500 + (process.pid % 500);
const tradeBaseUrl = `http://127.0.0.1:${tradePort}`;
const tinifyBaseUrl = `http://127.0.0.1:${tinifyPort}`;
const apiToken = `tinypng-test-${process.pid}`;
const fakeKey = 'TEST_TINYPNG_KEY_DO_NOT_USE';
const originalImage = Buffer.alloc(20 * 1024 * 1024, 0x5a);
const optimizedImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==', 'base64');
let tradeServer = null;
let tinifyServer = null;
let tinifyMode = 'success';
const tinifyCalls = [];

main().catch(error => {
  console.error(`TinyPNG compression test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stopServers();
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
});

async function main() {
  fs.copyFileSync(seedFile, path.join(testDir, 'trade-order-data.json'));
  const secretsDir = path.join(testDir, 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(secretsDir, 'tinypng-api-key'), `${fakeKey}\n`, { mode: 0o600 });
  await startTinifyServer();
  startTradeServer();
  await waitForHealth();

  const optimized = await saveAttachment('TINIFY-SUCCESS');
  assert.equal(optimized.optimized, true);
  assert.equal(optimized.optimizer, 'TinyPNG');
  assert.equal(optimized.compressionCount, 42);
  assert.equal(tinifyCalls.length, 1);
  assert.equal(tinifyCalls[0].authorization, `Basic ${Buffer.from(`api:${fakeKey}`).toString('base64')}`);
  assert.equal(tinifyCalls[0].contentType, 'image/png');
  assert.equal(tinifyCalls[0].body.length, originalImage.length);
  assert.equal(tinifyCalls[0].body[0], originalImage[0]);
  assert.equal(tinifyCalls[0].body.at(-1), originalImage.at(-1));
  assert.deepEqual(readSavedAttachment(optimized.fileUrl), optimizedImage);
  assert.deepEqual(savedAttachmentFiles(optimized.fileUrl), [path.basename(new URL(optimized.fileUrl, tradeBaseUrl).pathname)]);

  tinifyMode = 'failure';
  const fallback = await saveAttachment('TINIFY-FALLBACK');
  assert.equal(fallback.optimized, false);
  assert.equal(fallback.optimizer, '本地原图');
  assert.equal(fallback.fallback, true);
  assert.deepEqual(readSavedAttachment(fallback.fileUrl), originalImage);

  console.log('TinyPNG compression test passed: optimized save, protected secret, and local fallback verified.');
}

function startTinifyServer() {
  tinifyServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/shrink') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        tinifyCalls.push({
          authorization: String(req.headers.authorization || ''),
          contentType: String(req.headers['content-type'] || ''),
          body
        });
        if (tinifyMode === 'failure') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service unavailable' }));
          return;
        }
        res.writeHead(201, {
          'Content-Type': 'application/json',
          Location: `${tinifyBaseUrl}/result`,
          'Compression-Count': '42'
        });
        res.end(JSON.stringify({ output: { size: optimizedImage.length, type: 'image/png', ratio: 0.5, url: `${tinifyBaseUrl}/result` } }));
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/result') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(optimizedImage);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    tinifyServer.once('error', reject);
    tinifyServer.listen(tinifyPort, '127.0.0.1', resolve);
  });
}

function startTradeServer() {
  tradeServer = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      TRADE_APP_DATA_DIR: testDir,
      TRADE_APP_PORT: String(tradePort),
      TRADE_APP_NO_OPEN: '1',
      TRADE_API_TOKEN: apiToken,
      TRADE_TINIFY_ENDPOINT: `${tinifyBaseUrl}/shrink`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function saveAttachment(orderId) {
  const response = await fetch(`${tradeBaseUrl}/api/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trade-Token': apiToken
    },
    body: JSON.stringify({
      orderId,
      fileName: 'order.png',
      mimeType: 'image/png',
      data: `data:image/png;base64,${originalImage.toString('base64')}`
    })
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  return data;
}

function readSavedAttachment(fileUrl) {
  const relative = decodeURIComponent(new URL(fileUrl, tradeBaseUrl).pathname.replace(/^\/attachments\//, ''));
  return fs.readFileSync(path.join(testDir, 'attachments', relative));
}

function savedAttachmentFiles(fileUrl) {
  const relative = decodeURIComponent(new URL(fileUrl, tradeBaseUrl).pathname.replace(/^\/attachments\//, ''));
  return fs.readdirSync(path.dirname(path.join(testDir, 'attachments', relative))).sort();
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${tradeBaseUrl}/api/health`);
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('trade server health check timed out');
}

async function stopServers() {
  if (tradeServer && tradeServer.exitCode === null) {
    const server = tradeServer;
    tradeServer = null;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill('SIGTERM');
    });
  }
  if (tinifyServer) {
    const server = tinifyServer;
    tinifyServer = null;
    await new Promise(resolve => server.close(resolve));
  }
}
