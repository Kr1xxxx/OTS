#!/usr/bin/env node
// 承运商的非标准状态（On FedEx vehicle for delivery、Shipment on hold、Not delivered…）在服务端换成 6 个标准状态再交给前端，
// 前端 normalizeTrackingStatus 和服务端 standardLogisticsStatus 用同一套规则；认不出的回空状态（前端不改原来的状态），原文另存。
// 以前服务端把原文当状态返回，前端刷新后一律变成「已发货」；前端还先认 delivered，把 "Not delivered" 判成已签收。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');
const carriers = require('../mac-app/carrier-tracking');

function extract(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `Missing production code: ${signature}`);
  const bodyStart = source.indexOf('{', start + signature.length - 1);
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] !== '}') continue;
    const end = source[index + 1] === ';' ? index + 2 : index + 1;
    const candidate = source.slice(start, end);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error(`Unclosed code: ${signature}`);
}

const frontContext = vm.createContext({});
vm.runInContext(extract(html, 'function normalizeTrackingStatus('), frontContext);

const serverStatus = text => carriers.standardLogisticsStatus(text);
const frontStatus = text => vm.runInContext(`normalizeTrackingStatus(${JSON.stringify(text)})`, frontContext);

const cases = [
  ['Delivered', '已签收'],
  ['Delivered - Signed for by: J.SMITH', '已签收'],
  ['Not delivered', '异常'],
  ['Not delivered - recipient not available', '异常'],
  ['Delivery attempted', '异常'],
  ['Undeliverable address', '异常'],
  ['Delivery exception', '异常'],
  ['Shipment on hold', '异常'],
  ['Clearance delay', '异常'],
  ['Shipment returned to shipper', '异常'],
  ['扣件', '异常'],
  ['On FedEx vehicle for delivery', '派送中'],
  ['Out for delivery', '派送中'],
  ['With delivery courier', '派送中'],
  ['Ready for pickup', '派送中'],
  ['Held at FedEx location', '派送中'],
  ['In transit', '运输中'],
  ['Arrived at FedEx location', '运输中'],
  ['Departed FedEx hub', '运输中'],
  ['Processed at DHL facility', '运输中'],
  ['At local FedEx facility', '运输中'],
  ['Shipment information received', '已发货'],
  ['Label created', '已发货'],
  ['Picked up', '已发货'],
  ['已签收', '已签收'],
  ['派送中', '派送中'],
  ['运输中', '运输中'],
  ['已发货', '已发货'],
  ['异常', '异常'],
  ['Something we have never seen', '']
];
for (const [text, expected] of cases) {
  assert.equal(serverStatus(text), expected, `server: ${text}`);
  assert.equal(frontStatus(text), expected, `front: ${text}`);
}

// DHL：文字明确说没送到 / 扣件时以文字为准（statusCode 可能还是 transit）；认不出回空。
const dhl = shipment => carriers.logisticsStatusFromDhl(shipment);
assert.equal(dhl({ status:{ statusCode:'transit', description:'Shipment on hold' } }), '异常');
assert.equal(dhl({ status:{ statusCode:'delivered', description:'Delivered' } }), '已签收');
assert.equal(dhl({ status:{ statusCode:'transit', description:'Not delivered' } }), '异常');
assert.equal(dhl({ status:{ statusCode:'failure', description:'' } }), '异常');
assert.equal(dhl({ status:{ statusCode:'transit', description:'Processed at LEIPZIG' } }), '运输中');
assert.equal(dhl({ status:{ statusCode:'pre-transit', description:'' } }), '已发货');
assert.equal(dhl({ status:{ statusCode:'unknown', description:'zzz' } }), '');

// FedEx：按状态代码映射，代码认不出再看文字。
const fedex = detail => carriers.logisticsStatusFromFedEx({ latestStatusDetail:detail });
assert.equal(fedex({ code:'OD', statusByLocale:'On FedEx vehicle for delivery' }), '派送中');
assert.equal(fedex({ code:'DL', statusByLocale:'Delivered' }), '已签收');
assert.equal(fedex({ code:'DE', statusByLocale:'Delivery exception' }), '异常');
assert.equal(fedex({ code:'IT', statusByLocale:'In transit' }), '运输中');
assert.equal(fedex({ code:'HL', statusByLocale:'Ready for pickup' }), '派送中');
assert.equal(fedex({ code:'SE', statusByLocale:'Shipment exception' }), '异常');
assert.equal(fedex({ code:'XX', statusByLocale:'Shipment on hold' }), '异常');
assert.equal(fedex({ code:'XX', statusByLocale:'Mystery' }), '');

// 服务端认不出时返回空状态 + 原文，不再把原文当状态：对着本机的假 DHL 接口真查一次。
async function unknownStatusKeepsCarrierText() {
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ shipments:[{ status:{ statusCode:'unknown', description:'Awaiting carrier magic', timestamp:'2025-01-02T03:04:05Z' }, events:[] }] }));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  try {
    process.env.OTS_DHL_TRACKING_ENDPOINT = `http://127.0.0.1:${fake.address().port}/track/shipments`;
    const modulePath = require.resolve('../mac-app/carrier-tracking');
    delete require.cache[modulePath];
    const written = [];
    const tracking = require(modulePath).createCarrierTracking({
      readTrackingSettings:() => ({ dhlApiEnabled:'是', dhlApiKey:'made-up-key' }),
      writeTrackingSettings:patch => written.push(patch)
    });
    const result = await tracking.queryDhlTracking('1234567890');
    assert.equal(result.ok, true);
    assert.equal(result.status, '', 'a status the server cannot map stays empty');
    assert.equal(result.rawStatus, 'Awaiting carrier magic', 'the carrier text is returned as rawStatus');
    assert.match(written[0].lastDhlStatus, /状态未识别（Awaiting carrier magic）/);
  } finally {
    delete process.env.OTS_DHL_TRACKING_ENDPOINT;
    await new Promise(resolve => fake.close(resolve));
  }
}

unknownStatusKeepsCarrierText().then(() => {
  console.log(`Tracking status mapping passed: ${cases.length} carrier phrases map the same on server and front end; DHL / FedEx codes verified; unmapped carrier text returned as rawStatus.`);
}).catch(error => { console.error(error); process.exitCode = 1; });
