#!/usr/bin/env node
// 真机启动检查（只在 macOS 上跑）：把打好的 App 真的开起来（Swift 壳 + WKWebView + 包里的 Node），
// 用临时数据目录，看它能不能走到「页面报告已启动」这一步。其它界面测试都跑在 Chromium 里，
// 只有这里用的是用户实际用的那个 WebKit 和那个原生壳。
//
// 1. 正常的包：放一个 update-pending-<版本>（假装刚更新完），App 起来后页面发 appBooted，
//    原生端写出 update-ok-<版本>。更新器靠这个文件判断「新版本能用」。
// 2. 坏掉的包：同一个 App 拷一份，让页面主脚本在启动时抛错。窗口照样能开、页面照样「加载完成」，
//    但不能写 update-ok，这样更新器才会把它退回旧版本。
//
// 用法：node scripts/smoke-test-real-app.js --app mac-app/TradeOrderSystem.app
// 给 CI 用。在自己的 Mac 上跑之前先退出 OTS：App 只允许开一份，开着的话这里起的那一份会直接退出。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

async function waitFor(check, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(stepMs);
  }
  return check();
}

// Starts the app's own executable (so the environment reaches it) on an empty data folder that
// claims an update to this version is waiting to be confirmed.
function launch(app, version, label) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `ots-real-${label}-`));
  fs.writeFileSync(path.join(dataDir, `update-pending-${version}`), 'previous\n');
  let output = '';
  const child = spawn(path.join(app, 'Contents', 'MacOS', 'TradeOrderSystem'), [], {
    env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || os.tmpdir(), LANG: 'zh_CN.UTF-8', TRADE_APP_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return {
    child, dataDir,
    ok: path.join(dataDir, `update-ok-${version}`),
    pending: path.join(dataDir, `update-pending-${version}`),
    lock: path.join(dataDir, 'server.lock'),
    output: () => output
  };
}

// The app is killed, not quit (a quit may ask about unsaved work); its server leaves with it.
async function stop(run) {
  let serverPid = 0;
  try { serverPid = Number(JSON.parse(fs.readFileSync(run.lock, 'utf8')).pid) || 0; } catch (_) {}
  if (run.child.exitCode === null && run.child.signalCode === null) {
    run.child.kill('SIGKILL');
    await new Promise(resolve => run.child.once('exit', resolve));
  }
  if (serverPid && !await waitFor(() => !alive(serverPid), 10000)) {
    try { process.kill(serverPid, 'SIGKILL'); } catch (_) {}
  }
  fs.rmSync(run.dataDir, { recursive: true, force: true });
}

function describe(run) {
  let files = [];
  try { files = fs.readdirSync(run.dataDir); } catch (_) {}
  return `data folder: ${files.join(', ') || '(empty)'}\napp output:\n${run.output() || '(none)'}`;
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('Real app boot check skipped (requires macOS).');
    return;
  }
  const app = path.resolve(argument('--app') || 'mac-app/TradeOrderSystem.app');
  const page = path.join(app, 'Contents', 'Resources', 'trade-order-system.html');
  assert.ok(fs.existsSync(page), `no built app at ${app}`);
  const version = execFileSync('/usr/bin/defaults', ['read', path.join(app, 'Contents', 'Info'), 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim();
  assert.match(version, /^\d+\.\d+$/, 'app version');

  // 1. The app as built.
  const good = launch(app, version, 'good');
  try {
    const confirmed = await waitFor(() => fs.existsSync(good.ok) || good.child.exitCode !== null, 90000);
    assert.ok(confirmed && fs.existsSync(good.ok), `the built app did not report a working page within 90 s\n${describe(good)}`);
    assert.ok(await waitFor(() => !fs.existsSync(good.pending), 5000), 'update-pending is cleared once the page reported in');
    assert.equal(good.child.exitCode, null, `the app is still running after its page booted\n${describe(good)}`);
  } finally { await stop(good); }

  // 2. The same app with a page whose script throws while starting.
  const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-real-broken-app-'));
  const brokenApp = path.join(brokenRoot, 'TradeOrderSystem.app');
  execFileSync('/usr/bin/ditto', [app, brokenApp]);
  const brokenPage = path.join(brokenApp, 'Contents', 'Resources', 'trade-order-system.html');
  const html = fs.readFileSync(brokenPage, 'utf8');
  const marker = 'appScriptCompleted = true;\nreportAppBooted();\n</script>';
  assert.equal(html.split(marker).length, 2, 'the page ends with its boot report');
  fs.writeFileSync(brokenPage, html.replace(marker, `throw new Error("broken build");\n${marker}`));
  const bad = launch(brokenApp, version, 'bad');
  try {
    // Its server came up (so the window is loading the page), then give the page as long as the good one needed, and more.
    assert.ok(await waitFor(() => fs.existsSync(bad.lock) || bad.child.exitCode !== null, 60000) && fs.existsSync(bad.lock),
      `the broken copy did not start its server, so this check proves nothing\n${describe(bad)}`);
    await waitFor(() => fs.existsSync(bad.ok), 25000);
    assert.equal(fs.existsSync(bad.ok), false, 'a page whose script throws on start must not confirm the update');
    assert.ok(fs.existsSync(bad.pending), 'update-pending stays, so the installer rolls back');
    assert.equal(bad.child.exitCode, null, `the broken copy was running the whole time\n${describe(bad)}`);
  } finally {
    await stop(bad);
    fs.rmSync(brokenRoot, { recursive: true, force: true });
  }
  console.log(`Real app boot check passed: V${version} in its own window (WKWebView) confirmed a working page; a copy whose script throws on start did not.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
