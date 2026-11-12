#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { html, extractFunction } = require('./helpers/page-source');

const context = vm.createContext({});
vm.runInContext(html.match(/const subscriptionRemindDays = [^;]+;/)[0].replace('const ', 'var '), context);
[
  'subscriptionLocalDate', 'subscriptionDayNumber', 'subscriptionDateFromDay', 'subscriptionAddMonths',
  'subscriptionCycle', 'subscriptionChargeDate', 'subscriptionCycleEvery', 'subscriptionCycleLabel', 'subscriptionChargeIndex', 'subscriptionSchedule', 'subscriptionSummary', 'subscriptionCompare', 'subscriptionWhen', 'subscriptionRemindWindow',
  'subscriptionInitial', 'subscriptionDayAfter', 'subscriptionPriceChanges', 'subscriptionPriceAt', 'subscriptionToCny', 'subscriptionStopBound', 'subscriptionCharges',
  'subscriptionMonthShift', 'subscriptionMonthEnd', 'subscriptionStopPreset', 'subscriptionWithPrice',
  'subscriptionPricer', 'subscriptionTerms', 'subscriptionFirstStart', 'subscriptionManualTracked', 'subscriptionTermTotals', 'subscriptionTermOffset',
  'subscriptionDefaultRemindWindow', 'subscriptionWhenDate'
].forEach(name => vm.runInContext(extractFunction(name), context));
const call = (name, ...args) => context[name](...args);
const item = overrides => ({
  id:'sub-test-1', name:'Test', note:'', amount:10, currency:'CNY', cycleMonths:1, startDate:'2026-01-31',
  category:'其他', color:'#7747ff', status:'active', endsOn:'', ...overrides
});

// Month-end starts clamp to the end of shorter months and return to the original day afterwards.
assert.equal(call('subscriptionAddMonths', '2026-01-31', 1), '2026-02-28');
assert.equal(call('subscriptionAddMonths', '2026-01-31', 2), '2026-03-31');
assert.equal(call('subscriptionAddMonths', '2024-01-31', 1), '2024-02-29');
assert.equal(call('subscriptionAddMonths', '2024-02-29', 12), '2025-02-28');
assert.equal(call('subscriptionAddMonths', '2024-02-29', 48), '2028-02-29');
assert.equal(call('subscriptionAddMonths', '2026-11-30', 3), '2027-02-28');

const monthEnd = call('subscriptionSchedule', item({}), '2026-03-01', 7.1);
assert.equal(monthEnd.nextCharge, '2026-03-31', 'Jan 31 monthly must not jump to Mar 3');
assert.equal(monthEnd.charges, 2, 'Jan 31 and Feb 28 were charged');
const leap = call('subscriptionSchedule', item({ startDate:'2024-02-29', cycleMonths:12, amount:120 }), '2026-03-01', 7.1);
assert.equal(leap.nextCharge, '2027-02-28');
assert.equal(leap.charges, 3, 'Feb 29 2024, Feb 28 2025 and Feb 28 2026');
assert.equal(leap.monthlyCny, 10, 'yearly amounts are averaged per month');
assert.equal(leap.yearlyCny, 120);

const today = call('subscriptionSchedule', item({ startDate:'2026-01-18' }), '2026-03-18', 7.1);
assert.equal(today.nextCharge, '2026-03-18', 'a charge due today is the next charge');
assert.equal(today.daysLeft, 0);
assert.equal(today.paidThrough, '2026-04-18', 'paying today covers the subscription until the following charge');
assert.equal(today.charges, 3, 'today’s charge counts as spent');
assert.deepEqual({ ...call('subscriptionWhen', today) }, { cls:'red solid', text:'今天扣费' });

assert.deepEqual({ ...call('subscriptionWhen', call('subscriptionSchedule', item({ startDate:'2026-01-25' }), '2026-03-18', 7.1)) }, { cls:'amber', text:'7天后扣费' });
assert.deepEqual({ ...call('subscriptionWhen', call('subscriptionSchedule', item({ startDate:'2026-01-26' }), '2026-03-18', 7.1)) }, { cls:'line', text:'8天后扣费' });
assert.deepEqual({ ...call('subscriptionWhen', call('subscriptionSchedule', item({ startDate:'2026-01-21' }), '2026-03-18', 7.1)) }, { cls:'red', text:'3天后扣费' });
// Manual renewals (most domains) count down to expiry and turn amber 30 days ahead.
const manual = item({ startDate:'2025-04-10', cycleMonths:12, autoRenew:false });
assert.deepEqual({ ...call('subscriptionWhen', call('subscriptionSchedule', manual, '2026-03-18', 7.1), manual) }, { cls:'amber', text:'23天后到期' });
assert.deepEqual({ ...call('subscriptionWhen', call('subscriptionSchedule', manual, '2026-03-09', 7.1), manual) }, { cls:'line', text:'32天后到期' });
assert.deepEqual({ ...call('subscriptionWhen', call('subscriptionSchedule', manual, '2026-04-09', 7.1), manual) }, { cls:'red', text:'明天到期' });

const future = call('subscriptionSchedule', item({ startDate:'2026-04-02' }), '2026-03-18', 7.1);
assert.equal(future.nextCharge, '2026-04-02', 'a future start is the first charge');
assert.equal(future.charges, 0);

// The 1Password screenshot: yearly from 2022-05-18, viewed on 2026-03-18.
const onePassword = item({ name:'1Password', amount:35.88, currency:'USD', cycleMonths:12, startDate:'2022-05-18' });
const shot = call('subscriptionSchedule', onePassword, '2026-03-18', 7.1);
assert.equal(shot.nextCharge, '2026-05-18');
assert.equal(shot.paidThrough, '2026-05-18');
assert.equal(shot.charges, 4);
assert.equal(shot.daysLeft, 61);
assert.equal(Math.round(shot.cycleCny * 100) / 100, 254.75, 'USD is converted with the page rate');
assert.equal(Math.round(shot.spentCny * 100) / 100, 1018.99);

// Custom cycles: every N days, weeks (stored as days), quarters and multi-year.
const weekly = call('subscriptionSchedule', item({ cycleUnit:'day', cycleCount:7, startDate:'2026-03-01', amount:7 }), '2026-03-18', 7.1);
assert.equal(weekly.nextCharge, '2026-03-22');
assert.equal(weekly.charges, 3, 'Mar 1, 8 and 15');
assert.equal(weekly.paidThrough, '2026-03-22');
assert.equal(Math.round(weekly.monthlyCny * 100) / 100, 30.42, 'a weekly price is averaged over 365/12 days');
const quarterly = call('subscriptionSchedule', item({ cycleUnit:'month', cycleCount:3, startDate:'2025-11-30', amount:90 }), '2026-03-18', 7.1);
assert.equal(quarterly.nextCharge, '2026-05-30');
assert.equal(quarterly.charges, 2, 'Nov 30 and Feb 28');
assert.equal(quarterly.monthlyCny, 30);
const legacyYearly = call('subscriptionSchedule', item({ cycleMonths:12, startDate:'2025-04-01', amount:120 }), '2026-03-18', 7.1);
assert.equal(legacyYearly.nextCharge, '2026-04-01', 'records with only cycleMonths still work');
const label = (cycleUnit, cycleCount) => [call('subscriptionCycleLabel', { cycleUnit, cycleCount }), call('subscriptionCycleEvery', { cycleUnit, cycleCount })].join('/');
assert.equal(label('day', 7), '周付/每周');
assert.equal(label('day', 14), '每2周/每2周');
assert.equal(label('day', 10), '每10天/每10天');
assert.equal(label('month', 1), '月付/每月');
assert.equal(label('month', 3), '季付/每季度');
assert.equal(label('month', 6), '半年付/每半年');
assert.equal(label('month', 12), '年付/每年');
assert.equal(label('month', 24), '每2年/每2年');
assert.equal(label('month', 2), '每2个月/每2个月');
assert.equal(call('subscriptionCycleLabel', { cycleMonths:12 }), '年付');
const weeklyWindow = call('subscriptionSummary', [item({ id:'w', cycleUnit:'day', cycleCount:7, startDate:'2026-03-01' })], '2026-03-18', 7);
assert.deepEqual(Array.from(weeklyWindow.upcoming, entry => entry.date), ['2026-03-22', '2026-03-29', '2026-04-05', '2026-04-12'], 'weekly charges inside the 30-day window');

// Cancelling keeps the subscription until the end date, then it expires and stops counting charges.
const cancelled = { ...onePassword, status:'cancelled', endsOn:'2026-05-18' };
const ending = call('subscriptionSchedule', cancelled, '2026-03-18', 7.1);
assert.equal(ending.state, 'ending');
assert.equal(ending.nextCharge, '', 'cancelled subscriptions are never charged again');
assert.equal(ending.daysLeft, 61);
assert.deepEqual({ ...call('subscriptionWhen', ending) }, { cls:'amber', text:'61天后到期' });
const expired = call('subscriptionSchedule', cancelled, '2026-05-18', 7.1);
assert.equal(expired.state, 'expired', 'a cancelled subscription expires on its end date');
assert.equal(expired.charges, 4, 'no charge is counted on or after the end date');
const longAfter = call('subscriptionSchedule', cancelled, '2030-01-01', 7.1);
assert.equal(longAfter.charges, 4);

// Per-period prices: past periods keep what they cost, future ones follow the last price.
const raised = item({ startDate:'2026-01-05', amount:10, priceChanges:[{ from:'2026-04-05', amount:15, once:false }, { from:'2026-02-05', amount:12, once:true }] });
const raisedNow = call('subscriptionSchedule', raised, '2026-03-18', 7.1);
assert.equal(raisedNow.charges, 3, 'Jan 5, Feb 5, Mar 5');
assert.equal(raisedNow.spent, 10 + 12 + 10, 'the one-off Feb override counts only for February');
assert.equal(raisedNow.cycleAmount, 15, 'the next charge (Apr 5) is at the raised price');
assert.equal(raisedNow.monthlyCny, 15);
assert.deepEqual(Array.from(call('subscriptionCharges', raised, '2026-01-01', '2026-06-30', 7.1), charge => charge.amount), [10, 12, 10, 15, 15, 15]);

// A planned stop counts charges up to and including its date, then nothing.
const stopping = item({ startDate:'2026-01-05', stopOn:'2026-04-30' });
const beforeStop = call('subscriptionSchedule', stopping, '2026-03-18', 7.1);
assert.equal(beforeStop.state, 'active', 'charges remain before the stop');
assert.equal(beforeStop.nextCharge, '2026-04-05');
assert.deepEqual(Array.from(call('subscriptionCharges', stopping, '2026-01-01', '2026-12-31', 7.1), charge => charge.date), ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']);
const afterLast = call('subscriptionSchedule', stopping, '2026-04-10', 7.1);
assert.equal(afterLast.state, 'ending', 'no charge left before the stop date');
assert.equal(afterLast.stopReason, 'planned');
assert.equal(afterLast.paidThrough, '2026-04-30');
assert.equal(afterLast.daysLeft, 20);
assert.equal(call('subscriptionSchedule', stopping, '2026-05-01', 7.1).state, 'expired');
assert.equal(call('subscriptionSchedule', stopping, '2027-01-01', 7.1).charges, 4);
const stoppingSummary = call('subscriptionSummary', [stopping], '2026-04-10', 7);
assert.equal(stoppingSummary.active, 0, 'an item with nothing left to charge leaves the monthly total');
assert.equal(call('subscriptionStopPreset', 'this', '2026-11-02'), '2026-11-30');
assert.equal(call('subscriptionStopPreset', 'next', '2026-11-02'), '2026-12-31');
assert.equal(call('subscriptionStopPreset', 'next', '2026-12-15'), '2027-01-31');

// Editing a period's price: once, from that period on, or back to the original.
const realLocalDate = context.subscriptionLocalDate;
context.subscriptionLocalDate = () => '2026-03-18';
const base = item({ startDate:'2026-01-05', amount:10, priceChanges:[] });
const once = call('subscriptionWithPrice', base, '2026-02-05', 11, 'once');
assert.deepEqual(JSON.parse(JSON.stringify(once.priceChanges)), [{ from:'2026-02-05', amount:11, once:true }]);
const onward = call('subscriptionWithPrice', once, '2026-05-05', 20, 'onward');
assert.deepEqual(Array.from(call('subscriptionCharges', onward, '2026-01-01', '2026-06-30', 7.1), charge => charge.amount), [10, 11, 10, 10, 20, 20]);
const earlier = call('subscriptionWithPrice', onward, '2026-04-05', 18, 'onward');
assert.deepEqual(Array.from(call('subscriptionCharges', earlier, '2026-01-01', '2026-06-30', 7.1), charge => charge.amount), [10, 11, 10, 18, 18, 18], 'a new rise replaces later ones');
const first = call('subscriptionWithPrice', base, '2026-01-05', 9, 'onward');
assert.equal(first.amount, 9, 'changing the first period from then on changes the base price');
assert.deepEqual(Array.from(first.priceChanges), []);
const reset = call('subscriptionWithPrice', once, '2026-02-05', 0, 'reset');
assert.deepEqual(Array.from(reset.priceChanges), []);
assert.deepEqual(Array.from(call('subscriptionWithPrice', base, '2026-02-05', 10, 'once').priceChanges), [], 'same price adds nothing');
context.subscriptionLocalDate = realLocalDate;

// The local calendar day decides “today”, not the UTC day.
const previousTz = process.env.TZ;
process.env.TZ = 'Asia/Shanghai';
assert.equal(call('subscriptionLocalDate', new Date('2026-03-17T23:00:00Z')), '2026-03-18', '7am in UTC+8 is already the 18th');
process.env.TZ = previousTz;

const summary = call('subscriptionSummary', [
  item({ id:'a', amount:20, currency:'USD', startDate:'2026-02-20' }),
  item({ id:'b', amount:120, cycleMonths:12, startDate:'2025-04-01' }),
  item({ id:'c', amount:50, startDate:'2026-02-01', status:'cancelled', endsOn:'2026-04-01' }),
  item({ id:'d', amount:30, startDate:'2026-02-18' })
], '2026-03-18', 7);
assert.equal(summary.total, 4);
assert.equal(summary.active, 3);
assert.equal(summary.cancelled, 1, 'cancelled subscriptions are counted separately and not in the monthly total');
assert.equal(summary.dueSoon, 2, 'charges today and in 2 days are within 7 days; April 1 is not');
assert.equal(summary.monthlyCny, 140 + 10 + 30);
assert.equal(summary.yearlyCny, 180 * 12);
assert.deepEqual(Array.from(summary.upcoming, entry => `${entry.item.id}:${entry.date}`), ['d:2026-03-18', 'a:2026-03-20', 'b:2026-04-01'],
  'the 30-day window includes today and ends before the April 18 repeat');
assert.equal(summary.upcomingCny, 30 + 140 + 120);
const february = call('subscriptionSummary', [item({ id:'f', startDate:'2026-01-01' })], '2026-02-01', 7);
assert.deepEqual(Array.from(february.upcoming, entry => entry.date), ['2026-02-01', '2026-03-01'], 'a short month can hold two monthly charges');
const lastDay = call('subscriptionSummary', [item({ id:'g', startDate:'2026-03-02' })], '2026-02-01', 7);
assert.deepEqual(Array.from(lastDay.upcoming, entry => entry.date), ['2026-03-02'], 'day 29 of the window is still included');

const rows = [
  item({ id:'expired-old', name:'B', status:'cancelled', endsOn:'2026-01-31', startDate:'2025-12-31' }),
  item({ id:'ending', name:'C', status:'cancelled', endsOn:'2026-03-31' }),
  item({ id:'late', name:'D', startDate:'2026-02-28' }),
  item({ id:'soon', name:'E', startDate:'2026-02-20' }),
  item({ id:'expired-new', name:'A', status:'cancelled', endsOn:'2026-02-28', startDate:'2026-01-28' })
].map(entry => ({ item:entry, schedule:call('subscriptionSchedule', entry, '2026-03-18', 7.1) }));
assert.deepEqual(rows.sort(context.subscriptionCompare).map(row => row.item.id), ['soon', 'late', 'ending', 'expired-new', 'expired-old'],
  'active by next charge, then ending, then most recently expired');

// Icon initials follow the prototype: two Latin characters, one Chinese character.
assert.equal(call('subscriptionInitial', 'ChatGPT Plus'), 'Ch');
assert.equal(call('subscriptionInitial', '1Password'), '1P');
assert.equal(call('subscriptionInitial', '阿里云域名'), '阿');
assert.equal(call('subscriptionInitial', 'iCloud+'), 'iC');
assert.equal(call('subscriptionInitial', ' + '), '·');

// History keeps the settings of its time: $10 monthly from Jan 5, then (from Apr 5 on) ¥200 every 3 months.
const switched = item({
  startDate:'2026-04-05', amount:200, currency:'CNY', cycleUnit:'month', cycleCount:3, cycleMonths:undefined,
  terms:[{ startDate:'2026-01-05', until:'2026-04-05', amount:10, currency:'USD', cycleUnit:'month', cycleCount:1, priceChanges:[{ from:'2026-03-05', amount:12, once:true }], paymentMethod:'PayPal', category:'AI' }]
});
const switchedCharges = Array.from(call('subscriptionCharges', switched, '2026-01-01', '2026-12-31', 7, { today:'2026-11-08' }), charge => `${charge.date}:${charge.amount}${charge.currency}#${charge.index}`);
assert.deepEqual(switchedCharges, ['2026-01-05:10USD#0', '2026-02-05:10USD#1', '2026-03-05:12USD#2', '2026-04-05:200CNY#3', '2026-07-05:200CNY#4', '2026-10-05:200CNY#5'],
  'old charges keep their price, cycle and currency; numbering runs on');
const switchedNow = call('subscriptionSchedule', switched, '2026-11-08', 7);
assert.equal(switchedNow.charges, 6);
assert.equal(switchedNow.spentCny, 32 * 7 + 600, 'spent adds the earlier settings at the page rate');
assert.equal(switchedNow.mixedCurrency, true);
assert.equal(switchedNow.nextCharge, '2027-01-05');
assert.equal(call('subscriptionTermOffset', switched), 3);
assert.equal(call('subscriptionFirstStart', switched), '2026-01-05');
assert.equal(call('subscriptionTermTotals', switched, '2026-02-10', 7).charges, 2, 'only charges up to today count');

// Manual renewals with a confirmed date: a due date that passes without 「已续费」 is overdue, not paid.
const domain = item({ startDate:'2025-04-10', cycleMonths:12, amount:60, autoRenew:false, renewedThrough:'2025-04-10' });
const due = call('subscriptionSchedule', domain, '2026-04-20', 7);
assert.equal(due.overdue, true);
assert.equal(due.nextCharge, '2026-04-10');
assert.equal(due.daysLeft, -10);
assert.equal(due.charges, 1, 'the unconfirmed renewal is not counted as spent');
assert.deepEqual({ ...call('subscriptionWhen', due, domain) }, { cls:'red solid', text:'已过期 10 天' });
assert.deepEqual(Array.from(call('subscriptionCharges', domain, '2025-01-01', '2027-12-31', 7, { today:'2026-04-20' }), charge => charge.date), ['2025-04-10', '2027-04-10'],
  'history leaves the unconfirmed renewal out; the next year is still projected');
assert.deepEqual(Array.from(call('subscriptionCharges', domain, '2025-01-01', '2026-12-31', 7, { today:'2026-04-20', unpaid:true }), charge => charge.date), ['2025-04-10', '2026-04-10']);
const renewed = call('subscriptionSchedule', { ...domain, renewedThrough:'2026-04-10' }, '2026-04-20', 7);
assert.deepEqual([renewed.overdue, renewed.nextCharge, renewed.charges], [false, '2027-04-10', 2], '「已续费」 moves on to the next year');
const legacyManual = call('subscriptionSchedule', { ...domain, renewedThrough:'' }, '2026-04-20', 7);
assert.equal(legacyManual.overdue, false, 'records without the date keep the old behaviour');

// Reminder windows: default per renewal kind, capped at a quarter of the cycle; the item's own choice wins.
assert.equal(call('subscriptionRemindWindow', item({ cycleMonths:12, autoRenew:false })), 30);
assert.equal(call('subscriptionRemindWindow', item({ cycleMonths:1, autoRenew:false })), 7, 'a monthly manual renewal is not reminded every day');
assert.equal(call('subscriptionRemindWindow', item({ cycleUnit:'day', cycleCount:1 })), -1, 'daily charges are not reminded');
assert.equal(call('subscriptionRemindWindow', item({ cycleMonths:12, extra:{ remindDays:60 } })), 60);
assert.equal(call('subscriptionRemindWindow', item({ cycleMonths:12, extra:{ remindDays:-1 } })), -1);
assert.deepEqual({ ...call('subscriptionWhen', call('subscriptionSchedule', item({ cycleUnit:'day', cycleCount:1, startDate:'2026-01-01' }), '2026-03-18', 7), item({ cycleUnit:'day', cycleCount:1 })) }, { cls:'line', text:'每天扣费' });
// A planned stop reads 停止, and the countdown pill carries its date.
const plannedStop = call('subscriptionSchedule', stopping, '2026-04-10', 7.1);
assert.deepEqual({ ...call('subscriptionWhen', plannedStop, stopping) }, { cls:'amber', text:'20天后停止' });
context.subscriptionLocalDate = () => '2026-04-10';
assert.equal(call('subscriptionWhenDate', plannedStop), '04-30');
assert.equal(call('subscriptionWhenDate', { nextCharge:'2027-01-05' }), '2027-01-05');
context.subscriptionLocalDate = realLocalDate;

console.log('Subscription schedule test passed: custom day/month cycles, month ends, leap years, today, cancellation, local date, 30-day window, status pills, initials, ordering, earlier settings, manual renewal confirmation and reminder windows.');
