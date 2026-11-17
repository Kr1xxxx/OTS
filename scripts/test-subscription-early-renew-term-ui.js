#!/usr/bin/env node
// 续费：手动续费提前点了「已续费」，再改付款方式选「从下一期起」，提前续好的那一期落进历史设置（terms），日期还在今天之后。
// 以前历史设置下的扣费另拿今天卡日期（subscriptionTermTotals / subscriptionChargePaid / subscriptionPeriods 三处），
// 累计已付少这一笔（120 → 90）、分析页把它算成本月待扣和未来预计、详情「周期费用」里这一期消失，等日期到了才回来。
// 一段历史设置到「付到哪天之后的第一期」为止，里面每一期都付过了：这里断言改前改后各处的数一分不差。
// 自动续费项走同一条路（从下一期起改付款方式），改前改后也一分不差。
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSubscriptionStore } = require('../mac-app/subscription-store');
const { launchBrowser, h } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');
const { confirmChoices } = require('./helpers/confirm-dialog');

const now = new Date('2026-11-16T10:00:00+08:00');
const manualName = 'manual-monthly.test';
const autoName = 'auto-monthly.test';

(async () => {
  const store = createSubscriptionStore(new DatabaseSync(':memory:'));
  // 手动续费、月付 ¥30：8/20、9/20、10/20 已续（累计 90），下一期 11/20 在四天后。
  store.save({ name:manualName, amount:30, currency:'CNY', cycleUnit:'month', cycleCount:1, startDate:'2026-08-20', category:'域名', provider:'Made-up Registrar', paymentMethod:'支付宝', autoRenew:false, renewedThrough:'2026-10-20', color:'#1971c2' });
  // 自动续费、月付 ¥25：7/10 到 11/10 已扣五期。
  store.save({ name:autoName, amount:25, currency:'CNY', cycleUnit:'month', cycleCount:1, startDate:'2026-07-10', category:'VPS', provider:'Made-up Host', paymentMethod:'支付宝', autoRenew:true, color:'#0f9d8a' });
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, timezoneId:'Asia/Shanghai', locale:'zh-CN' });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', '2026-11-16'); } catch (_) {} });
    const page = await context.newPage();
    await page.clock.setFixedTime(now);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
    await page.route('**/*', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:1, data:{ orders:[], customers:{}, trashOrders:[], deletedOrders:[], demoCleared:true, demoCustomersCleared:true } } });
      if (pathname.startsWith('/api/subscriptions')) {
        try {
          const body = request.postData() ? JSON.parse(request.postData()) : {};
          const item = body.item && typeof body.item === 'object' ? { ...body.item, ...(typeof body.baseUpdatedAt === 'string' ? { baseUpdatedAt:body.baseUpdatedAt } : {}) } : body.item;
          const result = pathname === '/api/subscriptions' ? store.list()
            : pathname === '/api/subscriptions/save' ? store.save(item)
            : pathname === '/api/subscriptions/options' ? store.setOptions(body) : store.setRate(body);
          return route.fulfill({ json:result });
        } catch (error) {
          return route.fulfill({ status:error.status || 500, json:{ ok:false, message:error.message } });
        }
      }
      return route.fulfill({ json:{ ok:true } });
    });
    await page.goto('http://127.0.0.1:47997/trade-order-system.html#subscriptions');
    await page.waitForFunction(() => subscriptionState.loaded && subscriptionState.items.length === 2);
    await page.locator('#subsList .subs-row').first().waitFor();
    await h.quiet(page);

    const row = name => page.locator('#subsList .subs-row', { hasText:name });
    const click = locator => h.click(page, locator, String(locator));
    const record = name => store.list().items.find(item => item.name === name);
    // Everything the page says about one item's money: 累计 and 已扣费 N 次, every period, the analysis cards.
    const numbers = name => page.evaluate(name => {
      const today = subscriptionLocalDate();
      const rate = subscriptionState.usdCnyRate;
      const item = subscriptionState.items.find(entry => entry.name === name);
      const schedule = subscriptionSchedule(item, today, rate);
      const { periods } = subscriptionPeriods(item, today, schedule);
      const a = subscriptionAnalysis([item], today, rate);
      return {
        spent:schedule.spent, charges:schedule.charges, renewsOn:schedule.renewsOn,
        periods:periods.map(period => `${period.index}|${period.date}|${period.amount}|${period.past ? 'paid' : period.due ? 'due' : 'future'}`),
        cards:{ monthPaid:a.monthPaid, monthDue:a.monthDue, yearPaid:a.yearPaid, yearCount:a.yearCount, next12:a.next12, lifetime:a.lifetime },
        months:a.months.map(month => `${month.key}|${month.total}|${month.paid}`)
      };
    }, name);
    const closeDrawer = async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('subscriptionDrawer').classList.contains('open'));
    };
    // 编辑 → 换一种付款方式 → 保存 → 「从下一期起」。
    const changePaymentFromNext = async name => {
      await click(row(name).locator('[data-sub-edit]'));
      await page.locator('#subscriptionEditModal.open').waitFor();
      await h.settle(page, '#subscriptionEditModal .subs-modal');
      await click(page.locator('#subscriptionEditForm [data-sub-opts="payment"] [data-opt-value="微信支付"]'));
      await page.waitForFunction(() => document.querySelector('#subscriptionEditForm [data-sub-opts="payment"] [data-opt-value="微信支付"]')?.getAttribute('aria-pressed') === 'true');
      await click(page.locator('#subscriptionSaveBtn'));
      await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      await h.settle(page, '#confirmModal .modal');
      const choices = await confirmChoices(page);
      assert.deepEqual([choices.labels, choices.checked, choices.ok], [['从下一期起', '更正全部历史'], 0, '从下一期起生效'], `${name}: the from-next choice`);
      await click(page.locator('#confirmOkBtn'));
      await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
      await h.waitToast(page, `${name} 已保存`);
    };

    // ---- 1. Manual renewal: 3 periods paid, 累计 90 ----
    const start = await numbers(manualName);
    assert.equal(start.spent, 90);
    assert.equal(start.charges, 3);

    // ---- 2. 「已续费」 four days early: 11/20 is paid, 累计 120 ----
    await click(row(manualName));
    await page.locator('#subscriptionDrawer.open [data-sub-action="renewed"]').waitFor();
    await click(page.locator('#subscriptionDrawer [data-sub-action="renewed"]'));
    await h.waitToast(page, `${manualName} 已续费`);
    assert.equal(record(manualName).renewedThrough, '2026-11-20');
    const renewed = await numbers(manualName);
    assert.equal(renewed.spent, 120, 'renewing early pays the next period at once');
    assert.equal(renewed.charges, 4);
    assert.equal(renewed.renewsOn, '2026-12-20');
    assert.ok(renewed.periods.includes('3|2026-11-20|30|paid'), `the early-renewed period is paid: ${renewed.periods}`);
    assert.deepEqual(renewed.cards, { monthPaid:30, monthDue:0, yearPaid:120, yearCount:4, next12:330, lifetime:120 });
    await closeDrawer();

    // ---- 3. Payment method changed from the next period on: 11/20 now sits under the earlier settings ----
    await changePaymentFromNext(manualName);
    const split = record(manualName);
    assert.equal(split.startDate, '2026-12-20', 'the new settings start at the first unpaid period');
    assert.deepEqual(split.terms.map(term => [term.startDate, term.until, term.paymentMethod]), [['2026-08-20', '2026-12-20', '支付宝']]);
    assert.equal(split.paymentMethod, '微信支付');
    const after = await numbers(manualName);
    assert.equal(after.spent, 120, '累计已付 keeps the early-renewed period');
    assert.equal(after.charges, 4, '已扣费 4 次');
    assert.deepEqual(after.periods, renewed.periods, 'the drawer lists the same periods, the early-renewed one 已发生');
    assert.deepEqual(after.cards, renewed.cards, 'the analysis cards do not count the early-renewed period as 本月待扣 or upcoming');
    assert.deepEqual(after.months, renewed.months, 'every month of the chart is the same');
    // What the drawer shows.
    await click(row(manualName));
    await page.locator('#subscriptionDrawer.open .subs-per').first().waitFor();
    const period = page.locator('#subscriptionDrawer .subs-per[data-period="2026-11-20"]');
    assert.equal(await period.count(), 1, 'the early-renewed period is still in 周期费用');
    assert.match(await period.getAttribute('class'), /\bpast\b/);
    assert.equal(await period.locator('.subs-pill').innerText(), '已发生');
    assert.match(await page.locator('#subscriptionDrawer .subs-card').nth(2).innerText(), /¥120\.00[\s\S]*已扣费 4 次/);
    await closeDrawer();
    // The calendar still writes the payment method it was paid with, not 「需要手动续费」.
    const calendar = await page.evaluate(() => calendarEventsInRange('2026-11-20', '2026-11-20').filter(event => event.type === 'subscription').map(event => event.sub));
    assert.equal(calendar.length, 1);
    assert.match(calendar[0], /支付宝/);
    assert.doesNotMatch(calendar[0], /需要手动续费/);

    // ---- 4. Auto renewal through the same path: nothing changes by a cent ----
    const autoBefore = await numbers(autoName);
    assert.equal(autoBefore.spent, 125);
    assert.equal(autoBefore.renewsOn, '2026-12-10');
    await changePaymentFromNext(autoName);
    assert.deepEqual(record(autoName).terms.map(term => [term.startDate, term.until]), [['2026-07-10', '2026-12-10']]);
    assert.deepEqual(await numbers(autoName), autoBefore, 'an auto renewal split from the next period keeps every number');

    // ---- 5. A month later the numbers are where they would have been anyway ----
    await page.clock.setFixedTime(new Date('2026-12-21T10:00:00+08:00'));
    const later = await numbers(manualName);
    assert.equal(later.spent, 120, 'the 12/20 period is not renewed yet: still four periods');
    assert.ok(later.periods.includes('4|2026-12-20|30|due'), `12/20 is due: ${later.periods}`);
    assert.equal((await numbers(autoName)).spent, 150, 'the auto renewal charged 12/10 under the new settings');

    assert.deepEqual(errors, []);
    console.log('Subscription early renewal + from-next split passed: a manual renewal renewed early and then changed from the next period keeps 累计 120, its early period (已发生) and the analysis cards; an auto renewal split the same way changes nothing.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
