const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Moving an order to 已发货 / 已完成 also marks the balance paid and the shipment sent.
// Undo must put those back, not only the stage. Also covers the calendar agenda and
// the amount chart axis on an empty month.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
    const day = n => `${month}-${String(n).padStart(2,'0')}`;
    const order = {id:'o-undo',num:'SO-UNDO-1',client:'Undo Buyer',amount:1000,paidAmount:300,currency:'USD',orderType:'定金订单',stage:'production',logisticsStatus:'未发货',createdAt:day(1),orderMonth:month,updated:`${day(1)} 09:00`,logs:[]};
    // Enough orders this month that the agenda has more than 20 entries.
    const filler = Array.from({length:24},(_,i)=>({id:`o-f${i}`,num:`SO-F${i}`,client:`Filler ${i}`,amount:100,currency:'USD',stage:'quote',createdAt:day(1+(i%27)),orderMonth:month,updated:`${day(1)} 09:00`,logs:[]}));
    let stored = {app:'trade-order-system',data:{orders:[order,...filler],customers:{},demoCleared:true,demoCustomersCleared:true,depositBalanceMigrated:true},revision:0};
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response = {ok:true};
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = {ok:true,storageMode:'sqlite',counts:{orders:1},backups:{sqliteCount:0}};
      if (pathname === '/api/ecb-rates') response = {ok:true,rates:[]};
      if (pathname === '/api/save') {
        const body = route.request().postDataJSON();
        stored = {...body.state,revision:stored.revision+1};
        response = {ok:true,revision:stored.revision,backup:{ok:true,skipped:true}};
      }
      return route.fulfill({json:response});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    const snapshot = () => page.evaluate(()=>{ const o = state.orders.find(item=>item.id==='o-undo'); return {stage:o.stage,paidAmount:o.paidAmount,logisticsStatus:o.logisticsStatus,shippedAt:o.shippedAt||'',logisticsUpdated:o.logisticsUpdated||''}; });
    const before = await snapshot();

    await page.evaluate(()=>openOrderDetail('o-undo'));
    await page.locator('#detailStageBar [data-detail-stage="shipment"]').click();
    const moved = await snapshot();
    assert.equal(moved.stage,'shipment');
    assert.equal(moved.paidAmount,1000,'entering 已发货 should mark the balance as paid');
    assert.equal(moved.logisticsStatus,'已发货');

    await page.locator('.toast-undo').first().click();
    assert.deepEqual(await snapshot(),before,'undo left the auto-filled payment or shipment behind');
    assert.match(await page.locator('#orderDetailBody').textContent(),/待收/,'drawer still shows the order as fully paid after undo');
    await page.evaluate(()=>window.flushPendingSave());
    const saved = stored.data.orders.find(item=>item.id==='o-undo');
    assert.equal(saved.paidAmount,300,'undone payment was not saved');
    assert.equal(saved.stage,'production');
    assert.equal(stored.data.depositBalanceMigrated,true,'the one-time 尾款 migration flag was not saved');

    // A manual edit made before undo is kept: only the move's own changes are reverted.
    await page.evaluate(()=>moveOrderToStage('o-undo','done'));
    await page.evaluate(()=>{ state.orders.find(item=>item.id==='o-undo').logisticsStatus = '已签收'; });
    await page.locator('.toast-undo').first().click();
    const partial = await snapshot();
    assert.equal(partial.stage,'production');
    assert.equal(partial.paidAmount,300);
    assert.equal(partial.logisticsStatus,'已签收','undo overwrote a field edited after the move');

    // Old data: a deposit order parked in 生产中 with only the deposit paid moves to 尾款 once.
    const migrated = await page.evaluate(()=>{
      const legacy = {id:'o-legacy',num:'SO-L',client:'Legacy',amount:1000,paidAmount:400,currency:'USD',orderType:'定金订单',stage:'production',logs:[]};
      const fresh = normalizeState({orders:[legacy,{...legacy,id:'o-paid',num:'SO-P',paidAmount:1000},{...legacy,id:'o-full',num:'SO-Q',orderType:'全款订单'}],demoCleared:true});
      const movedBack = normalizeState({...fresh,orders:fresh.orders.map(o=>({...o,stage:'production'}))});
      return {stages:fresh.orders.map(o=>o.stage),log:fresh.orders[0].logs[0]?.text || '',again:movedBack.orders[0].stage};
    });
    assert.deepEqual(migrated.stages,['balance','production','production'],'only deposit orders with the balance still due move to 尾款');
    assert.match(migrated.log,/归入尾款/);
    assert.equal(migrated.again,'production','a manual move back to 生产中 was undone on the next load');

    await page.evaluate(()=>{ closeOrderDetail(); setPage('calendar'); });
    const agenda = await page.evaluate(()=>({events:calendarEventsForMonth(activeCalendarMonth).length,rows:document.querySelectorAll('#calendarAgenda .agenda-row').length}));
    assert(agenda.events > 20,`fixture should produce more than 20 agenda entries, got ${agenda.events}`);
    assert.equal(agenda.rows,agenda.events,'calendar agenda hides entries beyond the first 20');

    await page.evaluate(()=>{ state.orders = []; setPage('amount'); render(); });
    const ticks = await page.locator('#amountChart .chart-axis-y').allTextContents();
    assert.equal(new Set(ticks).size,ticks.length,`empty chart repeats y-axis ticks: ${ticks.join(' ')}`);
    assert.equal(await page.locator('#amountMonth option[value="all"]').textContent(),'跟随图表范围');

    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Stage undo UI passed: undo restores payment and shipment, keeps later edits, saves; agenda shows every entry; empty chart axis is unique.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
