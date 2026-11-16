// Today's USD → RMB rate for the current month's cell of the exchange table (设置 → 汇率).
// Only Chinese sources, tried in order; the first one that gives a plausible number wins:
//   1. 中国银行外汇牌价, 现汇买入价 (a web page; what Alibaba's 结汇 uses)
//   2. 工商银行牌价, 现汇买入价 (JSON)
//   3. 中国外汇交易中心, 人民币汇率中间价 (JSON; the official reference rate, about 0.8 % above what a bank pays)
// The answer is kept in the data folder and fetched again at most every six hours; an older answer is handed
// out at once while a new one is fetched, and kept when every source fails.
const fs = require('fs');
const outbound = require('./outbound-http');
const { atomicWrite, readJson } = require('./file-store');

const FRESH_MS = 6 * 60 * 60 * 1000;
const MIN_RATE = 5;
const MAX_RATE = 9;

function htmlCellText(html = '') {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, '')
    .trim();
}

function htmlTableRows(html = '') {
  const rows = [];
  for (const row of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(cell => htmlCellText(cell[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// "2026.11.16" + "10:30:00", "2026-11-16 10:30:00", "2026/11/16" … → "2026-11-16 10:30" (or the date alone).
function normalizePublishedAt(text = '') {
  const value = String(text);
  const date = value.match(/(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})/);
  if (!date) return '';
  const day = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
  const time = value.slice(date.index + date[0].length).match(/(\d{1,2}):(\d{2})/);
  return time ? `${day} ${time[1].padStart(2, '0')}:${time[2]}` : day;
}

function plausibleRate(value) {
  return Number.isFinite(value) && value >= MIN_RATE && value <= MAX_RATE;
}

// 中国银行外汇牌价 (https://www.boc.cn/sourcedb/whpj/): one table, prices per 100 units of the foreign currency.
// Columns are found by their header text, not by position, so a reordered or wider table still reads right.
// Throws when the table, the USD row or a plausible number is missing: the caller then tries the next source.
function parseBocUsdBuyRate(html = '') {
  const rows = htmlTableRows(html);
  const headerIndex = rows.findIndex(cells => cells.includes('现汇买入价') && cells.some(cell => cell.includes('货币名称')));
  if (headerIndex < 0) throw new Error('中国银行牌价：没找到表头');
  const header = rows[headerIndex];
  const nameColumn = header.findIndex(cell => cell.includes('货币名称'));
  const buyColumn = header.indexOf('现汇买入价');
  const dateColumn = header.findIndex(cell => cell.includes('发布日期'));
  const timeColumn = header.findIndex(cell => cell.includes('发布时间'));
  const usd = rows.slice(headerIndex + 1).find(cells => cells[nameColumn] === '美元');
  if (!usd) throw new Error('中国银行牌价：没找到美元');
  const rate = Number(usd[buyColumn]) / 100;
  if (!plausibleRate(rate)) throw new Error(`中国银行牌价：美元现汇买入价不对（${usd[buyColumn] || '空'}）`);
  const published = [dateColumn, timeColumn].filter(column => column >= 0).map(column => usd[column] || '').join(' ');
  return { rate:Math.round(rate * 10000) / 10000, publishedAt:normalizePublishedAt(published) };
}

function parseJson(text) {
  try { return JSON.parse(String(text || '')); } catch (_) { throw new Error('返回的不是 JSON'); }
}

// 工商银行 https://papi.icbc.com.cn/exchanges/ns/getLatest: { data:[{ currencyENName:'USD', foreignBuy:'665.25',
// publishDate:'2026-11-16', publishTime:'09:53:59', … }] }, prices per 100 USD.
function parseIcbcUsdBuyRate(text = '') {
  const data = parseJson(text)?.data;
  const usd = (Array.isArray(data) ? data : []).find(item => String(item?.currencyENName || '').toUpperCase() === 'USD');
  if (!usd) throw new Error('工商银行牌价：没找到美元');
  const rate = Number(usd.foreignBuy) / 100;
  if (!plausibleRate(rate)) throw new Error(`工商银行牌价：美元现汇买入价不对（${usd.foreignBuy ?? '空'}）`);
  return { rate:Math.round(rate * 10000) / 10000, publishedAt:normalizePublishedAt(`${usd.publishDate || ''} ${usd.publishTime || ''}`) };
}

// 中国外汇交易中心 CcprHisNew: { records:[{ date:'2026-11-16', values:['6.7141'] }, …] }, per 1 USD, one per working day.
function parseCfetsUsdMid(text = '') {
  const records = parseJson(text)?.records;
  const latest = (Array.isArray(records) ? records : [])
    .filter(item => normalizePublishedAt(item?.date))
    .sort((a, b) => normalizePublishedAt(b.date).localeCompare(normalizePublishedAt(a.date)))[0];
  if (!latest) throw new Error('外汇交易中心：没有中间价');
  const rate = Number(Array.isArray(latest.values) ? latest.values[0] : NaN);
  if (!plausibleRate(rate)) throw new Error(`外汇交易中心：中间价不对（${latest.values?.[0] ?? '空'}）`);
  return { rate:Math.round(rate * 10000) / 10000, publishedAt:normalizePublishedAt(latest.date) };
}

// Beijing date (UTC+8), YYYY-MM-DD, `days` before now.
function beijingDay(nowMs, days = 0) {
  return new Date(nowMs + 8 * 60 * 60 * 1000 - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const defaultSources = [
  { id:'boc', label:'中国银行现汇买入价', url:() => 'https://www.boc.cn/sourcedb/whpj/', parse:parseBocUsdBuyRate },
  { id:'icbc', label:'工商银行现汇买入价', url:() => 'https://papi.icbc.com.cn/exchanges/ns/getLatest', parse:parseIcbcUsdBuyRate },
  {
    id:'cfets',
    label:'外汇交易中心中间价',
    url:nowMs => `https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew?startDate=${beijingDay(nowMs, 10)}&endDate=${beijingDay(nowMs)}&currency=USD/CNY`,
    parse:parseCfetsUsdMid
  }
];

// The page says which charset it is in; Chinese bank pages are often GBK rather than UTF-8.
function decodeHtml(body) {
  if (typeof body === 'string') return body;
  const buffer = Buffer.from(body || []);
  const head = buffer.subarray(0, 4096).toString('latin1');
  const charset = (head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8').toLowerCase();
  const label = /^(gb2312|gbk|gb18030|x-gbk)$/.test(charset) ? 'gb18030' : charset;
  try { return new TextDecoder(label).decode(buffer); } catch (_) { return buffer.toString('utf8'); }
}

function createUsdCnyRate({ cacheFile, requestText = outbound.requestText, sources = defaultSources, now = () => Date.now() }) {
  let refreshPromise = null;
  function refresh() {
    // 同一时间只取一次：几个窗口同时打开、或页面重试时，不重复请求。
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const failures = [];
      for (const source of sources) {
        try {
          const url = typeof source.url === 'function' ? source.url(now()) : source.url;
          const body = await requestText(url, {
            binary:true,
            headers:{ 'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TradeOrderSystem', Accept:'text/html,application/json,*/*' }
          });
          const parsed = source.parse(decodeHtml(body));
          if (!plausibleRate(parsed?.rate)) throw new Error(`${source.label}：数字不对`);
          const payload = {
            rate:parsed.rate,
            source:source.id,
            sourceLabel:source.label,
            publishedAt:parsed.publishedAt || '',
            fetchedAt:new Date(now()).toISOString()
          };
          atomicWrite(cacheFile, JSON.stringify(payload));
          return payload;
        } catch (error) {
          failures.push(`${source.label}：${String(error?.message || error).slice(0, 120)}`);
        }
      }
      throw new Error(failures.join('；') || '没有汇率来源');
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function queryUsdCnyRate() {
    const cached = fs.existsSync(cacheFile) ? (() => {
      try { return readJson(cacheFile); } catch (_) { return null; }
    })() : null;
    const usable = cached && plausibleRate(Number(cached.rate)) && sources.some(source => source.id === cached.source);
    if (usable) {
      const age = now() - Date.parse(cached.fetchedAt || '');
      if (age >= 0 && age < FRESH_MS) return { ...cached, cached:true };
      // 过期：先交旧的，后台再取；取不到时旧的继续用，页面看发布时间判断是不是太旧。
      refresh().catch(() => {});
      return { ...cached, cached:true, stale:true };
    }
    return refresh();
  }

  return { queryUsdCnyRate };
}

module.exports = { createUsdCnyRate, parseBocUsdBuyRate, parseIcbcUsdBuyRate, parseCfetsUsdMid, normalizePublishedAt, decodeHtml, defaultSources };
