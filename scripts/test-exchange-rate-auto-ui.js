#!/usr/bin/env node
// The current month's USD → RMB cell updates itself from /api/usd-cny-rate (the lower of
// 中国银行 and 工商银行, mac-app/usd-cny-rate.js), and nothing else in the table moves:
// - only the current month is written; past months, and months the user typed, stay as they are
// - a cell typed in the form becomes the user's; clearing it hands it back to the automatic rate
// - months before the table (before 2026-05) use the 2026-05 cell, also after saving the form
//   (bug review 2026-11-16 item 6: saving used to move every older order's RMB amount to the current month's rate)
// - the note on the current-month card says where the number came from; a failed fetch writes nothing and says so
// - nothing is written while the page is read-only; a new month starts with the newest rate, the old month stays
// The clock is fixed in the page (Asia/Shanghai); the rates are made up.
const assert = require('node:assert/strict');
const { launchBrowser, h } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

const at = text => new Date(`${text}+08:00`);

(async () => {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, timezoneId:'Asia/Shanghai' });
    await context.clock.setFixedTime(at('2026-11-16T11:00:00'));
    await context.addInitScript(() => {
      try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {}
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const order = { id:'o-old', num:'K1', client:'Alice', currency:'USD', amount:1000, paidAmount:1000, stage:'done', orderMonth:'2026-03', createdAt:'2026-03-10', updated:'2026-03-10 09:00', logs:[], shipments:[], attachments:[] };
    // Saved before the table updated itself: October and November typed back then, December typed ahead of time.
    const legacyRates = { '2026-05':6.9, '2026-10':7.0, '2026-11':7.11, '2026-12':7.2 };
    const store = {
      current:{ app:'trade-order-system', data:{ orders:[order], customers:{}, doneTasks:{}, demoCleared:true, demoCustomersCleared:true, exchangeSettings:{ fallbackRate:7.11, monthlyRates:legacyRates, source:'手动', lastStatus:'尚未联网更新' } }, revision:0 },
      saves:0
    };
    let rateAnswer = { status:200, json:{ ok:true, rate:6.6621, source:'boc', sourceLabel:'中国银行现汇买入价', publishedAt:'2026-11-16 10:30', fetchedAt:'2026-11-16T02:31:00.000Z', quotes:[{ source:'boc', sourceLabel:'中国银行现汇买入价', rate:6.6621 }, { source:'icbc', sourceLabel:'工商银行现汇买入价', rate:6.6702 }], failed:[] } };
    let rateRequests = 0;
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/usd-cny-rate') { rateRequests += 1; return route.fulfill({ status:rateAnswer.status, json:rateAnswer.json }); }
      let response = { ok:true };
      if (pathname === '/api/data') response = store.current;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:1 }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/ecb-rates') response = { ok:true, rates:[{ date:'2026-11-13', rates:{ EUR:1, USD:1.1, CNY:7.9 } }] };
      if (pathname === '/api/save') {
        const body = route.request().postDataJSON();
        store.current = { ...body.state, revision:store.current.revision + 1 };
        store.saves += 1;
        response = { ok:true, revision:store.current.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47996/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    const saved = () => store.current.data?.exchangeSettings || store.current.exchangeSettings;
    const settings = () => page.evaluate(() => JSON.parse(JSON.stringify(getExchangeSettings())));
    const note = () => page.evaluate(() => document.getElementById('exchangeRateNote').textContent);
    const refresh = () => page.evaluate(() => refreshAutoExchangeRate());
    const flush = () => page.evaluate(() => window.flushPendingSave?.());

    // 1. At start: November takes the Bank of China rate and is saved; nothing else moves.
    await page.waitForFunction(() => getExchangeSettings().monthlyRates['2026-11'] === 6.6621);
    await flush();
    let s = await settings();
    assert.equal(saved().monthlyRates['2026-11'], 6.6621, 'the new rate is saved to the database');
    assert.deepEqual(saved().auto, { month:'2026-11', rate:6.6621, source:'boc', sourceLabel:'中国银行现汇买入价', publishedAt:'2026-11-16 10:30', checkedAt:saved().auto.checkedAt, quotes:rateAnswer.json.quotes, failed:[] });
    assert.equal(s.monthlyRates['2026-10'], 7.0, 'a past month stays');
    assert.equal(s.monthlyRates['2026-12'], 7.2, 'a month typed ahead of time stays');
    assert.deepEqual(s.manualMonths, { '2026-12':true }, 'a later month that was typed before the update counts as typed');
    assert.equal(s.monthlyRates['2027-12'], 6.8);
    assert.ok(!('fallbackRate' in s) && !('lastStatus' in s), 'the unused keys are gone');
    assert.equal(await page.evaluate(() => exchangeMonths().at(-1)), '2027-12', 'the table runs to December of next year');
    assert.equal(await page.evaluate(() => exchangeRateForMonth('2026-03')), 6.9, 'before the table: the first cell (2026-05)');
    assert.equal(await page.evaluate(() => exchangeRateForMonth('2028-04')), 6.8, 'after the table: the last cell');
    assert.equal(await page.evaluate(() => Math.round(usdPaidTotalRmb(state.orders))), 6900);
    await page.evaluate(() => setPage('settings'));
    await page.locator('[data-settings-tab="exchange"]').click();
    assert.equal(await note(), '11月：6.6621 · 中国银行现汇买入价（工商银行 6.6702，两家取低的） · 11月16日 10:30 更新。');

    // 2. The same rate again on the same day: no extra save.
    const savesBefore = store.saves;
    await refresh();
    await flush();
    assert.equal(store.saves, savesBefore, 'an unchanged rate on the same day saves nothing');

    // 3. Typing November in the form makes it the user's: the next update leaves it alone.
    //    Saving the form does not move the RMB amount of an order from before the table (item 6).
    await page.fill('#exchangeRate-2026-11', '7.05');
    await page.evaluate(() => document.getElementById('exchangeSettingsForm').requestSubmit());
    await h.waitToast(page, '汇率设置已保存');
    s = await settings();
    assert.equal(s.monthlyRates['2026-11'], 7.05);
    assert.deepEqual(s.manualMonths, { '2026-11':true, '2026-12':true });
    assert.equal(s.monthlyRates['2026-10'], 7.0, 'saving the form keeps a past month');
    assert.equal(await page.evaluate(() => exchangeRateForMonth('2026-03')), 6.9, 'saving the form keeps the rate of months before the table');
    assert.equal(await page.evaluate(() => Math.round(usdPaidTotalRmb(state.orders))), 6900);
    rateAnswer = { status:200, json:{ ...rateAnswer.json, rate:6.7, publishedAt:'2026-11-16 15:30' } };
    await refresh();
    assert.equal((await settings()).monthlyRates['2026-11'], 7.05, 'a typed month is not updated');
    assert.match(await note(), /^11月：7\.05 · 你自己填的，不联网更新/);

    // 4. Clearing November hands it back: it takes the newest rate at once. Clearing a past month keeps its number.
    await page.fill('#exchangeRate-2026-11', '');
    await page.fill('#exchangeRate-2026-10', '');
    await page.evaluate(() => document.getElementById('exchangeSettingsForm').requestSubmit());
    await page.waitForFunction(() => getExchangeSettings().monthlyRates['2026-11'] === 6.7);
    s = await settings();
    assert.deepEqual(s.manualMonths, { '2026-12':true });
    assert.equal(s.monthlyRates['2026-10'], 7.0);
    assert.equal(await page.inputValue('#exchangeRate-2026-11'), '6.7', 'the form shows the automatic rate again');

    // 5. The note names both banks when both answered, and the bank that failed when one did.
    const bocQuote = { source:'boc', sourceLabel:'中国银行现汇买入价', rate:6.6621 };
    const icbcQuote = { source:'icbc', sourceLabel:'工商银行现汇买入价', rate:6.6525 };
    rateAnswer = { status:200, json:{ ok:true, ...icbcQuote, publishedAt:'2026-11-16 09:53', quotes:[bocQuote, icbcQuote], failed:[] } };
    await refresh();
    assert.equal((await settings()).monthlyRates['2026-11'], 6.6525);
    assert.match(await note(), /^11月：6\.6525 · 工商银行现汇买入价（中国银行 6\.6621，两家取低的） · 11月16日 09:53 更新。/);
    rateAnswer = { status:200, json:{ ok:true, ...bocQuote, rate:6.6611, publishedAt:'2026-11-16 10:30', quotes:[{ ...bocQuote, rate:6.6611 }], failed:['icbc'] } };
    await refresh();
    assert.equal((await settings()).monthlyRates['2026-11'], 6.6611);
    assert.match(await note(), /^11月：6\.6611 · 中国银行现汇买入价 · 11月16日 10:30 更新（工商银行今天没取到）。/);
    // A rate saved by V3.171–V3.173 from the CFETS central parity is still named as what it is.
    await page.evaluate(() => {
      state.exchangeSettings = { ...getExchangeSettings(), auto:{ ...getExchangeSettings().auto, source:'cfets', sourceLabel:'外汇交易中心中间价', quotes:[], failed:[] } };
      renderExchangeNote();
    });
    assert.match(await note(), /^11月：6\.6611 · 外汇交易中心中间价（参考价，比银行买入价高） · 11月16日 10:30 更新。/);

    // 6. Nothing to be had: the cell stays, the note says the last rate is kept.
    rateAnswer = { status:500, json:{ ok:false, message:'中国银行现汇买入价：没找到表头；工商银行现汇买入价：request timeout' } };
    await refresh();
    assert.equal((await settings()).monthlyRates['2026-11'], 6.6611);
    assert.match(await note(), /^11月：今天没取到汇率，沿用 11月16日 10:30 的 6\.6611（中国银行现汇买入价）。/);

    // 7. Read-only (another window saved first): nothing is written.
    await flush();
    await page.evaluate(() => macSetStorageMode('conflict'));
    rateAnswer = { status:200, json:{ ok:true, rate:6.65, source:'boc', sourceLabel:'中国银行现汇买入价', publishedAt:'2026-11-16 16:00' } };
    await refresh();
    assert.equal((await settings()).monthlyRates['2026-11'], 6.6611, 'no write while read-only');
    await page.evaluate(() => macSetStorageMode('ready'));
    await refresh();
    assert.equal((await settings()).monthlyRates['2026-11'], 6.65);

    // 8. A new month: November stays at its last rate; December was typed ahead, so it stays too until cleared.
    await flush();
    await context.clock.setFixedTime(at('2026-12-01T09:00:00'));
    await page.evaluate(() => checkMonthRollover());
    s = await settings();
    assert.equal(s.monthlyRates['2026-11'], 6.65, 'the month that ended keeps its last rate');
    assert.equal(s.monthlyRates['2026-12'], 7.2, 'a typed month is not updated when it comes');
    rateAnswer = { status:200, json:{ ok:true, rate:6.61, source:'boc', sourceLabel:'中国银行现汇买入价', publishedAt:'2026-12-01 08:30' } };
    await refresh();
    s = await settings();
    assert.equal(s.monthlyRates['2026-12'], 7.2);
    assert.equal(s.monthlyRates['2026-11'], 6.65, 'only the current month follows a new rate');
    await page.evaluate(() => render());
    await page.fill('#exchangeRate-2026-12', '');
    await page.evaluate(() => document.getElementById('exchangeSettingsForm').requestSubmit());
    await page.waitForFunction(() => getExchangeSettings().monthlyRates['2026-12'] === 6.61);
    assert.equal((await settings()).monthlyRates['2026-11'], 6.65);
    assert.match(await note(), /^12月：6\.61 · 中国银行现汇买入价 · 12月1日 08:30 更新。/);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#toast .toast-item').length && [...document.querySelectorAll('#toast .toast-item')].some(el => el.textContent.includes('没更新'))), false, 'no stale warning while the rate is fresh');

    // 9. A rate that stopped coming (four days and more): the note and one toast say so.
    await context.clock.setFixedTime(at('2026-12-06T09:00:00'));
    rateAnswer = { status:500, json:{ ok:false, message:'offline' } };
    await refresh();
    assert.match(await note(), /汇率已经 5 天没更新，请检查网络；联网后会自动补取。/);
    await h.waitToast(page, '当月汇率已经 5 天没更新');

    // 10. Two windows each wrote the rate they fetched: merging takes the later one and asks nothing.
    //     Two different typed numbers for the same month still count as a conflict.
    const merge = await page.evaluate(() => {
      const base = normalizeExchangeSettings({ monthlyRates:{ '2026-11':6.6 }, manualMonths:{}, auto:null });
      const auto = (rate, checkedAt) => ({ month:'2026-12', rate, source:'boc', sourceLabel:'中国银行现汇买入价', publishedAt:'2026-12-06 09:30', checkedAt });
      const mine = { ...base, monthlyRates:{ ...base.monthlyRates, '2026-12':6.62 }, auto:auto(6.62, '2026-12-06T01:00:00.000Z') };
      const theirs = { ...base, monthlyRates:{ ...base.monthlyRates, '2026-12':6.63 }, auto:auto(6.63, '2026-12-06T01:00:05.000Z') };
      const quiet = mergeMacStates({ exchangeSettings:base }, { exchangeSettings:mine }, { exchangeSettings:theirs }, 'mine');
      const typed = mergeMacStates(
        { exchangeSettings:base },
        { exchangeSettings:{ ...base, monthlyRates:{ ...base.monthlyRates, '2027-03':7.1 }, manualMonths:{ '2027-03':true } } },
        { exchangeSettings:{ ...base, monthlyRates:{ ...base.monthlyRates, '2027-03':7.2 }, manualMonths:{ '2027-03':true } } }
      );
      return { conflicts:quiet.conflicts.length, rate:quiet.state.exchangeSettings.monthlyRates['2026-12'], auto:quiet.state.exchangeSettings.auto.rate, typed:typed.conflicts.map(item => item.path.join('.')) };
    });
    assert.deepEqual(merge, { conflicts:0, rate:6.63, auto:6.63, typed:['exchangeSettings.monthlyRates.2027-03'] });

    assert.ok(rateRequests >= 10);
    await flush();
    assert.equal(saved().monthlyRates['2026-12'], 6.61);
    assert.deepEqual(errors, []);
    console.log('Exchange rate auto update tests passed: current month only, typed months kept, clearing hands back, months before the table fixed, both banks named, failure keeps the last rate, read-only writes nothing, month rollover, stale warning.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
