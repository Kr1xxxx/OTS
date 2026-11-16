#!/usr/bin/env node
// 续费「这一笔付没付」只算一处（subscriptionChargeState）：同一笔扣费在列表（付到哪天）、详情各期的标签、日历小字、
// 改价格弹窗的副标题、铃铛里说的是同一个状态。四种续费项：自动续费、手动没确认（过期）、手动确认到本期、手动提前续好。
// 以前这几处各自比日期，#128 只改了其中三处，日历把续过的写成「需要手动续费」，改价格把提前续好的当「未来」。
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSubscriptionStore } = require('../mac-app/subscription-store');
const { launchBrowser } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

const today = '2026-11-16';
const now = new Date(`${today}T10:00:00+08:00`);
const rows = [
  { name:'auto.test', item:{ amount:60, cycleUnit:'month', cycleCount:12, startDate:'2025-11-21', autoRenew:true }, charges:{ '2025-11-21':'paid', '2026-11-21':'future' } },
  { name:'manual-due.test', item:{ amount:70, cycleUnit:'month', cycleCount:12, startDate:'2025-11-10', autoRenew:false, renewedThrough:'2025-11-10' }, charges:{ '2025-11-10':'paid', '2026-11-10':'due' } },
  { name:'manual-today.test', item:{ amount:30, cycleUnit:'month', cycleCount:1, startDate:'2026-08-06', autoRenew:false, renewedThrough:'2026-11-06' }, charges:{ '2026-10-06':'paid', '2026-11-06':'paid', '2026-12-06':'future' } },
  { name:'manual-early.test', item:{ amount:89, cycleUnit:'month', cycleCount:12, startDate:'2025-11-21', autoRenew:false, renewedThrough:'2026-11-21' }, charges:{ '2026-11-21':'paid', '2027-11-21':'future' } }
];

(async () => {
  const store = createSubscriptionStore(new DatabaseSync(':memory:'));
  rows.forEach(row => store.save({ name:row.name, currency:'CNY', category:'域名', provider:'Made-up', paymentMethod:'支付宝', color:'#1971c2', ...row.item }));
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, timezoneId:'Asia/Shanghai', locale:'zh-CN' });
    const page = await context.newPage();
    await page.clock.setFixedTime(now);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:1, data:{ orders:[], customers:{}, demoCleared:true, demoCustomersCleared:true } } });
      if (pathname === '/api/subscriptions') return route.fulfill({ json:store.list() });
      return route.fulfill({ json:{ ok:true } });
    });
    await page.goto('http://127.0.0.1:47998/trade-order-system.html#subscriptions');
    await page.waitForFunction(() => subscriptionState.loaded && subscriptionState.items.length === 4);

    for (const row of rows) {
      for (const [date, expected] of Object.entries(row.charges)) {
        const seen = await page.evaluate(([name, date]) => {
          const today = subscriptionLocalDate();
          const item = subscriptionState.items.find(entry => entry.name === name);
          const schedule = subscriptionSchedule(item, today, subscriptionState.usdCnyRate);
          const period = subscriptionPeriods(item, today, schedule).periods.find(entry => entry.date === date);
          const calendar = calendarEventsInRange(date, date).find(event => event.subId === item.id);
          subscriptionDetailId = item.id;
          openSubscriptionPriceEditor(date);
          const priceSub = document.getElementById('subscriptionPriceSub').textContent;
          setModalOpenState('subscriptionPriceModal', false);
          subscriptionDetailId = '';
          return {
            state:subscriptionChargeState(item, date, today),
            period:period ? (period.due ? 'due' : period.past ? 'paid' : 'future') : 'missing',
            paidThrough:schedule.paidThrough,
            calendar:calendar ? calendar.sub : 'missing',
            priceSub,
            reminded:subscriptionReminders(today).some(reminder => reminder.title === name),
            manual:item.autoRenew === false
          };
        }, [row.name, date]);
        const where = `${row.name} ${date}`;
        assert.equal(seen.state, expected, `${where}: subscriptionChargeState`);
        assert.equal(seen.period, expected, `${where}: the drawer's period tag`);
        assert.equal(date < seen.paidThrough, expected === 'paid', `${where}: paid through ${seen.paidThrough}`);
        assert.notEqual(seen.calendar, 'missing', `${where}: on the calendar`);
        assert.equal(/需要手动续费/.test(seen.calendar), seen.manual && expected !== 'paid', `${where}: calendar says ${seen.calendar}`);
        if (!seen.manual || expected === 'paid') assert.match(seen.calendar, /支付宝/, `${where}: calendar shows the payment method`);
        assert.equal(/已发生$/.test(seen.priceSub), expected !== 'future', `${where}: price editor says ${seen.priceSub}`);
        if (expected === 'due') assert.equal(seen.reminded, true, `${where}: the bell reminds a due renewal`);
      }
    }
    // 改价：提前续好的那一期记下的实际价格，和日期已过的一样留着（在更早一期选「这一期和之后每一期」时）。
    const priced = await page.evaluate(() => {
      const today = subscriptionLocalDate();
      const base = subscriptionState.items.find(entry => entry.name === 'manual-today.test');
      let item = { ...base, amount:30, cycleCount:1, startDate:'2026-09-21', renewedThrough:'2026-11-21', priceChanges:[] };
      item = subscriptionWithPrice(item, '2026-10-21', 20, 'once');
      item = subscriptionWithPrice(item, '2026-11-21', 25, 'once');
      item = subscriptionWithPrice(item, '2026-09-21', 40, 'onward');
      const schedule = subscriptionSchedule(item, today, subscriptionState.usdCnyRate);
      return { amounts:subscriptionPeriods(item, today, schedule).periods.slice(0, 4).map(period => period.amount), spent:schedule.spent };
    });
    assert.deepEqual(priced.amounts, [40, 20, 25, 40], 'the early-renewed period keeps its recorded price');
    assert.equal(priced.spent, 85);
    // 数字卡：提前续好的那一笔算已付，不再算本月待扣和未来 12 个月。
    const cards = await page.evaluate(() => {
      const item = subscriptionState.items.find(entry => entry.name === 'manual-early.test');
      const a = subscriptionAnalysis([item], subscriptionLocalDate(), subscriptionState.usdCnyRate);
      return { monthPaid:a.monthPaid, monthDue:a.monthDue, yearPaid:a.yearPaid, next12:a.next12, lifetime:a.lifetime };
    });
    assert.deepEqual(cards, { monthPaid:89, monthDue:0, yearPaid:89, next12:0, lifetime:178 });
    // 提前续好之后改了付款方式（从下一期起）：续好的那一期归到历史设置下，日历照旧写当时的付款方式，不写「需要手动续费」。
    const afterChange = await page.evaluate(() => {
      const today = subscriptionLocalDate();
      const all = subscriptionState.items;
      const old = all.find(entry => entry.name === 'manual-early.test');
      const schedule = subscriptionSchedule(old, today, subscriptionState.usdCnyRate);
      const changed = subscriptionFromNext(old, { ...old, paymentMethod:'made-up card' }, false, schedule.renewsOn);
      subscriptionState.items = all.map(entry => entry === old ? changed : entry);
      const event = calendarEventsInRange('2026-11-21', '2026-11-21').find(entry => entry.subId === old.id);
      subscriptionState.items = all;
      return { terms:changed.terms.length, sub:event ? event.sub : 'missing' };
    });
    assert.equal(afterChange.terms, 1);
    assert.match(afterChange.sub, /支付宝/, `an early-renewed charge under earlier settings: calendar says ${afterChange.sub}`);
    assert.doesNotMatch(afterChange.sub, /需要手动续费/);
    assert.deepEqual(errors, []);
    console.log('Subscription charge state UI passed: auto, manual due, manual confirmed, manual renewed early agree across schedule, drawer periods, calendar, price editor and bell; an early-renewed charge keeps its recorded price and counts as paid on the stat cards.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
