// The save engine names where it is: pendingSaveStatus().phase. This walks the real page through every
// phase with a scripted server and checks the name at each step, together with what hangs on it
// (read-only, the two panels on the settings page, the bell's "save failed" card).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
const address = 'http://127.0.0.1:47998/trade-order-system.html';

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

// A page whose server answers /api/data and /api/save the way `server` says at that moment.
async function open(browser, server) {
  const page = await browser.newPage({ viewport:{ width:1200, height:800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss(); });
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    if (pathname === '/api/data') return server.data(route);
    if (pathname === '/api/health') return route.fulfill({ json:{ ok:true, storageMode:'sqlite', counts:{ orders:0 }, backups:{ sqliteCount:0 } } });
    if (pathname === '/api/save') return server.save(route);
    return route.fulfill({ json:{ ok:true } });
  });
  await page.goto(address);
  return { page, errors };
}

const phase = page => page.evaluate(() => window.pendingSaveStatus().phase);
const waitPhase = (page, name) => page.waitForFunction(expected => window.pendingSaveStatus?.().phase === expected, name, { timeout:15000 });
const edit = (page, name) => page.evaluate(customer => { state.customers[customer] = { name:customer }; saveState(); }, name);
const panels = page => page.evaluate(() => ({
  conflict: !document.getElementById('macStorageConflictActions').hidden,
  reload: !document.getElementById('macStorageReloadActions').hidden
}));
const openSaveFailures = page => page.evaluate(() => uiNotifEvents().filter(item => item.id.startsWith('save-') && !item.resolvedAt).length);

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    // ---- loading → idle → queued → saving → idle ----
    const stored = { app:'trade-order-system', data:{ orders:[], customers:{}, demoCleared:true, demoCustomersCleared:true }, revision:4 };
    const accept = route => {
      const body = route.request().postDataJSON();
      stored.data = body.state.data ?? body.state;
      stored.revision += 1;
      return route.fulfill({ json:{ ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } } });
    };
    const firstLoad = deferred();
    const server = {
      data: async route => { await firstLoad.promise; return route.fulfill({ json:stored }); },
      save: accept
    };
    const { page, errors } = await open(browser, server);
    await waitPhase(page, 'loading');
    assert.equal(await page.evaluate(() => window.pendingSaveStatus().loaded), false);
    await edit(page, 'Too Early');
    assert.equal(await phase(page), 'loading', 'nothing is queued before the database was read');
    firstLoad.release();
    await waitPhase(page, 'idle');
    assert.deepEqual(await panels(page), { conflict:false, reload:false });
    assert.equal(await page.evaluate(() => 'Too Early' in state.customers), false, 'the database replaces what was typed into the placeholder');
    server.data = route => route.fulfill({ json:stored });

    const held = deferred();
    server.save = async route => { await held.promise; return accept(route); };
    // In one step: the 350 ms wait must not run out between the change and the question.
    assert.equal(await page.evaluate(() => { state.customers['First Buyer'] = { name:'First Buyer' }; saveState(); return window.pendingSaveStatus().phase; }), 'queued');
    await waitPhase(page, 'saving');
    assert.equal(await page.evaluate(() => window.pendingSaveStatus().saving), true);
    held.release();
    await waitPhase(page, 'idle');
    assert.ok(stored.data.customers['First Buyer']);

    // ---- a server error: retrying, and the retry clears it ----
    server.save = route => route.fulfill({ status:500, json:{ ok:false, message:'disk is busy' } });
    await edit(page, 'Second Buyer');
    await waitPhase(page, 'retrying');
    assert.equal(await page.evaluate(() => window.pendingSaveStatus().readOnly), false);
    assert.equal(await openSaveFailures(page), 1, 'the bell holds one open "save failed" card');
    server.save = accept;
    await page.evaluate(() => { flushPendingSave(); });
    await waitPhase(page, 'idle');
    assert.equal(await openSaveFailures(page), 0, 'the card is resolved once the save went through');
    assert.equal(await page.evaluate(() => macSaveRetryTimer), 0, 'no retry is left waiting after a save that went through');

    // ---- the data itself is refused: rejected, and no retry is set up ----
    server.save = route => route.fulfill({ status:400, json:{ ok:false, message:'订单号重复' } });
    await edit(page, 'Third Buyer');
    await waitPhase(page, 'rejected');
    assert.equal(await page.evaluate(() => macSaveRetryTimer), 0, 'a refused save is not sent again by itself');
    server.save = accept;
    await edit(page, 'Fourth Buyer');
    await waitPhase(page, 'idle');
    assert.equal(await openSaveFailures(page), 0);

    // ---- an earlier failure, then a 409 where the database already holds exactly this state ----
    // (the first attempt was written although its answer never arrived): settled like any other success.
    server.save = route => route.fulfill({ status:500, json:{ ok:false, message:'disk is busy' } });
    await edit(page, 'Fifth Buyer');
    await waitPhase(page, 'retrying');
    assert.equal(await openSaveFailures(page), 1);
    const mine = await page.evaluate(() => dataFilePayload(JSON.parse(JSON.stringify(state))));
    stored.data = mine.data ?? mine;
    stored.revision += 1;
    server.save = route => route.fulfill({ status:409, json:{ ok:false, message:'state revision conflict', currentRevision:stored.revision } });
    await page.evaluate(() => { flushPendingSave(); });
    await waitPhase(page, 'idle');
    assert.equal(await page.evaluate(() => window.pendingSaveStatus().revision), stored.revision);
    assert.equal(await openSaveFailures(page), 0, 'the "save failed" card is resolved on this path too');

    // ---- both windows changed the same field: choosing, read-only until one side is picked ----
    await page.evaluate(() => { state.customers['First Buyer'].country = 'Mine'; saveState(); });
    stored.data = JSON.parse(JSON.stringify(stored.data));
    stored.data.customers['First Buyer'].country = 'Theirs';
    stored.revision += 1;
    await waitPhase(page, 'choosing');
    assert.equal(await page.evaluate(() => window.pendingSaveStatus().readOnly), true);
    assert.deepEqual(await panels(page), { conflict:true, reload:false });
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open') && document.getElementById('confirmTitle').textContent === '两个窗口改了同一处');
    server.save = accept;
    await page.locator('#confirmAltBtn').click();
    await waitPhase(page, 'idle');
    assert.equal(stored.data.customers['First Buyer'].country, 'Mine');
    assert.deepEqual(await panels(page), { conflict:false, reload:false });
    assert.equal(await page.evaluate(() => window.pendingSaveStatus().readOnly), false);

    // ---- a conflict that cannot be merged (the latest data cannot be read): conflict ----
    server.save = route => route.fulfill({ status:409, json:{ ok:false, message:'state revision conflict', currentRevision:stored.revision + 1 } });
    server.data = route => route.fulfill({ status:500, json:{ ok:false } });
    await edit(page, 'Sixth Buyer');
    await waitPhase(page, 'conflict');
    assert.deepEqual(await panels(page), { conflict:true, reload:false });
    assert.equal(await page.evaluate(() => flushPendingSave()), false, 'nothing is sent while read-only');
    assert.equal(await page.evaluate(() => otsSaveBlockReason()), 'conflict');
    assert.deepEqual(errors, []);
    await page.close();

    // ---- the database cannot be read: load-failed, and "read again" brings it back ----
    const broken = { data: route => route.fulfill({ status:500, json:{ ok:false, message:'database is missing' } }), save: accept };
    const second = await open(browser, broken);
    await waitPhase(second.page, 'load-failed');
    assert.equal(await second.page.evaluate(() => window.pendingSaveStatus().loaded), false);
    assert.deepEqual(await panels(second.page), { conflict:false, reload:true });
    await edit(second.page, 'Not Saved');
    assert.equal(await phase(second.page), 'load-failed');
    broken.data = route => route.fulfill({ json:stored });
    await second.page.evaluate(() => setPage('settings'));
    await second.page.locator('#macStorageReloadBtn').click();
    await waitPhase(second.page, 'idle');
    assert.deepEqual(await panels(second.page), { conflict:false, reload:false });
    assert.deepEqual(second.errors, []);

    console.log('Save phases passed: loading, idle, queued, saving, retrying, rejected, choosing, conflict, load-failed, and the way back from each.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
