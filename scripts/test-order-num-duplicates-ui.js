#!/usr/bin/env node
// 订单号重复检测（V3.118）：大小写 / 全角 / 空格 / 零宽字符不同的「同号」在页面上就拦下并标红，输入框离开时规范化；
// 旧数据里已有的变体不挡住别的字段的修改；标题号跟着输入走；改号写进操作记录；健康检查和导入预览认得变体；
// 粘贴匹配只认完整单号；复制订单不改客户名并直接打开新单；保存失败的提示不是绿色对勾。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
const d = new Date();
const day = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const base = { country:'🇺🇸 美国 United States', currency:'USD', amount:1000, paidAmount:0, orderType:'定金订单', stage:'quote', productType:'睫毛', paymentChannel:'Paypal', createdAt:`${month}-01`, orderMonth:month, updated:`${month}-01 09:00`, logs:[], logisticsStatus:'未发货', shipments:[], attachments:[] };

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:920 } });
    const errors = [];
    const dialogs = [];
    const saves = [];
    let failSaves = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
    let stored = { app:'trade-order-system', revision:0, data:{
      orders:[
        { ...base, id:'o1', num:`K${day}01`, client:'Alpha Buyer' },
        { ...base, id:'o2', num:`K${day}02`, client:'Beta Buyer' },
        // 旧数据：两张单只差大小写（数据库按字节比较，存得下）。
        { ...base, id:'o5', num:`k${day}05`, client:'Legacy Lower' },
        { ...base, id:'o6', num:`K${day}05`, client:'Legacy Upper' },
        { ...base, id:'o-empty', num:'', client:'No Number Co' }
      ],
      deletedOrders:[{ ...base, id:'o3', num:`K${day}03`, client:'Deleted Buyer', deletedAt:`${month}-02 10:00` }],
      trashOrders:[{ ...base, id:'o4', num:`K${day}04`, client:'Trash Buyer', trashedAt:`${month}-02 10:00` }],
      customers:{}, demoCleared:true, demoCustomersCleared:true
    } };
    await page.route('**/*', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:5 }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/save') {
        if (failSaves) return route.fulfill({ status:500, json:{ ok:false, message:'disk I/O error' } });
        const body = request.postDataJSON();
        saves.push(body);
        stored = { ...body.state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const numField = page.locator('#orderForm input[name="num"]');
    const toastTexts = () => page.evaluate(() => [...document.querySelectorAll('#toast .toast-item')].map(item => `${item.className} | ${item.querySelector('.toast-text')?.textContent}`));
    const clearToasts = () => page.evaluate(() => document.querySelectorAll('#toast .toast-item').forEach(item => item.remove()));

    // 1. 新建：填一个只差大小写的号，离开输入框就规范化、标红并说清楚是哪张单在用；标题号跟着输入走。
    await page.locator('#newOrderBtn').click();
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    assert.equal(await numField.inputValue(), `K${day}06`, 'prefill skips trash / deleted / lower-case legacy numbers');
    await numField.fill(`k${day}01`);
    assert.equal(await page.locator('#modalNum').innerText(), `K${day}01`, 'modal title follows the typed number');
    await numField.dispatchEvent('change');
    assert.equal(await numField.inputValue(), `K${day}01`, 'number is normalized when leaving the field');
    assert.equal(await numField.evaluate(el => el.closest('.field').classList.contains('ui-err')), true, 'conflict marks the field');
    assert.match((await toastTexts()).join('\n'), new RegExp(`is-error \\| 订单号 K${day}01 已被「Alpha Buyer」的订单使用`));
    await page.locator('#orderForm input[name="client"]').fill('Gamma Buyer');
    await page.locator('#orderForm input[name="amount"]').fill('500');
    await page.locator('#orderModal [name="sendFeishuNotification"]').uncheck().catch(() => {});

    // 2. 全角、零宽字符、中间空格、已删除 / 回收站里的号都在页面上拦下：不写进 state、不发保存请求。
    const savesBefore = saves.length;
    const ordersBefore = await page.evaluate(() => state.orders.length);
    for (const [variant, owner] of [[`Ｋ${day}02`, 'Beta Buyer'], [`K${day}02\u200B`, 'Beta Buyer'], [`K${day} 02`, 'Beta Buyer'], [`k${day}03`, '已删除订单里「Deleted Buyer」'], [`K${day}04`, '回收站里「Trash Buyer」']]) {
      await clearToasts();
      await numField.fill(variant);
      await page.evaluate(() => document.getElementById('orderForm').requestSubmit());
      await page.waitForFunction(() => document.querySelector('#toast .toast-item.is-error'));
      assert.match((await toastTexts()).join('\n'), new RegExp(owner.replace(/[「」]/g, '.')), `variant ${JSON.stringify(variant)} must be rejected`);
    }
    assert.equal(await page.evaluate(() => state.orders.length), ordersBefore, 'a rejected number must not enter state');
    assert.equal(saves.length, savesBefore, 'a rejected number must not be sent to the database');
    assert.equal(await page.evaluate(() => document.getElementById('orderModal').classList.contains('open')), true);

    // 3. 合法的手工号：存规范化后的写法（转大写、去空格，- 保留）。
    await numField.fill(' k-manual 1 ');
    await page.evaluate(() => document.getElementById('orderForm').requestSubmit());
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    assert.equal(await page.evaluate(() => state.orders.find(o => o.client === 'Gamma Buyer')?.num), 'K-MANUAL1');

    // 4. 旧数据里已有只差大小写的两张单：只改金额能照常保存，号保持原写法。
    await page.evaluate(() => openOrder('o5'));
    await page.locator('#orderForm input[name="amount"]').fill('1500');
    await page.evaluate(() => document.getElementById('orderForm').requestSubmit());
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    assert.deepEqual(await page.evaluate(() => { const o = state.orders.find(x => x.id === 'o5'); return [o.num, o.amount]; }), [`k${day}05`, 1500]);

    // 5. 改号写进操作记录。
    await page.evaluate(() => openOrder('o2'));
    await numField.fill(`K${day}88`);
    await page.evaluate(() => document.getElementById('orderForm').requestSubmit());
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    assert.match(await page.evaluate(() => state.orders.find(o => o.id === 'o2').logs[0].text), new RegExp(`订单号：K${day}02 → K${day}88`));

    // 6. 数据健康检查：认得只差大小写的号，写清楚客户和位置，空号单独报；纯信息只留「知道了」。
    await page.evaluate(() => runDataHealthCheck());
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    const health = await page.locator('#confirmMessage').innerText();
    assert.match(health, new RegExp(`k${day}05（Legacy Lower · 订单） / K${day}05（Legacy Upper · 订单）`));
    assert.match(health, /订单号为空：1 个/);
    assert.doesNotMatch(health, /、$/m);
    assert.equal(await page.locator('#confirmCancelBtn').isVisible(), false, 'info dialog has no 取消 button');
    await page.locator('#confirmOkBtn').click();

    // 7. 导入预览：完全相同的号拒绝导入；只差大小写的号可以导入，但预览里要说出来。
    await clearToasts();
    const importFile = orders => ({ name:'import.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify({ app:'trade-order-system', data:{ orders, customers:{}, demoCleared:true, demoCustomersCleared:true } })) });
    await page.setInputFiles('#dataFileInput', importFile([{ id:'i1', num:'K25010101', client:'Imp A', amount:10 }, { id:'i2', num:'K25010101', client:'Imp B', amount:20 }]));
    await page.waitForFunction(() => document.querySelector('#toast .toast-item.is-error'));
    assert.match((await toastTexts()).join('\n'), /导入失败：文件里订单号 K25010101 出现了不止一次/);
    await page.setInputFiles('#dataFileInput', importFile([{ id:'i1', num:'K25010101', client:'Imp A', amount:10 }, { id:'i2', num:'k25010101', client:'Imp B', amount:20 }]));
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    assert.match(await page.locator('#confirmMessage').innerText(), /1 组订单号只差大小写、全角或空格（K25010101 \/ k25010101）/);
    await page.locator('#confirmCancelBtn').click();

    // 8. 粘贴匹配只认完整单号：K…010 不命中 K…01，空号的单不会命中任何粘贴，K 前缀也认。
    const matched = text => page.evaluate(value => matchOrdersFromPaste(value).map(o => o.id), text);
    assert.deepEqual(await matched(`order K${day}010 please`), []);
    assert.deepEqual(await matched(`please check k${day}01.`), ['o1']);
    assert.deepEqual(await matched('hello there'), []);

    // 9. 复制订单：客户名不变（不再出现「X 复制」假客户），直接打开新单编辑，toast 带新号。
    await clearToasts();
    await page.evaluate(() => openOrder('o1'));
    await page.locator('#duplicateBtn').click();
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open') && editingId !== 'o1');
    const copy = await page.evaluate(() => state.orders.find(o => o.id === editingId));
    assert.equal(copy.client, 'Alpha Buyer');
    assert.equal(await numField.inputValue(), copy.num);
    assert.match((await toastTexts()).join('\n'), new RegExp(`已复制为新订单 ${copy.num}`));
    await page.evaluate(() => closeOrder());
    // 弹窗里有没保存的改动时，复制前先问（复制的是已保存的那一版）。
    // 打开弹窗后快照在下一帧才取（遮罩观察器里的 requestAnimationFrame），慢机器上固定等 100ms 不够：
    // 先清掉上次的快照，等这次的快照真的取好再改字段。
    await page.evaluate(() => { delete document.getElementById('orderForm')._cleanFingerprint; openOrder('o1'); });
    await page.waitForFunction(() => document.getElementById('orderForm')._cleanFingerprint !== undefined);
    await page.locator('#orderForm input[name="amount"]').fill('4321');
    await page.locator('#duplicateBtn').click();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.locator('#confirmTitle').innerText(), '放弃未保存的修改？');
    await page.locator('#confirmCancelBtn').click();
    assert.equal(await page.evaluate(() => editingId), 'o1');
    await page.evaluate(() => closeOrder());

    // 10. 保存失败的提示不能是绿色对勾：自动重试中是黄色，没保存是红色。
    await clearToasts();
    failSaves = true;
    await page.evaluate(() => { state.orders[0].note = 'retry me'; return window.flushPendingSave(); });
    await page.waitForFunction(() => document.querySelector('#toast .toast-item'));
    const failureToasts = await toastTexts();
    assert.ok(failureToasts.some(text => /is-warn \| 数据库保存失败，正在自动重试/.test(text)), failureToasts.join('\n'));
    assert.ok(!failureToasts.some(text => /is-success/.test(text)), failureToasts.join('\n'));
    assert.match(await page.evaluate(() => { toast('打开失败'); return document.querySelector('#toast .toast-item:last-child').className; }), /is-error/, 'failure wording falls back to the error style');
    failSaves = false;

    assert.deepEqual(dialogs, [], 'native dialogs are not allowed');
    assert.deepEqual(errors, []);
    console.log('Order number duplicates UI passed: variants rejected and marked, normalized storage, legacy variants editable, title sync, change log, health check, import preview, paste matching, copy, failure toast tones.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
