// 合并客户 / 删除客户：真实 mac-app/server.js（临时数据目录）+ 真实键盘鼠标。
// - 合并不再把主档案名自动改大小写：「alice baker」合并时不会整份覆盖另一位「Alice Baker」；
// - 合并、删除前强制生成一份操作前备份（不受一小时一次限制），确认框默认焦点在「取消」，6 秒内可撤销；
// - 冲突字段写进备注；可以改为保留另一份；「不是同一人」以后不再提示；
// - 0 单客户合并后 WhatsApp 聊天跟过去，撤销后只搬回那次搬过去的聊天；物流「最近查询」跟着改名；
// - 删除客户：有订单的不能直接删（可合并到其他客户），没订单的删除后各处都找不到，撤销后原样回来。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');

const root = path.resolve(__dirname, '..');
const lagos = 'C/O Lagos Freight Hub, 12 Airport Road, Ikeja, Lagos';
const base = { currency:'USD', logisticsStatus:'未发货', createdAt:'2026-10-20', orderMonth:'2026-10', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', updated:'2026-11-01 09:00', amount:1000, paidAmount:300, depositAmount:300, depositPercent:30, orderType:'定金订单', stage:'production', shipments:[], attachments:[] };
let seq = 0;
const order = (id, extra) => ({ ...base, id, num:`K9${String(++seq).padStart(3, '0')}`, ...extra });
const fixture = {
  orders:[
    order('M1', { client:'Maria Lopez', country:'🇪🇸 西班牙 Spain', currency:'EUR' }),
    order('A1', { client:'Alice Baker' }),
    order('A2', { client:'alice baker' }),
    order('A3', { client:'alice baker' }),
    order('D1', { client:'Ada Okafor', country:'🇳🇬 Nigeria' }),
    order('B1', { client:'Bisi Hair Lagos', country:'🇳🇬 Nigeria', trackingNumber:'1Z999AA10123456785', carrier:'UPS' })
  ],
  trashOrders:[], deletedOrders:[],
  customers:{
    'Maria Lopez':{ client:'Maria Lopez', country:'🇪🇸 西班牙 Spain', currency:'EUR', phones:['+34 612 345 678'], phone:'+34 612 345 678', emails:['maria@lopezhair.es'], email:'maria@lopezhair.es', level:'B级翡翠客户', paymentMethod:'TT', repurchaseCycle:'30' },
    'Lopez Hair Studio':{ client:'Lopez Hair Studio', country:'🇺🇸 美国 United States', currency:'USD', phones:['+1 305 555 0199'], phone:'+1 305 555 0199', emails:['maria@lopezhair.es'], email:'maria@lopezhair.es', level:'A级钻石客户', paymentMethod:'Paypal', paymentEmail:'pay@lopezhair.es', repurchaseCycle:'60', note:'Miami 分店' },
    'Alice Baker':{ client:'Alice Baker', contacts:['Alice'], contact:'Alice', phones:['+1 702 555 0100'], phone:'+1 702 555 0100', emails:['alice@example.com'], email:'alice@example.com', addresses:['500 Fremont St, Las Vegas, NV 89101'], address:'500 Fremont St, Las Vegas, NV 89101', tags:['VIP'], note:'原档案', permanentNote:'永远用 DHL', paymentMethod:'Paypal', paymentEmail:'alice.pay@example.com' },
    'alice baker':{ client:'alice baker', note:'小写那一行编辑出来的档案', emails:['alice.b@work.com'], email:'alice.b@work.com' },
    'Alice B. Hair':{ client:'Alice B. Hair', emails:['alice.b@work.com'], email:'alice.b@work.com', note:'店铺账号' },
    'Ada Okafor':{ client:'Ada Okafor', country:'🇳🇬 Nigeria', phones:['+234 803 555 0101'], phone:'+234 803 555 0101', addresses:[lagos], address:lagos },
    'Bisi Hair Lagos':{ client:'Bisi Hair Lagos', country:'🇳🇬 Nigeria', phones:['+234 805 555 0202'], phone:'+234 805 555 0202', addresses:[lagos], address:lagos },
    'Typo Custmer':{ client:'Typo Custmer', note:'打错名字建的档案' }
  },
  trackingLookups:[{ id:'lookup-b1', trackingNumber:'1Z999AA10123456785', carrier:'UPS', checkedAt:'2026-11-05 10:00', orderId:'B1', client:'Bisi Hair Lagos', displayClient:'', orderNum:'K9006', status:'运输中', events:[] }]
};

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-customer-merge-'));
  fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:1, data:{ doneTasks:{}, demoCleared:true, demoCustomersCleared:true, ...fixture } }));
  const port = await freePort();
  const token = 'customer-merge-delete-test-token';
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', DHL_API_KEY:'', FEDEX_CLIENT_ID:'', FEDEX_CLIENT_SECRET:'' };
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${url}/api/health`)).ok; } catch (_) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'server starts');
    const api = async (route, body) => (await fetch(url + route, { method:body ? 'POST' : 'GET', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) })).json();
    const native = (action, payload = {}) => {
      const bytes = Buffer.from(JSON.stringify({ action, payload }));
      const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
      const result = spawnSync(process.execPath, [path.join(root, 'mac-app/whatsapp-native-host.js')], { env, input:Buffer.concat([length, bytes]), timeout:10000 });
      return JSON.parse(result.stdout.subarray(4));
    };
    const chatCount = async name => (await api(`/api/whatsapp/messages?customer=${encodeURIComponent(name)}`)).total;
    const backupsDir = path.join(dataDir, 'backups');
    const beforeChangeBackups = () => { try { return fs.readdirSync(backupsDir).filter(name => /-before-change(?:-\d+)?\.sqlite$/.test(name)).sort(); } catch (_) { return []; } };

    // 0 单的 Lopez Hair Studio 和 Maria Lopez 各绑一个 WhatsApp 聊天。
    const lopezChat = { account:'15550001111@c.us', chatId:'13055550199@c.us', customer:'Lopez Hair Studio', title:'Lopez Hair Studio' };
    const mariaChat = { account:'15550001111@c.us', chatId:'34612345678@c.us', customer:'Maria Lopez', title:'Maria' };
    assert.equal(native('bind', lopezChat).ok, true);
    assert.equal(native('sync', { ...lopezChat, messages:[{ id:'l1', direction:'in', kind:'text', timestamp:'[10:20, 01/11/2026]', text:'Miami store' }, { id:'l2', direction:'out', kind:'text', timestamp:'[10:21, 01/11/2026]', text:'USD list' }] }).inserted, 2);
    assert.equal(native('bind', mariaChat).ok, true);
    assert.equal(native('sync', { ...mariaChat, messages:[{ id:'m1', direction:'in', kind:'text', timestamp:'[11:00, 01/11/2026]', text:'Hola' }] }).inserted, 1);
    // 一小时一次的自动备份刚做过：之后的保存都会跳过备份，合并前的备份只能来自强制的操作前备份。
    assert.equal((await api('/api/manual-backup', {})).ok, true);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 } });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    await page.goto(`${url}/trade-order-system.html?token=${token}`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('customers'));
    await page.waitForSelector('#customerDuplicateAlerts .customer-duplicate-row');

    // 切页面后 setPage 还会在 80 / 240ms 时把页面滚回顶部：量完位置被滚走了就重新量（最多 5 次），不是挡住就不算失败。
    const click = async selector => {
      let hit = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const point = await h.center(page, selector);
        hit = await page.locator(selector).first().evaluate((el, p) => { const top = document.elementFromPoint(p.x, p.y); return top === el || el.contains(top) ? '' : (top?.outerHTML || 'nothing').slice(0, 160); }, point);
        if (!hit) return page.mouse.click(point.x, point.y);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      assert.fail(`${selector} 被挡住了：${hit}`);
    };
    const confirmOpen = async () => {
      await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      await h.settle(page, '#confirmModal .modal');
      return page.evaluate(() => ({ title:document.getElementById('confirmTitle').textContent, message:document.getElementById('confirmMessage').textContent, ok:document.getElementById('confirmOkBtn').textContent, alt:document.getElementById('confirmAltBtn').hidden ? '' : document.getElementById('confirmAltBtn').textContent, cancel:document.getElementById('confirmCancelBtn').textContent, danger:document.getElementById('confirmOkBtn').classList.contains('btn-danger') }));
    };
    const focusOnCancel = () => page.waitForFunction(() => document.activeElement?.id === 'confirmCancelBtn');
    const confirmClosed = () => page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    const flush = async () => assert.equal(await page.evaluate(() => window.flushPendingSave()), true, 'saved to the database');
    const db = async () => (await api('/api/data')).data;
    // 鼠标放到提示上让它停住（6 秒计时暂停），检查完数据库再点「撤销」。
    const holdToast = async text => {
      await h.waitToast(page, text);
      const box = await page.locator('#toast .toast-item:not(.leaving)', { hasText:text }).last().boundingBox();
      await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 3 + 2, box.y + box.height / 2);
    };

    // ---- 1. 主档案名只差大小写：合并不覆盖另一位「Alice Baker」 ----
    const aliceRow = '[data-duplicate-merge-secondary="Alice B. Hair"]';
    const aliceRowText = await page.locator('.customer-duplicate-row', { has:page.locator(aliceRow) }).innerText();
    assert.match(aliceRowText, /alice baker（2 单） ↔ Alice B\. Hair（0 单）/, `提醒行显示原名和订单数：${aliceRowText}`);
    await click(aliceRow);
    let dialog = await confirmOpen();
    assert.equal(dialog.danger, true, '合并确认用危险样式');
    assert.match(dialog.message, /保留：alice baker（2 单）/);
    assert.match(dialog.message, /合并前会先保存一份数据备份；合并后 6 秒内可以撤销/);
    await focusOnCancel();
    // 默认焦点在「取消」：直接按回车不会合并。
    await page.keyboard.press('Enter');
    await confirmClosed();
    assert.ok(await page.evaluate(() => Object.hasOwn(state.customers, 'Alice B. Hair')), '回车只是取消');
    await click(aliceRow);
    await confirmOpen();
    await click('#confirmOkBtn');
    await h.waitToast(page, '已合并到 alice baker');
    await flush();
    let data = await db();
    const realAlice = data.customers['Alice Baker'];
    assert.equal(realAlice.phone, '+1 702 555 0100', '另一位 Alice Baker 的电话还在');
    assert.equal(realAlice.address, '500 Fremont St, Las Vegas, NV 89101');
    assert.deepEqual(realAlice.tags, ['VIP']);
    assert.equal(realAlice.permanentNote, '永远用 DHL');
    assert.equal(realAlice.paymentEmail, 'alice.pay@example.com');
    assert.equal(data.customers['alice baker'].email, 'alice.b@work.com');
    assert.equal(Object.hasOwn(data.customers, 'Alice B. Hair'), false);
    assert.equal(data.orders.find(o => o.id === 'A1').client, 'Alice Baker', '另一位的订单不动');
    assert.equal(beforeChangeBackups().length, 1, '合并前生成了一份操作前备份');
    await h.clearToasts(page);

    // ---- 2. 0 单客户合并：备份内容、改为保留另一份、冲突写进备注、WhatsApp 跟过去、撤销 ----
    await page.evaluate(() => { state.customers['Lopez Hair Studio'].note += '\n下月要 200 顶 13x4'; saveState(); });
    await flush();
    const lopezBefore = (await db()).customers['Lopez Hair Studio'];
    const mergeRow = '[data-duplicate-merge-secondary="Lopez Hair Studio"]';
    await click(mergeRow);
    dialog = await confirmOpen();
    assert.equal(dialog.alt, '改为保留 Lopez Hair Studio');
    assert.match(dialog.message, /· 国家：保留 🇪🇸 西班牙 Spain，记进备注 🇺🇸 美国 United States/);
    assert.match(dialog.message, /· 币种：保留 EUR，记进备注 USD/);
    await focusOnCancel();
    await click('#confirmAltBtn');
    await page.waitForFunction(() => /保留：Lopez Hair Studio/.test(document.getElementById('confirmMessage').textContent));
    dialog = await confirmOpen();
    assert.equal(dialog.alt, '改为保留 Maria Lopez', '换过来以后还能换回去');
    await focusOnCancel();
    await click('#confirmAltBtn');
    await page.waitForFunction(() => /保留：Maria Lopez/.test(document.getElementById('confirmMessage').textContent));
    await confirmOpen();
    await click('#confirmOkBtn');
    await holdToast('已合并到 Maria Lopez');
    await flush();
    data = await db();
    const maria = data.customers['Maria Lopez'];
    assert.equal(Object.hasOwn(data.customers, 'Lopez Hair Studio'), false);
    assert.equal(maria.country, '🇪🇸 西班牙 Spain');
    assert.match(maria.note, /原国家：🇺🇸 美国 United States/, '被放弃的国家写进备注');
    assert.match(maria.note, /原币种：USD/);
    assert.match(maria.note, /原等级：A级钻石客户/);
    assert.doesNotMatch(maria.note, /其他付款邮箱/, '主档案原来没有付款邮箱，不叫「其他」');
    assert.equal(maria.paymentEmail, 'pay@lopezhair.es');
    assert.equal(await chatCount('Maria Lopez'), 3, '0 单客户的聊天跟着合并过来');
    assert.equal(await chatCount('Lopez Hair Studio'), 0);
    assert.equal(native('sync', { ...lopezChat, messages:[{ id:'l3', direction:'in', kind:'text', timestamp:'[09:00, 07/11/2026]', text:'new' }] }).ok, true, '插件照常同步');
    const backups = beforeChangeBackups();
    assert.equal(backups.length, 2);
    assert.ok(fs.readFileSync(path.join(backupsDir, backups.at(-1))).includes(Buffer.from('下月要 200 顶 13x4')), '操作前备份里有合并前最后一次修改');
    assert.ok(await page.evaluate(() => document.activeElement?.matches('[data-duplicate-view], #customerSearch')), '合并后焦点落在下一条提醒或搜索框');
    await h.clickUndo(page, '已合并到 Maria Lopez');
    await h.waitToast(page, '已撤销合并');
    await flush();
    data = await db();
    assert.deepEqual(data.customers['Lopez Hair Studio'], lopezBefore, '撤销后档案原样回来');
    assert.equal(data.customers['Maria Lopez'].country, '🇪🇸 西班牙 Spain');
    assert.equal(data.customers['Maria Lopez'].note || '', '');
    assert.equal(await chatCount('Lopez Hair Studio'), 3, '撤销后合并过去的聊天回来');
    assert.equal(await chatCount('Maria Lopez'), 1, 'Maria 自己的聊天留在 Maria');
    await h.clearToasts(page);

    // ---- 3. 「不是同一人」 ----
    const ignoreBtn = '[data-duplicate-ignore-b="Bisi Hair Lagos"]';
    assert.match(await page.locator('.customer-duplicate-row', { has:page.locator(ignoreBtn) }).innerText(), /地址相同（可能是同一个货代仓）/);
    await click(ignoreBtn);
    await h.waitToast(page, '不再提示');
    await page.waitForFunction(() => !document.querySelector('[data-duplicate-ignore-b="Bisi Hair Lagos"]'));
    await flush();
    assert.equal((await db()).customerDuplicateIgnores.length, 1, '「不是同一人」存进数据库');
    await h.clearToasts(page);

    // ---- 4. 有订单的客户不能直接删：合并到其他客户（物流最近查询跟着改名） ----
    await click('.customer-row[data-view-customer="Bisi Hair Lagos"]');
    await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
    await click('#customerDeleteBtn');
    dialog = await confirmOpen();
    assert.equal(dialog.title, '不能直接删除这位客户');
    assert.match(dialog.message, /名下有 1 单/);
    await focusOnCancel();
    await click('#confirmOkBtn');
    await page.waitForFunction(() => document.getElementById('confirmTitle').textContent === '合并到其他客户' && document.activeElement?.id === 'confirmInput');
    await page.keyboard.type('Nobody Here');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /没有这位客户/.test(document.getElementById('confirmError').textContent));
    await page.locator('#confirmInput').evaluate(el => el.setSelectionRange(0, el.value.length));
    await page.keyboard.type('ada okafor');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /保留：Ada Okafor/.test(document.getElementById('confirmMessage').textContent));
    await confirmOpen();
    await focusOnCancel();
    await click('#confirmOkBtn');
    await h.waitToast(page, '已合并到 Ada Okafor');
    await flush();
    data = await db();
    assert.equal(data.orders.find(o => o.id === 'B1').client, 'Ada Okafor');
    assert.equal(data.trackingLookups.find(item => item.id === 'lookup-b1').client, 'Ada Okafor', '物流最近查询显示订单现在的客户');
    assert.equal(await page.evaluate(() => buildGlobalSearchResults('Bisi').filter(item => /Bisi/.test(item.title)).length), 0, '全局搜索不再出现旧名字');
    await h.clearToasts(page);

    // ---- 5. 删除没有订单的客户、撤销 ----
    await click('.customer-row[data-view-customer="Typo Custmer"]');
    await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
    await click('#customerDeleteBtn');
    dialog = await confirmOpen();
    assert.equal(dialog.title, '删除客户');
    assert.equal(dialog.danger, true);
    assert.match(dialog.message, /删除前会先保存一份数据备份；删除后 6 秒内可以撤销/);
    await focusOnCancel();
    await page.keyboard.press('Enter');
    await confirmClosed();
    assert.ok(await page.evaluate(() => Object.hasOwn(state.customers, 'Typo Custmer')), '默认焦点在取消，回车不删除');
    await click('#customerDeleteBtn');
    await confirmOpen();
    await click('#confirmOkBtn');
    await holdToast('已删除客户 Typo Custmer');
    await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
    await flush();
    data = await db();
    assert.equal(Object.hasOwn(data.customers, 'Typo Custmer'), false, '数据库里删掉了');
    assert.equal(beforeChangeBackups().length, 4, '删除前也生成了操作前备份');
    const leftovers = await page.evaluate(() => ({
      row:Boolean(document.querySelector('.customer-row[data-view-customer="Typo Custmer"]')),
      search:buildGlobalSearchResults('Typo Custmer').filter(item => item.type === 'customer').length,
      picker:clientHistory().some(item => item.client === 'Typo Custmer'),
      paste:matchClientsFromPaste('Customer: Typo Custmer').length
    }));
    assert.deepEqual(leftovers, { row:false, search:0, picker:false, paste:0 }, '删除后列表、搜索、选择器、粘贴匹配都找不到');
    await h.clickUndo(page, '已删除客户 Typo Custmer');
    await h.waitToast(page, '已撤销：Typo Custmer');
    await flush();
    assert.equal((await db()).customers['Typo Custmer'].note, '打错名字建的档案', '撤销后档案回来');
    await page.waitForSelector('.customer-row[data-view-customer="Typo Custmer"]');

    assert.deepEqual(dialogs, [], '没有原生弹窗');
    assert.deepEqual(errors, []);
    console.log('customer merge / delete UI test passed');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
