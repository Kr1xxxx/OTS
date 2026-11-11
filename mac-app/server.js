const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createWhatsAppStore, renameWhatsAppCustomer, moveWhatsAppChats } = require('./whatsapp-store');
const { createAiUsageStore } = require('./ai-usage-store');
const { createSubscriptionStore } = require('./subscription-store');
const { readFeishuSettings, writeFeishuSettings } = require('./feishu-settings');
const { createAttachmentCopier } = require('./backup-attachments');
const { createCarrierTracking, cleanTracking, detectCarrier } = require('./carrier-tracking');
const { httpError } = require('./http-error');
const { createFeishuNotifier, deliveryPublicFields, larkFailureText } = require('./feishu-notify');
const { createAiChat } = require('./ai-chat');
const { atomicWrite, readJson } = require('./file-store');
const { createRequestGuard, send, readJsonBody, validateFetchSite, requireJsonContentType } = require('./request-guard');
const { createAppSettings, aiSettingLimits, trackingSettingLimits, assertSettingFields, assertAutoRunTimes, maskSecret } = require('./app-settings');
const { createEcbRates } = require('./ecb-rates');

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
const aiUsageStore = createAiUsageStore({ file:path.join(supportDir, 'ai-usage.json'), atomicWrite });
const secretsDir = path.join(supportDir, 'secrets');
const tinifyApiKeyFile = path.join(secretsDir, 'tinypng-api-key');
const storageMarkerFile = path.join(supportDir, 'sqlite-storage.json');
const migrationErrorFile = path.join(supportDir, 'migration-error.json');
const feishuSettingsFile = path.join(supportDir, 'feishu-settings.json');
// 每次用到时重新读本机配置（16 KB 以内的小文件）：设置页保存、或手改文件后不用重启 App。
function feishuConfig() { return readFeishuSettings(feishuSettingsFile); }
const apiToken = String(process.env.TRADE_API_TOKEN || crypto.randomBytes(32).toString('base64url'));
const instanceNonce = String(process.env.TRADE_INSTANCE_NONCE || crypto.randomBytes(24).toString('base64url'));
const { tokenMatches, requestIsAuthorized, requestHasPageSession, validateHost, validateOrigin, sessionCookieHeader } = createRequestGuard({ port, apiToken });
const tinifyEndpoint = String(process.env.TRADE_TINIFY_ENDPOINT || 'https://api.tinify.com/shrink');
let database = null;
let storageMode = 'initializing';
let storageError = '';
let storageRevision = 0;
let integrityCache = null;
const integrityCacheMs = 5 * 60 * 1000;
const { sendOrderNotification, orderNotificationStatus, publicFeishuStatus, sendFeishuTestMessage } = createFeishuNotifier({
  currentDatabase:() => database, feishuConfig, attachmentTargetFromUrl, resourcesDir
});
const {
  readAiApiKey, migrateLegacyAiApiKey, publicAiSettings, readAiSettings, writeAiSettings,
  migrateLegacyTrackingSecrets, readTrackingSettings, writeTrackingSettings
} = createAppSettings({ supportDir, secretsDir, ensureStorage });
const { queryAiChat, checkAiApiStatus } = createAiChat({ readAiSettings, readAiApiKey:() => process.env.AI_API_KEY || readAiApiKey(), aiUsageStore });
const { checkDhlApiStatus, checkFedExApiStatus, queryDhlTracking, queryFedExTracking } = createCarrierTracking({ readTrackingSettings, writeTrackingSettings });

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
    openDetached(['-R', target]);
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

let backupSettingsLoaded = false;
function loadBackupSettingsOnce() {
  if (backupSettingsLoaded) return;
  backupSettingsLoaded = true;
  loadBackupSettings();
}

// 备份目录可以是用户自己选的文件夹（iCloud、网盘），里面可能有别的 .sqlite / .json：轮转、统计、清理附件只认 OTS 自己起的名字。
// 文件名：trade-order-data-<日期>-<时间>[-<本机数据库 id 前 6 位>][-before-<原因>][-<序号>].sqlite
// - 数据库 id：两台 Mac 把备份目录选到同一个 iCloud 文件夹时，轮转只删自己的，不删对方的（旧备份没有 id，按自己的算）。
// - 「-before-<原因>」：操作前强制生成的快照（合并 / 删除客户 change、导入 import、恢复示例 reset、从备份恢复 restore），
//   安装更新前（update）也强制备份一份。单独保留 90 天（至少最近 20 份），不参与日常轮转。
const backupReasons = ['change', 'import', 'reset', 'restore', 'update'];
const otsBackupFileName = /^trade-order-data-(\d{8})-(\d{6})(?:-([0-9a-f]{6}))?(?:-before-(change|import|reset|restore|update))?(?:-\d+)?\.(?:sqlite|json)$/;
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

// 附件的链接 / 文件地址：javascript:、vbscript:、file:、非图片的 data: 点开会在软件里执行或读本机文件，导入和接口写入时一律去掉。
// 普通备注（「发票在邮箱里」）和 http(s)、本机附件、图片地址照存；页面显示时还会再按 safeAttachmentHref 过一遍。
const unsafeAttachmentLinkPattern = /^[\s\u0000-\u001f]*(?:javascript|vbscript|file|data(?![\s\u0000-\u001f]*:[\s\u0000-\u001f]*image\/(?:png|jpe?g|webp|avif|gif)[;,]))[\s\u0000-\u001f]*:/i;
function stripUnsafeAttachmentLinks(order) {
  if (!order || typeof order !== 'object' || !Array.isArray(order.attachments)) return;
  order.attachments.forEach(item => {
    if (!item || typeof item !== 'object') return;
    ['link', 'fileUrl', 'thumbUrl'].forEach(key => {
      if (typeof item[key] === 'string' && unsafeAttachmentLinkPattern.test(item[key])) item[key] = '';
    });
  });
}

// 用 /usr/bin/open 打开文件夹 / 地址，不等它结束。spawn 失败（没有这个程序）只记一笔：以前没有 error 监听，整个服务会崩掉。
function openDetached(args) {
  const child = spawn('/usr/bin/open', args, { detached: true, stdio: 'ignore' });
  child.once('error', error => console.error(`open failed: ${error.code || error.message}`));
  child.unref();
}

function normalizeDataPayload(raw) {
  const wrapper = raw && raw.data && Array.isArray(raw.data.orders)
    ? raw
    : { app: 'trade-order-system', version: 'legacy', exportedAt: new Date().toISOString(), data: raw };
  const data = wrapper?.data;
  if (!data || !Array.isArray(data.orders)) throw httpError(400, '数据里没有订单列表（orders），没有保存');
  orderBuckets.forEach(key => {
    if (!Array.isArray(data[key])) data[key] = [];
  });
  if (!data.customers || typeof data.customers !== 'object' || Array.isArray(data.customers)) data.customers = {};
  if (!Array.isArray(data.trackingLookups)) data.trackingLookups = [];
  orderBuckets.forEach(key => data[key].forEach(stripUnsafeAttachmentLinks));
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

    -- Until V3.146 every save also copied each order's attachments and log lines into these two tables.
    -- Nothing ever read them: the order's own data_json is the record. An older version started on this
    -- database creates them again, empty, and carries on.
    DROP TABLE IF EXISTS order_attachments;
    DROP TABLE IF EXISTS order_logs;

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
function writeStateToDatabase(rawPayload, { migration = false, baseRevision, saveId = '', customerMoves: explicitMoves = [], customerDeletes = [], customerInference = true } = {}) {
  if (!database) throw new Error('SQLite database is not available');
  // 同一次保存的编号（页面重试时不变）：上一次其实已经写进去、只是响应在路上丢了，重试直接回那次的结果，
  // 不再拿旧版本号去比、得到 409，让只有一个窗口的人看到「另一个窗口刚保存过数据」。
  const requestSaveId = typeof saveId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(saveId) ? saveId : '';
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
  const orderDelete = database.prepare('DELETE FROM orders WHERE id = ?');
  const customerDelete = database.prepare('DELETE FROM customers WHERE name = ?');
  const lookupDelete = database.prepare('DELETE FROM tracking_lookups WHERE id = ?');
  const appStateGet = database.prepare('SELECT data_json FROM app_state WHERE key = ?');
  const appStateDelete = database.prepare('DELETE FROM app_state WHERE key = ?');

  database.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = Number(metadataValue('revision', '0'));
    if (!migration && requestSaveId && metadataValue('last_save_id', '') === requestSaveId) {
      let previous = {};
      try { previous = JSON.parse(metadataValue('last_save_result', '{}')) || {}; } catch (_) { previous = {}; }
      database.exec('COMMIT');
      storageRevision = currentRevision;
      return { ...previous, revision: Number(previous.revision) || currentRevision, duplicate: true };
    }
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
    const result = { revision: nextRevision, counts: actual, ...(movedChats.length ? { movedChats } : {}) };
    if (!migration) {
      setMetadata('last_save_id', requestSaveId);
      setMetadata('last_save_result', requestSaveId ? JSON.stringify(result) : '');
    }
    database.exec('COMMIT');
    storageRevision = nextRevision;
    return result;
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

// 版本号以数据库里的为准：同一个数据目录被第二个服务进程写过时，本进程内存里的数字是旧的，
// 页面拿着旧版本号保存会一直 409，重新加载也出不来。
function currentStorageRevision() {
  if (storageMode !== 'sqlite' || !database) return storageRevision;
  try {
    const revision = Number(metadataValue('revision', String(storageRevision)));
    if (Number.isSafeInteger(revision)) storageRevision = revision;
  } catch (_) {}
  return storageRevision;
}

// 数据和版本号在同一个读事务里取：两者对得上。
function readCurrentPayloadWithRevision() {
  if (storageMode !== 'sqlite' || !database) return { ...readCurrentPayload(), revision: storageRevision };
  database.exec('BEGIN');
  try {
    const payload = readCurrentPayload();
    const revision = currentStorageRevision();
    database.exec('COMMIT');
    return { ...payload, revision };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

// 常见的存储错误说成人话（以前直接回英文原文「database or disk is full」）。code 给页面区分原因。
function friendlySaveError(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  if (/SQLITE_FULL|disk is full|ENOSPC/i.test(text)) return { code: 'disk-full', message: 'Mac 磁盘空间不足，数据没有存进去。清理出空间后会自动继续保存。' };
  if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(text)) return { code: 'db-busy', message: '数据库正被其他程序占用，稍后会自动重试。' };
  if (/EACCES|EPERM|SQLITE_READONLY|readonly database/i.test(text)) return { code: 'no-permission', message: '没有权限写入数据目录，请检查文件夹权限。' };
  return null;
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
  // 页面只送来本机压缩过的图（原图不落盘）；配了 TinyPNG 再压一遍，结果更大就留本机压缩版。
  const tinified = await optimizeAttachmentWithTinify(sourceImage);
  const image = tinified.optimized && tinified.buffer.length >= sourceImage.buffer.length
    ? { ...sourceImage, optimized: false, fallback: false, compressionCount: tinified.compressionCount }
    : tinified;
  const locallyCompressed = body.compressed === true;
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
    optimizer: image.optimized ? 'TinyPNG' : locallyCompressed ? '本机压缩' : '本地原图',
    compressed: locallyCompressed || image.optimized,
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
  let data;
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
// The newest earlier backup of this database that has an attachments folder: what the next backup can share files with.
function previousBackupAttachmentsDir(tag = '') {
  const own = fs.readdirSync(backupDir).map(parseBackupName)
    .filter(item => item && item.name.endsWith('.sqlite') && (!item.tag || !tag || item.tag === tag))
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  for (const item of own) {
    const dir = path.join(backupDir, item.name) + '.attachments';
    if (fs.existsSync(dir)) return dir;
  }
  return '';
}
// A backup interrupted halfway (the app was force-quit, the disk went away) leaves its staging files behind; nothing reads them.
function removeStaleBackupStaging(now = Date.now()) {
  for (const name of fs.readdirSync(backupDir)) {
    const base = name.replace(/\.partial(\.attachments)?$/, '');
    if (base === name || !isOtsBackupFile(base)) continue;
    const file = path.join(backupDir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > 60 * 60 * 1000) fs.rmSync(file, { recursive:true, force:true });
    } catch (_) {}
  }
}
// Each backup has its own complete attachments folder; a file the previous backup already holds is shared with it, not written again (see backup-attachments.js).
function copyBackupAttachments(backupFile, previousDir = '') {
  const dir = backupFile + '.attachments';
  fs.mkdirSync(dir, { recursive:true, mode:0o700 });
  const copier = createAttachmentCopier({ previous: relative => previousDir ? path.join(previousDir, relative) : '' });
  for (const source of backupAttachmentRefs(backupFile)) {
    const relative = path.relative(attachmentsDir, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid backup attachment path');
    // 本机没有的附件（换电脑后导入的数据文件、被清理过的旧图）记在 missing 清单里，不拖垮整份备份。
    if (!fs.existsSync(source)) continue;
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive:true, mode:0o700 });
    copier.place(source, target, relative);
  }
  return copier.counts;
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
  try { removeStaleBackupStaging(now); } catch (_) {}
  database.exec('PRAGMA wal_checkpoint(FULL)');
  const quoted = stagingFile.replaceAll("'", "''");
  let attachmentCopies;
  try {
    const previousDir = previousBackupAttachmentsDir(tag);
    database.exec(`VACUUM INTO '${quoted}'`);
    fs.chmodSync(stagingFile, 0o600);
    attachmentCopies = copyBackupAttachments(stagingFile, previousDir);
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
    ok:true, file:backupFile, name:backupName, attachmentsDir:backupFile + '.attachments',
    attachmentCount:attachmentCopies.cloned + attachmentCopies.linked + attachmentCopies.copied, attachmentCopies, rotated,
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

function isAllowedTrackingHost(hostname = '') {
  const host = String(hostname).toLowerCase();
  // 和前端 carrierDefs 的官网一一对应：UPS 单号查不了 API，只能打开官网，以前漏了 ups.com，Mac App 里点「官网查询」没反应。
  return ['dhl.com', 'fedex.com', 'ups.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
}

const { queryEcbHistoricalRates } = createEcbRates({ cacheFile:path.join(supportDir, 'exchange-rates-cache.json') });

async function checkApiStatus(kind) {
  if (kind === 'dhl') return checkDhlApiStatus();
  if (kind === 'fedex') return checkFedExApiStatus();
  if (kind === 'ai') return checkAiApiStatus();
  const results = await Promise.all([checkDhlApiStatus(), checkFedExApiStatus(), checkAiApiStatus()]);
  return { ok: results.every(item => item.ok), results };
}

// 单实例锁：同一个数据目录只允许一个服务进程（DMG 里再开一份、两个 App 同时开时，两份服务轮流写同一个库，保存永远冲突）。
// - 锁文件记 pid；持有者已经不在（或不是本服务）→ 过期锁，接管；
// - 持有者的父进程已经没了（App 被强制退出或崩溃后留下的孤儿服务，还占着端口和数据库）→ 先结束它，再接管；
// - 持有者好好地挂在另一个 App 下 → 不启动，退出码 75，Mac 壳据此提示「另一个窗口正在使用」而不是换端口重试。
const instanceLockFile = path.join(supportDir, 'server.lock');
const instanceLockExitCode = 75;
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function processInfo(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding:'utf8', stdio:['ignore', 'pipe', 'ignore'], timeout:3000 }).trim();
    const match = /^(\d+)\s+(.*)$/s.exec(out);
    return match ? { ppid:Number(match[1]), command:match[2] } : null;
  } catch (_) { return null; }
}
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function acquireInstanceLock() {
  fs.mkdirSync(supportDir, { recursive:true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const fd = fs.openSync(instanceLockFile, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid:process.pid, ppid:process.ppid, port, startedAt:new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(instanceLockFile, 'utf8')); } catch (_) {}
    const pid = Number(holder?.pid);
    const info = Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid) ? processInfo(pid) : null;
    if (!info || !/server\.js/.test(info.command)) {
      // 新写的锁可能还没写完：读不出内容时稍等再看，别把正在启动的那一份当成过期锁。
      if (!holder && attempt === 0) { sleepSync(200); continue; }
      fs.rmSync(instanceLockFile, { force:true });
      continue;
    }
    // 孤儿：父进程没了，被系统改挂到 launchd（或容器里的收养进程）下，父进程号已经不是上锁时那个。
    if (info.ppid === 1 || (Number(holder?.ppid) > 0 && info.ppid !== Number(holder.ppid))) {
      console.error(`Stopping orphaned server ${pid} that still holds ${supportDir}`);
      try { process.kill(pid, 'SIGTERM'); } catch (_) {}
      for (let i = 0; i < 60 && processAlive(pid); i += 1) sleepSync(100);
      if (processAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} sleepSync(200); }
      fs.rmSync(instanceLockFile, { force:true });
      continue;
    }
    break;
  }
  console.error(`另一个外贸订单跟进系统正在使用这份数据（${supportDir}）。请先退出另一个窗口，再打开这个。`);
  process.exit(instanceLockExitCode);
}
function releaseInstanceLock() {
  try {
    const holder = JSON.parse(fs.readFileSync(instanceLockFile, 'utf8'));
    if (holder.pid === process.pid) fs.rmSync(instanceLockFile, { force:true });
  } catch (_) {}
}
// TRADE_ALLOW_SHARED_DATA_DIR=1：只给回归测试用，验证锁被绕过时（例如旧版本还在跑）第二个进程也报数据库里的真实版本号。
if (process.env.TRADE_ALLOW_SHARED_DATA_DIR !== '1') {
  acquireInstanceLock();
  process.on('exit', releaseInstanceLock);
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
    validateFetchSite(req);
    const isAppDocument = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-order-system.html');
    if (isAppDocument && url.searchParams.has('token')) {
      if (!tokenMatches(url.searchParams.get('token'))) throw httpError(401, 'invalid API session token');
      const redirectTarget = new URL('/trade-order-system.html', `http://127.0.0.1:${port}`);
      for (const [key, value] of url.searchParams) {
        if (key !== 'token') redirectTarget.searchParams.append(key, value);
      }
      // 令牌放在地址的 # 后面交给页面：# 后的内容不会发给服务器、也不进 Referer；页面读出后存进 sessionStorage，再把地址换回 #dashboard。
      return send(res, 303, '', 'text/plain; charset=utf-8', {
        Location: `${redirectTarget.pathname}${redirectTarget.search}#ots-token=${encodeURIComponent(apiToken)}`,
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
        storageRevision: currentStorageRevision()
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
    const pageResource = req.method === 'GET' && !url.pathname.startsWith('/api/');
    if (!requestIsAuthorized(req) && !(pageResource && requestHasPageSession(req))) {
      throw httpError(401, 'API session token required');
    }
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
      return send(res, 200, JSON.stringify(readCurrentPayloadWithRevision()));
    }
    // 页面每隔一会儿、窗口回到前台时看一眼版本号：别的窗口存过、自己又没有待保存的修改，就悄悄读最新数据。
    if (req.method === 'GET' && url.pathname === '/api/revision') {
      ensureStorage();
      return send(res, 200, JSON.stringify({ ok: true, revision: currentStorageRevision() }));
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
      const result = saveCurrentPayload(payload, { baseRevision, saveId:requestPayload?.saveId, customerMoves:requestPayload?.customerMoves, customerDeletes:requestPayload?.customerDeletes, customerInference:requestPayload?.customerInference !== false });
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
      openDetached([supportDir]);
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
      openDetached([folder]);
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
        // 交给 open 的是解析过的地址（和白名单检查的是同一个），不是原始字符串。
        const child = spawn('/usr/bin/open', [parsed.href], { stdio: 'ignore' });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`open exited ${code}`)));
      });
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (req.method === 'GET' && url.pathname === '/api/track') {
      const rawNumber = String(url.searchParams.get('number') || '');
      // 运单号最长也就三十来位：超长的不发给承运商；承运商只认这三家，不把调用方写的任意文字原样回显。
      if (rawNumber.length > 80) throw httpError(400, '物流单号太长');
      const number = cleanTracking(rawNumber);
      if (!number) return send(res, 400, JSON.stringify({ ok: false, message: '缺少物流单号' }));
      if (number.length > 40) throw httpError(400, '物流单号太长');
      const requestedCarrier = String(url.searchParams.get('carrier') || '').trim();
      const knownCarrier = { dhl: 'DHL', fedex: 'FedEx', ups: 'UPS' }[requestedCarrier.toLowerCase()];
      if (requestedCarrier && !knownCarrier) throw httpError(400, '承运商只支持 DHL、FedEx、UPS');
      const carrier = knownCarrier || detectCarrier(number);
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
      assertSettingFields(body, aiSettingLimits);
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
      assertSettingFields(body, trackingSettingLimits);
      assertAutoRunTimes(body.autoRunTimes);
      const current = readTrackingSettings();
      const next = { ...body };
      if (!String(next.dhlApiKey || '').trim() && current.dhlApiKey) next.dhlApiKey = current.dhlApiKey;
      if (!String(next.fedexApiKey || '').trim() && current.fedexApiKey) next.fedexApiKey = current.fedexApiKey;
      if (!String(next.fedexApiSecret || '').trim() && current.fedexApiSecret) next.fedexApiSecret = current.fedexApiSecret;
      return send(res, 200, JSON.stringify(writeTrackingSettings(next)));
    }
    if (req.method === 'GET' && url.pathname === '/api/ecb-rates') {
      const result = await queryEcbHistoricalRates();
      return send(res, 200, JSON.stringify({ ok:true, ...result }));
    }
    return send(res, 404, JSON.stringify({ ok: false, message: 'not found' }));
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    const friendly = status >= 500 ? friendlySaveError(error) : null;
    return send(res, status, JSON.stringify({
      ok: false,
      message: friendly?.message || error.message || 'internal server error',
      ...(friendly ? { code: friendly.code, detail: String(error.message || '').slice(0, 200) } : {}),
      ...(error.publicDetails && typeof error.publicDetails === 'object' ? error.publicDetails : {}),
      ...(Number.isInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {})
    }), 'application/json; charset=utf-8', status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
  }
});

// 端口被占等监听错误：直接退出（非 0），Mac 壳换一个端口重试。以前这个错误被下面的 uncaughtException 接住，
// 进程还活着却没在监听，App 要白等 12 秒健康检查。
server.on('error', error => {
  console.error(`Server error: ${error.code || ''} ${error.message || error}`);
  if (!server.listening) process.exit(error.code === 'EADDRINUSE' ? 98 : 1);
});
server.listen(port, '127.0.0.1', () => {
  const target = `http://127.0.0.1:${port}/trade-order-system.html?token=${encodeURIComponent(apiToken)}#dashboard`;
  if (process.env.TRADE_APP_NO_OPEN !== '1') {
    openDetached([target]);
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

// 一个没接住的异常不该让整个服务退出（页面会只剩一个永远保存不了的窗口）：记下来，继续服务。
process.on('uncaughtException', error => {
  console.error(`Uncaught exception: ${error?.stack || error}`);
});
process.on('unhandledRejection', reason => {
  console.error(`Unhandled rejection: ${reason?.stack || reason}`);
});

// Mac 壳被强制退出或崩溃时不会来得及结束服务：父进程一没（被系统改挂到 launchd 下），服务自己收尾退出，
// 不再留下占着端口和数据库的孤儿进程。
if (process.env.TRADE_APP_EXIT_WITH_PARENT === '1') {
  const parentPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentPid) {
      console.error(`Host app ${parentPid} is gone; shutting down`);
      shutdown('parent-exit');
    }
  }, 2000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
