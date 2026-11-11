#!/usr/bin/env node
// 日期字段：App 自己画的日历代替系统日期框。点开、点日子、键盘选、手打各种写法、认不出来改回、
// 最小 / 最大日期、Esc 只关日历不关弹窗、选完焦点还在输入框里；听 input 的代码看不到打到一半的日期。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders:[] }, { port:freePortSync() });
    const popover = page.locator('#datePickerPopover');
    const isOpen = () => popover.evaluate(el => !el.hidden).catch(() => false);

    // ---- parser: the ways people type a date ----
    const parsed = await page.evaluate(() => ['2030-05-14', '2030/5/4', '2030.05.04', '2030年5月4日', '20300504', '５/４', '5月4日', ' ', '2030-02-30', '14/05/2030', 'abc']
      .map(text => parseDateInputText(text, '2030-01-01')));
    assert.deepEqual(parsed, ['2030-05-14', '2030-05-04', '2030-05-04', '2030-05-04', '2030-05-04', '2030-05-04', '2030-05-04', '', null, null, null]);

    await h.click(page, '#newOrderBtn');
    await page.locator('#orderModal.open').waitFor();
    await h.settle(page, '#orderModal .modal');
    await page.evaluate(() => uiOrderCompact(document.getElementById('orderForm'), false));
    const created = page.locator('#orderForm [name="createdAt"]');
    const required = page.locator('#orderForm [name="customerRequiredDate"]');
    assert.equal(await created.getAttribute('type'), 'text', 'no system date field is left');
    assert.equal(await page.locator('input[type="date"]').count(), 0);

    // Everything that listens to `input` on the field is logged here.
    await page.evaluate(() => {
      window.__dateInputs = [];
      window.__dateChanges = [];
      document.getElementById('orderForm').addEventListener('input', e => { if (e.target.name === 'customerRequiredDate') window.__dateInputs.push(e.target.value); });
      document.getElementById('orderForm').addEventListener('change', e => { if (e.target.name === 'customerRequiredDate') window.__dateChanges.push(e.target.value); });
    });

    // ---- 1. Click opens the calendar on the field's month, a day click fills it and keeps the focus ----
    await required.fill('2030-05-14');
    await h.click(page, '#orderForm [name="customerRequiredDate"]');
    await popover.waitFor({ state:'visible' });
    assert.equal(await popover.locator('.date-picker-title').innerText(), '2030年5月');
    assert.equal(await popover.locator('.date-picker-day.selected').innerText(), '14');
    assert.equal(await popover.locator('.date-picker-day').count(), 42);
    assert.equal(await popover.locator('[data-dp-clear]').count(), 1, 'an optional date can be cleared');
    await h.click(page, popover.locator('[data-dp-date="2030-05-21"]'), '21 May');
    assert.equal(await isOpen(), false, 'picking a day closes the calendar');
    assert.equal(await required.inputValue(), '2030-05-21');
    assert.equal(await page.evaluate(() => document.activeElement?.name), 'customerRequiredDate', 'the focus stays in the field');
    assert.deepEqual(await page.evaluate(() => window.__dateChanges.slice(-1)), ['2030-05-21']);

    // ---- 2. Keyboard: ↓ opens, arrows move, PageDown is a month, Enter picks; Esc closes the calendar, not the dialog ----
    await page.keyboard.press('ArrowDown');
    await popover.waitFor({ state:'visible' });
    assert.equal(await popover.evaluate(el => el.classList.contains('keyboard')), true);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('PageDown');
    assert.equal(await popover.locator('.date-picker-title').innerText(), '2030年6月');
    assert.equal(await required.getAttribute('aria-activedescendant'), 'datePickerPopover-d-2030-06-29');
    await page.keyboard.press('Enter');
    assert.equal(await required.inputValue(), '2030-06-29');
    assert.equal(await isOpen(), false);
    assert.equal(await page.locator('#orderModal.open').count(), 1, 'Enter in the calendar does not submit the order');
    await page.keyboard.press('ArrowUp');
    await popover.waitFor({ state:'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await isOpen(), false);
    assert.equal(await page.locator('#orderModal.open').count(), 1, 'Esc closed only the calendar');

    // ---- 3. Month view: the title switches to the twelve months ----
    await h.click(page, '#orderForm [name="customerRequiredDate"]');
    await popover.waitFor({ state:'visible' });
    await h.click(page, popover.locator('.date-picker-title'), 'calendar title');
    assert.equal(await popover.locator('.date-picker-month').count(), 12);
    await h.click(page, popover.locator('[data-dp-step="1"]'), 'next year');
    await h.click(page, popover.locator('[data-dp-month="1"]'), 'February');
    assert.equal(await popover.locator('.date-picker-title').innerText(), '2031年2月');
    assert.equal(await popover.locator('[data-dp-date="2031-02-28"]').count(), 1);
    await h.click(page, '#orderForm .order-section-title', 'a section title');
    assert.equal(await isOpen(), false, 'a click elsewhere closes the calendar');

    // ---- 4. Typing: half a date is not passed on, a finished one is written as YYYY-MM-DD, nonsense goes back ----
    await page.evaluate(() => { window.__dateInputs = []; });
    await required.click();
    await page.keyboard.press('Escape');
    await required.press('ControlOrMeta+a');
    await page.keyboard.type('2031/3/5');
    assert.deepEqual(await page.evaluate(() => window.__dateInputs), [], 'half-typed dates do not reach the page');
    assert.equal(await isOpen(), false, 'typing does not open the calendar');
    await page.keyboard.press('Tab');
    assert.equal(await required.inputValue(), '2031-03-05');
    assert.deepEqual(await page.evaluate(() => window.__dateInputs), ['2031-03-05']);
    await required.click();
    await page.keyboard.press('Escape');
    await required.press('ControlOrMeta+a');
    await page.keyboard.type('next week');
    await page.keyboard.press('Tab');
    assert.equal(await required.inputValue(), '2031-03-05', 'an unreadable date goes back to the last one');
    await h.waitToast(page, '不是有效日期');

    // ---- 5. Required fields have no 清除; days outside min / max cannot be picked ----
    await created.evaluate(el => { el.value = '2030-05-14'; el.min = '2030-05-10'; el.max = '2030-05-20'; });
    await h.click(page, '#orderForm [name="createdAt"]');
    await popover.waitFor({ state:'visible' });
    assert.equal(await popover.locator('[data-dp-clear]').count(), 0);
    assert.equal(await popover.locator('[data-dp-date="2030-05-09"]').isDisabled(), true);
    assert.equal(await popover.locator('[data-dp-date="2030-05-21"]').isDisabled(), true);
    assert.equal(await popover.locator('[data-dp-date="2030-05-10"]').isDisabled(), false);
    await page.keyboard.press('PageDown');
    assert.equal(await created.getAttribute('aria-activedescendant'), 'datePickerPopover-d-2030-05-20', 'keyboard moves stop at the last allowed day');
    await page.keyboard.press('Escape');
    await created.evaluate(el => { el.removeAttribute('min'); el.removeAttribute('max'); });

    // ---- 6. The order saves the picked dates ----
    await page.evaluate(() => {
      const form = document.getElementById('orderForm');
      form.elements.client.value = 'Date Picker Buyer';
      form.elements.amount.value = '100';
    });
    await page.evaluate(() => document.getElementById('orderForm').requestSubmit());
    await page.waitForFunction(() => state.orders.some(o => o.client === 'Date Picker Buyer'));
    const order = await page.evaluate(() => { const o = state.orders.find(item => item.client === 'Date Picker Buyer'); return { createdAt:o.createdAt, customerRequiredDate:o.customerRequiredDate }; });
    assert.deepEqual(order, { createdAt:'2030-05-14', customerRequiredDate:'2031-03-05' });

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('date picker UI test passed');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
