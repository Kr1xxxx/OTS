// Carrier tracking: DHL and FedEx lookups for the logistics page, and the mapping of what a carrier
// says onto the six statuses the page knows.
//
// The part that needs the saved settings (API keys, last-checked notes) is created by the server with
// its own readers and writers; everything else here is plain functions of their arguments.
const crypto = require('crypto');
const { requestText, requestJsonResponse } = require('./outbound-http');

// 测试用：环境变量可以把 DHL / FedEx 指到本机的假服务（只认 127.0.0.1），测试永远不碰真实承运商接口。
function loopbackOverride(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/127\.0\.0\.1(?::\d+)?(\/|$)/.test(text) ? text : '';
}
const dhlTrackingEndpoint = loopbackOverride(process.env.OTS_DHL_TRACKING_ENDPOINT) || 'https://api-eu.dhl.com/track/shipments';
const fedexApiHostOverride = loopbackOverride(process.env.OTS_FEDEX_API_HOST);

function cleanTracking(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^(?:UPS|FEDEX|FED\s*EX|DHL)\s*[:：#-]?\s*/i, '')
    .replace(/[^A-Z0-9]+/g, '');
}

function detectCarrier(number) {
  const clean = cleanTracking(number);
  if (/^1Z[A-Z0-9]{16}$/.test(clean) || /^T\d{10}$/.test(clean) || /^\d{9}$/.test(clean)) return 'UPS';
  if (/^\d{12}$/.test(clean)) return 'FedEx';
  return 'DHL';
}

// 订单里的包裹状态只认 6 个标准值（未发货 / 已发货 / 运输中 / 派送中 / 已签收 / 异常）。承运商的原文另放在 rawStatus，
// 认不出时回空状态（前端不改原来的状态）。以前认不出就把原文当状态返回，前端刷新后一律变成「已发货」，异常件丢了异常标记。
// 和 trade-order-system.html 的 normalizeTrackingStatus 同一套规则。
function standardLogisticsStatus(value = '') {
  const text = String(value || '').toLowerCase();
  if (!text) return '';
  // 「not delivered / undeliverable / delivery attempted」也含 delivered / delivery，要先判成异常。
  if (/not\s+delivered|undeliver|delivery\s+(?:attempt|failed|exception)|attempted\s+delivery|未签收|派送失败/.test(text)) return '异常';
  if (/已签收|签收成功|delivered/.test(text)) return '已签收';
  if (/派送中|正在派送|out for delivery|vehicle for delivery|with delivery courier|ready for pickup|available for pickup|hold(?:ing)? at (?:fedex )?location|held at (?:fedex )?location/.test(text)) return '派送中';
  if (/异常|失败|退回|滞留|扣件|exception|failed|expired|returned|on hold|held|clearance delay|customs delay|cancel/.test(text)) return '异常';
  if (/运输中|转运中|在途中|in transit|transit|arrived|departed|processed|at local|at destination/.test(text)) return '运输中';
  if (/已发货|已揽收|信息已收到|shipment information received|info received|label created|picked up|pre-transit/.test(text)) return '已发货';
  return '';
}

function logisticsStatusFromDhl(shipment) {
  const code = String(shipment?.status?.statusCode || '').toLowerCase();
  const text = [shipment?.status?.description, shipment?.status?.status].filter(Boolean).join(' ');
  const fromText = standardLogisticsStatus(text);
  // 文字明确说没送到 / 扣件时以文字为准（statusCode 可能还是 transit）。
  if (fromText === '异常') return '异常';
  if (code === 'failure') return '异常';
  if (code === 'delivered') return '已签收';
  if (fromText) return fromText;
  if (code === 'transit') return '运输中';
  if (code === 'pre-transit') return '已发货';
  return '';
}

function formatApiTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizeTrackingEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .map(event => ({
      time: formatApiTime(event.time || event.dateTime || event.timestamp || ''),
      title: event.title || event.status || event.eventDescription || event.scanType || '物流更新',
      location: event.location || event.scanLocation || '',
      description: event.description || event.exceptionDescription || ''
    }))
    .filter(event => event.title || event.time || event.location);
}

function dhlTrackingEvents(shipment = {}) {
  return normalizeTrackingEvents((shipment.events || []).map(event => ({
    time: event.timestamp,
    title: event.description || event.status,
    location: event.location?.address?.addressLocality || event.location?.address?.countryCode || '',
    description: event.statusCode || ''
  })));
}

// 物流查询失败归类：返回给前端的是人话和一个代码（rate_limited / not_found / timeout / auth / server / network），
// 不再把 HTTP 状态码和承运商返回的 JSON 原文拼进提示里。
function trackingFailure(carrier, error = {}, { notFound = false } = {}) {
  const status = Number(error.statusCode || (String(error.message || '').match(/HTTP (\d{3})/) || [])[1] || 0);
  const text = String(error.message || '');
  let code = 'error';
  let message;
  if (notFound || status === 404) {
    code = 'not_found';
    message = `${carrier} 查不到这个单号（刚发出的包裹可能要几小时后才有记录）`;
  } else if (status === 429) {
    code = 'rate_limited';
    const minutes = Number(error.retryAfter) > 0 ? Math.max(1, Math.ceil(Number(error.retryAfter) / 60)) : 0;
    message = `${carrier} 调用次数超限${minutes ? `，约 ${minutes} 分钟后再试` : '，请稍后再试'}`;
  } else if (status === 401 || status === 403) {
    code = 'auth';
    message = carrier === 'DHL'
      ? 'DHL API 未授权当前资源，请在 DHL Developer 后台确认已开通 Shipment Tracking - Unified。'
      : 'FedEx API 未授权，请在设置里检查 API Key 和 Secret。';
  } else if (error.timeout || /timeout|ETIMEDOUT/i.test(text)) {
    code = 'timeout';
    message = `${carrier} 查询超时，请稍后再试`;
  } else if (status >= 500) {
    code = 'server';
    message = `${carrier} 服务暂时不可用（HTTP ${status}），请稍后再试`;
  } else if (status) {
    message = `${carrier} 查询失败（HTTP ${status}）`;
  } else if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|socket hang up/i.test(text)) {
    code = 'network';
    message = `${carrier} 连不上，请检查网络`;
  } else {
    message = `${carrier} 查询失败：${text.replace(/\s*[{[][\s\S]*$/, '').slice(0, 80) || '未知错误'}`;
  }
  const result = new Error(message);
  result.code = code;
  if (Number(error.retryAfter) > 0) result.retryAfter = Number(error.retryAfter);
  return result;
}

// FedEx 按状态代码映射，代码认不出再看文字；都认不出回空状态（前端不改原来的状态），原文另放 rawStatus。
const fedexStatusCodes = {
  OC:'已发货', PU:'已发货', PX:'已发货',
  IT:'运输中', AR:'运输中', DP:'运输中', IN:'运输中', AF:'运输中', CC:'运输中', CP:'运输中', EA:'运输中', ED:'运输中', EO:'运输中', EP:'运输中', FD:'运输中', LO:'运输中', OF:'运输中', PF:'运输中', PL:'运输中', PM:'运输中', SF:'运输中', TR:'运输中',
  OD:'派送中', HL:'派送中', HP:'派送中',
  DL:'已签收',
  DE:'异常', SE:'异常', CA:'异常', RS:'异常', DY:'异常', CD:'异常'
};
function logisticsStatusFromFedEx(track) {
  const detail = track?.latestStatusDetail || {};
  const text = [detail.statusByLocale, detail.description].filter(Boolean).join(' ');
  const fromText = standardLogisticsStatus(text);
  if (fromText === '异常') return '异常';
  const code = String(detail.code || detail.derivedCode || '').toUpperCase();
  if (fedexStatusCodes[code]) return fedexStatusCodes[code];
  const derived = String(detail.derivedCode || '').toUpperCase();
  if (fedexStatusCodes[derived]) return fedexStatusCodes[derived];
  return fromText;
}

function fedexLocation(place = {}) {
  return [place.city, place.stateOrProvinceCode, place.countryName || place.countryCode].filter(Boolean).join(', ');
}
function fedexDateTypeLabel(type = '') {
  const labels = {
    ACTUAL_DELIVERY: '实际签收时间',
    ACTUAL_PICKUP: '实际揽收时间',
    SHIP: '发货时间',
    ESTIMATED_DELIVERY: '预计签收时间',
    COMMITMENT: '承诺送达时间'
  };
  return labels[type] || String(type || '').replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\w/g, s => s.toUpperCase()) || 'FedEx 时间节点';
}
function uniqueTrackingEvents(events = []) {
  const seen = new Set();
  return events.filter(event => {
    const key = [event.time, event.title, event.location].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function fedexTrackingEvents(track = {}) {
  const latest = track.latestStatusDetail ? [{
    time: track.dateAndTimes?.[0]?.dateTime || '',
    title: track.latestStatusDetail.statusByLocale || track.latestStatusDetail.description || track.derivedStatus || 'FedEx 最新状态',
    location: fedexLocation(track.latestStatusDetail.scanLocation || {}),
    description: track.latestStatusDetail.code || ''
  }] : [];
  const scans = (track.scanEvents || []).map(event => ({
    time: event.date,
    title: event.eventDescription || event.derivedStatus || event.eventType,
    location: fedexLocation(event.scanLocation || {}),
    description: event.exceptionDescription || ''
  }));
  const times = (track.dateAndTimes || []).map(item => ({
    time: item.dateTime,
    title: fedexDateTypeLabel(item.type),
    location: '',
    description: item.description || ''
  }));
  return uniqueTrackingEvents(normalizeTrackingEvents([...latest, ...scans, ...times]));
}

function trackingCarrierStatusPatch(carrier, message, checkedAt = new Date().toISOString()) {
  return carrier === 'FedEx'
    ? { lastFedexCheckedAt: checkedAt, lastFedexStatus: message }
    : { lastDhlCheckedAt: checkedAt, lastDhlStatus: message };
}

function createCarrierTracking({ readTrackingSettings, writeTrackingSettings }) {
  async function checkDhlApiStatus() {
    const settings = readTrackingSettings();
    if (settings.dhlApiEnabled !== '是') return { ok: false, disabled: true, label: 'DHL', message: 'DHL API 未开启' };
    const apiKey = process.env.DHL_API_KEY || settings.dhlApiKey || '';
    if (!apiKey) return { ok: false, disabled: true, label: 'DHL', message: 'DHL API Key 未保存' };
    const checkedAt = new Date().toISOString();
    try {
      const response = await requestJsonResponse(`${dhlTrackingEndpoint}?trackingNumber=0000000000`, {
        headers: { 'DHL-API-Key': apiKey, Accept: 'application/json' },
        timeout: 12000
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, label: 'DHL', checkedAt, message: 'DHL API 未授权' };
      }
      // 测试单号 0000000000 查不到（400/404）也说明 Key 能用；429 限流、5xx 服务故障都不算可连接。
      if (response.status === 429) return { ok: false, label: 'DHL', checkedAt, message: 'DHL API 调用次数超限，请稍后再试' };
      if (response.status >= 500) return { ok: false, label: 'DHL', checkedAt, message: `DHL 服务暂时不可用（HTTP ${response.status}）` };
      return { ok: true, label: 'DHL', checkedAt, message: 'DHL API 可连接' };
    } catch (error) {
      const text = String(error?.message || '');
      if (/HTTP 401|HTTP 403/i.test(text)) return { ok: false, label: 'DHL', checkedAt, message: 'DHL API 未授权' };
      if (/HTTP 400|HTTP 404/i.test(text)) return { ok: true, label: 'DHL', checkedAt, message: 'DHL API 可连接' };
      return { ok: false, label: 'DHL', checkedAt, message: `DHL 检测失败：${error?.message || '未知错误'}` };
    }
  }

  async function checkFedExApiStatus() {
    const settings = readTrackingSettings();
    if (settings.fedexApiEnabled !== '是') return { ok: false, disabled: true, label: 'FedEx', message: 'FedEx API 未开启' };
    if (!settings.fedexApiKey || !settings.fedexApiSecret) return { ok: false, disabled: true, label: 'FedEx', message: 'FedEx API Key 或 Secret 未保存' };
    const checkedAt = new Date().toISOString();
    try {
      const token = await fedexToken(settings);
      return token
        ? { ok: true, label: 'FedEx', checkedAt, message: 'FedEx API 可连接' }
        : { ok: false, label: 'FedEx', checkedAt, message: 'FedEx 未返回授权 Token' };
    } catch (error) {
      return { ok: false, label: 'FedEx', checkedAt, message: `FedEx 授权失败：${error?.message || '未知错误'}` };
    }
  }

  async function queryDhlTracking(number) {
    const settings = readTrackingSettings();
    const apiKey = process.env.DHL_API_KEY || settings.dhlApiKey || '';
    if (settings.dhlApiEnabled !== '是' || !apiKey) {
      return { ok: false, status: '待 API 查询', message: 'DHL API 未开启或未保存 Key。' };
    }
    const url = `${dhlTrackingEndpoint}?trackingNumber=${encodeURIComponent(number)}`;
    let text;
    try {
      text = await requestText(url, { headers: { 'DHL-API-Key': apiKey, Accept: 'application/json' } });
    } catch (error) {
      const failure = trackingFailure('DHL', error);
      const checkedAt = new Date().toISOString();
      writeTrackingSettings({ lastCheckedAt: checkedAt, lastStatus: failure.message, ...trackingCarrierStatusPatch('DHL', failure.message, checkedAt) });
      throw failure;
    }
    const data = JSON.parse(text);
    const shipment = data.shipments?.[0];
    if (!shipment) throw trackingFailure('DHL', {}, { notFound:true });
    const status = logisticsStatusFromDhl(shipment);
    const rawStatus = String(shipment?.status?.description || shipment?.status?.status || shipment?.status?.statusCode || '').trim();
    const checkedAt = new Date().toISOString();
    const message = `DHL API 已同步：${status || `状态未识别（${rawStatus || '无描述'}）`}`;
    writeTrackingSettings({ lastCheckedAt: checkedAt, lastStatus: message, ...trackingCarrierStatusPatch('DHL', message, checkedAt) });
    return {
      ok: true,
      status,
      rawStatus,
      updatedAt: shipment.status?.timestamp || new Date().toISOString(),
      events: dhlTrackingEvents(shipment),
      rawCarrier: 'DHL',
      source: 'DHL API'
    };
  }

  function fedexApiHost(settings) {
    if (fedexApiHostOverride) return fedexApiHostOverride;
    return settings.fedexEnv === 'prod' ? 'https://apis.fedex.com' : 'https://apis-sandbox.fedex.com';
  }
  // FedEx 的 OAuth token 按 expires_in 缓存（提前 60 秒过期）：以前每查一个单号都重新拿一次，请求量翻倍，更容易被限流。
  const fedexTokenCache = new Map();

  async function fedexToken(settings = readTrackingSettings()) {
    return fedexTokenWithCredentials(settings, process.env.FEDEX_CLIENT_ID || settings.fedexApiKey || '', process.env.FEDEX_CLIENT_SECRET || settings.fedexApiSecret || '');
  }

  async function fedexTokenWithCredentials(settings = readTrackingSettings(), apiKey = '', apiSecret = '') {
    const clientId = String(apiKey || '').trim();
    const clientSecret = String(apiSecret || '').trim();
    if (!clientId || !clientSecret) return '';
    const cacheKey = crypto.createHash('sha256').update(`${fedexApiHost(settings)}\n${clientId}\n${clientSecret}`).digest('hex');
    const cached = fedexTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    }).toString();
    const text = await requestText(`${fedexApiHost(settings)}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = JSON.parse(text);
    const token = data.access_token || '';
    const ttl = Number(data.expires_in);
    if (token && Number.isFinite(ttl) && ttl > 120) fedexTokenCache.set(cacheKey, { token, expiresAt:Date.now() + (ttl - 60) * 1000 });
    return token;
  }

  async function queryFedExTracking(number) {
    const settings = readTrackingSettings();
    if (settings.fedexApiEnabled !== '是') {
      return { ok: false, status: '待 API 查询', message: 'FedEx API 未开启。' };
    }
    let token;
    try {
      token = await fedexToken(settings);
    } catch (error) {
      const failure = trackingFailure('FedEx', error);
      if (failure.code === 'auth' || failure.code === 'error') failure.message = `FedEx 授权失败：${failure.code === 'auth' ? '请检查 API Key 和 Secret' : failure.message.replace(/^FedEx /, '')}`;
      const checkedAt = new Date().toISOString();
      writeTrackingSettings({ lastCheckedAt: checkedAt, lastStatus: failure.message, ...trackingCarrierStatusPatch('FedEx', failure.message, checkedAt) });
      throw failure;
    }
    if (!token) {
      return { ok: false, status: '待 API 查询', message: 'FedEx API Key 或 Secret 未保存。' };
    }
    const body = JSON.stringify({
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }],
      includeDetailedScans: true
    });
    let text;
    try {
      text = await requestText(`${fedexApiHost(settings)}/track/v1/trackingnumbers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body
      });
    } catch (error) {
      const failure = trackingFailure('FedEx', error);
      // token 被 FedEx 提前作废：下次重新拿。
      if (failure.code === 'auth') fedexTokenCache.clear();
      const checkedAt = new Date().toISOString();
      writeTrackingSettings({ lastCheckedAt: checkedAt, lastStatus: failure.message, ...trackingCarrierStatusPatch('FedEx', failure.message, checkedAt) });
      throw failure;
    }
    const data = JSON.parse(text);
    const track = data.output?.completeTrackResults?.[0]?.trackResults?.[0];
    // 单号查不到时 FedEx 也回 200，只在 trackResults[0].error 里写原因：不能当成「已发货」。
    if (!track || (track.error && !track.latestStatusDetail)) {
      const failure = trackingFailure('FedEx', {}, { notFound:true });
      const checkedAt = new Date().toISOString();
      writeTrackingSettings({ lastCheckedAt: checkedAt, lastStatus: failure.message, ...trackingCarrierStatusPatch('FedEx', failure.message, checkedAt) });
      throw failure;
    }
    const status = logisticsStatusFromFedEx(track);
    const rawStatus = String(track.latestStatusDetail?.statusByLocale || track.latestStatusDetail?.description || track.latestStatusDetail?.code || '').trim();
    const checkedAt = new Date().toISOString();
    const message = `FedEx API 已同步：${status || `状态未识别（${rawStatus || '无描述'}）`}`;
    writeTrackingSettings({ lastCheckedAt: checkedAt, lastStatus: message, ...trackingCarrierStatusPatch('FedEx', message, checkedAt) });
    return {
      ok: true,
      status,
      rawStatus,
      updatedAt: track.dateAndTimes?.[0]?.dateTime || new Date().toISOString(),
      events: fedexTrackingEvents(track),
      rawCarrier: 'FedEx',
      source: 'FedEx API'
    };
  }

  return { checkDhlApiStatus, checkFedExApiStatus, queryDhlTracking, queryFedExTracking };
}

module.exports = {
  createCarrierTracking, cleanTracking, detectCarrier,
  standardLogisticsStatus, logisticsStatusFromDhl, logisticsStatusFromFedEx, trackingFailure
};
