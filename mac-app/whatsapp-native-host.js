#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { verifyStorageMarker } = require('./file-store');
const { createWhatsAppStore } = require('./whatsapp-store');

// One request per Chrome sendNativeMessage invocation; stdout is protocol only.
let buffer = Buffer.alloc(0);
let handled = false;
function reply(value) {
  const data = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4); size.writeUInt32LE(data.length);
  process.stdout.write(Buffer.concat([size, data]), () => process.exit(0));
}
process.stdin.on('data', chunk => {
  if (handled) return;
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length < 4) return;
  const length = buffer.readUInt32LE(0);
  if (length > 4 * 1024 * 1024) { handled = true; return reply({ ok:false, message:'同步批次过大' }); }
  if (buffer.length < length + 4) return;
  handled = true;
  let db;
  try {
    const input = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
    if (!['status','search','bind','sync'].includes(input.action)) throw new Error('不支持的同步操作');
    const directory = process.env.TRADE_APP_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'TradeOrderSystem');
    const pendingRestore = path.join(directory, 'restore-pending.json');
    function requireStableDatabase() {
      if (fs.existsSync(pendingRestore)) throw new Error('订单系统正在恢复备份，请在恢复完成后重试');
    }
    requireStableDatabase();
    const file = path.join(directory, 'trade-order-system.sqlite');
    const expectedFile = fs.statSync(file, { bigint:true, throwIfNoEntry:false });
    if (!expectedFile) throw new Error('请先打开一次外贸订单跟进系统');
    db = new DatabaseSync(file);
    // The restore process first blocks new host requests, then drains writers. Check again after locking:
    // even a request started on the previous file must never confirm a write on its displaced inode.
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    requireStableDatabase();
    const currentFile = fs.statSync(file, { bigint:true });
    if (currentFile.dev !== expectedFile.dev || currentFile.ino !== expectedFile.ino) throw new Error('订单数据库已切换，请重试');
    const marker = path.join(directory, 'sqlite-storage.json');
    if (!fs.existsSync(marker)) throw new Error('请先打开订单系统，确认数据库已初始化');
    const metadata = db.prepare('SELECT value FROM metadata WHERE key = ?');
    if (!metadata.get('initialized')?.value) throw new Error('订单数据库尚未初始化');
    verifyStorageMarker(marker, metadata.get('database_id')?.value, { requireMatch:true });
    const store = createWhatsAppStore(db, { inWriteTransaction:true });
    const result = store[input.action](input.payload || {});
    db.exec('COMMIT');
    db.close(); db = null;
    reply(result);
  } catch (error) {
    if (db) try { db.close(); } catch {}
    reply({ ok:false, ...(error.code === 'STALE_BINDING' ? { code:error.code } : {}), message:error.code === 'SQLITE_BUSY' ? '订单系统正在保存，请稍后重试' : String(error.message || '同步失败').slice(0, 300) });
  }
});
process.stdin.on('end', () => { if (!handled) reply({ ok:false, message:'同步请求不完整' }); });
