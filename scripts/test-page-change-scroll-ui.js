#!/usr/bin/env node
// A page change puts the new page at the top, and puts it there again on the next frame and after 80
// and 240 ms while the page lays out. Those later passes used to undo whatever the user did in that
// quarter second: a scroll jumped back, a menu opened in that time was closed by the scroll the jump
// caused, and a press that began before the jump landed on whatever had moved under the pointer
// (tests that clicked right after a page change failed now and then for the same reason).
// Now the later passes stop as soon as the user scrolls, presses or types.
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const orders = Array.from({ length:40 }, (_, index) => ({
  ...base, id:`o${index}`, num:`PI-${1000 + index}`, client:`Customer ${index}`, stage:'报价', amount:100 + index, paidAmount:0, createdAt:day(1 + index % 20)
}));
const scrollTop = page => page.evaluate(() => Math.round(document.scrollingElement.scrollTop));

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { height:700 });
    await h.waitPageTime(page, 400);

    // Nothing done by the user: something that moves the page during those 240 ms is still put back.
    const moved = await page.evaluate(() => { setPage('customers'); document.scrollingElement.scrollTop = 300; return document.scrollingElement.scrollTop; });
    assert.equal(moved, 300, 'the customer page is tall enough to scroll in this test');
    await h.waitPageTime(page, 320);
    assert.equal(await scrollTop(page), 0, 'a page change still ends at the top when the user did nothing');

    // The user turns the wheel right after switching page: the page stays where they scrolled to. (The wheel
    // itself may move a list under the pointer instead of the page, so the test moves the page directly.)
    await page.mouse.move(700, 400);
    await page.evaluate(() => setPage('dashboard'));
    await h.waitPageTime(page, 400);
    await page.evaluate(() => setPage('customers'));
    await page.mouse.wheel(0, 40);
    await page.evaluate(() => { document.scrollingElement.scrollTop = 300; });
    await h.waitPageTime(page, 320);
    assert.ok(await scrollTop(page) >= 300, 'a scroll right after a page change jumped back to the top');

    // A press does the same: what is under the pointer when the button goes down is still there when it
    // comes up, whatever moves the page meanwhile.
    await page.evaluate(() => setPage('dashboard'));
    await h.waitPageTime(page, 400);
    await page.evaluate(() => setPage('customers'));
    await page.mouse.down();
    await page.evaluate(() => { document.scrollingElement.scrollTop = 300; });
    await h.waitPageTime(page, 320);
    await page.mouse.up();
    assert.equal(await scrollTop(page), 300, 'the page jumped under a pressed pointer');

    // A key does too (arrow keys and Page Down scroll the page).
    await page.evaluate(() => setPage('dashboard'));
    await h.waitPageTime(page, 400);
    await page.evaluate(() => setPage('customers'));
    await page.keyboard.press('Shift');
    await page.evaluate(() => { document.scrollingElement.scrollTop = 300; });
    await h.waitPageTime(page, 320);
    assert.equal(await scrollTop(page), 300, 'the page jumped after a key press');

    // Input that arrives before the page has heard its own hash change (a busy machine delivers the
    // press first): the hash change must not start the passes again.
    await page.evaluate(() => setPage('dashboard'));
    await h.waitPageTime(page, 400);
    const order = await page.evaluate(() => {
      const seen = [];
      window.addEventListener('hashchange', () => seen.push('hashchange'), { once:true });
      setPage('customers');
      window.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
      seen.push('pointerdown');
      document.scrollingElement.scrollTop = 300;
      return new Promise(resolve => setTimeout(() => resolve(seen), 320));
    });
    assert.deepEqual(order, ['pointerdown', 'hashchange'], 'the press comes before the hash change in this case');
    assert.equal(await scrollTop(page), 300, 'the hash change of the page change put the page at the top after a press');

    // Going back in history is a page change like any other.
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'page-dashboard');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('Page change scroll passed: the new page starts at the top; a scroll, press or key right after the change is not undone; history still changes page.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
