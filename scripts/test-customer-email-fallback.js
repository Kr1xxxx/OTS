const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Catches AI omissions discarding source emails; all network and business data are isolated.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1360,height:900}});
    let saves = 0;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const source = 'Alex Example\nmailto:Buyer@example.com?subject=Order\norders+sales@example.net\nbuyer@EXAMPLE.com';
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8')});
      if (pathname === '/api/data') return route.fulfill({json:{app:'trade-order-system',revision:0,data:{demoCleared:true,demoCustomersCleared:true,orders:[],customers:{}}}});
      if (pathname === '/api/ai-settings') return route.fulfill({json:{enabled:'是',provider:'custom',baseUrl:'https://fixture.example/v1',model:'fixture',apiKeySaved:true}});
      if (pathname === '/api/ai-chat') return route.fulfill({json:{choices:[{message:{role:'assistant',content:JSON.stringify({name:'Alex Example'})}}]}});
      if (pathname === '/api/save') { saves++; return route.fulfill({json:{ok:true,revision:1}}); }
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    const normalize = (raw, text) => page.evaluate(({raw,text})=>normalizeAiCustomerFields(raw,text), {raw,text});

    const omitted = await normalize({name:'Alex Example'}, source);
    assert.deepEqual(omitted.emails,['Buyer@example.com','orders+sales@example.net'],'Source emails must survive an AI response that omits every email');
    assert.equal(omitted.email,'Buyer@example.com');
    assert.equal(omitted.phone,undefined,'Email recovery must not merge unrelated local fields');
    assert.deepEqual((await normalize({},'only@example.com')).emails,['only@example.com'],'An empty AI object must not discard an explicit source email');
    assert.deepEqual((await normalize({emails:['orders+sales@example.net']},source)).emails,['orders+sales@example.net','Buyer@example.com'],'Preserve the valid AI primary email and append omitted values without duplicates');
    assert.deepEqual((await normalize({email:'invented@example.org'},source)).emails,['Buyer@example.com','orders+sales@example.net'],'Reject fabricated AI emails before supplementing source values');
    const absent = await normalize({email:'invented@example.org'},'Alex Example\nnot-an-email\nbuyer@\n@example.com');
    assert.equal(absent.email,undefined);
    assert.equal(absent.emails,undefined,'No source email means no invented or malformed fallback');
    const payment = await normalize({paymentEmail:'pay@example.com'},'Alex Example\ncontact@example.com\nPaypal: pay@example.com');
    assert.equal(payment.paymentEmail,'pay@example.com');
    assert.deepEqual(payment.emails,['contact@example.com'],'An identified payment email must not be added as a contact email');
    const paymentOnly = await normalize({paymentEmail:'pay@example.com'},'Paypal: pay@example.com');
    assert.equal(paymentOnly.email,undefined);
    assert.equal(paymentOnly.paymentEmail,'pay@example.com');

    await page.evaluate(()=>openCustomerModal(''));
    await page.locator('#customerPasteInput').fill(source);
    await page.locator('#customerPasteAnalyzeBtn').click();
    await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
    const preview = page.locator('#customerPasteResults');
    assert.match(await preview.innerText(),/Buyer@example\.com/);
    assert.match(await preview.innerText(),/orders\+sales@example\.net/);
    assert.equal(await page.locator('#customerForm [name="email"]').inputValue(),'','Recognition must preview rather than fill or save');
    for (const [theme,width] of [['light',1360],['dark',390]]) {
      await page.setViewportSize({width,height:900});
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      if (process.env.UI_SCREENSHOT) await preview.screenshot({path:`${process.env.UI_SCREENSHOT}.${theme}.png`});
    }
    await page.setViewportSize({width:1360,height:900});
    await page.locator('[data-customer-paste-fill]').click();
    assert.deepEqual(await page.locator('#customerForm [data-customer-multi-kind="emails"] [data-customer-multi-input]').evaluateAll(nodes=>nodes.map(node=>node.value)),['Buyer@example.com','orders+sales@example.net'],'Confirmed fill must retain every unique source email');
    assert.equal(saves,0,'Recognition and fill must never save a customer automatically');
    assert.deepEqual(errors,[]);
    console.log('Customer email fallback passed: AI omission, empty object, mailto, multiple emails, case-insensitive dedupe, fabricated/malformed rejection, payment isolation, preview and explicit fill.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
