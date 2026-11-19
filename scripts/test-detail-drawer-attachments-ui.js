#!/usr/bin/env node
// 订单抽屉「附件」页直接加附件：选文件 → 进度 → 存进订单（只存压缩版）→ 关了再开还在；粘贴、拖进来；
// 抽屉里别的没保存的输入不跟着存；超过 20 个不收；上传失败不改订单；删除要确认、确认后才删文件；
// 只读（垃圾箱）的订单没有上传区和「删除」。上传接口在测试里挡住，返回编的结果。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');

(async () => {
  const browser = await launchBrowser();
  let board;
  try {
    const link = { name:'报价单', type:'报价单', link:'https://example.com/quote.pdf', time:`${day(2)} 10:00` };
    const orders = [
      { ...base, id:'a1', num:'K-ATT1', client:'Attach Buyer', amount:500, paidAmount:0, stage:'quote', orderType:'定金订单', updated:`${day(2)} 10:00`, attachments:[link] },
      { ...base, id:'a2', num:'K-ATT2', client:'Full Buyer', amount:300, paidAmount:0, stage:'quote', orderType:'定金订单', updated:`${day(2)} 10:00`,
        attachments:Array.from({ length:19 }, (_, index) => ({ name:`凭证 ${index + 1}`, type:'其他', link:`https://example.com/${index}` })) }
    ];
    const trashOrders = [{ ...base, id:'t1', num:'K-TRASH', client:'Trash Buyer', amount:100, paidAmount:0, stage:'quote', trashedAt:`${day(3)} 10:00`, attachments:[link] }];
    board = await openBoard(browser, { orders, trashOrders }, { port:freePortSync() });
    const { page, store, errors, dialogs } = board;

    // 上传接口：记下收到的内容；第一次先挂住，看进度卡和「处理中不能离开」；fail 为真时回 500。
    const uploads = [];
    const deletes = [];
    let hold = null;
    let fail = false;
    await page.route('**/api/attachments', async route => {
      const body = route.request().postDataJSON();
      uploads.push(body);
      if (hold) await hold.promise;
      if (fail) return route.fulfill({ status:500, json:{ ok:false, message:'测试：图片保存失败' } });
      const n = uploads.length;
      return route.fulfill({ json:{ ok:true, name:body.fileName.replace(/\.[^.]+$/, ''), fileUrl:`/attachments/${body.orderId}/img-${n}.webp`, thumbUrl:`/attachments/${body.orderId}/img-${n}-thumb.webp`, size:1234, optimized:false, optimizer:'本机压缩' } });
    });
    await page.route('**/api/delete-attachments', route => {
      deletes.push(route.request().postDataJSON().urls);
      return route.fulfill({ json:{ ok:true, deleted:1 } });
    });
    await page.route('**/attachments/**', route => route.fulfill({ contentType:'image/png', body:png }));
    // WebKit under Playwright also routes the page's own blob: addresses (the picked / pasted picture it is about
    // to compress). openBoard answers everything with JSON, so the picture would fail to load ("图片读取失败").
    await page.route(url => !/^https?:$/.test(url.protocol), route => route.continue());

    // 选文件用的图：页面里 canvas 画的普通 RGBA PNG（和订单弹窗的测试一样），不用手写的 1×1 灰度 PNG。
    const picked = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 160; canvas.height = 100;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f3e8d7'; ctx.fillRect(0, 0, 160, 100);
      ctx.fillStyle = '#0f8f81'; ctx.fillRect(16, 20, 128, 16);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    const stored = id => store.current.data.orders.find(order => order.id === id);
    const panel = page.locator('#orderDetailBody [data-detail-tab="attachments"]');
    const busy = () => page.evaluate(() => Boolean(document.getElementById('orderDetailBody').dataset.attachmentBusy));
    const waitIdle = () => page.waitForFunction(() => !document.getElementById('orderDetailBody').dataset.attachmentBusy);

    // ---- 收款页那句提示改了；附件页有上传区，不再叫人去完整编辑 ----
    await page.evaluate(() => openOrderDetail('a1', { tab:'payment' }));
    assert.match(await page.locator('#orderDetailBody [data-detail-tab="payment"] .detail-edit-hint').innerText(), /付款截图在「附件」页加/);
    await h.click(page, '[data-detail-tab-btn="attachments"]');
    await panel.waitFor({ state:'visible' });
    assert.doesNotMatch(await panel.innerText(), /完整编辑/);
    assert.match(await panel.locator('[data-detail-attach-drop]').innerText(), /把截图粘贴或拖到这里/);
    assert.equal(await panel.locator('[data-detail-remove-attachment]').count(), 1);

    // 抽屉别处改了没保存的内容：加附件不能把它一起存掉，也不能把它清掉。
    await page.evaluate(() => {
      const note = document.querySelector('#orderDetailBody [data-dedit="note"]');
      note.value = '还没保存的备注';
      note.dispatchEvent(new Event('input', { bubbles:true }));
    });

    // ---- 选文件：进度卡、处理中不能离开，传完存进订单 ----
    hold = Promise.withResolvers ? Promise.withResolvers() : (() => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; })();
    const savesBefore = store.saves;
    await panel.locator('[data-detail-attach-input]').setInputFiles({ name:'payment.png', mimeType:'image/png', buffer:picked });
    await page.waitForFunction(() => document.querySelectorAll('#orderDetailBody [data-detail-upload-list] [role="progressbar"]').length === 1);
    // 请求已经发到上传接口（被挡住）：卡片在「上传中 / 优化保存中」。
    const cardState = () => page.evaluate(() => [...document.querySelectorAll('#orderDetailBody .image-upload-card')].map(card => `${card.dataset.state} ${card.getAttribute('aria-valuenow')}% ${card.querySelector('.image-upload-stage')?.textContent}`).join(' | '));
    await page.waitForFunction(() => /上传中|优化保存中/.test(document.querySelector('#orderDetailBody [data-detail-upload-list] .image-upload-stage')?.textContent || '')).catch(async error => {
      throw new Error(`图片没走到上传（上传接口收到 ${uploads.length} 次）：${await cardState()}\n${error.message}`);
    });
    for (let tries = 0; !uploads.length && tries < 250; tries++) await page.waitForTimeout(20);
    assert.equal(uploads.length, 1, '图片发到了上传接口');
    assert(Number(await panel.locator('.image-upload-card').getAttribute('aria-valuenow')) < 100, '服务没确认前不能写 100%');
    assert.equal(await busy(), true);
    assert.equal(await panel.locator('[data-detail-attach-drop]').getAttribute('aria-disabled'), 'true');
    assert.equal(await panel.locator('[data-detail-attach-pick]').isDisabled(), true);
    assert.equal(await panel.locator('[data-detail-remove-attachment]').first().isDisabled(), true);
    await page.evaluate(() => uiCloseDetailGuarded());
    assert.equal(await page.locator('#orderDetailDrawer').evaluate(el => el.classList.contains('open')), true, '上传中不能关抽屉');
    await page.evaluate(() => uiDetailSave());
    assert.equal(store.saves, savesBefore, '上传中抽屉的「保存」要等它做完');
    hold.resolve(); hold = null;
    await waitIdle();
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].compressed, true, '只上传本机压缩版');
    assert.match(uploads[0].mimeType, /^image\/(?:webp|jpeg|png)$/);
    assert.equal(uploads[0].orderId, 'K-ATT1', '图片存在这张单的订单号下面');
    assert.match(uploads[0].fileName, /^K-ATT1-1\./);
    let saved = stored('a1');
    assert.equal(saved.attachments.length, 2);
    assert.equal(saved.attachments[0].fileUrl, '/attachments/K-ATT1/img-1.webp');
    assert.equal(saved.attachments[0].compressed, true);
    assert.equal('temporary' in saved.attachments[0], false, '存进订单的附件不带「待保存」标记');
    assert.deepEqual(saved.attachments[1], link, '已有的附件不动');
    assert.equal(saved.note || '', '', '抽屉里别的没保存的输入不跟着存');
    assert.match(saved.logs[0].text, /^添加附件：/);
    assert.equal(await page.locator('#orderDetailBody [data-dedit="note"]').inputValue(), '还没保存的备注', '没保存的输入留着');
    assert.equal(await page.evaluate(() => uiDetailUnsaved()), true, '没保存的输入仍算没保存');
    assert.equal(await panel.locator('.image-upload-card').count(), 0, '存进订单后进度卡收起，图片在下面的列表里');
    assert.equal(await panel.locator('.detail-attachment').count(), 2);
    assert.equal(await panel.locator('.detail-attachment img').count(), 1);
    assert.equal(await page.locator('#detailAttachmentCount').innerText(), '2');
    await h.waitToast(page, '已添加 1 张图片');
    // 放弃没保存的备注后关掉再开：图片还在，备注是原样。
    const closing = page.evaluate(() => uiCloseDetailGuarded());
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await page.click('#confirmOkBtn');
    await closing;
    await page.evaluate(() => openOrderDetail('a1', { tab:'attachments' }));
    await panel.waitFor({ state:'visible' });
    assert.equal(await panel.locator('.detail-attachment').count(), 2, '重新打开还在');
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'a1').attachments.length), 2, '放弃修改不撤回已经存进去的附件');

    // ---- 粘贴：附件页、焦点不在输入框里才收；别的页签不收 ----
    const paste = () => page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 120; canvas.height = 80;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f8f81'; ctx.fillRect(0, 0, 120, 80);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], 'pasted.png', { type:'image/png' }));
      document.activeElement?.blur?.();
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData:data, bubbles:true, cancelable:true }));
    });
    await h.click(page, '[data-detail-tab-btn="info"]');
    await paste();
    await page.waitForTimeout(200);
    assert.equal(uploads.length, 1, '不在附件页时粘贴不加附件');
    await h.click(page, '[data-detail-tab-btn="attachments"]');
    await paste();
    await page.waitForFunction(() => document.getElementById('orderDetailBody').dataset.attachmentBusy || state.orders.find(o => o.id === 'a1').attachments.length === 3);
    await waitIdle();
    assert.equal(stored('a1').attachments.length, 3);
    assert.match(uploads[1].fileName, /^K-ATT1-2\./, '图片序号接着已有的图片数');

    // ---- 拖进上传区 ----
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 60; canvas.height = 60;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], 'dropped.png', { type:'image/png' }));
      const zone = document.querySelector('#orderDetailBody [data-detail-attach-drop]');
      const fire = type => {
        const event = new Event(type, { bubbles:true, cancelable:true });
        Object.defineProperty(event, 'dataTransfer', { value:data });
        zone.dispatchEvent(event);
        return event;
      };
      if (!fire('dragover').defaultPrevented) throw new Error('上传区不接拖进来的文件');
      if (!zone.classList.contains('is-over')) throw new Error('拖到上面时上传区没有亮起来');
      fire('drop');
    });
    await page.waitForFunction(() => state.orders.find(o => o.id === 'a1').attachments.length === 4);
    await waitIdle();
    assert.equal(stored('a1').attachments.length, 4);
    assert.equal(await panel.locator('[data-detail-attach-drop].is-over').count(), 0);

    // ---- 上传失败：订单不动，失败的卡留着说原因 ----
    fail = true;
    const savesBeforeFail = store.saves;
    await panel.locator('[data-detail-attach-input]').setInputFiles({ name:'broken.png', mimeType:'image/png', buffer:picked });
    await page.waitForFunction(() => document.querySelector('#orderDetailBody .image-upload-card[data-state="error"]'));
    await waitIdle();
    fail = false;
    assert.equal(stored('a1').attachments.length, 4);
    assert.equal(store.saves, savesBeforeFail, '一张都没传上去时不保存订单');
    assert.match(await panel.locator('.image-upload-card[data-state="error"] .image-upload-stage').innerText(), /测试：图片保存失败/);
    await h.waitToast(page, '1 张图片没加上');

    // ---- 删除：先确认，取消就什么都不动；确认后存好订单再删文件 ----
    const first = await page.evaluate(() => state.orders.find(o => o.id === 'a1').attachments[0]);
    await panel.locator('[data-detail-remove-attachment="0"]').click();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await busy(), true, '等确认时不能再加图片');
    await page.click('#confirmCancelBtn');
    await waitIdle();
    assert.equal(stored('a1').attachments.length, 4);
    assert.equal(deletes.length, 0);
    await panel.locator('[data-detail-remove-attachment="0"]').click();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await page.click('#confirmOkBtn');
    await waitIdle();
    saved = stored('a1');
    assert.equal(saved.attachments.length, 3);
    assert.equal(saved.attachments.some(item => item.fileUrl === first.fileUrl), false);
    assert.match(saved.logs[0].text, /^删除附件：/);
    assert.deepEqual(deletes, [[first.fileUrl, first.thumbUrl]]);
    await h.waitToast(page, '附件已删除');
    assert.equal(await page.locator('#orderDetailBody [data-dedit="note"]').inputValue(), '', '放弃过的备注不会回来');

    // ---- 超过 20 个：不上传 ----
    await page.evaluate(() => openOrderDetail('a2', { tab:'attachments' }));
    await panel.waitFor({ state:'visible' });
    const uploadsBefore = uploads.length;
    await panel.locator('[data-detail-attach-input]').setInputFiles([
      { name:'one.png', mimeType:'image/png', buffer:picked },
      { name:'two.png', mimeType:'image/png', buffer:picked }
    ]);
    await h.waitToast(page, '附件最多保留 20 个');
    assert.equal(uploads.length, uploadsBefore);
    assert.equal(stored('a2').attachments.length, 19);

    // ---- 只读（垃圾箱）的订单：没有上传区，也不能删 ----
    await page.evaluate(() => openOrderDetail('t1', { tab:'attachments' }));
    await panel.waitFor({ state:'visible' });
    assert.equal(await panel.locator('[data-detail-attach-drop]').count(), 0);
    assert.equal(await panel.locator('[data-detail-remove-attachment]').count(), 0);
    assert.equal(await panel.locator('.detail-attachment').count(), 1);
    await page.evaluate(() => closeOrderDetail());

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('Detail drawer attachments UI passed: pick, paste and drop add compressed images to the order, other drawer edits stay unsaved, failures leave the order alone, delete asks first, 20 is the limit, read-only orders have no upload area.');
  } finally {
    await board?.context?.close().catch(() => {});
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
