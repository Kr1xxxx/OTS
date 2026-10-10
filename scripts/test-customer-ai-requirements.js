const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1360,height:900}});
    let saves = 0;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const source = 'Alex Example\nContact: Alex Example; Pat Example\n+1 202 555 0101; +1 202 555 0102\nmailto:buyer@example.com; orders@example.com\nPaypal: mailto:pay@example.com\n1600 Amphitheatre Pkwy Mountain View 94043';
    const raw = {name:'Alex Example',contacts:['Alex Example','Pat Example'],phones:['+1 202 555 0101','+1 202 555 0102'],emails:['mailto:buyer@example.com','orders@example.com'],addresses:['1600 Amphitheatre Pkwy Mountain View 94043'],country:'United States',countrySource:'inferred',countryEvidence:'Mountain View',paymentEmail:'mailto:pay@example.com',paymentMethod:'Other'};
    let responseFields = raw;
    await page.route('**/*', async route => {
      const p = new URL(route.request().url()).pathname;
      if(p==='/trade-order-system.html') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'trade-order-system.html'),'utf8')});
      if(p==='/api/data') return route.fulfill({json:{app:'trade-order-system',revision:0,data:{demoCleared:true,demoCustomersCleared:true,orders:[],customers:{}}}});
      if(p==='/api/ai-settings') return route.fulfill({json:{enabled:'是',provider:'custom',baseUrl:'https://fixture.example/v1',model:'fixture',apiKeySaved:true}});
      if(p==='/api/save') { saves++; return route.fulfill({json:{ok:true,revision:1}}); }
      if(p==='/api/ai-chat') return route.fulfill({json:{choices:[{message:{content:JSON.stringify(responseFields)}}]}});
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    const normalized = await page.evaluate(({raw,source})=>normalizeAiCustomerFields(raw,source),{raw,source});
    assert.equal(normalized.paymentMethod,undefined,'unknown AI payment must not claim Alibaba');
    assert.deepEqual(normalized.phones,['+1 202 555 0101','+1 202 555 0102']);
    assert.deepEqual(normalized.emails,['buyer@example.com','orders@example.com']);
    assert.deepEqual(normalized.addresses,['1600 Amphitheatre Pkwy Mountain View 94043'],'postal-code ending must not be mistaken for an order amount');
    assert.equal(normalized.paymentEmail,'pay@example.com');
    const duplicatePhones = await page.evaluate(()=>normalizeAiCustomerFields({
      country:'United States', phones:['(202) 555-0116','+1-2025550116','+1 (202) 555 0116','+1 202 555 0117']
    }, 'United States\n(202) 555-0116\n+1-2025550116\n+1 (202) 555 0116\n+1 202 555 0117'));
    assert.deepEqual(duplicatePhones.phones,['+1-2025550116','+1 202 555 0117'],'US local and +1 representations of one number must appear once, preferring the explicit international form');
    assert.equal(duplicatePhones.phone,'+1-2025550116');
    const uncertainPhones = await page.evaluate(()=>normalizeAiCustomerFields({phones:['+44 202 555 0116','+1 202 555 0116','2025550116']},'+44 202 555 0116\n+1 202 555 0116\n2025550116'));
    assert.deepEqual(uncertainPhones.phones,['+44 202 555 0116','+1 202 555 0116','2025550116'],'without country evidence, shared suffixes must not merge international numbers');
    const invented = await page.evaluate(()=>normalizeAiCustomerFields({name:'Google',phone:'+1 202 555 0199',email:'fake@example.com',paymentEmail:'fakepay@example.com'},'1600 Amphitheatre Pkwy Mountain View 94043'));
    for(const key of ['name','phone','email','paymentEmail']) assert.equal(invented[key],undefined,`unprovided ${key} must be rejected`);
    assert.equal(await page.evaluate(()=>normalizeAiCustomerFields({name:'Apple Park'},'Apple Park, One Apple Park Way, Cupertino CA').name),'Apple Park','explicit organization names are not blacklisted');
    assert.equal(await page.evaluate(()=>normalizeAiCustomerFields({phone:'+44'},'Alex Example +44, 123 Sample Rd PR2 2LE').phone),undefined);
    assert.equal(await page.evaluate(()=>normalizeAiCustomerFields({addresses:['1600 Amphitheatre Pkwy Mountain View 94043 99999']},'1600 Amphitheatre Pkwy Mountain View 94043').address),undefined,'fabricated address digits must be rejected');
    for(const value of ['18 inch lace frontal','123 Example Street, London SW1A 1AA']) {
      assert.equal(await page.evaluate(value=>normalizeAiCustomerFields({contacts:[value]},value).contact,value),undefined,'array contacts must use scalar identity checks');
    }
    assert.equal(await page.evaluate(()=>normalizeAiCustomerFields({addresses:['Total 100 USD']},'Total 100 USD').address),undefined,'an amount followed by currency is not an address');
    assert.equal(await page.evaluate(()=>normalizeAiCustomerFields({addresses:['100 USD']},'100 USD').address),undefined);
    assert.equal(await page.evaluate(()=>normalizeAiCustomerFields({address:'123 Example Street, Springfield, IL 62704 1234'},'123 Example Street, Springfield, IL 62704-1234').address),'123 Example Street, Springfield, IL 62704 1234','ZIP+4 separator changes preserve unchanged digits');
    assert.equal(await page.evaluate(()=>normalizeAiCustomerFields({address:'1 Pariser Platz Berlin 10117'},'1 Pariser Platz Berlin 10117').address),'1 Pariser Platz Berlin 10117','international address ending in postcode is not an amount');
    const prompt = await page.evaluate(()=>aiCustomerPrompt('fixture'));
    assert.doesNotMatch(prompt,/Google|Apple/,'the removed branded example must not appear');
    assert.match(prompt,/countrySource/);
    assert.equal(await page.evaluate(()=>aiCustomerCountryMetadata({countrySource:'explicit'}, {country:normalizeCountry('Germany')},'Alex Example\nUnited Kingdom').countryInferred),true,'a different explicit country cannot establish returned-country provenance');
    assert.equal(await page.evaluate(()=>aiCustomerCountryMetadata({countrySource:'explicit'}, {country:normalizeCountry('United Kingdom')},'Alex Example +44, 123 Sample Rd PR2 2LE').countryInferred),true,'a dialing prefix is inference, not an explicit country name');
    await page.evaluate(()=>openCustomerModal(''));
    await page.locator('#customerPasteInput').fill(source);
    await page.locator('#customerPasteAnalyzeBtn').click();
    await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
    assert.match(await page.locator('#customerPasteResults').innerText(),/推断/);
    assert.match(await page.locator('#customerPasteResults').innerText(),/orders@example.com/);
    assert.doesNotMatch(await page.locator('#customerPasteResults').innerText(),/付款：阿里巴巴/);
    assert.equal(await page.locator('#customerForm [name="name"]').inputValue(),'');
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      if(process.env.UI_SCREENSHOT) await page.locator('#customerPasteResults').screenshot({path:`${process.env.UI_SCREENSHOT}.${theme}.png`});
    }
    await page.locator('[data-customer-paste-fill]').click();
    const values = kind=>page.locator(`#customerForm [data-customer-multi-kind="${kind}"] [data-customer-multi-input]`).evaluateAll(inputs=>inputs.map(input=>input.value));
    assert.deepEqual(await values('phones'),['+1 202 555 0101','+1 202 555 0102']);
    assert.deepEqual(await values('emails'),['buyer@example.com','orders@example.com']);
    assert.deepEqual(await values('contacts'),['Alex Example','Pat Example']);
    // Use the real filler with an explicit decline; only the modal decision is stubbed.
    await page.evaluate(async()=>{
      const form=document.getElementById('customerForm');
      form.elements.email.value='existing@example.com';
      appendCustomerMultiRow(form,'emails').value='pending-email';
      const original=appConfirm;
      appConfirm=async()=>({confirmed:false});
      try { await fillCustomerFieldsFromPaste({emails:['new@example.com'],email:'new@example.com',phones:['+1 202 555 0103'],phone:'+1 202 555 0103'}); }
      finally { appConfirm=original; }
    });
    assert.deepEqual(await values('emails'),['existing@example.com','orders@example.com','pending-email','new@example.com']);
    assert.deepEqual(await values('phones'),['+1 202 555 0101','+1 202 555 0102','+1 202 555 0103']);
    await page.evaluate(async()=>{
      const original=appConfirm; appConfirm=async()=>({confirmed:true});
      try { await fillCustomerFieldsFromPaste({phones:['+1 202 555 0104'],phone:'+1 202 555 0104'}); }
      finally { appConfirm=original; }
    });
    assert.deepEqual(await values('phones'),['+1 202 555 0104']);
    assert.ok((await values('emails')).includes('pending-email'),'untouched unfinished field must remain');
    responseFields = {name:'Alex Example',country:'United States',countrySource:'explicit',phones:['(202) 555-0116','+1-2025550116','+1 (202) 555 0116','+1 202 555 0117']};
    await page.evaluate(()=>{closeCustomerModal();openCustomerModal('');});
    await page.locator('#customerPasteInput').fill('Alex Example\nUnited States\n(202) 555-0116\n+1-2025550116\n+1 (202) 555 0116\n+1 202 555 0117');
    await page.locator('#customerPasteAnalyzeBtn').click();
    await page.waitForFunction(()=>!document.getElementById('customerPasteAnalyzeBtn').disabled);
    const preview = await page.locator('#customerPasteResults').innerText();
    assert.match(preview,/电话1：\s*\+1-2025550116/);
    assert.match(preview,/电话2：\s*\+1 202 555 0117/);
    assert.doesNotMatch(preview,/电话3|\(202\) 555/,'preview must show unique actual numbers, not formatting duplicates');
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      if(process.env.UI_SCREENSHOT) await page.locator('#customerPasteResults').screenshot({path:`${process.env.UI_SCREENSHOT}.phones.${theme}.png`});
    }
    await page.locator('[data-customer-paste-fill]').click();
    assert.deepEqual(await values('phones'),['+1-2025550116','+1 202 555 0117'],'filling the preview must keep two distinct phones without duplicates');
    assert.equal(saves,0);
    assert.deepEqual(errors,[]);
    console.log('Customer AI requirements passed: source validation, arrays, inferred-country preview, safe fill, no auto-save.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
