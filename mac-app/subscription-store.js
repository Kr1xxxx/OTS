'use strict';
const crypto = require('node:crypto');

// Personal subscriptions live only in the subscription tables. Orders, reports, search and the JSON
// data file never read them; the hourly SQLite backup copies them with the rest of the database.
// Built-in types, each with its own icon and color on the page; the user can add their own.
const categories = ['软件', 'AI', 'VPS', '域名', '云服务', '其他'];
// Types renamed when the page grew from software subscriptions to all renewals.
const legacyCategories = { 工具效率:'软件' };
const currencies = ['CNY', 'USD'];
// A billing cycle is a count of days or months; weeks are stored as 7 days and years as 12 months.
const cycleUnits = { day:3650, month:120 };
const defaultPaymentMethods = ['支付宝', '微信支付', '银行卡', '信用卡', 'PayPal', 'Apple Pay'];
const maxCustomOptions = 30;
const statuses = ['active', 'cancelled'];
const defaultUsdCnyRate = 7.1;

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
// Control characters (a pasted newline, a bell) never belong in a one-line label.
function stripControls(text) { return text.replace(/[\u0000-\u001f\u007f]+/g, ' '); }
function bounded(value, name, max, required = true) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${name}无效`);
  const text = stripControls(value).trim();
  if (required && !text) fail(`${name}无效`);
  return text;
}
function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
// Dates outside 2000 … 2100 are typing slips (a year typed as 0202 bills 21,889 times).
const minDate = '2000-01-01';
const maxDate = '2100-12-31';
function isoDate(value, name, { max = maxDate } = {}) {
  const text = bounded(value, name, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!date || date.toISOString().slice(0, 10) !== text || text < minDate || text > max) fail(`${name}无效`);
  return text;
}
function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) fail(`${name}无效`);
  return value;
}
// Amounts are numbers or plain decimal text: 0x10, 1e3 and the like are not prices.
function decimal(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return NaN;
}
function cleanCycle(unit, count) {
  if (!Object.hasOwn(cycleUnits, unit)) fail('扣费周期无效');
  const value = Number(count);
  if (!Number.isInteger(value) || value < 1 || value > cycleUnits[unit]) fail('扣费周期无效');
  return { unit, count:value };
}
function dayNumber(text) {
  const [year, month, day] = text.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86400000);
}
function addMonths(text, months, anchorDay) {
  const [year, month, day] = text.split('-').map(Number);
  const index = month - 1 + months;
  const targetYear = year + Math.floor(index / 12);
  const targetMonth = index - Math.floor(index / 12) * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(anchorDay || day, lastDay)).padStart(2, '0')}`;
}
// Same schedule as the page: every charge is counted from the start date, so month ends do not drift.
function cleanAnchorDay(value, startDate, cycle) {
  if (value == null || value === 0) return 0;
  if (cycle.unit !== 'month' || !Number.isInteger(value) || value < 1 || value > 31 || addMonths(startDate, 0, value) !== startDate) fail('扣费日无效');
  return value;
}
function isChargeDate(startDate, cycle, date, anchorDay) {
  if (date < startDate) return false;
  if (cycle.unit === 'day') return (dayNumber(date) - dayNumber(startDate)) % cycle.count === 0;
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [year, month] = date.split('-').map(Number);
  const months = (year - startYear) * 12 + month - startMonth;
  return months % cycle.count === 0 && addMonths(startDate, months, anchorDay) === date;
}
const maxPriceChanges = 240;
function cleanPriceChanges(value, startDate, cycle, anchorDay) {
  // Price changes per billing period: `once` overrides one charge (a period already paid at a
  // different price), otherwise the price holds from that charge date on until the next change.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxPriceChanges) fail('周期价格无效');
  // A later entry for the same period and kind replaces an earlier one.
  const byKey = new Map();
  value.forEach(entry => {
    if (!entry || typeof entry !== 'object') fail('周期价格无效');
    let from = isoDate(entry.from, '周期价格日期');
    const amount = decimal(entry.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) fail('周期价格无效');
    const once = entry.once === true;
    // A one-off price that is not on a charge date never applies; an onward one dated before the
    // start applies from the first charge, so it is stored there. Same effect, no dead entries,
    // and records saved before this check still save.
    if (once && !isChargeDate(startDate, cycle, from, anchorDay)) return;
    if (!once && from < startDate) from = startDate;
    byKey.set(`${from}:${once}`, { from, amount:Math.round(amount * 100) / 100, once });
  });
  const list = [...byKey.values()];
  return list.sort((a, b) => a.from.localeCompare(b.from) || Number(a.once) - Number(b.once));
}
const maxTerms = 60;
function cleanTerms(value, startDate) {
  // Earlier settings, kept when the price, cycle, currency, payment method or type changed from a later
  // period on: each covers the charges from its own start date up to (not including) `until`, so the
  // charges already made keep the price and cycle they had at the time.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxTerms) fail('历史设置无效');
  let previousUntil = '';
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('历史设置无效');
    const amount = Math.round(decimal(entry.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) fail('历史设置无效');
    const cycle = cleanCycle(entry.cycleUnit, entry.cycleCount);
    const termStart = isoDate(entry.startDate, '历史设置日期');
    const until = isoDate(entry.until, '历史设置日期');
    const anchorDay = cleanAnchorDay(entry.cycleAnchorDay, termStart, cycle);
    if (until <= termStart || (previousUntil && termStart < previousUntil) || until > startDate) fail('历史设置无效');
    previousUntil = until;
    return {
      startDate:termStart, until, amount, currency:oneOf(entry.currency, currencies, '币种'), cycleUnit:cycle.unit, cycleCount:cycle.count,
      ...(anchorDay ? { cycleAnchorDay:anchorDay } : {}),
      priceChanges:cleanPriceChanges(entry.priceChanges, termStart, cycle, anchorDay),
      paymentMethod:bounded(entry.paymentMethod, '付款方式', 40, false),
      category:Object.hasOwn(legacyCategories, entry.category) ? legacyCategories[entry.category] : bounded(entry.category, '类型', 20)
    };
  });
}
function cleanItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('续费内容无效');
  // Checked after rounding to cents: 0.004 would otherwise pass here and then hit the table's CHECK(amount > 0).
  const amount = Math.round(decimal(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) fail('金额无效');
  const status = oneOf(input.status ?? 'active', statuses, '状态');
  const extra = input.extra ?? {};
  if (!extra || typeof extra !== 'object' || Array.isArray(extra) || JSON.stringify(extra).length > 4000) fail('附加信息无效');
  const id = input.id === undefined || input.id === '' ? crypto.randomUUID() : bounded(input.id, '续费项标识', 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) fail('续费项标识无效');
  const color = bounded(input.color ?? '#7747ff', '颜色', 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail('颜色无效');
  // Records saved before custom cycles only carry cycleMonths (1 or 12).
  const cycle = input.cycleUnit === undefined && input.cycleCount === undefined
    ? cleanCycle('month', input.cycleMonths)
    : cleanCycle(input.cycleUnit, input.cycleCount);
  // Only a real boolean: the text "false" used to be stored as auto-renew on.
  if (input.autoRenew !== undefined && input.autoRenew !== null && typeof input.autoRenew !== 'boolean') fail('续费方式无效');
  // A start date more than ten years ahead is a typing slip too.
  const startDate = isoDate(input.startDate, '开始日期', { max:addMonths(localDate(), 120) });
  const terms = cleanTerms(input.terms, startDate);
  const anchorDay = cleanAnchorDay(input.cycleAnchorDay, startDate, cycle);
  // The first day the item was used, before any earlier settings.
  const firstStart = terms[0]?.startDate || startDate;
  const endsOn = status === 'cancelled' ? isoDate(input.endsOn, '到期日') : '';
  if (endsOn && endsOn < firstStart) fail('到期日不能早于开始日期');
  const stopOn = input.stopOn ? isoDate(input.stopOn, '预计停止时间') : '';
  if (stopOn && stopOn < firstStart) fail('预计停止时间不能早于开始日期');
  return {
    id,
    name:bounded(input.name, '名称', 80),
    note:bounded(input.note, '备注', 200, false),
    amount,
    currency:oneOf(input.currency, currencies, '币种'),
    cycleUnit:cycle.unit,
    cycleCount:cycle.count,
    paymentMethod:bounded(input.paymentMethod, '付款方式', 40, false),
    startDate,
    // Any short label: a custom type deleted later stays on the records that used it.
    // Own keys only: a type named 「constructor」 must not read Object.prototype.
    category:Object.hasOwn(legacyCategories, input.category) ? legacyCategories[input.category] : bounded(input.category, '类型', 20),
    provider:bounded(input.provider, '服务商', 40, false),
    // Off for things renewed by hand, such as most domains; those are reminded earlier.
    autoRenew:input.autoRenew !== false,
    color:color.toLowerCase(),
    status,
    // A cancelled subscription keeps running until the charge date it would have renewed on.
    endsOn,
    cycleAnchorDay:anchorDay,
    priceChanges:cleanPriceChanges(input.priceChanges, startDate, cycle, anchorDay),
    // Planned last day: charges dated after it are not counted.
    stopOn,
    terms,
    // Manual renewals: charges on or before this date were renewed by the user; a later one that is
    // already due is overdue, not silently paid. Left out, the record keeps what it had.
    renewedThrough:input.renewedThrough === undefined ? undefined : input.renewedThrough ? isoDate(input.renewedThrough, '已续费日期') : '',
    extra
  };
}
function parseJsonList(text) {
  try { const list = JSON.parse(text || '[]'); return Array.isArray(list) ? list : []; } catch (_) { return []; }
}
// Rows are checked when saved, but a restored backup brings its own rows (a file from a synced folder or
// from someone else): dates the page reads as YYYY-MM-DD and the color it puts into a style attribute are
// checked again here, so such a row cannot carry markup into the page or break its date maths.
function storedDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''; }
function storedPriceChanges(text) { return parseJsonList(text).filter(entry => entry && storedDate(entry.from)); }
function fromRow(row) {
  let extra = {};
  try { extra = JSON.parse(row.extra_json); } catch (_) {}
  const terms = parseJsonList(row.terms_json)
    .filter(term => term && typeof term === 'object' && storedDate(term.startDate) && storedDate(term.until))
    .map(term => Array.isArray(term.priceChanges) ? { ...term, priceChanges:term.priceChanges.filter(entry => entry && storedDate(entry.from)) } : term);
  return {
    id:row.id, name:row.name, note:row.note, amount:row.amount, currency:row.currency,
    cycleUnit:row.cycle_unit, cycleCount:row.cycle_months, paymentMethod:row.payment_method, startDate:storedDate(row.start_date), category:row.category,
    color:/^#[0-9a-fA-F]{6}$/.test(row.color) ? row.color : '',
    provider:row.provider || '', autoRenew:row.auto_renew !== 0,
    status:row.status, endsOn:storedDate(row.ends_on), priceChanges:storedPriceChanges(row.price_changes_json), stopOn:storedDate(row.stop_on),
    terms, renewedThrough:storedDate(row.renewed_through),
    ...(row.cycle_anchor_day >= 1 && row.cycle_anchor_day <= 31 ? { cycleAnchorDay:row.cycle_anchor_day } : {}),
    createdAt:row.created_at, updatedAt:row.updated_at, extra
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
    CREATE TABLE IF NOT EXISTS subscription_deletions (
      id TEXT PRIMARY KEY,
      deleted_version TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscription_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // cycle_months holds the cycle count; cycle_unit says whether it counts days or months.
  const columns = db.prepare('PRAGMA table_info(subscriptions)').all().map(column => column.name);
  if (!columns.includes('cycle_unit')) db.exec("ALTER TABLE subscriptions ADD COLUMN cycle_unit TEXT NOT NULL DEFAULT 'month'");
  if (!columns.includes('cycle_anchor_day')) db.exec('ALTER TABLE subscriptions ADD COLUMN cycle_anchor_day INTEGER NOT NULL DEFAULT 0');
  if (!columns.includes('payment_method')) db.exec("ALTER TABLE subscriptions ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('provider')) db.exec("ALTER TABLE subscriptions ADD COLUMN provider TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('auto_renew')) db.exec('ALTER TABLE subscriptions ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 1');
  if (!columns.includes('price_changes_json')) db.exec("ALTER TABLE subscriptions ADD COLUMN price_changes_json TEXT NOT NULL DEFAULT '[]'");
  if (!columns.includes('stop_on')) db.exec("ALTER TABLE subscriptions ADD COLUMN stop_on TEXT NOT NULL DEFAULT ''");
  // Earlier settings of a record (see cleanTerms); old rows have none, so their history reads as before.
  if (!columns.includes('terms_json')) db.exec("ALTER TABLE subscriptions ADD COLUMN terms_json TEXT NOT NULL DEFAULT '[]'");
  if (!columns.includes('renewed_through')) {
    db.exec("ALTER TABLE subscriptions ADD COLUMN renewed_through TEXT NOT NULL DEFAULT ''");
    // Manual renewals already on file were shown as renewed up to today, so that stays true; only a
    // renewal that falls due after the upgrade waits for the user's 「已续费」.
    db.prepare('UPDATE subscriptions SET renewed_through = ? WHERE auto_renew = 0').run(localDate());
  }
  for (const [from, to] of Object.entries(legacyCategories)) db.prepare('UPDATE subscriptions SET category = ? WHERE category = ?').run(to, from);
  const setting = key => db.prepare('SELECT value FROM subscription_settings WHERE key = ?').get(key)?.value;
  const writeSetting = (key, value) => db.prepare(`INSERT INTO subscription_settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  const options = () => {
    let saved = {};
    try { saved = JSON.parse(setting('options') || '{}'); } catch (_) {}
    return {
      customCycles:Array.isArray(saved.customCycles) ? saved.customCycles : [],
      customPaymentMethods:Array.isArray(saved.customPaymentMethods) ? saved.customPaymentMethods : [],
      customCategories:Array.isArray(saved.customCategories) ? saved.customCategories : []
    };
  };
  const usdCnyRate = () => {
    const rate = Number(setting('usd_cny_rate'));
    return Number.isFinite(rate) && rate > 0 ? rate : defaultUsdCnyRate;
  };
  const write = operation => input => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(input);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const conflict = row => {
    const error = new Error('这一项在别处改过');
    error.status = 409;
    error.publicDetails = { current:fromRow(row) };
    throw error;
  };
  return {
    list() {
      const items = db.prepare('SELECT * FROM subscriptions ORDER BY created_at, id').all().map(fromRow);
      return { ok:true, items, usdCnyRate:usdCnyRate(), categories, defaultPaymentMethods, ...options() };
    },
    save:write(input => {
      const item = cleanItem(input);
      const previous = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(item.id);
      if (previous && (input.restore === true || (input.baseUpdatedAt !== undefined && previous.updated_at !== input.baseUpdatedAt))) conflict(previous);
      if (!previous && input.baseUpdatedAt !== undefined && input.restore !== true) fail('这一项已在别处删除', 404);
      if (input.restore === true) {
        const deletion = db.prepare('SELECT deleted_version FROM subscription_deletions WHERE id = ?').get(item.id);
        if (!deletion || deletion.deleted_version !== input.updatedAt) fail('这次删除已失效，不能撤销', 409);
      }
      // The clock survives deletes and id reuse. Existing rows may predate this setting.
      const lastVersion = Math.max(Date.parse(setting('last_write_at')) || 0, Date.parse(previous?.updated_at) || 0);
      const now = new Date(Math.max(Date.now(), lastVersion + 1)).toISOString();
      writeSetting('last_write_at', now);
      db.prepare('DELETE FROM subscription_deletions WHERE id = ?').run(item.id);
      // Undo after delete writes the same record back, so a valid original creation time is kept.
      const restoredAt = typeof input.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(input.createdAt) && !Number.isNaN(Date.parse(input.createdAt)) ? input.createdAt : '';
      const createdAt = previous?.created_at || restoredAt || now;
      // A new manual renewal counts what is already due as paid (the user is recording what they have).
      const renewedThrough = item.renewedThrough ?? (previous ? previous.renewed_through : (item.autoRenew ? '' : localDate()));
      db.prepare(`
        INSERT INTO subscriptions(id, name, note, amount, currency, cycle_months, cycle_unit, payment_method, start_date, category, provider, auto_renew, color, status, ends_on, price_changes_json, stop_on, terms_json, renewed_through, created_at, updated_at, extra_json, cycle_anchor_day)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, note = excluded.note, amount = excluded.amount, currency = excluded.currency,
          cycle_months = excluded.cycle_months, cycle_unit = excluded.cycle_unit, payment_method = excluded.payment_method, start_date = excluded.start_date, category = excluded.category,
          provider = excluded.provider, auto_renew = excluded.auto_renew, color = excluded.color, status = excluded.status, ends_on = excluded.ends_on,
          price_changes_json = excluded.price_changes_json, stop_on = excluded.stop_on, terms_json = excluded.terms_json, renewed_through = excluded.renewed_through,
          updated_at = excluded.updated_at, extra_json = excluded.extra_json, cycle_anchor_day = excluded.cycle_anchor_day
      `).run(item.id, item.name, item.note, item.amount, item.currency, item.cycleCount, item.cycleUnit, item.paymentMethod, item.startDate,
        item.category, item.provider, item.autoRenew ? 1 : 0, item.color, item.status, item.endsOn, JSON.stringify(item.priceChanges), item.stopOn,
        JSON.stringify(item.terms), renewedThrough, createdAt, now, JSON.stringify(item.extra), item.cycleAnchorDay);
      return { ok:true, item:fromRow(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(item.id)) };
    }),
    remove:write((input = {}) => {
      const id = bounded(input.id, '续费项标识', 64);
      const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
      if (!row) fail('续费项不存在', 404);
      if (typeof input.baseUpdatedAt !== 'string') fail('请刷新后再删除续费项', 428);
      if (row.updated_at !== input.baseUpdatedAt) conflict(row);
      db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
      // Undo targets this deletion. If the same id is recreated and deleted again, its earlier snapshot stays invalid.
      const deletedAt = Date.now();
      db.prepare('DELETE FROM subscription_deletions WHERE deleted_at < ?').run(deletedAt - 86400000);
      db.prepare('INSERT OR REPLACE INTO subscription_deletions(id, deleted_version, deleted_at) VALUES(?, ?, ?)').run(id, row.updated_at, deletedAt);
      return { ok:true, deleted:1, item:fromRow(row) };
    }),
    setRate(input = {}) {
      const rate = Number(input.usdCnyRate);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 100) fail('汇率无效');
      const value = Math.round(rate * 10000) / 10000;
      if (value <= 0) fail('汇率无效');
      writeSetting('usd_cny_rate', String(value));
      return { ok:true, usdCnyRate:value };
    },
    setOptions:write((input = {}) => {
      // The user's own billing cycles, payment methods and types, offered next to the built-in ones.
      // A call that leaves a list out keeps what was saved for it.
      const saved = options();
      const cyclesIn = input.customCycles ?? saved.customCycles;
      const methodsIn = input.customPaymentMethods ?? saved.customPaymentMethods;
      const categoriesIn = input.customCategories ?? saved.customCategories;
      if (!Array.isArray(cyclesIn) || cyclesIn.length > maxCustomOptions) fail(`自定义扣费周期最多 ${maxCustomOptions} 个，请先删掉不用的`);
      if (!Array.isArray(methodsIn) || methodsIn.length > maxCustomOptions) fail(`自定义付款方式最多 ${maxCustomOptions} 个，请先删掉不用的`);
      if (!Array.isArray(categoriesIn) || categoriesIn.length > maxCustomOptions) fail(`自定义类型最多 ${maxCustomOptions} 个，请先删掉不用的`);
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
      const customCategories = [];
      categoriesIn.forEach(entry => {
        const category = bounded(entry, '类型', 20);
        // An old type name is stored as its new one, so offering it as a custom type would never stick.
        if (Object.hasOwn(legacyCategories, category)) return;
        if (!customCategories.includes(category) && !categories.includes(category)) customCategories.push(category);
      });
      for (const key of Object.keys(saved)) {
        if (!Object.hasOwn(input, key)) continue;
        if (!Array.isArray(input.baseOptions?.[key])) fail('请刷新后再更改自定义选项', 428);
        if (JSON.stringify(input.baseOptions?.[key]) !== JSON.stringify(saved[key])) {
          const error = new Error('自定义选项已在别处更改，请根据最新列表重试');
          error.status = 409;
          error.publicDetails = { currentOptions:saved };
          throw error;
        }
      }
      writeSetting('options', JSON.stringify({ customCycles, customPaymentMethods, customCategories }));
      return { ok:true, customCycles, customPaymentMethods, customCategories };
    })
  };
}
module.exports = { createSubscriptionStore, defaultUsdCnyRate, defaultPaymentMethods };
