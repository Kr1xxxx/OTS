const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Everyday actions in one step: the new-order modal opens compact (3 sections + 展开更多, editing
// shows all), cards / the context menu / list rows offer 收齐尾款 and 推进到下一阶段 (with undo),
// entering 已发货 without a tracking number shows a small non-blocking card to add one, tasks and
// notifications open the drawer on the matching tab, and repurchase reminders can be postponed
// 7 / 30 days or turned into a new order.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const stamp = daysAgo => { const d = new Date(); d.setDate(d.getDate()-daysAgo); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    const base = {currency:'USD',logisticsStatus:'未发货',productType:'假发',orderType:'定金订单',country:'🇺🇸 美国 United States',logs:[]};
    const orders = [
      {...base,id:'o-bal',num:'K1',client:'Alice',amount:1000,paidAmount:300,stage:'balance',createdAt:stamp(1),updated:`${stamp(1)} 09:00`},
      {...base,id:'o-prod',num:'K2',client:'Bob',amount:500,paidAmount:500,stage:'production',createdAt:stamp(1),updated:`${stamp(1)} 09:00`},
      {...base,id:'o-ship',num:'K3',client:'Carl',amount:800,paidAmount:800,stage:'shipment',logisticsStatus:'已发货',shippedAt:stamp(40),createdAt:stamp(45),updated:`${stamp(40)} 09:00`}
    ];
    const customers = {Carl:{client:'Carl',repurchaseCycle:30}};
    let stored = {app:'trade-order-system',data:{orders,customers,doneTasks:{},demoCleared:true,demoCustomersCleared:true},revision:0};
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response = {ok:true};
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = {ok:true,storageMode:'sqlite',counts:{orders:3},backups:{sqliteCount:0}};
      if (pathname === '/api/ecb-rates') response = {ok:true,rates:[]};
      if (pathname === '/api/save') { stored = {...route.request().postDataJSON().state,revision:stored.revision+1}; response = {ok:true,revision:stored.revision,backup:{ok:true,skipped:true}}; }
      return route.fulfill({json:response});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    const order = id => page.evaluate(id=>{ const o = state.orders.find(x=>x.id===id); return {stage:o.stage,paidAmount:o.paidAmount,trackingNumber:o.trackingNumber||'',carrier:o.carrier||'',logisticsStatus:o.logisticsStatus,log:(o.logs[0]||{}).text||''}; }, id);
    const settle = () => page.waitForTimeout(250);

    // New order: 3 steps, folded sections hidden, 展开更多 restores all 8; editing shows everything.
    await page.evaluate(()=>openOrder(''));
    await page.waitForFunction(()=>document.querySelectorAll('#orderModal .mnav [data-jump]').length === 3);
    const compact = await page.evaluate(()=>({steps:[...document.querySelectorAll('#orderModal .mnav [data-jump]')].map(b=>b.textContent.trim()),amount:document.querySelector('#orderForm [name="amount"]').offsetParent!==null,note:document.querySelector('#orderForm [name="note"]').offsetParent!==null,toggle:document.querySelector('#orderForm [data-order-more]').offsetParent!==null}));
    assert.deepEqual(compact.steps,['1粘贴识别','2基础与金额','3产品与阶段']);
    assert.equal(compact.amount,true,'amount belongs to the merged first section');
    assert.equal(compact.note,false,'备注 is folded for a new order');
    assert.equal(compact.toggle,true);
    await page.locator('#orderForm [data-order-more]').click();
    await page.waitForFunction(()=>document.querySelectorAll('#orderModal .mnav [data-jump]').length === 8);
    assert.equal(await page.evaluate(()=>document.querySelector('#orderForm [name="note"]').offsetParent!==null),true);
    assert.equal(await page.evaluate(()=>document.querySelector('#orderForm .payment-grid').parentElement.dataset.orderSection),'payment','payment grid moves back to its own section');
    await page.evaluate(()=>closeOrder());
    await page.evaluate(()=>openOrder('o-bal'));
    await page.waitForFunction(()=>document.querySelectorAll('#orderModal .mnav [data-jump]').length === 9);
    assert.equal(await page.evaluate(()=>document.getElementById('orderForm').classList.contains('order-compact')),false,'editing an order shows every section');
    await page.evaluate(()=>closeOrder());

    // Card hover: 收齐 marks the balance paid and moves 尾款 → 生产中; undo restores both.
    await page.evaluate(()=>setPage('dashboard'));
    const card = page.locator('.board-card[data-id="o-bal"]');
    await card.hover();
    assert.deepEqual(await card.locator('.oc-act').allTextContents(),['收齐','生产中']);
    const paidBtn = await card.locator('[data-quick="paid"]').boundingBox();
    await page.mouse.click(paidBtn.x+paidBtn.width/2,paidBtn.y+paidBtn.height/2);
    await settle();
    let o = await order('o-bal');
    assert.equal(o.paidAmount,1000);
    assert.equal(o.stage,'production');
    assert.match(o.log,/收齐尾款/);
    assert.equal(await page.evaluate(()=>document.getElementById('orderDetailDrawer').classList.contains('open')),false,'a quick action must not open the drawer');
    await page.locator('.toast-undo').first().click();
    await settle();
    o = await order('o-bal');
    assert.equal(o.paidAmount,300,'undo should restore the paid amount');
    assert.equal(o.stage,'balance','undo should restore the stage');

    // Context menu carries the same two actions; 推进 from 尾款 goes to 生产中.
    await page.locator('.board-card[data-id="o-bal"]').click({button:'right'});
    const menu = await page.locator('.board-menu [role=menuitem]').allTextContents();
    assert.ok(menu.some(t=>/收齐尾款/.test(t)) && menu.some(t=>/推进到生产中/.test(t)),`menu lacks quick actions: ${menu.join('|')}`);
    await page.locator('.board-menu [data-board-menu="advance"]').click();
    await settle();
    assert.equal((await order('o-bal')).stage,'production');

    // Advancing 生产中 → 已发货 without a tracking number shows the small card; Enter saves it, carrier auto-detected.
    await page.evaluate(()=>quickAdvanceStage('o-prod'));
    await settle();
    assert.equal((await order('o-prod')).stage,'shipment');
    assert.equal(await page.locator('#trackingQuickCard').count(),1,'tracking card should appear after entering 已发货');
    assert.equal(await page.evaluate(()=>document.querySelector('.modal-backdrop.open')),null,'the tracking card must not be a blocking modal');
    await page.locator('#trackingQuickCard input').fill('1Z999AA10123456784');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>!document.getElementById('trackingQuickCard'));
    o = await order('o-prod');
    assert.equal(o.trackingNumber,'1Z999AA10123456784');
    assert.equal(o.carrier,'UPS');
    assert.equal(o.logisticsStatus,'已发货');
    assert.match(o.log,/补充运单号/);
    // 先跳过 just closes it.
    await page.evaluate(()=>{ const x = state.orders.find(i=>i.id==='o-prod'); x.trackingNumber=''; x.shipments=[]; uiTrackingQuickCard('o-prod'); });
    await page.locator('#trackingQuickCard [data-track-skip]').click();
    await page.waitForFunction(()=>!document.getElementById('trackingQuickCard'));
    assert.equal((await order('o-prod')).trackingNumber,'');

    // Order list: 操作 column offers the same quick actions and does not open the drawer.
    await page.evaluate(()=>setPage('order-list'));
    await settle();
    const rowBtn = page.locator('#orderTableBody [data-order-list-quick="advance"][data-order-list-open="o-bal"]');
    assert.equal(await rowBtn.count(),1);
    await rowBtn.click();
    await settle();
    assert.equal((await order('o-bal')).stage,'shipment');
    assert.equal(await page.evaluate(()=>document.getElementById('orderDetailDrawer').classList.contains('open')),false);
    await page.evaluate(()=>document.getElementById('trackingQuickCard')?.remove());

    // Tasks open the drawer on the matching tab; repurchase gets 推迟 / 已下单.
    await page.evaluate(()=>{ const x = state.orders.find(i=>i.id==='o-bal'); x.stage='balance'; x.paidAmount=300; x.logisticsStatus='未发货'; render(); setPage('dashboard'); });
    await settle();
    await page.locator('#taskList .task[data-task-id="payment-o-bal"] [data-task-action="open"]').click();
    await settle();
    assert.equal(await page.evaluate(()=>uiDetailTab.current),'payment','收款 task should land on the 收款 tab');
    assert.equal(await page.evaluate(()=>document.querySelector('#detailTabs [data-detail-tab-btn="payment"]').getAttribute('aria-selected')),'true');
    await page.evaluate(()=>closeOrderDetail());
    const notif = await page.evaluate(()=>uiNotifItems().find(i=>i.id==='task-payment-o-bal'));
    assert.equal(notif?.tab,'payment','notification should carry the target tab');

    const rep = page.locator('#taskList .task[data-task-id="repurchase-Carl"]');
    assert.equal(await rep.count(),1,'Carl is 40 days past shipping with a 30-day cycle');
    assert.deepEqual(await rep.locator('.task-action-btn').allTextContents(),['推迟 7 天','推迟 30 天','已下单']);
    await rep.locator('[data-task-action="snooze7"]').click();
    await settle();
    assert.equal(await page.evaluate(()=>state.customers.Carl.nextFollow),stamp(-7));
    assert.equal(await page.locator('#taskList .task[data-task-id="repurchase-Carl"]').count(),0,'postponed reminder should leave the list');
    await page.locator('.toast-undo').first().click();
    await settle();
    assert.equal(await page.locator('#taskList .task[data-task-id="repurchase-Carl"]').count(),1,'undo should bring the reminder back');
    await page.locator('#taskList .task[data-task-id="repurchase-Carl"] [data-task-action="ordered"]').click();
    await settle();
    assert.equal(await page.evaluate(()=>document.getElementById('orderModal').classList.contains('open')),true,'已下单 opens a new order');
    assert.equal(await page.locator('#orderForm [name="client"]').inputValue(),'Carl');
    await page.evaluate(()=>closeOrder());

    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Quick actions UI passed: compact new-order modal, card/menu/list 收齐 + 推进 with undo, tracking card, task deep links, repurchase postpone / ordered.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
