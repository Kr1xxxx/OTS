#!/usr/bin/env node
// Today's USD → RMB rate for the exchange table: reading the Bank of China rate table by its header text,
// the ICBC and CFETS JSON answers, refusing anything it cannot read, the three sources tried in order
// (中行 → 工行 → 外汇交易中心), and the cache in the data folder (asked once a day; after that the old answer
// is handed out at once and renewed in the background). Every table and JSON below is made up in the shape of
// the real answers; the numbers are not real rates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsdCnyRate, parseBocUsdBuyRate, parseIcbcUsdBuyRate, parseCfetsUsdMid, normalizePublishedAt, decodeHtml } = require('../mac-app/usd-cny-rate');

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

// 外汇交易中心: the newest record, values[0] per 1 USD.
const cfets = (...records) => JSON.stringify({ head:{}, records });
assert.deepEqual(parseCfetsUsdMid(cfets({ date:'2031-04-03', values:['6.1800'] }, { date:'2031-04-04', values:['6.1900'] })), { rate:6.19, publishedAt:'2031-04-04' }, 'the newest day, whatever the order');
assert.throws(() => parseCfetsUsdMid(cfets()), /没有/);
assert.throws(() => parseCfetsUsdMid(cfets({ date:'2031-04-04', values:['619.00'] })), /不对/);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-usd-cny-'));
  try {
    const cacheFile = path.join(dir, 'usd-cny-rate-cache.json');
    let clock = Date.parse('2031-04-05T02:00:00Z');
    const requests = [];
    const answers = { boc:table([euro, dollar]), icbc:icbc('611.11'), cfets:cfets({ date:'2031-04-04', values:['6.1900'] }) };
    const sourceOf = url => ({ 'www.boc.cn':'boc', 'papi.icbc.com.cn':'icbc', 'www.chinamoney.com.cn':'cfets' })[new URL(url).hostname];
    const { queryUsdCnyRate } = createUsdCnyRate({
      cacheFile,
      now:() => clock,
      requestText: async (url, options) => {
        requests.push(url);
        assert.equal(options.binary, true, 'the answer is asked for as bytes, so a GBK page can be decoded');
        const answer = answers[sourceOf(url)];
        if (answer instanceof Error) throw answer;
        return Buffer.from(answer);
      }
    });
    const cache = () => JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const waitForCache = async source => {
      for (let tries = 0; tries < 200 && (!fs.existsSync(cacheFile) || cache().source !== source); tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setImmediate(resolve)); // the finished request lets go of its promise
    };

    // No cache: the Bank of China answers; two callers at once share one request; the answer is kept.
    const [first, second] = await Promise.all([queryUsdCnyRate(), queryUsdCnyRate()]);
    assert.deepEqual(requests, ['https://www.boc.cn/sourcedb/whpj/'], 'two callers at once share one request; BOC is asked first');
    assert.deepEqual(first, { rate:6.1234, source:'boc', sourceLabel:'中国银行现汇买入价', publishedAt:'2031-04-05 09:15', fetchedAt:'2031-04-05T02:00:00.000Z' });
    assert.equal(second, first);
    assert.equal(cache().rate, 6.1234);

    const hours = n => n * 60 * 60 * 1000;
    // Once a day: for the rest of that day in Beijing (10:00 → 23:59) it comes from the file.
    for (const later of [5, 8]) {
      clock += hours(later); // Beijing 15:00, then 23:00
      const cached = await queryUsdCnyRate();
      assert.equal(cached.cached, true);
      assert.equal(cached.stale, undefined);
      assert.equal(requests.length, 1, 'asked once a day');
    }

    // The next day (Beijing 01:00): the old answer at once, a new one fetched behind it. BOC now fails: ICBC answers,
    // still with yesterday's publish date.
    clock += hours(2);
    answers.boc = '<html><body>页面改版了</body></html>';
    const stale = await queryUsdCnyRate();
    assert.equal(stale.stale, true);
    assert.equal(stale.rate, 6.1234);
    await waitForCache('icbc');
    assert.deepEqual({ rate:cache().rate, source:cache().source, sourceLabel:cache().sourceLabel, publishedAt:cache().publishedAt }, { rate:6.1111, source:'icbc', sourceLabel:'工商银行现汇买入价', publishedAt:'2031-04-05 08:41' });
    assert.deepEqual(requests.slice(1).map(sourceOf), ['boc', 'icbc']);

    // Fetched today but published yesterday: not asked again within six hours, asked again after that.
    clock += hours(3); // Beijing 04:00
    assert.equal((await queryUsdCnyRate()).stale, undefined);
    assert.equal(requests.length, 3);
    // BOC and ICBC both fail: the CFETS central parity, asked for the last ten days up to today in Beijing.
    clock += hours(4); // Beijing 08:00, seven hours after the last request
    answers.icbc = new Error('offline');
    assert.equal((await queryUsdCnyRate()).stale, true);
    await waitForCache('cfets');
    assert.deepEqual({ rate:cache().rate, source:cache().source, publishedAt:cache().publishedAt }, { rate:6.19, source:'cfets', publishedAt:'2031-04-04' });
    assert.deepEqual(requests.slice(3).map(sourceOf), ['boc', 'icbc', 'cfets']);
    assert.match(requests.at(-1), /^https:\/\/www\.chinamoney\.com\.cn\/.*startDate=2031-03-27&endDate=2031-04-06&currency=USD\/CNY$/);

    // Every source fails while an old answer exists: the old answer keeps coming back, marked stale.
    clock += 7 * 60 * 60 * 1000;
    answers.cfets = new Error('offline too');
    const kept = await queryUsdCnyRate();
    assert.equal(kept.rate, 6.19);
    assert.equal(kept.stale, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(cache().rate, 6.19, 'a failed renewal leaves the cache alone');

    // No cache and nothing works: an error naming every source, nothing written.
    fs.rmSync(cacheFile);
    await assert.rejects(queryUsdCnyRate(), error => ['中国银行', '工商银行', '外汇交易中心'].every(name => error.message.includes(name)));
    assert.equal(fs.existsSync(cacheFile), false);

    // A cache from a source no longer in the list is not used.
    fs.writeFileSync(cacheFile, JSON.stringify({ rate:6.5, source:'gone', fetchedAt:new Date(clock).toISOString() }));
    answers.boc = table([dollar]);
    assert.equal((await queryUsdCnyRate()).source, 'boc');

    console.log('USD/CNY rate tests passed: BOC table read by header, ICBC and CFETS answers, bad answers refused, GBK decoded, BOC → ICBC → CFETS in order, once a day, stale served while renewing, failures keep the old answer.');
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
