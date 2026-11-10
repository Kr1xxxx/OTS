#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');

function extractFunction(name) {
  const asyncStart = html.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  const bodyStart = html.indexOf('{', start);
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const candidate = html.slice(start, index + 1);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error(`Unclosed function: ${name}`);
}

const calls = [];
let uploadBody = null;
const context = vm.createContext({
  isMacAppMode: () => true,
  compactImageBlob: async (file, options) => {
    calls.push(options);
    return { type: 'image/jpeg', size: 123, marker: `compressed-${options.maxSide}` };
  },
  attachmentImageMaxSide: 2560,
  attachmentImageQuality: .82,
  attachmentThumbMaxSide: 720,
  attachmentThumbQuality: .8,
  blobToDataUrl: async blob => `data:${blob.type};base64,${blob.marker}`,
  orderAttachmentImageName: () => 'SO-TEST-1',
  orderAttachmentBucket: () => 'SO-TEST',
  uploadAttachmentImage: async body => {
    uploadBody = body;
    return {
      ok: true,
        name: 'SO-TEST-1',
        fileUrl: '/attachments/SO-TEST/SO-TEST-1.png',
        thumbUrl: '/attachments/SO-TEST/SO-TEST-1-thumb.png',
        size: 456,
        optimized: true,
        optimizer: 'TinyPNG'
    };
  },
  nowText: () => '2026-08-26 12:00'
});
vm.runInContext(extractFunction('attachmentImageExtension'), context);
vm.runInContext(extractFunction('saveCompressedImageAttachment'), context);
context.testFile = { type: 'image/png', size: 20 * 1024 * 1024, marker: 'original' };

main().catch(error => {
  console.error(`Image attachment preparation test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const saved = await vm.runInContext('saveCompressedImageAttachment(testFile, 1)', context);
  assert.equal(uploadBody.data, 'data:image/jpeg;base64,compressed-2560', '只上传本机压缩版，原图不交给服务端');
  assert.ok(!JSON.stringify(uploadBody).includes('original'), '上传内容里不能带原图');
  assert.equal(uploadBody.mimeType, 'image/jpeg');
  assert.equal(uploadBody.fileName, 'SO-TEST-1.jpg');
  assert.equal(uploadBody.compressed, true);
  assert.deepEqual(calls.map(item => item.maxSide), [2560, 720], '压缩版最长边 2560，缩略图 720');
  assert.equal(uploadBody.thumbData, 'data:image/jpeg;base64,compressed-720');
  assert.equal(saved.optimizer, 'TinyPNG');
  assert.equal(saved.compressed, true);
  console.log('Image attachment preparation test passed: only the compressed image and thumbnail are uploaded.');
}
