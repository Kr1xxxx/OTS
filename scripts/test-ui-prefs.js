#!/usr/bin/env node
// The server's copy of the page's preferences (mac-app/ui-prefs.js): theme, accent, the notification
// list. The page keeps them in localStorage, which is lost when the Mac app has to start on another port;
// the server stores them beside the data and writes them into the page it serves.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { freePortSync } = require('./helpers/free-port');
const { createUiPrefs, pageWithPrefs, pageMarker } = require('../mac-app/ui-prefs');

const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-ui-prefs-'));
const port = freePortSync();
const apiToken = `ui-prefs-test-${process.pid}`;
const base = `http://127.0.0.1:${port}`;
let child = null;

// The value of the ots-prefs meta tag as a browser would read it.
function prefsInPage(html) {
  const match = /<meta name="ots-prefs" content="([^"]*)">/.exec(html);
  assert.ok(match, 'the page has no ots-prefs meta tag');
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

function moduleTests() {
  const file = path.join(dir, 'module', 'ui-prefs.json');
  fs.mkdirSync(path.dirname(file));
  const prefs = createUiPrefs({ file });
  assert.deepEqual(prefs.read(), {}, 'nothing stored yet');
  assert.deepEqual(prefs.write({ 'ots-accent-v1':'teal', 'trade-order-system-theme':'dark' }), { 'ots-accent-v1':'teal', 'trade-order-system-theme':'dark' });
  assert.deepEqual(prefs.write({ 'trade-order-system-theme':null }), { 'ots-accent-v1':'teal', 'trade-order-system-theme':null }, 'a removed value is remembered as removed');
  assert.deepEqual(createUiPrefs({ file }).read(), { 'ots-accent-v1':'teal', 'trade-order-system-theme':null }, 'stored in the file');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'readable by the user only');

  for (const [bad, why] of [
    [null, 'no object'], [[], 'an array'], [{ 'Bad Key':'x' }, 'a key with a space'], [{ '../x':'x' }, 'a path as key'],
    [{ 'ots-accent-v1':5 }, 'a number'], [{ 'ots-accent-v1':{ a:1 } }, 'an object'], [{ 'ots-accent-v1':'x'.repeat(256 * 1024 + 1) }, 'a value over the limit']
  ]) {
    assert.throws(() => prefs.write(bad), error => error.status === 400, `${why} is refused`);
  }
  assert.throws(() => prefs.write(Object.fromEntries(Array.from({ length:40 }, (_, i) => [`key-${i}`, 'x']))), error => error.status === 400, 'too many keys');
  assert.deepEqual(prefs.read(), { 'ots-accent-v1':'teal', 'trade-order-system-theme':null }, 'a refused write changes nothing');

  // A file edited by hand, or damaged: what is not a valid entry is dropped, nothing throws.
  fs.writeFileSync(file, JSON.stringify({ 'ots-accent-v1':'rose', 'Bad Key':'x', 'ots-greet-v1':{ a:1 }, 'ots-modal-style-v1':null }));
  assert.deepEqual(prefs.read(), { 'ots-accent-v1':'rose', 'ots-modal-style-v1':null });
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(prefs.read(), {});
  fs.writeFileSync(file, '[1,2]');
  assert.deepEqual(prefs.read(), {});

  // Into the page: any text survives the trip through an HTML attribute, and cannot close the tag.
  const awkward = { 'ots-notif-events-v1':JSON.stringify([{ id:'a', title:'5 < 6 & "quoted" </script><meta x=">' }]), 'ots-accent-v1':null };
  const page = pageWithPrefs(`<head>${pageMarker}</head><body>$& $1 ${'x'.repeat(10)}</body>`, awkward);
  assert.deepEqual(prefsInPage(page), awkward);
  assert.equal((page.match(/<meta /g) || []).length, 1, 'the value stays inside the one tag');
  assert.ok(page.endsWith('<body>$& $1 xxxxxxxxxx</body>'), 'the rest of the page is untouched');
  assert.equal(pageWithPrefs('<p>no tag</p>', awkward), '<p>no tag</p>');
  assert.ok(fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8').includes(pageMarker), 'the page carries the tag the server fills');
}

function startServer() {
  child = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], {
    env:{ ...process.env, TRADE_APP_DATA_DIR:path.join(dir, 'data'), TRADE_APP_PORT:String(port), TRADE_API_TOKEN:apiToken, TRADE_APP_NO_OPEN:'1' },
    stdio:['ignore', 'pipe', 'pipe']
  });
}
async function waitForHealth() {
  for (let tries = 0; tries < 100; tries += 1) {
    try { if ((await fetch(`${base}/api/health`)).status === 200) return; } catch (_) { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}
function stopServer() {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}
const post = (body, headers = { Authorization:`Bearer ${apiToken}`, 'Content-Type':'application/json' }) =>
  fetch(`${base}/api/ui-prefs`, { method:'POST', headers, body:typeof body === 'string' ? body : JSON.stringify(body) });
async function servedPrefs() {
  const first = await fetch(`${base}/trade-order-system.html?token=${apiToken}`, { redirect:'manual' });
  assert.equal(first.status, 303);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const page = await fetch(`${base}/trade-order-system.html`, { headers:{ Cookie:cookie } });
  assert.equal(page.status, 200);
  return prefsInPage(await page.text());
}

async function serverTests() {
  startServer();
  await waitForHealth();
  assert.deepEqual(await servedPrefs(), {}, 'a new data folder: the page gets an empty set, which tells it to send what it has');

  assert.equal((await post({ set:{ 'ots-accent-v1':'teal' } }, { 'Content-Type':'application/json' })).status, 401, 'needs the API token');
  assert.equal((await post({ set:{ 'ots-accent-v1':'teal' } }, { Authorization:`Bearer ${apiToken}`, 'Content-Type':'text/plain' })).status, 415, 'needs JSON');
  assert.equal((await post({ set:{ 'Bad Key':'x' } })).status, 400);
  assert.equal((await post({})).status, 400, 'no set');
  assert.deepEqual(await servedPrefs(), {}, 'refused requests stored nothing');

  const events = JSON.stringify([{ id:'api-dhl', title:'DHL "超时" <b>&</b>', time:'2026-06-30 10:00' }]);
  assert.equal((await post({ set:{ 'ots-accent-v1':'teal', 'trade-order-system-theme':'dark', 'ots-notif-events-v1':events } })).status, 200);
  assert.equal((await post({ set:{ 'trade-order-system-theme':null } })).status, 200);
  const expected = { 'ots-accent-v1':'teal', 'trade-order-system-theme':null, 'ots-notif-events-v1':events };
  assert.deepEqual(await servedPrefs(), expected);

  // They stay with the data folder: another start of the server (as on another port) serves the same.
  await stopServer();
  startServer();
  await waitForHealth();
  assert.deepEqual(await servedPrefs(), expected, 'kept across a restart');
  assert.equal((await fetch(`${base}/trade-order-system.html`)).status, 401, 'the page, and the preferences in it, need the page session');
}

(async () => {
  moduleTests();
  await serverTests();
  console.log('UI prefs passed: stored beside the data, removals remembered, bad input refused, written into the served page safely, kept across a restart.');
})().catch(error => {
  console.error(`UI prefs test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  fs.rmSync(dir, { recursive:true, force:true });
});
