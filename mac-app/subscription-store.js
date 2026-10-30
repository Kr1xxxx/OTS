'use strict';
const crypto = require('node:crypto');

// Personal subscriptions live only in these two tables. Orders, reports, search and the JSON
// data file never read them; the hourly SQLite backup copies them with the rest of the database.
const categories = ['工具效率', 'AI', '其他'];
const currencies = ['CNY', 'USD'];
// A billing cycle is a count of days or months; weeks are stored as 7 days and years as 12 months.
const cycleUnits = { day:3650, month:120 };
const defaultPaymentMethods = ['支付宝', '微信支付', '银行卡', '信用卡', 'PayPal', 'Apple Pay'];
const maxCustomOptions = 30;
const statuses = ['active', 'cancelled'];
const defaultUsdCnyRate = 7.1;

function fail(message) { const error = new Error(message); error.status = 400; throw error; }
function bounded(value, name, max, required = true) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${name}无效`);
  return value.trim();
}
function isoDate(value, name) {
  const text = bounded(value, name, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!date || date.toISOString().slice(0, 10) !== text) fail(`${name}无效`);
  return text;
}
function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) fail(`${name}无效`);
  return value;
}
function cleanCycle(unit, count) {
  if (!Object.hasOwn(cycleUnits, unit)) fail('扣费周期无效');
  const value = Number(count);
  if (!Number.isInteger(value) || value < 1 || value > cycleUnits[unit]) fail('扣费周期无效');
  return { unit, count:value };
}
function cleanItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('订阅内容无效');
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) fail('金额无效');
  const status = oneOf(input.status ?? 'active', statuses, '状态');
  const extra = input.extra ?? {};
  if (!extra || typeof extra !== 'object' || Array.isArray(extra) || JSON.stringify(extra).length > 4000) fail('附加信息无效');
  const id = input.id === undefined || input.id === '' ? crypto.randomUUID() : bounded(input.id, '订阅标识', 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) fail('订阅标识无效');
  const color = bounded(input.color ?? '#7747ff', '颜色', 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail('颜色无效');
  // Records saved before custom cycles only carry cycleMonths (1 or 12).
  const cycle = input.cycleUnit === undefined && input.cycleCount === undefined
    ? cleanCycle('month', input.cycleMonths)
    : cleanCycle(input.cycleUnit, input.cycleCount);
  return {
    id,
    name:bounded(input.name, '名称', 80),
    note:bounded(input.note, '备注', 200, false),
    amount:Math.round(amount * 100) / 100,
    currency:oneOf(input.currency, currencies, '币种'),
    cycleUnit:cycle.unit,
    cycleCount:cycle.count,
    paymentMethod:bounded(input.paymentMethod, '付款方式', 40, false),
    startDate:isoDate(input.startDate, '开始日期'),
    category:oneOf(input.category, categories, '分类'),
    color:color.toLowerCase(),
    status,
    // A cancelled subscription keeps running until the charge date it would have renewed on.
    endsOn:status === 'cancelled' ? isoDate(input.endsOn, '到期日') : '',
    extra
  };
}
function fromRow(row) {
  let extra = {};
  try { extra = JSON.parse(row.extra_json); } catch (_) {}
  return {
    id:row.id, name:row.name, note:row.note, amount:row.amount, currency:row.currency,
    cycleUnit:row.cycle_unit, cycleCount:row.cycle_months, paymentMethod:row.payment_method, startDate:row.start_date, category:row.category, color:row.color,
    status:row.status, endsOn:row.ends_on, createdAt:row.created_at, updatedAt:row.updated_at, extra
  };
}

function createSubscriptionStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL CHECK(currency IN ('CNY','USD')),
      cycle_months INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      category TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('active','cancelled')),
      ends_on TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      extra_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS subscription_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // cycle_months holds the cycle count; cycle_unit says whether it counts days or months.
  const columns = db.prepare('PRAGMA table_info(subscriptions)').all().map(column => column.name);
  if (!columns.includes('cycle_unit')) db.exec("ALTER TABLE subscriptions ADD COLUMN cycle_unit TEXT NOT NULL DEFAULT 'month'");
  if (!columns.includes('payment_method')) db.exec("ALTER TABLE subscriptions ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''");
  const setting = key => db.prepare('SELECT value FROM subscription_settings WHERE key = ?').get(key)?.value;
  const writeSetting = (key, value) => db.prepare(`INSERT INTO subscription_settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  const options = () => {
    let saved = {};
    try { saved = JSON.parse(setting('options') || '{}'); } catch (_) {}
    return {
      customCycles:Array.isArray(saved.customCycles) ? saved.customCycles : [],
      customPaymentMethods:Array.isArray(saved.customPaymentMethods) ? saved.customPaymentMethods : []
    };
  };
  const usdCnyRate = () => {
    const rate = Number(setting('usd_cny_rate'));
    return Number.isFinite(rate) && rate > 0 ? rate : defaultUsdCnyRate;
  };
  return {
    list() {
      const items = db.prepare('SELECT * FROM subscriptions ORDER BY created_at, id').all().map(fromRow);
      return { ok:true, items, usdCnyRate:usdCnyRate(), categories, defaultPaymentMethods, ...options() };
    },
    save(input) {
      const item = cleanItem(input);
      const now = new Date().toISOString();
      const previous = db.prepare('SELECT created_at FROM subscriptions WHERE id = ?').get(item.id);
      // Undo after delete writes the same record back, so a valid original creation time is kept.
      const restoredAt = typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)) ? input.createdAt : '';
      const createdAt = previous?.created_at || restoredAt || now;
      db.prepare(`
        INSERT INTO subscriptions(id, name, note, amount, currency, cycle_months, cycle_unit, payment_method, start_date, category, color, status, ends_on, created_at, updated_at, extra_json)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, note = excluded.note, amount = excluded.amount, currency = excluded.currency,
          cycle_months = excluded.cycle_months, cycle_unit = excluded.cycle_unit, payment_method = excluded.payment_method, start_date = excluded.start_date, category = excluded.category,
          color = excluded.color, status = excluded.status, ends_on = excluded.ends_on,
          updated_at = excluded.updated_at, extra_json = excluded.extra_json
      `).run(item.id, item.name, item.note, item.amount, item.currency, item.cycleCount, item.cycleUnit, item.paymentMethod, item.startDate,
        item.category, item.color, item.status, item.endsOn, createdAt, now, JSON.stringify(item.extra));
      return { ok:true, item:fromRow(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(item.id)) };
    },
    remove(input = {}) {
      const id = bounded(input.id, '订阅标识', 64);
      const deleted = Number(db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id).changes);
      if (!deleted) { const error = new Error('订阅不存在'); error.status = 404; throw error; }
      return { ok:true, deleted };
    },
    setRate(input = {}) {
      const rate = Number(input.usdCnyRate);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 100) fail('汇率无效');
      const value = Math.round(rate * 10000) / 10000;
      writeSetting('usd_cny_rate', String(value));
      return { ok:true, usdCnyRate:value };
    },
    setOptions(input = {}) {
      // The user's own billing cycles and payment methods, offered next to the built-in ones.
      const cyclesIn = input.customCycles ?? [];
      const methodsIn = input.customPaymentMethods ?? [];
      if (!Array.isArray(cyclesIn) || cyclesIn.length > maxCustomOptions) fail('自定义扣费周期无效');
      if (!Array.isArray(methodsIn) || methodsIn.length > maxCustomOptions) fail('自定义付款方式无效');
      const customCycles = [];
      cyclesIn.forEach(entry => {
        const cycle = cleanCycle(entry?.unit, entry?.count);
        if (!customCycles.some(other => other.unit === cycle.unit && other.count === cycle.count)) customCycles.push(cycle);
      });
      const customPaymentMethods = [];
      methodsIn.forEach(entry => {
        const method = bounded(entry, '付款方式', 40);
        if (!customPaymentMethods.includes(method) && !defaultPaymentMethods.includes(method)) customPaymentMethods.push(method);
      });
      writeSetting('options', JSON.stringify({ customCycles, customPaymentMethods }));
      return { ok:true, customCycles, customPaymentMethods };
    }
  };
}
module.exports = { createSubscriptionStore, defaultUsdCnyRate, defaultPaymentMethods };
