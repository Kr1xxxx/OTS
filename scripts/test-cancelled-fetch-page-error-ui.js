#!/usr/bin/env node
// A request that a reload cuts off is not a page error.
//
// WebKit writes "Fetch API cannot load <url> due to access control checks." to the console when a reload (or a
// navigation, or the page closing) cuts off a request that is still on its way, and Playwright's WebKit hands that
// line to the test as a 'pageerror'. Tests collect page errors and expect none, so a test that reloaded while one of
// the page's background requests was out (the exchange rate is asked again every 15 s when the stub has none) failed
// now and then, in WebKit only. scripts/helpers/use-webkit.js drops that line; this test holds a request open across
// a reload and expects no page error from it, while an exception the page throws still arrives.
const assert = require('node:assert/strict');
const { launchBrowser } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

(async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(`${error.name}: ${error.message}`));
    let held = 0;
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/page.html') return route.fulfill({ contentType:'text/html', body:'<!doctype html><title>reload</title>' });
      // Never answered: still on its way when the page reloads.
      held += 1;
      return undefined;
    });
    await page.goto(`http://127.0.0.1:${freePortSync()}/page.html`);
    // What the page does with its background requests: it asks, and takes a failure as "not this time".
    await page.evaluate(() => { fetch('/api/held', { cache:'no-store' }).catch(() => {}); });
    for (let i = 0; i < 200 && !held; i += 1) await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(held, 1, 'the request reached the test and is still unanswered');
    await page.reload();

    // An exception thrown after the reload arrives after anything the reload itself reported, so once it is
    // here the list is complete; and it shows that real exceptions are still reported.
    await page.evaluate(() => { setTimeout(() => { throw new Error('thrown by the page'); }, 0); });
    for (let i = 0; i < 200 && !errors.some(text => text.includes('thrown by the page')); i += 1) await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(errors, ['Error: thrown by the page'], 'the cut-off request is not a page error; the thrown exception is');
    console.log('Cancelled fetch test passed: a request cut off by a reload is not reported as a page error, a thrown exception is.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
