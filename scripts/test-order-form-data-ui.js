#!/usr/bin/env node
// orderFormDataFromOrder (what the detail drawer saves from) must equal what the order form holds after
// openOrder(id): Object.fromEntries(new FormData(#orderForm)) plus shipments, partialShipment and attachments.
// A field added to the order form, or a change to how openOrder fills it, without the same change in
// orderFormDataFromOrder fails here. Orders: the drawer save matrix's orders plus some odd data.
const assert = require('node:assert/strict');
const { launchBrowser, openBoard } = require('./helpers/board-page');
const { orders:matrixOrders, customers } = require('./helpers/drawer-save-matrix');

const base = matrixOrders[0];
const odd = [
  // Values the form's selects do not have, a stage the order type has no column for, odd number text.
  { ...base, id:'odd-select', num:'K25039901', productType:'帽子', paymentChannel:'支付宝', orderType:'全款订单', stage:'balance', amount:'12.50', paidAmount:'abc' },
  { ...base, id:'odd-type', num:'K25039902', orderType:'', stage:'', amount:0, paidAmount:0, depositAmount:'', depositPercent:'' },
  // More than 20 attachments (the form keeps the first 20), CRLF in the note, a line break in a one-line field.
  { ...base, id:'odd-text', num:'K25039903', note:'第一行\r\n第二行\r第三行', next:'换行\n下一步', orderDetail:'A\r\nB',
    attachments:Array.from({ length:23 }, (_, i) => ({ name:`a${i}.jpg`, type:'图片', link:`https://example.com/${i}`, time:'2025-03-01 09:00', temporary:i === 0 })) },
  // A shipment status the form does not list, an unknown carrier, the same number twice, an old single tracking number.
  { ...base, id:'odd-ship', num:'K25039904', stage:'shipment', shipments:[
    { id:'s1', trackingNumber:'1234567890', carrier:'Aramex', status:'Delivered', shippedAt:'2025-03-02' },
    { id:'s2', trackingNumber:'1234567890', carrier:'DHL', status:'运输中' },
    { id:'', trackingNumber:'771234567890', carrier:'', status:'' }
  ] },
  { ...base, id:'odd-legacy', num:'K25039905', shipments:[], trackingNumber:'1Z999AA10123456784', carrier:'UPS', logisticsStatus:'运输中' },
  // Currency outside the list, a lower-case code, a draft whose group message was sent, a deposit from a preset.
  { ...base, id:'odd-currency', num:'K25039906', currency:'jpy', amount:30000, paidAmount:9000, depositAmount:9000, depositPercent:30 },
  { ...base, id:'odd-draft', num:'K25039907', isDraft:true, feishuNotification:{ requested:true, status:'sent' } },
  { ...base, id:'odd-preset', num:'K25039908', amount:1000, depositAmount:500, depositPercent:50, paidAmount:0 }
];
const orders = [...matrixOrders, ...odd];

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors } = await openBoard(browser, { orders, customers }, { port:47995 });
    const compare = async ({ pendingCopy = false, feishuChoice = null } = {}) => page.evaluate(({ ids, pendingCopy, feishuChoice }) => {
      if (feishuChoice === null) safeStorage.removeItem('ots-feishu-send-v1');
      else safeStorage.setItem('ots-feishu-send-v1', feishuChoice);
      return ids.map(id => {
        if (pendingCopy) feishuPendingCopies.add(id);
        const order = state.orders.find(o => o.id === id);
        const expected = orderFormDataFromOrder(order);
        openOrder(id);
        const form = document.getElementById('orderForm');
        const actual = {
          ...Object.fromEntries(new FormData(form).entries()),
          shipments:orderShipmentsFromForm(form),
          partialShipment:form.elements.partialShipment.checked,
          attachments:orderAttachmentsFromForm(form)
        };
        closeOrder();
        feishuPendingCopies.delete(id);
        return { id, expected:JSON.parse(JSON.stringify(expected)), actual:JSON.parse(JSON.stringify(actual)) };
      });
    }, { ids:orders.map(o => o.id), pendingCopy, feishuChoice });
    const runs = [
      ['default', await compare()],
      ['group message choice off', await compare({ feishuChoice:'0' })],
      ['pending copies', await compare({ pendingCopy:true })]
    ];
    for (const [label, results] of runs) {
      for (const { id, expected, actual } of results) {
        assert.deepStrictEqual(expected, actual, `${label}: orderFormDataFromOrder differs from the order form for ${id}`);
      }
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(`Order form data passed: orderFormDataFromOrder matches the order form after openOrder for ${orders.length} orders (also with the group-message choice off and as pending copies).`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
