#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// PM review P1 batch D: 配色 / 弹窗样式 / API 检测 leave the sidebar for 设置 → 外观 / 接口状态 (the
// sidebar only shows a red dot on an API error and opens that tab), 金额统计 and 分析 are one page
// with an empty-month fallback, 生产中 / 尾款 columns carry subtitles, the Feishu checkbox remembers
// the last choice, and the settings page shows the backup dir + last backup time.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const ym = offset => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()+offset); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
    const last = ym(-1);
    const base = {currency:'USD',logisticsStatus:'未发货',productType:'假发',orderType:'定金订单',country:'🇺🇸 美国 United States',logs:[]};
    const orders = [
      {...base,id:'o1',num:'K1',client:'Alice',amount:1000,paidAmount:300,stage:'balance',orderMonth:last,createdAt:`${last}-05`,updated:`${last}-06 09:00`},
      {...base,id:'o2',num:'K2',client:'Bob',amount:800,paidAmount:800,stage:'production',orderMonth:last,createdAt:`${last}-07`,updated:`${last}-08 09:00`}
    ];
    let stored = {app:'trade-order-system',data:{orders,customers:{},doneTasks:{},demoCleared:true,demoCustomersCleared:true},revision:0};
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response = {ok:true};
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = {ok:true,storageMode:'sqlite',counts:{orders:2},backups:{sqliteCount:3,lastBackupAt:Date.now()-3*3600e3,dir:'/Users/me/iCloud/OTS',isDefault:false}};
      if (pathname === '/api/ecb-rates') response = {ok:true,rates:[]};
      if (pathname === '/api/save') { stored = {...route.request().postDataJSON().state,revision:stored.revision+1}; response = {ok:true,revision:stored.revision,backup:{ok:true,skipped:true}}; }
      return route.fulfill({json:response});
    });
    const load = async () => { await page.goto('http://127.0.0.1:47999/trade-order-system.html?token=t'); await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded); };
    await load();
    const settle = () => page.waitForTimeout(250);

    // 1. Sidebar: no swatches / modal picker / API card; they live in settings.
    assert.equal(await page.locator('aside .accent-swatches, aside .modal-style-picker, aside .sidebar-api-card').count(),0,'sidebar must not carry 配色 / 弹窗 / API 检测 any more');
    assert.equal(await page.locator('[data-settings-panel="appearance"] .accent-swatches [data-accent-choice]').count(),6);
    assert.equal(await page.locator('[data-settings-panel="appearance"] [data-modal-style-choice]').count(),4);
    assert.equal(await page.locator('[data-settings-panel="api"] [data-api-check]').count(),3);
    assert.equal(await page.locator('#navSettingsAlert').isHidden(),true,'no red dot without an API error');
    await page.evaluate(()=>{ saveApiStatuses({dhl:{ok:false,message:'密钥无效',checkedAt:nowText()}}); renderApiStatusLights(); });
    assert.equal(await page.locator('#navSettingsAlert').isHidden(),false,'API error must light the sidebar dot');
    await page.locator('.nav-item[data-page="settings"]').click();
    await settle();
    assert.equal(await page.evaluate(()=>document.querySelector('.settings-panel.active')?.dataset.settingsPanel),'api','red dot click should land on 接口状态');
    assert.equal(await page.locator('[data-api-check="dhl"]').evaluate(el=>el.classList.contains('bad')),true);
    await page.evaluate(()=>{ saveApiStatuses({}); renderApiStatusLights(); });
    assert.equal(await page.locator('#navSettingsAlert').isHidden(),true,'dot disappears once statuses are fine');
    // accent still works from its new home
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator('[data-accent-choice="teal"]').click();
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.accent),'teal');
    await page.locator('[data-accent-choice="violet"]').click();
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.accent),undefined);
    // backup info from health
    await page.locator('[data-settings-tab="data"]').click();
    const backupInfo = await page.locator('#macBackupInfo').innerText();
    assert.match(backupInfo,/上次备份 3 小时前/,backupInfo);
    assert.match(backupInfo,/\/Users\/me\/iCloud\/OTS/,backupInfo);
    assert.equal(await page.locator('#macResetBackupDirBtn').isHidden(),false,'non-default dir shows 恢复默认目录');
    assert.match(await page.locator('#savePulse').getAttribute('title'),/上次备份 3 小时前/);

    // 2. 金额统计 + 分析 are one page; 分析 tab is gone; old links still land there.
    await page.evaluate(()=>setPage('analysis'));
    await settle();
    assert.equal(await page.evaluate(()=>document.querySelector('.page.active')?.id),'page-amount');
    assert.equal(await page.locator('#page-amount .insights-tabs [data-page="analysis"]').count(),0,'分析 tab removed');
    assert.equal(await page.locator('#page-amount #analysisSection').count(),1,'analysis lives inside the 金额统计 page');
    assert.equal(await page.locator('#page-analysis').count(),0);
    // Empty current month → chart range falls back to 上月 and the analysis month to the last month with data.
    assert.equal(await page.locator('#chartRange').inputValue(),'last','本月 empty → 上月');
    assert.match(await page.locator('#amountRangeNote').innerText(),/本月还没有正式订单/);
    assert.equal(await page.evaluate(()=>activeBusinessMonth),last,'analysis month falls back to the latest month with orders');
    assert.equal(await page.locator('#analysisFallbackNote').isHidden(),false);
    assert.equal(await page.locator('#reportUsd').innerText(),'$1,800.0 USD','numbers follow the fallback month');
    // Touching the month stops the fallback.
    await page.locator('#businessNextBtn').click();
    await settle();
    assert.equal(await page.evaluate(()=>activeBusinessMonth),ym(0));
    assert.equal(await page.locator('#analysisFallbackNote').isHidden(),true,'manual month choice is respected');
    await page.locator('#chartRange').selectOption('this');
    await page.evaluate(()=>render());
    await settle();
    assert.equal(await page.locator('#chartRange').inputValue(),'this','manual range choice is respected');

    // 3. Board column subtitles (order unchanged).
    await page.evaluate(()=>setPage('dashboard'));
    await settle();
    const heads = await page.evaluate(()=>[...document.querySelectorAll('.board-column')].map(col=>({stage:col.dataset.stage,sub:col.querySelector('.board-column-sub')?.textContent||''})));
    assert.deepEqual(heads.map(h=>h.stage),['quote','production','balance','shipment']);
    assert.match(heads.find(h=>h.stage==='balance').sub,/已收定金/);
    assert.match(heads.find(h=>h.stage==='production').sub,/已付清/);
    assert.equal(heads.find(h=>h.stage==='quote').sub,'');

    // 4. Feishu checkbox remembers the last choice.
    await page.evaluate(()=>openOrder(''));
    const box = page.locator('#orderModal [name="sendFeishuNotification"]');
    assert.equal(await box.isChecked(),true,'first run defaults to checked');
    await box.uncheck();
    await page.locator('#orderForm [name="client"]').fill('Carl');
    await page.locator('#orderForm [name="client"]').press('Escape');
    await page.locator('#orderForm [name="amount"]').fill('500');
    await page.evaluate(()=>upsertOrder(document.getElementById('orderForm')));
    await page.waitForFunction(()=>state.orders.some(o=>o.client==='Carl'));
    await page.evaluate(()=>closeOrder());
    await page.evaluate(()=>openOrder(''));
    assert.equal(await box.isChecked(),false,'unchecked choice is remembered for the next new order');
    assert.equal(await page.evaluate(()=>localStorage.getItem('ots-feishu-send-v1')),'0');
    await page.evaluate(()=>closeOrder());
    await page.evaluate(()=>openOrder('o1'));
    assert.equal(await page.evaluate(()=>document.getElementById('orderFeishuNotificationField').style.display),'none','editing an existing order never shows the checkbox');
    await page.evaluate(()=>closeOrder());

    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Settings / sidebar UI passed: 配色+弹窗+API moved to settings with red-dot alert, merged 金额统计+分析 with empty-month fallback, column subtitles, Feishu choice memory, backup info.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
