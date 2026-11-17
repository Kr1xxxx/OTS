#!/usr/bin/env node
// TEMPORARY PROBE (this commit only): which way of cutting a request off makes WebKit report
// "Fetch API cannot load <url> due to access control checks." as a page error? The first version of this test
// (a request held open across a reload) did not reproduce it in WebKit, so each scenario below is tried in a fresh
// page and the page errors it produced are printed. In WebKit the script exits 1 on purpose so that CI shows the
// report; the next commit replaces this file with the real test.
const { launchBrowser, openBoard } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = [];

async function settle(page, errors) {
  await page.evaluate(() => { setTimeout(() => { throw new Error('marker'); }, 0); }).catch(error => errors.push(`evaluate failed: ${error.message}`));
  for (let i = 0; i < 100 && !errors.some(text => text.includes('marker')); i += 1) await sleep(20);
  await sleep(300);
}

async function scenario(browser, name, { script, apiDelay = 0, htmlDelay = 0, trigger = 'reload', before = 150 }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(`${error.name}: ${error.message}`));
  let loads = 0;
  let api = 0;
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/page.html') {
      loads += 1;
      if (loads > 1 && htmlDelay) await sleep(htmlDelay);
      return route.fulfill({ contentType:'text/html', body:`<!doctype html><title>probe</title><script>${script}</script>` }).catch(() => {});
    }
    api += 1;
    if (apiDelay === null) return undefined;
    if (apiDelay) await sleep(apiDelay);
    return route.fulfill({ json:{ ok:true } }).catch(() => {});
  });
  const url = `http://127.0.0.1:${freePortSync()}/page.html`;
  try {
    await page.goto(url);
    await sleep(before);
    const apiBefore = api;
    if (trigger === 'reload') await page.reload();
    else if (trigger === 'goto') await page.goto(url);
    else if (trigger === 'location') { await page.evaluate(() => { location.reload(); }); await sleep(htmlDelay + 500); }
    await settle(page, errors);
    report.push({ name, apiBefore, api, errors });
  } catch (error) {
    report.push({ name, failed:String(error.message).split('\n')[0], errors });
  } finally { await context.close().catch(() => {}); }
}

const once = "fetch('/api/once', { cache:'no-store' }).catch(() => {});";
const ticking = "setInterval(() => { fetch('/api/tick', { cache:'no-store' }).catch(() => {}); }, 10);";
const tickingJson = "setInterval(() => { fetch('/api/tick', { cache:'no-store' }).then(r => r.json()).catch(() => {}); }, 10);";
const onEvent = name => `addEventListener('${name}', () => { fetch('/api/${name}', { cache:'no-store' }).catch(() => {}); });`;

(async () => {
  const browser = await launchBrowser();
  try {
    await scenario(browser, 'A held request, reload', { script:once, apiDelay:null });
    await scenario(browser, 'A2 held request, goto', { script:once, apiDelay:null, trigger:'goto' });
    await scenario(browser, 'B answer 400 ms late, reload at once', { script:once, apiDelay:400, before:50 });
    await scenario(browser, 'B2 answer 400 ms late, new page takes 800 ms', { script:once, apiDelay:400, htmlDelay:800, before:50 });
    await scenario(browser, 'C request every 10 ms, new page takes 600 ms', { script:ticking, htmlDelay:600 });
    await scenario(browser, 'C2 request every 10 ms, new page at once', { script:ticking });
    await scenario(browser, 'C3 request every 10 ms + json(), new page takes 600 ms', { script:tickingJson, htmlDelay:600 });
    await scenario(browser, 'D request every 10 ms answered 50 ms late, new page takes 600 ms', { script:ticking, apiDelay:50, htmlDelay:600 });
    await scenario(browser, 'D2 request every 10 ms answered 50 ms late, new page at once', { script:ticking, apiDelay:50 });
    await scenario(browser, 'D3 request every 10 ms never answered, new page takes 600 ms', { script:ticking, apiDelay:null, htmlDelay:600 });
    await scenario(browser, 'E request in pagehide', { script:onEvent('pagehide') });
    await scenario(browser, 'F request in beforeunload', { script:onEvent('beforeunload') });
    await scenario(browser, 'G request in unload', { script:onEvent('unload') });
    await scenario(browser, 'H request every 10 ms, goto, new page takes 600 ms', { script:ticking, htmlDelay:600, trigger:'goto' });
    await scenario(browser, 'I request every 10 ms, location.reload(), new page takes 600 ms', { script:ticking, htmlDelay:600, trigger:'location' });

    // The real page: its own rate request asked again and again while a reload is under way.
    for (const htmlDelay of [0, 600]) {
      const { page, context, errors } = await openBoard(browser, { orders:[] }, { port:freePortSync() });
      try {
        if (htmlDelay) await page.route('**/trade-order-system.html', async route => { await sleep(htmlDelay); return route.fallback(); });
        await page.evaluate(() => { setInterval(() => { refreshAutoExchangeRate(); }, 20); });
        await sleep(100);
        await page.reload();
        await settle(page, errors);
        report.push({ name:`R real page, rate request every 20 ms, new page takes ${htmlDelay} ms`, errors });
      } catch (error) {
        report.push({ name:`R real page ${htmlDelay}`, failed:String(error.message).split('\n')[0], errors });
      } finally { await context.close().catch(() => {}); }
    }
  } finally { await browser.close(); }
  for (const row of report) console.log(JSON.stringify(row));
  if (process.env.OTS_TEST_BROWSER === 'webkit') {
    console.log('Probe: exit 1 on purpose so that this report is shown.');
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
