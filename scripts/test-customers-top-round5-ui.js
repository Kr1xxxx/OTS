#!/usr/bin/env node
// Pages round 3 (round 5 of the tidy-ups), customers page top and tabs with nothing in them:
// 1. the customers page has no「N 个结果 · 成交 … · 待收 …」line, no「N 个客户」above the groups and no level dropdown;
//    the level is picked in the groups on the left only, and the groups follow the level list in 设置 (a level added
//    there gets its own group)
// 2. a group, a to-do tab or a notification tab with nothing in it is grey and writes no「0」; it can still be picked,
//    and a screen reader still hears「…，0 个 / 0 条」
// 3. the customer list's last column is called「复购 / 更新」, and the read-only profile no longer writes
//    「3 个订单 · $17,800」next to its tabs
// The clock is fixed in the page (Asia/Shanghai); customers and orders are made up.
const assert = require('node:assert/strict');
const { launchBrowser } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

const at = text => new Date(`${text}+08:00`);
const base = { currency:'USD', logisticsStatus:'未发货', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[], orderType:'定金订单', depositAmount:300 };
let seq = 0;
const order = extra => { seq += 1; return { ...base, id:`o${seq}`, num:`T-26110${seq}`, paidAmount:300, amount:1000, stage:'production', createdAt:'2026-11-03', orderMonth:'2026-11', updated:'2026-11-06 09:00', ...extra }; };
const CUSTOM = '试用级客户';
const profile = (client, level) => ({ client, level, country:'🇺🇸 美国 United States', tags:[] });
const customers = {
  'Sample Alpha':profile('Sample Alpha', 'A级钻石客户'),
  'Sample Beta':profile('Sample Beta', 'A级钻石客户'),
  'Sample Gamma':profile('Sample Gamma', 'C级白金客户'),
  'Sample Delta':profile('Sample Delta', CUSTOM)
};
const orders = [
  order({ client:'Sample Alpha', amount:3000, paidAmount:3000 }),
  order({ client:'Sample Beta', stage:'balance', latestShipDate:'2026-11-12' }),
  order({ client:'Sample Gamma' }),
  order({ client:'Sample Gamma', amount:2000 }),
  order({ client:'Sample Delta' })
];

async function open(browser) {
  const context = await browser.newContext({ viewport:{ width:1440, height:900 }, timezoneId:'Asia/Shanghai' });
  await context.clock.setFixedTime(at('2026-11-17T11:00:00'));
  await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  const store = { app:'trade-order-system', data:{ orders, deletedOrders:[], customers, customerLevels:[CUSTOM], doneTasks:{}, demoCleared:true, demoCustomersCleared:true }, revision:0 };
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    let response = { ok:true };
    if (pathname === '/api/data') response = store;
    if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
    if (pathname === '/api/ecb-rates') response = { ok:true, rates:[{ date:'2026-11-02', rates:{ CNY:7.7, USD:1.08 } }] };
    if (pathname === '/api/usd-cny-rate') response = { ok:false };
    if (pathname === '/api/save') {
      store.data = route.request().postDataJSON().state;
      store.revision += 1;
      response = { ok:true, revision:store.revision, backup:{ ok:true, skipped:true } };
    }
    return route.fulfill({ json:response });
  });
  await page.goto('http://127.0.0.1:47992/trade-order-system.html');
  await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  return { page, context, errors };
}

const groups = page => page.evaluate(() => [...document.querySelectorAll('#customerGroups [data-customer-group]')].map(btn => ({
  id:btn.dataset.customerGroup,
  text:btn.innerText.replace(/\s+/g, ' ').trim(),
  count:btn.querySelector('.customer-group-count')?.textContent ?? null,
  label:btn.getAttribute('aria-label'),
  empty:btn.classList.contains('is-empty'),
  active:btn.classList.contains('active'),
  color:getComputedStyle(btn).color
})));

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, context, errors } = await open(browser);
    await page.evaluate(() => setPage('customers'));
    await page.waitForSelector('#customerGroups [data-customer-group="all"]');

    // ---- 1. one place for each number, one place to pick a level ----
    assert.deepEqual(await page.evaluate(() => ['customerResultMeta', 'customerGroupTotal', 'customerLevelFilter'].filter(id => document.getElementById(id))), []);
    assert.equal(await page.locator('.customer-toolbar select').count(), 1, 'only the sort dropdown is left in the toolbar');
    let list = await groups(page);
    assert.deepEqual(list.map(g => g.id), ['all', 'level-a', 'level-b', 'level-c', 'level-d', 'level-e', 'level-f', `level:${CUSTOM}`, 'paid', 'unpaid']);
    const byId = id => list.find(g => g.id === id);
    assert.equal(byId('all').count, '4');
    assert.equal(byId('level-a').count, '2');
    assert.equal(byId(`level:${CUSTOM}`).text, `${CUSTOM} 1`, 'a level added in 设置 has its own group');
    await page.locator(`#customerGroups [data-customer-group="level:${CUSTOM}"]`).click();
    assert.equal(await page.locator('#customerList .customer-row:not(.head)').count(), 1);
    assert.match(await page.locator('#customerList .customer-row:not(.head)').innerText(), /Sample Delta/);
    await page.locator('#customerGroups [data-customer-group="level-a"]').click();
    assert.equal(await page.locator('#customerList .customer-row:not(.head)').count(), 2);

    // ---- 2. empty groups: grey, no 0, still a button ----
    list = await groups(page);
    for (const id of ['level-b', 'level-d', 'level-e', 'level-f']) {
      const g = byId(id);
      assert.equal(g.count, null, `${id} writes no 0`);
      assert.ok(g.empty, `${id} is marked empty`);
      assert.match(g.label, /，0 个$/, `${id} still says 0 to a screen reader`);
    }
    assert.equal(byId('level-a').empty, false);
    assert.notEqual(byId('level-d').color, byId('unpaid').color, 'an empty group is greyer than a group with customers');
    await page.locator('#customerGroups [data-customer-group="level-d"]').click();
    list = await groups(page);
    assert.ok(byId('level-d').active && byId('level-d').empty, 'an empty group can still be picked');
    const activeEmptyColor = byId('level-d').color;
    assert.equal(await page.locator('#customerList .customer-row:not(.head)').count(), 0);
    await page.locator('#customerGroups [data-customer-group="all"]').click();
    list = await groups(page);
    assert.equal(activeEmptyColor, byId('all').color, 'a picked empty group looks like any picked group');

    // ---- 3. list header and the read-only profile ----
    assert.equal((await page.locator('#customerList .customer-row.head > div').last().innerText()).trim(), '复购 / 更新');
    await page.evaluate(() => openCustomerModal('Sample Gamma', { viewOnly:true }));
    await page.waitForFunction(() => document.getElementById('customerModal')?.classList.contains('open'));
    assert.equal(await page.evaluate(() => document.getElementById('customerDetailOrdersMeta')), null);
    assert.doesNotMatch(await page.locator('#customerModal').innerText(), /2 个订单 · /);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('customerModal')?.classList.contains('open'));

    // ---- 2. to-do tabs and notification tabs ----
    await page.evaluate(() => setPage('dashboard'));
    const tabs = selector => page.evaluate(selector => [...document.querySelectorAll(selector)].map(btn => ({
      text:btn.innerText.replace(/\s+/g, ' ').trim(),
      c:btn.querySelector('.c')?.textContent ?? null,
      label:btn.getAttribute('aria-label'),
      empty:btn.classList.contains('is-empty'),
      active:btn.classList.contains('active')
    })), selector);
    const checkTabs = (rows, what) => {
      assert.ok(rows.length >= 4, `${what}: tabs found`);
      rows.forEach(row => {
        const n = Number(row.label.match(/，(\d+) 条$/)?.[1]);
        assert.ok(Number.isInteger(n), `${what} ${row.text}: aria-label carries the count (${row.label})`);
        if (n) assert.deepEqual([row.c, row.empty], [String(n), false], `${what} ${row.text}`);
        else assert.deepEqual([row.c, row.empty, row.text], [null, true, row.label.replace(/，0 条$/, '')], `${what} ${row.text}`);
      });
    };
    const todo = await tabs('#taskInboxFilters [data-task-filter]');
    checkTabs(todo, 'to-do');
    assert.ok(todo.some(row => row.empty) && todo.some(row => !row.empty), 'the fixture has empty and filled to-do tabs');
    await page.locator('#notifBtn').click();
    await page.waitForFunction(() => !document.getElementById('notifPanel').hidden);
    const notif = await tabs('#notifTabs [data-notif-tab]');
    checkTabs(notif, 'notifications');

    assert.deepEqual(errors, []);
    await context.close();
    console.log('Customers top round 5 UI passed: no result line, total or level dropdown, groups follow the level list, empty groups and tabs are grey without 0, 复购 / 更新 header, profile without the orders line.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
