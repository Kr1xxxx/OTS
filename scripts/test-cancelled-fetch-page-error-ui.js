#!/usr/bin/env node
// A request the page starts while it is on its way out is not a page error.
//
// During a reload the old page lives on until the new one arrives (the real page is 1.4 MB, so that takes a
// moment) and its timers still fire. A request it starts at the very end of that, or in pagehide / unload, is
// refused by WebKit, which writes "Fetch API cannot load <url> due to access control checks." to the console, and
// Playwright's WebKit hands every console error that comes from JavaScript to the test as a 'pageerror'. Chromium
// reports nothing. Requests that were already on their way are cut off silently in both engines. (Each case was
// tried one by one in WebKit on CI, see pull request #164.)
//
// The real page asks for the exchange rate again 15 s, 45 s, ... after loading when the test's stub has none, so a
// test that reloaded at one of those moments failed now and then, in WebKit only (test-order-list-density-ui,
// test-followup-tasks-ui, test-dashboard-layout-ui). scripts/helpers/use-webkit.js drops that line from 'pageerror'.
//
// Here a page that keeps asking, and asks once more in pagehide, is reloaded, and the new copy arrives only after
// the old one has asked a few more times. The test's 'pageerror' list must hold nothing but an exception the page
// really throws afterwards.
const assert = require('node:assert/strict');
const { launchBrowser } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const asking = `<script>
  setInterval(() => { fetch('/api/tick', { cache:'no-store' }).catch(() => {}); }, 4);
  addEventListener('pagehide', () => { fetch('/api/leaving', { cache:'no-store' }).catch(() => {}); });
</script>`;
const cutOff = text => /^Fetch API cannot load .* due to access control checks\.$/.test(text);
const text = error => `${error.name}: ${error.message}`;

(async () => {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // What tests listen to, and what the browser reported before use-webkit.js looked at it.
    const errors = [];
    const reported = [];
    page.on('pageerror', error => errors.push(text(error)));
    context.on('weberror', webError => reported.push(text(webError.error())));
    let loads = 0;
    let asked = 0;
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).pathname !== '/page.html') {
        asked += 1;
        return route.fulfill({ json:{ ok:true } }).catch(() => {});
      }
      loads += 1;
      if (loads === 1) return route.fulfill({ contentType:'text/html', body:`<!doctype html><title>asking</title>${asking}` });
      // The new copy takes a while: the old page asks five more times first (two seconds at most).
      const before = asked;
      for (let i = 0; i < 400 && asked < before + 5; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
      return route.fulfill({ contentType:'text/html', body:'<!doctype html><title>quiet</title>' });
    });
    await page.goto(`http://127.0.0.1:${freePortSync()}/page.html`);
    for (let i = 0; i < 400 && asked < 3; i += 1) await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.ok(asked >= 3, 'the page is asking');
    const beforeReload = asked;
    await page.reload();
    assert.equal(await page.title(), 'quiet');
    assert.ok(asked >= beforeReload + 5, `the old page kept asking while the new one was on its way (${asked - beforeReload} more)`);

    // An exception thrown now arrives after anything the reload reported, so once it is here both lists are
    // complete; and it shows that real exceptions still reach the test.
    await page.evaluate(() => { setTimeout(() => { throw new Error('thrown by the page'); }, 0); });
    for (let i = 0; i < 400 && !errors.includes('Error: thrown by the page'); i += 1) await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(errors, ['Error: thrown by the page'], 'a request refused on the way out is not a page error; a thrown exception is');
    assert.deepEqual(reported.filter(line => !cutOff(line)), ['Error: thrown by the page']);
    if (process.env.OTS_TEST_BROWSER === 'webkit') {
      // Without this the test above would pass on an engine that reports nothing. When WebKit or Playwright stops
      // reporting the line, this fails: then the filter in scripts/helpers/use-webkit.js and this test can go.
      assert.ok(reported.some(cutOff), `WebKit no longer reports the refused request; use-webkit.js has nothing to drop (${JSON.stringify(reported)})`);
    }
    console.log(`Cancelled fetch test passed: ${reported.filter(cutOff).length} refused request(s) reported by the browser, none of them a page error; a thrown exception still is.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
