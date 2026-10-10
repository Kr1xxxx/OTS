const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Catches early completion, carrier/date mixups, lost persistence and fake delivery status.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.clock.install({time:new Date('2026-09-16T12:00:00+08:00')});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const order = (id, patch={}) => ({id,num:id,client:'UPS Test',stage:'shipment',amount:100,paidAmount:100,currency:'USD',createdAt:'2026-08-01',orderMonth:'2026-08',shippedAt:'2026-09-11',trackingNumber:'1Z000AA10123456780',carrier:'UPS',logisticsStatus:'已发货',logs:[],...patch});
    let stored = {app:'trade-order-system',revision:0,data:{demoCleared:true,demoCustomersCleared:true,customers:{},orders:[
      order('due'), order('young',{shippedAt:'2026-09-12'}), order('missing',{shippedAt:''}),
      order('invalid',{shippedAt:'2026-02-30'}), order('future',{shippedAt:'2026-10-01'}),
      order('missing-status-date',{shippedAt:'',logisticsStatus:'',updated:'2026-08-01 10:00'}),
      order('dhl',{carrier:'DHL',trackingNumber:'1234567890'}), order('production',{stage:'production'}),
      order('exception',{logisticsStatus:'异常'}), order('draft',{isDraft:true}),
      order('done',{stage:'done'}),
      order('mixed',{shipments:[{trackingNumber:'1Z000AA10123456780',carrier:'UPS',status:'已发货',shippedAt:'2026-09-01'},{trackingNumber:'1234567890',carrier:'DHL',status:'运输中',shippedAt:'2026-09-01'}]}),
      order('multi-young',{shipments:[{trackingNumber:'1Z000AA10123456780',carrier:'UPS',status:'已发货',shippedAt:'2026-09-01'},{trackingNumber:'1Z999AA10123456784',carrier:'UPS',status:'已发货',shippedAt:'2026-09-12'}]}),
      order('multi-due',{shipments:[{trackingNumber:'1Z000AA10123456780',carrier:'UPS',status:'已发货',shippedAt:'2026-09-01'},{trackingNumber:'1Z999AA10123456784',carrier:'UPS',status:'运输中',shippedAt:'2026-09-11'}]})
    ]}};
    const errors = [];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const pathname = new URL(route.request().url()).pathname;
      if(pathname==='/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response={ok:true};
      if(pathname==='/api/data') response=stored;
      if(pathname==='/api/health') response={ok:true,storageMode:'sqlite',counts:{orders:13},backups:{sqliteCount:0}};
      if(pathname==='/api/save') {
        stored={...route.request().postDataJSON().state,revision:stored.revision+1};
        response={ok:true,revision:stored.revision,backup:{ok:true,skipped:true}};
      }
      return route.fulfill({json:response});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    await page.evaluate(()=>flushPendingSave());
    const saved = id=>stored.data.orders.find(o=>o.id===id);
    assert.equal(saved('due').stage,'done','UPS shipment at five days must complete on startup');
    assert.equal(saved('multi-due').stage,'done');
    for(const id of ['young','missing','missing-status-date','invalid','future','dhl','exception','mixed','multi-young','draft']) assert.equal(saved(id).stage,'shipment',id);
    assert.equal(saved('production').stage,'production');
    assert.equal(saved('due').logisticsStatus,'已发货','Timer must not pretend UPS confirmed delivery');
    assert.equal(saved('due').logs.length,1);
    assert.match(saved('due').logs[0].text,/UPS.*5.*自动/);
    await page.reload();
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    await page.evaluate(()=>flushPendingSave());
    assert.equal(saved('due').logs.length,1,'Reload must not duplicate completion log');
    const dates = await page.evaluate(()=>{
      const existing = state.orders.find(o=>o.id==='young');
      const rebuilt = buildOrderFromFormData({...existing,shipments:[{trackingNumber:existing.trackingNumber,carrier:'UPS',status:'已发货'}]}, {existing});
      const added = buildOrderFromFormData({...existing,shipments:[{trackingNumber:existing.trackingNumber,carrier:'UPS',status:'已发货'},{trackingNumber:'1Z999AA10123456784',carrier:'UPS',status:'已发货'}]}, {existing});
      return [rebuilt.shipments[0].shippedAt,added.shipments[1].shippedAt];
    });
    assert.deepEqual(dates,['2026-09-12','2026-09-16'],'Editing must preserve dispatch date; new parcels start their own timer');
    // App stays open overnight: timer must complete at the next local calendar-day boundary.
    await page.evaluate(()=>openOrder('young'));
    await page.clock.setSystemTime(new Date('2026-09-17T12:00:00+08:00'));
    await page.clock.runFor(60001);
    assert.equal(await page.evaluate(()=>state.orders.find(o=>o.id==='young').stage),'shipment','Do not change an order while its edit form is open');
    await page.evaluate(()=>closeOrder());
    await page.clock.runFor(60001);
    await page.evaluate(()=>flushPendingSave());
    assert.equal(saved('young').stage,'done','Open application must check again without relaunch');
    assert.equal(saved('multi-young').stage,'done');
    await page.evaluate(()=>{macStorageReadOnly=true;state.orders.find(o=>o.id==='future').shippedAt='2026-09-01';});
    await page.clock.runFor(60001);
    assert.equal(await page.evaluate(()=>state.orders.find(o=>o.id==='future').stage),'shipment','Read-only mode must not mutate orders');
    assert.deepEqual(errors,[]);
    console.log('UPS completion passed: startup, five-day boundary, timer, persistence, multiple parcels, safety and idempotence.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
