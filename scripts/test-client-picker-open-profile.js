const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// 订单弹窗「客户名称」下拉里每行右侧 ↗：点击要跳到客户页并打开该客户资料，而不是选中客户或没反应。
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const customers = {
      'Quesia H':{country:'🇺🇸 美国 United States', paymentChannel:'Zelle'},
      'Bob Taylor':{country:'🇬🇧 英国 United Kingdom'}
    };
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response={ok:true};
      if(pathname==='/api/data') response={app:'trade-order-system',revision:0,data:{orders:[{id:'o1',num:'K26110401',client:'Quesia H',country:'🇺🇸 美国 United States',currency:'USD',amount:200,stage:'production',productType:'睫毛',paymentChannel:'Zelle',createdAt:'2026-11-04T00:00:00Z',updated:'2026-11-04T00:00:00Z'}],customers,demoCleared:true,demoCustomersCleared:true}};
      if(pathname==='/api/health') response={ok:true,storageMode:'sqlite',counts:{orders:0},backups:{sqliteCount:0}};
      if(pathname==='/api/save') response={ok:true,revision:1,backup:{ok:true,skipped:true}};
      return route.fulfill({json:response});
    });
    // 模拟 Mac App（WKWebView / Safari）：点按钮不会把焦点给按钮，输入框直接失焦（relatedTarget 为空）。
    await page.addInitScript(()=>{
      window.addEventListener('mousedown',e=>{
        if(e.defaultPrevented || !e.target.closest?.('button')) return;
        e.preventDefault();
        document.activeElement?.blur?.();
      });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    await page.evaluate(()=>openOrderDetail('o1'));
    await page.locator('#detailEditBtn').click();
    await page.waitForFunction(()=>document.getElementById('orderModal')?.classList.contains('open'));
    const input=page.locator('#orderForm .client-picker input[name="client"]');
    // 字母筛选按钮同样不能因失焦把菜单收起。
    await input.fill('');
    await page.locator('#orderForm .client-menu [data-client-letter="B"]').click();
    assert.deepEqual(await page.locator('#orderForm .client-menu [data-select-client]').evaluateAll(n=>n.map(x=>x.dataset.selectClient)),['Bob Taylor'],'字母筛选生效');
    assert.equal(await page.locator('#orderForm .client-menu').evaluate(n=>n.classList.contains('open')),true,'字母筛选后菜单仍打开');
    await input.fill('Quesia');
    const openBtn=page.locator('#orderForm .client-menu [data-open-client="Quesia H"]');
    await openBtn.waitFor({state:'visible'});
    await openBtn.click();
    await page.waitForFunction(()=>document.getElementById('customerModal')?.classList.contains('open'), null, {timeout:3000});
    assert.equal(await page.locator('#orderModal').evaluate(n=>n.classList.contains('open')),false,'订单弹窗应关闭');
    assert.match(await page.locator('#customerModal').innerText(),/Quesia H/,'应打开 Quesia H 的客户资料');
    assert.deepEqual(errors,[]);
    console.log('client picker open-profile ok');
  } finally { await browser.close(); }
})().catch(e=>{ console.error(e); process.exit(1); });
