#!/usr/bin/env node
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { h } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

// PM review P1 batch C: the notification panel carries events only (save failures, API errors,
// logistics status changes, Feishu results, new versions) and never tasks; the order drawer no longer has
// the 文案 menu (removed on request), old saved templates stay in the data;
// customer level thresholds are editable in 设置 → 客户设置 and persist with the data file.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
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
    // Wait for open / close animations to finish (it used to wait a fixed 250 ms).
    const settle = () => h.quiet(page);
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
    assert.equal(feishu?.tab,'info','the retry button lives on the 订单信息 tab');
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

    // 5. The 文案 button and its settings card are gone (removed on request). Templates saved before the
    // removal stay in the data: saving 订单设置 keeps keys that form does not own.
    await page.evaluate(()=>openOrderDetail('o-due'));
    await settle();
    assert.equal(await page.locator('#detailCopyTextBtn, #detailCopyMenu').count(),0,'order drawer has no 文案 button');
    assert.deepEqual(await page.locator('.order-detail-topline .order-action-group .btn:visible').allInnerTexts().then(t=>t.map(s=>s.trim())),['客户档案','复制订单','完整编辑…']);
    await page.evaluate(()=>closeOrderDetail());
    await page.evaluate(()=>setPage('settings'));
    await page.locator('[data-settings-tab="order"]').click();
    assert.equal(await page.locator('#copyTemplatesForm').count(),0,'settings has no template card');
    await page.evaluate(()=>{ state.orderSettings = { ...state.orderSettings, copyStatusTemplate:'Old status {num}', copyDunningTemplate:'Old reminder {num}', ownEmails:['sales@example.com'] }; });
    await page.locator('#orderSettingsForm button[type="submit"]').click();
    await settle();
    assert.deepEqual(await page.evaluate(()=>({ s:state.orderSettings.copyStatusTemplate, d:state.orderSettings.copyDunningTemplate, own:state.orderSettings.ownEmails })),{ s:'Old status {num}', d:'Old reminder {num}', own:['sales@example.com'] },'saving 订单设置 keeps the old templates and 我方邮箱');

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
    console.log('Events / copy text / level rules UI passed: events-only notifications with dedupe and persistence, no 文案 menu and old templates kept, editable level thresholds.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
