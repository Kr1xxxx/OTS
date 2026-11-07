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
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
    await page.evaluate(()=>{state.customers['Conflict Buyer'] = {name:'Conflict Buyer'}; return window.flushPendingSave();});
    assert.equal(await page.evaluate(()=>window.pendingSaveStatus().readOnly),true,'conflict must switch to read-only');
    assert.equal(await panel.isVisible(),true,'conflict must show reload and export actions');
    // 冲突当场弹页面内确认框（不是 window.confirm），说中文，把「导出这次的修改」放到眼前；服务端的英文原文不给人看。
    await page.waitForFunction(()=>document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.locator('#confirmTitle').innerText(),'另一个窗口刚保存过数据');
    assert.equal(await page.locator('#confirmOkBtn').innerText(),'导出这次的修改');
    const visibleText = await page.evaluate(()=>document.getElementById('confirmModal').innerText + document.getElementById('toast').innerText + document.getElementById('macStorageStatusText').innerText);
    assert.doesNotMatch(visibleText,/state revision conflict/,'English server message leaked to the UI');
    assert.doesNotMatch(await page.locator('#toast').innerText(),/请重试/,'a conflict must not ask to retry');
    // 「稍后处理」只关掉确认框，不重新加载、不丢修改。
    const loadsBeforeLater = loads;
    await page.locator('#confirmCancelBtn').click();
    await page.waitForFunction(()=>!document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(loads,loadsBeforeLater,'「稍后处理」 must not reload');
    // 只读时再保存：说清楚是另一个窗口保存过，而不是「数据库连接」问题，并再次给出导出入口。
    assert.equal(await page.evaluate(()=>canSubmitStoredData()),false);
    await page.waitForFunction(()=>document.getElementById('confirmModal').classList.contains('open'));
    assert.doesNotMatch(await page.locator('#toast').innerText(),/恢复数据库连接/);
    // 确认框里直接导出：导出成功后再问要不要重新加载，选「稍后」不重新加载。
    await page.locator('#confirmOkBtn').click();
    await page.waitForFunction(()=>document.getElementById('confirmTitle').textContent === '已导出这次的修改');
    assert.ok(JSON.parse(exportRequest.text).data.customers['Conflict Buyer'],'dialog export must contain the unsaved local change');
    exportRequest = null;
    await page.locator('#confirmCancelBtn').click();
    await page.waitForFunction(()=>!document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(loads,loadsBeforeLater,'「稍后」 must not reload');
    // 失败提示不能是绿色对勾。
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#toast .toast-item.is-success')].filter(item=>/保存|只读|冲突/.test(item.textContent)).length),0,'save failure toasts must not use the success style');
    assert.deepEqual(dialogs,[],'native dialogs are not allowed');

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
