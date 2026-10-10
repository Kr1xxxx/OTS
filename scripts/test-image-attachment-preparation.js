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
  compressImageFile: async (file, options) => {
    calls.push(options);
    return { type: options.type, size: 123, marker: `compressed-${options.maxSide}` };
  },
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
vm.runInContext(extractFunction('saveCompressedImageAttachment'), context);
context.testFile = { type: 'image/png', size: 20 * 1024 * 1024, marker: 'original' };

main().catch(error => {
  console.error(`Image attachment preparation test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const saved = await vm.runInContext('saveCompressedImageAttachment(testFile, 1)', context);
  assert.equal(uploadBody.data, 'data:image/png;base64,original', '支持的图片无论大小都必须原样交给 TinyPNG');
  assert.equal(uploadBody.mimeType, 'image/png');
  assert.equal(calls.length, 1, '只应在本机生成缩略图');
  assert.equal(calls[0].maxSide, 720);
  assert.equal(saved.optimizer, 'TinyPNG');
  console.log('Image attachment preparation test passed: original upload and independent thumbnail verified.');
}
