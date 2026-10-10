'use strict';

function fail(message) { const error = new Error(message); error.status = 400; throw error; }
function bounded(value, name, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${name}无效`);
  return value.trim();
}
function phoneKey(value) {
  const raw = String(value || '').trim();
  if (!/^[+\d\s().-]+$/.test(raw)) return '';
  const digits = raw.replace(/\D/g, '').replace(/^00/, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}
function conversationKey(input) {
  const account = bounded(input.account, '账号标识', 100);
  const chatId = bounded(input.chatId, '会话标识', 160);
  if (/@g\.us$/.test(chatId)) fail('第一版不支持群聊同步');
  if (!/^[\w.+:-]+@(c\.us|s\.whatsapp\.net|lid)$/.test(chatId)) fail('无法确认单人聊天标识');
  return { account, chatId };
}
function createWhatsAppStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_conversations (
      account TEXT NOT NULL, chat_id TEXT NOT NULL, customer TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      PRIMARY KEY(account, chat_id)
    );
    CREATE INDEX IF NOT EXISTS whatsapp_by_customer ON whatsapp_conversations(customer);
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL, direction TEXT NOT NULL, timestamp TEXT NOT NULL,
      text TEXT NOT NULL, kind TEXT NOT NULL, captured_at TEXT NOT NULL,
      UNIQUE(account, chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS whatsapp_messages_chat ON whatsapp_messages(account, chat_id, seq);
  `);
  const exists = name => db.prepare('SELECT name FROM customers WHERE name = ?').get(name);
  const findConversation = input => {
    const key = conversationKey(input);
    return db.prepare('SELECT customer, title, updated_at AS updatedAt FROM whatsapp_conversations WHERE account = ? AND chat_id = ?').get(key.account, key.chatId) || null;
  };
  return {
    status() { return { ok:true, protocol:1, messages:db.prepare('SELECT COUNT(*) AS n FROM whatsapp_messages').get().n }; },
    search(input = {}) {
      const phone = phoneKey(input.phone);
      const query = String(input.query || '').trim().toLocaleLowerCase();
      if (query.length > 100) fail('搜索词过长');
      const matched = [];
      if (phone || query.length >= 2) {
        for (const row of db.prepare('SELECT name, data_json FROM customers').iterate()) {
          let profile; try { profile = JSON.parse(row.data_json); } catch { continue; }
          const phones = [...new Set([profile.phone, ...(Array.isArray(profile.phones) ? profile.phones : [])].filter(v => typeof v === 'string'))];
          const exactPhone = Boolean(phone && phones.some(v => phoneKey(v) === phone));
          if (phone ? exactPhone : row.name.toLocaleLowerCase().includes(query)) {
            matched.push({ name:row.name, phones, country:String(profile.country || ''), exactPhone });
          }
          if (matched.length >= 30) break;
        }
      }
      const binding = input.account && input.chatId ? findConversation(input) : null;
      return { ok:true, customers:matched, binding };
    },
    bind(input) {
      const { account, chatId } = conversationKey(input);
      const customer = bounded(input.customer, '客户', 300);
      if (!exists(customer)) fail('客户不存在，请先在订单系统建档');
      const previous = findConversation(input);
      if (previous && previous.customer !== customer) fail(`此聊天已关联 ${previous.customer}，不能覆盖已有聊天归属`);
      const title = bounded(input.title || '', '聊天标题', 300, false);
      db.prepare(`INSERT INTO whatsapp_conversations VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(account, chat_id) DO UPDATE SET title = excluded.title`).run(account, chatId, customer, title, new Date().toISOString());
      return { ok:true, customer };
    },
    sync(input) {
      const { account, chatId } = conversationKey(input);
      const binding = findConversation(input);
      if (!binding || !exists(binding.customer)) fail('请先关联有效客户再同步');
      if (!Array.isArray(input.messages) || input.messages.length > 100) fail('每批最多同步 100 条消息');
      const messages = input.messages.map(message => {
        if (!message || !['in', 'out'].includes(message.direction)) fail('消息方向无效');
        if (!['text','image','video','audio','file','sticker','other'].includes(message.kind)) fail('消息类型无效');
        return { id:bounded(message.id, '消息标识', 400), text:bounded(message.text || '', '消息正文', 20000, false),
          timestamp:bounded(message.timestamp || '', '消息时间', 200, false), direction:message.direction, kind:message.kind };
      });
      const insert = db.prepare(`INSERT INTO whatsapp_messages(account, chat_id, message_id, direction, timestamp, text, kind, captured_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account, chat_id, message_id) DO NOTHING`);
      const fill = db.prepare(`UPDATE whatsapp_messages SET
        text = CASE WHEN text = '' THEN ? ELSE text END,
        timestamp = CASE WHEN timestamp = '' THEN ? ELSE timestamp END,
        kind = CASE WHEN kind = 'other' THEN ? ELSE kind END
        WHERE account = ? AND chat_id = ? AND message_id = ?
        AND ((text = '' AND ? <> '') OR (timestamp = '' AND ? <> '') OR (kind = 'other' AND ? <> 'other'))`);
      let inserted = 0, updated = 0;
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const m of messages) {
          const added = Number(insert.run(account, chatId, m.id, m.direction, m.timestamp, m.text, m.kind, now).changes);
          inserted += added;
          if (!added) updated += Number(fill.run(m.text, m.timestamp, m.kind, account, chatId, m.id, m.text, m.timestamp, m.kind).changes);
        }
        db.prepare('UPDATE whatsapp_conversations SET updated_at = ? WHERE account = ? AND chat_id = ?').run(now, account, chatId);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { ok:true, inserted, updated, duplicate:messages.length - inserted - updated, customer:binding.customer, syncedAt:now };
    },
    messages(input = {}) {
      const customer = bounded(input.customer, '客户', 300);
      const limit = Math.max(1, Math.min(100, Number.parseInt(input.limit, 10) || 50));
      const before = Number.parseInt(input.before, 10) || Number.MAX_SAFE_INTEGER;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_messages m JOIN whatsapp_conversations c
        ON c.account = m.account AND c.chat_id = m.chat_id WHERE c.customer = ?`).get(customer).n;
      const rows = db.prepare(`SELECT m.seq, m.message_id AS id, m.account, m.chat_id AS chatId,
        m.direction, m.timestamp, m.text, m.kind, m.captured_at AS capturedAt
        FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.account = m.account AND c.chat_id = m.chat_id
        WHERE c.customer = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`).all(customer, before, limit + 1);
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      return { ok:true, total, messages:rows, nextBefore:hasMore ? rows.at(-1).seq : null };
    }
  };
}
module.exports = { createWhatsAppStore, phoneKey };
