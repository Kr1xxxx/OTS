#!/usr/bin/env node
// Runs every regression test and reports all results instead of stopping at the first failure.
// Usage: node scripts/run-tests.js [name-filter ...]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scriptsDir = __dirname;

// Opt-in live requests, never part of the default run.
const excluded = new Set(['test-tracking-api.js']);
// These start mac-app/server.js on a pid-derived port; run them one at a time.
const serial = new Set([
  'test-feishu-order-notification.js',
  'test-server-security.js',
  'test-sqlite-storage.js',
  'test-tinypng-compression.js',
  'test-whatsapp-integration.js'
]);
// Need macOS tools (sips, swift).
const darwinOnly = new Set(['test-app-icon.js', 'native']);

const tests = [
  { name: 'check-project', command: process.execPath, args: [path.join(scriptsDir, 'check-project.js')], first: true },
  ...fs.readdirSync(scriptsDir)
    .filter(name => /^test-.*\.js$/.test(name) && !excluded.has(name))
    .sort()
    .map(name => ({ name: name.replace(/\.js$/, ''), file: name, command: process.execPath, args: [path.join(scriptsDir, name)] })),
  { name: 'native', file: 'native', command: 'swift', args: ['run', 'TradeOrderSystemCoreTests'], cwd: path.join(root, 'mac-app', 'native') }
];

const filters = process.argv.slice(2);
const selected = tests.filter(test => !filters.length || filters.some(filter => test.name.includes(filter)));
const concurrency = Math.max(1, Number(process.env.OTS_TEST_CONCURRENCY) || Math.min(4, os.availableParallelism?.() || os.cpus().length));
const results = [];

function run(test) {
  if (darwinOnly.has(test.file) && process.platform !== 'darwin') {
    results.push({ test, status: 'skip', ms: 0, output: 'requires macOS' });
    return Promise.resolve();
  }
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(test.command, test.args, { cwd: test.cwd || root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const finish = (code, error) => {
      const result = { test, status: code === 0 ? 'pass' : 'fail', ms: Date.now() - started, output: error ? String(error.message) : output };
      results.push(result);
      console.log(`${result.status === 'pass' ? 'PASS' : 'FAIL'}  ${test.name}  (${(result.ms / 1000).toFixed(1)}s)`);
      resolve();
    };
    child.once('error', error => finish(1, error));
    child.once('close', code => finish(code));
  });
}

async function runPool(list) {
  const queue = [...list];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await run(queue.shift());
  });
  await Promise.all(workers);
}

async function main() {
  const startedAt = Date.now();
  for (const test of selected.filter(test => test.first)) await run(test);
  await runPool(selected.filter(test => !test.first && !serial.has(test.file)));
  for (const test of selected.filter(test => serial.has(test.file))) await run(test);

  const failed = results.filter(result => result.status === 'fail');
  const skipped = results.filter(result => result.status === 'skip');
  for (const result of failed) {
    console.log(`\n--- ${result.test.name} output ---\n${result.output.trim()}`);
  }
  for (const result of skipped) console.log(`SKIP  ${result.test.name}  (${result.output})`);
  const passed = results.length - failed.length - skipped.length;
  console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (!selected.length) {
    console.log('No tests matched.');
    process.exitCode = 1;
  }
  if (failed.length) process.exitCode = 1;
}

main();
