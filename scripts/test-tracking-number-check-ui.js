#!/usr/bin/env node
// 不像运单号的输入不能存（2026-11-17：用户误把一个纯字母的网址存成了运单号）。
// - 判断只有一个 trackingNumberProblem：网址、没有数字、太短太长、1Z 开头不是 18 位；UPS 1Z、DHL JJD / GM 这些带字母的真单号照常能存；
// - 订单弹窗（编辑、新建）、新客户加订单、抽屉「补运单号」、已发货补单号小卡片都拦，提示说清原因；AI 识别出的网址不填进表单；
// - 以前存进去的坏单号不删不改：打开订单只灰字提示，改别的字段照常保存；导入照原样导入，预览里点出来。
// 页面用 helpers/board-page 的内存假服务器，单号和客户都是编的。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

(async () => {
  const browser = await launchBrowser();
  try {
    const orders = [
      // 以前存进去的坏单号（网址被清成了一串大写字母）。
      { ...base, id:'bad', num:'T9001', client:'Old Bad Track', amount:500, paidAmount:500, orderType:'全款订单', stage:'shipment', updated:`${day(2)} 09:00`,
        shipments:[{ id:'s-bad', trackingNumber:'HTTPSWWWEXAMPLECOMTRACK', carrier:'DHL', status:'已发货', shippedAt:day(2) }] },
      { ...base, id:'prod', num:'T9002', client:'Drawer Add', amount:800, paidAmount:800, orderType:'全款订单', stage:'shipment', updated:`${day(2)} 09:00` },
      { ...base, id:'card', num:'T9003', client:'Quick Card', amount:300, paidAmount:300, orderType:'全款订单', stage:'shipment', updated:`${day(2)} 09:00` }
    ];
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { port:freePortSync() });
    const waitToast = text => h.waitToast(page, text);
    const order = id => h.order(page, id);
    const isOpen = id => page.evaluate(id => document.getElementById(id).classList.contains('open'), id);

    // ===== 判断规则 =====
    const verdicts = await page.evaluate(() => Object.fromEntries([
      'https://www.example.com/abc', 'www.dhl.com', 'ups.com/track?num=1', 'abcdefghij', 'HTTPSWWWEXAMPLECOM', '顺丰', '12345',
      '1Z999AA1012345678', '1'.repeat(41),
      '1Z999AA10123456784', 'UPS: 1Z999AA10123456784', 'T1234567890', '123456789', '91 8833 5262', '871032796510',
      'JJD0099999999', 'GM2951173225174494', 'DHL 1234567890', 'SF1234567890123', ''
    ].map(value => [value, trackingNumberProblem(value)])));
    ['https://www.example.com/abc', 'www.dhl.com', 'ups.com/track?num=1', 'HTTPSWWWEXAMPLECOM'].forEach(value => assert.match(verdicts[value], /网址/, value));
    ['abcdefghij', '顺丰'].forEach(value => assert.match(verdicts[value], /没有数字/, value));
    assert.match(verdicts['12345'], /太短/);
    assert.match(verdicts['1Z999AA1012345678'], /18 位/);
    assert.match(verdicts['1'.repeat(41)], /太长/);
    ['1Z999AA10123456784', 'UPS: 1Z999AA10123456784', 'T1234567890', '123456789', '91 8833 5262', '871032796510', 'JJD0099999999', 'GM2951173225174494', 'DHL 1234567890', 'SF1234567890123', '']
      .forEach(value => assert.equal(verdicts[value], '', `真单号（或空）要能存：${value}`));

    // ===== 订单弹窗：以前存的坏单号不拦，只提示 =====
    await page.evaluate(() => openOrder('bad'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    const primaryHint = () => page.evaluate(() => {
      const hint = document.querySelector('#orderForm [data-shipment-primary-row] [data-shipment-hint]');
      return hint ? { text:hint.textContent, tone:hint.dataset.tone } : null;
    });
    await page.locator('#orderForm [data-shipment-primary-row] [data-shipment-number]').click();
    await page.locator('#orderForm [name="note"]').click();
    assert.deepEqual(await primaryHint(), { text:'这是以前存的单号：这是网址，不是运单号，只填单号本身。不改也能保存', tone:'info' });
    await page.locator('#orderForm [name="note"]').fill('改个备注');
    await page.getByRole('button', { name:'保存订单' }).click();
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    let saved = await order('bad');
    assert.equal(saved.note, '改个备注', '有旧坏单号的订单照常能改别的字段');
    assert.deepEqual(saved.shipments.map(s => s.trackingNumber), ['HTTPSWWWEXAMPLECOMTRACK'], '旧单号不删不改');

    // ===== 订单弹窗：新加一批填网址，拦下；改成真单号后能存 =====
    await page.evaluate(() => openOrder('bad'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await page.locator('#orderForm [data-add-shipment]').click();
    await page.keyboard.type('https://www.example.com/abc', { delay:2 });
    await page.locator('#orderForm [name="note"]').click();
    const extra = page.locator('#orderForm [data-shipment-extra-row]').last();
    assert.equal(await extra.locator('[data-shipment-number]').inputValue(), 'https://www.example.com/abc', '不像单号的输入原样留着，不改写成一串大写字母');
    assert.equal(await extra.locator('[data-shipment-hint]').textContent(), '这是网址，不是运单号，只填单号本身，改正或删掉这一行');
    assert.equal(await extra.evaluate(row => row.classList.contains('is-duplicate')), true, '标红');
    await page.getByRole('button', { name:'保存订单' }).click();
    await waitToast('第 2 批物流单号：这是网址，不是运单号');
    assert.equal(await isOpen('orderModal'), true, '不像单号时不保存、弹窗留着');
    assert.equal((await order('bad')).shipments.length, 1);
    await extra.locator('[data-shipment-number]').fill('1Z999AA10123456784');
    await page.locator('#orderForm [name="note"]').click();
    assert.equal(await extra.locator('[data-shipment-hint]').count(), 0, '改对后红字消失');
    await page.getByRole('button', { name:'保存订单' }).click();
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    saved = await order('bad');
    assert.deepEqual(saved.shipments.map(s => [s.trackingNumber, s.carrier]), [['HTTPSWWWEXAMPLECOMTRACK', 'DHL'], ['1Z999AA10123456784', 'UPS']]);

    // ===== 新建订单：纯字母拦下（草稿也一样） =====
    await page.evaluate(() => openOrder());
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await page.locator('#orderForm [name="client"]').fill('New Letters Only');
    // 新单的物流区要选到已发货才露出来：直接填值，和粘贴识别填进去一样。
    await page.evaluate(() => { document.querySelector('#orderForm [data-shipment-primary-row] [data-shipment-number]').value = 'abcdefghij'; });
    const before = (await page.evaluate(() => state.orders.length));
    await page.evaluate(() => upsertOrder(document.getElementById('orderForm'), { draft:true }));
    await waitToast('第 1 批物流单号：没有数字，不像运单号');
    assert.equal(await page.evaluate(() => state.orders.length), before, '纯字母单号的新单没存进去');
    await page.evaluate(() => closeOrder());

    // ===== 新客户加订单：和订单弹窗同一个检查 =====
    const combinedBlocked = await page.evaluate(() => {
      const form = document.getElementById('combinedOrderForm');
      form.querySelector('[data-shipment-primary-row] [data-shipment-number]').value = 'www.ups.com';
      const blocked = rejectBadShipmentRows(form);
      const hint = form.querySelector('[data-shipment-primary-row] [data-shipment-hint]')?.textContent || '';
      form.querySelector('[data-shipment-primary-row] [data-shipment-number]').value = '';
      syncShipmentRowHints(form);
      return { blocked, hint };
    });
    assert.deepEqual(combinedBlocked, { blocked:true, hint:'这是网址，不是运单号，只填单号本身，改正或删掉这一行' });

    // ===== 抽屉「补运单号」 =====
    await page.evaluate(() => openOrderDetail('prod', { tab:'logistics' }));
    const drawerInput = page.locator('#orderDetailBody [data-detail-ship-input]');
    await drawerInput.waitFor();
    await drawerInput.fill('abc-def-ghi');
    await page.locator('#orderDetailBody [data-detail-ship-add]').click();
    await waitToast('没有数字，不像运单号');
    assert.equal((await order('prod')).shipments.length, 0, '抽屉里补的纯字母单号没存');
    await drawerInput.fill('91 8833 5262');
    await page.locator('#orderDetailBody [data-detail-ship-add]').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'prod').shipments.length === 1);
    assert.equal((await order('prod')).shipments[0].trackingNumber, '9188335262');
    await page.evaluate(() => closeOrderDetail());

    // ===== 已发货补单号小卡片 =====
    await page.evaluate(() => uiTrackingQuickCard('card'));
    const cardInput = page.locator('#trackingQuickCard input');
    await cardInput.fill('https://track.example.com/x');
    await page.locator('#trackingQuickCard [data-track-save]').click();
    await waitToast('这是网址，不是运单号');
    assert.equal(await page.locator('#trackingQuickCard').count(), 1, '小卡片留着让人改');
    assert.equal((await order('card')).shipments.length, 0);
    await cardInput.fill('871032796510');
    await page.locator('#trackingQuickCard [data-track-save]').click();
    await page.waitForFunction(() => state.orders.find(o => o.id === 'card').shipments.length === 1);

    // ===== AI 识别：网址不填进表单 =====
    const ai = await page.evaluate(() => ['https://www.dhl.com/track', '待补', '1Z999AA10123456784']
      .map(value => normalizeAiExtractedFields({ trackingNumber:value }).trackingNumber || ''));
    assert.deepEqual(ai, ['', '', '1Z999AA10123456784']);

    // ===== 导入：坏单号照原样导入，预览里点出来 =====
    const file = { app:'trade-order-system', data:{ orders:[
      { ...base, id:'imp1', num:'T9100', client:'Import Bad', amount:100, paidAmount:0, orderType:'全款订单', stage:'shipment', shipments:[{ id:'i1', trackingNumber:'NOTANUMBER', carrier:'DHL', status:'已发货' }] },
      { ...base, id:'imp2', num:'T9101', client:'Import Good', amount:100, paidAmount:0, orderType:'全款订单', stage:'shipment', shipments:[{ id:'i2', trackingNumber:'1234567890', carrier:'DHL', status:'已发货' }] }
    ], customers:{} } };
    await page.evaluate(json => { previewImportDataFile(new File([json], 'backup.json', { type:'application/json' })); }, JSON.stringify(file));
    await page.waitForFunction(() => document.getElementById('importPreviewModal').classList.contains('open'));
    const previewText = await page.evaluate(() => document.querySelector('#importPreviewModal .modal-body').innerText);
    assert.match(previewText, /有 1 张订单的物流单号不像正常单号（T9100），照原样导入/);
    await page.locator('#importPreviewGoBtn').click();
    await page.waitForFunction(() => state.orders.some(o => o.id === 'imp1'));
    assert.equal((await order('imp1')).shipments[0].trackingNumber, 'NOTANUMBER', '导入时不删不改');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('tracking number check ui ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
