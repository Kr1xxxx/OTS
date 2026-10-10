#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  const bodyStart = html.indexOf('{', start);
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const source = html.slice(start, index + 1);
    try { new vm.Script(source); return source; } catch (_) {}
  }
  throw new Error(`Unclosed function: ${name}`);
}

const context = vm.createContext({ normalizeDate: value => String(value || '').slice(0, 10) });
['cleanTracking', 'carrierHintFromTrackingText', 'detectCarrier', 'normalizeOrderShipments', 'primaryOrderShipment']
  .forEach(name => vm.runInContext(extractFunction(name), context));
const evaluate = expression => JSON.parse(JSON.stringify(vm.runInContext(expression, context)));

const legacy = evaluate(`normalizeOrderShipments(${JSON.stringify({
  trackingNumber:' 1234 5678 9012 ', carrier:'FedEx', logisticsStatus:'运输中', logisticsUpdated:'2026-08-29 10:00'
})})`);
assert.equal(legacy.length, 1);
assert.equal(legacy[0].trackingNumber, '123456789012');
assert.equal(legacy[0].carrier, 'FedEx');
assert.equal(legacy[0].status, '运输中');

const multiple = evaluate(`normalizeOrderShipments(${JSON.stringify({
  shipments:[
    { trackingNumber:'1Z 999 AA1 01 2345 6784', carrier:'UPS', status:'派送中' },
    { trackingNumber:'1234567890', carrier:'DHL', status:'已签收' },
    { trackingNumber:'1234567890', carrier:'DHL', status:'运输中' }
  ],
  trackingNumber:'legacy-ignored'
})})`);
assert.equal(multiple.length, 2, '重复物流单号应去重');
assert.equal(multiple[0].carrier, 'UPS');
assert.equal(multiple[1].status, '已签收');
assert.deepEqual(evaluate(`primaryOrderShipment({ shipments:${JSON.stringify(multiple)} })`), multiple[0]);

console.log('Multi-shipment tests passed: legacy migration, normalization, dedupe, carrier and status verified.');
