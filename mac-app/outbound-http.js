// Requests the server makes to the outside: carrier APIs, the exchange-rate sources, the AI provider.
const http = require('http');
const https = require('https');
const zlib = require('zlib');

// The far side is not trusted to behave: a connection closed after the headers but before the whole body
// fires neither 'end' nor an error, and the idle timeout cannot fire on a socket that is already closed.
// Left alone, the promise never settles, and the exchange-rate refresh that shares it stays stuck on the
// old rate until the app restarts. So a cut-off body rejects, every request has an overall deadline, and
// the body (also once decompressed) has a size limit.
const maxResponseBytes = 32 * 1024 * 1024;
const maxDecodedBytes = 64 * 1024 * 1024;
const defaultDeadlineMs = 120000;

function settleWithin(req, deadlineMs) {
  const timer = setTimeout(() => {
    const error = new Error('request timeout');
    error.timeout = true;
    req.destroy(error);
  }, deadlineMs || defaultDeadlineMs);
  req.on('close', () => clearTimeout(timer));
}

function collectBody(req, res, reject, onBody, maxBytes = maxResponseBytes) {
  const chunks = [];
  let bytes = 0;
  res.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      req.destroy(new Error('response too large'));
      return;
    }
    chunks.push(chunk);
  });
  res.on('error', reject);
  res.on('close', () => {
    if (res.complete) return;
    const error = new Error('response cut off');
    error.truncated = true;
    reject(error);
  });
  res.on('end', () => onBody(Buffer.concat(chunks)));
}

function decodeBody(buffer, encoding) {
  const limit = { maxOutputLength: maxDecodedBytes };
  try {
    if (encoding.includes('gzip')) return zlib.gunzipSync(buffer, limit);
    if (encoding.includes('br')) return zlib.brotliDecompressSync(buffer, limit);
    if (encoding.includes('deflate')) return zlib.inflateSync(buffer, limit);
  } catch (_) {}
  return buffer;
}

function requestText(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const client = String(targetUrl).startsWith('http://127.0.0.1') ? http : https;
    const req = client.request(targetUrl, {
      method: options.method || 'GET',
      headers: { 'Accept-Encoding': 'identity', ...(options.headers || {}) },
      timeout: 12000
    }, res => collectBody(req, res, reject, raw => {
      const buffer = decodeBody(raw, String(res.headers['content-encoding'] || ''));
      const body = buffer.toString('utf8');
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const error = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
        error.statusCode = res.statusCode;
        const retryAfter = Number(res.headers['retry-after']);
        if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
        reject(error);
        return;
      }
      // binary: the caller decodes the bytes itself (pages that are not UTF-8, e.g. GBK).
      resolve(options.binary ? buffer : body);
    }));
    settleWithin(req, options.deadline);
    req.on('timeout', () => {
      const error = new Error('request timeout');
      error.timeout = true;
      req.destroy(error);
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function requestJsonResponse(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(targetUrl, {
      method: options.method || 'GET',
      headers: { 'Accept-Encoding': 'identity', ...(options.headers || {}) },
      timeout: options.timeout || 15000
    }, res => collectBody(req, res, reject, raw => {
      const text = decodeBody(raw, String(res.headers['content-encoding'] || '')).toString('utf8');
      let data;
      try { data = JSON.parse(text || '{}'); } catch (_) { data = { raw: text }; }
      resolve({ status: res.statusCode, data });
    }));
    settleWithin(req, options.deadline);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

module.exports = { requestText, requestJsonResponse };
