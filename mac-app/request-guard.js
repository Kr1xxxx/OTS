// What the local server checks on every request before a route runs, and how it reads a body and answers.
//
// The server listens on loopback only, but any page in any browser on this Mac can send requests to
// 127.0.0.1. So: the Host and Origin must be this server's own, a request from another site is refused,
// /api/* needs the token the Mac app was started with, and bodies have a size and depth limit.
const crypto = require('crypto');
const { httpError } = require('./http-error');

const apiSessionCookie = 'trade_api_session';
const defaultBodyLimit = 1024 * 1024;
const saveBodyLimit = 16 * 1024 * 1024;
const exportBodyLimit = 64 * 1024 * 1024;
const attachmentBodyLimit = 96 * 1024 * 1024;

function securityHeaders(type = '') {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...(type ? { 'Content-Type': type } : {})
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { ...securityHeaders(type), ...headers });
  res.end(body);
}

function bodyLimitForRequest(req) {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch (_) {}
  if (pathname === '/api/attachments') return attachmentBodyLimit;
  if (pathname === '/api/save') return saveBodyLimit;
  // 导出的正文是「缩进 JSON 再转义一次」，约为保存体积的 1.8 倍：上限单独放宽，别出现「能保存却不能导出」。
  if (pathname === '/api/export-file') return exportBodyLimit;
  return defaultBodyLimit;
}

function readBody(req, limit = bodyLimitForRequest(req)) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      req.resume();
      reject(httpError(413, 'request body too large'));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > limit) {
        rejected = true;
        chunks.length = 0;
        req.resume();
        reject(httpError(413, 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

// 嵌套太深的 JSON 写库时 JSON.stringify 会栈溢出（500）：读进来就按层数拦下。用显式栈，不递归。
const maxJsonDepth = 64;
function jsonTooDeep(value, limit = maxJsonDepth) {
  const stack = [[value, 1]];
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (depth > limit) return true;
    for (const key in item) {
      const child = item[key];
      if (child && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return false;
}
// 请求正文不是 JSON 对象（写错、空正文、null）是调用方的问题，回 400，别当成服务器出错（500）。
async function readJsonBody(req, fallback) {
  const text = await readBody(req);
  if (!text.trim() && fallback !== undefined) return fallback;
  let value;
  try { value = JSON.parse(text); } catch (_) { throw httpError(400, '请求内容不是有效的 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '请求内容必须是 JSON 对象');
  if (jsonTooDeep(value)) throw httpError(400, `请求内容嵌套超过 ${maxJsonDepth} 层`);
  return value;
}

function secretMatches(candidate, secret) {
  const supplied = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const item of cookies) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(item.slice(separator + 1).trim()); } catch (_) { return ''; }
  }
  return '';
}

function requestToken(req) {
  const headerToken = String(req.headers['x-trade-token'] || '').trim();
  if (headerToken) return headerToken;
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return '';
}

// 浏览器发的请求带 Sec-Fetch-Site：别的站点、或同一台机器上别的端口（同站）的页面发来的一律拒绝，
// 例如 <img src="http://127.0.0.1:端口/api/track?..."> 借用户的 DHL 密钥查询。本页（same-origin）、地址栏直接打开（none）、
// 以及不带这个头的本机程序（测试、Mac App 原生请求）照常。
function validateFetchSite(req) {
  const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (site === 'same-site' || site === 'cross-site') throw httpError(403, 'cross-site request rejected');
}

function requestIsLoopback(req) {
  const address = String(req.socket?.remoteAddress || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function requireJsonContentType(req, pathname) {
  const jsonRoutes = new Set([
    '/api/save', '/api/open-attachment-folder', '/api/delete-attachments', '/api/attachments',
    '/api/open-url', '/api/ai-settings', '/api/ai-chat', '/api/api-status',
    '/api/tracking-settings', '/api/order-notification', '/api/backup-settings',
    '/api/subscriptions/save', '/api/subscriptions/delete', '/api/subscriptions/rate',
    '/api/subscriptions/options', '/api/export-file', '/api/backup-preview', '/api/restore-backup', '/api/check-attachments',
    '/api/ui-prefs'
  ]);
  if (req.method !== 'POST' || !jsonRoutes.has(pathname)) return;
  const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw httpError(415, 'Content-Type must be application/json');
}

function createRequestGuard({ port, apiToken }) {
  // 页面会话 cookie 的值不是 API 令牌，而是由令牌算出来的另一个值：cookie 不分端口，127.0.0.1 上别的端口的服务也会收到它。
  // 这个值只能取页面本身和 /attachments/ 的图片，调不了任何 /api/*；/api/* 只认 X-Trade-Token / Bearer。
  // 由令牌派生（不是另起随机数）：Mac App 用同一个令牌重启服务后，页面里的附件图片照样能显示。
  const pageSessionValue = crypto.createHmac('sha256', apiToken).update('ots-page-session-v1').digest('base64url');

  function tokenMatches(candidate = '') {
    return secretMatches(candidate, apiToken);
  }

  function requestIsAuthorized(req) {
    return tokenMatches(requestToken(req));
  }

  // 浏览器带来的页面会话 cookie：只用于取页面和附件图片。
  function requestHasPageSession(req) {
    return secretMatches(cookieValue(req, apiSessionCookie), pageSessionValue);
  }

  function validateHost(req) {
    if (!requestIsLoopback(req)) throw httpError(403, 'loopback access only');
    const host = String(req.headers.host || '').toLowerCase();
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowed.has(host)) throw httpError(421, 'unsupported host');
  }

  function validateOrigin(req) {
    const origin = String(req.headers.origin || '').trim();
    if (!origin) return;
    const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (!allowed.has(origin.toLowerCase())) throw httpError(403, 'cross-origin request rejected');
  }

  function sessionCookieHeader() {
    return `${apiSessionCookie}=${encodeURIComponent(pageSessionValue)}; HttpOnly; SameSite=Strict; Path=/`;
  }

  return { tokenMatches, requestIsAuthorized, requestHasPageSession, validateHost, validateOrigin, sessionCookieHeader };
}

module.exports = { createRequestGuard, send, readJsonBody, validateFetchSite, requireJsonContentType };
