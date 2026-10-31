const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Closing the order / customer modal or the detail drawer with unsaved edits asks first
// (关闭 button, backdrop, Esc); a clean form closes straight away. Esc closes the top layer.
// Also covers: customer 查看 → 编辑资料 keeps the step nav + full-width form, the hold-to-delete
// button survives a tiny pointer jitter on its label, and local recognition shows an empty state.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const html = fs.readFileSync(path.join(__dirname,'..','trade-order-system.html'),'utf8');
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
    const orders = [
      {id:'o1',num:'K1',client:'Alice',country:'🇺🇸 美国 United States',amount:1000,paidAmount:0,orderType:'定金订单',stage:'quote',currency:'USD',logisticsStatus:'未发货',createdAt:`${month}-01`,orderMonth:month,updated:`${month}-01 09:00`,logs:[]}
    ];
    const customers = {Alice:{client:'Alice',country:'🇺🇸 美国 United States',note:'old note'}};
    let stored = {app:'trade-order-system',data:{orders,customers,demoCleared:true,demoCustomersCleared:true},revision:0};
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
        stored = {...route.request().postDataJSON().state,revision:stored.revision+1};
        response = {ok:true,revision:stored.revision,backup:{ok:true,skipped:true}};
      }
      return route.fulfill({json:response});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    const isOpen = id => page.evaluate(id=>document.getElementById(id).classList.contains('open'), id);
    const settle = () => page.waitForTimeout(250);

    // 查看 → 编辑资料: the step nav is rebuilt and the sections take the content column (used to render 176px wide in the nav column).
    await page.evaluate(()=>openCustomerModal('Alice',{viewOnly:true}));
    await settle();
    assert.equal(await page.locator('#customerModal .mnav [data-jump]').count(),0,'view mode shows no step nav');
    await page.locator('#customerDetailEditBtn').click();
    await page.waitForFunction(()=>document.querySelectorAll('#customerModal .mnav [data-jump]').length === 6);
    const layout = await page.evaluate(()=>{
      const nav = document.querySelector('#customerModal .mnav');
      return {navDisplay:getComputedStyle(nav).display, widths:[...document.querySelectorAll('#customerModal .order-section')].map(s=>Math.round(s.getBoundingClientRect().width))};
    });
    assert.equal(layout.navDisplay,'flex');
    assert.ok(layout.widths.every(w=>w>500),`customer edit sections squeezed: ${layout.widths.join(',')}`);

    // Clean edit form: Esc closes without asking.
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('customerModal'),false,'clean customer modal should close on Esc');
    assert.equal(await isOpen('confirmModal'),false);

    // Dirty customer edit: 关闭 asks; 继续编辑 keeps it; Esc on the confirm cancels; 放弃 closes.
    await page.evaluate(()=>openCustomerModal('Alice',{viewOnly:false}));
    await settle();
    await page.locator('#customerForm [name="note"]').fill('typed but not saved');
    await page.locator('#closeCustomerModalBtn').click();
    await settle();
    assert.equal(await isOpen('confirmModal'),true,'dirty customer modal closed without asking');
    assert.match(await page.locator('#confirmTitle').textContent(),/放弃未保存的修改/);
    await page.locator('#confirmCancelBtn').click();
    await settle();
    assert.equal(await isOpen('customerModal'),true,'继续编辑 should keep the modal');
    assert.equal(await page.locator('#customerForm [name="note"]').inputValue(),'typed but not saved');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('confirmModal'),true,'Esc on a dirty modal should ask');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('confirmModal'),false,'Esc should dismiss the confirm');
    assert.equal(await isOpen('customerModal'),true,'dismissing the confirm must not close the modal');
    await page.locator('#customerModal').click({position:{x:5,y:5}});
    await settle();
    assert.equal(await isOpen('confirmModal'),true,'backdrop click on a dirty modal should ask');
    await page.locator('#confirmOkBtn').click();
    await settle();
    assert.equal(await isOpen('customerModal'),false,'放弃修改 should close');
    assert.equal(stored.data.customers.Alice.note,'old note','discarding must not save');

    // Order modal: new and existing orders close cleanly; a typed amount asks.
    await page.evaluate(()=>openOrder(''));
    await settle();
    await page.locator('#closeModalBtn').click();
    await settle();
    assert.equal(await isOpen('orderModal'),false,'untouched new order should close without asking');
    assert.equal(await isOpen('confirmModal'),false);
    await page.evaluate(()=>openOrder('o1'));
    await settle();
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('orderModal'),false,'untouched existing order should close on Esc');
    await page.evaluate(()=>openOrder(''));
    await settle();
    await page.locator('#orderForm [name="amount"]').fill('1234');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('confirmModal'),true,'dirty order modal should ask on Esc');
    assert.equal(await isOpen('orderModal'),true);
    await page.locator('#confirmOkBtn').click();
    await settle();
    assert.equal(await isOpen('orderModal'),false);

    // Detail drawer: clean closes on Esc, edited note asks on 取消, saving still works and leaves it clean.
    await page.evaluate(()=>openOrderDetail('o1'));
    await settle();
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('orderDetailDrawer'),false,'clean drawer should close on Esc');
    await page.evaluate(()=>openOrderDetail('o1'));
    await settle();
    await page.locator('#orderDetailBody [data-dedit="note"]').fill('drawer note');
    await page.locator('#detailCancelBtn').click();
    await settle();
    assert.equal(await isOpen('confirmModal'),true,'dirty drawer should ask on 取消');
    await page.locator('#confirmCancelBtn').click();
    await page.locator('#detailSaveBtn').click();
    await page.waitForFunction(()=>document.getElementById('detailSaveBtn').dataset.mode !== 'busy' && !document.getElementById('orderForm').dataset.saving);
    await settle();
    assert.equal(await isOpen('orderDetailDrawer'),true);
    assert.equal(await page.evaluate(()=>state.orders[0].note),'drawer note');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await isOpen('orderDetailDrawer'),false,'saved drawer should close without asking');
    assert.equal(await isOpen('confirmModal'),false);

    // Hold to delete: pressing on the label text and jittering 2px used to cancel the hold (pointerleave on the span).
    await page.evaluate(()=>{ openOrderDetail('o1'); window.__held = 0; document.getElementById('detailDeleteBtn').addEventListener('hold-confirm',e=>{ e.stopImmediatePropagation(); window.__held++; },true); });
    await settle();
    const label = await page.locator('#detailDeleteBtn .hold-label').boundingBox();
    await page.mouse.move(label.x+label.width/2,label.y+label.height/2);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.move(label.x+label.width/2+2,label.y+label.height/2+1);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>document.getElementById('detailDeleteBtn').dataset.holding),'1','hold cancelled by a 2px jitter on the label');
    await page.waitForTimeout(1600);
    assert.equal(await page.evaluate(()=>window.__held),1,'hold-confirm should fire after holding on the label');
    await page.mouse.up();
    // Really leaving the button still cancels.
    const cancelled = await page.evaluate(()=>{ const btn = document.getElementById('detailDeleteBtn'); uiStartHold(btn); btn.dispatchEvent(new PointerEvent('pointerleave',{relatedTarget:document.body})); return !btn.dataset.holding; });
    assert.equal(cancelled,true,'leaving the button should cancel the hold');
    await page.evaluate(()=>closeOrderDetail());

    // Local recognition with nothing usable shows an empty state with next steps (the currency fallback alone is not a result).
    await page.evaluate(()=>openOrder(''));
    await settle();
    await page.locator('#pasteAssistInput').fill('hi, how are you');
    await page.locator('#pasteAssistAnalyzeBtn').click();
    await settle();
    assert.match(await page.locator('#pasteAssistResults').textContent(),/没识别出可以填的内容/);
    assert.equal(await page.locator('#pasteAssistResults [data-paste-run-ai]').count(),1);
    await page.locator('#pasteAssistResults [data-paste-fill-manually]').click();
    await settle();
    assert.equal(await page.evaluate(()=>document.activeElement?.name),'client','手动填写 should focus the customer field');
    await page.locator('#pasteAssistInput').fill('Total USD 520, 睫毛 20 盒');
    await page.locator('#pasteAssistAnalyzeBtn').click();
    await settle();
    assert.match(await page.locator('#pasteAssistResults').textContent(),/识别到可填字段/,'real fields still render the fill card');
    await page.evaluate(()=>closeOrder());

    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Modal close guard UI passed: dirty forms ask before closing (button, backdrop, Esc), clean ones close, customer edit layout, hold jitter, recognition empty state.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
