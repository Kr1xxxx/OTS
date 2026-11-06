const fs = require('node:fs');

// Deployment configuration belongs outside the app bundle and outside source control.
function readFeishuSettings(file) {
  const unavailable = { profile:'', chatName:'订单通知群（待配置）', chatId:'', configured:false };
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 16384) return unavailable;
    const bytes = Buffer.alloc(16385);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length > 16384) return unavailable;
    const raw = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable;
    if (typeof raw.profile !== 'string' || typeof raw.chatId !== 'string') return unavailable;
    const profile = raw.profile.trim();
    const chatId = raw.chatId.trim();
    const chatName = typeof raw.chatName === 'string' ? raw.chatName.trim() : '订单通知群';
    if (!/^[\p{L}\p{N}_][\p{L}\p{N} ._-]{0,127}$/u.test(profile) || profile === 'OTS_BOT_CONFIGURE') return unavailable;
    if (!/^oc_[a-zA-Z0-9]+$/.test(chatId) || chatId.length > 128) return unavailable;
    if (!chatName || chatName.length > 200 || /[\u0000-\u001f\u007f]/.test(chatName)) return unavailable;
    return { profile, chatName, chatId, configured:true };
  } catch (_) {
    // Missing or invalid configuration disables only notifications, never the order database.
    return unavailable;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

module.exports = { readFeishuSettings };
