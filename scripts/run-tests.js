#!/usr/bin/env node
// Runs every regression test and reports all results instead of stopping at the first failure.
// Usage: node scripts/run-tests.js [name-filter ...]
//
// OTS_TEST_BROWSER=webkit runs the tests that open a browser a second time, in Playwright's WebKit instead of
// Chromium (see helpers/use-webkit.js). The tests that never open one are left out of that run: they would
// only repeat what the Chromium run showed.
//
// OTS_TEST_NOW=<ISO time> runs every test as if it were that moment (see helpers/shift-clock.js): the clock of the
// test processes, the servers they start and the pages they open is moved there and keeps running. CI does this on
// every pull request with the first of next month (.github/workflows/clock.yml). A time without a zone is local time.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scriptsDir = __dirname;
// page.evaluate that returns a page-side promise waits for it by polling (see the comment in that file): a pending
// promise handed straight to Playwright was now and then lost on CI ("Resulting promise was garbage collected").
const stableEvaluate = path.join(scriptsDir, 'helpers', 'stable-evaluate.js');
// click / dblclick / tap first wait until animations on the target and its ancestors have started (see the comment in
// that file): a click on an element that was still sliding in now and then landed beside it and did nothing.
const settledClick = path.join(scriptsDir, 'helpers', 'settled-click.js');
const inWebkit = process.env.OTS_TEST_BROWSER === 'webkit';
const useWebkit = path.join(scriptsDir, 'helpers', 'use-webkit.js');
// Tests that open a browser but cannot run in WebKit, each with its reason. A new test runs there by default.
const notInWebkit = new Map([
  ['test-whatsapp-chrome.js', 'loads the Chrome extension'],
  ['test-webkit-interactions-ui.js', 'imitates WebKit inside Chromium']
]);
// Tests that cannot run with a shifted clock, each with its reason (checked, not "it failed").
const notWithShiftedClock = new Map([
  ['test-sqlite-storage.js', 'the server ages staging and attachment files by Date.now() against their mtime, which the system writes on the real clock, so fresh files look a month old']
]);
const testNow = process.env.OTS_TEST_NOW || '';
if (testNow) {
  const at = Date.parse(testNow);
  if (!Number.isFinite(at)) throw new Error(`OTS_TEST_NOW is not a date: ${testNow}`);
  process.env.OTS_TEST_CLOCK_OFFSET = String(at - Date.now());
}
const shiftClock = path.join(scriptsDir, 'helpers', 'shift-clock.js');
const opensBrowser = name => /require\('playwright'\)|helpers\/board-page/.test(fs.readFileSync(path.join(scriptsDir, name), 'utf8'));

// Opt-in live requests, never part of the default run.
const excluded = new Set(['test-tracking-api.js']);
// Need macOS tools (sips, swift).
const darwinOnly = new Set(['test-app-icon.js', 'native']);

const testFiles = fs.readdirSync(scriptsDir).filter(name => /^test-.*\.js$/.test(name) && !excluded.has(name)).sort();
const commonPreload = ['--require', stableEvaluate, '--require', settledClick];
const preload = [
  ...(testNow ? ['--require', shiftClock] : []),
  ...commonPreload,
  ...(inWebkit ? ['--require', useWebkit] : [])
];
const tests = inWebkit
  ? testFiles.filter(opensBrowser)
    .map(name => ({ name: name.replace(/\.js$/, ''), file: name, command: process.execPath, args: [...preload, path.join(scriptsDir, name)] }))
  : [
    { name: 'check-project', command: process.execPath, args: [path.join(scriptsDir, 'check-project.js')], first: true },
    ...testFiles.map(name => ({ name: name.replace(/\.js$/, ''), file: name, command: process.execPath, args: [...preload, path.join(scriptsDir, name)] })),
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
  if (inWebkit && notInWebkit.has(test.file)) {
    results.push({ test, status: 'skip', ms: 0, output: notInWebkit.get(test.file) });
    return Promise.resolve();
  }
  if (testNow && notWithShiftedClock.has(test.file)) {
    results.push({ test, status: 'skip', ms: 0, output: `shifted clock: ${notWithShiftedClock.get(test.file)}` });
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
  await runPool(selected.filter(test => !test.first));

  const failed = results.filter(result => result.status === 'fail');
  const skipped = results.filter(result => result.status === 'skip');
  for (const result of failed) {
    console.log(`\n--- ${result.test.name} output ---\n${result.output.trim()}`);
  }
  for (const result of skipped) console.log(`SKIP  ${result.test.name}  (${result.output})`);
  const passed = results.length - failed.length - skipped.length;
  console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (testNow) console.log(`Clock shifted: the tests ran as if it were ${new Date(Date.parse(testNow)).toISOString()} (OTS_TEST_NOW=${testNow}).`);
  if (!selected.length) {
    console.log('No tests matched.');
    process.exitCode = 1;
  }
  if (failed.length) process.exitCode = 1;
}

main();
