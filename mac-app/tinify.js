// Order images are compressed by TinyPNG before they are stored, when a key is set (TINIFY_API_KEY or
// secrets/tinypng-api-key). Without a key, or when TinyPNG fails in any way, the image is kept as it came.
const fs = require('fs');
const http = require('http');
const https = require('https');

// endpoint: the TinyPNG shrink URL. Tests point it at a server on 127.0.0.1; anything else must be https.
function createTinify({ keyFile, endpoint }) {
  function readTinifyApiKey() {
    const environmentKey = String(process.env.TINIFY_API_KEY || '').trim();
    if (environmentKey) return environmentKey;
    if (!fs.existsSync(keyFile)) return '';
    try {
      fs.chmodSync(keyFile, 0o600);
      return fs.readFileSync(keyFile, 'utf8').trim();
    } catch (_) {
      return '';
    }
  }

  function tinifyUrlAllowed(targetUrl = '') {
    try {
      const target = new URL(targetUrl);
      const service = new URL(endpoint);
      return target.origin === service.origin
        && (service.protocol === 'https:' || (service.protocol === 'http:' && service.hostname === '127.0.0.1'));
    } catch (_) {
      return false;
    }
  }

  function requestBinaryResponse(targetUrl, options = {}) {
    return new Promise((resolve, reject) => {
      if (!tinifyUrlAllowed(targetUrl)) {
        reject(new Error('unsupported TinyPNG response URL'));
        return;
      }
      const parsed = new URL(targetUrl);
      const transport = parsed.protocol === 'http:' ? http : https;
      const req = transport.request(parsed, {
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 15000
      }, res => {
        const chunks = [];
        let bytes = 0;
        const maxBytes = Number(options.maxBytes || 9 * 1024 * 1024);
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy(new Error('TinyPNG response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: Number(res.statusCode || 0), headers: res.headers, buffer: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error('TinyPNG request timeout')));
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  async function optimizeAttachmentWithTinify(image) {
    const apiKey = readTinifyApiKey();
    if (!apiKey) return { ...image, optimized: false, fallback: true, compressionCount: 0 };
    try {
      const authorization = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;
      const shrink = await requestBinaryResponse(endpoint, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': image.mime,
          'Content-Length': image.buffer.length
        },
        body: image.buffer,
        maxBytes: 512 * 1024
      });
      if (shrink.status !== 201) throw new Error('TinyPNG compression rejected');
      let metadata = {};
      try { metadata = JSON.parse(shrink.buffer.toString('utf8') || '{}'); } catch (_) {}
      const resultUrl = String(shrink.headers.location || metadata?.output?.url || '');
      if (!tinifyUrlAllowed(resultUrl)) throw new Error('TinyPNG returned an invalid result URL');
      const result = await requestBinaryResponse(resultUrl, { maxBytes: 64 * 1024 * 1024 });
      if (result.status < 200 || result.status >= 300 || !result.buffer.length) throw new Error('TinyPNG result unavailable');
      const mime = String(result.headers['content-type'] || metadata?.output?.type || image.mime).split(';', 1)[0].toLowerCase();
      if (!/^image\/(?:avif|png|jpe?g|webp)$/.test(mime)) throw new Error('TinyPNG returned an unsupported image type');
      return {
        mime,
        buffer: result.buffer,
        optimized: true,
        fallback: false,
        compressionCount: Number(shrink.headers['compression-count'] || 0)
      };
    } catch (_) {
      return { ...image, optimized: false, fallback: true, compressionCount: 0 };
    }
  }

  return { optimizeAttachmentWithTinify };
}

module.exports = { createTinify };
