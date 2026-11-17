#!/usr/bin/env node
// 物流页一样的字只写一遍（页面第二轮 PR-B）：
// - 「发货订单」每行：承运商只在单号前写一次，右上角只写状态；异常件的时长小标只写「已 N 天」；今天查成功的不写「查过 ✓」，
//   昨天查的、查询失败的照写；签收的时长是灰色，悬停只写发货日；
// - 「最近查询物流」每行：右上角已经有查询时间，查询成功的不写「查过 ✓」，失败的照写；
// - 物流进度抽屉：客户名、订单号、最新节点各只写一次；只关联一张订单时「打开订单」在顶上的卡里；拼箱时列「关联订单」；
//   「打开官网」在顶上的按钮里，能点；UPS 没有节点时空状态写明原因。
// 时间用固定时钟，数据里的日期都从这个时间往前推。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const pad = n => String(n).padStart(2, '0');
const NOW = new Date(2030, 2, 12, 12, 0);
const dayText = offset => { const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const base = { currency:'USD', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', orderType:'全款订单', amount:800, paidAmount:800, attachments:[] };
let seq = 0;
const mk = (id, client, shipments) => {
  seq += 1;
  return { ...base, id, num:`P${String(seq).padStart(4, '0')}`, client, stage:'shipment', logisticsStatus:'运输中', orderMonth:dayText(-10).slice(0, 7), createdAt:dayText(-10), updated:`${dayText(-1)} 09:00`, shipments };
};
const ship = (id, trackingNumber, carrier, status, shippedOffset, updatedOffset = -1) => ({ id, trackingNumber, carrier, status, shippedAt:dayText(shippedOffset), updated:`${dayText(updatedOffset)} 09:00` });
const lookup = (id, trackingNumber, carrier, extra = {}) => ({ id, trackingNumber, carrier, checkedAt:`${dayText(0)} 09:00`, orderId:'', client:'', displayClient:'', orderNum:'-', status:'运输中', statusUpdatedAt:`${dayText(-1)} 09:00`, queryMessage:'', online:'是', pinned:false, events:[], ...extra });

const orders = [
  mk('o-today', 'Today Checked', [ship('s1', '1000000001', 'DHL', '运输中', -2)]),
  mk('o-yday', 'Yesterday Checked', [ship('s2', '1000000002', 'DHL', '运输中', -2)]),
  mk('o-fail', 'Failed Check', [ship('s3', '1000000003', 'DHL', '运输中', -2)]),
  mk('o-done', 'Delivered Buyer', [ship('s4', '100000000004', 'FedEx', '已签收', -6, -1)]),
  mk('o-bad', 'Held Parcel', [ship('s5', '1000000005', 'DHL', '异常', -3)]),
  mk('o-combo1', 'Combo First', [ship('s6', '1000000006', 'DHL', '运输中', -2)]),
  mk('o-combo2', 'Combo Second', [ship('s7', '1000000006', 'DHL', '运输中', -2)]),
  mk('o-ups', 'Ups Buyer', [ship('s8', '1Z999AA10123456784', 'UPS', '已发货', -2)])
];
const trackingLookups = [
  lookup('lk-today', '1000000001', 'DHL', { orderId:'o-today', client:'Today Checked', orderNum:'P0001', events:[
    { time:`${dayText(-1)} 08:00`, title:'Arrived at hub', location:'Leipzig' },
    { time:`${dayText(-2)} 20:00`, title:'Shipment picked up', location:'Guangzhou' }] }),
  lookup('lk-yday', '1000000002', 'DHL', { orderId:'o-yday', client:'Yesterday Checked', orderNum:'P0002', checkedAt:`${dayText(-1)} 08:00` }),
  lookup('lk-fail', '1000000003', 'DHL', { orderId:'o-fail', client:'Failed Check', orderNum:'P0003', checkedAt:`${dayText(0)} 10:00`, lastOkAt:`${dayText(-1)} 08:00`,
    lastError:{ code:'rate_limited', message:'Too many requests', at:`${dayText(0)} 10:00` } }),
  lookup('lk-done', '100000000004', 'FedEx', { orderId:'o-done', client:'Delivered Buyer', orderNum:'P0004', status:'已签收' }),
  lookup('lk-bad', '1000000005', 'DHL', { orderId:'o-bad', client:'Held Parcel', orderNum:'P0005', status:'异常', events:[{ time:`${dayText(-1)} 12:00`, title:'Shipment on hold', location:'Sydney' }] }),
  lookup('lk-combo', '1000000006', 'DHL', { orderId:'o-combo1', orderIds:['o-combo1', 'o-combo2'], client:'Combo First', orderNum:'P0006' }),
  lookup('lk-ups', '1Z999AA10123456784', 'UPS', { orderId:'o-ups', client:'Ups Buyer', orderNum:'P0008', online:'官网', status:'已发货' })
];

const shipRow = number => `#logisticsList .ship-row:has([data-copy-tracking="${number}"])`;
const recentRow = number => `#priceHistoryList .recent-tracking-row:has([data-copy-tracking="${number}"])`;
const count = (text, word) => text.split(word).length - 1;

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders, trackingLookups }, { port:freePortSync() });
    await page.clock.setFixedTime(NOW);
    await page.evaluate(() => { window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }; setPage('logistics'); });
    await page.waitForSelector(shipRow('1000000001'));
    const text = selector => page.locator(selector).first().innerText().then(value => value.replace(/\s+/g, ' ').trim());

    // ===== 发货订单 =====
    const todayRow = await text(shipRow('1000000001'));
    assert.equal(count(todayRow, 'DHL'), 1, `承运商只写一次：${todayRow}`);
    assert.equal(await text(`${shipRow('1000000001')} .ship-pill`), '运输中', '右上角只写状态');
    assert.doesNotMatch(todayRow, /查过/, '今天查成功的不写「查过」');
    assert.match(await text(`${shipRow('1000000002')} .ship-check`), /^昨天 08:00 查过 ✓$/, '昨天查的照写');
    const failCheck = page.locator(`${shipRow('1000000003')} .ship-check`);
    assert.match(await failCheck.innerText(), /今天 10:00 查询失败（限流）/, '查询失败的照写');
    assert.equal(await failCheck.getAttribute('class'), 'ship-check bad');
    // 异常：右上角写「异常」，时长小标只写「已 N 天」，照旧红色。
    assert.equal(await text(`${shipRow('1000000005')} .ship-pill`), '异常');
    assert.match(await text(`${shipRow('1000000005')} .delivery-timing`), /^已 \d+ 天$/);
    assert.equal(await page.locator(`${shipRow('1000000005')} .delivery-timing`).getAttribute('class'), 'delivery-timing bad');
    assert.equal(count(await text(shipRow('1000000005')), '异常'), 1, '「异常」一行只写一次');
    // 签收：灰色，悬停只写发货日。在途的颜色不变。
    const delivered = page.locator(`${shipRow('100000000004')} .delivery-timing`);
    assert.match(await delivered.innerText(), /^签收 \d+天/);
    assert.equal(await delivered.getAttribute('class'), 'delivery-timing neutral', '签收的时长是灰色');
    assert.equal(await delivered.getAttribute('title'), `${dayText(-6)} 发货`);
    assert.match(await page.locator(`${shipRow('1000000001')} .delivery-timing`).getAttribute('class'), /delivery-timing (ok|warn|bad)/, '在途照旧按天数上色');
    assert.match(await page.locator(`${shipRow('1000000001')} .delivery-timing`).getAttribute('title'), /2 天内绿色/);

    // ===== 最近查询物流 =====
    assert.equal(await page.locator(`${recentRow('1000000001')} .ship-check`).count(), 0, '查询成功的不写「查过」，右上角已经有时间');
    assert.equal(await page.locator(`${recentRow('1000000002')} .ship-check`).count(), 0);
    assert.equal(await text(`${recentRow('1000000002')} .recent-tracking-time`), '昨天 08:00');
    assert.match(await text(`${recentRow('1000000003')} .ship-check.bad`), /查询失败（限流）/, '失败的照写');
    assert.equal(await page.locator(`${recentRow('100000000004')} .delivery-timing`).getAttribute('class'), 'delivery-timing neutral');
    assert.match(await text(`${recentRow('1000000005')} .delivery-timing`), /^已 \d+ 天$/);

    // ===== 物流进度抽屉：只关联一张订单 =====
    await page.evaluate(() => openTrackingDetail('lk-today'));
    await page.waitForFunction(() => document.getElementById('trackingDetailDrawer').classList.contains('open'));
    const drawer = await text('#trackingDetailBody');
    assert.equal(count(drawer, 'Today Checked'), 1, `客户名只写一次：${drawer}`);
    assert.equal(count(drawer, 'P0001'), 1, '订单号只写一次');
    assert.equal(count(drawer, 'Arrived at hub'), 1, '最新节点只写一次');
    assert.match(drawer, /^Today Checked 打开订单 P0001 · 已发货 运输中 今天 09:00 查过 ✓ 复制单号 重新查询 打开官网 物流节点 共 2 个 Arrived at hub 最新 /);
    assert.doesNotMatch(drawer, /物流概览|人工核对|风险判断|关联订单|更新 \d/);
    assert.equal(await page.locator('#trackingDetailBody .detail-hero [data-tracking-open-order="o-today"]').count(), 1, '「打开订单」在顶上的卡里');
    assert.equal(await page.locator('#trackingDetailBody .carrier-badge').count(), 0, '标题栏已经写了承运商');
    assert.equal(await page.locator('#trackingDetailBody .tracking-event-latest').count(), 1);
    // 本机服务模式下官网链接交给 /api/open-url，否则 window.open：两条路都记下来。
    const openUrl = page.waitForRequest(request => new URL(request.url()).pathname === '/api/open-url', { timeout:3000 }).then(request => request.postDataJSON().url).catch(() => '');
    await page.locator('#trackingDetailBody [data-open-official-tracking]').click();
    const opened = [await openUrl, ...await page.evaluate(() => window.__opened)].filter(Boolean);
    assert.equal(opened.length, 1, `「打开官网」打开一次 ${opened}`);
    assert.match(opened[0], /1000000001/, '打开的是这个单号');

    // 异常：风险跟在状态后面，只写「需要联系承运商」。
    await page.evaluate(() => openTrackingDetail('lk-bad'));
    await page.waitForFunction(() => /Held Parcel/.test(document.getElementById('trackingDetailBody').innerText));
    assert.equal(await text('#trackingDetailBody .tracking-detail-status .tracking-freshness-risk'), '需要联系承运商');
    assert.equal(count(await text('#trackingDetailBody'), '异常'), 1);

    // 拼箱：「关联订单」列两张，顶上的卡里不放「打开订单」。
    await page.evaluate(() => openTrackingDetail('lk-combo'));
    await page.waitForFunction(() => /关联订单/.test(document.getElementById('trackingDetailBody').innerText));
    assert.equal(await page.locator('#trackingDetailBody .tracking-detail-order').count(), 2);
    assert.equal(await page.locator('#trackingDetailBody .detail-hero [data-tracking-open-order]').count(), 0);
    assert.match(await text('#trackingDetailBody .detail-hero'), /^Combo First P0006 等 2 单 /);

    // UPS 没有节点：空状态写明原因，没有「重新查询」。
    await page.evaluate(() => openTrackingDetail('lk-ups'));
    await page.waitForFunction(() => /Ups Buyer/.test(document.getElementById('trackingDetailBody').innerText));
    assert.equal(await text('#trackingDetailBody .empty'), '暂无详细节点：UPS 不查 API，请在官网核对。');
    assert.equal(await page.locator('#trackingDetailBody [data-detail-refresh]').count(), 0);
    assert.equal(await page.locator('#trackingDetailBody .detail-hero [data-open-official-tracking]').count(), 1);

    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
    console.log('Logistics dedupe UI test passed: carrier and status once per row, today\'s successful check not repeated, delivered timing grey, drawer shows client / order / latest event once, combo and UPS cases.');
  } finally {
    await browser.close().catch(() => {});
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
