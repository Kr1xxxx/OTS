#!/usr/bin/env node
// 物流页（审查 20）：真实的 mac-app/server.js + 本机假承运商（DHL / FedEx 都指到 127.0.0.1），真鼠标、真键盘。
// - 数字卡、列表、侧栏同一个口径：不算已完成和草稿，拼箱单号只算一个包裹；异常排最前；可以筛状态、看近 30 天已完成；
// - 查询失败（限流 / 查不到）不覆盖上一次成功的结果，物流风险提醒不消失；提示是人话，不带 JSON；自动更新碰到限流就停掉这家；
//   FedEx token 复用；
// - 「最近查询」置顶的不被挤掉，「清除所有」先用页面内确认框、可以撤销，清完提醒还在；
// - 查询框：Tab / 斜杠分隔、超过 12 个留在输入框里、认不出的不查、订单里选了 UPS 的不按 FedEx 查、查询中按钮禁用；
// - 抽屉：异常用红色、风险判断和待办同一规则；行可以用键盘打开、直接到「物流」页签；拼箱显示「等 2 单」；
// - 签收自动完成时提示写明移到「已完成」，可以撤销。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { freePortSync } = require('./helpers/free-port');
const { launchBrowser, h } = require('./helpers/board-page');

const root = path.resolve(__dirname, '..');
const TODAY = '2026-11-07';
const pad = n => String(n).padStart(2, '0');
const day = offset => { const [y, m, d] = TODAY.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + offset)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- 假承运商：按单号返回预设的结果，记下每一次调用 ----
const carrier = { dhl:{}, fedex:{}, calls:[], tokenCalls:0, delayMs:{} };
const dhlOk = (code, description, timestamp, events = []) => ({ status:200, body:{ shipments:[{ status:{ statusCode:code, status:code, description, timestamp }, events }] } });
function fakeCarrierServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const reply = (status, json, headers = {}) => { res.writeHead(status, { 'Content-Type':'application/json', ...headers }); res.end(JSON.stringify(json)); };
      if (url.pathname === '/dhl/track/shipments') {
        const number = url.searchParams.get('trackingNumber');
        carrier.calls.push(`DHL:${number}`);
        if (carrier.delayMs[number]) await sleep(carrier.delayMs[number]);
        const plan = carrier.dhl[number] || carrier.dhl['*'] || dhlOk('transit', 'In transit', new Date().toISOString());
        return reply(plan.status, plan.body, plan.headers);
      }
      if (url.pathname === '/fedex/oauth/token') {
        carrier.tokenCalls += 1;
        return reply(200, { access_token:'fake-fedex-token', expires_in:3600 });
      }
      if (url.pathname === '/fedex/track/v1/trackingnumbers') {
        const number = JSON.parse(body || '{}').trackingInfo?.[0]?.trackingNumberInfo?.trackingNumber;
        carrier.calls.push(`FedEx:${number}`);
        const plan = carrier.fedex[number] || { status:200, body:{ output:{ completeTrackResults:[{ trackResults:[{ latestStatusDetail:{ code:'IT', statusByLocale:'In transit', description:'In transit' }, dateAndTimes:[{ type:'ACTUAL_PICKUP', dateTime:new Date().toISOString() }], scanEvents:[] }] }] } } };
        return reply(plan.status, plan.body);
      }
      reply(404, { title:'not found' });
    });
  });
}

const base = { currency:'USD', logisticsStatus:'未发货', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', orderType:'全款订单', amount:1000, paidAmount:1000 };
let seq = 0;
const mk = (id, extra = {}) => {
  seq += 1;
  const created = extra.createdAt || day(-10);
  return { ...base, id, num:`L${String(seq).padStart(4, '0')}`, client:`Buyer ${id}`, stage:'production', orderMonth:created.slice(0, 7), createdAt:created, updated:`${created} 09:00`, ...extra };
};
function fixture() {
  const orders = [
    // 旧版本存下的批次：查询成功过（checkedAt），还没有 trackOkAt；承运商最后一个节点在 5 天前。
    mk('a1', { client:'Alpha Wigs', stage:'shipment', shipments:[{ id:'a1-1', trackingNumber:'1234567890', carrier:'DHL', status:'运输中', shippedAt:day(-3), updated:`${day(-5)} 08:00`, checkedAt:`${day(-1)} 08:00` }] }),
    mk('a2', { client:'Three Parcels', stage:'shipment', shipments:[
      { id:'a2-1', trackingNumber:'1111111111', carrier:'DHL', status:'已签收', shippedAt:day(-6), updated:`${day(-1)} 10:00` },
      { id:'a2-2', trackingNumber:'123456789012', carrier:'FedEx', status:'运输中', shippedAt:day(-3), updated:`${day(-1)} 11:00` },
      { id:'a2-3', trackingNumber:'2222222222', carrier:'DHL', status:'异常', shippedAt:day(-3), updated:`${day(-1)} 12:00` }] }),
    // 手动完成的老单：包裹状态停在「已发货」。
    mk('d1', { client:'Done Long Ago', stage:'done', createdAt:day(-80), shipments:[{ id:'d1-1', trackingNumber:'3333333333', carrier:'DHL', status:'已发货', shippedAt:day(-60), updated:`${day(-60)} 09:00` }] }),
    mk('d3', { client:'Done Ups', stage:'done', createdAt:day(-30), updated:`${day(-3)} 09:00`, shipments:[{ id:'d3-1', trackingNumber:'1Z999AA10123456784', carrier:'UPS', status:'已发货', shippedAt:day(-20), updated:`${day(-20)} 09:00` }] }),
    mk('p1', { client:'Sample Buyer', stage:'production', shipments:[{ id:'p1-1', trackingNumber:'5555555555', carrier:'DHL', status:'已发货', shippedAt:day(-2), updated:`${day(-2)} 09:00` }] }),
    mk('s0', { client:'No Number Yet', stage:'shipment', logisticsStatus:'已发货', shippedAt:day(-1) }),
    mk('u1', { client:'Ups Transit', stage:'shipment', shipments:[{ id:'u1-1', trackingNumber:'1Z999AA10123456785', carrier:'UPS', status:'已发货', shippedAt:day(-2), updated:`${day(-2)} 09:00` }] }),
    mk('dr', { client:'Draft Holder', stage:'shipment', isDraft:true, shipments:[{ id:'dr-1', trackingNumber:'6666666666', carrier:'DHL', status:'已发货', shippedAt:day(-1) }] }),
    mk('c1', { client:'Combo One', stage:'shipment', shipments:[{ id:'c1-1', trackingNumber:'4444444444', carrier:'DHL', status:'运输中', shippedAt:day(-4), updated:`${day(-2)} 09:00` }] }),
    mk('c2', { client:'Combo Two', stage:'shipment', shipments:[{ id:'c2-1', trackingNumber:'4444444444', carrier:'DHL', status:'运输中', shippedAt:day(-4), updated:`${day(-2)} 09:00` }] }),
    // 订单里手选了 UPS 的 12 位单号。
    mk('u12', { client:'Ups Twelve', stage:'shipment', shipments:[{ id:'u12-1', trackingNumber:'123456789099', carrier:'UPS', status:'已发货', shippedAt:day(-1), updated:`${day(-1)} 09:00` }] })
  ];
  const deletedOrders = [{ ...mk('x1', { client:'Deleted Buyer', stage:'shipment', shipments:[{ id:'x1-1', trackingNumber:'7777777777', carrier:'DHL', status:'运输中', shippedAt:day(-5) }] }), deletedAt:`${day(-1)} 10:00` }];
  const trackingLookups = [
    { id:'lk-a1', trackingNumber:'1234567890', carrier:'DHL', checkedAt:`${day(-1)} 08:00`, orderId:'a1', client:'Alpha Wigs', displayClient:'', orderNum:'L0001', shippedAt:day(-3), status:'运输中', statusUpdatedAt:`${day(-5)} 08:00`, queryMessage:'DHL API 已同步：运输中', online:'是', pinned:false, events:[{ time:`${day(-5)} 08:00`, title:'Processed at LEIPZIG', location:'Leipzig' }] },
    { id:'lk-a2', trackingNumber:'2222222222', carrier:'DHL', checkedAt:`${day(-1)} 12:00`, orderId:'a2', client:'Three Parcels', displayClient:'', orderNum:'L0002', shippedAt:day(-3), status:'异常', statusUpdatedAt:`${day(-1)} 12:00`, queryMessage:'', online:'是', pinned:false, events:[{ time:`${day(-1)} 12:00`, title:'Shipment on hold', location:'Sydney' }] },
    { id:'lk-x1', trackingNumber:'7777777777', carrier:'DHL', checkedAt:`${day(-2)} 09:00`, orderId:'x1', client:'Deleted Buyer', displayClient:'', orderNum:'L0012', shippedAt:day(-5), status:'运输中', statusUpdatedAt:`${day(-2)} 09:00`, online:'是', pinned:false, events:[] },
    { id:'lk-free', trackingNumber:'9999999999', carrier:'DHL', checkedAt:`${day(-3)} 09:00`, orderId:'', client:'Prospect Sample', displayClient:'Prospect Sample', orderNum:'-', status:'运输中', statusUpdatedAt:`${day(-3)} 09:00`, online:'是', pinned:true, events:[] }
  ];
  const customers = {};
  [...orders, ...deletedOrders].forEach(o => { customers[o.client] = { client:o.client, country:o.country }; });
  return { orders, deletedOrders, trackingLookups, customers, trashOrders:[], doneTasks:{}, demoCleared:true, demoCustomersCleared:true };
}

function zonedEpoch(local, timeZone) {
  const [d, t] = local.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [hh, mi] = t.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, dd, hh, mi);
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle:'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    guess += Date.UTC(y, m - 1, dd, hh, mi) - Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  }
  return guess;
}

// 真鼠标点一个元素：等它停稳，确认那一点上最上层就是它，再点。
// 滚动之后页面顶栏会收起、布局会挪一下（不是动画，h.settle 等不到），所以再等位置连续几帧不变。
async function clickAt(page, selector) {
  await h.center(page, selector);
  await page.locator(selector).first().evaluate(el => new Promise(resolve => {
    let last = '';
    let same = 0;
    const tick = () => {
      const r = el.getBoundingClientRect();
      const key = `${r.x},${r.y},${r.width},${r.height}`;
      same = key === last ? same + 1 : 0;
      last = key;
      if (same >= 3) resolve(); else requestAnimationFrame(tick);
    };
    tick();
  }));
  const point = await h.center(page, selector);
  const hit = await page.evaluate(({ selector, x, y }) => {
    const target = document.querySelector(selector);
    const top = document.elementFromPoint(x, y);
    return target && top && target.contains(top) ? '' : (top?.outerHTML || 'nothing').slice(0, 160);
  }, { selector, x:point.x, y:point.y });
  assert.equal(hit, '', `${selector} is covered by ${hit}`);
  await page.mouse.click(point.x, point.y);
}
// 行上悬停才出现的按钮：先把鼠标放到行上，等按钮出现、停稳，确认没被挡住再点。
async function clickRowAction(page, rowSelector, actionSelector) {
  const row = await h.center(page, rowSelector);
  await page.mouse.move(row.box.x + 30, row.box.y + 12);
  const selector = `${rowSelector} ${actionSelector}`;
  await page.waitForFunction(sel => { const el = document.querySelector(sel); return el && getComputedStyle(el.closest('.ship-row-actions, .recent-tracking-actions') || el).opacity === '1'; }, selector);
  await clickAt(page, selector);
}
const shipRow = number => `#logisticsList .ship-row:has([data-copy-tracking="${number}"])`;
const recentRow = number => `#priceHistoryList .recent-tracking-row:has([data-copy-tracking="${number}"])`;
const text = (page, selector) => page.locator(selector).first().innerText().then(value => value.replace(/\s+/g, ' ').trim());
const risks = page => page.evaluate(() => buildTaskItems().filter(task => String(task.id).startsWith('logistics-risk-')).map(task => `${task.title}: ${task.reason}`).sort());

(async () => {
  const fake = fakeCarrierServer();
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-logistics-ui-'));
  fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:1, data:fixture() }));
  const port = freePortSync();
  const token = 'l'.repeat(40);
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], {
    env:{ ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1',
      DHL_API_KEY:'fake-dhl-key', FEDEX_CLIENT_ID:'fake-fedex-id', FEDEX_CLIENT_SECRET:'fake-fedex-secret',
      OTS_DHL_TRACKING_ENDPOINT:`${fakeBase}/dhl/track/shipments`, OTS_FEDEX_API_HOST:`${fakeBase}/fedex`,
      HTTPS_PROXY:'http://127.0.0.1:9', HTTP_PROXY:'http://127.0.0.1:9', https_proxy:'http://127.0.0.1:9', http_proxy:'http://127.0.0.1:9' },
    stdio:['ignore', 'ignore', 'pipe']
  });
  let serverLog = '';
  server.stderr.on('data', chunk => { serverLog += chunk; });
  const api = (pathname, options = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, { ...options, headers:{ Authorization:`Bearer ${token}`, ...(options.headers || {}) } });
  let browser;
  try {
    for (let i = 0; ; i += 1) {
      try { if ((await api('/api/health')).ok) break; } catch (_) { /* 还没起来 */ }
      if (i > 150) throw new Error(`server did not start: ${serverLog}`);
      await sleep(100);
    }
    const saved = await api('/api/tracking-settings', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ dhlApiEnabled:'是', fedexApiEnabled:'是', autoDhlUpdate:'否' }) });
    assert.equal(saved.ok, true);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, deviceScaleFactor:1, timezoneId:'Asia/Shanghai', locale:'zh-CN' });
    await context.addInitScript(today => {
      try { localStorage.setItem('trade-order-system-theme', 'light'); localStorage.setItem('ots-greet-v1', today); } catch (_) { /* 忽略 */ }
    }, TODAY);
    // 浏览器只许连本机：真实承运商一个请求都不会发出去。
    await context.route(url => !/^http:\/\/127\.0\.0\.1[:/]/.test(url.toString()), route => route.abort());
    await context.route('**/api/ecb-rates', route => route.fulfill({ json:{ ok:true, rates:[] } }));
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    await page.clock.setFixedTime(zonedEpoch(`${TODAY}T10:00`, 'Asia/Shanghai'));
    await page.goto(`http://127.0.0.1:${port}/trade-order-system.html?token=${token}#dashboard`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => saveTrackingApiSettings({ ...getTrackingApiSettings(), dhlApiEnabled:'是', fedexApiEnabled:'是', autoDhlUpdate:'否' }));
    await clickAt(page, '.nav-item[data-page="logistics"]');
    await page.waitForFunction(() => document.getElementById('page-logistics')?.classList.contains('active') && document.querySelectorAll('#logisticsList .ship-row').length > 0);

    // ===== P1-1：数字卡、列表、侧栏同一个口径 =====
    const kpis = await page.locator('#logisticsKpis .logistics-kpi').evaluateAll(cards => cards.map(card => card.innerText.replace(/\s+/g, ' ').trim()));
    assert.match(kpis[0], /^运输中 6 /, '运输中只数进行中订单的包裹，拼箱算一个：1234567890、123456789012、5555555555、UPS 在途、4444444444、UPS 12 位');
    assert.match(kpis[1], /^异常 1 /);
    assert.match(kpis[2], /^近 7 天签收 1 /, '40 天前签收的不再一直算');
    assert.match(kpis[3], /^待补单号 1 /, '已发货却没单号的才是该补的');
    assert.equal(await text(page, '[data-nav-count="logistics"]'), '8', '侧栏：还有包裹在途 / 异常 / 待补单号的进行中订单');
    assert.equal(await text(page, '#logisticsCount'), '9 个包裹 · 8 张订单');
    const listText = await text(page, '#logisticsList');
    assert.doesNotMatch(listText, /Done Long Ago|Done Ups|Draft Holder/, '已完成和草稿默认不在列表里');
    assert.doesNotMatch(listText, /在途 60天/);
    const firstRow = await text(page, '#logisticsList .ship-row');
    assert.match(firstRow, /Three Parcels[\s\S]*DHL · 异常[\s\S]*第 3\/3 批[\s\S]*异常 · 已 3 天/, '异常件排最前，写明第几批，徽标写「异常 · 已 N 天」');
    assert.equal(await page.locator(`${shipRow('2222222222')} .delivery-timing`).getAttribute('class'), 'delivery-timing bad');
    // P2-8：颜色和文字同一个天数（3 天 → 橙色）。
    assert.match(await text(page, `${shipRow('1234567890')} .delivery-timing`), /^在途 3天10小时$/);
    assert.equal(await page.locator(`${shipRow('1234567890')} .delivery-timing`).getAttribute('class'), 'delivery-timing warn');
    // P2-7：✅ / ❌ 不在状态胶囊里；没单号的行不写 DHL、有「补单号」；UPS 行没有「更新」。
    assert.equal(await text(page, `${shipRow('1234567890')} .ship-pill`), 'DHL · 运输中');
    assert.match(await text(page, `${shipRow('1234567890')} .ship-check`), /昨天 08:00 查过 ✓/);
    const noNumber = page.locator('#logisticsList .ship-row', { hasText:'No Number Yet' });
    assert.doesNotMatch(await noNumber.innerText(), /DHL/);
    assert.equal(await noNumber.locator('[data-fill-tracking]').count(), 1);
    assert.equal(await page.locator(`${shipRow('1Z999AA10123456785')} [data-refresh-logistics]`).count(), 0);
    await clickAt(page, '#logisticsCarrierFilter [data-carrier-filter="DHL"]');
    assert.doesNotMatch(await text(page, '#logisticsList'), /No Number Yet/, '没单号的行不在 DHL 筛选里');
    await clickAt(page, '#logisticsCarrierFilter [data-carrier-filter="all"]');
    // 状态筛选（页面里的下拉）和「含已完成（近 30 天）」。
    await clickAt(page, '.logistics-filters .app-select-button');
    await page.locator('.app-select-popover [data-app-select-value="异常"]').waitFor();
    await clickAt(page, '.app-select-popover [data-app-select-value="异常"]');
    await page.waitForFunction(() => document.querySelectorAll('#logisticsList .ship-row').length === 1);
    assert.match(await text(page, '#logisticsList'), /2222 2222 22/);
    await clickAt(page, '.logistics-filters .app-select-button');
    await page.locator('.app-select-popover [data-app-select-value="all"]').waitFor();
    await clickAt(page, '.app-select-popover [data-app-select-value="all"]');
    await clickAt(page, '#logisticsIncludeDone');
    const doneUps = page.locator('#logisticsList .ship-row', { hasText:'Done Ups' });
    await doneUps.waitFor();
    assert.match(await doneUps.innerText(), /已完成/);
    assert.doesNotMatch(await doneUps.innerText(), /在途 20天/, '已完成的单不再挂「在途 N 天」');
    assert.doesNotMatch(await text(page, '#logisticsList'), /Done Long Ago/, '只看近 30 天完成的');
    await clickAt(page, '#logisticsIncludeDone');
    await page.waitForFunction(() => !/Done Ups/.test(document.getElementById('logisticsList').innerText));
    // P2-7：行能用键盘打开，打开的是「物流」页签。
    await page.locator(shipRow('2222222222')).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    assert.equal(await text(page, '#detailTabs [aria-selected="true"]'), '物流');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));

    // ===== P1-2：查询失败不覆盖上一次成功的结果；提示是人话 =====
    assert.deepEqual(await risks(page), ['Alpha Wigs: 物流 5 天未更新进度']);
    carrier.dhl['1234567890'] = { status:429, body:{ title:'Too Many Requests', status:429, detail:'You have exceeded the rate limit for this API' }, headers:{ 'Retry-After':'1800' } };
    await clickRowAction(page, shipRow('1234567890'), '[data-refresh-logistics]');
    await h.waitToast(page, 'DHL 调用次数超限');
    const rateToast = (await h.toasts(page)).find(item => item.includes('DHL 调用次数超限'));
    assert.match(rateToast, /约 30 分钟后再试/);
    assert.doesNotMatch(rateToast, /HTTP|\{|Too Many/, '不再显示服务端拼出的 JSON 原文');
    assert.equal(await text(page, `${shipRow('1234567890')} .ship-pill`), 'DHL · 运输中', '状态不被改成「待 API 查询」');
    assert.match(await text(page, `${shipRow('1234567890')} .ship-check`), /今天 10:00 查询失败（限流）/);
    assert.match(await text(page, recentRow('1234567890')), /运输中[\s\S]*查询失败（限流）/);
    assert.deepEqual(await risks(page), ['Alpha Wigs: 物流 5 天未更新进度'], '限流后物流风险提醒还在');
    // 查不到单号（DHL 404）：说清楚是承运商查不到。
    carrier.dhl['8888888888'] = { status:404, body:{ title:'No result found', status:404, detail:'No shipment with given tracking number found.' } };
    await clickAt(page, '#trackingLookupInput');
    await page.keyboard.type('8888888888');
    await clickAt(page, '#trackingLookupBtn');
    await page.waitForFunction(() => /查询完成/.test(document.getElementById('trackingLookupResult').innerText));
    const notFound = await text(page, '#trackingLookupResult');
    assert.match(notFound, /DHL 查不到这个单号（刚发出的包裹可能要几小时后才有记录）/);
    assert.match(notFound, /未关联订单/);
    assert.doesNotMatch(notFound, /\{|HTTP 404|待 API 查询 · 更新/);
    assert.doesNotMatch(await text(page, '#trackingApiMiniStatus'), /\{/, '调用情况小条也不带 JSON');

    // 签收的单（4444 拼箱）先成功查一次，节点停在 5 天前：两张单都挂上提醒，记在批次上。
    carrier.dhl['4444444444'] = dhlOk('transit', 'Processed at hub', `${day(-5)}T08:00:00+08:00`);
    await clickRowAction(page, shipRow('4444444444'), '[data-refresh-logistics]');
    await h.waitToast(page, '物流状态已同步');
    await page.waitForFunction(() => buildTaskItems().filter(task => String(task.id).startsWith('logistics-risk-')).length === 3);
    assert.deepEqual(await risks(page), ['Alpha Wigs: 物流 5 天未更新进度', 'Combo One: 物流 5 天未更新进度', 'Combo Two: 物流 5 天未更新进度']);
    // P2-6：拼箱的查询记录写「等 2 单」，按第二张单的客户也搜得到。
    assert.match(await text(page, recentRow('4444444444')), /Combo One · L0009 等 2 单/);

    // 自动更新：DHL 第一个就限流 → 这一轮剩下的 DHL 不再发；FedEx 照查，token 只拿一次；草稿的单号不查。
    carrier.dhl['*'] = { status:429, body:{ title:'Too Many Requests' } };
    carrier.calls.length = 0;
    await page.evaluate(() => { trackingAutoUpdateGapMs = 0; });
    // Started here and polled for, not handed to page.evaluate as a promise: on macOS CI that now and then ends in
    // "Resulting promise was garbage collected" although the run finished (same workaround as test-audit-v3117).
    await page.evaluate(() => {
      window.__otsAutoRun = null;
      Promise.resolve(runTrackingAutoUpdate('manual')).then(() => { window.__otsAutoRun = { ok:true }; }, error => { window.__otsAutoRun = { error:String(error?.message || error) }; });
    });
    assert.deepEqual(await (await page.waitForFunction(() => window.__otsAutoRun)).jsonValue(), { ok:true });
    assert.deepEqual(carrier.calls.filter(call => call.startsWith('DHL:')), ['DHL:1234567890'], '限流后这一轮剩下的 DHL 单号跳过');
    assert.ok(carrier.calls.includes('FedEx:123456789012'));
    assert.ok(!carrier.calls.some(call => call.endsWith('6666666666')), '草稿的单号不查');
    await h.waitToast(page, '限流，跳过');
    assert.match((await h.toasts(page)).find(item => item.includes('自动') || item.includes('手动更新完成')), /成功 1，失败 1；DHL 限流，跳过 3 个/);
    assert.equal(await text(page, `${shipRow('2222222222')} .ship-pill`), 'DHL · 异常', '跳过的单号不写失败');
    await clickRowAction(page, shipRow('123456789012'), '[data-refresh-logistics]');
    await page.waitForFunction(() => !document.querySelector('#logisticsList .logistics-refreshing'));
    assert.equal(carrier.tokenCalls, 1, 'FedEx token 按有效期复用，不再每查一个单号拿一次');
    delete carrier.dhl['*'];
    assert.equal((await risks(page)).length, 3, '自动更新全部限流后提醒都还在');

    // ===== P2-4 / P2-5：抽屉和「最近查询」行 =====
    await page.locator('#priceHistorySearch').fill('');
    await clickAt(page, '#priceHistorySearch');
    // 页面上分组显示的单号（带空格）原样粘进来也能搜到。
    await page.keyboard.type('2222 2222 22');
    await page.waitForFunction(() => document.querySelectorAll('#priceHistoryList .recent-tracking-row').length === 1 && /Three Parcels/.test(document.getElementById('priceHistoryList').innerText));
    await page.locator('#priceHistorySearch').fill('Combo Two');
    await page.waitForFunction(() => document.querySelectorAll('#priceHistoryList .recent-tracking-row').length === 1 && /4444/.test(document.getElementById('priceHistoryList').innerText));
    await page.locator('#priceHistorySearch').fill('7777777777');
    await page.waitForFunction(() => /订单已删除/.test(document.getElementById('priceHistoryList').innerText));
    await page.locator('#priceHistorySearch').fill('2222222222');
    await page.waitForFunction(() => document.querySelectorAll('#priceHistoryList .recent-tracking-row').length === 1);
    // 点行本身打开详情。
    await clickAt(page, `${recentRow('2222222222')} .recent-tracking-code`);
    await page.waitForFunction(() => document.getElementById('trackingDetailDrawer').classList.contains('open'));
    assert.equal(await page.locator('#trackingDetailBody .modal-summary .ship-pill').getAttribute('class'), 'ship-pill tone-red', '异常用红色');
    assert.match(await text(page, '#trackingDetailBody'), /风险判断 异常 · 需要联系承运商/);
    assert.equal(await page.locator('#trackingDetailBody [data-copy-tracking="2222222222"]').count(), 1);
    assert.equal(await page.locator('#trackingDetailBody [data-detail-refresh]').count(), 1);
    assert.equal(await text(page, '#trackingDetailNum'), '2222 2222 22');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trackingDetailDrawer').classList.contains('open'));
    await page.locator('#priceHistorySearch').fill('');

    // ===== P2-1 / P2-2 / P2-3：查询框 =====
    await page.locator('#trackingLookupInput').fill('');
    await clickAt(page, '#trackingLookupInput');
    await page.keyboard.insertText('3100000001\t3100000002 / 3100000003');
    assert.match(await text(page, '#trackingDetect'), /^3 个单号 DHL 3$/, 'Tab、斜杠分隔的单号分开识别');
    await page.keyboard.insertText('\nK26110501\nUPS 123456789099\nFedEx 3100000004');
    assert.match(await text(page, '#trackingDetect'), /6 个单号 .*识别不了 1/);
    carrier.calls.length = 0;
    carrier.delayMs['3100000001'] = 700;
    await clickAt(page, '#trackingLookupBtn');
    await page.waitForFunction(() => document.getElementById('trackingLookupBtn').disabled);
    assert.equal(await page.locator('#trackingLookupBtn').getAttribute('aria-busy'), 'true');
    assert.match(await text(page, '#trackingLookupBtn'), /查询中 1\/5/);
    // 查询中再按一次（真鼠标点、⌘Enter）都不开新的一轮。
    const busyBtn = await h.center(page, '#trackingLookupBtn');
    await page.mouse.click(busyBtn.x, busyBtn.y);
    await page.locator('#trackingLookupInput').focus();
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => /查询完成：5 个物流单/.test(document.getElementById('trackingLookupResult').innerText));
    assert.deepEqual(carrier.calls.sort(), ['DHL:3100000001', 'DHL:3100000002', 'DHL:3100000003', 'FedEx:3100000004'], '每个单号只查一次；认不出的不查；订单里选了 UPS 的 12 位单号不按 FedEx 查');
    const queryResult = await text(page, '#trackingLookupResult');
    assert.match(queryResult, /UPS · 1234 5678 9099 Ups Twelve · L0011/);
    assert.match(queryResult, /格式不像 DHL \/ FedEx \/ UPS 单号，没有查询/);
    assert.equal(await page.evaluate(() => state.orders.find(order => order.id === 'u12').stage), 'shipment');
    assert.equal(await page.locator('#trackingLookupInput').inputValue(), '3100000001\t3100000002 / 3100000003\nK26110501\nUPS 123456789099\nFedEx 3100000004', '输入框不被改写，前缀还在');
    await page.waitForFunction(() => !document.getElementById('trackingLookupBtn').disabled);
    // 超过 12 个：查前 12 个，剩下的留在输入框里。
    const fifteen = Array.from({ length:15 }, (_, i) => String(3200000000 + i));
    await page.locator('#trackingLookupInput').fill('');
    await clickAt(page, '#trackingLookupInput');
    await page.keyboard.insertText(fifteen.join('\n'));
    assert.match(await text(page, '#trackingDetect'), /15 个单号 · 每次查 12 个/);
    carrier.calls.length = 0;
    await clickAt(page, '#trackingLookupBtn');
    await page.waitForFunction(() => /查询完成：12 个物流单/.test(document.getElementById('trackingLookupResult').innerText));
    assert.equal(carrier.calls.length, 12);
    assert.equal(await page.locator('#trackingLookupInput').inputValue(), fifteen.slice(12).join('\n'));
    assert.match(await text(page, '#trackingLookupResult'), /还有 3 个单号没查/);

    // ===== P1-3：置顶不被挤掉，上限 50；「清除所有」先确认、可撤销，提醒不受影响 =====
    for (let round = 0; round < 3; round += 1) {
      const batch = Array.from({ length:12 }, (_, i) => String(3300000000 + round * 100 + i));
      await page.locator('#trackingLookupInput').fill(batch.join('\n'));
      await page.waitForFunction(() => !document.getElementById('trackingLookupBtn').disabled);
      await clickAt(page, '#trackingLookupBtn');
      await page.waitForFunction(() => /查询完成：12 个物流单/.test(document.getElementById('trackingLookupResult').innerText) && !document.getElementById('trackingLookupBtn').disabled);
    }
    const lookups = await page.evaluate(() => state.trackingLookups.map(item => `${item.trackingNumber}${item.pinned ? ':pinned' : ''}`));
    assert.equal(lookups.length, 50);
    assert.ok(lookups.includes('9999999999:pinned'), '置顶的记录不被挤掉');
    assert.match(await text(page, '#priceHistoryList .recent-tracking-more'), /还有 32 条 · 全部显示/);
    await clickAt(page, '#priceHistoryList .recent-tracking-more');
    assert.equal(await page.locator('#priceHistoryList .recent-tracking-row').count(), 50);
    await clickAt(page, '#clearTrackingHistoryBtn');
    await page.locator('#confirmModal.open').waitFor();
    assert.match(await text(page, '#confirmTitle'), /清除 50 条查询记录/);
    assert.match(await text(page, '#confirmMessage'), /置顶的 1 条会保留/);
    assert.equal(await text(page, '#confirmAltBtn'), '连置顶一起清除');
    await h.settle(page, '#confirmModal .modal');
    await clickAt(page, '#confirmOkBtn');
    await page.waitForFunction(() => state.trackingLookups.length === 1);
    assert.equal(await page.evaluate(() => state.trackingLookups[0].trackingNumber), '9999999999');
    assert.equal((await risks(page)).length, 3, '清空查询记录后物流风险提醒还在（看批次上的最后一次成功查询）');
    await h.clickUndo(page, '已清除 49 条查询记录');
    await page.waitForFunction(() => state.trackingLookups.length === 50);
    assert.equal(await page.locator('#clearTrackingHistoryBtn').isVisible(), true);

    // ===== P2-9：签收自动完成，提示写明并可撤销 =====
    carrier.dhl['1234567890'] = dhlOk('delivered', 'Delivered', new Date(zonedEpoch(`${TODAY}T09:30`, 'Asia/Shanghai')).toISOString());
    await clickRowAction(page, shipRow('1234567890'), '[data-refresh-logistics]');
    await h.waitToast(page, 'L0001 Alpha Wigs 已签收，订单移到「已完成」');
    assert.equal(await page.evaluate(() => state.orders.find(order => order.id === 'a1').stage), 'done');
    assert.equal(await page.locator(shipRow('1234567890')).count(), 0, '完成的单离开进行中的列表');
    await h.clickUndo(page, '已签收，订单移到「已完成」');
    await page.waitForFunction(() => state.orders.find(order => order.id === 'a1').stage === 'shipment');
    assert.ok(await page.evaluate(() => state.orders.find(order => order.id === 'a1').autoDoneHold), '撤销后这批单号不再被自动推回已完成');
    await clickRowAction(page, shipRow('1234567890'), '[data-refresh-logistics]');
    await h.waitToast(page, '物流状态已同步');
    assert.equal(await page.evaluate(() => state.orders.find(order => order.id === 'a1').stage), 'shipment');

    // 窄屏不横向滚动。
    await page.setViewportSize({ width:390, height:844 });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, '390px 下没有横向滚动');

    assert.ok(carrier.calls.every(call => /^(DHL|FedEx):/.test(call)), '只调用了本机的假承运商');
    assert.deepEqual(dialogs, [], '没有原生 alert / confirm');
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.flushPendingSave?.());
    console.log('Logistics page UI test passed: one in-transit scope for cards / list / sidebar, filters, failures keep the last good result, rate-limit stop, FedEx token reuse, pinned cap, confirm + undo clear, query box parsing / carrier / busy, drawer risk, combo, delivered-complete undo.');
  } finally {
    await browser?.close().catch(() => {});
    server.kill('SIGTERM');
    fake.close();
    await sleep(200);
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
