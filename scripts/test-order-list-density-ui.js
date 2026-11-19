const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, h } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');
const { freePortSync } = require('./helpers/free-port');
const { pageWithPrefs } = require('../mac-app/ui-prefs');

// 订单列表的行距：「紧凑」（默认，每行最多两层字，1440×920 一屏 10 行）和「宽松」（V3.180 的排法）。
// 两种共用一份行模板。国家并进客户格，没到发货阶段的单物流格不写「未填写运单」，已发货 / 已完成没单号的写「待补单号」。
// 选择是界面偏好 ots-order-list-density-v1：本机存储加本机服务那份（serverPrefKeys），本机存储被清掉后还在。

const key = 'ots-order-list-density-v1';
const customers = {
  'Kora Hair Johannesburg':{ client:'Kora Hair Johannesburg', contact:'Thandi M.', country:'🇿🇦 南非 South Africa' }
};
const order = (id, extra = {}) => ({ ...base, id, num:`D${id}`, client:`Density Buyer ${id}`, amount:1000, paidAmount:0, orderType:'定金订单', depositAmount:300, depositPercent:30, stage:'quote', updated:`${base.createdAt} 09:${String(10 + Number(id.replace(/\D/g, '') || 0)).padStart(2, '0')}`, ...extra });
const orders = [
  order('o1', { client:'Kora Hair Johannesburg', country:'🇿🇦 南非 South Africa', note:'等客户确认颜色', stage:'production', paidAmount:300, urgentOrder:true }),
  order('o2', { country:'' }),
  order('o3', { stage:'shipment', paidAmount:1000, logisticsStatus:'已发货', shippedAt:base.createdAt }),
  order('o4', { stage:'done', paidAmount:1000 }),
  order('o5', { stage:'production', paidAmount:300, logisticsStatus:'运输中' }),
  order('o6', { stage:'shipment', paidAmount:1000, trackingNumber:'1234567890', carrier:'DHL', logisticsStatus:'运输中', shippedAt:base.createdAt,
    shipments:[{ id:'s6', trackingNumber:'1234567890', carrier:'DHL', status:'运输中', shippedAt:base.createdAt }] }),
  ...Array.from({ length:8 }, (_, i) => order(`o${7 + i}`, { country:'🇬🇧 英国 United Kingdom', note:i % 2 ? '周五前催尾款' : '', next:'旧数据里的下一步' }))
];

// 重载前等保存落地：WebKit 里重载打断还在路上的 /api/save，会报一条页面错误「Fetch API cannot load … due to access control checks」。
const saved = page => page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
const rowOf = (page, id) => page.locator(`#orderTableBody [data-order-list-id="${id}"]`);
const density = page => page.evaluate(() => ({
  table:document.querySelector('#page-order-list .order-table').dataset.density,
  pressed:[...document.querySelectorAll('[data-order-list-density]')].filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.orderListDensity)
}));
const layout = page => page.evaluate(() => {
  const scroll = document.querySelector('#page-order-list .order-table-scroll').getBoundingClientRect();
  const rows = [...document.querySelectorAll('#orderTableBody tr')];
  const top = el => Math.round(el.getBoundingClientRect().top);
  const o1 = document.querySelector('[data-order-list-id="o1"]');
  return {
    heights:rows.map(row => Math.round(row.getBoundingClientRect().height)),
    visible:rows.filter(row => { const box = row.getBoundingClientRect(); return box.top >= scroll.top - 0.5 && box.bottom <= scroll.bottom + 0.5; }).length,
    stageTops:[...new Set([...o1.querySelectorAll('.order-table-stage > *')].map(top))].length,
    actionTops:[...new Set([...o1.querySelectorAll('.order-table-actions > button')].map(top))].length,
    cutNames:[...document.querySelectorAll('#orderTableBody .order-table-customer .order-table-ellipsis')].filter(el => el.scrollWidth > el.clientWidth + 0.5).map(el => el.textContent)
  };
});
// 行内「收齐」：只改这一张，行先不跳走（排序是最近更新在前，改完它本该排到第一）。
async function quickPaid(page, id, expectedPaid) {
  const before = await page.evaluate(() => [...document.querySelectorAll('#orderTableBody [data-order-list-id]')].map(row => row.dataset.orderListId));
  // 行内按钮 400ms 内的第二下不算（防双击），这里是另一张单、隔了一会儿才点。
  await h.waitPageTime(page, 450);
  await rowOf(page, id).locator('[data-order-list-quick="paid"]').click();
  await page.waitForFunction(([id, paid]) => state.orders.find(item => item.id === id)?.paidAmount === paid, [id, expectedPaid]);
  const after = await page.evaluate(() => [...document.querySelectorAll('#orderTableBody [data-order-list-id]')].map(row => row.dataset.orderListId));
  assert.equal(after.indexOf(id), before.indexOf(id), `${id}: the row stays where it was after 收齐`);
  assert.equal(await page.locator('#orderDetailDrawer.open').count(), 0, '收齐 does not open the order');
  await page.mouse.move(5, 5);
}

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders, customers }, { port:freePortSync() });
    await page.locator('.nav-item[data-page="order-list"]').click();
    await rowOf(page, 'o1').waitFor();
    await page.mouse.move(5, 5);

    // 1. 默认紧凑：每行两层字，行高不超过 56，1440×920 能看到 10 行；客户名不被截；「加急」和阶段、两个按钮各自并排。
    assert.deepEqual(await density(page), { table:'compact', pressed:['compact'] });
    assert.equal(await page.evaluate(k => localStorage.getItem(k), key), null, 'nothing stored until the user picks');
    const compact = await layout(page);
    assert(compact.heights.every(height => height <= 56), `compact rows are at most 56px: ${compact.heights}`);
    assert(compact.visible >= 10, `at least 10 rows fit at 1440×920: ${compact.visible}`);
    assert.deepEqual(compact.cutNames, [], 'customer names are not cut at 1440');
    assert.equal(compact.stageTops, 1, '加急 sits beside the stage');
    assert.equal(compact.actionTops, 1, '收齐 and → next stage sit side by side');
    assert.match(await rowOf(page, 'o1').locator('.col-customer').innerText(), /Kora Hair Johannesburg（Thandi M\.）/);

    // 2. 国家并进客户格（没有「国家地区」列），物流格只在该写的时候写字。两种行距共用这一份内容。
    const headers = await page.locator('#page-order-list .order-table thead th').allInnerTexts();
    assert.deepEqual(headers.map(text => text.trim()), ['订单号', '客户', '产品 · 收款', '阶段', '金额 · 收款', '物流', '创建日期', '操作']);
    assert.equal(await page.locator('#orderTableBody .col-country').count(), 0);
    const sub = rowOf(page, 'o1').locator('.col-customer .order-table-sub');
    assert.equal(await sub.innerText(), '🇿🇦 南非 · 等客户确认颜色');
    assert.equal(await sub.getAttribute('title'), '🇿🇦 南非 South Africa · 等客户确认颜色', 'the full country name is in the title');
    assert.equal(await rowOf(page, 'o8').locator('.col-customer .order-table-sub').innerText(), '🇬🇧 英国 · 周五前催尾款', 'the note is the remark');
    assert.equal(await rowOf(page, 'o7').locator('.col-customer .order-table-sub').innerText(), '🇬🇧 英国', 'the removed next step (still in old data) is not shown');
    assert.equal(await rowOf(page, 'o2').locator('.col-customer .order-table-sub').innerText(), '🌐 其他 Other', 'an empty country is read as 其他 (shown as before), never 未填写');
    const logistics = async id => (await rowOf(page, id).locator('.order-table-logistics strong').innerText()).trim();
    assert.equal(await logistics('o2'), '', 'a quote has no shipping yet: the cell stays empty');
    assert.equal(await logistics('o3'), '待补单号', 'shipped without a tracking number');
    assert.equal(await logistics('o4'), '待补单号', 'done without a tracking number');
    assert.equal(await logistics('o5'), '运输中 · 未填运单', 'a status of its own stays as it was');
    assert.equal(await logistics('o6'), '运输中');
    assert.ok(!(await page.locator('#orderTableBody').innerText()).includes('未填写运单'), 'no row says 未填写运单');
    assert.equal(await page.locator('#orderTableBody .order-table-logistics.missing').count(), 2);

    // 3. 紧凑下点「收齐」：行不跳走、不打开详情。
    await quickPaid(page, 'o7', 1000);

    // 4. 切到宽松：行回到 V3.180 的高度，阶段小标和两个按钮上下排；存进本机。
    await page.locator('[data-order-list-density="comfortable"]').click();
    assert.deepEqual(await density(page), { table:'comfortable', pressed:['comfortable'] });
    assert.equal(await page.evaluate(k => localStorage.getItem(k), key), 'comfortable');
    const comfortable = await layout(page);
    assert(comfortable.heights.every(height => height >= 66), `comfortable rows keep their height: ${comfortable.heights}`);
    assert.equal(comfortable.stageTops, 2, '加急 under the stage');
    assert.equal(comfortable.actionTops, 2, 'the two buttons stacked');
    assert.deepEqual(comfortable.cutNames, [], 'customer names are not cut at 1440');
    assert.equal(await logistics('o3'), '待补单号');
    await quickPaid(page, 'o9', 1000);

    // 5. 刷新后还是宽松。
    await saved(page);
    await page.reload();
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('order-list'));
    await rowOf(page, 'o1').waitFor();
    assert.deepEqual(await density(page), { table:'comfortable', pressed:['comfortable'] });

    // 6. 本机服务那份：页面由服务发出（ots-prefs 里还没有这一项）时把本机的值交给它；本机存储清掉后照服务那份。
    const posted = [];
    let served = {};
    await page.route('**/api/ui-prefs', route => { posted.push(route.request().postDataJSON()); return route.fulfill({ json:{ ok:true } }); });
    await page.route('**/trade-order-system.html', route => route.fulfill({ contentType:'text/html', body:pageWithPrefs(html, served) }));
    await saved(page);
    await page.reload();
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await assert.doesNotReject(() => page.waitForFunction(() => !localStorage.getItem('ots-prefs-unsent'), null, { timeout:5000 }), 'the stored choice reaches the server');
    assert.ok(posted.some(body => body.set?.[key] === 'comfortable'), `the server gets the stored choice: ${JSON.stringify(posted)}`);
    served = { [key]:'comfortable' };
    await page.evaluate(() => localStorage.clear());
    await saved(page);
    await page.reload();
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('order-list'));
    await rowOf(page, 'o1').waitFor();
    assert.deepEqual(await density(page), { table:'comfortable', pressed:['comfortable'] }, 'kept after the local storage was cleared');
    await page.locator('[data-order-list-density="compact"]').click();
    assert.deepEqual(await density(page), { table:'compact', pressed:['compact'] });
    await page.waitForFunction(k => localStorage.getItem(k) === 'compact' && !localStorage.getItem('ots-prefs-unsent'), key);
    assert.ok(posted.some(body => body.set?.[key] === 'compact'), 'switching back is sent to the server too');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('Order list density passed: compact by default (10 rows of at most 56px at 1440×920), comfortable keeps the old rows, the choice survives a reload and a cleared local storage, country in the customer cell, 待补单号 only for shipped orders, 收齐 keeps the row in both.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
