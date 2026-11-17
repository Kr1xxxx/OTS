#!/usr/bin/env node
// 设置 › 汇率 page: one card for the current month, the past months as cells, and only the later months
// that were set ahead of time (manualMonths). The stored data (monthlyRates, manualMonths, auto) keeps its shape:
// - the current-month card shows exchangeRateForMonth(current) and an 自动 / 手填 tag that follows manualMonths
// - past months, newest first, carry 手填 only when typed; nothing claims a past month was fetched online
// - saving only the current month leaves every other month's number and 手填 mark alone, including
//   later months that are not in the form (set in another window while this form had unsaved input) (the save used to read a missing field as "cleared"
//   and reset such a month to 6.8)
// - 恢复自动 empties the card's field; saving hands the month back to the fetched rate
// - 加一个月份 adds a later month; a number typed there is the user's even when it equals 6.8
// - 取消 on a month set ahead hands it back on save; 取消 on a row just added removes the row
// - clearing a past month keeps its number; a fetched rate does not wipe a row being added
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
    const quotes = [{ source:'boc', sourceLabel:'中国银行现汇买入价', rate:7.1023 }, { source:'icbc', sourceLabel:'工商银行现汇买入价', rate:7.1102 }];
    const auto = { month:'2026-11', rate:7.1023, source:'boc', sourceLabel:'中国银行现汇买入价', publishedAt:'2026-11-16 09:30', checkedAt:'2026-11-16T01:31:00.000Z', quotes, failed:[] };
    const exchangeSettings = {
      monthlyRates:{ '2026-05':7.2, '2026-06':7.1702, '2026-07':7.1466, '2026-08':7.15, '2026-09':7.1204, '2026-10':7.0981, '2026-11':7.1023, '2027-02':7.05 },
      manualMonths:{ '2026-05':true, '2026-08':true, '2027-02':true },
      auto
    };
    const store = {
      current:{ app:'trade-order-system', data:{ orders:[], customers:{}, doneTasks:{}, demoCleared:true, demoCustomersCleared:true, exchangeSettings }, revision:0 },
      saves:0
    };
    let rateAnswer = { ok:true, rate:7.1023, source:'boc', sourceLabel:'中国银行现汇买入价', publishedAt:'2026-11-16 09:30', quotes, failed:[] };
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/usd-cny-rate') return route.fulfill({ json:rateAnswer });
      let response = { ok:true };
      if (pathname === '/api/data') response = store.current;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:0 }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
      if (pathname === '/api/save') {
        const body = route.request().postDataJSON();
        store.current = { ...body.state, revision:store.current.revision + 1 };
        store.saves += 1;
        response = { ok:true, revision:store.current.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    await page.goto('http://127.0.0.1:47997/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('settings'));
    await h.click(page, '[data-settings-tab="exchange"]', 'exchange tab');
    await page.waitForSelector('.settings-panel.active .exchange-now');

    const settings = () => page.evaluate(() => JSON.parse(JSON.stringify(getExchangeSettings())));
    const saved = () => store.current.data?.exchangeSettings || store.current.exchangeSettings;
    const save = async () => {
      await h.clearToasts(page);
      await page.evaluate(() => document.getElementById('exchangeSettingsForm').requestSubmit());
      await h.waitToast(page, '汇率设置已保存');
      await page.evaluate(() => window.flushPendingSave?.());
    };
    const look = () => page.evaluate(() => {
      const text = el => el?.textContent.replace(/\s+/g, ' ').trim() || '';
      const now = document.querySelector('.exchange-now');
      return {
        nowLabel:text(now.querySelector('label')),
        nowValue:now.querySelector('input').value,
        nowTag:text(now.querySelector('.exchange-tag')),
        reset:Boolean(now.querySelector('[data-exchange-reset]')),
        note:text(document.getElementById('exchangeRateNote')),
        past:[...document.querySelectorAll('.exchange-panel .manual-rate-item')].map(cell => [cell.querySelector('input').name.slice(5), cell.querySelector('input').value, text(cell.querySelector('.exchange-tag'))]),
        future:[...document.querySelectorAll('.exchange-future-row')].map(row => [row.dataset.exchangeMonth, row.querySelector('input').value]),
        fields:[...document.getElementById('exchangeSettingsForm').elements].filter(el => el.name).map(el => el.name),
        rules:text(document.querySelector('.settings-panel.active .exchange-rules'))
      };
    });
    const dirty = () => page.evaluate(() => uiFormDirty(document.getElementById('exchangeSettingsForm')));

    // 1. The page as it opens.
    let view = await look();
    assert.equal(view.nowLabel, '2026年11月 · 本月');
    assert.equal(Number(view.nowValue), await page.evaluate(() => exchangeRateForMonth('2026-11')), 'the card shows the rate used for the month');
    assert.equal(view.nowTag, '自动', 'the current month is not typed: 自动');
    assert.equal(view.reset, false, 'no 恢复自动 while automatic');
    assert.equal(view.note, '11月：7.1023 · 中国银行现汇买入价（工商银行 7.1102，两家取低的） · 11月16日 09:30 更新。', 'the card says where the number came from');
    assert.match(view.rules, /^过去的月份不会自动改；自己填过的月份不自动更新（清空再保存就恢复自动）；2026年5月以前的订单按 2026年5月 那格算。$/);
    assert.deepEqual(view.past, [
      ['2026-10', '7.0981', ''], ['2026-09', '7.1204', ''], ['2026-08', '7.15', '手填'],
      ['2026-07', '7.1466', ''], ['2026-06', '7.1702', ''], ['2026-05', '7.2', '手填']
    ], 'past months newest first; only typed months carry a tag');
    assert.deepEqual(view.future, [['2027-02', '7.05']], 'only the later month set ahead is listed');
    assert.ok(!view.fields.includes('rate-2026-12') && !view.fields.includes('rate-2027-03'), 'later months that were not set are not in the form');
    assert.equal(await dirty(), false);

    // 2. Changing only the current month: every other month keeps its number and its mark.
    //    Meanwhile another window set 2027-05 ahead; the form has an unsaved number, so it is not redrawn
    //    and has no field for 2027-05. Saving must not read the missing field as "cleared".
    await page.fill('#exchangeRate-2026-11', '7.08');
    await page.evaluate(() => {
      const current = getExchangeSettings();
      state.exchangeSettings = { ...current, monthlyRates:{ ...current.monthlyRates, '2027-05':7.3 }, manualMonths:{ ...current.manualMonths, '2027-05':true } };
      render();
    });
    assert.equal(await page.locator('#exchangeRate-2027-05').count(), 0, 'the unsaved form is not redrawn');
    await save();
    let s = await settings();
    assert.equal(s.monthlyRates['2026-11'], 7.08);
    assert.deepEqual(s.manualMonths, { '2026-05':true, '2026-08':true, '2027-02':true, '2027-05':true, '2026-11':true });
    assert.equal(s.monthlyRates['2027-05'], 7.3, 'a month set ahead in another window is kept');
    const untouched = { ...exchangeSettings.monthlyRates };
    delete untouched['2026-11'];
    for (const [month, rate] of Object.entries(untouched)) assert.equal(s.monthlyRates[month], rate, `${month} keeps its number`);
    assert.equal(s.monthlyRates['2027-03'], 6.8, 'a later month not set stays 6.8');
    assert.equal(saved().monthlyRates['2027-02'], 7.05, 'the month set ahead is still saved');
    assert.equal(saved().manualMonths['2027-02'], true, 'and still the user\'s');
    assert.ok(!saved().manualMonths['2027-03'], 'a later month not set is not the user\'s');
    view = await look();
    assert.equal(view.nowTag, '手填');
    assert.equal(view.reset, true, '恢复自动 shows for a typed month');
    assert.equal(view.note, '11月：7.08 · 你自己填的，不联网更新。');

    // 3. 恢复自动 empties the field (unsaved until saved); saving hands the month back to the fetched rate.
    await h.click(page, '[data-exchange-reset]', '恢复自动');
    assert.equal(await page.inputValue('#exchangeRate-2026-11'), '');
    assert.equal(await dirty(), true, '恢复自动 leaves the form unsaved');
    await save();
    await page.waitForFunction(() => getExchangeSettings().monthlyRates['2026-11'] === 7.1023);
    s = await settings();
    assert.ok(!s.manualMonths['2026-11'], 'the current month is automatic again');
    assert.equal(s.manualMonths['2027-02'], true);
    view = await look();
    assert.equal(view.nowTag, '自动');
    assert.equal(view.nowValue, '7.1023');

    // 4. 加一个月份: a later month typed as 6.8 is still the user's and is listed afterwards.
    await h.click(page, '.exchange-add .app-select-button', '加一个月份');
    await h.click(page, page.locator('.app-select-option', { hasText:'2027年4月' }), '2027年4月');
    await page.waitForSelector('#exchangeRate-2027-04');
    assert.deepEqual((await look()).future.map(row => row[0]), ['2027-02', '2027-04', '2027-05'], 'the new row goes in month order');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'exchangeRate-2027-04', 'the new field takes the focus');
    assert.equal(await dirty(), true, 'an added row counts as unsaved');
    const optionsNow = await page.evaluate(() => [...document.querySelectorAll('#exchangeAddMonth option')].map(option => option.value));
    assert.ok(!optionsNow.includes('2027-04') && !optionsNow.includes('2027-02') && !optionsNow.includes('2026-11') && optionsNow.includes('2026-12'), 'only later months not listed yet can be added');
    // A fetched rate while the row waits does not redraw the form away.
    rateAnswer = { ...rateAnswer, rate:7.1011, publishedAt:'2026-11-16 10:30', quotes:[{ ...quotes[0], rate:7.1011 }, quotes[1]] };
    await page.evaluate(() => refreshAutoExchangeRate());
    await page.waitForFunction(() => getExchangeSettings().monthlyRates['2026-11'] === 7.1011);
    assert.ok(await page.locator('#exchangeRate-2027-04').count(), 'the added row survives a fetched rate');
    assert.match((await look()).note, /^11月：7\.1011 · /, 'the note still follows the fetched rate');
    await page.fill('#exchangeRate-2027-04', '6.8');
    await save();
    s = await settings();
    assert.equal(s.monthlyRates['2027-04'], 6.8);
    assert.equal(s.manualMonths['2027-04'], true, 'a typed 6.8 counts as typed');
    assert.deepEqual((await look()).future, [['2027-02', '7.05'], ['2027-04', '6.8'], ['2027-05', '7.3']]);

    // 5. 取消 on a row just added removes it; nothing is left unsaved.
    await h.click(page, '.exchange-add .app-select-button', '加一个月份');
    await h.click(page, page.locator('.app-select-option', { hasText:'2027年6月' }), '2027年6月');
    await page.waitForSelector('#exchangeRate-2027-06');
    await h.click(page, '[data-exchange-cancel="2027-06"]', '取消 2027-06');
    assert.equal(await page.locator('#exchangeRate-2027-06').count(), 0);
    assert.equal(await dirty(), false, 'removing the added row leaves nothing unsaved');

    // 6. 取消 on a month set ahead hands it back: saved, it is 6.8 and automatic, and no longer listed.
    await h.click(page, '[data-exchange-cancel="2027-02"]', '取消 2027-02');
    assert.equal(await page.inputValue('#exchangeRate-2027-02'), '');
    await save();
    s = await settings();
    assert.equal(s.monthlyRates['2027-02'], 6.8);
    assert.ok(!s.manualMonths['2027-02']);
    assert.equal(s.manualMonths['2027-04'], true, 'the other month set ahead stays');
    assert.deepEqual((await look()).future, [['2027-04', '6.8'], ['2027-05', '7.3']]);

    // 7. Clearing a past month keeps its number and its mark.
    await page.fill('#exchangeRate-2026-08', '');
    await page.fill('#exchangeRate-2026-09', '');
    await save();
    s = await settings();
    assert.equal(s.monthlyRates['2026-08'], 7.15);
    assert.equal(s.monthlyRates['2026-09'], 7.1204);
    assert.equal(s.manualMonths['2026-08'], true);
    assert.ok(!s.manualMonths['2026-09']);

    // 8. An unchanged save changes nothing.
    const before = JSON.stringify(await settings());
    const savesBefore = store.saves;
    await save();
    assert.equal(JSON.stringify(await settings()), before, 'an unchanged save leaves the settings as they are');
    assert.ok(store.saves - savesBefore <= 1);

    assert.deepEqual(errors, []);
    console.log('Exchange settings page tests passed: current-month card and tag, past months newest first, only months set ahead listed, saving one month keeps the rest, 恢复自动, 加一个月份 with 6.8, 取消, past month cleared keeps its number.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
