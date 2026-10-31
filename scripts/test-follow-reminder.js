const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Follow-up reminders: 假发 orders after 3 idle days, 睫毛 after 7, one task per order, none for
// shipped / done orders. 完成 silences the task until the order changes again. The notification
// panel no longer mirrors every task: only 加急 / 收款 / 最晚发货 / 物流风险 show up there, once each.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const stamp = daysAgo => { const d = new Date(); d.setDate(d.getDate()-daysAgo); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    const order = (id, productType, daysAgo, extra = {}) => ({id,num:id,client:`客户${id}`,country:'',productType,amount:100,paidAmount:0,currency:'USD',orderType:'定金订单',stage:'quote',logisticsStatus:'未发货',createdAt:stamp(daysAgo),orderMonth:stamp(daysAgo).slice(0,7),updated:`${stamp(daysAgo)} 09:00`,logs:[],...extra});
    const orders = [
      order('wig2','假发',2),
      order('wig3','假发',3),
      order('lash6','睫毛',6),
      order('lash7','睫毛',7),
      order('done30','假发',30,{stage:'done'}),
      order('ship30','假发',30,{stage:'shipment',trackingNumber:'',logisticsStatus:'已发货'}),
      order('due','假发',1,{stage:'balance',amount:500,paidAmount:200})
    ];
    const stored = {app:'trade-order-system',data:{orders,customers:{},doneTasks:{},demoCleared:true,demoCustomersCleared:true},revision:0};
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response = {ok:true};
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = {ok:true,storageMode:'sqlite',counts:{orders:orders.length},backups:{sqliteCount:0}};
      if (pathname === '/api/ecb-rates') response = {ok:true,rates:[]};
      if (pathname === '/api/save') response = {ok:true,revision:stored.revision+1,backup:{ok:true,skipped:true}};
      return route.fulfill({json:response});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    const follows = () => page.evaluate(()=>buildTaskItems().filter(t=>t.type==='follow').map(t=>t.id).sort());

    assert.deepEqual(await follows(),['follow-lash7','follow-wig3'],'only orders idle for 3 (假发) / 7 (睫毛) days get a follow-up, never done / shipped ones');
    const task = await page.evaluate(()=>buildTaskItems().find(t=>t.id==='follow-wig3'));
    assert.match(task.reason,/3 天没有新动态/);
    assert.equal(task.date,stamp(0),'due date is the idle threshold, not today + another cycle');

    // 完成 silences it; a later update to the order brings it back once idle again.
    await page.evaluate(()=>handleTaskAction('done',{dataset:{taskId:'follow-wig3'}}));
    assert.deepEqual(await follows(),['follow-lash7'],'完成 should hide the follow-up');
    assert.deepEqual(await page.evaluate(()=>Object.keys(state.doneTasks)),[`follow-wig3-${stamp(3)} 09:00`],'done is keyed by the order\'s last update');
    await page.evaluate(stamp=>{ state.orders.find(o=>o.id==='wig3').updated = `${stamp} 10:00`; }, stamp(5));
    assert.deepEqual(await follows(),['follow-lash7','follow-wig3'],'a changed order starts a fresh follow-up');
    await page.evaluate(stamp=>{ state.orders.find(o=>o.id==='wig3').updated = `${stamp} 10:00`; }, stamp(1));
    assert.deepEqual(await follows(),['follow-lash7'],'a freshly updated order is not nagged');

    // Task list shows the follow-ups; the notification panel only carries alerting tasks, each once.
    await page.evaluate(()=>render());
    assert.ok(await page.locator('#taskList [data-task-id="follow-lash7"]').count(),'follow-up missing from the task list');
    const notif = await page.evaluate(()=>uiNotifItems().filter(i=>i.id.startsWith('task-')).map(i=>i.id));
    assert.deepEqual(notif,['task-payment-due'],`notifications should only carry alerting tasks, got ${notif.join(',')}`);

    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Follow reminder passed: 3/7-day idle rule, one task per order, done keyed to the last update, notifications only carry alerting tasks.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
