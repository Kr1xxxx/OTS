#!/usr/bin/env node
// 发版前的冒烟测试：用打好的包里自带的 Node 和 server.js 起一次本地服务（临时数据目录），
// /api/health 要通过，页面要能加载完（pendingSaveStatus().loaded）且没有脚本错误，然后正常退出。
// 用法：node scripts/smoke-test-app-bundle.js --app <TradeOrderSystem.app>
//       node scripts/smoke-test-app-bundle.js --resources <目录，里面有 server.js 和 trade-order-system.html>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { freePortSync } = require('./helpers/free-port');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

async function smokeTest({ resources: resourcesArg, node: nodeArg }) {
  // 子进程的 cwd 是包里的 Resources：相对路径的 node / server.js 会按新的 cwd 去找（ENOENT），一律先转成绝对路径。
  const resources = path.resolve(resourcesArg);
  const node = path.isAbsolute(nodeArg) || !/[\\/]/.test(nodeArg) ? nodeArg : path.resolve(nodeArg);
  for (const file of ['server.js', 'trade-order-system.html']) {
    if (!fs.existsSync(path.join(resources, file))) throw new Error(`包里缺少 ${file}：${resources}`);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-smoke-'));
  const port = freePortSync();
  const apiToken = crypto.randomBytes(24).toString('hex');
  const instanceNonce = crypto.randomBytes(12).toString('hex');
  let output = '';
  const child = spawn(node, [path.join(resources, 'server.js')], {
    cwd: resources,
    env: { HOME: process.env.HOME || dataDir, PATH: process.env.PATH, TRADE_APP_DATA_DIR: dataDir, TRADE_APP_PORT: String(port), TRADE_APP_NO_OPEN: '1', TRADE_API_TOKEN: apiToken, TRADE_INSTANCE_NONCE: instanceNonce, TRADE_EXPORT_NO_REVEAL: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let browser;
  try {
    const deadline = Date.now() + 20000;
    let health = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`服务提前退出（状态 ${child.exitCode}）：\n${output}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${apiToken}` } });
        const body = await res.json();
        if (res.ok && body.ok === true && body.instanceNonce === instanceNonce) { health = body; break; }
      } catch (_) { /* 还没起来 */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!health) throw new Error(`/api/health 20 秒内没有通过：\n${output}`);

    const { chromium } = require('playwright');
    try { browser = await chromium.launch({ headless: true }); }
    catch (_) { browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' }); }
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/trade-order-system.html?token=${encodeURIComponent(apiToken)}#dashboard`);
    await page.waitForFunction(() => globalThis.pendingSaveStatus?.().loaded, null, { timeout: 30000 });
    if (errors.length) throw new Error(`页面脚本出错：\n${errors.join('\n')}`);
    await browser.close();
    browser = null;

    child.kill('SIGTERM');
    const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve({ code: 'timeout' }), 8000))]);
    if (result.code !== 0) throw new Error(`服务没有正常退出（${JSON.stringify(result)}）：\n${output}`);
    return { port, storageMode: health.storageMode };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

module.exports = { smokeTest };

if (require.main === module) {
  const app = argument('--app') ? path.resolve(argument('--app')) : '';
  const resources = argument('--resources') ? path.resolve(argument('--resources')) : (app ? path.join(app, 'Contents', 'Resources') : '');
  if (!resources) {
    console.error('用法：node scripts/smoke-test-app-bundle.js --app <TradeOrderSystem.app> | --resources <目录>');
    process.exit(2);
  }
  const bundledNode = path.join(resources, 'node-runtime');
  const node = fs.existsSync(bundledNode) ? bundledNode : process.execPath;
  smokeTest({ resources, node })
    .then(result => console.log(`Smoke test passed: packaged server healthy (${result.storageMode}) and the page loaded, using ${node === process.execPath ? 'this Node' : 'the bundled Node'}.`))
    .catch(error => { console.error(error.message || error); process.exitCode = 1; });
}
