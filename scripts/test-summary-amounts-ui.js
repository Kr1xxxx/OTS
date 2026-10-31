#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{width:1360,height:900} });
    await page.clock.install({time:new Date('2026-10-16T12:00:00+08:00')});
    const errors = []; let saves = 0;
    page.on('pageerror', error => errors.push(error.message));
    const data = {
      demoCleared:true, demoCustomersCleared:true,
      customers:{'Example Buyer':{name:'Example Buyer',country:'United States',currency:'USD'}},
      performanceTargets:{'2026-10':20000.123},
      orders:[{id:'summary-example',num:'TEST-SUMMARY',client:'Example Buyer',country:'United States',currency:'USD',amount:12345.678,paidAmount:4567.891,orderMonth:'2026-10',createdAt:'2026-10-01',updated:'2026-10-16 12:00',stage:'production',productType:'睫毛',paymentChannel:'Paypal',logs:[],attachments:[]}]
    };
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'..','trade-order-system.html'),'utf8')});
      if (pathname === '/api/data') return route.fulfill({json:{app:'trade-order-system',revision:0,data}});
      if (pathname === '/api/save') saves++;
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const before = await page.evaluate(() => JSON.stringify(state.orders));
    const surfaces = {
      dashboard:'#statAmount,#statPayment,#statTargetSub,.board-column-meta',
      amount:'#reportUsd,#reportPaid,#reportDue,#reportOverdue,.breakdown-row strong,.side-bar-head strong',
      targets:'#targetGoal,#targetActual,#targetGap,.target-history-values span',
      analysis:'.analysis-rank strong,.analysis-trend-row strong,.business-product-value,.business-payment-item strong',
      customers:'.customer-summary-item strong,.customer-summary-item small'
    };
    for (const theme of ['light','dark']) {
      await page.evaluate(value => applyTheme(value),theme);
      for (const width of [1360,1100,768,390]) {
        await page.setViewportSize({width,height:900});
        for (const [surface,selector] of Object.entries(surfaces)) {
          await page.evaluate(name => {activeBusinessMonth='2026-10';setPage(name);},surface);
          await page.clock.fastForward(1000);
          const amounts = await page.locator(selector).evaluateAll(nodes => nodes.filter(el => el.getBoundingClientRect().width > 0 && /\d USD/.test(el.textContent)).map(el => {
            const style = getComputedStyle(el), box = el.getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect();
            return {text:el.textContent.trim(),fits:el.scrollWidth <= el.clientWidth+1 && box.right <= parent.right+1,ellipsis:style.textOverflow==='ellipsis'};
          }));
          assert.ok(amounts.length,`${surface} must render synthetic monetary summaries`);
          for (const amount of amounts) {
            assert.match(amount.text,/\d\.\d USD/,`${surface}: fixed one decimal: ${amount.text}`);
            assert.doesNotMatch(amount.text,/\d\.\d{2,} USD/,`${surface}: excess precision`);
            assert.ok(amount.fits,`${surface} summary must fit at ${width}px in ${theme}: ${amount.text}`);
            assert.equal(amount.ellipsis,false,`${surface} summary must not ellipsize`);
          }
          if (surface === 'analysis') assert.equal(await page.evaluate(() => document.querySelector('.page.active')?.id),'page-amount','分析 now lives inside the 金额统计 page');
          if (surface === 'amount') {
            assert.equal(await page.locator('#reportPaid').innerText(),'$4,567.9 USD');
            assert.equal(await page.locator('#reportDue').innerText(),'$7,777.8 USD');
            assert.equal(await page.locator('#reportOverdue').innerText(),'$0.0 USD');
          }
          if (process.env.UI_SCREENSHOT && ['amount','analysis','customers'].includes(surface)) await page.screenshot({path:`${process.env.UI_SCREENSHOT}.${surface}.${theme}.${width}.png`,fullPage:true,animations:'disabled'});
        }
        await page.evaluate(() => openCustomerModal('Example Buyer',{viewOnly:true}));
        const metrics = await page.locator('.customer-metric-card strong').evaluateAll(nodes => nodes.filter(el => /USD/.test(el.textContent)).map(el => ({text:el.textContent,fits:el.scrollWidth<=el.clientWidth+1,ellipsis:getComputedStyle(el).textOverflow==='ellipsis'})));
        assert.equal(metrics.length,3);
        for (const metric of metrics) { assert.match(metric.text,/\d\.\d USD/); assert.doesNotMatch(metric.text,/\d\.\d{2,} USD/); assert.ok(metric.fits); assert.equal(metric.ellipsis,false); }
        if (process.env.UI_SCREENSHOT) await page.locator('.customer-profile-metrics').screenshot({path:`${process.env.UI_SCREENSHOT}.profile.${theme}.${width}.png`,animations:'disabled'});
        await page.evaluate(() => closeCustomerModal());
      }
    }
    assert.equal(await page.evaluate(() => JSON.stringify(state.orders)),before,'Summary rendering must not round stored amounts');
    await page.evaluate(() => setPage('order-list'));
    assert.ok((await page.locator('.order-table-money').allTextContents()).includes('$12,345.678 USD'),'Order amounts retain original precision');
    assert.deepEqual(await page.evaluate(() => ({money:money(123.456,'USD'),cost:formatAiCost(0.0001234567),tiny:formatAiCost(0.00000001),rate:ecbUsdRateForOrder({currency:'GBP',createdAt:'2026-10-16'},[{date:'2026-10-16',rates:{USD:1.23456789,GBP:1}}])})),{money:'$123.456 USD',cost:'USD 0.000123',tiny:'USD <0.000001',rate:1.23456789},'Detail, AI cost and exchange-rate precision are unchanged');
    assert.deepEqual(await page.evaluate(() => [summaryMoney(100),summaryMoney(0),summaryMoney(12.04),rmbMoney(123.456)]),['$100.0 USD','$0.0 USD','$12.0 USD','¥123.5 RMB']);
    // Large totals must remain fully readable, not merely have fewer decimals.
    await page.evaluate(() => {state.orders[0].amount=1234567.891;state.orders[0].paidAmount=456789.123;state.performanceTargets['2026-10']=2000000.123;});
    for (const width of [1360,1100,768,390]) {
      await page.setViewportSize({width,height:900});
      for (const [surface,selector] of Object.entries(surfaces)) {
        await page.evaluate(name => {activeBusinessMonth='2026-10';setPage(name);},surface);
        await page.clock.fastForward(1000);
        const overflow = await page.locator(selector).evaluateAll(nodes => nodes.filter(el => el.getBoundingClientRect().width>0 && /\d USD/.test(el.textContent) && (el.scrollWidth>el.clientWidth+1 || el.getBoundingClientRect().right>el.parentElement.getBoundingClientRect().right+1)).map(el => el.id || el.className || el.parentElement.className));
        assert.deepEqual(overflow,[],`${surface}: million-scale summaries must not clip at ${width}px`);
      }
    }
    assert.equal(saves,0,'Read-only rendering must never save business data');
    assert.deepEqual(errors,[]);
    console.log('Summary amounts UI passed: fixed one decimal, light/dark responsive layouts, unchanged detail/rate/AI precision, zero saves.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
