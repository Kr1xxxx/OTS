#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// PM review P1 batch C: the notification panel carries events only (save failures, API errors,
// logistics status changes, Feishu results, new versions) and never tasks; the order drawer has a
// 文案 menu that copies an English status / payment reminder from editable templates and logs it;
// customer level thresholds are editable in 设置 → 客户设置 and persist with the data file.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const stamp = daysAgo => { const d = new Date(); d.setDate(d.getDate()-daysAgo); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    const base = {currency:'USD',logisticsStatus:'未发货',productType:'假发',orderType:'定金订单',country:'🇺🇸 美国 United States',logs:[]};
    const orders = [
      {...base,id:'o-due',num:'K1',client:'Alice Chen',amount:1000,paidAmount:300,stage:'balance',createdAt:stamp(1),updated:`${stamp(1)} 09:00`},
      {...base,id:'o-ship',num:'K2',client:'Bob',amount:800,paidAmount:800,stage:'shipment',logisticsStatus:'已发货',trackingNumber:'871032796510',carrier:'FedEx',shippedAt:stamp(2),createdAt:stamp(5),updated:`${stamp(2)} 09:00`},
      {...base,id:'o-big',num:'K3',client:'Carol',amount:25000,paidAmount:25000,stage:'done',createdAt:stamp(30),updated:`${stamp(20)} 09:00`},
      {...base,id:'o-d1',num:'K4',client:'Dana',amount:1500,paidAmount:1500,stage:'done',createdAt:stamp(60),updated:`${stamp(50)} 09:00`},
      {...base,id:'o-d2',num:'K5',client:'Dana',amount:1600,paidAmount:1600,stage:'done',createdAt:stamp(30),updated:`${stamp(20)} 09:00`}
    ];
    let stored = {app:'trade-order-system',data:{orders,customers:{},doneTasks:{},demoCleared:true,demoCustomersCleared:true},revision:0};
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response = {ok:true};
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = {ok:true,storageMode:'sqlite',counts:{orders:5},backups:{sqliteCount:0}};
      if (pathname === '/api/ecb-rates') response = {ok:true,rates:[]};
      if (pathname === '/api/save') { stored = {...route.request().postDataJSON().state,revision:stored.revision+1}; response = {ok:true,revision:stored.revision,backup:{ok:true,skipped:true}}; }
      return route.fulfill({json:response});
    });
    const load = async () => {
      await page.goto('http://127.0.0.1:47999/trade-order-system.html');
      await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
      await page.evaluate(()=>{ window.__copied = ''; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:text=>{ window.__copied = text; return Promise.resolve(); }}}); });
    };
    await load();
    const settle = () => page.waitForTimeout(250);
    const notifIds = () => page.evaluate(()=>uiNotifItems().map(i=>i.id));

    // 1. Notifications never carry tasks, even though o-due has an open balance task.
    assert.ok(await page.evaluate(()=>buildTaskItems().some(t=>t.type==='payment')),'fixture should produce a payment task');
    assert.equal((await notifIds()).some(id=>id.startsWith('task-')),false,'tasks must stay out of the notification panel');

    // 2. Logistics status change → one event, deduped; 已签收 is a success event and the order completes.
    await page.evaluate(()=>{ applyTrackingResultToOrder('871032796510',{ok:true,status:'运输中',checkedAt:nowText()}); applyTrackingResultToOrder('871032796510',{ok:true,status:'运输中',checkedAt:nowText()}); });
    let events = await page.evaluate(()=>uiNotifEvents());
    const transit = events.filter(e=>e.pill==='物流');
    assert.equal(transit.length,1,`logistics change should log exactly one event, got ${JSON.stringify(transit)}`);
    assert.equal(transit[0].kind,'info');
    assert.equal(transit[0].tab,'logistics');
    assert.equal(transit[0].orderId,'o-ship');
    assert.match(transit[0].title,/「已发货」变为「运输中」/);
    await page.evaluate(()=>applyTrackingResultToOrder('871032796510',{ok:true,status:'已签收',checkedAt:nowText()}));
    events = await page.evaluate(()=>uiNotifEvents());
    assert.equal(events.filter(e=>e.pill==='物流').length,2);
    assert.equal(events.at(-1).kind,'success');
    assert.equal(await page.evaluate(()=>state.orders.find(o=>o.id==='o-ship').stage),'done');

    // 3. Feishu failure and a new version are events too; same id never repeats.
    await page.evaluate(()=>applyOrderNotificationResult('o-due',{status:'failed',error:'网络超时'}));
    await page.evaluate(()=>{ otsAppUpdateStatus({state:'available',version:'4.00'}); otsAppUpdateStatus({state:'available',version:'4.00'}); });
    events = await page.evaluate(()=>uiNotifEvents());
    const feishu = events.find(e=>e.pill==='飞书');
    assert.equal(feishu?.kind,'error');
    assert.equal(feishu?.tab,'records');
    assert.match(feishu?.sub||'',/Alice Chen · K1 · 网络超时/);
    assert.equal(events.filter(e=>e.id==='update-4.00').length,1,'version event must be logged once');

    // 4. Events survive a reload and render as cards; a logistics card opens the drawer on 物流.
    await load();
    await page.evaluate(()=>uiToggleNotifs(true));
    await settle();
    const cards = await page.evaluate(()=>[...document.querySelectorAll('#notifList .notif-card')].map(el=>({id:el.dataset.notifId,tab:el.dataset.tab})));
    assert.ok(cards.some(c=>c.id==='update-4.00'),'version event should survive a reload');
    assert.ok(cards.some(c=>c.id.startsWith('logistics-o-ship-')),'logistics event should survive a reload');
    assert.equal(cards.some(c=>c.id.startsWith('task-')),false);
    const panelTitles = await page.evaluate(()=>[...document.querySelectorAll('#notifList .notif-card b')].map(el=>el.textContent));
    assert.ok(panelTitles.some(t=>t.includes('发现新版本 V4.00')),panelTitles.join(' | '));
    await page.locator('#notifList .notif-card[data-notif-id^="logistics-o-ship-"]').first().click();
    await settle();
    assert.equal(await page.evaluate(()=>document.getElementById('orderDetailDrawer').classList.contains('open')),true,'event card should open the order');
    assert.equal(await page.evaluate(()=>uiDetailTab.current),'logistics');
    await page.evaluate(()=>closeOrderDetail());

    // 5. 文案 menu: 催款 copies the dunning template with the real balance and logs a follow-up.
    await page.evaluate(()=>openOrderDetail('o-due'));
    await settle();
    await page.locator('#detailCopyTextBtn').click();
    assert.equal(await page.locator('#detailCopyMenu').isVisible(),true);
    assert.equal(await page.locator('#detailCopyMenu [data-copy-text="dunning"]').isDisabled(),false);
    await page.locator('#detailCopyMenu [data-copy-text="dunning"]').click();
    await settle();
    let copied = await page.evaluate(()=>window.__copied);
    assert.match(copied,/^Hi Alice Chen,/);
    assert.match(copied,/order K1 has an outstanding balance of \$700 USD \(total \$1,000 USD, received \$300 USD\)/);
    assert.match(copied,/we will arrange shipment right away\./);
    assert.equal(await page.locator('#detailCopyMenu').isVisible(),false,'menu closes after copying');
    assert.equal(await page.locator('#detailCopyTextBtn').textContent(),'已复制');
    assert.match(await page.evaluate(()=>state.orders.find(o=>o.id==='o-due').logs[0].text),/^复制催款文案（待收 \$700 USD）/);
    assert.ok(await page.locator('#orderDetailBody [data-detail-tab="records"]').textContent().then(t=>t.includes('复制催款文案')),'records tab should show the copy right away');
    await page.waitForFunction(()=>document.getElementById('detailCopyTextBtn').textContent==='文案');
    // Esc closes only the menu, not the drawer.
    await page.locator('#detailCopyTextBtn').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#detailCopyMenu').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.getElementById('orderDetailDrawer').classList.contains('open')),true,'Esc with the menu open must not close the drawer');
    await page.evaluate(()=>closeOrderDetail());

    // Status copy: tracking line present for the shipped order, 催款 disabled when nothing is due.
    await page.evaluate(()=>openOrderDetail('o-ship'));
    await settle();
    await page.locator('#detailCopyTextBtn').click();
    assert.equal(await page.locator('#detailCopyMenu [data-copy-text="dunning"]').isDisabled(),true,'no balance → no 催款');
    await page.locator('#detailCopyMenu [data-copy-text="status"]').click();
    await settle();
    copied = await page.evaluate(()=>window.__copied);
    assert.match(copied,/Status: Shipped\n/,'shipped + 已发货 collapses to one word');
    assert.match(copied,/Tracking: FedEx 871032796510/);
    assert.match(copied,/Total \$800 USD · Received \$800 USD · Balance \$0 USD/);
    await page.evaluate(()=>closeOrderDetail());
    // No tracking → the Tracking line is dropped entirely.
    await page.evaluate(()=>openOrderDetail('o-due'));
    await page.locator('#detailCopyTextBtn').click();
    await page.locator('#detailCopyMenu [data-copy-text="status"]').click();
    await settle();
    copied = await page.evaluate(()=>window.__copied);
    assert.equal(copied.includes('Tracking'),false,`empty variable line must be dropped:\n${copied}`);
    assert.match(copied,/Status: Ready to ship, awaiting balance payment/);
    await page.evaluate(()=>closeOrderDetail());

    // 6. Templates are editable in 设置 → 订单设置 and persist; 恢复默认 refills the textarea.
    await page.evaluate(()=>setPage('settings'));
    await page.locator('[data-settings-tab="order"]').click();
    const statusBox = page.locator('#copyTemplatesForm [name="copyStatusTemplate"]');
    assert.match(await statusBox.inputValue(),/^Hi \{client\},/,'default template shows in settings');
    await statusBox.fill('Order {num} for {client}: {stage}');
    await page.locator('#copyTemplatesForm button[type="submit"]').click();
    await settle();
    assert.equal(await page.evaluate(()=>state.orderSettings.copyStatusTemplate),'Order {num} for {client}: {stage}');
    await page.evaluate(()=>openOrderDetail('o-ship'));
    await page.locator('#detailCopyTextBtn').click();
    await page.locator('#detailCopyMenu [data-copy-text="status"]').click();
    await settle();
    assert.equal(await page.evaluate(()=>window.__copied),'Order K2 for Bob: Shipped');
    await page.evaluate(()=>closeOrderDetail());
    await page.locator('#copyTemplatesResetBtn').click();
    assert.match(await statusBox.inputValue(),/^Hi \{client\},/);
    await page.locator('#copyTemplatesForm button[type="submit"]').click();
    await settle();
    assert.equal(await page.evaluate(()=>state.orderSettings.copyStatusTemplate),'','saving the default stores an empty override');

    // 7. Customer level thresholds: new defaults, editable, validated, reset, persisted.
    const level = name => page.evaluate(name=>customerLevelForName(name), name);
    assert.equal(await level('Carol'),'A级钻石客户','25000 single order reaches A under the 20000 default');
    assert.equal(await level('Dana'),'C级白金客户','two orders totalling 3100 reach C under the 3000 default');
    assert.equal(await level('Alice Chen'),'F级青铜客户');
    await page.locator('[data-settings-tab="customer"]').click();
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('#levelRuleTable input')].map(i=>i.value)),['20000','10000','3000','1000']);
    await page.locator('#levelRuleTable input[name="A"]').fill('50000');
    await page.locator('#levelRuleForm button[type="submit"]').click();
    await settle();
    assert.equal(await level('Carol'),'B级翡翠客户','raising A demotes Carol to B');
    assert.equal(await page.evaluate(()=>document.querySelector('#levelRuleTable .level-rule-row:nth-child(3) > div:last-child').textContent),'成交额累计 10,000－50,000','释义 follows the thresholds');
    await page.locator('#levelRuleTable input[name="B"]').fill('60000');
    await page.locator('#levelRuleForm button[type="submit"]').click();
    await settle();
    assert.deepEqual(await page.evaluate(()=>state.customerLevelRules),{A:50000,B:10000,C:3000,D:1000},'B above A must be rejected');
    await page.locator('#levelRuleResetBtn').click();
    await settle();
    assert.deepEqual(await page.evaluate(()=>state.customerLevelRules),{A:20000,B:10000,C:3000,D:1000});
    assert.equal(await level('Carol'),'A级钻石客户');
    await page.locator('#levelRuleTable input[name="A"]').fill('30000');
    await page.locator('#levelRuleForm button[type="submit"]').click();
    await page.waitForFunction(()=>pendingSaveStatus().pending === false || pendingSaveStatus().saved === true || !pendingSaveStatus().pending).catch(()=>{});
    await page.evaluate(()=>flushPendingSave());
    assert.equal(stored.data?.customerLevelRules?.A ?? stored.customerLevelRules?.A,30000,'thresholds persist with the data file');
    await load();
    assert.deepEqual(await page.evaluate(()=>state.customerLevelRules),{A:30000,B:10000,C:3000,D:1000},'thresholds come back after reload');

    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Events / copy text / level rules UI passed: events-only notifications with dedupe and persistence, 文案 menu with templates and logs, editable level thresholds.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
