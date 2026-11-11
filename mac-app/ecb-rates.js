// Daily exchange rates of the European Central Bank, for amounts in other currencies than USD.
// The whole history is one XML file; it is kept in the data folder and fetched again at most once a day.
const fs = require('fs');
const outbound = require('./outbound-http');
const { atomicWrite, readJson } = require('./file-store');

function parseEcbHistoricalRates(xml = '') {
  const supported = new Set(['USD','EUR','GBP','CNY','AUD','CAD']);
  const rows = [];
  const dayPattern = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]>([\s\S]*?)<\/Cube>/g;
  for (const match of String(xml || '').matchAll(dayPattern)) {
    const rates = { EUR:1 };
    const ratePattern = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/?\s*>/g;
    for (const rateMatch of match[2].matchAll(ratePattern)) {
      if (!supported.has(rateMatch[1])) continue;
      const value = Number(rateMatch[2]);
      if (Number.isFinite(value) && value > 0) rates[rateMatch[1]] = value;
    }
    if (rates.USD) rows.push({ date:match[1], rates });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

function createEcbRates({ cacheFile, requestText = outbound.requestText }) {
  let ecbRefreshPromise = null;
  function refreshEcbHistoricalRates() {
    // 同一时间只下载一次：几个窗口同时打开、或者前端重试时，不重复拉整份 ECB 历史。
    if (ecbRefreshPromise) return ecbRefreshPromise;
    ecbRefreshPromise = (async () => {
      const xml = await requestText('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml', {
        headers:{ 'User-Agent':'TradeOrderSystem' }
      });
      const rates = parseEcbHistoricalRates(xml);
      if (!rates.length) throw new Error('ECB 未返回历史汇率');
      const payload = { source:'European Central Bank', updatedAt:new Date().toISOString(), rates };
      atomicWrite(cacheFile, JSON.stringify(payload));
      return payload;
    })().finally(() => { ecbRefreshPromise = null; });
    return ecbRefreshPromise;
  }

  async function queryEcbHistoricalRates() {
    const cached = fs.existsSync(cacheFile) ? (() => {
      try { return readJson(cacheFile); } catch (_) { return null; }
    })() : null;
    const hasCache = Array.isArray(cached?.rates) && cached.rates.length;
    const cachedAge = cached?.updatedAt ? Date.now() - Date.parse(cached.updatedAt) : Infinity;
    if (hasCache && cachedAge < 24 * 60 * 60 * 1000) return { ...cached, cached:true };
    // 缓存过期：先把旧缓存交出去（历史汇率只多出最近一两天），后台再去 ECB 下载更新。
    // 以前要等整份历史下载完才返回，每天第一次打开 App 时统计卡要等好几秒、期间非美元订单算 0。
    if (hasCache) {
      refreshEcbHistoricalRates().catch(() => {});
      return { ...cached, cached:true, stale:true };
    }
    return refreshEcbHistoricalRates();
  }

  return { queryEcbHistoricalRates };
}

module.exports = { createEcbRates, parseEcbHistoricalRates };
