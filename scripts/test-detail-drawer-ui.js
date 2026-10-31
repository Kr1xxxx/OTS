const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// The order detail drawer saves through the order form. Saving must keep the form's
// rules: a customer is required, and a payment change moves 报价 / 尾款 orders the way a
// new order would (no deposit = 报价, deposit = 尾款, paid in full = 生产中). Editing a
// note alone leaves the stage alone, also when the form last held an order of another type.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
    const base = {currency:'USD',logisticsStatus:'未发货',createdAt:`${month}-01`,orderMonth:month,updated:`${month}-01 09:00`,logs:[]};
    const orders = [
      {...base,id:'o-quote',num:'K1',client:'Alice',country:'🇺🇸 美国 United States',amount:1000,paidAmount:0,orderType:'定金订单',stage:'quote'},
      {...base,id:'o-balance',num:'K2',client:'Bob',country:'🇩🇪 德国 Germany',amount:500,paidAmount:200,orderType:'定金订单',stage:'balance'},
      {...base,id:'o-full',num:'K3',client:'Carl',country:'',amount:800,paidAmount:0,orderType:'全款订单',stage:'quote'},
      {...base,id:'o-manual',num:'K4',client:'Dan',country:'',amount:300,paidAmount:0,orderType:'定金订单',stage:'balance'}
    ];
    let stored = {app:'trade-order-system',data:{orders,customers:{},demoCleared:true,demoCustomersCleared:true},revision:0};
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      let response = {ok:true};
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = {ok:true,storageMode:'sqlite',counts:{orders:4},backups:{sqliteCount:0}};
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
    const snapshot = id => page.evaluate(id=>{ const o = state.orders.find(item=>item.id===id); return {stage:o.stage,paidAmount:o.paidAmount,amount:o.amount,client:o.client,country:o.country,note:o.note,next:o.next}; }, id);
    const open = async (id, tab) => {
      await page.evaluate(id=>openOrderDetail(id), id);
      await page.locator(`[data-detail-tab-btn="${tab}"]`).click();
    };
    const save = async () => {
      await page.locator('#detailSaveBtn').click();
      await page.waitForFunction(()=>document.getElementById('detailSaveBtn').dataset.mode !== 'busy' && !document.getElementById('orderForm').dataset.saving);
    };

    // Deposit entered on a 报价 order moves it to 尾款; the drawer re-renders on the saved order.
    await open('o-quote','payment');
    await page.locator('#orderDetailBody [data-dedit="paidAmount"]').fill('300');
    await save();
    let saved = await snapshot('o-quote');
    assert.equal(saved.paidAmount,300);
    assert.equal(saved.stage,'balance','a deposit should move a 报价 order to 尾款');
    assert.equal(saved.country,'🇺🇸 美国 United States');
    assert.match(await page.locator('#detailPills').textContent(),/尾款/,'drawer header still shows the old stage');

    // 收齐 on a 尾款 order moves it to 生产中, and the saved state goes to the server.
    await open('o-balance','payment');
    await page.locator('#orderDetailBody [data-detail-paid-full]').click();
    await save();
    saved = await snapshot('o-balance');
    assert.equal(saved.paidAmount,500);
    assert.equal(saved.stage,'production','paid in full should move a 尾款 order to 生产中');
    await page.evaluate(()=>window.flushPendingSave());
    assert.equal(stored.data.orders.find(item=>item.id==='o-balance').stage,'production');

    // Full-payment orders: 收齐 marks them paid and starts production.
    await open('o-full','payment');
    await page.locator('#orderDetailBody [data-detail-paid-full]').click();
    await save();
    saved = await snapshot('o-full');
    assert.equal(saved.paidAmount,800);
    assert.equal(saved.stage,'production');

    // The order form was last used for a 全款订单, whose stage list has no 尾款. Opening a
    // 尾款 order next must still show and keep 尾款 (the stale option list used to turn it into 报价).
    await page.evaluate(()=>{ closeOrderDetail(); openOrder('o-manual'); });
    assert.equal(await page.locator('#orderForm [name="stage"]').inputValue(),'balance','order form shows the wrong stage after a 全款订单 was open');
    await page.evaluate(()=>closeOrder());

    // Editing only the note keeps a manually chosen stage.
    await open('o-manual','info');
    await page.locator('#orderDetailBody [data-dedit="note"]').fill('只改备注');
    await page.locator('#orderDetailBody [data-dedit="next"]').fill('等客户确认');
    await save();
    saved = await snapshot('o-manual');
    assert.equal(saved.note,'只改备注');
    assert.equal(saved.next,'等客户确认');
    assert.equal(saved.stage,'balance','a note edit must not move the stage');

    // An empty customer is refused, like the order form's required field.
    await open('o-manual','info');
    await page.locator('#orderDetailBody [data-dedit="client"]').fill('');
    await page.locator('#detailSaveBtn').click();
    await page.waitForTimeout(300);
    saved = await snapshot('o-manual');
    assert.equal(saved.client,'Dan','an order was saved without a customer');
    assert.match(await page.locator('#toast').textContent(),/请填写客户名称/);

    // The 更新 button never stays on 检查中… when the native side does not answer.
    const stuck = await page.evaluate(()=>{ otsAppUpdateStatus({state:'checking'}); return document.getElementById('appUpdateBtn').classList.contains('is-busy'); });
    assert.equal(stuck,true);
    await page.clock.install();
    await page.evaluate(()=>otsAppUpdateStatus({state:'checking'}));
    await page.clock.runFor(46000);
    assert.equal(await page.evaluate(()=>document.getElementById('appUpdateBtn').classList.contains('is-busy')),false,'update button stays busy after the native side ignored the click');

    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Detail drawer UI passed: payment edits move 报价/尾款 orders, note edits keep the stage (also after a 全款订单 was open), empty customer refused, update button recovers.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
