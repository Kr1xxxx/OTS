const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1200,height:800}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const stored = {app:'trade-order-system',data:{orders:[],customers:{},demoCleared:true,demoCustomersCleared:true},revision:4};
    let conflict = false;
    let loads = 0;
    let exportRequest = null;
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      if (pathname === '/api/data') { loads++; return route.fulfill({json:stored}); }
      if (pathname === '/api/health') return route.fulfill({json:{ok:true,storageMode:'sqlite',counts:{orders:0},backups:{sqliteCount:0}}});
      if (pathname === '/api/save' && conflict) return route.fulfill({status:409,json:{ok:false,message:'state revision conflict',currentRevision:7}});
      if (pathname === '/api/save') return route.fulfill({json:{ok:true,revision:stored.revision,backup:{ok:true,skipped:true}}});
      if (pathname === '/api/export-file') { exportRequest = route.request().postDataJSON(); return route.fulfill({json:{ok:true,name:exportRequest.name,path:`/Users/test/Downloads/${exportRequest.name}`}}); }
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    await page.evaluate(()=>setPage('settings'));
    const panel = page.locator('#macStorageConflictActions');
    assert.equal(await panel.isVisible(),false,'conflict actions must stay hidden until a conflict');

    conflict = true;
    await page.evaluate(()=>{state.customers['Conflict Buyer'] = {name:'Conflict Buyer'}; return window.flushPendingSave();});
    assert.equal(await page.evaluate(()=>window.pendingSaveStatus().readOnly),true,'conflict must switch to read-only');
    assert.equal(await panel.isVisible(),true,'conflict must show reload and export actions');

    // Mac App 的 WebKit 不处理 blob 下载，导出交给本地服务写进「下载」文件夹。
    await page.locator('#macConflictExportBtn').click();
    await page.waitForFunction(()=>document.getElementById('toast')?.textContent.includes('已导出到「下载」文件夹'));
    assert.match(exportRequest.name,/^trade-order-unsaved-\d+\.json$/);
    const exported = JSON.parse(exportRequest.text);
    assert.ok(exported.data.customers['Conflict Buyer'],'export must contain the unsaved local change');

    conflict = false;
    const loadsBefore = loads;
    await page.locator('#macConflictReloadBtn').click();
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded && !window.pendingSaveStatus().readOnly);
    assert.equal(loads,loadsBefore+1,'reload must fetch the latest database state');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Save conflict UI passed: conflict shows actions, export keeps unsaved changes, reload returns to writable state.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
