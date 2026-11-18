#!/usr/bin/env node
// 订单弹窗粘贴图片的三条规则：
// - 一次粘贴超过 5 张：只加前 5 张，提示里说出另外几张没加（以前只说「已添加 5 张」，多的悄悄丢了）。
// - 订单详情抽屉盖在订单弹窗上面时粘贴：图不加到下面那张看不见的订单里。
// - 附件列表里的小图读缩略图，点开预览才读整张图。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const order = (id, num) => ({ id, num, client:`Paste Buyer ${id}`, amount:100, paidAmount:0, currency:'USD', stage:'quote', orderType:'定金订单', productType:'假发', createdAt:'2026-10-03', orderMonth:'2026-10', updated:'2026-10-03 10:00', logs:[], shipments:[], attachments:[] });

(async () => {
  const browser = await chromium.launch({ headless:true });
  // 页面的请求都由 page.route 回答；这个本机服务只是给页面一个能打开的地址
  //（WebKit 不让打开 9 号这类受限端口，连 page.route 也走不到）。
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage({ viewport:{ width:1280, height:900 } });
    const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
    const errors = [];
    let uploads = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      if (!/^https?:/.test(route.request().url())) return route.continue();
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:0, data:{ orders:[order('paste-a', 'PASTE-A'), order('paste-b', 'PASTE-B')], customers:{}, demoCleared:true, demoCustomersCleared:true } } });
      if (pathname === '/api/health') return route.fulfill({ json:{ ok:true, storageMode:'sqlite', counts:{ orders:2 }, backups:{ sqliteCount:0 } } });
      if (pathname === '/api/attachments' && route.request().method() === 'POST') {
        uploads += 1;
        return route.fulfill({ json:{ ok:true, name:`PASTE-A-${uploads}`, fileUrl:`/attachments/PASTE-A/PASTE-A-${uploads}.webp`, thumbUrl:`/attachments/PASTE-A/PASTE-A-${uploads}-thumb.webp`, size:2048, optimized:false, optimizer:'本机压缩', compressed:true } });
      }
      if (pathname.startsWith('/attachments/')) return route.fulfill({ contentType:'image/png', body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64') });
      return route.fulfill({ json:{ ok:true } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/trade-order-system.html?token=ui-test-token`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    // selector：在哪个元素上发出粘贴（焦点所在的地方）。
    const paste = (selector, count) => page.evaluate(async ({ selector, count }) => {
      const data = new DataTransfer();
      for (let i = 0; i < count; i++) {
        const canvas = document.createElement('canvas');
        canvas.width = 120; canvas.height = 80;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = `hsl(${i * 50}, 60%, 50%)`; ctx.fillRect(0, 0, 120, 80);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        data.items.add(new File([blob], `shot-${i}.png`, { type:'image/png' }));
      }
      document.querySelector(selector).dispatchEvent(new ClipboardEvent('paste', { clipboardData:data, bubbles:true, cancelable:true }));
    }, { selector, count });
    const formAttachments = () => page.evaluate(() => orderAttachmentsFromForm(document.getElementById('orderForm')));
    const idle = () => page.waitForFunction(() => !document.getElementById('orderForm').dataset.uploading);

    await page.evaluate(() => openOrder('paste-a'));
    await paste('#orderForm', 7);
    await page.waitForFunction(() => document.querySelectorAll('#orderImageUploads [data-state="complete"]').length === 5, null, { timeout:10000 });
    await idle();
    assert.equal(uploads, 5, '一次只传前 5 张');
    assert.equal((await formAttachments()).length, 5);
    const toastText = await page.locator('#toast').innerText();
    assert.match(toastText, /已添加 5 张/);
    assert.match(toastText, /另外 2 张没加/, '多出来的 2 张要在提示里说出来');

    // 小图读缩略图，预览读整张图。
    const thumb = page.locator('#attachmentList .attachment-thumb-btn').first();
    assert.match(await thumb.locator('img').getAttribute('src'), /-thumb\.webp$/);
    assert.doesNotMatch(await thumb.getAttribute('data-preview-image'), /-thumb\.webp$/);

    // 抽屉盖在订单弹窗上：焦点在抽屉里、或者没有焦点时粘贴，下面那张单都不收。
    await page.evaluate(() => openOrderDetail('paste-b'));
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open'));
    await paste('#orderDetailBody', 1);
    await page.evaluate(() => document.activeElement?.blur?.());
    await paste('body', 1);
    await page.waitForTimeout(300);
    assert.equal(uploads, 5, '抽屉盖着时不能往下面的订单弹窗传图');
    assert.equal((await formAttachments()).length, 5);
    assert.equal(await page.evaluate(() => Boolean(document.getElementById('orderForm').dataset.uploading)), false);

    // 抽屉关掉、弹窗在最上面：没有焦点时粘贴照常收。
    await page.evaluate(() => closeOrderDetail());
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));
    await page.evaluate(() => document.activeElement?.blur?.());
    await paste('body', 1);
    await page.waitForFunction(() => document.querySelectorAll('#orderImageUploads [data-state="complete"]').length === 1, null, { timeout:10000 });
    await idle();
    assert.equal(uploads, 6);
    assert.equal((await formAttachments()).length, 6);
    assert.doesNotMatch(await page.locator('#toast').innerText(), /另外 0 张/);

    assert.deepEqual(errors, []);
    console.log('Attachment paste rules passed: more than 5 pasted images are reported, a drawer above the order dialog keeps the paste, list thumbnails use the thumbnail file.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
