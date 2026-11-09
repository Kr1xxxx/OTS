const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createWhatsAppStore, renameWhatsAppCustomer, moveWhatsAppChats } = require('./whatsapp-store');
const { createAiUsageStore } = require('./ai-usage-store');
const { createSubscriptionStore } = require('./subscription-store');
const { readFeishuSettings, writeFeishuSettings } = require('./feishu-settings');

const appName = 'TradeOrderSystem';
const port = Number(process.env.TRADE_APP_PORT || 47828);
const bundledResourcesDir = path.join(__dirname, 'TradeOrderSystem.app', 'Contents', 'Resources');
// Bundled app first, then a local build, then the repository root so tests run on a clean checkout.
const resourcesDir = [__dirname, bundledResourcesDir, path.resolve(__dirname, '..')]
  .find(dir => fs.existsSync(path.join(dir, 'trade-order-system.html'))) || bundledResourcesDir;
const htmlFile = path.join(resourcesDir, 'trade-order-system.html');
const appUpdatedAt = fs.existsSync(htmlFile) ? fs.statSync(htmlFile).mtime.toISOString() : null;
const seedDataFile = path.join(resourcesDir, 'trade-order-data.json');
const supportDir = process.env.TRADE_APP_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', appName);
// 备份目录可以改（比如 iCloud Drive），记在 backup-settings.json；目录不可用时这次会话退回默认目录并把原因带给前端。
const defaultBackupDir = path.join(supportDir, 'backups');
const backupSettingsFile = path.join(supportDir, 'backup-settings.json');
let backupDir = defaultBackupDir;
let backupDirError = '';
const attachmentsDir = path.join(supportDir, 'attachments');
const dataFile = path.join(supportDir, 'trade-order-data.json');
const databaseFile = path.join(supportDir, 'trade-order-system.sqlite');
const migrationArchiveDir = path.join(supportDir, 'migration-archive');
const backupMetaFile = path.join(supportDir, 'backup-meta.json');
const ecbExchangeCacheFile = path.join(supportDir, 'exchange-rates-cache.json');
const trackingSettingsFile = path.join(supportDir, 'tracking-settings.json');
const aiSettingsFile = path.join(supportDir, 'ai-settings.json');
const aiUsageStore = createAiUsageStore({ file:path.join(supportDir, 'ai-usage.json'), atomicWrite });
const secretsDir = path.join(supportDir, 'secrets');
const aiApiKeyFile = path.join(secretsDir, 'ai-api-key');
const tinifyApiKeyFile = path.join(secretsDir, 'tinypng-api-key');
const trackingSecretsFile = path.join(secretsDir, 'tracking-credentials.json');
const trackingSecretKeys = ['dhlApiKey', 'fedexApiKey', 'fedexApiSecret'];
const storageMarkerFile = path.join(supportDir, 'sqlite-storage.json');
const migrationErrorFile = path.join(supportDir, 'migration-error.json');
const feishuSettingsFile = path.join(supportDir, 'feishu-settings.json');
// 每次用到时重新读本机配置（16 KB 以内的小文件）：设置页保存、或手改文件后不用重启 App。
function feishuConfig() { return readFeishuSettings(feishuSettingsFile); }
// 测试用：环境变量可以把 DHL / FedEx 指到本机的假服务（只认 127.0.0.1），测试永远不碰真实承运商接口。
function loopbackOverride(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/127\.0\.0\.1(?::\d+)?(\/|$)/.test(text) ? text : '';
}
const dhlTrackingEndpoint = loopbackOverride(process.env.OTS_DHL_TRACKING_ENDPOINT) || 'https://api-eu.dhl.com/track/shipments';
const fedexApiHostOverride = loopbackOverride(process.env.OTS_FEDEX_API_HOST);
const apiToken = String(process.env.TRADE_API_TOKEN || crypto.randomBytes(32).toString('base64url'));
const instanceNonce = String(process.env.TRADE_INSTANCE_NONCE || crypto.randomBytes(24).toString('base64url'));
const apiSessionCookie = 'trade_api_session';
const defaultBodyLimit = 1024 * 1024;
const saveBodyLimit = 16 * 1024 * 1024;
const exportBodyLimit = 64 * 1024 * 1024;
const attachmentBodyLimit = 96 * 1024 * 1024;
const tinifyEndpoint = String(process.env.TRADE_TINIFY_ENDPOINT || 'https://api.tinify.com/shrink');
let database = null;
let storageMode = 'initializing';
let storageError = '';
let storageRevision = 0;
let integrityCache = null;
const integrityCacheMs = 5 * 60 * 1000;

function loadBackupSettings() {
  backupDir = defaultBackupDir;
  backupDirError = '';
  if (!fs.existsSync(backupSettingsFile)) return;
  try {
    const saved = readJson(backupSettingsFile);
    const dir = String(saved?.backupDir || '').trim();
    if (dir && path.isAbsolute(dir)) backupDir = path.resolve(dir);
  } catch (error) {
    backupDirError = error.message || 'backup-settings.json unreadable';
  }
}
function prepareBackupDir() {
  if (backupDir !== defaultBackupDir) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.accessSync(backupDir, fs.constants.W_OK);
      backupDirError = '';
    } catch (error) {
      backupDirError = error.message || '备份目录不可写';
      backupDir = defaultBackupDir;
    }
  }
  fs.mkdirSync(backupDir, { recursive: true });
}
function setBackupDir(input) {
  const dir = String(input || '').trim();
  if (!dir || dir === 'default') {
    try { fs.rmSync(backupSettingsFile, { force: true }); } catch (_) {}
    backupDir = defaultBackupDir;
    backupDirError = '';
    prepareBackupDir();
    return backupSummary();
  }
  if (!path.isAbsolute(dir)) throw httpError(400, '备份目录要用完整路径');
  const resolved = path.resolve(dir);
  const inside = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  if (inside(resolved, attachmentsDir) || inside(supportDir, resolved)) throw httpError(400, '备份目录不能是数据目录本身或附件目录');
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch (error) {
    throw httpError(400, `备份目录不可写：${error.message}`);
  }
  atomicWrite(backupSettingsFile, JSON.stringify({ backupDir: resolved }, null, 2));
  backupDir = resolved;
  backupDirError = '';
  return backupSummary();
}
function chooseBackupFolder() {
  if (process.platform !== 'darwin') return Promise.reject(httpError(400, '请在 Mac App 内选择备份目录'));
  return new Promise((resolve, reject) => {
    const script = 'POSIX path of (choose folder with prompt "选择备份目录（建议选 iCloud Drive 或网盘里的文件夹）")';
    const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(httpError(408, '选择目录超时')); }, 180000);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(httpError(500, error.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        if (/-128|User canceled/i.test(err)) return resolve({ ok: false, cancelled: true });
        return reject(httpError(500, err.trim() || '选择目录失败'));
      }
      resolve({ ok: true, path: out.trim() });
    });
  });
}
// 导出 CSV / JSON：Mac App 的 WebKit 不处理网页下载（blob 链接被拦下，点了导出什么都没有），
// 由本地服务直接写进「下载」文件夹，再在访达里选中它。重名时加 (1)、(2)，不覆盖已有文件。
function exportDirectory() {
  return path.resolve(process.env.TRADE_EXPORT_DIR || path.join(os.homedir(), 'Downloads'));
}
function safeExportName(name = '') {
  const base = path.basename(String(name || '').replace(/\\/g, '/'))
    // 方向控制符（U+202E 等）能让访达把 a\u202Evsc.json 显示成 ajson.csv：一并去掉。
    .replace(/[\u0000-\u001f\u007f:*?"<>|\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  // 按字节限长：macOS 文件名上限 255 字节，中文一个字 3 字节（以前按字符数，85 个中文字以上写盘时 500）。
  if (!/\.(csv|json|txt)$/i.test(base) || Buffer.byteLength(base) > 200) throw httpError(400, '导出文件名不支持');
  return base;
}
function writeExportFile(name, text) {
  const fileName = safeExportName(name);
  const dir = exportDirectory();
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, -ext.length);
  let target = '';
  for (let index = 0; index < 1000 && !target; index += 1) {
    const candidate = path.join(dir, index ? `${stem} (${index})${ext}` : fileName);
    if (!fs.existsSync(candidate)) target = candidate;
  }
  if (!target) throw httpError(409, '下载文件夹里同名文件太多');
  if (typeof text !== 'string') throw httpError(400, '导出内容必须是文字');
  try { atomicWrite(target, text); } catch (error) {
    // 错误里不带绝对路径和临时文件名，常见原因翻成中文。
    const friendly = friendlyStorageError(error, '「下载」文件夹');
    throw friendly === error ? httpError(500, '导出文件没有写成功') : friendly;
  }
  if (process.platform === 'darwin' && process.env.TRADE_EXPORT_NO_REVEAL !== '1') {
    spawn('/usr/bin/open', ['-R', target], { detached: true, stdio: 'ignore' }).unref();
  }
  return { ok: true, path: target, name: path.basename(target) };
}
function ensureStorage() {
  loadBackupSettingsOnce();
  prepareBackupDir();
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.mkdirSync(migrationArchiveDir, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });
  // 用户自选的备份目录不改它的权限（可能是共享网盘文件夹）。
  [supportDir, ...(backupDir === defaultBackupDir ? [backupDir] : []), attachmentsDir, migrationArchiveDir, secretsDir].forEach(dir => {
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
let backupSettingsLoaded = false;
function loadBackupSettingsOnce() {
  if (backupSettingsLoaded) return;
  backupSettingsLoaded = true;
  loadBackupSettings();
}

function atomicWrite(file, text) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(descriptor, text);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw error;
  }
}

function httpError(status, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, details);
  return error;
}

// 备份目录可以是用户自己选的文件夹（iCloud、网盘），里面可能有别的 .sqlite / .json：轮转、统计、清理附件只认 OTS 自己起的名字。
// 文件名：trade-order-data-<日期>-<时间>[-<本机数据库 id 前 6 位>][-before-<原因>][-<序号>].sqlite
// - 数据库 id：两台 Mac 把备份目录选到同一个 iCloud 文件夹时，轮转只删自己的，不删对方的（旧备份没有 id，按自己的算）。
// - 「-before-<原因>」：操作前强制生成的快照（合并 / 删除客户 change、导入 import、恢复示例 reset、从备份恢复 restore），
//   单独保留 90 天（至少最近 20 份），不参与日常轮转。
const backupReasons = ['change', 'import', 'reset', 'restore'];
const otsBackupFileName = /^trade-order-data-(\d{8})-(\d{6})(?:-([0-9a-f]{6}))?(?:-before-(change|import|reset|restore))?(?:-\d+)?\.(?:sqlite|json)$/;
function parseBackupName(name = '') {
  const match = otsBackupFileName.exec(name);
  if (!match) return null;
  const [, day, time, tag = '', reason = ''] = match;
  const at = new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)), Number(time.slice(0, 2)), Number(time.slice(2, 4)), Number(time.slice(4, 6))).getTime();
  return { name, at, tag, reason };
}
function isOtsBackupFile(name = '', extension = '') {
  return otsBackupFileName.test(name) && (!extension || name.endsWith(`.${extension}`));
}
function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const orderBuckets = ['orders', 'trashOrders', 'deletedOrders'];
const entityStateKeys = new Set([...orderBuckets, 'customers', 'trackingLookups']);

function emptyDataPayload() {
  return {
    app: 'trade-order-system',
    version: 'sqlite-1',
    exportedAt: new Date().toISOString(),
    data: {
      orders: [],
      trashOrders: [],
      deletedOrders: [],
      customers: {},
      trackingLookups: []
    }
  };
}

function normalizeDataPayload(raw) {
  const wrapper = raw && raw.data && Array.isArray(raw.data.orders)
    ? raw
    : { app: 'trade-order-system', version: 'legacy', exportedAt: new Date().toISOString(), data: raw };
  const data = wrapper?.data;
  if (!data || !Array.isArray(data.orders)) throw httpError(400, 'missing orders');
  orderBuckets.forEach(key => {
    if (!Array.isArray(data[key])) data[key] = [];
  });
  if (!data.customers || typeof data.customers !== 'object' || Array.isArray(data.customers)) data.customers = {};
  if (!Array.isArray(data.trackingLookups)) data.trackingLookups = [];
  return {
    app: String(wrapper.app || 'trade-order-system'),
    version: String(wrapper.version || 'sqlite-1'),
    exportedAt: String(wrapper.exportedAt || new Date().toISOString()),
    data
  };
}

function stateCounts(payload) {
  const data = normalizeDataPayload(payload).data;
  return {
    orders: data.orders.length,
    trashOrders: data.trashOrders.length,
    deletedOrders: data.deletedOrders.length,
    customers: Object.keys(data.customers).length,
    trackingLookups: data.trackingLookups.length
  };
}

function metadataValue(key, fallback = '') {
  if (!database) return fallback;
  const row = database.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
  return row ? String(row.value) : fallback;
}

function setMetadata(key, value) {
  database.prepare(`
    INSERT INTO metadata(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(key), String(value));
}

function createDatabaseSchema() {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      bucket TEXT NOT NULL CHECK(bucket IN ('orders','trashOrders','deletedOrders')),
      position INTEGER NOT NULL,
      num TEXT NOT NULL DEFAULT '',
      client TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      order_month TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      tracking_number TEXT NOT NULL DEFAULT '',
      carrier TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_num ON orders(num) WHERE num <> '';
    CREATE INDEX IF NOT EXISTS idx_orders_bucket_position ON orders(bucket, position);
    CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client);
    CREATE INDEX IF NOT EXISTS idx_orders_month ON orders(order_month);
    CREATE INDEX IF NOT EXISTS idx_orders_stage ON orders(stage);
    CREATE INDEX IF NOT EXISTS idx_orders_tracking ON orders(tracking_number);

    CREATE TABLE IF NOT EXISTS customers (
      name TEXT PRIMARY KEY,
      country TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
    CREATE INDEX IF NOT EXISTS idx_customers_contact ON customers(contact);

    CREATE TABLE IF NOT EXISTS tracking_lookups (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      tracking_number TEXT NOT NULL DEFAULT '',
      carrier TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_number ON tracking_lookups(tracking_number);

    CREATE TABLE IF NOT EXISTS order_attachments (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      file_url TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL,
      PRIMARY KEY(order_id, position)
    );

    CREATE TABLE IF NOT EXISTS order_logs (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      event_time TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL,
      PRIMARY KEY(order_id, position)
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      channel TEXT NOT NULL DEFAULT 'feishu_group',
      status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')),
      idempotency_key TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  // error_kind：失败原因的类别（timeout = 可能已经发出）；sent_fields：发出时群里那条消息的字段，用来提示「发出后改过」。
  const deliveryColumns = new Set(database.prepare('PRAGMA table_info(notification_deliveries)').all().map(row => row.name));
  if (!deliveryColumns.has('error_kind')) database.exec("ALTER TABLE notification_deliveries ADD COLUMN error_kind TEXT NOT NULL DEFAULT ''");
  if (!deliveryColumns.has('sent_fields')) database.exec("ALTER TABLE notification_deliveries ADD COLUMN sent_fields TEXT NOT NULL DEFAULT ''");
}

// 金额列是 REAL NOT NULL：写不进去的值（"1,200"、"$500"、对象）是请求的错，回 422 并说出是哪张单的哪个字段，
// 页面不会把它当成临时故障每 3 秒重试。
function orderMoneyValue(order, field, label) {
  const raw = order?.[field];
  const value = Number(raw || 0);
  if (!Number.isFinite(value)) {
    const name = String(order?.num || order?.id || '').slice(0, 60) || '未编号订单';
    throw httpError(422, `订单 ${name} 的${label}（${field}）不是数字：${String(typeof raw === 'object' ? JSON.stringify(raw) : raw).slice(0, 40)}`, { publicDetails:{ orderNum:name, field } });
  }
  return value;
}
// customerInference:false（导入、恢复示例、撤销导入）：整份数据换掉时不按「删 1 加 1」或订单改名去猜客户改名，
// WhatsApp 聊天留在原来的名字上，不会挂到另一位客户名下。
function writeStateToDatabase(rawPayload, { migration = false, baseRevision, customerMoves: explicitMoves = [], customerDeletes = [], customerInference = true } = {}) {
  if (!database) throw new Error('SQLite database is not available');
  const payload = normalizeDataPayload(rawPayload);
  const data = payload.data;
  const orderInsert = database.prepare(`
    INSERT INTO orders(
      id, bucket, position, num, client, country, order_month, stage,
      amount, paid_amount, currency, tracking_number, carrier, updated_at, data_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      bucket = excluded.bucket,
      position = excluded.position,
      num = excluded.num,
      client = excluded.client,
      country = excluded.country,
      order_month = excluded.order_month,
      stage = excluded.stage,
      amount = excluded.amount,
      paid_amount = excluded.paid_amount,
      currency = excluded.currency,
      tracking_number = excluded.tracking_number,
      carrier = excluded.carrier,
      updated_at = excluded.updated_at,
      data_json = excluded.data_json
  `);
  const attachmentInsert = database.prepare(`
    INSERT INTO order_attachments(order_id, position, file_url, data_json) VALUES(?, ?, ?, ?)
  `);
  const logInsert = database.prepare(`
    INSERT INTO order_logs(order_id, position, event_time, data_json) VALUES(?, ?, ?, ?)
  `);
  const customerInsert = database.prepare(`
    INSERT INTO customers(name, country, email, contact, updated_at, data_json) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      country = excluded.country,
      email = excluded.email,
      contact = excluded.contact,
      updated_at = excluded.updated_at,
      data_json = excluded.data_json
  `);
  const lookupInsert = database.prepare(`
    INSERT INTO tracking_lookups(id, position, tracking_number, carrier, updated_at, data_json) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      position = excluded.position,
      tracking_number = excluded.tracking_number,
      carrier = excluded.carrier,
      updated_at = excluded.updated_at,
      data_json = excluded.data_json
  `);
  const appStateInsert = database.prepare(`
    INSERT INTO app_state(key, data_json) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json
  `);
  const attachmentDelete = database.prepare('DELETE FROM order_attachments WHERE order_id = ?');
  const logDelete = database.prepare('DELETE FROM order_logs WHERE order_id = ?');
  const orderDelete = database.prepare('DELETE FROM orders WHERE id = ?');
  const customerDelete = database.prepare('DELETE FROM customers WHERE name = ?');
  const lookupDelete = database.prepare('DELETE FROM tracking_lookups WHERE id = ?');
  const appStateGet = database.prepare('SELECT data_json FROM app_state WHERE key = ?');
  const appStateDelete = database.prepare('DELETE FROM app_state WHERE key = ?');

  database.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = Number(metadataValue('revision', '0'));
    if (!migration) {
      const requestedRevision = Number(baseRevision);
      if (!Number.isSafeInteger(requestedRevision) || requestedRevision < 0) {
        throw httpError(428, 'baseRevision is required', { currentRevision });
      }
      if (requestedRevision !== currentRevision) {
        throw httpError(409, 'state revision conflict', { currentRevision });
      }
    }
    const nextRevision = currentRevision + 1;
    const existingOrders = new Map(database.prepare('SELECT id, bucket, position, num, client, data_json FROM orders').all().map(row => [row.id, row]));
    const desiredOrders = [];
    const desiredOrderIds = new Set();
    // Invalid state is a client error (422), not a server failure: the page must not retry it forever.
    const desiredNums = new Map();
    orderBuckets.forEach(bucket => {
      data[bucket].forEach((order, position) => {
        const id = String(order?.id || '').trim();
        if (!id) throw httpError(422, `${bucket} contains an order without id`);
        if (desiredOrderIds.has(id)) throw httpError(422, `duplicate order id: ${id}`);
        const num = String(order?.num || '');
        if (num && desiredNums.has(num)) {
          throw httpError(422, `订单号 ${num} 重复：两张订单用了同一个订单号（含回收站和已删除），请改掉其中一个`, { publicDetails:{ duplicateNum:num } });
        }
        if (num) desiredNums.set(num, id);
        orderMoneyValue(order, 'amount', '金额');
        orderMoneyValue(order, 'paidAmount', '已付款');
        desiredOrderIds.add(id);
        desiredOrders.push({ bucket, order, position, id });
      });
    });
    // The unique num index is checked row by row, so free numbers that are being
    // removed or reassigned before upserting; duplicates in the final state still fail.
    existingOrders.forEach((_, id) => {
      if (!desiredOrderIds.has(id)) orderDelete.run(id);
    });
    const orderNumClear = database.prepare("UPDATE orders SET num = '' WHERE id = ?");
    desiredOrders.forEach(({ order, id }) => {
      const previous = existingOrders.get(id);
      if (previous && previous.num && previous.num !== String(order.num || '')) orderNumClear.run(id);
    });
    desiredOrders.forEach(({ bucket, order, position, id }) => {
      const orderJson = JSON.stringify(order);
      const previous = existingOrders.get(id);
      const changed = !previous || previous.data_json !== orderJson || previous.bucket !== bucket || Number(previous.position) !== position;
      if (changed) {
        orderInsert.run(
          id,
          bucket,
          position,
          String(order.num || ''),
          String(order.client || ''),
          String(order.country || ''),
          String(order.orderMonth || ''),
          String(order.stage || ''),
          orderMoneyValue(order, 'amount', '金额'),
          orderMoneyValue(order, 'paidAmount', '已付款'),
          String(order.currency || 'USD'),
          String(order.trackingNumber || ''),
          String(order.carrier || ''),
          String(order.updated || ''),
          orderJson
        );
      }
      if (!previous || previous.data_json !== orderJson) {
        attachmentDelete.run(id);
        logDelete.run(id);
        (Array.isArray(order.attachments) ? order.attachments : []).forEach((item, index) => {
          attachmentInsert.run(id, index, String(item?.fileUrl || item?.link || ''), JSON.stringify(item));
        });
        (Array.isArray(order.logs) ? order.logs : []).forEach((item, index) => {
          const eventTime = typeof item === 'object' && item ? item.time : '';
          logInsert.run(id, index, String(eventTime || ''), JSON.stringify(item));
        });
      }
    });

    const existingCustomers = new Map(database.prepare('SELECT name, data_json FROM customers').all().map(row => [row.name, row.data_json]));
    const desiredCustomerNames = new Set();
    // 叫 __proto__ 的客户读回来时会写到对象原型上（凭空消失，下一次保存被删）：直接拒绝。
    if (Object.prototype.hasOwnProperty.call(data.customers, '__proto__')) throw httpError(422, '客户名称不可用：__proto__', { publicDetails:{ field:'customers' } });
    Object.entries(data.customers).forEach(([name, customer]) => {
      const record = customer && typeof customer === 'object' ? customer : {};
      const cleanName = String(name);
      const customerJson = JSON.stringify(record);
      desiredCustomerNames.add(cleanName);
      if (existingCustomers.get(cleanName) !== customerJson) {
        customerInsert.run(
          cleanName,
          String(record.country || ''),
          String(record.email || ''),
          String(record.contact || ''),
          String(record.updated || ''),
          customerJson
        );
      }
    });
    existingCustomers.forEach((_, name) => {
      if (!desiredCustomerNames.has(name)) customerDelete.run(name);
    });
    // Renames and merges arrive as "old profile removed + its orders moved to a new
    // name". Follow those moves so WhatsApp chats stay attached to the customer.
    const customerMoves = new Map();
    if (customerInference !== false) desiredOrders.forEach(({ order, id }) => {
      const from = existingOrders.get(id)?.client || '';
      const to = String(order.client || '');
      if (!from || from === to || desiredCustomerNames.has(from) || !existingCustomers.has(from) || !desiredCustomerNames.has(to)) return;
      if (!customerMoves.has(from)) customerMoves.set(from, new Set());
      customerMoves.get(from).add(to);
    });
    // A customer without orders renamed in the profile editor leaves no order move behind:
    // exactly one old name gone and exactly one new name added in the same save is that rename.
    // The page names deleted customers explicitly: their chats stay on the deleted name (undo or restore
    // re-attaches them) and are never guessed into a rename of a customer added in the same save.
    const deletedNames = new Set((Array.isArray(customerDeletes) ? customerDeletes : []).map(name => String(name || '')));
    const removedNames = [...existingCustomers.keys()].filter(name => !desiredCustomerNames.has(name) && !customerMoves.has(name) && !deletedNames.has(name));
    const addedNames = [...desiredCustomerNames].filter(name => !existingCustomers.has(name));
    if (customerInference !== false && removedNames.length === 1 && addedNames.length === 1 && !desiredOrders.some(({ order }) => String(order.client || '') === removedNames[0])) {
      customerMoves.set(removedNames[0], new Set([addedNames[0]]));
    }
    // Merges and their undo arrive as explicit moves: a merged customer without orders leaves no order
    // move behind, and the target already exists, so neither guess above would see it. An undo names the
    // exact chats the merge moved, so chats that were the target's own stay where they are.
    const movedChats = [];
    (Array.isArray(explicitMoves) ? explicitMoves : []).forEach(move => {
      const from = String(move?.from || '');
      const to = String(move?.to || '');
      if (!from || !to || from === to || !desiredCustomerNames.has(to)) return;
      customerMoves.delete(from);
      const chats = Array.isArray(move.chats) ? move.chats : null;
      movedChats.push({ id:String(move.id || ''), from, to, chats:moveWhatsAppChats(database, from, to, chats) });
    });
    customerMoves.forEach((targets, from) => {
      if (targets.size === 1) renameWhatsAppCustomer(database, from, [...targets][0]);
    });

    const existingLookups = new Map(database.prepare('SELECT id, position, data_json FROM tracking_lookups').all().map(row => [row.id, row]));
    const desiredLookupIds = new Set();
    data.trackingLookups.forEach((item, position) => {
      const id = String(item?.id || `lookup-${position}-${item?.trackingNumber || ''}`);
      const lookupJson = JSON.stringify(item || {});
      if (desiredLookupIds.has(id)) throw httpError(422, `物流查询记录 ID 重复：${id.slice(0, 80)}`, { publicDetails:{ field:'trackingLookups' } });
      desiredLookupIds.add(id);
      const previous = existingLookups.get(id);
      if (!previous || previous.data_json !== lookupJson || Number(previous.position) !== position) {
        lookupInsert.run(
          id,
          position,
          String(item?.trackingNumber || ''),
          String(item?.carrier || ''),
          String(item?.checkedAt || item?.updated || ''),
          lookupJson
        );
      }
    });
    existingLookups.forEach((_, id) => {
      if (!desiredLookupIds.has(id)) lookupDelete.run(id);
    });

    const desiredAppStateKeys = new Set();
    Object.entries(data).forEach(([key, value]) => {
      if (entityStateKeys.has(key)) return;
      desiredAppStateKeys.add(key);
      const nextJson = JSON.stringify(value);
      const existing = appStateGet.get(key);
      if (!existing || existing.data_json !== nextJson) appStateInsert.run(key, nextJson);
    });
    database.prepare('SELECT key FROM app_state').all().forEach(row => {
      if (!desiredAppStateKeys.has(row.key)) appStateDelete.run(row.key);
    });
    setMetadata('schema_version', '1');
    setMetadata('app', payload.app);
    setMetadata('payload_version', payload.version);
    setMetadata('exported_at', payload.exportedAt);
    setMetadata('revision', String(nextRevision));
    setMetadata('last_saved_at', new Date().toISOString());
    if (migration) setMetadata('migrated_at', new Date().toISOString());

    const expected = stateCounts(payload);
    const actual = {
      orders: Number(database.prepare("SELECT COUNT(*) AS count FROM orders WHERE bucket = 'orders'").get().count),
      trashOrders: Number(database.prepare("SELECT COUNT(*) AS count FROM orders WHERE bucket = 'trashOrders'").get().count),
      deletedOrders: Number(database.prepare("SELECT COUNT(*) AS count FROM orders WHERE bucket = 'deletedOrders'").get().count),
      customers: Number(database.prepare('SELECT COUNT(*) AS count FROM customers').get().count),
      trackingLookups: Number(database.prepare('SELECT COUNT(*) AS count FROM tracking_lookups').get().count)
    };
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`SQLite verification failed: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
    }
    database.exec('COMMIT');
    storageRevision = nextRevision;
    return { revision: nextRevision, counts: actual, ...(movedChats.length ? { movedChats } : {}) };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function readStateFromDatabase(db = database) {
  if (!db) throw new Error('SQLite database is not available');
  const data = {};
  db.prepare('SELECT key, data_json FROM app_state').all().forEach(row => {
    data[row.key] = JSON.parse(row.data_json);
  });
  orderBuckets.forEach(bucket => { data[bucket] = []; });
  db.prepare(`
    SELECT bucket, data_json FROM orders
    ORDER BY CASE bucket WHEN 'orders' THEN 0 WHEN 'trashOrders' THEN 1 ELSE 2 END, position
  `).all().forEach(row => {
    data[row.bucket].push(JSON.parse(row.data_json));
  });
  data.customers = {};
  db.prepare('SELECT name, data_json FROM customers ORDER BY name').all().forEach(row => {
    // 以前存进去的 __proto__ 客户读回来要是自己的键，不能改到原型上。
    Object.defineProperty(data.customers, row.name, { value:JSON.parse(row.data_json), enumerable:true, writable:true, configurable:true });
  });
  data.trackingLookups = db.prepare('SELECT data_json FROM tracking_lookups ORDER BY position').all().map(row => JSON.parse(row.data_json));
  let deliveryRows = [];
  try {
    deliveryRows = db.prepare(`
      SELECT *
      FROM notification_deliveries
    `).all();
  } catch (_) {}
  const deliveryByOrder = new Map(deliveryRows.map(row => [row.order_id, row]));
  const chatName = deliveryRows.length ? feishuConfig().chatName : '';
  orderBuckets.forEach(bucket => {
    data[bucket] = data[bucket].map(order => {
      const delivery = deliveryByOrder.get(order.id);
      if (!delivery) return order;
      return { ...order, feishuNotification: { requested: true, ...deliveryPublicFields(delivery, chatName) } };
    });
  });
  const meta = key => { try { const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key); return row ? String(row.value) : ''; } catch (_) { return ''; } };
  return {
    app: meta('app') || 'trade-order-system',
    version: meta('payload_version') || 'sqlite-1',
    exportedAt: meta('exported_at') || new Date().toISOString(),
    data
  };
}

function databaseIntegrity() {
  if (!database) return { ok: false, message: storageError || 'SQLite unavailable' };
  const result = database.prepare('PRAGMA integrity_check').get();
  const message = String(result?.integrity_check || 'unknown');
  integrityCache = { ok: message === 'ok', message, checkedAt: Date.now() };
  return { ok: integrityCache.ok, message };
}

// A full integrity_check scans every page; health probes reuse a recent result.
function recentDatabaseIntegrity(maxAgeMs = integrityCacheMs) {
  if (!database) return { ok: false, message: storageError || 'SQLite unavailable' };
  if (integrityCache && Date.now() - integrityCache.checkedAt < maxAgeMs) {
    return { ok: integrityCache.ok, message: integrityCache.message };
  }
  return databaseIntegrity();
}

function databaseCounts() {
  const counts = { orders: 0, trashOrders: 0, deletedOrders: 0 };
  database.prepare('SELECT bucket, COUNT(*) AS count FROM orders GROUP BY bucket').all().forEach(row => {
    counts[row.bucket] = Number(row.count);
  });
  return {
    ...counts,
    customers: Number(database.prepare('SELECT COUNT(*) AS count FROM customers').get().count),
    trackingLookups: Number(database.prepare('SELECT COUNT(*) AS count FROM tracking_lookups').get().count)
  };
}

function archiveMigrationSource(sourceFile) {
  if (!sourceFile || !fs.existsSync(sourceFile)) return '';
  const target = path.join(migrationArchiveDir, `trade-order-data-before-sqlite-${timestamp()}.json`);
  fs.copyFileSync(sourceFile, target);
  try { fs.chmodSync(target, 0o600); } catch (_) {}
  return target;
}

function hasPriorSqliteEvidence() {
  if (fs.existsSync(storageMarkerFile)) return true;
  try {
    if (fs.readdirSync(backupDir).some(name => isOtsBackupFile(name, 'sqlite'))) return true;
    if (fs.readdirSync(migrationArchiveDir).some(name => name.endsWith('.json'))) return true;
    if (fs.readdirSync(supportDir).some(name => name.startsWith('trade-order-system.sqlite.failed-'))) return true;
  } catch (_) {}
  return false;
}

function writeStorageMarker() {
  const databaseId = metadataValue('database_id', '') || crypto.randomUUID();
  if (!metadataValue('database_id', '')) setMetadata('database_id', databaseId);
  const current = fs.existsSync(storageMarkerFile) ? (() => {
    try { return readJson(storageMarkerFile); } catch (_) { return {}; }
  })() : {};
  atomicWrite(storageMarkerFile, JSON.stringify({
    databaseId,
    initializedAt: current.initializedAt || new Date().toISOString(),
    lastOpenedAt: new Date().toISOString()
  }, null, 2));
}

function verifyStorageMarker() {
  if (!fs.existsSync(storageMarkerFile)) return;
  const marker = readJson(storageMarkerFile);
  const expected = String(marker.databaseId || '');
  const actual = metadataValue('database_id', '');
  if (expected && actual && expected !== actual) {
    throw new Error('SQLite database identity does not match the storage marker');
  }
}

function initializeStorage() {
  ensureStorage();
  const existed = fs.existsSync(databaseFile);
  if (!existed && hasPriorSqliteEvidence()) {
    storageMode = 'error';
    storageError = 'SQLite database is missing; automatic recovery from legacy JSON is disabled';
    try {
      // A first-run migration that failed leaves its reason here; show that instead of the generic message.
      const lastError = readJson(migrationErrorFile);
      if (lastError?.message) storageError = `${storageError} (last migration error: ${lastError.message})`;
    } catch (_) {}
    database = null;
    return;
  }
  try {
    database = new DatabaseSync(databaseFile);
    createDatabaseSchema();
    if (!metadataValue('initialized', '')) {
      let sourceFile = '';
      if (fs.existsSync(dataFile)) sourceFile = dataFile;
      else if (fs.existsSync(seedDataFile)) sourceFile = seedDataFile;
      const payload = sourceFile ? readJson(sourceFile) : emptyDataPayload();
      const result = writeStateToDatabase(payload, { migration: true });
      // Archive only after the data is in SQLite: a copy left behind by a failed migration would count as
      // "prior SQLite evidence" and block the retry on the next launch.
      const archive = sourceFile === dataFile ? archiveMigrationSource(sourceFile) : '';
      setMetadata('initialized', '1');
      setMetadata('migration_source', sourceFile || 'empty');
      setMetadata('migration_archive', archive || '');
      setMetadata('migration_counts', JSON.stringify(result.counts));
    }
    const integrity = databaseIntegrity();
    if (!integrity.ok) throw new Error(`SQLite integrity check failed: ${integrity.message}`);
    verifyStorageMarker();
    writeStorageMarker();
    storageRevision = Number(metadataValue('revision', '0'));
    storageMode = 'sqlite';
    storageError = '';
    try { fs.chmodSync(databaseFile, 0o600); } catch (_) {}
  } catch (error) {
    storageError = error.message || String(error);
    const initialized = (() => { try { return Boolean(metadataValue('initialized', '')); } catch (_) { return false; } })();
    try { database?.close(); } catch (_) {}
    database = null;
    if (!existed && fs.existsSync(databaseFile)) {
      if (initialized) {
        try { fs.renameSync(databaseFile, `${databaseFile}.failed-${timestamp()}`); } catch (_) {}
      } else {
        // The migration never completed, so nothing in this file is worth keeping. Removing it lets the
        // next launch retry from the legacy JSON instead of treating the failed file as prior SQLite evidence.
        ['', '-wal', '-shm'].forEach(suffix => { try { fs.rmSync(`${databaseFile}${suffix}`, { force: true }); } catch (_) {} });
        try { atomicWrite(migrationErrorFile, JSON.stringify({ at: new Date().toISOString(), message: storageError }, null, 2)); } catch (_) {}
      }
    }
    storageMode = 'error';
  }
}

function readCurrentPayload() {
  if (storageMode === 'sqlite') return readStateFromDatabase();
  throw new Error(storageError || 'storage unavailable');
}

function saveCurrentPayload(payload, options = {}) {
  if (storageMode === 'sqlite') return writeStateToDatabase(payload, options);
  throw new Error(storageError || 'storage unavailable');
}

function safeFilePart(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+$/, '')
    .slice(0, 80) || 'file';
}

function extensionForMime(mime = '') {
  if (/avif/i.test(mime)) return 'avif';
  if (/webp/i.test(mime)) return 'webp';
  if (/png/i.test(mime)) return 'png';
  if (/jpe?g/i.test(mime)) return 'jpg';
  return 'bin';
}

function availableFileName(dir, base, ext) {
  let index = 1;
  let name = `${base}.${ext}`;
  while (fs.existsSync(path.join(dir, name))) {
    index += 1;
    name = `${base}-${index}.${ext}`;
  }
  return name;
}

function parseImageDataUrl(value = '') {
  const match = String(value || '').match(/^data:(image\/(?:avif|png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw httpError(415, '图片格式不支持：只接受 PNG、JPEG、WebP、AVIF 的 data URL');
  return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2].replace(/\s+/g, ''), 'base64') };
}

function readTinifyApiKey() {
  const environmentKey = String(process.env.TINIFY_API_KEY || '').trim();
  if (environmentKey) return environmentKey;
  if (!fs.existsSync(tinifyApiKeyFile)) return '';
  try {
    fs.chmodSync(tinifyApiKeyFile, 0o600);
    return fs.readFileSync(tinifyApiKeyFile, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function tinifyUrlAllowed(targetUrl = '') {
  try {
    const target = new URL(targetUrl);
    const endpoint = new URL(tinifyEndpoint);
    return target.origin === endpoint.origin
      && (endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'));
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
    const shrink = await requestBinaryResponse(tinifyEndpoint, {
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

function attachmentPublicUrl(relativePath = '') {
  return `/attachments/${String(relativePath).split('/').map(encodeURIComponent).join('/')}`;
}

function attachmentTargetFromUrl(fileUrl = '') {
  const parsed = new URL(String(fileUrl || ''), `http://127.0.0.1:${port}`);
  if (!parsed.pathname.startsWith('/attachments/')) throw httpError(400, 'unsupported attachment url');
  let relative;
  try { relative = decodeURIComponent(parsed.pathname.replace(/^\/attachments\//, '')); } catch (_) { throw httpError(400, 'unsupported attachment url'); }
  const target = path.resolve(attachmentsDir, relative);
  const root = path.resolve(attachmentsDir);
  if (!target.startsWith(root + path.sep)) throw httpError(400, 'unsupported attachment path');
  return target;
}

async function saveAttachmentImage(body = {}) {
  ensureStorage();
  const orderId = safeFilePart(body.orderId || 'draft');
  const dir = path.join(attachmentsDir, orderId);
  fs.mkdirSync(dir, { recursive: true });
  const sourceImage = parseImageDataUrl(body.data);
  const image = await optimizeAttachmentWithTinify(sourceImage);
  if (image.buffer.length > 64 * 1024 * 1024) throw new Error('image too large');
  const base = safeFilePart(path.parse(body.fileName || 'clipboard').name);
  const ext = extensionForMime(image.mime);
  const fileName = availableFileName(dir, base, ext);
  fs.writeFileSync(path.join(dir, fileName), image.buffer);

  let thumbName = '';
  let thumbSize = 0;
  if (body.thumbData) {
    const thumb = parseImageDataUrl(body.thumbData);
    if (thumb.buffer.length <= 512 * 1024) {
      const thumbExt = extensionForMime(body.thumbMimeType || thumb.mime);
      thumbName = availableFileName(dir, `${path.parse(fileName).name}-thumb`, thumbExt);
      thumbSize = thumb.buffer.length;
      fs.writeFileSync(path.join(dir, thumbName), thumb.buffer);
    }
  }

  const relative = `${orderId}/${fileName}`;
  const thumbRelative = thumbName ? `${orderId}/${thumbName}` : relative;
  return {
    ok: true,
    name: path.parse(fileName).name,
    fileUrl: attachmentPublicUrl(relative),
    thumbUrl: attachmentPublicUrl(thumbRelative),
    size: image.buffer.length,
    thumbSize,
    optimized: image.optimized,
    optimizer: image.optimized ? 'TinyPNG' : '本地原图',
    fallback: image.fallback,
    compressionCount: image.compressionCount
  };
}

function collectAttachmentRefs(value, refs = new Set()) {
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    value.forEach(item => collectAttachmentRefs(item, refs));
    return refs;
  }
  ['fileUrl', 'thumbUrl'].forEach(key => {
    const url = value[key];
    if (!url) return;
    try {
      refs.add(attachmentTargetFromUrl(url));
    } catch (_) {}
  });
  Object.values(value).forEach(item => collectAttachmentRefs(item, refs));
  return refs;
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  });
  if (dir !== attachmentsDir && fs.readdirSync(dir).length === 0) {
    try { fs.rmdirSync(dir); } catch (_) {}
  }
}

function cleanupOrphanAttachments({ minAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  ensureStorage();
  if (!fs.existsSync(attachmentsDir)) return { deleted: 0 };
  let data = {};
  try { data = readCurrentPayload(); } catch (_) { return { deleted: 0 }; }
  let refs;
  try { refs = retainedAttachmentRefs(data); }
  catch (_) { return { deleted: 0, skipped:true, reason:'backup references unavailable' }; }
  const now = Date.now();
  let deleted = 0;
  const walk = dir => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        return;
      }
      try {
        const stat = fs.statSync(target);
        if (!refs.has(target) && now - stat.mtimeMs >= minAgeMs) {
          fs.unlinkSync(target);
          deleted += 1;
        }
      } catch (_) {}
    });
  };
  walk(attachmentsDir);
  removeEmptyDirs(attachmentsDir);
  return { deleted };
}

function localDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function notificationIdempotencyKey(orderId = '') {
  return `trade-order-${crypto.createHash('sha256').update(String(orderId)).digest('hex').slice(0, 32)}`;
}

// 群消息里客户和订单的文字一律当纯文本：转义 Markdown 记号，去掉控制符和方向控制符（U+202E 会把后面的字倒过来）；
// 多行的值（地址、备注）从第二行起缩进两个全角空格，行首的 #、-、+、1.、--- 也换成全角，
// 群里不会出现客户写的标题、列表、分割线、表格，也不会多出一行看起来像字段的「订单金额：…」。
function escapeLarkMarkdown(value = '') {
  const lines = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replaceAll('\\', '\\\\')
    .replace(/([`*_\[\]])/g, '\\$1')
    .replaceAll('<', '＜')
    .replaceAll('>', '＞')
    .replaceAll('~', '～')
    .replaceAll('|', '｜')
    .split('\n')
    .map(line => line.trim());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return '未填写';
  return lines.map((line, index) => {
    if (!index || !line) return line;
    const plain = line
      .replace(/^#{1,6}(?=\s|$)/, marks => '＃'.repeat(marks.length))
      .replace(/^(?:[-=]\s*){2,}$/, rule => rule.replaceAll('-', '－').replaceAll('=', '＝'))
      .replace(/^[-+](?=\s)/, mark => (mark === '-' ? '－' : '＋'))
      .replace(/^(\d{1,9})([.)])(?=\s|$)/, (_, number, mark) => `${number}${mark === '.' ? '．' : '）'}`);
    return `\u3000\u3000${plain}`;
  }).join('\n');
}

function orderNotificationAmount(order = {}) {
  const currency = String(order.currency || 'USD').trim().toUpperCase() || 'USD';
  const amount = Number(order.amount || 0);
  return `${currency} ${Number.isFinite(amount) ? amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}`;
}

// 群消息里用到的字段（发出时记下来，之后订单改了这些字段，抽屉里提示「群里是旧信息」）。
function orderNotificationFields({ order, customer }) {
  const text = value => String(value ?? '').trim();
  return {
    client: text(order.client),
    num: text(order.num),
    email: text(customer.email),
    phone: text(customer.phone),
    address: text(customer.address),
    amount: orderNotificationAmount(order),
    paymentChannel: text(order.paymentChannel),
    note: text(order.note)
  };
}

function buildOrderNotificationMarkdown({ order, customer }, imageKeys = [], skippedImages = []) {
  const lines = [
    `**客户名称：** ${escapeLarkMarkdown(order.client)}`,
    `**订单号：** ${escapeLarkMarkdown(order.num)}`,
    `**邮箱：** ${escapeLarkMarkdown(customer.email)}`,
    `**手机号：** ${escapeLarkMarkdown(customer.phone)}`,
    `**收货地址：** ${escapeLarkMarkdown(customer.address)}`,
    '',
    `**订单金额：** ${escapeLarkMarkdown(orderNotificationAmount(order))}`,
    `**付款方式：** ${escapeLarkMarkdown(order.paymentChannel)}`,
    `**订单备注：** ${escapeLarkMarkdown(order.note)}`
  ];
  imageKeys.forEach((item, index) => lines.push('', `![附件 ${item.index || index + 1}](${item.key || item})`));
  if (skippedImages.length) {
    lines.push('', `**未能附上的图片：** ${skippedImages.map(item => `附件 ${item.index}（${item.reason}）`).join('、')}`);
  }
  return lines.join('\n');
}

// 测试可以把超时调短（只能更短），不用真的等 45 秒。
const larkTimeoutMs = Math.min(45000, Math.max(200, Number(process.env.OTS_LARK_TIMEOUT_MS) || 45000));
const larkImageLimitBytes = 10 * 1024 * 1024;
const larkFailureText = {
  config: '还没有配置飞书：到「设置 → 飞书通知」填写后再发送',
  'cli-missing': '这台 Mac 上找不到 lark-cli：先安装 lark-cli，或在「设置 → 飞书通知」里填写它的完整路径',
  'cli-start': 'lark-cli 启动失败：检查「设置 → 飞书通知」里的 lark-cli 路径',
  permission: '飞书机器人缺少权限：到飞书开发者后台给应用开通「以应用身份发消息」（im:message:send_as_bot），有图片时还要开通 im:resource，发布新版本后再重新发送',
  credential: '飞书凭证失效（token 过期或 App Secret 不对）：在终端运行 lark-cli config init 重新配置这个 profile，再重新发送',
  profile: 'lark-cli 里没有设置中填写的 profile：检查 profile 名，或在终端运行 lark-cli config init',
  rate: '飞书限流了：过一两分钟再重新发送',
  network: '连不上飞书（网络断开或代理不通）：联网后再重新发送',
  timeout: '飞书 45 秒内没有回应，消息可能已经发到群里：请先看一眼群，再决定是否重新发送',
  generic: '飞书服务暂时不可用，可稍后重试'
};
const larkRetryableKinds = new Set(['rate', 'network', 'timeout', 'generic']);

function larkFailure(kind, { chatName = '', reason = '' } = {}) {
  let message = larkFailureText[kind] || larkFailureText.generic;
  if (kind === 'chat') message = `机器人不在「${chatName || '目标群'}」里，或群 ID 不对：先把机器人拉进这个群（或在设置里改群 ID），再重新发送`;
  if (kind === 'config' && reason && reason !== '还没有配置飞书') message = `飞书配置有问题：${reason}。到「设置 → 飞书通知」改好后再发送`;
  return httpError(503, message, { larkKind: kind, retryable: larkRetryableKinds.has(kind) });
}

function larkCliCandidates(config = {}) {
  const home = os.homedir();
  const fromEnv = String(process.env.TRADE_LARK_CLI || '').trim();
  if (fromEnv) return [fromEnv];
  // 设置里填了路径：只用它，找不到就明说，不悄悄换成别处的另一个 lark-cli。
  if (config.cliPath) return [config.cliPath];
  const candidates = [
    path.join(home, '.local', 'bin', 'lark-cli'),
    '/opt/homebrew/bin/lark-cli',
    '/usr/local/bin/lark-cli',
    path.join(home, '.volta', 'bin', 'lark-cli'),
    path.join(home, '.npm-global', 'bin', 'lark-cli'),
    path.join(home, '.bun', 'bin', 'lark-cli'),
    path.join(home, 'bin', 'lark-cli')
  ];
  // nvm：每个 Node 版本各有一个 bin 目录，新版本优先。
  try {
    const nvmRoot = path.join(String(process.env.NVM_DIR || '').trim() || path.join(home, '.nvm'), 'versions', 'node');
    const versionKey = name => name.replace(/^v/, '').split('.').map(part => Number(part) || 0);
    fs.readdirSync(nvmRoot)
      .sort((a, b) => {
        const left = versionKey(a);
        const right = versionKey(b);
        for (let i = 0; i < 3; i += 1) if ((right[i] || 0) !== (left[i] || 0)) return (right[i] || 0) - (left[i] || 0);
        return 0;
      })
      .forEach(version => candidates.push(path.join(nvmRoot, version, 'bin', 'lark-cli')));
  } catch (_) {}
  return candidates;
}

// npm 装的是 JS 外壳（用这个 Node 跑，App 的 PATH 里不一定有 node）；make install / Volta 是原生程序，直接运行。
function resolveLarkCli(config = {}) {
  const executable = larkCliCandidates(config).find(candidate => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch (_) { return false; }
  });
  if (!executable) return null;
  let real = executable;
  try { real = fs.realpathSync(executable); } catch (_) {}
  let viaNode = /\.[cm]?js$/i.test(real);
  if (!viaNode) {
    let descriptor;
    try {
      descriptor = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const head = Buffer.alloc(256);
      const length = fs.readSync(descriptor, head, 0, head.length, 0);
      const firstLine = head.subarray(0, length).toString('latin1').split('\n')[0];
      viaNode = firstLine.startsWith('#!') && /\bnode\b/.test(firstLine);
    } catch (_) {
      viaNode = false;
    } finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (_) {} }
    }
  }
  return viaNode
    ? { command: process.execPath, prefix: [real], kind: 'node', path: executable }
    : { command: executable, prefix: [], kind: 'native', path: executable };
}

// lark-cli 只拿到它用得到的环境变量：本机接口令牌（TRADE_API_TOKEN）、端口、数据目录都不给这个第三方程序。
function larkCliEnv() {
  const keep = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TZ',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'VOLTA_HOME', 'NVM_DIR'];
  const env = {};
  keep.forEach(key => { if (typeof process.env[key] === 'string') env[key] = process.env[key]; });
  Object.keys(process.env).filter(key => /^LARK(SUITE)?_/.test(key)).forEach(key => { env[key] = process.env[key]; });
  env.PATH = [path.dirname(process.execPath), env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(path.delimiter);
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  return env;
}

// lark-cli 的约定：成功信封写 stdout，错误信封写 stderr。两边都看，取最后一个 JSON 对象。
function parseLarkCliResult(output = '') {
  const text = String(output || '').trim();
  if (!text) return null;
  const start = text.lastIndexOf('\n{') >= 0 ? text.lastIndexOf('\n{') + 1 : text.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

// 把 lark-cli 的错误归成几类。原文（本机路径、密钥、群 ID）不回给页面、不入库，页面只拿到这一类的中文说明。
function classifyLarkFailure(result = null, rawText = '') {
  const error = result && typeof result.error === 'object' && result.error ? result.error : {};
  const code = Number(error.code || result?.code || 0);
  const type = String(error.type || '').toLowerCase();
  const subtype = String(error.subtype || '').toLowerCase();
  const missing = Array.isArray(error.missing_scopes) ? error.missing_scopes.join(' ') : '';
  const text = `${type} ${subtype} ${missing} ${String(error.message || '')} ${String(error.hint || '')} ${String(rawText || '').slice(0, 4000)}`.toLowerCase();
  if ([99991672, 99991679, 99991676].includes(code) || subtype === 'missing_scope' || type === 'permission' || /missing[_ ]scopes?|permission denied|no permission|access denied|scope|权限/.test(text)) return 'permission';
  if ([230002, 230006, 230001, 232010, 232011].includes(code) || /not in (the )?chat|bot is not in|out of the chat|chat (is )?not (found|exist)|invalid chat|不在群|群不存在/.test(text)) return 'chat';
  if (/profile/.test(text) && /not found|unknown|no such|does not exist|not exist|不存在/.test(text)) return 'profile';
  if ([99991661, 99991663, 99991664, 99991665, 99991668, 10014, 10003].includes(code) || type === 'authentication' || type === 'authorization' || /access[_ ]token|tenant[_ ]token|token (is )?(invalid|expired)|credential|app[_ ]?secret|unauthori[sz]ed|invalid app|authentication/.test(text)) return 'credential';
  if ([99991400, 11232, 429].includes(code) || type === 'rate_limit' || /rate.?limit|too many requests|frequency|频率|限流/.test(text)) return 'rate';
  if (type === 'network' || /enotfound|econnrefused|econnreset|etimedout|eai_again|enetunreach|ehostunreach|network|no such host|dial tcp|connection (refused|reset)|i\/o timeout|tls handshake|proxyconnect/.test(text)) return 'network';
  return 'generic';
}

// 用 npm 装的 lark-cli 是 JS 外壳 + 原生程序：只杀外壳的话原生程序会继续把消息发出去，所以整组进程一起结束。
function killLarkProcessTree(child) {
  try { process.kill(-child.pid, 'SIGKILL'); return; } catch (_) {}
  try { child.kill('SIGKILL'); } catch (_) {}
}

function runLarkCli(args, { cwd = resourcesDir, timeoutMs = larkTimeoutMs, config = feishuConfig() } = {}) {
  return new Promise((resolve, reject) => {
    if (!config.configured) {
      reject(larkFailure('config', { reason: config.reason }));
      return;
    }
    const cli = resolveLarkCli(config);
    if (!cli) {
      reject(larkFailure('cli-missing'));
      return;
    }
    let child;
    try {
      child = spawn(cli.command, [...cli.prefix, '--profile', config.profile, ...args, '--as', 'bot'], {
        cwd,
        env: larkCliEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
    } catch (_) {
      reject(larkFailure('cli-start'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let finished = false;
    const outputLimit = 1024 * 1024;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killLarkProcessTree(child);
      reject(larkFailure('timeout'));
    }, timeoutMs);
    const collect = target => chunk => {
      if (target === 'stdout' && stdout.length < outputLimit) stdout += chunk.toString('utf8').slice(0, outputLimit - stdout.length);
      if (target === 'stderr' && stderr.length < outputLimit) stderr += chunk.toString('utf8').slice(0, outputLimit - stderr.length);
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.once('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(larkFailure('cli-start'));
    });
    child.once('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const result = parseLarkCliResult(stdout);
      if (code === 0 && result?.ok) {
        resolve(result.data || {});
        return;
      }
      const failure = (result && result.ok === false ? result : null) || parseLarkCliResult(stderr) || result;
      reject(larkFailure(classifyLarkFailure(failure, `${stderr}\n${failure ? '' : stdout}`), { chatName: config.chatName }));
    });
  });
}

const larkImageFormats = /\.(png|jpe?g|webp|gif|bmp)$/i;
// 发群前把订单图片整理好：飞书收不下的（AVIF / HEIC 等格式、超过 10 MB）先在本机用 sips 转成 JPEG，
// 转不了就跳过这一张、文字照发，消息末尾写明哪张没附上。以前一张图就让整条消息永远发不出去。
function prepareNotificationImages(order = {}, workDir = '') {
  const files = [];
  const skipped = [];
  let index = 0;
  for (const item of Array.isArray(order.attachments) ? order.attachments : []) {
    if (!item?.fileUrl || item.fileUrl === item.thumbUrl && !/图片|image/i.test(String(item.type || ''))) continue;
    index += 1;
    let target = '';
    try { target = attachmentTargetFromUrl(item.fileUrl); } catch (_) {}
    let size = 0;
    try { const stat = fs.statSync(target); size = stat.isFile() ? stat.size : 0; } catch (_) {}
    if (!target || !size) {
      skipped.push({ index, reason: '文件不存在' });
      continue;
    }
    const supported = larkImageFormats.test(target);
    if (supported && size <= larkImageLimitBytes) {
      files.push({ file: target, index });
      continue;
    }
    const converted = convertImageForLark(target, workDir, index);
    if (converted) files.push({ file: converted, index });
    else skipped.push({ index, reason: supported ? '超过 10 MB' : '格式不支持' });
  }
  return { files, skipped };
}

function convertImageForLark(source, workDir, index) {
  const sips = '/usr/bin/sips';
  if (!workDir || !fs.existsSync(sips)) return '';
  const output = path.join(workDir, `attachment-${index}.jpg`);
  try {
    execFileSync(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '3000', source, '--out', output], { stdio: 'ignore', timeout: 30000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } });
    const size = fs.statSync(output).size;
    return size > 0 && size <= larkImageLimitBytes ? output : '';
  } catch (_) {
    return '';
  }
}

function readOrderNotificationContext(orderId = '') {
  const id = String(orderId || '').trim();
  if (!id) throw httpError(400, 'orderId is required');
  const row = database.prepare("SELECT bucket, data_json FROM orders WHERE id = ?").get(id);
  if (!row || row.bucket !== 'orders') throw httpError(404, '订单不存在');
  const order = JSON.parse(row.data_json);
  if (order.isDraft) throw httpError(409, '草稿订单不能发送群通知');
  const customerRow = database.prepare('SELECT data_json FROM customers WHERE name = ?').get(String(order.client || ''));
  const customer = customerRow ? JSON.parse(customerRow.data_json) : {};
  return { order, customer };
}

async function uploadLarkImage(file, config) {
  const result = await runLarkCli([
    'im', 'images', 'create',
    '--data', '{"image_type":"message"}',
    '--file', `./${path.basename(file)}`
  ], { cwd: path.dirname(file), timeoutMs: larkTimeoutMs, config });
  if (!String(result.image_key || '').startsWith('img_')) throw larkFailure('generic');
  return result.image_key;
}

// 页面看到的发送状态：数据库那一行 + 本机配置里的群名。发送中超过 2 分钟算没完成（可能已经发出）。
function deliveryPublicFields(row = {}, chatName = '') {
  const stale = row.status === 'sending' && !(Date.now() - Date.parse(row.started_at || row.updated_at || 0) < 2 * 60 * 1000);
  let sentFields = null;
  try { sentFields = row.sent_fields ? JSON.parse(row.sent_fields) : null; } catch (_) {}
  const errorKind = stale ? 'timeout' : String(row.error_kind || '');
  return {
    status: stale ? 'failed' : row.status,
    chatName,
    sentAt: row.sent_at || '',
    messageId: row.message_id || '',
    error: stale ? '上次发送没有完成，消息可能已经发到群里：请先看一眼群，再决定是否重新发送' : (row.last_error || ''),
    errorKind,
    retryable: row.status === 'failed' || stale ? larkRetryableKinds.has(errorKind || 'generic') : false,
    updatedAt: row.updated_at || '',
    ...(sentFields && typeof sentFields === 'object' ? { sentFields } : {})
  };
}

function deliveryPublicResult(row, extra = {}, chatName = feishuConfig().chatName) {
  const fields = deliveryPublicFields(row, chatName);
  return { ok: fields.status === 'sent', ...fields, ...extra };
}

function orderNotificationStatus(orderId = '') {
  const id = String(orderId || '').trim();
  if (!id) throw httpError(400, 'orderId is required');
  const row = database.prepare('SELECT * FROM notification_deliveries WHERE order_id = ?').get(id);
  return row ? deliveryPublicResult(row) : { ok: false, status: 'skipped' };
}

async function sendOrderNotification(orderId = '') {
  const context = readOrderNotificationContext(orderId);
  const existing = database.prepare('SELECT * FROM notification_deliveries WHERE order_id = ?').get(context.order.id);
  const config = feishuConfig();
  if (existing?.status === 'sent') return deliveryPublicResult(existing, { alreadySent: true }, config.chatName);
  if (existing?.status === 'sending' && Date.now() - Date.parse(existing.started_at) < 2 * 60 * 1000) {
    throw httpError(409, '群消息正在发送，请稍候', { publicDetails: { status: 'sending', chatName: config.chatName } });
  }
  if (!config.configured) {
    const failure = larkFailure('config', { reason: config.reason });
    failure.publicDetails = { status: 'failed', error: failure.message, errorKind: 'config', retryable: false, chatName: config.chatName };
    throw failure;
  }
  const startedAt = new Date().toISOString();
  const idempotencyKey = existing?.idempotency_key || notificationIdempotencyKey(context.order.id);
  database.prepare(`
    INSERT INTO notification_deliveries(
      order_id, channel, status, idempotency_key, started_at, sent_at, message_id, last_error, updated_at
    ) VALUES(?, 'feishu_group', 'sending', ?, ?, '', '', '', ?)
    ON CONFLICT(order_id) DO UPDATE SET
      status = 'sending', idempotency_key = excluded.idempotency_key,
      started_at = excluded.started_at, last_error = '', error_kind = '', updated_at = excluded.updated_at
  `).run(context.order.id, idempotencyKey, startedAt, startedAt);
  let workDir = '';
  try {
    try { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-feishu-')); } catch (_) {}
    const images = prepareNotificationImages(context.order, workDir);
    const imageKeys = [];
    const skippedImages = [...images.skipped];
    for (const item of images.files) {
      try {
        imageKeys.push({ key: await uploadLarkImage(item.file, config), index: item.index });
      } catch (error) {
        // 飞书拒收某一张图（格式、尺寸）：跳过它，文字照发。权限、凭证、断网、超时这类整条都发不了的照常报错。
        if (error.larkKind !== 'generic') throw error;
        skippedImages.push({ index: item.index, reason: '飞书拒收' });
      }
    }
    skippedImages.sort((a, b) => a.index - b.index);
    const markdown = buildOrderNotificationMarkdown(context, imageKeys, skippedImages);
    const result = await runLarkCli([
      'im', '+messages-send',
      '--chat-id', config.chatId,
      '--markdown', markdown,
      '--idempotency-key', idempotencyKey
    ], { config });
    const sentAt = result.create_time || localDateTime();
    const messageId = String(result.message_id || '');
    database.prepare(`
      UPDATE notification_deliveries
      SET status = 'sent', sent_at = ?, message_id = ?, last_error = '', error_kind = '', sent_fields = ?, updated_at = ?
      WHERE order_id = ?
    `).run(sentAt, messageId, JSON.stringify(orderNotificationFields(context)), new Date().toISOString(), context.order.id);
    const row = database.prepare('SELECT * FROM notification_deliveries WHERE order_id = ?').get(context.order.id);
    return deliveryPublicResult(row, skippedImages.length ? { skippedImages: skippedImages.length } : {}, config.chatName);
  } catch (error) {
    const kind = error.larkKind || 'generic';
    const safeMessage = error.larkKind ? error.message : larkFailureText.generic;
    database.prepare(`
      UPDATE notification_deliveries
      SET status = 'failed', last_error = ?, error_kind = ?, updated_at = ?
      WHERE order_id = ?
    `).run(safeMessage, kind, new Date().toISOString(), context.order.id);
    throw httpError(Number.isInteger(error.status) ? error.status : 503, safeMessage, {
      publicDetails: { status: 'failed', error: safeMessage, errorKind: kind, retryable: larkRetryableKinds.has(kind), chatName: config.chatName }
    });
  } finally {
    if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} }
  }
}

// 设置页看到的飞书状态：只说配没配好、为什么，以及群名；profile 和群 ID 不回给页面。
function publicFeishuStatus() {
  const config = feishuConfig();
  const cli = resolveLarkCli(config);
  let lastSent = null;
  let lastFailed = null;
  try {
    lastSent = database ? database.prepare("SELECT sent_at FROM notification_deliveries WHERE status = 'sent' ORDER BY updated_at DESC LIMIT 1").get() || null : null;
    lastFailed = database ? database.prepare("SELECT last_error FROM notification_deliveries WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1").get() || null : null;
  } catch (_) {}
  return {
    ok: true,
    configured: config.configured,
    state: config.state,
    reason: config.reason,
    chatName: config.configured ? config.chatName : '',
    profileSaved: !!config.profile,
    chatIdSaved: !!config.chatId,
    cliPath: config.cliPath || '',
    cli: { found: !!cli, kind: cli ? cli.kind : '' },
    lastSentAt: lastSent ? lastSent.sent_at || '' : '',
    lastError: lastFailed ? lastFailed.last_error || '' : ''
  };
}

async function sendFeishuTestMessage() {
  const config = feishuConfig();
  if (!config.configured) throw larkFailure('config', { reason: config.reason });
  const result = await runLarkCli([
    'im', '+messages-send',
    '--chat-id', config.chatId,
    '--markdown', `**OTS 测试消息：** 飞书通知已连通（${localDateTime()}）`,
    '--idempotency-key', `trade-order-test-${crypto.randomBytes(12).toString('hex')}`
  ], { config });
  return { ok: true, chatName: config.chatName, sentAt: result.create_time || localDateTime() };
}

function backupAttachmentRefs(file) {
  if (file.endsWith('.json')) return collectAttachmentRefs(readJson(file));
  const backup = new DatabaseSync(file, { readOnly:true });
  try {
    const refs = new Set();
    const tables = new Set(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    for (const table of ['orders', 'customers', 'tracking_lookups', 'app_state']) {
      if (!tables.has(table)) continue;
      for (const row of backup.prepare(`SELECT data_json FROM ${table}`).all()) {
        collectAttachmentRefs(JSON.parse(row.data_json), refs);
      }
    }
    return refs;
  } finally { backup.close(); }
}
function retainedAttachmentRefs(payload = readCurrentPayload()) {
  const refs = collectAttachmentRefs(payload);
  for (const name of fs.readdirSync(backupDir).filter(name => isOtsBackupFile(name))) {
    for (const file of backupAttachmentRefs(path.join(backupDir, name))) refs.add(file);
  }
  return refs;
}
function copyBackupAttachments(backupFile) {
  const dir = backupFile + '.attachments';
  fs.mkdirSync(dir, { recursive:true, mode:0o700 });
  let count = 0;
  for (const source of backupAttachmentRefs(backupFile)) {
    const relative = path.relative(attachmentsDir, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid backup attachment path');
    // 本机没有的附件（换电脑后导入的数据文件、被清理过的旧图）记在 missing 清单里，不拖垮整份备份。
    if (!fs.existsSync(source)) continue;
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive:true, mode:0o700 });
    // Independent copy (APFS may share immutable blocks), never a hard link.
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(target, 0o600);
    count += 1;
  }
  return count;
}
function missingAttachmentReport() {
  // 数据库照常备份；缺的图片按订单列出来，写进备份旁边的 .missing.json，并告诉页面。
  const orders = new Map();
  let count = 0;
  for (const row of database.prepare('SELECT num, data_json FROM orders').all()) {
    const missing = [...collectAttachmentRefs(JSON.parse(row.data_json))].filter(file => !fs.existsSync(file));
    if (!missing.length) continue;
    count += missing.length;
    const label = String(row.num || '').trim() || '未编号订单';
    orders.set(label, (orders.get(label) || 0) + missing.length);
  }
  return { count, orders:[...orders].map(([orderNum, files]) => ({ orderNum, files })) };
}
function missingAttachmentMessage(missing) {
  if (!missing?.count) return '';
  const names = missing.orders.slice(0, 10).map(item => item.orderNum).join('、');
  const more = missing.orders.length > 10 ? ` 等 ${missing.orders.length} 个订单` : '';
  return `已备份，但 ${missing.count} 个附件文件在本机找不到（订单 ${names}${more}），这些图片没有进备份。`;
}
// 备份 / 导出写盘失败的常见原因翻成中文（以前只显示「备份失败」或英文 ENOSPC 原文）。
function friendlyStorageError(error, where = '备份目录') {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  if (/ENOSPC|SQLITE_FULL|disk is full|no space/i.test(text)) return httpError(507, `${where}所在的磁盘空间不足，请清理磁盘或换一个目录`, { code:'disk_full' });
  if (/EACCES|EPERM|EROFS|read-only file system|readonly/i.test(text)) return httpError(500, `${where}没有写入权限，请换一个目录`, { code:'no_permission' });
  if (/ENOENT|ENOTDIR|EIO|ETIMEDOUT/i.test(text)) return httpError(503, `${where}暂时不可用（网盘或外置盘没有连上？）`, { code:'unavailable' });
  return error;
}
function databaseTag(db = database) {
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'database_id'").get();
    return String(row?.value || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
  } catch (_) { return ''; }
}
function removeBackupFiles(name) {
  const file = path.join(backupDir, name);
  fs.rmSync(file, { force:true });
  fs.rmSync(file + '.attachments', { recursive:true, force:true });
  fs.rmSync(file + '.missing.json', { force:true });
}
// 分级保留（以前只留最新 30 份，一小时最多一份，大约只能回到 3 个工作日前）：
// - 日常备份：最新 30 份一定留；另外 48 小时内的全留，30 天内每天留最新一份，12 周内每周留最新一份。
// - 操作前快照（before-*）：90 天内的全留，另外至少留最新 20 份。
// - 只动本机数据库的备份（文件名里的 id 和本机一致，或旧的没有 id 的），别的 Mac 写进同一目录的不动。
const dayMs = 24 * 60 * 60 * 1000;
function backupsToRotate(names, { now = Date.now(), tag = '' } = {}) {
  const own = names.map(parseBackupName).filter(item => item && item.name.endsWith('.sqlite') && (!item.tag || !tag || item.tag === tag))
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  const keep = new Set();
  const regular = own.filter(item => !item.reason);
  const snapshots = own.filter(item => item.reason);
  regular.slice(0, 30).forEach(item => keep.add(item.name));
  const days = new Set();
  const weeks = new Set();
  regular.forEach(item => {
    const age = now - item.at;
    if (age < 2 * dayMs) { keep.add(item.name); return; }
    const date = new Date(item.at);
    const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (age < 30 * dayMs) {
      if (!days.has(dayKey)) { days.add(dayKey); keep.add(item.name); }
      return;
    }
    const weekKey = Math.floor((item.at - new Date(2001, 0, 1).getTime()) / (7 * dayMs));
    if (age < 84 * dayMs && !weeks.has(weekKey)) { weeks.add(weekKey); keep.add(item.name); }
  });
  snapshots.forEach((item, index) => { if (index < 20 || now - item.at < 90 * dayMs) keep.add(item.name); });
  return own.filter(item => !keep.has(item.name)).map(item => item.name);
}
function createBackup(force = false, { beforeChange = false, reason = '', rotate = true } = {}) {
  ensureStorage();
  if (storageMode !== 'sqlite' || !database) return { ok: false, message: storageError || 'SQLite unavailable' };
  const label = backupReasons.includes(reason) ? reason : beforeChange ? 'change' : '';
  let meta = {};
  if (fs.existsSync(backupMetaFile)) {
    try { meta = readJson(backupMetaFile); } catch (_) {}
  }
  const now = Date.now();
  if (!force && meta.lastBackupAt && now - meta.lastBackupAt < 60 * 60 * 1000) {
    return { ok: true, skipped: true };
  }
  const extension = 'sqlite';
  const tag = databaseTag();
  const backupName = availableFileName(backupDir, `trade-order-data-${timestamp()}${tag ? `-${tag}` : ''}${label ? `-before-${label}` : ''}`, extension);
  const backupFile = path.join(backupDir, backupName);
  const stagingFile = backupFile + '.partial';
  const missing = missingAttachmentReport();
  database.exec('PRAGMA wal_checkpoint(FULL)');
  const quoted = stagingFile.replaceAll("'", "''");
  let attachmentCount;
  try {
    database.exec(`VACUUM INTO '${quoted}'`);
    fs.chmodSync(stagingFile, 0o600);
    attachmentCount = copyBackupAttachments(stagingFile);
    if (missing.count) atomicWrite(backupFile + '.missing.json', JSON.stringify({ missingAttachments:missing.orders, count:missing.count }, null, 2));
    fs.renameSync(stagingFile + '.attachments', backupFile + '.attachments');
    fs.renameSync(stagingFile, backupFile);
  } catch (error) {
    fs.rmSync(stagingFile, { force:true });
    fs.rmSync(stagingFile + '.attachments', { recursive:true, force:true });
    fs.rmSync(backupFile + '.attachments', { recursive:true, force:true });
    fs.rmSync(backupFile + '.missing.json', { force:true });
    throw friendlyStorageError(error);
  }
  let rotated = 0;
  try {
    if (rotate) backupsToRotate(fs.readdirSync(backupDir).filter(name => isOtsBackupFile(name, extension)), { now, tag }).forEach(name => {
      if (name === backupName) return;
      removeBackupFiles(name);
      rotated += 1;
    });
  } catch (_) {}
  atomicWrite(backupMetaFile, JSON.stringify({ lastBackupAt: now, lastBackupFile: backupFile }, null, 2));
  const summary = backupSummary();
  return {
    ok:true, file:backupFile, name:backupName, attachmentsDir:backupFile + '.attachments', attachmentCount, rotated,
    sqliteCount:summary.sqliteCount, oldestBackupAt:summary.oldestBackupAt,
    ...(missing.count ? { missingAttachments:missing.orders, warning:missingAttachmentMessage(missing) } : {})
  };
}

// Created once per open database: creating it runs the table setup and the legacy-type migration.
let subscriptionStoreCache = null;
function subscriptionStore() {
  if (!database || storageMode !== 'sqlite') throw httpError(503, '续费数据库暂不可用');
  if (subscriptionStoreCache?.db !== database) subscriptionStoreCache = { db:database, store:createSubscriptionStore(database) };
  return subscriptionStoreCache.store;
}

function automaticBackup() {
  try { return createBackup(false); } catch (error) {
    return { ok: false, message: error.message || 'automatic backup failed' };
  }
}

function backupSummary() {
  ensureStorage();
  const backups = fs.readdirSync(backupDir)
    .filter(name => isOtsBackupFile(name))
    .sort()
    .reverse();
  let meta = {};
  if (fs.existsSync(backupMetaFile)) {
    try { meta = readJson(backupMetaFile); } catch (_) {}
  }
  return {
    ok: true,
    count: backups.length,
    sqliteCount: backups.filter(name => name.endsWith('.sqlite')).length,
    jsonCount: backups.filter(name => name.endsWith('.json')).length,
    latest: backups[0] || null,
    dir: backupDir,
    defaultDir: defaultBackupDir,
    isDefault: backupDir === defaultBackupDir,
    dirError: backupDirError,
    lastBackupAt: Number(meta.lastBackupAt) || 0,
    lastBackupFile: meta.lastBackupFile || '',
    // 设置里显示「最早可以回到」：按文件名里的时间，不按修改时间（拷来拷去会变）。
    oldestBackupAt: (() => { const times = backups.map(parseBackupName).filter(item => item && item.name.endsWith('.sqlite')).map(item => item.at); return times.length ? Math.min(...times) : 0; })()
  };
}

// ---- 从备份恢复 ----
// 设置 → 数据管理 →「从备份恢复…」：列出备份目录里的每一份；选一份先看和当前数据的对比，确认后由服务端一次做完：
// 先给当前数据做一份「恢复前」快照 → 校验备份 → 关库、原子替换 → 并回附件（不覆盖已有文件）→ 身份标记换成备份的 → 版本号调大。
// 换电脑时把「备份目录」选到 iCloud 里的旧备份文件夹，就能在这里看到并恢复。
function resolveBackupFile(name) {
  const clean = String(name || '');
  if (!clean || path.basename(clean) !== clean || !isOtsBackupFile(clean, 'sqlite')) throw httpError(400, '备份文件名不对');
  const file = path.join(backupDir, clean);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, '找不到这份备份，可能已被轮转删除或移走');
  return file;
}
function payloadCounts(data = {}) {
  return {
    orders:(data.orders || []).length,
    trashOrders:(data.trashOrders || []).length,
    deletedOrders:(data.deletedOrders || []).length,
    customers:Object.keys(data.customers || {}).length
  };
}
function orderIndexById(data = {}) {
  const map = new Map();
  orderBuckets.forEach(bucket => (Array.isArray(data[bucket]) ? data[bucket] : []).forEach(order => {
    if (order && order.id) map.set(String(order.id), { bucket, order });
  }));
  return map;
}
// 「当前 → 恢复后」的差别：按订单 id 和客户名比，数出新增、修改、删除，并列出前几个会消失的订单号和客户名。
function diffStateData(current = {}, next = {}) {
  const strip = order => JSON.stringify({ ...order, feishuNotification:undefined });
  const before = orderIndexById(current);
  const after = orderIndexById(next);
  const orders = { added:0, changed:0, removed:0, removedNums:[] };
  after.forEach((item, id) => {
    const prev = before.get(id);
    if (!prev) orders.added += 1;
    else if (prev.bucket !== item.bucket || strip(prev.order) !== strip(item.order)) orders.changed += 1;
  });
  before.forEach((item, id) => {
    if (after.has(id)) return;
    orders.removed += 1;
    if (orders.removedNums.length < 8) orders.removedNums.push(String(item.order.num || id));
  });
  const currentCustomers = current.customers || {};
  const nextCustomers = next.customers || {};
  const customers = { added:0, changed:0, removed:0, removedNames:[] };
  Object.keys(nextCustomers).forEach(name => {
    if (!Object.prototype.hasOwnProperty.call(currentCustomers, name)) customers.added += 1;
    else if (JSON.stringify(currentCustomers[name]) !== JSON.stringify(nextCustomers[name])) customers.changed += 1;
  });
  Object.keys(currentCustomers).forEach(name => {
    if (Object.prototype.hasOwnProperty.call(nextCustomers, name)) return;
    customers.removed += 1;
    if (customers.removedNames.length < 8) customers.removedNames.push(name);
  });
  return { orders, customers };
}
function tableCount(db, table) {
  try { return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count); } catch (_) { return 0; }
}
function listBackups() {
  ensureStorage();
  const tag = database ? databaseTag() : '';
  const backups = fs.readdirSync(backupDir)
    .filter(name => isOtsBackupFile(name, 'sqlite'))
    .map(parseBackupName)
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1))
    .map(item => {
      const file = path.join(backupDir, item.name);
      let size = 0;
      try { size = fs.statSync(file).size; } catch (_) {}
      let missingAttachments = 0;
      try { missingAttachments = Number(readJson(file + '.missing.json').count) || 0; } catch (_) {}
      return { name:item.name, at:item.at, reason:item.reason, mine:!item.tag || !tag || item.tag === tag, size, hasAttachments:fs.existsSync(file + '.attachments'), missingAttachments };
    });
  return { ok:true, dir:backupDir, isDefault:backupDir === defaultBackupDir, storageMode, storageError, backups };
}
function openBackupReadOnly(file) {
  let db;
  try { db = new DatabaseSync(file, { readOnly:true }); }
  catch (error) { throw httpError(422, `这份备份打不开：${String(error.message || error).slice(0, 120)}`); }
  try {
    const integrity = String(db.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown');
    if (integrity !== 'ok') throw httpError(422, `这份备份已损坏：${integrity.slice(0, 120)}`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!['metadata', 'orders', 'customers'].every(name => tables.has(name))) throw httpError(422, '这不是本系统的数据库备份');
    return db;
  } catch (error) {
    try { db.close(); } catch (_) {}
    throw error.status ? error : httpError(422, `这份备份打不开：${String(error.message || error).slice(0, 120)}`);
  }
}
function backupPreview(name) {
  ensureStorage();
  const file = resolveBackupFile(name);
  const info = parseBackupName(name);
  const db = openBackupReadOnly(file);
  try {
    const payload = readStateFromDatabase(db);
    const current = storageMode === 'sqlite' && database ? readCurrentPayload().data : null;
    let missingAttachments = 0;
    try { missingAttachments = Number(readJson(file + '.missing.json').count) || 0; } catch (_) {}
    return {
      ok:true, name, at:info.at, reason:info.reason,
      counts:{ ...payloadCounts(payload.data), subscriptions:tableCount(db, 'subscriptions'), whatsappMessages:tableCount(db, 'whatsapp_messages') },
      current:current ? { ...payloadCounts(current), subscriptions:tableCount(database, 'subscriptions'), whatsappMessages:tableCount(database, 'whatsapp_messages') } : null,
      diff:current ? diffStateData(current, payload.data) : null,
      hasAttachments:fs.existsSync(file + '.attachments'),
      missingAttachments,
      storageMode, storageError
    };
  } finally { db.close(); }
}
function mergeBackupAttachments(sourceDir) {
  if (!fs.existsSync(sourceDir)) return 0;
  let copied = 0;
  const root = path.resolve(attachmentsDir);
  const walk = dir => {
    fs.readdirSync(dir, { withFileTypes:true }).forEach(entry => {
      const from = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(from);
      if (!entry.isFile()) return;
      const target = path.resolve(attachmentsDir, path.relative(sourceDir, from));
      if (!target.startsWith(root + path.sep) || fs.existsSync(target)) return;
      fs.mkdirSync(path.dirname(target), { recursive:true, mode:0o700 });
      fs.copyFileSync(from, target);
      try { fs.chmodSync(target, 0o600); } catch (_) {}
      copied += 1;
    });
  };
  walk(sourceDir);
  return copied;
}
function moveDatabaseFiles(from, to) {
  ['', '-wal', '-shm'].forEach(suffix => {
    if (fs.existsSync(from + suffix)) fs.renameSync(from + suffix, to + suffix);
  });
}
function restoreFromBackup(name) {
  ensureStorage();
  const source = resolveBackupFile(name);
  const staging = path.join(supportDir, `.restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  let displaced = '';
  try {
    fs.copyFileSync(source, staging);
    openBackupReadOnly(staging).close();
    // 1. 当前数据先备份一份「恢复前」快照；生成不了就不恢复。
    let safety = null;
    if (storageMode === 'sqlite' && database) {
      // 这次不轮转：要恢复的那份可能正是按规则该删的旧备份（例如从 iCloud 选回来的），它和它的附件这时还要用。
      safety = createBackup(true, { reason:'restore', rotate:false });
      if (!safety.ok) throw httpError(503, `恢复前的备份没有生成，没有恢复：${safety.message || ''}`);
    } else if (fs.existsSync(databaseFile)) {
      // 读库失败（身份标记不符等）时库没打开：把现在的文件原样拷一份（连同 -wal）。
      const rawName = availableFileName(backupDir, `trade-order-data-${timestamp()}-before-restore`, 'sqlite');
      try {
        fs.copyFileSync(databaseFile, path.join(backupDir, rawName));
        if (fs.existsSync(`${databaseFile}-wal`)) fs.copyFileSync(`${databaseFile}-wal`, path.join(backupDir, `${rawName}-wal`));
      } catch (error) {
        fs.rmSync(path.join(backupDir, rawName), { force:true });
        throw friendlyStorageError(error);
      }
      safety = { ok:true, name:rawName, file:path.join(backupDir, rawName) };
    }
    // 2. 关库、原子替换。原来的文件先挪开，新库打不开就放回去。
    const previousRevision = database ? Math.max(storageRevision, Number(metadataValue('revision', '0'))) : storageRevision;
    if (database) {
      try { database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
      database.close();
      database = null;
    }
    subscriptionStoreCache = null;
    integrityCache = null;
    storageMode = 'restoring';
    displaced = `${databaseFile}.replaced-${process.pid}-${Date.now()}`;
    moveDatabaseFiles(databaseFile, displaced);
    fs.renameSync(staging, databaseFile);
    let revision = 0;
    try {
      database = new DatabaseSync(databaseFile);
      createDatabaseSchema();
      const integrity = databaseIntegrity();
      if (!integrity.ok) throw new Error(`SQLite integrity check failed: ${integrity.message}`);
      // 3. 版本号比当前和备份里的都大：别的窗口再保存会得到 409，切成只读，不会把旧数据写回来。
      revision = Math.max(previousRevision, Number(metadataValue('revision', '0'))) + 1;
      setMetadata('revision', String(revision));
      if (!metadataValue('initialized', '')) setMetadata('initialized', '1');
      setMetadata('restored_from', name);
      setMetadata('restored_at', new Date().toISOString());
      // 4. 用户明确选了这份备份：身份标记换成它的数据库 id，不再被「identity does not match」拦下。
      fs.rmSync(storageMarkerFile, { force:true });
      writeStorageMarker();
      storageRevision = revision;
      storageMode = 'sqlite';
      storageError = '';
      fs.rmSync(migrationErrorFile, { force:true });
      try { fs.chmodSync(databaseFile, 0o600); } catch (_) {}
    } catch (error) {
      try { database?.close(); } catch (_) {}
      database = null;
      ['', '-wal', '-shm'].forEach(suffix => fs.rmSync(databaseFile + suffix, { force:true }));
      moveDatabaseFiles(displaced, databaseFile);
      displaced = '';
      initializeStorage();
      throw httpError(500, `恢复没有完成，数据保持原样：${error.message || error}`);
    }
    ['', '-wal', '-shm'].forEach(suffix => fs.rmSync(displaced + suffix, { force:true }));
    displaced = '';
    // 5. 附件并回来，已有的同名文件不覆盖。
    let restoredAttachments = 0;
    try { restoredAttachments = mergeBackupAttachments(source + '.attachments'); } catch (_) {}
    return { ok:true, restored:name, revision, safetyBackup:safety?.name || '', restoredAttachments, counts:databaseCounts(), backups:backupSummary() };
  } finally {
    fs.rmSync(staging, { force:true });
  }
}
// 导入预览用：文件里引用的附件本机有没有（换电脑后导入的数据文件常常没有）。
function checkAttachmentUrls(urls) {
  if (!Array.isArray(urls)) throw httpError(400, 'urls 必须是数组');
  const missing = [];
  urls.slice(0, 20000).forEach(url => {
    if (typeof url !== 'string' || !url) return;
    let target;
    try { target = attachmentTargetFromUrl(url); } catch (_) { return; }
    if (!fs.existsSync(target)) missing.push(url);
  });
  return { ok:true, missing };
}

const defaultTrackingSettings = {
  dhlApiEnabled: '是',
  dhlApiKey: '',
  fedexApiEnabled: '是',
  fedexApiKey: '',
  fedexApiSecret: '',
  fedexEnv: 'test',
  autoDhlUpdate: '是',
  autoRunTimes: '09:00,18:00',
  lastCheckedAt: '',
  lastStatus: '尚未查询',
  lastDhlCheckedAt: '',
  lastDhlStatus: '尚未查询',
  lastFedexCheckedAt: '',
  lastFedexStatus: '尚未查询',
  lastAutoRunAt: '',
  lastAutoRunSlot: '',
  lastAutoOkCount: 0,
  lastAutoFailCount: 0
};

function isAllowedTrackingHost(hostname = '') {
  const host = String(hostname).toLowerCase();
  // 和前端 carrierDefs 的官网一一对应：UPS 单号查不了 API，只能打开官网，以前漏了 ups.com，Mac App 里点「官网查询」没反应。
  return ['dhl.com', 'fedex.com', 'ups.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
}

const defaultAiSettings = {
  enabled: '否',
  provider: 'custom',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'deepseek/deepseek-v4.1-flash',
  lastTestAt: '',
  lastTestStatus: '尚未测试连接'
};

function normalizeAiSettings(raw = {}) {
  const rawModel = String(raw.model || defaultAiSettings.model).trim();
  return {
    enabled: raw.enabled === '是' ? '是' : '否',
    provider: raw.provider === 'zhipu' ? 'zhipu' : 'custom',
    baseUrl: String(raw.baseUrl || defaultAiSettings.baseUrl).trim().replace(/\/+$/, ''),
    model: rawModel,
    lastTestAt: String(raw.lastTestAt || ''),
    lastTestStatus: String(raw.lastTestStatus || defaultAiSettings.lastTestStatus)
  };
}

function readAiApiKey() {
  if (!fs.existsSync(aiApiKeyFile)) return '';
  try {
    fs.chmodSync(aiApiKeyFile, 0o600);
    return fs.readFileSync(aiApiKeyFile, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function writeAiApiKey(value) {
  ensureStorage();
  const key = String(value || '').trim();
  if (!key) {
    try { fs.rmSync(aiApiKeyFile, { force: true }); } catch (_) {}
    return;
  }
  atomicWrite(aiApiKeyFile, `${key}\n`);
}

function migrateLegacyAiApiKey() {
  ensureStorage();
  if (!fs.existsSync(aiSettingsFile)) return;
  let raw;
  try { raw = readJson(aiSettingsFile); } catch (_) { return; }
  if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'apiKey')) return;
  const legacyKey = String(raw.apiKey || '').trim();
  if (legacyKey && !readAiApiKey()) {
    writeAiApiKey(legacyKey);
    if (readAiApiKey() !== legacyKey) throw new Error('AI API key migration verification failed');
  }
  delete raw.apiKey;
  atomicWrite(aiSettingsFile, JSON.stringify(normalizeAiSettings(raw), null, 2));
}

function publicAiSettings(settings = readAiSettings()) {
  const key = process.env.AI_API_KEY || readAiApiKey();
  return {
    ...settings,
    apiKeySaved: Boolean(key),
    apiKeyMask: maskSecret(key)
  };
}

function aiEndpointIdentity(settings = {}) {
  let endpoint = '';
  try { endpoint = new URL(String(settings.baseUrl || '')).href.replace(/\/+$/, ''); } catch (_) {}
  return `${String(settings.provider || '').toLowerCase()}|${endpoint}`;
}

function assertSafeAiBaseUrl(settings = {}) {
  let parsed;
  try { parsed = new URL(String(settings.baseUrl || '')); } catch (_) {
    throw httpError(400, 'invalid AI base URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw httpError(400, 'AI base URL must use HTTPS without embedded credentials');
  }
  if (settings.provider === 'zhipu' && parsed.hostname.toLowerCase() !== 'open.bigmodel.cn') {
    throw httpError(400, 'Zhipu AI must use the official open.bigmodel.cn endpoint');
  }
}

function readAiSettings() {
  ensureStorage();
  if (!fs.existsSync(aiSettingsFile)) return { ...defaultAiSettings };
  try {
    return normalizeAiSettings(readJson(aiSettingsFile));
  } catch (_) {
    return { ...defaultAiSettings };
  }
}

function writeAiSettings(settings) {
  ensureStorage();
  const current = readAiSettings();
  const incoming = settings && typeof settings === 'object' ? settings : {};
  const next = normalizeAiSettings({ ...current, ...incoming });
  assertSafeAiBaseUrl(next);
  const endpointChanged = aiEndpointIdentity(current) !== aiEndpointIdentity(next);
  const incomingKey = String(incoming.apiKey || '').trim();
  if (endpointChanged) writeAiApiKey('');
  atomicWrite(aiSettingsFile, JSON.stringify(next, null, 2));
  if (incomingKey) writeAiApiKey(incomingKey);
  return publicAiSettings(next);
}

function normalizeTrackingSettings(raw = {}) {
  return {
    ...defaultTrackingSettings,
    dhlApiEnabled: raw.dhlApiEnabled === '是' ? '是' : '否',
    dhlApiKey: String(raw.dhlApiKey || '').trim(),
    fedexApiEnabled: raw.fedexApiEnabled === '是' ? '是' : '否',
    fedexApiKey: String(raw.fedexApiKey || '').trim(),
    fedexApiSecret: String(raw.fedexApiSecret || '').trim(),
    fedexEnv: raw.fedexEnv === 'prod' ? 'prod' : 'test',
    autoDhlUpdate: raw.autoDhlUpdate === '否' ? '否' : '是',
    autoRunTimes: String(raw.autoRunTimes || defaultTrackingSettings.autoRunTimes).trim() || defaultTrackingSettings.autoRunTimes,
    lastCheckedAt: raw.lastCheckedAt || '',
    lastStatus: raw.lastStatus || defaultTrackingSettings.lastStatus,
    lastDhlCheckedAt: raw.lastDhlCheckedAt || '',
    lastDhlStatus: raw.lastDhlStatus || defaultTrackingSettings.lastDhlStatus,
    lastFedexCheckedAt: raw.lastFedexCheckedAt || '',
    lastFedexStatus: raw.lastFedexStatus || defaultTrackingSettings.lastFedexStatus,
    lastAutoRunAt: raw.lastAutoRunAt || '',
    lastAutoRunSlot: raw.lastAutoRunSlot || '',
    lastAutoOkCount: Number(raw.lastAutoOkCount || 0),
    lastAutoFailCount: Number(raw.lastAutoFailCount || 0)
  };
}

function maskSecret(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 6) return `${text.slice(0, 1)}***${text.slice(-1)}`;
  return `${text.slice(0, 3)}******${text.slice(-3)}`;
}

function readTrackingSecrets() {
  if (!fs.existsSync(trackingSecretsFile)) return {};
  try {
    fs.chmodSync(trackingSecretsFile, 0o600);
    const raw = readJson(trackingSecretsFile);
    return Object.fromEntries(trackingSecretKeys.map(key => [key, String(raw?.[key] || '').trim()]));
  } catch (_) {
    return {};
  }
}

function withoutTrackingSecrets(settings) {
  const copy = { ...settings };
  trackingSecretKeys.forEach(key => { delete copy[key]; });
  return copy;
}

// Carrier credentials live in secrets/ beside the AI key, not in the plain settings file.
function migrateLegacyTrackingSecrets() {
  ensureStorage();
  if (!fs.existsSync(trackingSettingsFile)) return;
  let raw;
  try { raw = readJson(trackingSettingsFile); } catch (_) { return; }
  if (!raw || typeof raw !== 'object' || !trackingSecretKeys.some(key => Object.hasOwn(raw, key))) return;
  const stored = readTrackingSecrets();
  const merged = Object.fromEntries(trackingSecretKeys.map(key => [key, stored[key] || String(raw[key] || '').trim()]));
  atomicWrite(trackingSecretsFile, JSON.stringify(merged, null, 2));
  const verified = readTrackingSecrets();
  if (trackingSecretKeys.some(key => verified[key] !== merged[key])) throw new Error('tracking credential migration verification failed');
  atomicWrite(trackingSettingsFile, JSON.stringify(withoutTrackingSecrets(raw), null, 2));
}

function readTrackingSettings() {
  ensureStorage();
  let raw = {};
  if (fs.existsSync(trackingSettingsFile)) {
    try { raw = readJson(trackingSettingsFile); } catch (_) { raw = {}; }
  }
  return normalizeTrackingSettings({ ...raw, ...readTrackingSecrets() });
}

function writeTrackingSettings(settings) {
  ensureStorage();
  const current = readTrackingSettings();
  const next = normalizeTrackingSettings({ ...current, ...(settings || {}) });
  atomicWrite(trackingSecretsFile, JSON.stringify(Object.fromEntries(trackingSecretKeys.map(key => [key, next[key]])), null, 2));
  atomicWrite(trackingSettingsFile, JSON.stringify(withoutTrackingSecrets(next), null, 2));
  return {
    ...next,
    dhlApiKeySaved: Boolean(next.dhlApiKey),
    fedexApiKeySaved: Boolean(next.fedexApiKey),
    fedexApiSecretSaved: Boolean(next.fedexApiSecret),
    dhlApiKeyMask: maskSecret(next.dhlApiKey),
    fedexApiKeyMask: maskSecret(next.fedexApiKey),
    fedexApiSecretMask: maskSecret(next.fedexApiSecret),
    dhlApiKey: '',
    fedexApiKey: '',
    fedexApiSecret: ''
  };
}

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
  try { pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname; } catch (_) {}
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

function tokenMatches(candidate = '') {
  const supplied = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(apiToken);
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
  return cookieValue(req, apiSessionCookie);
}

function requestIsAuthorized(req) {
  return tokenMatches(requestToken(req));
}

function requestIsLoopback(req) {
  const address = String(req.socket?.remoteAddress || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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

function requireJsonContentType(req, pathname) {
  const jsonRoutes = new Set([
    '/api/save', '/api/open-attachment-folder', '/api/delete-attachments', '/api/attachments',
    '/api/open-url', '/api/ai-settings', '/api/ai-chat', '/api/api-status',
    '/api/tracking-settings', '/api/order-notification', '/api/backup-settings',
    '/api/subscriptions/save', '/api/subscriptions/delete', '/api/subscriptions/rate',
    '/api/subscriptions/options', '/api/export-file', '/api/backup-preview', '/api/restore-backup', '/api/check-attachments'
  ]);
  if (req.method !== 'POST' || !jsonRoutes.has(pathname)) return;
  const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw httpError(415, 'Content-Type must be application/json');
}

function sessionCookieHeader() {
  return `${apiSessionCookie}=${encodeURIComponent(apiToken)}; HttpOnly; SameSite=Strict; Path=/`;
}

// 失败时错误上带 statusCode / retryAfter / timeout，给物流查询归类（限流、查不到、超时、未授权）用。
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
        let data = {};
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

let ecbRefreshPromise = null;
function refreshEcbHistoricalRates() {
  // 同一时间只下载一次：几个窗口同时打开、或者前端重试时，不重复拉整份 ECB 历史。
  if (ecbRefreshPromise) return ecbRefreshPromise;
  ecbRefreshPromise = (async () => {
    const xml = await requestText('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml', {
      headers:{ 'User-Agent':'TradeOrderSystem/3.56' }
    });
    const rates = parseEcbHistoricalRates(xml);
    if (!rates.length) throw new Error('ECB 未返回历史汇率');
    const payload = { source:'European Central Bank', updatedAt:new Date().toISOString(), rates };
    atomicWrite(ecbExchangeCacheFile, JSON.stringify(payload));
    return payload;
  })().finally(() => { ecbRefreshPromise = null; });
  return ecbRefreshPromise;
}

async function queryEcbHistoricalRates() {
  const cached = fs.existsSync(ecbExchangeCacheFile) ? (() => {
    try { return readJson(ecbExchangeCacheFile); } catch (_) { return null; }
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

function aiChatEndpoint(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  return /\/chat\/completions$/.test(clean) ? clean : `${clean}/chat/completions`;
}

function boundedAiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  if (messages.length > 64) throw httpError(400, 'too many AI messages');
  return messages.map(message => {
    const role = String(message?.role || 'user');
    const content = String(message?.content || '');
    if (content.length > 200000) throw httpError(400, 'AI message is too large');
    return { ...message, role, content };
  });
}

async function queryAiChat(body = {}) {
  const settings = readAiSettings();
  const apiKey = process.env.AI_API_KEY || readAiApiKey();
  if (settings.enabled !== '是') return { ok: false, message: 'AI 识别未启用。' };
  if (!apiKey) return { ok: false, message: 'AI API Key 未保存。' };
  if (!settings.baseUrl || !settings.model) return { ok: false, message: 'AI Base URL 或模型名称未设置。' };
  // 先在本地检查消息：太长 / 太多条时直接回中文提示，不调用上游，也不记一条「请求失败」的费用记录。
  let messages;
  try {
    messages = boundedAiMessages(body.messages);
  } catch (error) {
    const tooLarge = /too large/i.test(String(error?.message || ''));
    return { ok: false, status: 413, message: tooLarge ? '粘贴内容太长：AI 一次最多读 20 万字，请只粘贴和这笔订单有关的部分。' : '一次发给 AI 的消息太多。' };
  }
  let response, requestError;
  const startedAt = Date.now();
  try {
    response = await requestJsonResponse(aiChatEndpoint(settings.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      timeout: body.testOnly ? 20000 : 45000,
      body: JSON.stringify({
        model: settings.model,
        messages,
        // 智谱和 DeepSeek 官方接口都关掉深度思考：识别只要字段，思考会拖慢速度并占用输出额度
        thinking: settings.provider === 'zhipu' || new URL(settings.baseUrl).hostname === 'api.deepseek.com' ? { type: 'disabled' } : undefined,
        reasoning: new URL(settings.baseUrl).hostname === 'openrouter.ai' && settings.model === 'deepseek/deepseek-v4.1-flash' ? { enabled: false } : undefined,
        // DeepSeek 官方接口支持 JSON 模式：识别请求强制返回 JSON 对象，测试连接不用
        response_format: !body.testOnly && new URL(settings.baseUrl).hostname === 'api.deepseek.com' ? { type: 'json_object' } : undefined,
        max_tokens: body.testOnly ? 256 : 1024,
        temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0
      })
    });
  } catch (error) {
    requestError = error;
  }
  let accountingWarning = '';
  try {
    aiUsageStore.record({
      baseUrl:settings.baseUrl, model:settings.model, purpose:body.purpose, testOnly:body.testOnly,
      durationMs:Date.now() - startedAt,
      status:!requestError && response.status >= 200 && response.status < 300 && !response.data?.error ? 'success' : 'failed',
      data:response?.data
    });
  } catch (_) {
    accountingWarning = '本次 AI 费用记录失败，请检查设置中的费用记录。';
  }
  if (requestError) {
    const message = /timeout/i.test(String(requestError?.message || ''))
      ? 'AI 请求超时，请减少粘贴内容后重试，或稍后再试。'
      : `AI 请求失败：${requestError?.message || '未知错误'}`;
    return { ok: false, message, ...(accountingWarning ? { accountingWarning } : {}) };
  }
  // 有的中转接口出错也回 200，只在正文里放 error：同样当失败处理（费用记录那边已经这么算）。
  if (response.status < 200 || response.status >= 300 || response.data?.error) {
    const error = (typeof response.data.error === 'object' && response.data.error) || response.data.errors?.[0] || {};
    if (typeof response.data.error === 'string') error.message = response.data.error;
    return { ok: false, status: response.status, message: error.message || response.data.message || `AI 接口 HTTP ${response.status}`, ...(accountingWarning ? { accountingWarning } : {}) };
  }
  return { ok: true, ...response.data, ...(accountingWarning ? { accountingWarning } : {}) };
}

function trackingCarrierStatusPatch(carrier, message, checkedAt = new Date().toISOString()) {
  return carrier === 'FedEx'
    ? { lastFedexCheckedAt: checkedAt, lastFedexStatus: message }
    : { lastDhlCheckedAt: checkedAt, lastDhlStatus: message };
}

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

async function checkAiApiStatus() {
  const settings = readAiSettings();
  if (settings.enabled !== '是') return { ok: false, disabled: true, label: 'AI', message: 'AI 识别未开启' };
  if (!(process.env.AI_API_KEY || readAiApiKey())) return { ok: false, disabled: true, label: 'AI', message: 'AI API Key 未保存' };
  const checkedAt = new Date().toISOString();
  const result = await queryAiChat({
    testOnly: true,
    temperature: 0,
    messages: [{ role: 'user', content: 'ping' }]
  });
  return result.ok
    ? { ok: true, label: 'AI', checkedAt, message: 'AI API 可连接', ...(result.accountingWarning ? {accountingWarning:result.accountingWarning} : {}) }
    : { ok: false, label: 'AI', checkedAt, message: result.message || 'AI 检测失败', ...(result.accountingWarning ? {accountingWarning:result.accountingWarning} : {}) };
}

async function checkApiStatus(kind) {
  if (kind === 'dhl') return checkDhlApiStatus();
  if (kind === 'fedex') return checkFedExApiStatus();
  if (kind === 'ai') return checkAiApiStatus();
  const results = await Promise.all([checkDhlApiStatus(), checkFedExApiStatus(), checkAiApiStatus()]);
  return { ok: results.every(item => item.ok), results };
}

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

async function queryFedExTracking(number) {
  const settings = readTrackingSettings();
  if (settings.fedexApiEnabled !== '是') {
    return { ok: false, status: '待 API 查询', message: 'FedEx API 未开启。' };
  }
  let token = '';
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

function parseBocUsdSellRate(html) {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    if (!row.includes('美元')) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match =>
      match[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    );
    const sell = Number(cells[3]);
    if (!Number.isFinite(sell) || sell <= 0) continue;
    return { rate: sell / 100, rateTime: [cells[6], cells[7]].filter(Boolean).join(' '), rawSell: sell };
  }
  return null;
}

function hasCaptcha(text) {
  return /验证码|captcha|安全验证|请输入验证码|unusual traffic/i.test(String(text || ''));
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function queryBaiduUsdCnyRate() {
  const html = await requestText('https://www.baidu.com/s?wd=1%E7%BE%8E%E5%85%83%E7%AD%89%E4%BA%8E%E5%A4%9A%E5%B0%91%E4%BA%BA%E6%B0%91%E5%B8%81', {
    headers: {
      'User-Agent': 'Mozilla/5.0 TradeOrderSystem/1.0',
      Accept: 'text/html,application/xhtml+xml'
    }
  });
  if (hasCaptcha(html)) throw new Error('百度汇率页面需要验证码');
  const text = decodeHtmlEntities(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const patterns = [
    /1\s*美元[^0-9]{0,30}([0-9]\.\d{2,5})\s*人民币/,
    /美元[^0-9]{0,30}人民币[^0-9]{0,30}([0-9]\.\d{2,5})/,
    /人民币[^0-9]{0,30}([0-9]\.\d{2,5})/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const rate = Number(match?.[1]);
    if (Number.isFinite(rate) && rate > 5 && rate < 9) {
      return {
        rate,
        rateTime: new Date().toISOString().slice(0, 16).replace('T', ' '),
        rawSell: rate * 100,
        source: '百度实时美元汇率',
        date: new Date().toISOString().slice(0, 10),
        fallbackFromBaidu: true
      };
    }
  }
  throw new Error('未读取到百度美元人民币汇率');
}

async function queryBocRate(dateText) {
  const params = new URLSearchParams({ erectDate: dateText, nothing: dateText, pjname: '美元', page: '1' });
  let bocBlocked = false;
  try {
    const html = await requestText(`https://srh.bankofchina.com/search/whpj/search_cn.jsp?${params.toString()}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 TradeOrderSystem/1.0' }
    });
    bocBlocked = hasCaptcha(html);
    const data = parseBocUsdSellRate(html);
    if (data) return { ...data, source: '中国银行历史牌价网页', date: dateText };
  } catch (_) {}
  try {
    const baidu = await queryBaiduUsdCnyRate();
    return { ...baidu, bocCaptcha: bocBlocked, requestedBocDate: dateText };
  } catch (_) {}
  const currentHtml = await requestText('https://www.bankofchina.com/sourcedb/whpj/index.html', {
    headers: { 'User-Agent': 'Mozilla/5.0 TradeOrderSystem/1.0' }
  });
  const current = parseBocUsdSellRate(currentHtml);
  if (!current) throw new Error('未读取到中国银行美元现汇卖出价');
  return { ...current, source: '中国银行当前牌价网页', date: current.rateTime.split(' ')[0] || dateText, fallbackFromCurrent: true, bocCaptcha: bocBlocked };
}

ensureStorage();
migrateLegacyAiApiKey();
try { migrateLegacyTrackingSecrets(); } catch (error) {
  console.error(`Tracking credential migration skipped: ${error.message}`);
}
initializeStorage();
cleanupOrphanAttachments();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    validateHost(req);
    validateOrigin(req);
    const isAppDocument = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-order-system.html');
    if (isAppDocument && url.searchParams.has('token')) {
      if (!tokenMatches(url.searchParams.get('token'))) throw httpError(401, 'invalid API session token');
      const redirectTarget = new URL('/trade-order-system.html', `http://127.0.0.1:${port}`);
      for (const [key, value] of url.searchParams) {
        if (key !== 'token') redirectTarget.searchParams.append(key, value);
      }
      return send(res, 303, '', 'text/plain; charset=utf-8', {
        Location: `${redirectTarget.pathname}${redirectTarget.search}#dashboard`,
        'Set-Cookie': sessionCookieHeader()
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const integrity = storageMode === 'sqlite' ? recentDatabaseIntegrity() : { ok: false, message: storageError || storageMode };
      const authorized = requestIsAuthorized(req);
      const health = {
        ok: integrity.ok,
        instanceNonce,
        appUpdatedAt,
        storageMode,
        storageRevision
      };
      if (authorized) {
        Object.assign(health, {
          storageError,
          integrity,
          dataFile: storageMode === 'sqlite' ? databaseFile : dataFile,
          legacyJsonFile: fs.existsSync(dataFile) ? dataFile : '',
          backupDir,
          backups: backupSummary(),
          counts: integrity.ok ? databaseCounts() : null,
          migration: storageMode === 'sqlite' ? {
            migratedAt: metadataValue('migrated_at', ''),
            source: metadataValue('migration_source', ''),
            archive: metadataValue('migration_archive', ''),
            counts: metadataValue('migration_counts', '')
          } : null
        });
      } else {
        health.integrity = { ok: integrity.ok, message: integrity.ok ? 'ok' : 'storage unavailable' };
      }
      return send(res, integrity.ok ? 200 : 500, JSON.stringify(health));
    }
    if (!requestIsAuthorized(req)) throw httpError(401, 'API session token required');
    requireJsonContentType(req, url.pathname);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-order-system.html')) {
      return send(res, 200, fs.readFileSync(htmlFile), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/attachments/')) {
      ensureStorage();
      let relative = '';
      try { relative = decodeURIComponent(url.pathname.replace(/^\/attachments\//, '')); } catch (_) { throw httpError(400, 'invalid attachment path'); }
      const target = path.resolve(attachmentsDir, relative);
      const root = path.resolve(attachmentsDir);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return send(res, 404, JSON.stringify({ ok: false, message: 'attachment not found' }));
      }
      const ext = path.extname(target).toLowerCase();
      const type = ext === '.avif' ? 'image/avif' : ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
      return send(res, 200, fs.readFileSync(target), type);
    }
    if (req.method === 'GET' && url.pathname === '/api/data') {
      ensureStorage();
      return send(res, 200, JSON.stringify({ ...readCurrentPayload(), revision: storageRevision }));
    }
    if (req.method === 'GET' && url.pathname === '/api/whatsapp/messages') {
      if (!database || storageMode !== 'sqlite') throw httpError(503, '聊天数据库暂不可用');
      const result = createWhatsAppStore(database).messages({
        customer:url.searchParams.get('customer'), before:url.searchParams.get('before'), limit:50
      });
      return send(res, 200, JSON.stringify(result));
    }
    if (req.method === 'POST' && url.pathname === '/api/save') {
      const requestPayload = await readJsonBody(req);
      const payload = requestPayload && requestPayload.state && typeof requestPayload.state === 'object'
        ? requestPayload.state
        : requestPayload;
      const baseRevision = requestPayload?.baseRevision ?? payload?.baseRevision;
      ensureStorage();
      const result = saveCurrentPayload(payload, { baseRevision, customerMoves:requestPayload?.customerMoves, customerDeletes:requestPayload?.customerDeletes, customerInference:requestPayload?.customerInference !== false });
      let backup;
      try { backup = createBackup(false); } catch (error) {
        backup = { ok: false, message: error.message || 'automatic backup failed' };
      }
      return send(res, 200, JSON.stringify({ ok: true, storageMode, ...result, backup }));
    }
    if (req.method === 'GET' && url.pathname === '/api/subscriptions') {
      return send(res, 200, JSON.stringify(subscriptionStore().list()));
    }
    if (req.method === 'POST' && url.pathname === '/api/subscriptions/save') {
      const body = await readJsonBody(req);
      // baseUpdatedAt / restore travel next to the item; the store checks them for edits made elsewhere meanwhile.
      const item = body.item && typeof body.item === 'object' && !Array.isArray(body.item) ? { ...body.item } : body.item;
      if (item && typeof item === 'object') {
        delete item.baseUpdatedAt;
        delete item.restore;
        if (typeof body.baseUpdatedAt === 'string') item.baseUpdatedAt = body.baseUpdatedAt;
        if (body.restore === true) item.restore = true;
      }
      const result = subscriptionStore().save(item);
      return send(res, 200, JSON.stringify({ ...result, backup: automaticBackup() }));
    }
    if (req.method === 'POST' && url.pathname === '/api/subscriptions/delete') {
      const body = await readJsonBody(req);
      const result = subscriptionStore().remove(body);
      return send(res, 200, JSON.stringify({ ...result, backup: automaticBackup() }));
    }
    if (req.method === 'POST' && url.pathname === '/api/subscriptions/rate') {
      const body = await readJsonBody(req);
      const result = subscriptionStore().setRate(body);
      return send(res, 200, JSON.stringify({ ...result, backup: automaticBackup() }));
    }
    if (req.method === 'POST' && url.pathname === '/api/subscriptions/options') {
      const body = await readJsonBody(req);
      const result = subscriptionStore().setOptions(body);
      return send(res, 200, JSON.stringify({ ...result, backup: automaticBackup() }));
    }
    if (req.method === 'POST' && url.pathname === '/api/order-notification') {
      const body = await readJsonBody(req);
      return send(res, 200, JSON.stringify(await sendOrderNotification(body.orderId)));
    }
    if (req.method === 'GET' && url.pathname === '/api/order-notification') {
      return send(res, 200, JSON.stringify(orderNotificationStatus(url.searchParams.get('orderId'))));
    }
    if (req.method === 'GET' && url.pathname === '/api/feishu-settings') {
      return send(res, 200, JSON.stringify(publicFeishuStatus()));
    }
    if (req.method === 'POST' && url.pathname === '/api/feishu-settings') {
      const body = await readJsonBody(req);
      writeFeishuSettings(feishuSettingsFile, {
        profile: typeof body.profile === 'string' ? body.profile : '',
        chatName: typeof body.chatName === 'string' ? body.chatName : '',
        chatId: typeof body.chatId === 'string' ? body.chatId : '',
        cliPath: typeof body.cliPath === 'string' ? body.cliPath : undefined
      });
      return send(res, 200, JSON.stringify(publicFeishuStatus()));
    }
    if (req.method === 'POST' && url.pathname === '/api/feishu-test') {
      await readJsonBody(req, {});
      try {
        return send(res, 200, JSON.stringify(await sendFeishuTestMessage()));
      } catch (error) {
        return send(res, 200, JSON.stringify({ ok: false, message: error.larkKind ? error.message : larkFailureText.generic, errorKind: error.larkKind || 'generic' }));
      }
    }
    // 合并 / 删除客户、导入、恢复示例前由页面调用：不受「一小时一次」限制，备份的是操作前的数据（页面先把手上的修改存完再调用）。
    if (req.method === 'POST' && url.pathname === '/api/backup-before-change') {
      const body = await readJsonBody(req, {});
      const reason = backupReasons.includes(body.reason) ? body.reason : 'change';
      const result = createBackup(true, { reason });
      return send(res, result.ok ? 200 : 503, JSON.stringify(result));
    }
    if (req.method === 'GET' && url.pathname === '/api/backups') {
      return send(res, 200, JSON.stringify(listBackups()));
    }
    if (req.method === 'POST' && url.pathname === '/api/backup-preview') {
      const body = await readJsonBody(req);
      return send(res, 200, JSON.stringify(backupPreview(body.name)));
    }
    if (req.method === 'POST' && url.pathname === '/api/restore-backup') {
      const body = await readJsonBody(req);
      return send(res, 200, JSON.stringify(restoreFromBackup(body.name)));
    }
    if (req.method === 'POST' && url.pathname === '/api/check-attachments') {
      const body = await readJsonBody(req);
      return send(res, 200, JSON.stringify(checkAttachmentUrls(body.urls)));
    }
    if (req.method === 'POST' && url.pathname === '/api/manual-backup') {
      const result = createBackup(true);
      return send(res, result.ok ? 200 : 503, JSON.stringify(result));
    }
    if (req.method === 'GET' && url.pathname === '/api/backup-settings') {
      return send(res, 200, JSON.stringify(backupSummary()));
    }
    if (req.method === 'POST' && url.pathname === '/api/backup-settings') {
      const body = await readJsonBody(req, {});
      return send(res, 200, JSON.stringify(setBackupDir(body.backupDir)));
    }
    if (req.method === 'POST' && url.pathname === '/api/choose-backup-folder') {
      const picked = await chooseBackupFolder();
      if (!picked.ok) return send(res, 200, JSON.stringify(picked));
      return send(res, 200, JSON.stringify(setBackupDir(picked.path)));
    }
    if (req.method === 'POST' && url.pathname === '/api/export-file') {
      const body = await readJsonBody(req);
      return send(res, 200, JSON.stringify(writeExportFile(body.name, body.text)));
    }
    if (req.method === 'POST' && url.pathname === '/api/open-data-folder') {
      ensureStorage();
      spawn('/usr/bin/open', [supportDir], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, JSON.stringify({ ok: true, path: supportDir }));
    }
    if (req.method === 'POST' && url.pathname === '/api/open-attachment-folder') {
      ensureStorage();
      const body = await readJsonBody(req);
      const target = attachmentTargetFromUrl(body.fileUrl);
      const folder = fs.existsSync(target) ? path.dirname(target) : path.dirname(target);
      if (!folder.startsWith(path.resolve(attachmentsDir) + path.sep)) {
        return send(res, 400, JSON.stringify({ ok: false, message: 'unsupported folder' }));
      }
      spawn('/usr/bin/open', [folder], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, JSON.stringify({ ok: true, path: folder }));
    }
    if (req.method === 'POST' && url.pathname === '/api/delete-attachments') {
      ensureStorage();
      const body = await readJsonBody(req);
      const urls = Array.isArray(body.urls) ? body.urls : [];
      // If a retained backup cannot be read, fail closed rather than delete its images.
      const protectedRefs = retainedAttachmentRefs();
      let deleted = 0;
      urls.forEach(item => {
        try {
          const target = attachmentTargetFromUrl(item);
          if (!protectedRefs.has(target) && fs.existsSync(target)) {
            fs.unlinkSync(target);
            deleted += 1;
          }
        } catch (_) {}
      });
      return send(res, 200, JSON.stringify({ ok: true, deleted }));
    }
    if (req.method === 'POST' && url.pathname === '/api/attachments') {
      const body = await readJsonBody(req);
      return send(res, 200, JSON.stringify(await saveAttachmentImage(body)));
    }
    if (req.method === 'POST' && url.pathname === '/api/open-url') {
      const body = await readJsonBody(req);
      const target = String(body.url || '');
      let parsed;
      try { parsed = new URL(target); } catch (_) { return send(res, 400, JSON.stringify({ ok: false, message: 'unsupported url' })); }
      if (parsed.protocol !== 'https:' || !isAllowedTrackingHost(parsed.hostname)) {
        return send(res, 400, JSON.stringify({ ok: false, message: 'unsupported url' }));
      }
      await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/open', [target], { stdio: 'ignore' });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`open exited ${code}`)));
      });
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (req.method === 'GET' && url.pathname === '/api/track') {
      const number = cleanTracking(url.searchParams.get('number'));
      const carrier = url.searchParams.get('carrier') || detectCarrier(number);
      if (!number) return send(res, 400, JSON.stringify({ ok: false, message: 'missing tracking number' }));
      let result;
      try {
        result = carrier === 'UPS'
          ? { ok: false, online: '官网', status: '待官网查询', message: 'UPS 单号已识别，请打开 UPS 官网查询实时轨迹。' }
          : carrier === 'FedEx' ? await queryFedExTracking(number) : await queryDhlTracking(number);
      } catch (error) {
        // 失败带归类代码：前端据此不覆盖上一次成功的结果、自动更新遇到限流就停掉这家。
        result = { ok: false, status: '待 API 查询', code: error.code || 'error', message: error.message || '物流查询失败，请检查 API 设置' };
        if (error.retryAfter) result.retryAfter = error.retryAfter;
      }
      return send(res, 200, JSON.stringify({ carrier, number, checkedAt: new Date().toISOString(), ...result }));
    }
    if (req.method === 'GET' && url.pathname === '/api/tracking-settings') {
      const settings = readTrackingSettings();
      return send(res, 200, JSON.stringify({
        ...settings,
        dhlApiKeySaved: Boolean(settings.dhlApiKey),
        fedexApiKeySaved: Boolean(settings.fedexApiKey),
        fedexApiSecretSaved: Boolean(settings.fedexApiSecret),
        dhlApiKeyMask: maskSecret(settings.dhlApiKey),
        fedexApiKeyMask: maskSecret(settings.fedexApiKey),
        fedexApiSecretMask: maskSecret(settings.fedexApiSecret),
        dhlApiKey: '',
        fedexApiKey: '',
        fedexApiSecret: ''
      }));
    }
    if (req.method === 'GET' && url.pathname === '/api/ai-settings') {
      return send(res, 200, JSON.stringify(publicAiSettings()));
    }
    if (req.method === 'GET' && url.pathname === '/api/ai-usage') {
      try {
        return send(res, 200, JSON.stringify({ ok:true, ...aiUsageStore.read({page:url.searchParams.get('page'),model:url.searchParams.get('model') || '',endpointHost:url.searchParams.get('host') || ''}) }));
      } catch (_) {
        return send(res, 200, JSON.stringify({ ok:false, message:'AI 费用记录无法读取，原始记录已保留。' }));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/ai-settings') {
      const body = await readJsonBody(req);
      return send(res, 200, JSON.stringify(writeAiSettings(body)));
    }
    if (req.method === 'POST' && url.pathname === '/api/ai-chat') {
      const body = await readJsonBody(req);
      return send(res, 200, JSON.stringify(await queryAiChat(body)));
    }
    if (req.method === 'POST' && url.pathname === '/api/api-status') {
      const body = await readJsonBody(req, {});
      if (body.kind !== undefined && typeof body.kind !== 'string') throw httpError(400, 'kind 必须是文字');
      return send(res, 200, JSON.stringify(await checkApiStatus(String(body.kind || 'all'))));
    }
    if (req.method === 'POST' && url.pathname === '/api/tracking-settings') {
      const body = await readJsonBody(req);
      const current = readTrackingSettings();
      const next = { ...body };
      if (!String(next.dhlApiKey || '').trim() && current.dhlApiKey) next.dhlApiKey = current.dhlApiKey;
      if (!String(next.fedexApiKey || '').trim() && current.fedexApiKey) next.fedexApiKey = current.fedexApiKey;
      if (!String(next.fedexApiSecret || '').trim() && current.fedexApiSecret) next.fedexApiSecret = current.fedexApiSecret;
      return send(res, 200, JSON.stringify(writeTrackingSettings(next)));
    }
    if (req.method === 'GET' && url.pathname === '/api/exchange-rate') {
      const date = url.searchParams.get('date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return send(res, 400, JSON.stringify({ ok: false, message: 'invalid date' }));
      const result = await queryBocRate(date);
      return send(res, 200, JSON.stringify({ ok: true, requestedDate: date, ...result }));
    }
    if (req.method === 'GET' && url.pathname === '/api/ecb-rates') {
      const result = await queryEcbHistoricalRates();
      return send(res, 200, JSON.stringify({ ok:true, ...result }));
    }
    return send(res, 404, JSON.stringify({ ok: false, message: 'not found' }));
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    return send(res, status, JSON.stringify({
      ok: false,
      message: error.message || 'internal server error',
      ...(error.publicDetails && typeof error.publicDetails === 'object' ? error.publicDetails : {}),
      ...(Number.isInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {})
    }), 'application/json; charset=utf-8', status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
  }
});

server.listen(port, '127.0.0.1', () => {
  const target = `http://127.0.0.1:${port}/trade-order-system.html?token=${encodeURIComponent(apiToken)}#dashboard`;
  if (process.env.TRADE_APP_NO_OPEN !== '1') {
    spawn('/usr/bin/open', [target], { detached: true, stdio: 'ignore' }).unref();
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  // Saves are synchronous, so the database can be checkpointed right away; a request still being
  // received must not keep the WAL open until the host kills the process.
  let exitCode = 0;
  try {
    if (database) {
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      database.close();
      database = null;
    }
  } catch (error) {
    exitCode = 1;
    console.error(`Storage shutdown failed after ${signal}: ${error.message || error}`);
  }
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(exitCode);
  });
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 1000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
