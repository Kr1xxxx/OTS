const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Pasting a new customer's chat and saving customer + first order together (made-up data, network stubbed):
// 1. quantity-first product lines ("10 bundles body wave, 18 inch") are not read as the customer's address;
// 2. when the chat names no payment method, the new profile's 付款方式 follows the order's 收款方式
//    until the user changes it by hand (it used to stay at the default 阿里巴巴).
(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:920 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let revision = 0;
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8') });
      if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:0, data:{ demoCleared:true, demoCustomersCleared:true, orders:[], customers:{} } } });
      if (pathname === '/api/save') { revision++; return route.fulfill({ json:{ ok:true, revision } }); }
      return route.fulfill({ json:{ ok:true } });
    });
    await page.goto('http://127.0.0.1:47998/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    // 1. Address recognition.
    const address = text => page.evaluate(text => analyzeCustomerPasteText(text).extracted.address || '', text);
    const head = 'New buyer: Zed Wigs Ltd, Leeds UK, zed@zedwigs.example\n';
    for (const line of ['10 bundles body wave, 18 inch', '20 boxes 0.07 C curl, 12mm', '5 wigs please', '3 bob wigs, total 900 USD', '2 pcs 13x4 lace wig, 22 inch']) {
      assert.equal(await address(head + line), '', `"${line}" must not become the customer's address`);
    }
    assert.match(await address(head + '1200 Example Ave, Austin, TX 78701'), /^1200 Example Ave/, 'a street line is still an address');
    assert.match(await address(head + '10 Downing Street, London SW1A 2AA'), /^10 Downing Street/, 'a street named after a number stays an address');
    assert.match(await address(head + '12 Lace Road, Leeds LS1 4AP'), /^12 Lace Road/, 'a product word inside a real street name stays an address');

    // 2. Payment method of the new profile follows the order.
    const openCombined = async text => {
      await page.evaluate(() => openOrder());
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
      await page.fill('#pasteAssistInput', text);
      await page.click('#pasteAssistAnalyzeBtn');
      await page.locator('#pasteAssistResults [data-paste-create-customer-order]').click();
      await page.waitForFunction(() => document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
    };
    const fields = () => page.evaluate(() => {
      const c = document.getElementById('combinedCustomerForm');
      const o = document.getElementById('combinedOrderForm');
      return { customer:c.elements.paymentMethod.value, order:o.elements.paymentChannel.value, address:c.elements.address?.value || '', dirty:uiFormDirty(c) || uiFormDirty(o) };
    });
    const setSelect = (form, name, value) => page.evaluate(({ form, name, value }) => {
      const select = document.getElementById(form).elements[name];
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles:true }));
    }, { form, name, value });

    await openCombined('New buyer: Zed Wigs Ltd, Leeds UK, zed@zedwigs.example\n10 bundles body wave, 18 inch\ntotal 900 USD');
    let now = await fields();
    assert.equal(now.customer, now.order, 'no payment method in the chat: the profile starts with the order\'s 收款方式');
    assert.equal(now.address, '', 'the product line is not filled into the address');
    assert.equal(now.dirty, false, 'following the order is not an unsaved change of its own');
    await setSelect('combinedOrderForm', 'paymentChannel', 'TT');
    assert.equal((await fields()).customer, 'TT', 'changing the order\'s 收款方式 moves the profile along');
    await page.evaluate(() => { const box = document.getElementById('combinedOrderForm').elements.sendFeishuNotification; if (box) box.checked = false; });
    await page.locator('#combinedSaveBtn').click();
    await page.waitForFunction(() => !document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
    await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
    const saved = await page.evaluate(() => ({ profile:state.customers['Zed Wigs Ltd'], order:state.orders.find(o => o.client === 'Zed Wigs Ltd') }));
    assert.equal(saved.profile?.paymentMethod, 'TT');
    assert.equal(saved.order?.paymentChannel, 'TT');
    assert.ok(!saved.profile?.address, 'no product line saved as the address');
    assert.equal(await page.evaluate(() => clientFieldsForPaste('Zed Wigs Ltd').paymentChannel), 'TT', 'the next order for this customer is prefilled with TT');

    // A hand-picked 付款方式 is kept when the order changes afterwards.
    await openCombined('New buyer: Yara Wigs Ltd, Leeds UK, yara@yarawigs.example\n20 boxes 0.07 C curl, 12mm\ntotal 400 USD');
    await setSelect('combinedCustomerForm', 'paymentMethod', 'Zelle');
    await setSelect('combinedOrderForm', 'paymentChannel', '西联');
    now = await fields();
    assert.equal(now.customer, 'Zelle', 'a 付款方式 the user picked is not overwritten');
    assert.equal(now.order, '西联');
    await page.evaluate(() => closeCombinedCustomerOrderModal());

    // Named in the chat: the profile keeps what was recognised even when the order changes.
    await openCombined('New buyer: Xeno Wigs Ltd, Leeds UK, xeno@xenowigs.example\nI will pay by Zelle\n5 wigs please, total 700 USD');
    now = await fields();
    assert.equal(now.customer, 'Zelle', 'a recognised payment method fills the profile');
    await setSelect('combinedOrderForm', 'paymentChannel', 'TT');
    assert.equal((await fields()).customer, 'Zelle', 'a recognised payment method does not follow the order');
    await page.evaluate(() => closeCombinedCustomerOrderModal());

    assert.deepEqual(errors, []);
    console.log('paste new customer fixes ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
