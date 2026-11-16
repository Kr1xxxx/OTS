#!/usr/bin/env node
// Today's USD → RMB rate for the exchange table: reading the Bank of China rate table by its header text,
// the ICBC JSON answer, refusing anything it cannot read, both banks asked and the lower rate used (one bank
// when the other fails), and the cache in the data folder (asked once a day; after that the old answer
// is handed out at once and renewed in the background). Every table and JSON below is made up in the shape of
// the real answers; the numbers are not real rates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsdCnyRate, parseBocUsdBuyRate, parseIcbcUsdBuyRate, normalizePublishedAt, decodeHtml } = require('../mac-app/usd-cny-rate');

const header = ['货币名称', '现汇买入价', '现钞买入价', '现汇卖出价', '现钞卖出价', '中行折算价', '发布日期', '发布时间'];
const row = (cells, tag = 'td') => `<tr>\n${cells.map(cell => `  <${tag} class="x">${cell}</${tag}>`).join('\n')}\n</tr>`;
function table(rows, columns = header) {
  const order = columns.map(name => header.indexOf(name));
  return `<html><head><meta charset="utf-8"><title>外汇牌价</title></head><body>
<div class="publish"><table width="100%" cellpadding="0" cellspacing="0">
${row(columns, 'th')}
${rows.map(cells => row(order.map(index => cells[index]))).join('\n')}
</table></div></body></html>`;
}
const euro = ['欧元', '801.10', '776.20', '806.90', '809.30', '803.40', '2031.04.05', '09:15:00'];
const dollar = ['美元', '&nbsp;612.34 ', '607.50', '614.90', '614.90', '613.10', '2031.04.05', '09:15:00'];

assert.deepEqual(parseBocUsdBuyRate(table([euro, dollar])), { rate:6.1234, publishedAt:'2031-04-05 09:15' }, 'USD 现汇买入价 per 100, with the publish date and time');
const shuffled = ['货币名称', '中行折算价', '现钞买入价', '发布日期', '现汇买入价', '发布时间', '现汇卖出价', '现钞卖出价'];
assert.deepEqual(parseBocUsdBuyRate(table([dollar, euro], shuffled)), { rate:6.1234, publishedAt:'2031-04-05 09:15' }, 'columns are found by their header, not their position');
assert.deepEqual(parseBocUsdBuyRate(table([dollar], header.slice(0, 6))), { rate:6.1234, publishedAt:'' }, 'a table without publish columns still gives the rate');
// The live page puts date and time into the 发布日期 cell ("2031/04/05 09:15:00") and the time again into 发布时间.
assert.deepEqual(parseBocUsdBuyRate(table([[...dollar.slice(0, 6), '2031/04/05 09:15:00', '09:15:00']])), { rate:6.1234, publishedAt:'2031-04-05 09:15' });
assert.throws(() => parseBocUsdBuyRate(table([euro])), /美元/, 'no USD row: an error, not a number');
assert.throws(() => parseBocUsdBuyRate(table([['美元', '61.23', ...dollar.slice(2)]])), /不对/, 'a rate far outside 5–9 is refused');
assert.throws(() => parseBocUsdBuyRate(table([['美元', '', ...dollar.slice(2)]])), /不对/, 'an empty cell is refused');
assert.throws(() => parseBocUsdBuyRate('<html><body>系统维护中</body></html>'), /表头/, 'a page without the table is refused');

assert.equal(normalizePublishedAt('2031.4.5 9:15:00'), '2031-04-05 09:15');
assert.equal(normalizePublishedAt('2031/04/05'), '2031-04-05');
assert.equal(normalizePublishedAt('09:15:00'), '');
// A page in GBK reads the same as one in UTF-8.
assert.equal(decodeHtml(Buffer.from('<meta charset="gbk"><td>\xc3\xc0\xd4\xaa</td>', 'latin1')), '<meta charset="gbk"><td>美元</td>', 'GBK bytes are decoded as GBK');
assert.equal(decodeHtml(Buffer.from('<td>美元</td>')), '<td>美元</td>', 'no charset: UTF-8');

// 工商银行: the USD item of data, foreignBuy per 100.
const icbcItem = (code, buy) => ({ currencyType:'0', currencyCHName:'某币', currencyENName:code, reference:'1', foreignBuy:buy, foreignSell:'1', cashBuy:'1', cashSell:'1', publishDate:'2031-04-05', publishTime:'08:41:07' });
const icbc = buy => JSON.stringify({ code:0, data:[icbcItem('EUR', '801.00'), icbcItem('USD', buy)] });
assert.deepEqual(parseIcbcUsdBuyRate(icbc('611.11')), { rate:6.1111, publishedAt:'2031-04-05 08:41' });
assert.throws(() => parseIcbcUsdBuyRate(JSON.stringify({ data:[icbcItem('EUR', '801.00')] })), /美元/);
assert.throws(() => parseIcbcUsdBuyRate(icbc('6.1111')), /不对/, 'a number per 1 USD instead of per 100 is refused');
assert.throws(() => parseIcbcUsdBuyRate('<html>busy</html>'), /JSON/);


(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-usd-cny-'));
  try {
    const cacheFile = path.join(dir, 'usd-cny-rate-cache.json');
    let clock = Date.parse('2031-04-05T02:00:00Z');
    const requests = [];
    const answers = { boc:table([euro, dollar]), icbc:icbc('614.40') };
    const sourceOf = url => ({ 'www.boc.cn':'boc', 'papi.icbc.com.cn':'icbc' })[new URL(url).hostname];
    const { queryUsdCnyRate } = createUsdCnyRate({
      cacheFile,
      now:() => clock,
      requestText: async (url, options) => {
        requests.push(sourceOf(url));
        assert.equal(options.binary, true, 'the answer is asked for as bytes, so a GBK page can be decoded');
        const answer = answers[sourceOf(url)];
        if (answer instanceof Error) throw answer;
        return Buffer.from(answer);
      }
    });
    const cache = () => JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const waitForCache = async check => {
      for (let tries = 0; tries < 200 && (!fs.existsSync(cacheFile) || !check(cache())); tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setImmediate(resolve)); // the finished request lets go of its promise
      assert.ok(check(cache()), `cache: ${JSON.stringify(cache())}`);
    };
    const boc = { source:'boc', sourceLabel:'中国银行现汇买入价', rate:6.1234, publishedAt:'2031-04-05 09:15' };
    const icbcQuote = rate => ({ source:'icbc', sourceLabel:'工商银行现汇买入价', rate, publishedAt:'2031-04-05 08:41' });

    // No cache: both banks are asked, once for two callers at the same time; BOC is lower, so BOC's rate is used.
    const [first, second] = await Promise.all([queryUsdCnyRate(), queryUsdCnyRate()]);
    assert.deepEqual(requests.sort(), ['boc', 'icbc'], 'two callers at once share one request to each bank');
    assert.deepEqual(first, { ...boc, quotes:[boc, icbcQuote(6.144)], failed:[], fetchedAt:'2031-04-05T02:00:00.000Z' });
    assert.equal(second, first);
    assert.equal(cache().rate, 6.1234);

    const hours = n => n * 60 * 60 * 1000;
    // Once a day: for the rest of that day in Beijing (10:00 → 23:59) it comes from the file.
    for (const later of [5, 8]) {
      clock += hours(later); // Beijing 15:00, then 23:00
      const cached = await queryUsdCnyRate();
      assert.equal(cached.cached, true);
      assert.equal(cached.stale, undefined);
      assert.equal(requests.length, 2, 'asked once a day');
    }

    // The next day (Beijing 01:00): the old answer at once, a new one fetched behind it. ICBC is lower now: ICBC's rate,
    // still with yesterday's publish date.
    clock += hours(2);
    answers.icbc = icbc('611.11');
    const stale = await queryUsdCnyRate();
    assert.equal(stale.stale, true);
    assert.equal(stale.rate, 6.1234);
    await waitForCache(c => c.source === 'icbc');
    assert.deepEqual({ ...cache(), fetchedAt:undefined }, { ...icbcQuote(6.1111), quotes:[boc, icbcQuote(6.1111)], failed:[], fetchedAt:undefined }, 'the lower of the two banks');
    assert.equal(requests.length, 4);

    // Fetched today but published yesterday: not asked again within six hours, asked again after that.
    clock += hours(3); // Beijing 04:00
    assert.equal((await queryUsdCnyRate()).stale, undefined);
    assert.equal(requests.length, 4);
    // ICBC fails now: BOC's rate alone, and the cache says which bank failed.
    clock += hours(4); // Beijing 08:00, seven hours after the last request
    answers.icbc = new Error('offline');
    assert.equal((await queryUsdCnyRate()).stale, true);
    await waitForCache(c => c.source === 'boc');
    assert.deepEqual({ ...cache(), fetchedAt:undefined }, { ...boc, quotes:[boc], failed:['icbc'], fetchedAt:undefined }, 'one bank failed: the other one');
    // BOC's page changed and ICBC is back: ICBC alone, even though it would not be the lower one.
    clock += hours(24);
    answers.boc = '<html><body>页面改版了</body></html>';
    answers.icbc = icbc('620.00');
    await queryUsdCnyRate();
    await waitForCache(c => c.source === 'icbc');
    assert.deepEqual({ rate:cache().rate, failed:cache().failed }, { rate:6.2, failed:['boc'] });

    // Both banks fail while an old answer exists: the old answer keeps coming back, marked stale.
    clock += hours(24);
    answers.icbc = new Error('offline too');
    const kept = await queryUsdCnyRate();
    assert.equal(kept.rate, 6.2);
    assert.equal(kept.stale, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(cache().rate, 6.2, 'a failed renewal leaves the cache alone');

    // No cache and nothing works: an error naming both banks, nothing written.
    fs.rmSync(cacheFile);
    await assert.rejects(queryUsdCnyRate(), error => ['中国银行', '工商银行'].every(name => error.message.includes(name)));
    assert.equal(fs.existsSync(cacheFile), false);

    // A cache from a source no longer in the list (外汇交易中心 in V3.171–V3.173) is not used.
    fs.writeFileSync(cacheFile, JSON.stringify({ rate:6.5, source:'cfets', fetchedAt:new Date(clock).toISOString() }));
    answers.boc = table([dollar]);
    assert.equal((await queryUsdCnyRate()).source, 'boc');

    console.log('USD/CNY rate tests passed: BOC table read by header, ICBC answer, bad answers refused, GBK decoded, both banks asked and the lower rate used, one bank when the other fails, once a day, stale served while renewing, failures keep the old answer.');
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
