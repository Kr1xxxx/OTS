const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const source = 'Alice Example\n+1 2025550101\n+1 2025550102\nalice@example.com\nother@example.com\n123 Sample Road, London SW1A 1AA, United Kingdom\n客户备注: Leave at reception\nUSD 100 Paypal';
const fields = {name:'Alice Example',phones:['+1 2025550101','+1 2025550102'],emails:['alice@example.com','other@example.com'],addresses:['123 Sample Road, London SW1A 1AA, United Kingdom'],country:'United Kingdom',note:'Leave at reception'};
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1360,height:1000}});
    let release, mode = 'success', requests = 0, saves = 0;
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'trade-order-system.html'),'utf8')});
      if (pathname === '/api/data') return route.fulfill({json:{app:'trade-order-system',revision:0,data:{demoCleared:true,demoCustomersCleared:true,orders:[],customers:{}}}});
      if (pathname === '/api/ai-settings') return route.fulfill({json:{enabled:'是',provider:'custom',baseUrl:'https://fixture.example/v1',model:'fixture',apiKeySaved:true}});
      if (pathname === '/api/save') { saves++; return route.fulfill({json:{ok:true,revision:1}}); }
      if (pathname === '/api/ai-chat') {
        requests++;
        await new Promise(resolve => release = resolve);
        if (mode === 'failure') return route.fulfill({status:502,json:{message:'fixture unavailable'}});
        return route.fulfill({json:{choices:[{message:{content:JSON.stringify(fields)}}]}});
      }
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.clock.install();
    await page.evaluate(() => openCustomerModal(''));
    async function start() {
      release = undefined;
      await page.locator('#customerPasteInput').fill(source);
      await page.locator('#customerPasteAnalyzeBtn').click();
      for (let i=0;i<100 && !release;i++) await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(typeof release,'function');
    }
    async function finish() {
      release();
      await page.waitForFunction(() => !document.getElementById('customerPasteAnalyzeBtn').disabled);
    }
    await start();
    await page.clock.runFor(1400);
    assert.match(await page.locator('#customerPasteResults').innerText(),/已用时 1\.\d 秒/,'loading must show an updating elapsed timer');
    await finish();
    const completed = await page.locator('[data-customer-paste-timing]').innerText();
    assert.match(completed,/AI 识别结果 · 耗时 1\.\d 秒 · 请核对后填入/);
    await page.clock.runFor(2500);
    assert.equal(await page.locator('[data-customer-paste-timing]').innerText(),completed,'completed timer must stop');
    assert.equal(await page.locator('[data-customer-paste-edit="phones"]').count(),2,'each phone has its own edit button');
    async function edit(key,index,value,confirm=true) {
      await page.locator(`[data-customer-paste-edit="${key}"]`).nth(index).click();
      assert.equal(await page.locator('[data-customer-paste-fill]').isDisabled(),true,'unfinished draft must not be silently filled');
      await page.locator('#customerPasteEditValue').fill(value);
      await page.locator(confirm ? '[data-customer-paste-edit-confirm]' : '[data-customer-paste-edit-cancel]').click();
    }
    await edit('phones',1,'+1 2025550199',false);
    assert.match(await page.locator('[data-customer-paste-edit="phones"]').nth(1).innerText(),/0102/);
    await edit('phones',1,'+1 2025550199');
    await page.locator('[data-customer-paste-edit="emails"]').first().click();
    await page.locator('#customerPasteEditValue').dispatchEvent('keydown',{key:'Enter',isComposing:true,bubbles:true});
    assert.equal(await page.locator('#customerPasteEditValue').count(),1,'IME candidate confirmation must not save the editor');
    await page.locator('#customerPasteEditValue').fill('not-an-email');
    await page.locator('#customerPasteEditValue').press('Enter');
    assert.match(await page.locator('[data-customer-paste-edit-error]').innerText(),/完整邮箱/);
    await page.locator('#customerPasteEditValue').press('Escape');
    assert.match(await page.locator('[data-customer-paste-edit="emails"]').first().innerText(),/alice@example.com/);
    await edit('emails',0,'mailto:corrected@example.com');
    await edit('name',0,'Alice Corrected');
    await edit('addresses',0,'456 Corrected Road\nLondon SW1A 1AA');
    await page.locator('[data-customer-paste-edit="addresses"]').click();
    await page.locator('#customerPasteEditValue').press('End');
    await page.locator('#customerPasteEditValue').press('Enter');
    assert.equal(await page.locator('#customerPasteEditValue').count(),1,'Enter in a multiline address must not confirm or submit');
    await page.locator('#customerPasteEditValue').press('Escape');
    await edit('note',0,'<img src=x onerror=alert(1)>\nCorrected note');
    assert.equal(await page.locator('#customerPasteResults img').count(),0,'manual text must remain escaped');
    assert.equal(requests,1,'editing must not request AI again');
    assert.equal(await page.locator('#customerForm [name="name"]').inputValue(),'','preview edits must not modify form');
    await page.locator('[data-customer-paste-fill]').click();
    assert.equal(await page.locator('#customerForm [name="name"]').inputValue(),'Alice Corrected');
    assert.deepEqual(await page.locator('#customerForm [data-customer-multi-kind="phones"] [data-customer-multi-input]').evaluateAll(inputs=>inputs.map(i=>i.value)),['+1 2025550101','+1 2025550199']);
    assert.deepEqual(await page.locator('#customerForm [data-customer-multi-kind="emails"] [data-customer-multi-input]').evaluateAll(inputs=>inputs.map(i=>i.value)),['corrected@example.com','other@example.com']);
    assert.equal(await page.locator('#customerForm [name="address"]').inputValue(),'456 Corrected Road\nLondon SW1A 1AA');
    assert.equal(saves,0);
    if (process.env.UI_SCREENSHOT) {
      for (const theme of ['light','dark']) {
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        await page.locator('[data-customer-paste-edit="addresses"]').click();
        await page.locator('#customerPasteResults').screenshot({path:`${process.env.UI_SCREENSHOT}.${theme}.png`});
        await page.locator('#customerPasteEditValue').press('Escape');
      }
      await page.setViewportSize({width:390,height:844});
      await page.locator('[data-customer-paste-edit="emails"]').first().click();
      await page.locator('#customerPasteResults').screenshot({path:`${process.env.UI_SCREENSHOT}.mobile.png`});
      assert.equal(await page.locator('#customerPasteResults').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'mobile preview must not overflow');
      await page.locator('#customerPasteEditValue').press('Escape');
      await page.setViewportSize({width:1360,height:1000});
    }
    await edit('emails',1,'');
    assert.equal(await page.locator('[data-customer-paste-edit="emails"]').count(),1,'clearing one item removes only that item');
    await page.locator('[data-customer-paste-create-customer-order]').click();
    assert.equal(await page.locator('#combinedCustomerForm [name="name"]').inputValue(),'Alice Corrected','combined review must use edited preview, not reparse raw name');
    await page.evaluate(()=>{closeCombinedCustomerOrderModal();openCustomerModal('');});
    await start(); await finish();
    await page.evaluate(()=>{state.customers['Bob Existing']={name:'Bob Existing',phone:'+1 2025550190',address:'Old Address',country:'United States'};});
    await edit('name',0,'Bob Existing');
    assert.equal(await page.locator('[data-customer-paste-create-customer-order]').count(),0,'corrected existing identity must not silently merge through new-customer combined review');
    assert.match(await page.locator('#customerPasteResults').innerText(),/已有同名客户/);
    await page.locator('[data-customer-paste-edit="name"]').click();
    await page.locator('#customerPasteEditValue').fill('Discarded draft');
    await page.locator('#customerPasteClearBtn').click();
    assert.equal(await page.locator('#customerPasteEditValue').count(),0,'clear must discard editor draft');
    assert.equal(await page.locator('#customerPasteResults').innerText(),'');
    mode='failure'; await start(); await page.clock.runFor(2200); await finish();
    assert.match(await page.locator('[data-customer-paste-timing]').innerText(),/耗时 2\.\d 秒.*本地/);
    assert.equal(await page.locator('[data-customer-paste-edit="phones"]').count(),2,'fallback must split individual phone edit buttons');
    await edit('phones',1,'+1 2025550198');
    assert.match(await page.locator('[data-customer-paste-edit="phones"]').first().innerText(),/0101/);
    const failure = await page.locator('[data-customer-paste-timing]').innerText();
    await page.clock.runFor(1000);
    assert.equal(await page.locator('[data-customer-paste-timing]').innerText(),failure);
    mode='success'; await start();
    assert.match(await page.locator('#customerPasteResults').innerText(),/已用时 0\.0 秒/,'retry must reset timer');
    await page.clock.runFor(500);
    await page.locator('#customerPasteInput').fill('Different customer');
    await page.clock.runFor(1000); await finish();
    assert.equal(await page.locator('#customerPasteResults').innerText(),'','stale response must not restore timer or results');
    await start(); await page.clock.runFor(700);
    await page.evaluate(()=>closeCustomerModal()); await finish();
    assert.equal(await page.locator('#customerPasteResults').innerText(),'','close must discard results and timer');
    assert.equal(saves,0); assert.deepEqual(errors,[]);
    console.log('Customer AI preview passed: live/frozen timing, individual editing, cancel/remove, corrected fill/combined review, failure/retry and stale cleanup; no saves.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
