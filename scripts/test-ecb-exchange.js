#!/usr/bin/env node
// Exchange rates of the European Central Bank: parsing the history file, and the cache in the data
// folder (fresh for a day; after that the old rates are handed out at once and renewed in the background).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEcbRates, parseEcbHistoricalRates } = require('../mac-app/ecb-rates');

const xml = `<Cube><Cube time='2026-08-28'><Cube currency='USD' rate='1.2000'/><Cube currency='GBP' rate='0.8000'/><Cube currency='JPY' rate='170.1'/></Cube><Cube time='2026-08-27'><Cube currency='USD' rate='1.1900'/></Cube></Cube>`;
const expected = [
  { date:'2026-08-28', rates:{ EUR:1, USD:1.2, GBP:0.8 } },
  { date:'2026-08-27', rates:{ EUR:1, USD:1.19 } }
];
assert.deepEqual(parseEcbHistoricalRates(xml), expected, 'days come newest first, with the currencies the app uses only');
assert.deepEqual(parseEcbHistoricalRates('<html>not the file</html>'), []);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-ecb-'));
  try {
    const cacheFile = path.join(dir, 'exchange-rates-cache.json');
    const requests = [];
    let answer = xml;
    const { queryEcbHistoricalRates } = createEcbRates({
      cacheFile,
      requestText: async url => { requests.push(url); if (answer instanceof Error) throw answer; return answer; }
    });

    // No cache yet: the history is fetched once, also for two callers at the same time, and kept.
    const [first, second] = await Promise.all([queryEcbHistoricalRates(), queryEcbHistoricalRates()]);
    assert.equal(requests.length, 1, 'two callers at once share one download');
    assert.match(requests[0], /^https:\/\/www\.ecb\.europa\.eu\/.*eurofxref-hist\.xml$/);
    assert.deepEqual(first.rates, expected);
    assert.equal(second, first);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).rates, expected);

    // Fresh cache: answered from the file.
    const cached = await queryEcbHistoricalRates();
    assert.equal(cached.cached, true);
    assert.equal(cached.stale, undefined);
    assert.equal(requests.length, 1);

    // Cache older than a day: the old rates come back at once, the download runs behind them.
    const old = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    old.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(cacheFile, JSON.stringify(old));
    answer = xml.replace('1.2000', '1.2500');
    const stale = await queryEcbHistoricalRates();
    assert.equal(stale.stale, true);
    assert.equal(stale.rates[0].rates.USD, 1.2);
    for (let tries = 0; tries < 200 && JSON.parse(fs.readFileSync(cacheFile, 'utf8')).rates[0].rates.USD !== 1.25; tries += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).rates[0].rates.USD, 1.25, 'the cache is renewed in the background');
    assert.equal(requests.length, 2);
    await new Promise(resolve => setImmediate(resolve)); // the finished download lets go of its promise

    // No cache and no network, or an answer without rates: an error, and nothing is written.
    fs.rmSync(cacheFile);
    answer = new Error('offline');
    await assert.rejects(queryEcbHistoricalRates(), /offline/);
    answer = '<html>maintenance</html>';
    await assert.rejects(queryEcbHistoricalRates(), /ECB/);
    assert.equal(fs.existsSync(cacheFile), false);

    console.log('ECB exchange tests passed: history parsing, one shared download, day-long cache, stale rates served while renewing, failures leave no cache.');
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
