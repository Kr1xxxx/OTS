#!/usr/bin/env node
// 设置 → 数据管理 →「占用空间」：真实 mac-app/server.js（临时数据目录，订单和附件文件是编的）。
// 点「查看…」→ 本地服务量 → 确认框：标题下一句「一共 …」、分项表（0 的行不列，没有 .app 时没有「软件本身」）、
// 图片和附件清单（在用几个、占得最多的订单在前、不再使用的旧文件）、只有一个「知道了」。
// 服务端没响应时提示没算出来，不弹框。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');
const { confirmText } = require('./helpers/confirm-dialog');

const root = path.resolve(__dirname, '..');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-storage-ui-'));
  const file = (relative, size) => {
    const target = path.join(dataDir, 'attachments', relative);
    fs.mkdirSync(path.dirname(target), { recursive:true });
    fs.writeFileSync(target, Buffer.alloc(size, 1));
    return { fileUrl:`/attachments/${relative}` };
  };
  const att = (name, size) => ({ name, ...file(`${name}.webp`, size), thumbUrl:file(`${name}-thumb.webp`, 20000).fileUrl, compressed:true });
  const order = (id, num, attachments) => ({ id, num, client:'Made Up Hair', amount:100, paidAmount:0, stage:'quote', currency:'USD', createdAt:'2026-01-05', updated:'2026-01-05 10:00', logs:[], shipments:[], attachments });
  const orders = [
    order('a', 'K26010501', [att('K26010501/IMG_1', 300000)]),
    order('b', 'K26010502', [att('K26010502/IMG_2', 900000), att('K26010502/IMG_3', 500000)])
  ];
  file('K26010501/IMG_old.png', 2 * 1048576);
  fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:1, data:{ orders, customers:{}, trashOrders:[], deletedOrders:[], doneTasks:{}, demoCleared:true, demoCustomersCleared:true } }));
  const port = freePortSync();
  const token = `storage-ui-${process.pid}`;
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', DHL_API_KEY:'', FEDEX_CLIENT_ID:'', FEDEX_CLIENT_SECRET:'' };
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${url}/api/health`)).ok; } catch (_) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'server starts');

    // 没有令牌不给看。
    assert.equal((await fetch(`${url}/api/storage-usage`)).status, 401, 'storage usage needs the token');

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, locale:'zh-CN' });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    await context.route('**/api/ecb-rates**', route => route.fulfill({ json:{ ok:true, rates:[] } }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
    await page.goto(`${url}/trade-order-system.html?token=${token}`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => { setPage('settings'); uiSettingsTab('data'); });
    const button = page.locator('#macStorageUsageBtn');
    await button.scrollIntoViewIfNeeded();
    assert.equal(await button.isVisible(), true, 'the row is shown in the Mac app');
    assert.match(await page.evaluate(() => document.getElementById('macStorageUsageBtn').closest('.data-action').textContent), /占用空间/);

    await button.click();
    const text = await confirmText(page);
    const head = await page.evaluate(() => ({
      title:document.getElementById('confirmTitle').textContent,
      sub:document.getElementById('confirmSub').textContent,
      ok:document.getElementById('confirmOkBtn').textContent,
      cancelHidden:document.getElementById('confirmCancelBtn').hidden
    }));
    assert.equal(head.title, '占用空间');
    assert.match(head.sub, /^一共 \d+(\.\d)? MB · 这台 Mac 的硬盘$/, `sub says the total, got ${head.sub}`);
    assert.equal(head.ok, '知道了');
    assert.equal(head.cancelHidden, true, 'information only: one button');
    assert.match(text, /^图片和附件 · 3\.\d MB$/m, `attachments row, got\n${text}`);
    assert.match(text, /^数据库 · /m, 'database row');
    assert.doesNotMatch(text, /软件本身/, 'no .app around the server in tests: no app row');
    assert.doesNotMatch(text, /^缓存 · /m, 'zero rows are left out');
    assert.match(text, /在用 3 个 · 1\.\d MB 占得最多的订单：K26010502 1\.\d MB、K26010501 \d+ KB/, `in use with the largest order first, got\n${text}`);
    assert.match(text, /不再使用的旧文件 1 个 · 2\.0 MB/, 'the file no order uses');
    await page.click('#confirmOkBtn');
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));

    // 本地服务出错：一句提示，不弹框。
    await page.route('**/api/storage-usage', route => route.fulfill({ status:500, json:{ ok:false, message:'磁盘读不了' } }));
    await page.waitForFunction(() => !document.getElementById('macStorageUsageBtn').disabled);
    await button.click();
    await page.waitForFunction(() => [...document.querySelectorAll('#toast .toast-item')].some(item => item.textContent.includes('占用空间没算出来：磁盘读不了')));
    assert.equal(await page.evaluate(() => document.getElementById('confirmModal').classList.contains('open')), false, 'no dialog on failure');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Storage usage UI test passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
