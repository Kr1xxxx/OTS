// Requests the server makes to the outside: carrier APIs, the ECB rate file, the AI provider.
const http = require('http');
const https = require('https');
const zlib = require('zlib');

function requestText(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const client = String(targetUrl).startsWith('http://127.0.0.1') ? http : https;
    const req = client.request(targetUrl, {
      method: options.method || 'GET',
      headers: { 'Accept-Encoding': 'identity', ...(options.headers || {}) },
      timeout: 12000
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '');
        try {
          if (encoding.includes('gzip')) buffer = zlib.gunzipSync(buffer);
          else if (encoding.includes('br')) buffer = zlib.brotliDecompressSync(buffer);
          else if (encoding.includes('deflate')) buffer = zlib.inflateSync(buffer);
        } catch (_) {}
        const body = buffer.toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
          error.statusCode = res.statusCode;
          const retryAfter = Number(res.headers['retry-after']);
          if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
          reject(error);
          return;
        }
        resolve(body);
      });
    });
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
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '');
        try {
          if (encoding.includes('gzip')) buffer = zlib.gunzipSync(buffer);
          else if (encoding.includes('br')) buffer = zlib.brotliDecompressSync(buffer);
          else if (encoding.includes('deflate')) buffer = zlib.inflateSync(buffer);
        } catch (_) {}
        const text = buffer.toString('utf8');
        let data;
        try { data = JSON.parse(text || '{}'); } catch (_) { data = { raw: text }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

module.exports = { requestText, requestJsonResponse };
