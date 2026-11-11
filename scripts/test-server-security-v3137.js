#!/usr/bin/env node
// V3.137 regression test for audit 29 (server security).
// - P2-1: the browser-mode session cookie is not the API token and cannot call /api/*; the token reaches the
//   page through the redirect's # part only; requests from other ports on 127.0.0.1 (Sec-Fetch-Site:
//   same-site) or other sites are refused, so an <img> on another port cannot make OTS query DHL.
// - P2-2: paste recognition stays fast on pathological long lines (timing test, before: seconds to minutes).
// - P2-3: the detail drawer's 「打开」 goes through safeAttachmentHref; javascript: links are stripped on save
//   and refused when added by hand.
// - P2-4: bad settings / tracking input gets a 4xx with a Chinese message instead of being stored or a 500.
// - Release: scripts/smoke-test-app-bundle.js works with relative --app / --resources paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'mac-app', 'server.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-v3137-'));
const port = freePortSync();
const baseUrl = `http://127.0.0.1:${port}`;
const apiToken = crypto.randomBytes(16).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const servers = [];
let child = null;
let browser = null;

function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function api(pathname, { method = 'GET', body, headers = {}, token = apiToken } = {}) {
  const response = await fetch(baseUrl + pathname, {
    method,
    redirect: 'manual',
    headers: {
      ...(token ? { 'X-Trade-Token': token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: response.status, headers: response.headers, json, text };
}

async function main() {
  // A fake DHL endpoint that counts lookups (the real one is never contacted).
  let dhlHits = 0;
  const dhlPort = await listen((req, res) => {
    dhlHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shipments: [{ id: 'x', status: { statusCode: 'transit', status: 'transit', description: 'In transit' }, events: [] }] }));
  });
  child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env, TRADE_APP_DATA_DIR: dataDir, TRADE_APP_PORT: String(port), TRADE_APP_NO_OPEN: '1',
      TRADE_API_TOKEN: apiToken, TRADE_EXPORT_NO_REVEAL: '1', OTS_DHL_TRACKING_ENDPOINT: `http://127.0.0.1:${dhlPort}/track/shipments`
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverErrors = '';
  child.stderr.on('data', chunk => { serverErrors += chunk; });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch (_) {}
    if (i > 100) throw new Error(`server did not start: ${serverErrors}`);
    await sleep(100);
  }

  // ---------- P2-1: cookie is not the token; /api/* needs the token; same-site requests are refused ----------
  const bootstrap = await api('/trade-order-system.html?token=' + apiToken + '&foo=1', { token: '' });
  assert.equal(bootstrap.status, 303);
  assert.equal(bootstrap.headers.get('location'), `/trade-order-system.html?foo=1#ots-token=${apiToken}`, 'the token goes to the page in the # part');
  const setCookie = bootstrap.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.ok(!setCookie.includes(apiToken), 'the session cookie must not be the API token');
  const cookie = setCookie.split(';', 1)[0];
  assert.equal((await api('/trade-order-system.html', { token: '', headers: { Cookie: cookie } })).status, 200, 'the cookie still loads the page');
  assert.equal((await api('/attachments/none/missing.png', { token: '', headers: { Cookie: cookie } })).status, 404, 'the cookie still reaches attachments (404 = authorized, not found)');
  for (const route of ['/api/data', '/api/tracking-settings', '/api/track?number=1234567890&carrier=DHL']) {
    assert.equal((await api(route, { token: '', headers: { Cookie: cookie } })).status, 401, `${route} must not accept the session cookie`);
  }
  assert.equal((await api('/api/save', { method: 'POST', body: { state: {} }, token: '', headers: { Cookie: cookie } })).status, 401);
  assert.equal((await api('/api/data', { token: '', headers: { Cookie: `trade_api_session=${apiToken}` } })).status, 401, 'the old cookie value (= token) must not work either');

  // DHL configured, positive control: a request with the token does query DHL.
  const saved = await api('/api/tracking-settings', { method: 'POST', body: { dhlApiEnabled: '是', dhlApiKey: 'FAKE_DHL_KEY_FOR_TEST' } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await api('/api/track?number=1234567890&carrier=DHL', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal(dhlHits, 1, 'control: the token-authorized lookup reaches the fake DHL');
  for (const site of ['same-site', 'cross-site']) {
    const refused = await api('/api/track?number=1234567890&carrier=DHL', { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(refused.status, 403, `Sec-Fetch-Site: ${site} must be refused`);
    assert.equal((await api('/trade-order-system.html', { token: '', headers: { Cookie: cookie, 'Sec-Fetch-Site': site } })).status, 403);
  }
  assert.equal(dhlHits, 1, 'refused requests must not query DHL');
  assert.equal((await api('/api/health', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200, 'address-bar navigation (none) still works');

  // In a real browser: open the startup URL, then visit another port on 127.0.0.1 in the same browser.
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => { pageErrors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  // ECB / BOC lookups would leave the machine: answer them here.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.fulfill({ status: 503, body: '' }));
  await page.goto(`${baseUrl}/trade-order-system.html?token=${apiToken}`);
  await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  assert.equal(await page.evaluate(() => location.hash), '#dashboard', 'the token is removed from the address');
  assert.ok(!(await page.evaluate(() => location.href)).includes(apiToken));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('trade-order-system-api-token')), apiToken);
  assert.ok(await page.evaluate(() => state.orders.length >= 0 && document.documentElement.classList.contains('mac-app-mode')));
  const otherPortCookies = [];
  const otherPort = await listen((req, res) => {
    otherPortCookies.push(String(req.headers.cookie || ''));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>other</title><img src="${baseUrl}/api/track?number=9999999999&amp;carrier=DHL"><img src="${baseUrl}/api/ecb-rates">`);
  });
  const other = await context.newPage();
  await other.goto(`http://127.0.0.1:${otherPort}/`);
  await other.waitForLoadState('load');
  await sleep(300);
  assert.equal(dhlHits, 1, 'a page on another 127.0.0.1 port must not make OTS query DHL');
  const leaked = otherPortCookies.join(';').match(/trade_api_session=([^;\s]+)/);
  assert.ok(leaked, 'the other port does see the host cookie (RFC 6265 ignores ports)');
  assert.notEqual(decodeURIComponent(leaked[1]), apiToken, 'but it is not the API token');
  assert.equal((await api('/api/data', { token: decodeURIComponent(leaked[1]) })).status, 401, 'and it cannot be used as a token');
  assert.equal((await api('/api/data', { token: '', headers: { Cookie: `trade_api_session=${leaked[1]}` } })).status, 401);
  await other.close();
  // Reload keeps the token (sessionStorage) and the page keeps working.
  await page.reload();
  await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  assert.equal(await page.evaluate(async () => (await window.tradeApiFetch('/api/revision')).status), 200);
  // A tab opened by hand (cookie only, no token) gets a clear Chinese message instead of an English 401.
  const bare = await context.newPage();
  await bare.goto(`${baseUrl}/trade-order-system.html`);
  await bare.waitForFunction(() => document.body.textContent.includes('用启动时给出的地址重新打开'), null, { timeout: 15000 });
  await bare.close();

  // ---------- P2-4: settings / tracking validation ----------
  const expect4xx = async (label, pathname, options, status = 400, message) => {
    const result = await api(pathname, options);
    assert.equal(result.status, status, `${label}: ${result.status} ${result.text.slice(0, 200)}`);
    if (message) assert.match(result.json?.message || '', message, label);
  };
  await expect4xx('ai model too long', '/api/ai-settings', { method: 'POST', body: { model: 'm'.repeat(800000) } }, 400, /model 太长/);
  await expect4xx('ai status object', '/api/ai-settings', { method: 'POST', body: { lastTestStatus: { a: 1 } } }, 400, /lastTestStatus 必须是文字/);
  await expect4xx('tracking times huge', '/api/tracking-settings', { method: 'POST', body: { autoRunTimes: 'x'.repeat(900000) } }, 400);
  await expect4xx('tracking times bad', '/api/tracking-settings', { method: 'POST', body: { autoRunTimes: '9点' } }, 400, /09:00,18:00/);
  await expect4xx('tracking status object', '/api/tracking-settings', { method: 'POST', body: { lastStatus: { a: 1 } } }, 400, /lastStatus 必须是文字/);
  await expect4xx('track number too long', `/api/track?number=${'1'.repeat(8000)}&carrier=DHL`, {}, 400, /物流单号太长/);
  await expect4xx('track number long after cleanup', `/api/track?number=${'1'.repeat(60)}&carrier=DHL`, {}, 400, /物流单号太长/);
  await expect4xx('track carrier unknown', '/api/track?number=1234567890&carrier=%3Cb%3Ex%3C%2Fb%3E', {}, 400, /承运商/);
  assert.equal(dhlHits, 1, 'rejected lookups never reach DHL');
  const goodTimes = await api('/api/tracking-settings', { method: 'POST', body: { autoRunTimes: '08:30,17:45' } });
  assert.equal(goodTimes.status, 200);
  assert.equal(goodTimes.json.autoRunTimes, '08:30,17:45');
  const tracking = await api('/api/tracking-settings');
  assert.equal(typeof tracking.json.lastStatus, 'string');
  assert.ok(tracking.json.lastStatus.length <= 500);
  // Old settings files with oversized / wrong-typed values are clamped on read.
  const aiFile = path.join(dataDir, 'ai-settings.json');
  fs.writeFileSync(aiFile, JSON.stringify({ enabled: '否', provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', model: 'q'.repeat(5000), lastTestStatus: { a: 1 } }));
  const ai = await api('/api/ai-settings');
  assert.equal(ai.json.model.length, 200);
  assert.equal(ai.json.lastTestStatus, '尚未测试连接');
  await expect4xx('save without orders', '/api/save', { method: 'POST', body: { state: { data: {} } } }, 400, /订单列表/);
  await expect4xx('save array', '/api/save', { method: 'POST', body: '[]' }, 400);

  // ---------- P2-3 (server half): unsafe attachment links are stripped on save ----------
  const current = (await api('/api/data')).json;
  const order = current.data.orders[0];
  order.attachments = [
    { name: 'js', type: '其他', link: 'javascript:fetch("/api/data")', time: '2026-11-09 10:00' },
    { name: 'js2', type: '其他', link: ' \tJaVaScRiPt:alert(1)', time: '2026-11-09 10:00' },
    { name: 'html', type: '其他', link: 'data:text/html,<script>alert(1)</script>', time: '2026-11-09 10:00' },
    { name: 'file', type: '其他', link: 'file:///etc/passwd', time: '2026-11-09 10:00' },
    { name: 'web', type: '其他', link: 'https://example.com/invoice.pdf', time: '2026-11-09 10:00' },
    { name: 'note', type: '其他', link: 'Note: 发票在邮箱里', time: '2026-11-09 10:00' },
    { name: 'img', type: '其他', link: 'data:image/png;base64,AAAA', time: '2026-11-09 10:00' }
  ];
  const save = await api('/api/save', { method: 'POST', body: { state: current.data, baseRevision: current.revision } });
  assert.equal(save.status, 200, save.text);
  const reread = (await api('/api/data')).json.data.orders.find(item => item.id === order.id);
  assert.deepEqual(reread.attachments.map(item => item.link), ['', '', '', '', 'https://example.com/invoice.pdf', 'Note: 发票在邮箱里', 'data:image/png;base64,AAAA']);
  assert.deepEqual(pageErrors, []);
  await context.close();

  // ---------- P2-3 (page half) and P2-2: drawer link rule, add-attachment check, recognition timing ----------
  const attachments = [
    { name: '恶意链接', type: '其他', link: 'javascript:document.title="pwned"', time: '2026-11-09 10:00' },
    { name: '备注', type: '其他', link: '发票在邮箱里', time: '2026-11-09 10:00' },
    { name: '网页', type: '其他', link: 'https://example.com/a.pdf', time: '2026-11-09 10:00' },
    { name: '图片', type: '付款截图', fileUrl: '/attachments/o1/a.png', time: '2026-11-09 10:00' }
  ];
  const board = await openBoard(browser, { orders: [{ ...base, id: 'o1', num: 'SO1', client: 'Acme', amount: 100, paidAmount: 0, stage: 'quote', createdAt: day(2), attachments }] }, { port: freePortSync() });
  const p = board.page;
  await p.evaluate(() => openOrderDetail('o1'));
  await h.click(p, '[data-detail-tab-btn="attachments"]');
  await p.waitForSelector('#orderDetailBody .detail-attachment');
  const drawer = await p.evaluate(() => [...document.querySelectorAll('#orderDetailBody .detail-attachment')].map(row => ({
    href: row.querySelector('a.btn')?.getAttribute('href') || null,
    note: row.querySelector('.detail-attachment-note')?.textContent || null
  })));
  assert.equal(await p.locator('#orderDetailBody a[href^="javascript:" i]').count(), 0, 'no javascript: link in the drawer');
  assert.deepEqual(drawer, [
    { href: null, note: 'javascript:document.title="pwned"' },
    { href: null, note: '发票在邮箱里' },
    { href: 'https://example.com/a.pdf', note: null },
    { href: '/attachments/o1/a.png', note: null }
  ]);
  await p.evaluate(() => closeOrderDetail?.());
  // Adding an attachment by hand: a javascript: link is refused with a hint; a plain note is kept.
  await p.evaluate(() => { openOrder('o1'); uiOrderCompact(document.getElementById('orderForm'), false); });
  await p.waitForSelector('#attachmentLink', { state: 'visible' });
  const before = await p.evaluate(() => JSON.parse(document.querySelector('#orderForm [name="attachmentsJson"]').value).length);
  await p.locator('#attachmentLink').fill('javascript:alert(1)');
  await h.click(p, '#addAttachmentBtn');
  await h.waitToast(p, '链接要以 https:// 开头');
  assert.equal(await p.evaluate(() => JSON.parse(document.querySelector('#orderForm [name="attachmentsJson"]').value).length), before);
  await h.clearToasts(p);
  await p.locator('#attachmentLink').fill('原件在快递袋里');
  await h.click(p, '#addAttachmentBtn');
  await p.waitForFunction(n => JSON.parse(document.querySelector('#orderForm [name="attachmentsJson"]').value).length === n + 1, before);

  // P2-2 timing. Before the fix each of these took seconds (20 000 chars: 5–54 s, 50 000: up to 94 s).
  const timings = await p.evaluate(() => {
    const n = 20000;
    const paragraph = 'the quick brown fox jumps over the lazy dog and we ship hair to you soon, '.repeat(Math.ceil(n / 70)).slice(0, n);
    // Tokens shorter than the 300-char pre-clean, packed into lines under the 4000-char cap: only bounded regexes help here.
    const shortTokens = Array.from({ length: 12 }, () => Array.from({ length: 13 }, () => 'a.'.repeat(145)).join(' ')).join('\n');
    const shortWords = Array.from({ length: 12 }, () => Array.from({ length: 13 }, () => 'x'.repeat(290)).join(' ')).join('\n');
    const cases = {
      paragraph,
      url: 'see https://example.com/p?' + 'utm_source=x&'.repeat(Math.ceil(n / 13)).slice(0, n),
      base64: 'Photo: data:image/jpeg;base64,' + 'QUJD'.repeat(n / 4),
      word20k: 'a'.repeat(n),
      word50k: 'a'.repeat(50000),
      dots: 'a.'.repeat(n / 4) + '@' + 'b.'.repeat(n / 4),
      dashes: 'x-'.repeat(n / 2),
      shortTokens,
      shortWords,
      cityWords: 'Ab Cd Ef, '.repeat(390)
    };
    const out = {};
    for (const [name, text] of Object.entries(cases)) {
      let t = performance.now();
      analyzePasteText(text);
      const order = performance.now() - t;
      t = performance.now();
      analyzeCustomerPasteText(text);
      const customer = performance.now() - t;
      out[name] = [Math.round(order), Math.round(customer)];
    }
    // The bounded email / address patterns on their own, without the pre-clean (other callers pass raw text).
    let t = performance.now();
    findEmailsInText('a.'.repeat(25000));
    customerExcludedEmails('a.'.repeat(10000) + ' not ' + 'b.'.repeat(10000));
    isCityStateZipLine('Ab Cd '.repeat(5000));
    isLocalStreetLine('Haupt'.repeat(10000));
    out.rawPatterns = [Math.round(performance.now() - t), 0];
    return out;
  });
  const budget = Number(process.env.OTS_PASTE_BUDGET_MS || 1500);
  for (const [name, [order, customer]] of Object.entries(timings)) {
    assert.ok(order < budget && customer < budget, `paste recognition too slow on ${name}: order ${order} ms, customer ${customer} ms (budget ${budget} ms)`);
  }
  // Recognition still works on normal text after the change.
  const recognized = await p.evaluate(() => analyzeCustomerPasteText('Name: Tasha Green\nEmail: tasha.green@example.com\n123 Main St\nAustin, TX 78701\nUnited States').extracted);
  assert.equal(recognized.email, 'tasha.green@example.com');
  assert.match(recognized.address || '', /Austin, TX 78701/);
  const longLink = await p.evaluate(() => {
    const link = 'https://example.com/?' + 'x'.repeat(400);
    return analyzePasteText(`备注：${link}`).extracted.note.includes(link);
  });
  assert.equal(longLink, true, 'the note keeps a long link from the original text');
  assert.deepEqual(board.errors, []);
  assert.deepEqual(board.dialogs, []);
  await browser.close();
  browser = null;

  // ---------- Release smoke test with relative paths (the V3.136 release job failed with ENOENT) ----------
  // The workflow runs `--app smoke/TradeOrderSystem.app`; the bundled node-runtime and server.js must be found
  // even though the server is started with cwd = Resources. node-runtime here is a link to this Node.
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-v3137-smoke-'));
  try {
    const resources = path.join(smokeRoot, 'smoke', 'TradeOrderSystem.app', 'Contents', 'Resources');
    fs.mkdirSync(resources, { recursive: true });
    for (const file of ['server.js', 'feishu-settings.js', 'ai-usage-store.js', 'whatsapp-store.js', 'subscription-store.js', 'backup-attachments.js', 'whatsapp-native-host.js']) fs.copyFileSync(path.join(root, 'mac-app', file), path.join(resources, file));
    for (const file of ['trade-order-system.html', 'trade-order-data.json']) fs.copyFileSync(path.join(root, file), path.join(resources, file));
    fs.symlinkSync(process.execPath, path.join(resources, 'node-runtime'));
    const smokeScript = path.join(__dirname, 'smoke-test-app-bundle.js');
    for (const args of [['--app', path.join('smoke', 'TradeOrderSystem.app')], ['--resources', path.join('smoke', 'TradeOrderSystem.app', 'Contents', 'Resources')]]) {
      const output = execFileSync(process.execPath, [smokeScript, ...args], { cwd: smokeRoot, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.match(output, /Smoke test passed.*the bundled Node/, `relative ${args[0]} must work: ${output}`);
    }
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
  console.log(`V3.137 server security test passed (paste timings ms ${JSON.stringify(timings)}).`);
}

main().catch(error => {
  console.error(`V3.137 server security test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  try { await browser?.close(); } catch (_) {}
  servers.forEach(server => { try { server.closeAllConnections?.(); server.close(); } catch (_) {} });
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000); });
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
});
