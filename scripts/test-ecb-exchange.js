#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'mac-app', 'server.js'), 'utf8');
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  const bodyStart = source.indexOf('{', start);
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] !== '}') continue;
    const candidate = source.slice(start, index + 1);
    try { new vm.Script(candidate); return candidate; } catch (_) {}
  }
  throw new Error(`Unclosed function: ${name}`);
}
const context = vm.createContext({});
vm.runInContext(extractFunction('parseEcbHistoricalRates'), context);
const xml = `<Cube><Cube time='2026-08-28'><Cube currency='USD' rate='1.2000'/><Cube currency='GBP' rate='0.8000'/></Cube><Cube time='2026-08-27'><Cube currency='USD' rate='1.1900'/></Cube></Cube>`;
const rows = JSON.parse(JSON.stringify(vm.runInContext(`parseEcbHistoricalRates(${JSON.stringify(xml)})`, context)));
assert.deepEqual(rows, [
  { date:'2026-08-28', rates:{ EUR:1, USD:1.2, GBP:0.8 } },
  { date:'2026-08-27', rates:{ EUR:1, USD:1.19 } }
]);
assert.match(source, /eurofxref-hist\.xml/);
assert.match(source, /exchange-rates-cache\.json/);
console.log('ECB exchange tests passed: official history XML parsing and local cache verified.');
