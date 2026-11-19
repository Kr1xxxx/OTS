#!/usr/bin/env node
// 页面整理第四轮（made-up data, network stubbed）：
// 1. 粘贴识别结果卡：主按钮紧跟标题、在左栏第一屏看得到；字段是两列清单；有新客户卡时「识别到可填字段」收成一行；
// 2. 「一起确认客户和订单」：左边 6 格 + 收起的「更多资料」（识别到其中一项就展开），右边订单号 / 日期在栏标题旁边，
//    附件、交期、物流、备注收在「更多」里，飞书是开关；默认窗口不用滚；新建订单里加的附件带过来、和订单一起存；
// 3. 顶部搜索：订单行写金额和日期不写国家；客户行国家在前；搜订单号时没有重复的「物流」组，搜运单号时有；
// 4. 已删除订单没收过钱的不写「已付」；
// 5. 右键菜单标题订单号在前。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, day } = require('./helpers/board-page');

const order = (id, fields) => ({ ...base, id, orderType:'定金订单', paidAmount:0, stage:'quote', ...fields });
const orders = [
  order('o1', { num:'R6-26110101', client:'Aurora Hair Studio', amount:7500, paidAmount:2250, stage:'production', createdAt:day(2), note:'等客户确认颜色', updated:`${day(2)} 10:00`,
    trackingNumber:'7700112233', carrier:'DHL', shipments:[{ trackingNumber:'7700112233', carrier:'DHL', status:'运输中' }] }),
  order('o2', { num:'R6-26110102', client:'Aurora Hair Studio', amount:4200, createdAt:day(3), updated:`${day(3)} 10:00` })
];
const customers = {
  'Aurora Hair Studio': { client:'Aurora Hair Studio', contact:'Mia Carter', email:'hello0@customer0.example', phone:'+1 555 0100', country:'🇺🇸 美国 United States', address:'1200 Example Ave, Austin, TX 78701' }
};
const trackingLookups = [{ id:'t1', trackingNumber:'7700112233', carrier:'DHL', orderId:'o1', client:'Aurora Hair Studio', orderNum:'R6-26110101', status:'运输中', checkedAt:`${day(2)} 12:00` }];
const deletedOrders = [
  order('d1', { num:'R6-DEL-1', client:'Aurora Hair Studio', amount:500, deletedAt:`${day(2)} 09:00` }),
  order('d2', { num:'R6-DEL-2', client:'Aurora Hair Studio', amount:800, paidAmount:300, deletedAt:`${day(2)} 09:00` })
];
const zedChat = 'New buyer: Zed Wigs Ltd, Leeds UK, zed@zedwigs.example\n10 bundles body wave, 18 inch\ntotal 900 USD';

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, store, errors, dialogs } = await openBoard(browser, { orders, customers, trackingLookups, deletedOrders }, { port:47996 });
    const visible = selector => page.locator(selector).isVisible();

    // ---- 1. paste result cards ----
    const paste = async text => {
      await page.evaluate(() => openOrder());
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
      await page.fill('#pasteAssistInput', text);
      await page.click('#pasteAssistAnalyzeBtn');
      await page.waitForSelector('#pasteAssistResults .paste-result-card');
    };
    const cards = () => page.evaluate(() => [...document.querySelectorAll('#pasteAssistResults .paste-result-card')].map(card => ({
      title:card.querySelector('.paste-result-title')?.textContent || '',
      tag:card.querySelector('.paste-result-top .tag')?.textContent || '',
      line:card.classList.contains('paste-result-line') ? card.textContent.replace(/\s+/g, ' ').trim() : '',
      rows:[...card.querySelectorAll('.paste-field-kv dt')].map(dt => `${dt.textContent}：${dt.nextElementSibling.textContent}`),
      pills:card.querySelectorAll('.paste-field-pill').length
    })));
    await paste(zedChat);
    let list = await cards();
    assert.equal(list.length, 2, JSON.stringify(list));
    assert.deepEqual([list[0].title, list[0].tag], ['Zed Wigs Ltd', '新客户']);
    assert.equal(list[0].pills, 0, 'fields are a two-column list, not pills');
    assert.ok(list[0].rows.includes('金额：900 USD'), `currency goes with the amount: ${list[0].rows}`);
    assert.ok(list[0].rows.includes('订单类型：全款订单 · 未付'), `payment status goes with the order type: ${list[0].rows}`);
    assert.ok(!list[0].rows.some(row => /^(客户|币种|付款状态)：/.test(row)), `no row repeats the title or a merged field: ${list[0].rows}`);
    assert.equal(list[1].line, '只把这几项填进右边 填入 →', 'the second card is one line when the new-customer card is there');
    // The main button sits right under the title, inside the visible part of the left rail.
    const reach = await page.evaluate(() => {
      const rail = document.querySelector('#orderModal .order-paste-section');
      const button = document.querySelector('#pasteAssistResults [data-paste-create-customer-order]');
      const title = document.querySelector('#pasteAssistResults .paste-result-title');
      const kv = document.querySelector('#pasteAssistResults .paste-field-kv');
      return { railBottom:rail.getBoundingClientRect().bottom, buttonBottom:button.getBoundingClientRect().bottom, buttonTop:button.getBoundingClientRect().top, titleBottom:title.getBoundingClientRect().bottom, kvTop:kv.getBoundingClientRect().top };
    });
    assert.ok(reach.buttonBottom <= reach.railBottom, `the button is visible without scrolling: ${JSON.stringify(reach)}`);
    assert.ok(reach.buttonTop > reach.titleBottom && reach.buttonTop < reach.kvTop, 'the button comes before the field list');
    await page.evaluate(() => closeOrder());

    // Existing customer: one line of meta (how it was recognised · country), the rest in the tooltip.
    await paste('Hi this is Mia, hello0@customer0.example\n2 wigs total 2600 USD');
    list = await cards();
    assert.deepEqual([list[0].title, list[0].tag], ['Aurora Hair Studio（Mia Carter）', '已有客户']);
    const meta = await page.locator('#pasteAssistResults .paste-result-meta').first();
    assert.equal(await meta.innerText(), '按邮箱认出 · 🇺🇸 美国');
    assert.match(await meta.getAttribute('title'), /匹配依据：邮箱一致 · 可信度 100% · 地址：1200 Example Ave/);
    const titleBox = await page.evaluate(() => {
      const card = document.querySelector('#pasteAssistResults .paste-result-card');
      const tag = card.querySelector('.paste-result-top .tag');
      return { cardRight:card.getBoundingClientRect().right, tagRight:tag.getBoundingClientRect().right };
    });
    assert.ok(titleBox.tagRight <= titleBox.cardRight, 'a long name is cut, the tag stays inside the card');
    await page.evaluate(() => closeOrder());

    // No customer in the chat: the fill card stays a full card.
    await paste('Tracking 7700998877 DHL, total 300 USD');
    list = await cards();
    assert.equal(list.at(-1).title, '识别到可填字段');
    assert.ok(list.at(-1).rows.length > 0);
    await page.evaluate(() => closeOrder());

    // ---- 2. combined customer + order dialog ----
    await paste(zedChat);
    // A link attachment added in the new-order dialog comes along.
    await page.click('#orderForm [data-order-more="attachments"]');
    await page.fill('#attachmentName', 'PI 草稿');
    await page.fill('#attachmentLink', 'https://example.test/pi-draft');
    await page.click('#addAttachmentBtn');
    await page.locator('#pasteAssistResults [data-paste-create-customer-order]').click();
    // Only the attachment changed and it comes along: no 「放弃未保存的修改？」 on the way.
    await page.waitForFunction(() => document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
    assert.equal(await page.evaluate(() => document.getElementById('confirmModal').classList.contains('open')), false, 'nothing is discarded, so nothing to confirm');
    // The carried attachment is not "as opened": × asks before it is thrown away; 继续编辑 keeps it.
    await page.click('#combinedCloseBtn');
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await page.click('#confirmCancelBtn');
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.evaluate(() => document.getElementById('combinedCustomerOrderModal').classList.contains('open')), true);
    assert.equal(await visible('#combinedCustomerMore'), false, '更多资料 starts folded when none of it was recognised');
    assert.equal(await page.locator('[data-combined-customer-more-toggle]').getAttribute('aria-expanded'), 'false');
    for (const name of ['name', 'country', 'contact', 'phone', 'email', 'address']) assert.equal(await page.locator(`#combinedCustomerForm [name="${name}"]`).isVisible(), true, `${name} is one of the six`);
    assert.equal(await page.locator('#combinedCustomerForm [name="paymentEmail"]').isVisible(), false);
    const layout = await page.evaluate(() => {
      const body = document.querySelector('#combinedCustomerOrderModal .combined-modal-body');
      const head = document.querySelector('#combinedOrderForm > .combined-column-head');
      const num = document.querySelector('#combinedOrderForm [name="num"]');
      return { scroll:body.scrollHeight, client:body.clientHeight, numInHead:head.contains(num) };
    });
    assert.equal(layout.numInHead, true, 'order number next to the column title');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#combinedOrderForm [data-order-more]')].filter(chip => !chip.hidden).map(chip => chip.textContent.trim())),
      ['交期要求（含加急）', '物流信息', '备注'], 'the attachment section is open because it has one; the rest stay folded like in 新建订单');
    assert.equal(await page.locator('#combinedOrderForm [name="sendFeishuNotification"]').getAttribute('role'), 'switch');
    assert.match(await page.locator('#combinedAttachmentList').innerText(), /PI 草稿/);
    // One more link in the combined dialog itself.
    await page.fill('#combinedOrderForm [data-attachment-field="name"]', '报价单');
    await page.fill('#combinedOrderForm [data-attachment-field="link"]', 'https://example.test/quote');
    await page.click('#combinedOrderForm [data-attachment-add]');
    await page.evaluate(() => { document.getElementById('combinedOrderForm').elements.sendFeishuNotification.checked = false; });
    const savesBefore = store.saves;
    await page.click('#combinedSaveBtn');
    await page.waitForFunction(() => !document.getElementById('combinedCustomerOrderModal').classList.contains('open'));
    await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
    assert.ok(store.saves > savesBefore);
    const saved = store.current.data.orders.find(o => o.client === 'Zed Wigs Ltd');
    assert.deepEqual(saved?.attachments?.map(item => item.name), ['报价单', 'PI 草稿'], 'attachments saved with the order');
    assert.ok(store.current.data.customers['Zed Wigs Ltd'], 'customer saved');

    // A recognised payment email unfolds 更多资料; the shipment section opens when a tracking number was recognised.
    await page.evaluate(() => openCombinedCustomerOrderModal({ customerFields:{ name:'Yara Wigs Ltd', paymentEmail:'pay@yarawigs.example' }, orderFields:{ amount:200, trackingNumber:'7700445566' } }));
    assert.equal(await visible('#combinedCustomerMore'), true);
    assert.equal(await page.locator('[data-combined-customer-more-toggle]').innerText(), '收起');
    assert.equal(await page.locator('#combinedOrderForm [name="trackingNumber"]').isVisible(), true);
    await page.evaluate(() => closeCombinedCustomerOrderModal());

    // A picture pasted into this dialog goes into its own attachments (it used to have none) and opens that section.
    await page.evaluate(() => openCombinedCustomerOrderModal({ customerFields:{ name:'Wren Wigs Ltd' }, orderFields:{ amount:120 } }));
    assert.equal(await page.locator('#combinedAttachmentList').isVisible(), false);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 120; canvas.height = 80;
      canvas.getContext('2d').fillRect(10, 10, 60, 30);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], 'deposit.png', { type:'image/png' }));
      document.getElementById('combinedOrderForm').dispatchEvent(new ClipboardEvent('paste', { clipboardData:data, bubbles:true, cancelable:true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#combinedImageUploads .image-upload-card').length === 1);
    await page.waitForFunction(() => !document.getElementById('combinedOrderForm').dataset.uploading);
    assert.equal(await page.locator('#combinedAttachmentList').isVisible(), true);
    assert.equal(await page.evaluate(() => orderAttachmentsFromForm(document.getElementById('combinedOrderForm')).length), 1);
    assert.equal(await page.evaluate(() => orderAttachmentsFromForm(document.getElementById('orderForm')).filter(item => item.type === '图片附件').length), 0, 'nothing went into the hidden new-order form');
    await page.evaluate(() => closeCombinedCustomerOrderModal());
    assert.equal(await page.locator('#combinedImageUploads .image-upload-card').count(), 0, 'closing clears the progress cards');

    // A wrong payment email inside the folded part unfolds it on save.
    await page.evaluate(() => openCombinedCustomerOrderModal({ customerFields:{ name:'Xeno Wigs Ltd' }, orderFields:{ amount:200 } }));
    const fit = await page.evaluate(() => { const body = document.querySelector('#combinedCustomerOrderModal .combined-modal-body'); return { scroll:body.scrollHeight, client:body.clientHeight }; });
    assert.ok(fit.scroll <= fit.client + 1, `with nothing unfolded it fits the default window without scrolling: ${JSON.stringify(fit)}`);
    await page.evaluate(() => { document.getElementById('combinedCustomerForm').elements.paymentEmail.value = 'not-an-email'; });
    await page.click('#combinedSaveBtn');
    await page.waitForFunction(() => !document.getElementById('combinedCustomerMore').hidden);
    assert.equal(await page.evaluate(() => document.activeElement?.name), 'paymentEmail');
    assert.equal(await page.evaluate(() => document.getElementById('combinedCustomerOrderModal').classList.contains('open')), true);
    await page.evaluate(() => closeCombinedCustomerOrderModal());

    // ---- 3. global search ----
    const search = async query => {
      await page.fill('#searchInput', query);
      await page.waitForFunction(q => globalSearchRenderedQuery === q, query);
      return page.evaluate(() => currentGlobalSearchResults.map(item => ({ type:item.type, title:item.title, subtitle:item.subtitle, tooltip:item.tooltip || '' })));
    };
    let results = await search('Aurora');
    const customer = results.find(item => item.type === 'customer');
    assert.equal(customer.subtitle, '🇺🇸 美国 · hello0@customer0.example · +1 555 0100', 'country first, then email and phone');
    assert.match(customer.tooltip, /Mia Carter · 1200 Example Ave/);
    assert.equal(await page.locator('#globalSearchPanel .global-search-result[title*="1200 Example Ave"]').count(), 1);
    const orderRow = results.find(item => item.title.startsWith('R6-26110102'));
    assert.match(orderRow.subtitle, new RegExp(`^\\S*4,200\\S* USD · ${day(3).slice(5)}$`), 'amount · order date');
    assert.doesNotMatch(results.filter(item => item.type === 'order').map(item => item.subtitle).join('\n'), /美国|United States/, 'order rows leave the country to the customer row');
    assert.ok(results.filter(item => item.type === 'order').every(item => / · \d{2}-\d{2}( · |$)/.test(item.subtitle)), 'order rows show the order date');
    assert.equal(results.filter(item => item.type === 'tracking').length, 0, 'searching a customer does not list its shipments again');
    results = await search('R6-2611010');
    assert.equal(results.filter(item => item.type === 'tracking').length, 0, 'searching order numbers does not list the same orders again under 物流');
    results = await search('7700112233');
    assert.equal(results.filter(item => item.type === 'tracking').length, 1, 'a tracking number still finds the logistics row');
    results = await search('DHL');
    assert.equal(results.filter(item => item.type === 'tracking').length, 1, 'so does the carrier');
    // The full results page keeps every logistics hit under its 物流 tab.
    assert.equal(await page.evaluate(() => buildGlobalSearchResults('Aurora', { allTracking:true }).filter(item => item.type === 'tracking').length), 1);
    await page.keyboard.press('Escape');

    // ---- 4. deleted orders ----
    await page.evaluate(() => setPage('deleted'));
    await page.waitForSelector('.deleted-amount');
    const amounts = await page.evaluate(() => [...document.querySelectorAll('.deleted-amount')].map(el => el.textContent.replace(/\s+/g, ' ').trim()));
    assert.ok(amounts.some(text => /800/.test(text) && /已付 \$300/.test(text)), `a paid deleted order still shows 已付: ${amounts}`);
    assert.ok(amounts.some(text => /500/.test(text) && !/已付/.test(text)), `an unpaid one does not: ${amounts}`);

    // ---- 5. board menu title ----
    await page.evaluate(() => setPage('dashboard'));
    await page.evaluate(() => uiOpenBoardMenu(document.querySelector('#pipeline [data-id="o2"]'), { x:400, y:400 }));
    assert.equal(await page.locator('.board-menu-title').innerText(), 'R6-26110102 · Aurora Hair Studio（Mia Carter）');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('Pages round 6 UI passed: paste cards (button first, two-column list, one-line fill card, short existing meta), combined dialog (six fields + folded more, order head, more chips, switch, attachments carried and saved, fits without scrolling), search rows and logistics group, deleted orders without 已付 $0, board menu title.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
