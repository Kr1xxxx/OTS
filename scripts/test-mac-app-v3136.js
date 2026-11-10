#!/usr/bin/env node
// V3.136 regression test for audit 28 (Mac App: auto update, zoom, title bar) and the native-shell
// items handed over from audit 27 (single instance, orphaned server, quit prompt, server restart).
// - UI (real server, page wrapped in a fake Mac shell: webkit handlers, window pt ÷ zoom = CSS viewport):
//   the sidebar stays at 105%–120% in narrow windows; the 更新 button text fits, has a live accessible
//   name and enough contrast; bell copy points at the real button; zoom from shortcuts is shown in
//   settings and announced once; dark/light follows the system until the user picks one; full screen
//   drops the title-bar gap; the pre-update backup is labelled 安装更新前.
// - Server: one server per data folder (exit 75), stale locks and orphaned servers are taken over,
//   the server leaves with its host app, a busy port exits instead of hanging.
// - Installer script (extracted from AppUpdater.swift, run under bash with stubs): the old version
//   is kept until the new one reports a loaded page, and restored when it does not.
// - Release workflow waits for CI and smoke-tests the package; Swift wiring checked by reading.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'mac-app', 'server.js');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-v3136-'));
const children = new Set();
const grandchildPids = [];   // servers started by a fake host app; killed at the end if a check failed midway

function startServer(dataDir, { port = freePortSync(), env = {}, command = process.execPath, args = [serverFile] } = {}) {
  const apiToken = crypto.randomBytes(16).toString('hex');
  const instanceNonce = crypto.randomBytes(8).toString('hex');
  const child = spawn(command, args, {
    env: { ...process.env, TRADE_APP_DATA_DIR: dataDir, TRADE_APP_PORT: String(port), TRADE_APP_NO_OPEN: '1', TRADE_API_TOKEN: apiToken, TRADE_INSTANCE_NONCE: instanceNonce, TRADE_EXPORT_NO_REVEAL: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => { children.delete(child); resolve(code); }));
  return { child, port, apiToken, instanceNonce, exited, output: () => output };
}

async function waitHealthy(server, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`server exited (${server.child.exitCode}): ${server.output()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`, { headers:{ Authorization:`Bearer ${server.apiToken}` } });
      const body = await res.json();
      if (body.ok && body.instanceNonce === server.instanceNonce) return body;
    } catch (_) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`server not healthy: ${server.output()}`);
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function waitFor(check, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
  throw new Error(`timed out: ${label}`);
}
const stop = async server => { if (server.child.exitCode === null) { server.child.kill('SIGTERM'); await server.exited; } };

// ---------- 1. Static checks: release workflow and native wiring ----------
function checkReleaseWorkflow() {
  const yml = read('.github/workflows/release.yml');
  assert.match(yml, /workflow_run:\s*\n\s*workflows: \[CI\]\s*\n\s*types: \[completed\]/, 'release runs after CI completes');
  assert.doesNotMatch(yml, /^\s*push:/m, 'release no longer starts on its own in parallel with CI');
  assert.match(yml, /github\.event\.workflow_run\.conclusion == 'success'/, 'only a successful CI run releases');
  assert.match(yml, /github\.event\.workflow_run\.head_branch == 'main'/, 'only main releases');
  assert.match(yml, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$SHA/, 'manual runs also require green CI for the commit');
  assert.match(yml, /needs: gate/, 'the build waits for the gate job');
  assert.match(yml, /ref: \$\{\{ needs\.gate\.outputs\.sha \}\}/, 'the build checks out the commit CI tested');
  assert.match(yml, /node scripts\/smoke-test-app-bundle\.js --app/, 'the packaged app is started before publishing');
  assert.ok(yml.indexOf('smoke-test-app-bundle') < yml.indexOf('gh release create'), 'smoke test runs before publishing');
  assert.match(yml, /--target "\$\{\{ needs\.gate\.outputs\.sha \}\}"/, 'the release is tagged at the tested commit');
}

function checkNativeSources() {
  const main = read('mac-app/native/Sources/TradeOrderSystemNative/main.swift');
  const updater = read('mac-app/native/Sources/TradeOrderSystemNative/AppUpdater.swift');
  const expectMain = {
    'zoom script re-installed on change (reload keeps zoom)': /private func setUiZoom[\s\S]{0,300}installUserScripts\(webView\.configuration\.userContentController\)/,
    'web content crash reloads': /func webViewWebContentProcessDidTerminate\(_ webView: WKWebView\)[\s\S]{0,200}loadApp\(identity: identity\)/,
    'single instance check': /NSRunningApplication\.runningApplications\(withBundleIdentifier: identifier\)/,
    'server leaves with the app': /environment\["TRADE_APP_EXIT_WITH_PARENT"\] = "1"/,
    'server restarted when it dies': /process\.terminationHandler = \{[\s\S]{0,300}restartServerIfNeeded/,
    'lock exit code stops port retries': /serverLockedExitCode: Int32 = 75/,
    'quit timeout asks the page first': /saveTimedOut \{\s*\n\s*probePageDialog\(timeout: 2\)/,
    'native fallback defaults to the safe button': /hasDestructiveAction = true[\s\S]{0,80}alertSecondButtonReturn/,
    '⌘Q during an update is answered': /if terminationInProgress \{\s*\n[^\n]*\n[^\n]*\n\s*terminationReplyPending = true/,
    'window menu': /NSApp\.windowsMenu = windowMenu/,
    'double click on the title area': /AppleActionOnDoubleClick/,
    'full screen class': /windowDidEnterFullScreen[\s\S]{0,120}setFullScreenClass\(true\)/,
    'sidebar strip above the logo is draggable': /brandRect\.top - sidebarRect\.top/,
    'open popovers are not drag areas': /\.app-select-popover:not\(\[hidden\]\)/,
    'messages only from the main page frame': /message\.webView === webView, message\.frameInfo\.isMainFrame/,
    'native appearance follows the page': /NSApp\.appearance = NSAppearance\(named: \.darkAqua\)/,
    'startup error offers retry': /addButton\(withTitle: "重试"\)/,
    'backup before update': /otsBackupBeforeUpdate/,
    'install is confirmed first': /confirmText: "现在安装并重启"/,
    'periodic update checks': /scheduleAutomaticUpdateCheck\(\)/
  };
  for (const [label, pattern] of Object.entries(expectMain)) assert.match(main, pattern, `main.swift: ${label}`);
  const expectUpdater = {
    'busy click is queued': /if userInitiated \{ pendingUserCheck = true \}/,
    'unsaved forms checked before download': /unsavedFormsBlocker\(\) \{ throw[\s\S]{0,400}await install\(asset/,
    'confirm before install': /guard await confirmInstall\(/,
    'free space checked': /volumeAvailableCapacityForImportantUsage/,
    'tool error text kept': /readDataToEndOfFile\(\)/,
    'interrupted download cleaned up': /func cleanupInterruptedDownload\(\)/,
    'new version reports in': /update-ok-\\\(current\)/,
    'rollback explained': /update-rolled-back/
  };
  for (const [label, pattern] of Object.entries(expectUpdater)) assert.match(updater, pattern, `AppUpdater.swift: ${label}`);
  // The two Swift files must stay balanced (no Swift compiler here): brackets in code only, skipping
  // comments and string literals but counting the code inside string interpolations \( … ).
  for (const [name, text] of [['main.swift', main], ['AppUpdater.swift', updater]]) {
    assert.deepEqual(swiftBracketBalance(text), { '{':0, '(':0, '[':0 }, `${name}: unbalanced brackets`);
  }
}

function swiftBracketBalance(text) {
  const counts = { '{':0, '(':0, '[':0 };
  const closers = { '}':'{', ')':'(', ']':'[' };
  const frames = [];   // open interpolations: the string they return to and their own paren depth
  let mode = 'code';
  let quote = '';
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (mode === 'code') {
      if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
      if (text.startsWith('/*', i)) { i = text.indexOf('*/', i) + 2; continue; }
      if (text.startsWith('"""', i) || ch === '"') { quote = text.startsWith('"""', i) ? '"""' : '"'; mode = 'string'; i += quote.length; continue; }
      const frame = frames[frames.length - 1];
      if (ch === ')' && frame && frame.depth === 0) { frames.pop(); quote = frame.quote; mode = 'string'; i += 1; continue; }
      if (frame && ch === '(') frame.depth += 1;
      if (frame && ch === ')') frame.depth -= 1;
      if (ch in counts) counts[ch] += 1;
      if (ch in closers) counts[closers[ch]] -= 1;
      i += 1;
      continue;
    }
    if (ch === '\\' && text[i + 1] === '(') { frames.push({ quote, depth:0 }); mode = 'code'; i += 2; continue; }
    if (ch === '\\') { i += 2; continue; }
    if (text.startsWith(quote, i)) { mode = 'code'; i += quote.length; continue; }
    i += 1;
  }
  return counts;
}

// ---------- 2. Installer script under bash ----------
function installerScript() {
  const swift = read('mac-app/native/Sources/TradeOrderSystemNative/AppUpdater.swift');
  const match = /private static let installerScript = """\n([\s\S]*?)\n {4}"""/.exec(swift);
  assert.ok(match, 'installer script found');
  return match[1].split('\n').map(line => line.replace(/^ {4}/, '')).join('\n').replace(/\\\\/g, '\\');
}

function runInstaller(scenario) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `install-${scenario}-`));
  const target = path.join(dir, 'Applications', 'TradeOrderSystem.app');
  const staging = path.join(dir, 'staging');
  const markers = path.join(dir, 'support');
  const stubs = path.join(dir, 'bin');
  for (const folder of [target, path.join(staging, 'unpacked', 'TradeOrderSystem.app'), markers, stubs]) fs.mkdirSync(folder, { recursive:true });
  fs.writeFileSync(path.join(target, 'version'), '3.135');
  const newApp = path.join(staging, 'unpacked', 'TradeOrderSystem.app');
  fs.writeFileSync(path.join(newApp, 'version'), '3.136');
  if (scenario === 'install-fails') fs.rmSync(newApp, { recursive:true });
  // open: log what was opened; a working new version writes update-ok-<version> once it sees update-pending-<version>.
  fs.writeFileSync(path.join(stubs, 'open'), `#!/bin/bash
v="$(cat "$1/version" 2>/dev/null)"
echo "$v" >> "${dir}/open.log"
if [ "${scenario}" = ok ] && [ -f "${markers}/update-pending-$v" ]; then touch "${markers}/update-ok-$v"; fi
`, { mode:0o755 });
  fs.writeFileSync(path.join(stubs, 'xattr'), '#!/bin/bash\nexit 0\n', { mode:0o755 });
  fs.writeFileSync(path.join(stubs, 'pkill'), `#!/bin/bash\necho "$@" >> "${dir}/pkill.log"\nexit 0\n`, { mode:0o755 });
  fs.writeFileSync(path.join(stubs, 'pgrep'), '#!/bin/bash\nexit 1\n', { mode:0o755 });
  const script = path.join(dir, 'install-update.sh');
  fs.writeFileSync(script, installerScript());
  // "The app that is quitting": a process that ends in 0.5 s and is reaped by the system (spawnSync blocks
  // this event loop, so a direct child would stay a zombie that kill -0 still sees).
  const quittingPid = spawnSync('bash', ['-c', 'sleep 0.5 >/dev/null 2>&1 & echo $!'], { encoding:'utf8' }).stdout.trim();
  const result = spawnSync('bash', [script, quittingPid, newApp, target, staging, markers, '3.136', '3.135'], {
    env:{ ...process.env, PATH:`${stubs}:${process.env.PATH}`, OTS_UPDATE_CONFIRM_SECONDS:'2' }, encoding:'utf8', timeout:30000
  });
  const readIf = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return {
    status:result.status, log:`${result.stdout}${result.stderr}`,
    installed:readIf(path.join(target, 'version')),
    opened:readIf(path.join(dir, 'open.log')).trim().split('\n').filter(Boolean),
    rolledBack:readIf(path.join(markers, 'update-rolled-back')).trim().split('\n').filter(Boolean),
    stagingLeft:fs.existsSync(staging), pending:fs.readdirSync(markers).filter(name => name.startsWith('update-pending') || name.startsWith('update-ok')),
    killed:readIf(path.join(dir, 'pkill.log'))
  };
}

function checkInstaller() {
  const ok = runInstaller('ok');
  assert.equal(ok.status, 0, ok.log);
  assert.equal(ok.installed, '3.136');
  assert.deepEqual(ok.opened, ['3.136']);
  assert.equal(ok.stagingLeft, false, 'the old version is removed once the new one reported in');
  assert.deepEqual(ok.pending, [], 'markers cleaned up');
  assert.deepEqual(ok.rolledBack, []);

  const crash = runInstaller('crash');
  assert.notEqual(crash.status, 0);
  assert.equal(crash.installed, '3.135', `a new version that never loads is replaced by the old one again\n${crash.log}`);
  assert.deepEqual(crash.opened, ['3.136', '3.135'], 'the old version is reopened');
  assert.deepEqual(crash.rolledBack, ['3.136', '3.135', 'started'], 'the old version is told why on its next load');
  assert.match(crash.killed, /TradeOrderSystem\.app\/Contents\//, 'the broken new version is stopped first');
  assert.equal(crash.stagingLeft, false);

  const failed = runInstaller('install-fails');
  assert.notEqual(failed.status, 0);
  assert.equal(failed.installed, '3.135');
  assert.deepEqual(failed.opened, ['3.135']);
  assert.deepEqual(failed.rolledBack, ['3.136', '3.135', 'install'], 'a failed swap is also explained');
}

// ---------- 3. Server: lock, orphan, parent exit, busy port, update backup ----------
async function checkServerProcesses() {
  // One server per data folder.
  const dataDir = fs.mkdtempSync(path.join(tmpRoot, 'lock-'));
  const first = startServer(dataDir);
  await waitHealthy(first);
  const second = startServer(dataDir);
  assert.equal(await second.exited, 75, 'a second server on the same data exits with 75');
  assert.match(second.output(), /另一个外贸订单跟进系统正在使用这份数据/);
  await waitHealthy(first);
  // A killed server leaves a stale lock: the next one takes over.
  first.child.kill('SIGKILL');
  await first.exited;
  assert.ok(fs.existsSync(path.join(dataDir, 'server.lock')), 'SIGKILL leaves the lock file');
  const third = startServer(dataDir);
  await waitHealthy(third);
  await stop(third);
  assert.equal(fs.existsSync(path.join(dataDir, 'server.lock')), false, 'a normal exit removes the lock');

  // An app that is force-quit: its server (launched with TRADE_APP_EXIT_WITH_PARENT) leaves on its own.
  const hostScript = path.join(tmpRoot, 'host.js');
  fs.writeFileSync(hostScript, `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [process.argv[2]], { stdio:['ignore', 'inherit', 'inherit'] });
console.log('SERVER_PID ' + child.pid);
setInterval(() => {}, 1000);
`);
  const exitDir = fs.mkdtempSync(path.join(tmpRoot, 'parent-'));
  const host = startServer(exitDir, { env:{ TRADE_APP_EXIT_WITH_PARENT:'1' }, args:[hostScript, serverFile] });
  await waitHealthy(host);
  const serverPid = Number(/SERVER_PID (\d+)/.exec(host.output())[1]);
  grandchildPids.push(serverPid);
  host.child.kill('SIGKILL');
  await host.exited;
  await waitFor(() => !alive(serverPid), 8000, 'server leaves after its host app was killed');
  assert.equal(fs.existsSync(path.join(exitDir, 'server.lock')), false, 'the departing server released its lock');

  // An orphan from an older version (no parent watch) is stopped by the next launch, which then starts normally.
  const orphanDir = fs.mkdtempSync(path.join(tmpRoot, 'orphan-'));
  const oldHost = startServer(orphanDir, { args:[hostScript, serverFile] });
  await waitHealthy(oldHost);
  const orphanPid = Number(/SERVER_PID (\d+)/.exec(oldHost.output())[1]);
  grandchildPids.push(orphanPid);
  oldHost.child.kill('SIGKILL');
  await oldHost.exited;
  await sleep(300);
  assert.ok(alive(orphanPid), 'without the parent watch the orphan keeps running (what older versions left behind)');
  const next = startServer(orphanDir);
  await waitHealthy(next);
  assert.equal(alive(orphanPid), false, 'the new server stopped the orphan holding the data folder');
  await stop(next);

  // A busy port: exit at once (the app retries another port) instead of a live process that never listens.
  const portDir = fs.mkdtempSync(path.join(tmpRoot, 'port-'));
  const blocker = startServer(fs.mkdtempSync(path.join(tmpRoot, 'blocker-')));
  await waitHealthy(blocker);
  const clash = startServer(portDir, { port:blocker.port });
  const code = await Promise.race([clash.exited, sleep(8000).then(() => 'still running')]);
  assert.notEqual(code, 'still running', 'a server that cannot listen must exit');
  assert.notEqual(code, 0);
  await stop(blocker);
}

// ---------- 4. UI in a simulated Mac shell ----------
function shellInit({ zoom }) {
  window.__otsUiZoom = zoom;
  window.__messages = [];
  const post = name => ({ postMessage(body) {
    window.__messages.push({ name, body });
    if (name === 'uiZoom') setTimeout(() => window.otsUiZoomChanged?.(body.zoom), 30);
  } });
  window.webkit = { messageHandlers:{ appUpdate:post('appUpdate'), uiZoom:post('uiZoom'), appTheme:post('appTheme'), windowDragRegions:post('windowDragRegions') } };
}

async function openShell(browser, server, { width = 1440, height = 920, zoom = 0.85, colorScheme = 'light', theme = 'light' } = {}) {
  const context = await browser.newContext({ viewport:{ width:Math.round(width / zoom), height:Math.round(height / zoom) }, deviceScaleFactor:zoom, colorScheme, locale:'zh-CN' });
  await context.addInitScript(shellInit, { zoom });
  await context.addInitScript(value => {
    try {
      if (value) localStorage.setItem('trade-order-system-theme', value);
      localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10));
    } catch (_) {}
  }, theme);
  const page = await context.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  await page.goto(`http://127.0.0.1:${server.port}/trade-order-system.html?token=${server.apiToken}#dashboard`);
  await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  return { context, page, errors, dialogs };
}

async function checkSidebarAtZoom(browser, server) {
  for (const [width, height, zoom] of [[1100, 720, 1.05], [1100, 720, 1.2], [1280, 800, 1.2], [1100, 720, 0.85], [1440, 920, 1.2]]) {
    const { context, page, errors } = await openShell(browser, server, { width, height, zoom });
    const label = `${width}×${height} @${Math.round(zoom * 100)}%`;
    const layout = await page.evaluate(() => {
      const box = el => el.getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar');
      const update = document.getElementById('appUpdateBtn');
      const save = document.querySelector('.sidebar-foot');
      const main = document.querySelector('.main');
      return {
        viewport:[innerWidth, innerHeight], display:getComputedStyle(sidebar).display, sidebar:box(sidebar).toJSON(), update:box(update).toJSON(),
        foot:box(save).toJSON(), main:box(main).toJSON(), navItems:[...document.querySelectorAll('.sidebar .nav-item')].filter(el => el.getClientRects().length).length,
        scrollX:document.documentElement.scrollWidth - innerWidth
      };
    });
    assert.notEqual(layout.display, 'none', `${label}: sidebar hidden (viewport ${layout.viewport})`);
    assert.ok(layout.sidebar.width > 150 && layout.navItems >= 5, `${label}: sidebar with navigation ${JSON.stringify(layout.sidebar)} items ${layout.navItems}`);
    assert.ok(layout.update.width > 0 && layout.update.bottom <= layout.viewport[1] + 0.5 && layout.update.top >= 0, `${label}: 更新 button on screen ${JSON.stringify(layout.update)}`);
    assert.ok(Math.abs(layout.main.left - layout.sidebar.right) < 2, `${label}: no blank strip or overlap between sidebar and main (${layout.sidebar.right} / ${layout.main.left})`);
    assert.ok(layout.scrollX <= 1, `${label}: horizontal scroll ${layout.scrollX}`);
    // 更新 is reachable with a real click (native gets the request).
    await h.click(page, '#appUpdateBtn', `${label} 更新`);
    assert.ok(await page.evaluate(() => window.__messages.some(m => m.name === 'appUpdate')), `${label}: 更新 click reached the app`);
    assert.deepEqual(errors, []);
    await context.close();
  }
}

async function contrast(page, selector) {
  return page.evaluate(sel => {
    const ctx = Object.assign(document.createElement('canvas'), { width:1, height:1 }).getContext('2d', { willReadFrequently:true });
    const rgb = css => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const probe = document.createElement('div');
    probe.style.background = 'var(--surface-soft)';
    document.body.appendChild(probe);
    const bg = rgb(getComputedStyle(probe).backgroundColor);
    probe.remove();
    const fg = rgb(getComputedStyle(document.querySelector(sel)).color);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  }, selector);
}

async function checkUpdateButton(browser, server) {
  for (const theme of ['light', 'dark']) {
    const { context, page, errors, dialogs } = await openShell(browser, server, { theme });
    const states = [
      [{ state:'available', version:'3.137' }, '有更新', /V3\.137/],
      [{ state:'checking' }, '检查中', /检查更新/],
      [{ state:'downloading', version:'3.137', progress:0.37 }, '37%', /下载新版本 V3\.137：37%/],
      [{ state:'verifying' }, '校验中', /校验/],
      [{ state:'saving' }, '准备中', /准备重启/],
      [{ state:'restarting' }, '重启中', /重启/],
      [{ state:'error', message:'GitHub 返回状态 500' }, '失败', /更新失败：GitHub 返回状态 500/],
      [{ state:'latest', version:'3.136' }, '已最新', /V3\.136 已是最新/]
    ];
    for (const [status, text, name] of states) {
      const shown = await page.evaluate(s => {
        window.otsAppUpdateStatus(s);
        const btn = document.getElementById('appUpdateBtn');
        const span = btn.querySelector('span').getBoundingClientRect();
        const box = btn.getBoundingClientRect();
        const style = getComputedStyle(btn);
        const inner = [box.left + parseFloat(style.borderLeftWidth), box.right - parseFloat(style.borderRightWidth)];
        return { text:btn.textContent.trim(), aria:btn.getAttribute('aria-label'), title:btn.title, fits:span.left >= inner[0] - 0.5 && span.right <= inner[1] + 0.5, sizes:[span.left, span.right, ...inner] };
      }, status);
      assert.equal(shown.text, text, `${theme}/${status.state}: button text`);
      assert.ok(shown.fits, `${theme}/${status.state}: text cut off ${shown.sizes}`);
      assert.match(shown.aria, name, `${theme}/${status.state}: accessible name follows the state (${shown.aria})`);
      assert.equal(shown.title, shown.aria);
      if (theme === 'light' && ['available', 'error'].includes(status.state)) {
        const ratio = await contrast(page, '#appUpdateBtn');
        assert.ok(ratio >= 4.5, `light/${status.state}: contrast ${ratio.toFixed(2)} < 4.5`);
      }
    }
    if (theme === 'light') {
      // Bell copy points at the real button (bottom left), not the top right.
      // Always one version ahead of this build: the bell only announces a version newer than the running one.
      const [major, minor] = read('VERSION').trim().split('.').map(Number);
      const newer = `${major}.${minor + 1}`;
      await page.evaluate(version => window.otsAppUpdateStatus({ state:'available', version }), newer);
      await h.click(page, '#notifBtn', 'bell');
      await page.waitForFunction(version => document.getElementById('notifList')?.textContent.includes(`V${version}`), newer);
      const bell = await page.locator('#notifList').textContent();
      assert.match(bell, /左下角/);
      assert.doesNotMatch(bell, /右上角/);
      // The version tooltip says 发布 (it is the package time, not the install time).
      assert.match(await page.locator('.app-version').getAttribute('title'), /发布/);
      // Pre-update backup through the page (as the app calls it), labelled 安装更新前.
      assert.equal(await page.evaluate(() => window.otsBackupBeforeUpdate()), true);
      const backups = await (await fetch(`http://127.0.0.1:${server.port}/api/backups`, { headers:{ Authorization:`Bearer ${server.apiToken}` } })).json();
      const updateBackup = backups.backups.find(item => item.reason === 'update');
      assert.ok(updateBackup && /-before-update\.sqlite$/.test(updateBackup.name), `update backup listed: ${JSON.stringify(backups.backups.map(b => b.name))}`);
      assert.equal(await page.evaluate(() => backupReasonLabels.update), '安装更新前');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], 'no native dialogs');
    await context.close();
  }
}

async function checkZoomAndTitlebar(browser, server) {
  const { context, page, errors } = await openShell(browser, server);
  await page.evaluate(() => { setPage('settings'); uiSettingsTab('appearance'); });
  await page.waitForSelector('.ui-zoom-card', { state:'visible' });
  const toasts = text => page.evaluate(t => [...document.querySelectorAll('#toast .toast-item')].filter(el => el.textContent.includes(t)).length, text);
  // ⌘+ to 110%: settings say so, and a short toast confirms it.
  await page.evaluate(() => window.otsUiZoomChanged(1.1));
  const current = await page.evaluate(() => ({ hidden:document.querySelector('.ui-zoom-current').hidden, text:document.querySelector('.ui-zoom-current').textContent, pressed:document.querySelectorAll('[data-ui-zoom-choice][aria-pressed="true"]').length }));
  assert.deepEqual([current.hidden, current.pressed], [false, 0]);
  assert.match(current.text, /当前 110%/);
  assert.equal(await toasts('界面大小：110%'), 1, 'shortcut zoom is announced');
  assert.match(await page.locator('.ui-zoom-card').textContent(), /⌘0 回到默认 85%/);
  // A settings click: one toast, even though the app calls back with the same zoom.
  await h.click(page, '[data-ui-zoom-choice="0.9"]', '90%');
  await page.waitForFunction(() => window.__messages.some(m => m.name === 'uiZoom' && m.body.zoom === 0.9));
  await sleep(200);
  assert.equal(await toasts('界面大小：90%'), 1, 'settings click is announced once');
  assert.equal(await page.evaluate(() => document.querySelector('.ui-zoom-current').hidden), true);

  // Full screen: no traffic lights, no 44pt gap.
  const pad = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.sidebar')).paddingTop));
  assert.ok(await pad() > 40, 'title-bar gap in a normal window');
  await page.evaluate(() => document.documentElement.classList.add('mac-fullscreen'));
  assert.equal(await pad(), 18, 'full screen drops the title-bar gap');
  assert.deepEqual(errors, []);
  await context.close();
}

async function checkThemeFollowsSystem(browser, server) {
  const { context, page, errors } = await openShell(browser, server, { colorScheme:'dark', theme:'' });
  const stored = () => page.evaluate(() => localStorage.getItem('trade-order-system-theme'));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'no choice yet: follows the system (dark)');
  assert.equal(await stored(), null, 'following the system writes nothing');
  await page.emulateMedia({ colorScheme:'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await stored(), null);
  assert.deepEqual(await page.evaluate(() => window.__messages.filter(m => m.name === 'appTheme').at(-1).body), { theme:'system' }, 'the app is told to follow the system');
  await page.evaluate(() => { setPage('settings'); uiSettingsTab('appearance'); });
  await h.click(page, '[data-theme-mode-choice="dark"]', '深色');
  assert.equal(await stored(), 'dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.deepEqual(await page.evaluate(() => window.__messages.filter(m => m.name === 'appTheme').at(-1).body), { theme:'dark' });
  await page.emulateMedia({ colorScheme:'light' });
  await sleep(100);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'a chosen theme stays');
  await h.click(page, '[data-theme-mode-choice="system"]', '跟随系统');
  assert.equal(await stored(), null);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(await page.locator('[data-theme-mode-choice="system"]').getAttribute('aria-pressed'), 'true');
  // The moon/sun button still works and is remembered.
  await h.click(page, '#themeBtn', 'theme button');
  assert.equal(await stored(), 'dark');
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  checkReleaseWorkflow();
  checkNativeSources();
  checkInstaller();
  await checkServerProcesses();

  const dataDir = fs.mkdtempSync(path.join(tmpRoot, 'ui-'));
  const server = startServer(dataDir);
  await waitHealthy(server);
  const browser = await launchBrowser();
  try {
    await checkSidebarAtZoom(browser, server);
    await checkUpdateButton(browser, server);
    await checkZoomAndTitlebar(browser, server);
    await checkThemeFollowsSystem(browser, server);
  } finally {
    await browser.close();
    await stop(server);
  }
  // The smoke test the release workflow runs works on a bundle-shaped folder.
  const resources = fs.mkdtempSync(path.join(tmpRoot, 'bundle-'));
  for (const file of ['server.js', 'feishu-settings.js', 'ai-usage-store.js', 'whatsapp-store.js', 'subscription-store.js', 'whatsapp-native-host.js']) fs.copyFileSync(path.join(root, 'mac-app', file), path.join(resources, file));
  for (const file of ['trade-order-system.html', 'trade-order-data.json']) fs.copyFileSync(path.join(root, file), path.join(resources, file));
  const smoke = execFileSync(process.execPath, [path.join(__dirname, 'smoke-test-app-bundle.js'), '--resources', resources], { encoding:'utf8', timeout:90000 });
  assert.match(smoke, /Smoke test passed/);
  console.log('Mac app V3.136 passed: sidebar stays at 105–120% zoom in narrow windows; update button text fits with a live name and contrast; installer keeps the old version until the new one loads and rolls back otherwise; release waits for CI and smoke-tests the package; one server per data folder, orphans cleaned up, server leaves with the app; zoom shown and announced; theme follows the system; pre-update backup.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch (_) {} }
  for (const pid of grandchildPids) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  fs.rmSync(tmpRoot, { recursive:true, force:true });
});
