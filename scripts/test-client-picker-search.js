const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Exercises the actual input, menu, letter filters and selection without business-data writes.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1200,height:800}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const customers = {
      'Alice Baker':{country:'🇺🇸 美国 United States'},
      'Bob Taylor':{country:'🇺🇸 美国 United States'},
      'Carol Smith':{country:'🇬🇧 英国 United Kingdom'},
      'Dora Klein':{country:'🇦🇹 奥地利 Austria'},
      'Eleanor Example':{country:'🇳🇱 荷兰 Netherlands'},
      'Eva Reed':{country:'🇦🇺 澳大利亚 Australia'},
      'José García':{country:'🇪🇸 西班牙 Spain'}
    };
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response={ok:true};
      if(pathname==='/api/data') response={app:'trade-order-system',revision:0,data:{orders:[],customers,demoCleared:true,demoCustomersCleared:true}};
      if(pathname==='/api/health') response={ok:true,storageMode:'sqlite',counts:{orders:0},backups:{sqliteCount:0}};
      if(pathname==='/api/save') response={ok:true,revision:1,backup:{ok:true,skipped:true}};
      return route.fulfill({json:response});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    await page.locator('#newOrderBtn').click();
    const input=page.locator('#orderForm .client-picker input[name="client"]');
    const choices=page.locator('#orderForm .client-menu [data-select-client]');
    const cases=[
      ['美国',['Alice Baker','Bob Taylor']],
      ['United States',['Alice Baker','Bob Taylor']],
      ['US',['Alice Baker','Bob Taylor']],
      ['usa',['Alice Baker','Bob Taylor']],
      ['英国',['Carol Smith']], ['UK',['Carol Smith']],
      ['西班牙',['José García']], ['España',['José García']], ['ES',['José García']],
      ['Austria',['Dora Klein']], ['Australia',['Eva Reed']],
      ['ali',['Alice Baker']], ['jose',['José García']],
      ['Alice US',['Alice Baker']], ['Alice 英国',[]], ['不存在的国家',[]],
      ['',Object.keys(customers)]
    ];
    for(const [query,expected] of cases){
      await input.fill(query);
      assert.deepEqual(await choices.evaluateAll(nodes=>nodes.map(n=>n.dataset.selectClient)),expected,`Picker query: ${query}`);
    }
    await page.locator('#orderForm [data-client-letter="A"]').click();
    assert.equal(await choices.count(),1);
    await input.fill('英国');
    assert.deepEqual(await choices.evaluateAll(nodes=>nodes.map(n=>n.dataset.selectClient)),['Carol Smith'],'Country search resets old letter filter');
    await input.press('Tab');
    assert.equal(await page.locator('#orderForm [name="country"]').inputValue(),'🇺🇸 美国 United States','Search text must not overwrite country before customer selection');
    await page.locator('#orderForm .client-trigger').click();
    await choices.first().click();
    assert.equal(await input.inputValue(),'Carol Smith','Selection must insert customer name, not country query');
    assert.equal(await page.locator('#orderForm [name="country"]').inputValue(),'🇬🇧 英国 United Kingdom');
    assert.equal(await page.locator('#orderForm .client-menu').evaluate(el=>el.classList.contains('open')),false);
    assert.deepEqual(errors,[]);
    console.log('Customer picker search passed: country names/aliases, accents, names, combined filters, letter reset and selection.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
