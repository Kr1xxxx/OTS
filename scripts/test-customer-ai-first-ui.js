const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const input = 'Alex Example +44, 123 Sample Rd, Sample Road 123, PR2 2LE, Preston, England, United Kingdom';
const address = '123 Sample Rd, Sample Road 123, PR2 2LE, Preston, England, United Kingdom';
(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1360, height:900 } });
    let mode = 'success', requests = 0, saves = 0, release;
    const errors=[]; page.on('pageerror', error=>errors.push(error.message));
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:fs.readFileSync(path.join(root,'trade-order-system.html'),'utf8') });
      if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system',revision:0,data:{ demoCleared:true,demoCustomersCleared:true,orders:[],customers:{} } } });
      if (pathname === '/api/ai-settings') return route.fulfill({ json:{ enabled:'是',provider:'custom',baseUrl:'https://fixture.example/v1',model:'fixture',apiKeySaved:true } });
      if (pathname === '/api/save') { saves++; return route.fulfill({ json:{ok:true,revision:1} }); }
      if (pathname === '/api/ai-chat') {
        requests++;
        if(mode==='deferred') await new Promise(resolve=>release=resolve);
        if(mode==='failure') return route.fulfill({status:502,json:{ok:false,message:'fixture model unavailable'}});
        const fields = mode==='empty' ? {} : mode==='malformed' ? {name:{first:'Alex',last:'Example'}} : mode==='blank' ? {name:'   ',address:'  '} : { name:'Alex Example',country:'United Kingdom',address,phone:'+44' };
        return route.fulfill({json:{choices:[{message:{role:'assistant',content:JSON.stringify(fields)}}]}});
      }
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    await page.evaluate(()=>openCustomerModal(''));
    await page.locator('#customerPasteInput').fill(input);
    await page.locator('#customerPasteAnalyzeBtn').click();
    await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
    assert.equal(requests,1,'primary recognition must call AI');
    assert.equal(await page.locator('#customerForm [name="name"]').inputValue(),'','recognition only previews before confirmation');
    assert.match(await page.locator('#customerPasteResults').innerText(),/AI/);
    await page.locator('[data-customer-paste-fill]').click();
    assert.equal(await page.locator('#customerForm [name="name"]').inputValue(),'Alex Example');
    assert.equal(await page.locator('#customerForm [name="phone"]').inputValue(),'','country code alone is not a phone');
    assert.equal(await page.locator('#customerForm [name="address"]').inputValue(),address);
    assert.equal(saves,0,'recognition and fill must not save a customer');
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      if(process.env.UI_SCREENSHOT) await page.locator('#customerPasteResults').screenshot({path:`${process.env.UI_SCREENSHOT}.${theme}.png`});
    }
    await page.evaluate(()=>{closeCustomerModal();openCustomerModal('');});
    await page.locator('#customerPasteInput').fill(input);
    mode='failure';
    await page.locator('#customerPasteAnalyzeBtn').click();
    await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
    assert.match(await page.locator('#customerPasteResults').innerText(),/本地/);
    assert.match(await page.locator('#customerPasteResults').innerText(),/Alex Example/);
    mode='empty';
    await page.locator('#customerPasteAnalyzeBtn').click();
    await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
    assert.match(await page.locator('#customerPasteResults').innerText(),/本地/,'empty AI JSON must visibly fall back');
    for(const invalid of ['malformed','blank']) {
      mode=invalid;
      await page.locator('#customerPasteAnalyzeBtn').click();
      await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
      assert.match(await page.locator('#customerPasteResults').innerText(),/本地/,`${invalid} AI fields must fall back`);
      assert.doesNotMatch(await page.locator('#customerPasteResults').innerText(),/\[object Object\]/);
    }
    const before=requests;
    await page.locator('#customerPasteAiBtn').click();
    assert.equal(requests,before,'local button must work without an AI call');
    mode='success';
    await page.locator('#customerPasteAnalyzeBtn').click();
    await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
    await page.locator('#customerPasteInput').fill('Alice Example\n123 Sample Road\nLondon SW1A 1AA\nUnited Kingdom');
    assert.equal(await page.locator('[data-customer-paste-fill]').count(),0,'editing source must invalidate completed result');
    assert.equal(await page.locator('#customerForm [name="name"]').inputValue(),'');
    await page.locator('#customerPasteInput').fill(input);
    mode='deferred';
    await page.locator('#customerPasteAnalyzeBtn').click();
    await page.waitForFunction(()=>document.getElementById('customerPasteAnalyzeBtn').disabled);
    for(let i=0;i<50&&!release;i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(typeof release,'function');
    await page.locator('#customerPasteInput').fill('Alice Example\n123 Sample Road\nLondon SW1A 1AA\nUnited Kingdom');
    assert.equal(await page.locator('#customerPasteResults').innerText(),'','editing pending input must clear obsolete loading state');
    await page.locator('#customerPasteClearBtn').click();
    release();
    await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
    assert.equal(await page.locator('#customerPasteResults').innerText(),'','cleared input must reject late results');
    release=undefined;
    await page.locator('#customerPasteInput').fill(input);
    await page.locator('#customerPasteAnalyzeBtn').click();
    for(let i=0;i<50&&!release;i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(typeof release,'function');
    await page.evaluate(()=>closeCustomerModal());
    release();
    await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
    assert.equal(await page.locator('#customerPasteResults').textContent(),'','closed dialog must discard late results');
    assert.equal(saves,0);
    assert.deepEqual(errors,[]);
    console.log('Customer AI-first UI passed: default AI, explicit fill, incomplete phone, local fallback, empty output and stale response.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
