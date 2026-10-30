'use strict';
const crypto = require('node:crypto');

// Personal subscriptions live only in these two tables. Orders, reports, search and the JSON
// data file never read them; the hourly SQLite backup copies them with the rest of the database.
const categories = ['工具效率', 'AI', '其他'];
const currencies = ['CNY', 'USD'];
const cycles = [1, 12];
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
  return {
    id,
    name:bounded(input.name, '名称', 80),
    note:bounded(input.note, '备注', 200, false),
    amount:Math.round(amount * 100) / 100,
    currency:oneOf(input.currency, currencies, '币种'),
    cycleMonths:oneOf(Number(input.cycleMonths), cycles, '扣费周期'),
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
    cycleMonths:row.cycle_months, startDate:row.start_date, category:row.category, color:row.color,
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
  const usdCnyRate = () => {
    const row = db.prepare("SELECT value FROM subscription_settings WHERE key = 'usd_cny_rate'").get();
    const rate = Number(row?.value);
    return Number.isFinite(rate) && rate > 0 ? rate : defaultUsdCnyRate;
  };
  return {
    list() {
      const items = db.prepare('SELECT * FROM subscriptions ORDER BY created_at, id').all().map(fromRow);
      return { ok:true, items, usdCnyRate:usdCnyRate(), categories };
    },
    save(input) {
      const item = cleanItem(input);
      const now = new Date().toISOString();
      const previous = db.prepare('SELECT created_at FROM subscriptions WHERE id = ?').get(item.id);
      // Undo after delete writes the same record back, so a valid original creation time is kept.
      const restoredAt = typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)) ? input.createdAt : '';
      const createdAt = previous?.created_at || restoredAt || now;
      db.prepare(`
        INSERT INTO subscriptions(id, name, note, amount, currency, cycle_months, start_date, category, color, status, ends_on, created_at, updated_at, extra_json)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, note = excluded.note, amount = excluded.amount, currency = excluded.currency,
          cycle_months = excluded.cycle_months, start_date = excluded.start_date, category = excluded.category,
          color = excluded.color, status = excluded.status, ends_on = excluded.ends_on,
          updated_at = excluded.updated_at, extra_json = excluded.extra_json
      `).run(item.id, item.name, item.note, item.amount, item.currency, item.cycleMonths, item.startDate,
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
      db.prepare(`INSERT INTO subscription_settings(key, value) VALUES('usd_cny_rate', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(value));
      return { ok:true, usdCnyRate:value };
    }
  };
}
module.exports = { createSubscriptionStore, defaultUsdCnyRate };
