#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { extractFunction } = require('./helpers/page-source');
const context = vm.createContext({ normalizeDate: value => String(value || '').slice(0, 10) });
['cleanTracking', 'carrierHintFromTrackingText', 'detectCarrier', 'normalizeOrderShipments']
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
assert.deepEqual(evaluate(`normalizeOrderShipments({ shipments:${JSON.stringify(multiple)} })`), multiple, '已经整理过的批次再整理一次不变');

console.log('Multi-shipment tests passed: legacy migration, normalization, dedupe, carrier and status verified.');
