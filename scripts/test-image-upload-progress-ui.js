#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

// Catches premature 100%, missing per-image feedback, lost partial success,
// and saving/closing a form while its attachment request is still pending.
(async () => {
  const browser = await chromium.launch({ headless:true });
  let releaseUpload;
  let attachmentRequests = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      attachmentRequests++;
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(req.headers['x-trade-token'], 'ui-test-token');
      assert.equal(body.mimeType, 'image/png');
      assert(body.data.startsWith('data:image/png;base64,'));
      if (attachmentRequests === 1) {
        await new Promise(resolve => { releaseUpload = resolve; });
        res.writeHead(200, { 'Content-Type':'application/json' });
        res.end(JSON.stringify({ ok:true, name:'Payment Screenshot', fileUrl:'/attachments/test/payment.png', thumbUrl:'/attachments/test/payment-thumb.png', size:128, optimized:false, optimizer:'本地原图' }));
      } else {
        res.writeHead(500, { 'Content-Type':'application/json' });
        res.end(JSON.stringify({ ok:false, message:'测试：图片保存失败' }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage({ viewport:{ width:1200, height:900 } });
    const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
    let saves = 0;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:0, data:{ orders:[{ id:'upload-existing', num:'UPLOAD-TEST', client:'Upload Test Buyer', amount:100, paidAmount:0, currency:'USD', stage:'quote', productType:'睫毛', createdAt:'2026-10-03', attachments:Array.from({ length:18 }, (_, index) => ({ name:`Existing ${index}`, link:`https://example.com/${index}`, type:'其他' })) }], customers:{}, demoCleared:true, demoCustomersCleared:true } } });
      if (pathname === '/api/health') return route.fulfill({ json:{ ok:true, storageMode:'sqlite', counts:{ orders:0 }, backups:{ sqliteCount:0 } } });
      if (pathname === '/api/save') saves++;
      if (pathname === '/api/attachments' && route.request().method() === 'POST') {
        return route.continue();
      }
      if (pathname.startsWith('/attachments/')) return route.fulfill({ contentType:'image/png', body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64') });
      return route.fulfill({ json:{ ok:true } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/trade-order-system.html?token=ui-test-token`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => openOrder('upload-existing'));
    await page.locator('#orderForm [name="client"]').fill('Upload Test Buyer');
    await page.locator('#orderForm [name="client"]').press('Escape');
    await page.locator('#orderForm [name="amount"]').fill('100');
    await page.locator('#orderForm [name="sendFeishuNotification"]').uncheck();
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 240; canvas.height = 160;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f3e8d7'; ctx.fillRect(0, 0, 240, 160);
      ctx.fillStyle = '#0f8f81'; ctx.fillRect(24, 28, 192, 20);
      ctx.fillStyle = '#5f5549'; ctx.font = '16px sans-serif'; ctx.fillText('PAYMENT', 24, 90);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], 'payment.png', { type:'image/png' }));
      data.items.add(new File([blob], 'shipping.png', { type:'image/png' }));
      window.uploadTestClipboard = data;
      document.getElementById('orderForm').dispatchEvent(new ClipboardEvent('paste', { clipboardData:data, bubbles:true, cancelable:true }));
    });
    const cards = page.locator('#orderImageUploads .image-upload-card');
    await page.waitForFunction(() => document.querySelectorAll('#orderImageUploads [role="progressbar"]').length === 2, null, { timeout:3000 });
    await page.waitForFunction(() => document.querySelector('#orderImageUploads .image-upload-stage')?.textContent === '优化保存中');
    assert.equal(await cards.nth(0).getAttribute('data-state'), 'uploading');
    assert(Number(await cards.nth(0).getAttribute('aria-valuenow')) < 100, '不能在服务器确认前显示完成');
    assert.equal(await cards.nth(1).getAttribute('aria-valuenow'), '0', '排队图片不应假装已上传');
    assert.equal(JSON.parse(await page.locator('#orderForm [name="attachmentsJson"]').inputValue()).length, 18);
    await page.locator('#orderImageUploads').scrollIntoViewIfNeeded();
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      await page.waitForTimeout(250); // Allow the existing theme/progress transitions to settle for visual inspection.
      if (process.env.UI_SCREENSHOT) await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.${theme}.png` });
    }
    await page.evaluate(() => upsertOrder(document.getElementById('orderForm')));
    assert.equal(saves, 0, '上传中不应保存不完整订单');
    await page.evaluate(() => closeOrder());
    assert(await page.locator('#orderModal').isVisible(), '上传中关闭会让附件归属丢失');
    await page.locator('#attachmentName').fill('Concurrent manual attachment');
    await page.locator('#addAttachmentBtn').click();
    assert.equal(JSON.parse(await page.locator('#orderForm [name="attachmentsJson"]').inputValue()).length, 18, '上传中不能添加附件挤掉已有记录');
    await page.evaluate(() => duplicateOrder());
    assert.equal(await page.evaluate(() => state.orders.length), 1, '上传中复制不能提前修改订单');
    assert.equal(await page.evaluate(() => softDeleteOrder('upload-existing', { closeModal:true })), false, '上传中删除不能提前修改订单');
    assert.equal(await page.evaluate(() => state.orders[0]?.id), 'upload-existing');
    releaseUpload(); releaseUpload = null;
    await page.waitForFunction(() => !document.getElementById('orderForm').dataset.uploading);
    assert.equal(await cards.nth(0).getAttribute('aria-valuenow'), '100');
    assert.equal(await cards.nth(0).getAttribute('data-state'), 'complete');
    assert.equal(await cards.nth(1).getAttribute('data-state'), 'error');
    assert.notEqual(await cards.nth(1).getAttribute('aria-valuenow'), '100', '失败不能显示100%');
    const attachments = JSON.parse(await page.locator('#orderForm [name="attachmentsJson"]').inputValue());
    assert.equal(attachments.length, 19, '后续图片失败不能丢掉前面成功的图片或已有附件');
    assert.equal(attachments.at(-1).name, 'Existing 17', '不能静默截掉已有附件');
    assert.equal(attachments[0].fileUrl, '/attachments/test/payment.png');
    assert.equal(attachments[0].temporary, true, '添加图片不等于保存订单');
    await page.locator('[data-remove-attachment="1"]').click();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(window.uploadTestClipboard.files[0]);
      document.getElementById('orderForm').dispatchEvent(new ClipboardEvent('paste', { clipboardData:data, bubbles:true, cancelable:true }));
    });
    assert.equal(await page.evaluate(() => Boolean(document.getElementById('orderForm').dataset.uploading)), false, '等待删除确认时不能启动会被旧列表覆盖的上传');
    await page.locator('#confirmOkBtn').click();
    await page.waitForFunction(() => !document.getElementById('orderForm').dataset.deletingAttachment);
    const afterDelete = JSON.parse(await page.locator('#orderForm [name="attachmentsJson"]').inputValue());
    assert.equal(afterDelete.length, 18);
    assert.equal(afterDelete[0].fileUrl, '/attachments/test/payment.png', '删除已有附件不能丢掉刚上传的图片');
    assert.equal(await page.locator('#orderImageUploads [data-state="complete"]').count(), 1, 'deleting a different attachment must preserve the completed-upload thumbnail');
    assert.equal(attachmentRequests, 2);
    await page.emulateMedia({ reducedMotion:'reduce' });
    const duration = await cards.nth(0).locator('.image-upload-ring-progress').evaluate(el => getComputedStyle(el).transitionDuration);
    assert.equal(duration, '0s', '减少动态效果时应保留静态进度');
    await page.setViewportSize({ width:720, height:640 });
    await page.locator('#orderImageUploads').scrollIntoViewIfNeeded();
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.narrow.png` });
    assert.equal(await cards.nth(0).evaluate(el => el.scrollWidth <= el.clientWidth), true);
    const uploadedPreviewUrl = await cards.nth(0).locator('img').getAttribute('src');
    await page.evaluate(() => {
      window.revokedUploadPreviewUrls = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { window.revokedUploadPreviewUrls.push(url); revoke(url); };
    });
    await page.locator('[data-remove-attachment="0"]').click();
    await page.locator('#confirmCancelBtn').click();
    await page.waitForFunction(() => !document.getElementById('orderForm').dataset.deletingAttachment);
    assert.equal(await page.locator('#orderImageUploads [data-state="complete"]').count(), 1, 'cancelling deletion must keep the preview');
    assert.equal(await page.evaluate(() => window.revokedUploadPreviewUrls.length), 0);
    await page.locator('[data-remove-attachment="0"]').click();
    await page.locator('#confirmOkBtn').click();
    await page.waitForFunction(() => !document.getElementById('orderForm').dataset.deletingAttachment);
    assert.equal(await page.locator('#attachmentList [data-preview-image]').count(), 0, 'deleted attachment must disappear from the attachment list');
    assert.equal(await page.locator('#orderImageUploads [data-state="complete"]').count(), 0, 'deleted attachment must also lose its completed-upload thumbnail');
    assert.equal(await page.locator('#orderImageUploads [data-state="error"]').count(), 1, 'deleting a successful attachment must preserve unrelated failed-upload feedback');
    assert.equal(await page.evaluate(url => window.revokedUploadPreviewUrls.includes(url), uploadedPreviewUrl), true, 'deleted upload preview must release its object URL');
    assert.equal(JSON.parse(await page.locator('#orderForm [name="attachmentsJson"]').inputValue()).length, 17);
    assert.equal(saves, 0, 'deleting a temporary attachment must not submit the order');
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.deleted.png` });
    assert.deepEqual(errors, []);
    console.log('Image upload progress UI passed: real paste, server acknowledgement, queue, partial failure, form guards, reduced motion and responsive layout.');
  } finally {
    releaseUpload?.();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
