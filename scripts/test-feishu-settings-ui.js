#!/usr/bin/env node
// 设置 → 飞书通知 和订单发群（审查 26）：真实 mac-app/server.js（临时数据目录）+ 假 lark-cli（绝不连真实飞书）+ 真实鼠标键盘。
// - 没配置飞书：新单「保存后发送到飞书群」默认不勾、小字写明去哪里配，保存后不请求发群、没有红色失败提示；
// - 设置页填 profile / 群名 / 群 ID 保存，不重启就生效；文件 0600；profile 和群 ID 不留在页面上；「测试连接」成功；
// - 飞书慢：订单马上提示已创建、弹窗马上关，群消息在后台发完再提示；
// - 草稿「转为正式订单」和「重新发送」在飞书回来之前换到另一张单写备注：抽屉不被切回去、备注不丢；
// - 机器人不在群：抽屉里写清楚原因；新建时没勾的正式单能从抽屉补发；复制出来的单有开关、保存时发群。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const pad = n => String(n).padStart(2, '0');
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const secrets = { profile:'OTS_UI_SECRET_BOT', chatId:'oc_uisecretchat987' };

const fakeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(fs.realpathSync(__filename));
const args = process.argv.slice(2);
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(path.join(dir, 'ctl.json'), 'utf8')); } catch (_) {}
const markdown = args.includes('--markdown') ? args[args.indexOf('--markdown') + 1] : '';
const num = (/订单号：\\*\\* (\\S+)/.exec(markdown) || [])[1] || (markdown.includes('OTS 测试消息') ? 'TEST' : '');
const log = event => fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ ...event, num, at:Date.now() }) + '\\n');
log({ kind:'start', args });
const finish = () => {
  if (ctl.mode === 'notInChat' && num !== 'TEST') {
    process.stderr.write(JSON.stringify({ ok:false, error:{ type:'api_error', code:230002, message:'Bot/User can NOT be out of the chat.' } }) + '\\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({ ok:true, identity:'bot', data:{ message_id:'om_' + Date.now(), create_time:'${today} 10:00:00' } }) + '\\n');
  }
  log({ kind:'end' });
};
if (args.includes('+messages-send') && ctl.delayMs) setTimeout(finish, ctl.delayMs); else finish();
`;

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-feishu-ui-'));
  const larkDir = path.join(dataDir, 'lark');
  fs.mkdirSync(larkDir);
  const fakeCli = path.join(larkDir, 'lark-cli');
  fs.writeFileSync(fakeCli, fakeSource, { mode:0o700 });
  const setCtl = ctl => fs.writeFileSync(path.join(larkDir, 'ctl.json'), JSON.stringify(ctl));
  setCtl({});
  const calls = () => {
    const file = path.join(larkDir, 'calls.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const sendsFor = num => calls().filter(call => call.kind === 'start' && call.num === num);
  const C = { currency:'USD', country:'🇺🇸 美国 United States', orderType:'定金订单', productType:'假发', paymentChannel:'TT', createdAt:today, orderMonth:today.slice(0, 7), updated:`${today} 09:00`, logs:[], attachments:[], shipments:[] };
  const orders = [
    { ...C, id:'D1', num:'K4001', client:'Draft Co', stage:'quote', amount:800, paidAmount:0, isDraft:true },
    { ...C, id:'A1', num:'K4002', client:'Alpha Hair', stage:'production', amount:1000, paidAmount:300, depositAmount:300 },
    { ...C, id:'B1', num:'K4003', client:'Beta Lashes', stage:'production', amount:600, paidAmount:200, depositAmount:200 }
  ];
  const customers = Object.fromEntries(orders.map(o => [o.client, { client:o.client, country:o.country, email:`${o.id.toLowerCase()}@example.com` }]));
  fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:1, data:{ orders, customers, trashOrders:[], deletedOrders:[], doneTasks:{}, demoCleared:true, demoCustomersCleared:true } }));
  const port = freePortSync();
  const token = `feishu-ui-${process.pid}`;
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', TRADE_LARK_CLI:fakeCli, DHL_API_KEY:'', FEDEX_CLIENT_ID:'', FEDEX_CLIENT_SECRET:'' };
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${url}/api/health`)).ok; } catch (_) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'server starts');

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, locale:'zh-CN' });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    await context.route('**/api/ecb-rates**', route => route.fulfill({ json:{ ok:true, rates:[] } }));
    await context.route('**/api/api-status', route => route.fulfill({ json:{ ok:true, results:[] } }));
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    const notificationRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/order-notification') notificationRequests.push(request.postData()); });
    await page.goto(`${url}/trade-order-system.html?token=${token}`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.waitForFunction(() => feishuStatus && feishuStatus.configured === false);
    // 提示条会盖住抽屉底部的按钮：点之前收掉（用户会等它消失或挪开鼠标）。
    const click = async (selector, label) => { await h.clearToasts(page); return h.click(page, selector, label); };
    const toastsSeen = () => page.evaluate(() => window.__toastLog.slice());
    await page.evaluate(() => {
      window.__toastLog = [];
      new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
        if (node.classList?.contains('toast-item')) window.__toastLog.push(node.textContent.replace(/\s+/g, ' ').trim());
      }))).observe(document.getElementById('toast'), { childList:true });
    });
    const typeInto = async (selector, text) => {
      await click(selector, selector);
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(text);
    };
    const newOrder = async (client, amount) => {
      await click('#newOrderBtn', '新建订单');
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open') && document.getElementById('orderForm')._cleanFingerprint !== undefined);
      await typeInto('#orderForm [name="client"]', client);
      await page.keyboard.press('Escape');
      await typeInto('#orderForm [name="amount"]', amount);
    };
    const saveOrderModal = async () => {
      await click('#orderModal button[type="submit"][form="orderForm"]', '保存订单');
      await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    };
    const openCard = async id => {
      await page.evaluate(() => setPage('dashboard'));
      await click(`#pipeline .board-card[data-id="${id}"]`, `card ${id}`);
      await page.waitForFunction(id => detailOrderId === id && document.getElementById('orderDetailDrawer').classList.contains('open'), id);
    };
    const closeDrawer = async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    };

    // ---- 1. Not configured: the switch defaults to off, says where to configure, nothing is sent ----
    await newOrder('Gamma Wigs', '500');
    const box = page.locator('#orderModal [name="sendFeishuNotification"]');
    assert.equal(await box.isChecked(), false, 'not configured: 保存后发送到飞书群 defaults to off');
    assert.match(await page.locator('#orderFeishuNotificationField small').innerText(), /还没配置飞书.*设置 → 飞书通知/);
    await saveOrderModal();
    const gamma = await page.evaluate(() => state.orders.find(o => o.client === 'Gamma Wigs')?.id);
    assert.ok(gamma);
    await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
    assert.equal(notificationRequests.length, 0, 'no Feishu request without settings');
    assert.equal((await toastsSeen()).some(text => /失败/.test(text)), false, `no failure toast: ${await toastsSeen()}`);
    assert.equal(await page.evaluate(() => localStorage.getItem('ots-feishu-send-v1')), null, 'the forced "off" is not remembered as the user choice');

    // The unsent order's drawer offers to go to the settings, not a send that cannot work.
    await openCard('A1');
    const section = '#orderDetailBody [data-order-notification-section]';
    assert.match(await page.locator(section).innerText(), /未发送到飞书群/);
    assert.equal(await page.locator(`${section} [data-retry-order-notification]`).count(), 0);
    await click(`${section} [data-open-feishu-settings]`, '去设置飞书');
    await page.waitForFunction(() => document.querySelector('[data-settings-panel="feishu"]')?.classList.contains('active'));
    assert.equal(await page.evaluate(() => document.getElementById('orderDetailDrawer').classList.contains('open')), false);
    assert.match(await page.locator('#feishuSettingsStatus').innerText(), /未配置/);

    // ---- 2. Fill in and save; test connection ----
    await typeInto('#feishuProfile', secrets.profile);
    await typeInto('#feishuChatName', '外贸订单通知群');
    await typeInto('#feishuChatId', 'chat-wrong');
    await click('#feishuSettingsForm button[type="submit"]', '保存飞书设置');
    await page.waitForFunction(() => /没有保存：.*oc_/.test(document.getElementById('feishuTestStatus').textContent));
    await typeInto('#feishuChatId', secrets.chatId);
    await click('#feishuSettingsForm button[type="submit"]', '保存飞书设置');
    await page.waitForFunction(() => feishuStatus?.configured === true);
    await page.waitForFunction(() => /已配置/.test(document.getElementById('feishuSettingsStatus').textContent));
    assert.match(await page.locator('#feishuSettingsStatus').innerText(), /外贸订单通知群/);
    assert.equal(await page.locator('#feishuProfile').inputValue(), '', 'profile does not stay on the page');
    assert.equal(await page.locator('#feishuChatId').inputValue(), '', 'chat id does not stay on the page');
    assert.match(await page.locator('#feishuChatId').getAttribute('placeholder'), /已保存/);
    const settingsFile = path.join(dataDir, 'feishu-settings.json');
    assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600, 'settings file is 0600');
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).chatId, secrets.chatId);
    await click('#testFeishuBtn', '测试连接');
    await page.waitForFunction(() => /连接正常/.test(document.getElementById('feishuTestStatus').textContent));
    assert.equal(sendsFor('TEST').length, 1, 'the test message went through the fake CLI');
    assert.match(await page.locator('#apiFeishuLine').innerText(), /已配置（外贸订单通知群）/);

    // ---- 3. Slow Feishu: saving does not wait for it ----
    setCtl({ delayMs:4000 });
    await page.evaluate(() => setPage('dashboard'));
    await newOrder('Delta Hair', '700');
    assert.equal(await box.isChecked(), true, 'configured: the switch is back to the remembered default (on)');
    assert.match(await page.locator('#orderFeishuNotificationField small').innerText(), /仅首次正式保存发送一次/);
    const saveStarted = Date.now();
    await saveOrderModal();
    await h.waitToast(page, '正在发送群消息');
    assert.ok(Date.now() - saveStarted < 3500, 'the order is reported as created before Feishu answers');
    const delta = await page.evaluate(() => state.orders.find(o => o.client === 'Delta Hair'));
    assert.equal(delta.feishuNotification.status, 'sending');
    await page.waitForFunction(id => state.orders.find(o => o.id === id)?.feishuNotification?.status === 'sent', delta.id, { timeout:20000 });
    await h.waitToast(page, `${delta.num} 群消息已发送`);
    assert.equal(sendsFor(delta.num).length, 1);

    // ---- 4. Promote a draft, switch to another order and type while Feishu is slow ----
    await openCard('D1');
    assert.equal(await page.locator('#detailFeishuToggle').isChecked(), true);
    await click('#detailPromoteBtn', '转为正式订单');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'D1').isDraft === false);
    await page.waitForFunction(() => document.getElementById('detailPromoteBtn').dataset.morph !== 'busy');
    await closeDrawer();
    await openCard('B1');
    const note = '#orderDetailBody [data-dedit="note"]';
    await click(note, 'B1 note');
    await page.keyboard.type('客户刚说要改成 20 顶（还没保存）');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'D1').feishuNotification?.status === 'sent', null, { timeout:20000 });
    await h.waitToast(page, 'K4001 群消息已发送');
    assert.equal(await page.evaluate(() => detailOrderId), 'B1', 'the drawer stays on the order being edited');
    assert.equal(await page.locator(note).inputValue(), '客户刚说要改成 20 顶（还没保存）', 'typing in the other order is kept');
    assert.equal(await page.evaluate(() => uiDetailUnsaved()), true, 'and still counts as unsaved');
    await click('#detailSaveBtn', '保存');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'B1').note === '客户刚说要改成 20 顶（还没保存）');
    await page.waitForFunction(() => !uiDetailUnsaved());
    assert.equal(sendsFor('K4003').length, 0, 'editing a formal order does not send');

    // ---- 5. Bot not in the group: a clear reason; then resend while working in another order ----
    setCtl({ mode:'notInChat' });
    await closeDrawer();
    await openCard('A1');
    await click(`${section} [data-retry-order-notification]`, '发送到飞书群');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'A1').feishuNotification?.status === 'failed');
    await page.waitForFunction(sel => /机器人不在「外贸订单通知群」里.*拉进/.test(document.querySelector(sel)?.textContent || ''), section);
    assert.doesNotMatch(await page.locator(section).innerText(), /稍后重试/, 'a permanent problem does not say "retry later"');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-order-notification-section]') !== null), true, 'focus stays in the notification block');
    setCtl({ delayMs:4000 });
    await click(`${section} [data-retry-order-notification]`, '重新发送');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'A1').feishuNotification?.status === 'sending');
    await closeDrawer();
    await openCard('B1');
    await click(note, 'B1 note');
    await page.keyboard.press('End');
    await page.keyboard.type(' 第二次');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'A1').feishuNotification?.status === 'sent', null, { timeout:20000 });
    await h.waitToast(page, 'K4002 群消息已重新发送');
    assert.equal(await page.evaluate(() => detailOrderId), 'B1', 'resend does not switch the drawer back');
    assert.match(await page.locator(note).inputValue(), / 第二次$/);
    assert.equal(sendsFor('K4002').length, 2, 'one failed and one successful send');
    await click('#detailSaveBtn', '保存');
    await page.waitForFunction(() => !uiDetailUnsaved());

    // ---- 6. A copied order has the switch and sends on its first save ----
    setCtl({});
    await click('#detailDuplicateBtn', '复制订单');
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    const copyNum = await page.locator('#orderForm [name="num"]').inputValue();
    assert.equal(await page.locator('#orderFeishuNotificationField').isVisible(), true, 'a copied order shows the send switch');
    assert.equal(await box.isChecked(), true);
    await typeInto('#orderForm [name="amount"]', '650');
    await saveOrderModal();
    await h.waitToast(page, '订单已创建');
    await page.waitForFunction(num => state.orders.find(o => o.num === num)?.feishuNotification?.status === 'sent', copyNum, { timeout:20000 });
    assert.equal(sendsFor(copyNum).length, 1, 'the copy was sent once');

    // ---- 7. After a timeout the message may already be in the group: resending asks first (in-app dialog) ----
    await page.evaluate(() => {
      const o = state.orders.find(item => item.id === 'B1');
      o.feishuNotification = normalizeFeishuNotification({ requested:true, status:'failed', errorKind:'timeout', chatName:'外贸订单通知群', error:'飞书 45 秒内没有回应，消息可能已经发到群里：请先看一眼群，再决定是否重新发送' });
    });
    await openCard('B1');
    await click(`${section} [data-retry-order-notification]`, '重新发送');
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    assert.match(await page.locator('#confirmModal').innerText(), /可能已经发到群里/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(sendsFor('K4003').length, 0, 'cancelling the confirmation sends nothing');
    await closeDrawer();

    // ---- Secrets never reach the page ----
    const pageText = await page.evaluate(() => document.documentElement.outerHTML + JSON.stringify(state) + JSON.stringify({ ...localStorage }) + JSON.stringify(feishuStatus));
    for (const secret of [secrets.profile, secrets.chatId]) assert.equal(pageText.includes(secret), false, `page leaked ${secret}`);
    const exported = await (await fetch(`${url}/api/data`, { headers:{ Authorization:`Bearer ${token}` } })).text();
    for (const secret of [secrets.profile, secrets.chatId]) assert.equal(exported.includes(secret), false, `/api/data leaked ${secret}`);

    assert.deepEqual(dialogs, [], 'no native dialogs');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('Feishu settings UI passed: unconfigured default off with hint, settings save / validate / 0600 / no secrets, test connection, save does not wait for Feishu, drawers never switch or lose typing, clear failure reason, send from drawer, copied order sends.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 3000); });
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
