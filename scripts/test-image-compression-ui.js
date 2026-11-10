#!/usr/bin/env node
// 订单图片只存压缩版、原图不留：
// - compactImageBlob 把大图缩到最长边 2560 并换成更小的格式；本来就更小的小图原样用。
// - 以前存下的原图启动后补压：订单链接改指压缩版并写进数据库，压缩版文件比原图小。
// - 订单弹窗开着时补压停手，不动订单。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const token = `image-compression-${process.pid}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-image-compression-'));
const port = freePortSync();
let server = null;

const base = { currency:'USD', country:'🇺🇸 美国 United States', stage:'production', orderType:'定金订单', amount:1000, paidAmount:300, logs:[], shipments:[], orderMonth:'2026-11', createdAt:'2026-11-01' };

async function request(route, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers:{ Authorization:`Bearer ${token}`, ...(options.headers || {}) } });
  return { status:res.status, data:await res.json().catch(() => ({})) };
}

async function waitForHealth() {
  for (let i = 0; i < 200; i++) {
    try { if ((await request('/api/health')).status === 200) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

async function main() {
  const browser = await chromium.launch({ headless:true });
  try {
    // 用浏览器画一张 4000×3000 带噪点的 PNG，当作以前存下的原图。
    const scratch = await browser.newPage();
    const pngBase64 = await scratch.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 4000; canvas.height = 3000;
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(4000, 3000);
      let seed = 7;
      for (let i = 0; i < image.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const noise = seed % 40;
        image.data[i] = 120 + noise; image.data[i + 1] = 90 + noise; image.data[i + 2] = 60 + noise; image.data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      ctx.fillStyle = '#123456'; ctx.font = '200px sans-serif'; ctx.fillText('PAYMENT 1000 USD', 200, 1500);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    });
    await scratch.close();
    const original = Buffer.from(pngBase64, 'base64');
    fs.mkdirSync(path.join(dataDir, 'attachments', 'K26110101'), { recursive:true });
    fs.writeFileSync(path.join(dataDir, 'attachments', 'K26110101', 'K26110101-1.png'), original);
    fs.mkdirSync(path.join(dataDir, 'attachments', 'K26110103'), { recursive:true });
    fs.writeFileSync(path.join(dataDir, 'attachments', 'K26110103', 'K26110103-1.png'), original);
    const otherUrl = '/attachments/K26110103/K26110103-1.png';
    const oldUrl = '/attachments/K26110101/K26110101-1.png';
    const seed = {
      orders:[
        { ...base, id:'o1', num:'K26110101', client:'Alice Baker', attachments:[{ name:'K26110101-1', type:'图片附件', link:oldUrl, fileUrl:oldUrl, thumbUrl:oldUrl, size:original.length, optimized:false, optimizer:'本地原图' }] },
        { ...base, id:'o2', num:'K26110102', client:'Bob Lee', attachments:[] },
        { ...base, id:'o3', num:'K26110103', client:'Bob Lee', attachments:[{ name:'K26110103-1', type:'图片附件', link:otherUrl, fileUrl:otherUrl, thumbUrl:otherUrl, size:original.length, optimized:false, optimizer:'本地原图' }, { name:'gone', type:'图片附件', link:'/attachments/K26110103/gone.png', fileUrl:'/attachments/K26110103/gone.png', optimizer:'本地原图' }] }
      ],
      trashOrders:[], deletedOrders:[],
      customers:{ 'Alice Baker':{ client:'Alice Baker' }, 'Bob Lee':{ client:'Bob Lee' } },
      doneTasks:{}, demoCleared:true, demoCustomersCleared:true
    };
    fs.writeFileSync(path.join(dataDir, 'trade-order-data.json'), JSON.stringify({ app:'trade-order-system', version:'1', data:seed }));
    server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], {
      env:{ ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1' },
      stdio:['ignore', 'ignore', 'inherit']
    });
    await waitForHealth();

    const page = await browser.newPage({ viewport:{ width:1440, height:920 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/trade-order-system.html?token=${encodeURIComponent(token)}#dashboard`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    // 1. 新图：大图缩到 2560、换格式变小；小 JPEG 本来就小，原样用。
    const compact = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 3600; canvas.height = 1800;
      const ctx = canvas.getContext('2d');
      for (let x = 0; x < 3600; x += 30) { ctx.fillStyle = `hsl(${x % 360},60%,50%)`; ctx.fillRect(x, 0, 30, 1800); }
      const big = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const result = await compactImageBlob(big);
      const img = await imageFromFile(result);
      const tiny = document.createElement('canvas');
      tiny.width = 64; tiny.height = 64;
      const small = await new Promise(resolve => tiny.toBlob(resolve, 'image/jpeg', .3));
      const smallResult = await compactImageBlob(small);
      return { bigSize:big.size, size:result.size, type:result.type, width:img.naturalWidth, height:img.naturalHeight, smallKept:smallResult === small };
    });
    assert.ok(compact.size < compact.bigSize, `压缩版应比原图小：${compact.size} vs ${compact.bigSize}`);
    assert.match(compact.type, /^image\/(?:webp|jpeg)$/, '压缩版是 WebP 或 JPEG');
    assert.equal(compact.width, 2560, '最长边缩到 2560');
    assert.equal(compact.height, 1280);
    assert.equal(compact.smallKept, true, '本来就更小的小图原样用');

    // 1b. 大图本来就是压得很狠的 JPEG：缩小重编反而更大时，不能存成比原文件更大的图。
    const tight = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 3200; canvas.height = 2400;
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(3200, 2400);
      for (let i = 0; i < image.data.length; i += 4) { const v = (i * 2654435761) >>> 24; image.data[i] = v; image.data[i + 1] = 255 - v; image.data[i + 2] = v ^ 85; image.data[i + 3] = 255; }
      ctx.putImageData(image, 0, 0);
      const source = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .15));
      const result = await compactImageBlob(source);
      return { source:source.size, result:result.size };
    });
    assert.ok(tight.result <= tight.source, `压缩结果不能比原文件大：${tight.result} vs ${tight.source}`);

    // 1c. WKWebView 编不了 WebP（toBlob 悄悄退回 PNG）：改用 JPEG，透明处垫白。
    const fallback = await page.evaluate(async () => {
      const realToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        return realToBlob.call(this, callback, /webp/i.test(String(type)) ? 'image/png' : type, quality);
      };
      canvasWebpSupported = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 3000; canvas.height = 1000;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#c03030'; ctx.fillRect(1500, 0, 1500, 1000);
        const png = await new Promise(resolve => realToBlob.call(canvas, resolve, 'image/png'));
        const result = await compactImageBlob(png);
        const img = await imageFromFile(result);
        const check = document.createElement('canvas');
        check.width = img.naturalWidth; check.height = img.naturalHeight;
        const checkCtx = check.getContext('2d');
        checkCtx.drawImage(img, 0, 0);
        return { type:result.type, width:img.naturalWidth, corner:[...checkCtx.getImageData(10, 10, 1, 1).data], remembered:canvasWebpSupported };
      } finally {
        HTMLCanvasElement.prototype.toBlob = realToBlob;
        canvasWebpSupported = null;
      }
    });
    assert.equal(fallback.type, 'image/jpeg', 'WebP 编不了就用 JPEG');
    assert.equal(fallback.width, 2560);
    assert.ok(fallback.corner.slice(0, 3).every(value => value > 240), `透明处垫白：${fallback.corner}`);
    assert.equal(fallback.remembered, false, '记住 WebP 编不了，之后不再白编');

    // 2. 订单弹窗开着：补压停手，订单不动。
    await page.evaluate(() => openOrder('o2'));
    await page.waitForFunction(() => document.getElementById('orderModal')?.classList.contains('open'));
    const blocked = await page.evaluate(() => compressExistingOrderImages());
    assert.deepEqual(blocked, { done:0, stopped:true });
    assert.equal(await page.evaluate(() => state.orders.find(order => order.id === 'o1').attachments[0].fileUrl), oldUrl);
    await page.evaluate(() => { document.getElementById('orderModal').classList.remove('open'); });

    // 2b. 抽屉里开着 o1：只跳过 o1 这张，别的照做；文件已经没了的那张记下来以后不再取。
    await page.evaluate(() => openOrderDetail('o1'));
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer')?.classList.contains('open'));
    assert.deepEqual(await page.evaluate(() => compressExistingOrderImages()), { done:1, stopped:true });
    const o3 = await page.evaluate(() => state.orders.find(order => order.id === 'o3').attachments);
    assert.notEqual(o3[0].fileUrl, '/attachments/K26110103/K26110103-1.png', 'o3 的图照常补压');
    assert.equal(o3[1].compressFailed, true, '文件没了的记下来');
    assert.equal(await page.evaluate(() => state.orders.find(order => order.id === 'o1').attachments[0].fileUrl), oldUrl, '抽屉里开着的单不动');

    // 2c. 关掉抽屉后不再挡（以前关了抽屉 detailOrderId 还留着，补压一直停着）。
    await page.evaluate(() => closeOrderDetail());
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer')?.classList.contains('open'));

    // 3. 补压以前的原图：链接改指压缩版、存进数据库，文件更小、最长边 2560。
    const result = await page.evaluate(() => compressExistingOrderImages());
    assert.deepEqual(result, { done:1, stopped:false });
    await page.waitForFunction(() => { const status = window.pendingSaveStatus(); return !status.pending && !status.saving; }, null, { timeout:10000 });
    const saved = (await request('/api/data')).data.data.orders.find(order => order.id === 'o1').attachments[0];
    assert.notEqual(saved.fileUrl, oldUrl, '订单里的图片改指压缩版');
    assert.equal(saved.compressed, true);
    assert.equal(saved.optimizer, '本机压缩');
    assert.equal(saved.link, saved.fileUrl, '链接跟着换');
    assert.notEqual(saved.thumbUrl, oldUrl, '缩略图也换成新的小图');
    const newFile = path.join(dataDir, decodeURIComponent(saved.fileUrl.replace(/^\//, '')));
    const newSize = fs.statSync(newFile).size;
    assert.ok(newSize < original.length / 2, `压缩版应明显更小：${newSize} vs ${original.length}`);
    const dims = await page.evaluate(async url => { const img = new Image(); img.src = url; await img.decode(); return [img.naturalWidth, img.naturalHeight]; }, saved.fileUrl);
    assert.deepEqual(dims, [2560, 1920]);

    // 4. 再跑一次不重复压缩。
    assert.deepEqual(await page.evaluate(() => compressExistingOrderImages()), { done:0, stopped:false });
    assert.deepEqual(errors, []);
    console.log(`Image compression UI test passed: ${(original.length / 1048576).toFixed(1)} MB original → ${(newSize / 1048576).toFixed(2)} MB compressed.`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Image compression UI test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(() => {
  if (server && server.exitCode === null) server.kill();
  setTimeout(() => { try { fs.rmSync(dataDir, { recursive:true, force:true }); } catch (_) {} }, 300);
});
