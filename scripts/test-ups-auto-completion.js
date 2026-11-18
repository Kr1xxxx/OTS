const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// UPS 的单不再「发货满 5 天自动完成」（用户 2026-11-18：改成手动确认，之后接 UPS API）：
// - 启动时、每分钟的定时检查、过了一夜：UPS 批次怎么都不算送达，单留在已发货，没有记录、没有通知；
// - DHL / FedEx 查到全部签收照旧自动完成；一批 DHL 签收 + 一批 UPS 的混合单不自动完成；
// - 手动拖到已完成照样可以，已收不变；UPS 查询的说明不再提自动完成。
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.clock.install({time:new Date('2026-09-16T12:00:00+08:00')});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const order = (id, patch={}) => ({id,num:id,client:'UPS Test',stage:'shipment',amount:100,paidAmount:100,currency:'USD',createdAt:'2026-08-01',orderMonth:'2026-08',shippedAt:'2026-09-06',trackingNumber:'1Z000AA10123456780',carrier:'UPS',logisticsStatus:'已发货',logs:[],...patch});
    let stored = {app:'trade-order-system',revision:0,data:{demoCleared:true,demoCustomersCleared:true,customers:{},orders:[
      order('ten-days'), order('five-days',{shippedAt:'2026-09-11'}), order('owing',{paidAmount:40,orderType:'定金订单',depositAmount:40}),
      order('multi',{shipments:[{trackingNumber:'1Z000AA10123456780',carrier:'UPS',status:'已发货',shippedAt:'2026-09-01'},{trackingNumber:'1Z999AA10123456784',carrier:'UPS',status:'运输中',shippedAt:'2026-09-02'}]}),
      order('mixed',{shipments:[{trackingNumber:'1234567890',carrier:'DHL',status:'运输中',shippedAt:'2026-09-01'},{trackingNumber:'1Z000AA10123456780',carrier:'UPS',status:'已发货',shippedAt:'2026-09-01'}]}),
      order('dhl',{shipments:[{trackingNumber:'9876543210',carrier:'DHL',status:'运输中',shippedAt:'2026-09-01'}],trackingNumber:'9876543210',carrier:'DHL'})
    ]}};
    const errors = [];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const pathname = new URL(route.request().url()).pathname;
      if(pathname==='/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response={ok:true};
      if(pathname==='/api/data') response=stored;
      if(pathname==='/api/health') response={ok:true,storageMode:'sqlite',counts:{orders:6},backups:{sqliteCount:0}};
      if(pathname==='/api/save') {
        stored={...route.request().postDataJSON().state,revision:stored.revision+1};
        response={ok:true,revision:stored.revision,backup:{ok:true,skipped:true}};
      }
      return route.fulfill({json:response});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    await page.evaluate(()=>flushPendingSave());
    const stages = () => page.evaluate(()=>Object.fromEntries(state.orders.map(o=>[o.id,o.stage])));
    const allShipped = {'ten-days':'shipment','five-days':'shipment',owing:'shipment',multi:'shipment',mixed:'shipment',dhl:'shipment'};
    assert.deepEqual(await stages(), allShipped, 'UPS 发货满 5 天、10 天，启动时都不自动完成');
    // 过了一夜、定时检查跑过：还是不动。
    await page.clock.setSystemTime(new Date('2026-09-20T12:00:00+08:00'));
    await page.clock.runFor(60001);
    assert.deepEqual(await stages(), allShipped, '每分钟的定时检查也不再按天数完成 UPS 的单');
    const upsTrail = await page.evaluate(()=>({
      logs:state.orders.flatMap(o=>(o.logs||[]).map(log=>log.text)).filter(text=>/UPS|自动移/.test(text)),
      notices:(typeof uiNotifEvents==='function'?uiNotifEvents():[]).filter(item=>/UPS|自动移到已完成/.test(`${item.title} ${item.sub}`)||/^ups-done-/.test(item.id))
    }));
    assert.deepEqual(upsTrail,{logs:[],notices:[]},'不写 UPS 自动完成的记录和通知');
    const upsMessage = await page.evaluate(()=>queryTrackingStatusRaw('1Z000AA10123456780','UPS').then(r=>r.message));
    assert.doesNotMatch(upsMessage,/自动完成|5 天/,`UPS 查询说明不再提自动完成：${upsMessage}`);
    assert.match(upsMessage,/手动/);

    // DHL 查到已签收：只有 DHL 批次的单照旧自动完成；混合单那批 UPS 没人确认，不自动完成。
    const outcome = await page.evaluate(()=>{
      const dhl = applyTrackingResultToOrder('9876543210',{ok:true,status:'已签收',updatedAt:'2026-09-20 10:00'},'DHL');
      const mixed = applyTrackingResultToOrder('1234567890',{ok:true,status:'已签收',updatedAt:'2026-09-20 10:00'},'DHL');
      return {dhl:dhl.completed.map(item=>item.order.id),mixed:mixed.completed.map(item=>item.order.id),dhlLog:state.orders.find(o=>o.id==='dhl').logs[0]?.text||''};
    });
    assert.deepEqual(outcome.dhl,['dhl'],'DHL 全部签收照旧自动完成');
    assert.equal(outcome.dhlLog,'物流已签收，订单自动移动到已完成');
    assert.deepEqual(outcome.mixed,[],'一批 DHL 签收 + 一批 UPS：不自动完成');
    assert.equal((await stages()).mixed,'shipment');

    // 手动拖到已完成：可以，已收不变（欠着的 60 照样欠着）。
    const moved = await page.evaluate(()=>[moveOrderToStage('ten-days','done'),moveOrderToStage('owing','done')]);
    assert.deepEqual(moved,[true,true]);
    const after = await page.evaluate(()=>['ten-days','owing'].map(id=>{const o=state.orders.find(item=>item.id===id);return [o.stage,o.paidAmount,orderDueValue(o)];}));
    assert.deepEqual(after,[['done',100,0],['done',40,60]]);
    await page.evaluate(()=>flushPendingSave());
    const saved = id=>stored.data.orders.find(o=>o.id===id);
    assert.equal(saved('ten-days').stage,'done');
    assert.equal(saved('five-days').stage,'shipment');
    assert.equal(saved('multi').stage,'shipment');
    assert.deepEqual(errors,[]);
    console.log('UPS manual completion passed: no automatic completion by days on startup or on the timer, no logs or notices, DHL delivery still completes, mixed DHL + UPS waits, a manual move to 已完成 works and keeps the paid amount.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
