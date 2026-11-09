const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Deployment configuration belongs outside the app bundle and outside source control.
// The profile name and chat id never leave this machine: the settings page only learns whether they are set.
const maxSettingsBytes = 16384;
const placeholderProfile = 'OTS_BOT_CONFIGURE';

function unavailable(state, reason) {
  return { profile:'', chatName:'订单通知群（待配置）', chatId:'', cliPath:'', configured:false, state, reason };
}

// One rule set for reading the file and for saving from the settings page. Returns { settings } or { reason }.
function validateFeishuSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason:'配置文件内容不是一个 JSON 对象' };
  if (typeof raw.profile !== 'string' || !raw.profile.trim()) return { reason:'缺少 profile（lark-cli 里机器人配置的名字）' };
  if (typeof raw.chatId !== 'string' || !raw.chatId.trim()) return { reason:'缺少群 ID（chatId）' };
  const profile = raw.profile.trim();
  const chatId = raw.chatId.trim();
  const chatName = typeof raw.chatName === 'string' && raw.chatName.trim() ? raw.chatName.trim() : '订单通知群';
  const cliPath = typeof raw.cliPath === 'string' ? raw.cliPath.trim() : '';
  if (profile === placeholderProfile) return { reason:'profile 还是示例占位值，请改成 lark-cli 里真实的 profile 名' };
  if (!/^[\p{L}\p{N}_][\p{L}\p{N} ._-]{0,127}$/u.test(profile)) return { reason:'profile 只能用字母、数字、空格、点、下划线和短横线，最长 128 个字符，不能以符号开头' };
  if (!/^oc_[a-zA-Z0-9]+$/.test(chatId) || chatId.length > 128) return { reason:'群 ID 格式不对：应以 oc_ 开头，后面只有字母和数字' };
  if (/CONFIGURE/.test(chatId)) return { reason:'群 ID 还是示例占位值，请改成真实的群 ID' };
  if (chatName.length > 200 || /[\u0000-\u001f\u007f]/.test(chatName)) return { reason:'群名称太长或含有控制字符' };
  if (cliPath && (!path.isAbsolute(cliPath) || cliPath.length > 1024 || /[\u0000-\u001f\u007f]/.test(cliPath))) return { reason:'lark-cli 路径要写完整路径（以 / 开头）' };
  return { settings:{ profile, chatName, chatId, cliPath } };
}

function readFeishuSettings(file) {
  let descriptor;
  try {
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') return unavailable('missing', '还没有配置飞书');
      if (error.code === 'ELOOP') return unavailable('invalid', '配置文件是符号链接，出于安全不会读取');
      return unavailable('invalid', '配置文件无法读取（权限不足）');
    }
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return unavailable('invalid', '配置文件不是普通文件');
    if (stat.size > maxSettingsBytes) return unavailable('invalid', '配置文件太大（超过 16 KB）');
    const bytes = Buffer.alloc(maxSettingsBytes + 1);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length > maxSettingsBytes) return unavailable('invalid', '配置文件太大（超过 16 KB）');
    // TextEdit / 记事本存的 UTF-8 文件开头可能带 BOM：去掉再解析，不再当成「未配置」。
    const text = bytes.subarray(0, length).toString('utf8').replace(/^\uFEFF/, '');
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      if (/[\u201c\u201d\u2018\u2019]/.test(text)) return unavailable('invalid', '配置文件里有中文弯引号（\u201c \u201d），请改成英文直引号 "');
      const at = /position (\d+)/.exec(String(error.message || ''));
      return unavailable('invalid', `配置文件不是有效的 JSON${at ? `（第 ${Number(at[1]) + 1} 个字符附近）` : ''}`);
    }
    const checked = validateFeishuSettings(raw);
    if (!checked.settings) return unavailable('invalid', checked.reason);
    return { ...checked.settings, configured:true, state:'configured', reason:'' };
  } catch (_) {
    // Missing or invalid configuration disables only notifications, never the order database.
    return unavailable('invalid', '配置文件无法读取');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// Saving from the settings page: blank profile / chat id keep what is saved (they are never sent to the page).
// The file stays 0600 and is replaced atomically; a symbolic link in its place is replaced, never followed.
function writeFeishuSettings(file, input = {}) {
  const current = readFeishuSettings(file);
  const text = value => typeof value === 'string' ? value.trim() : '';
  const next = {
    profile: text(input.profile) || current.profile,
    chatName: text(input.chatName) || (current.configured ? current.chatName : ''),
    chatId: text(input.chatId) || current.chatId,
    cliPath: input.cliPath === undefined ? current.cliPath : text(input.cliPath)
  };
  const checked = validateFeishuSettings(next);
  if (!checked.settings) {
    const error = new Error(checked.reason);
    error.status = 400;
    throw error;
  }
  const saved = { profile:checked.settings.profile, chatName:checked.settings.chatName, chatId:checked.settings.chatId };
  if (checked.settings.cliPath) saved.cliPath = checked.settings.cliPath;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(saved, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (_) {} }
    try { fs.rmSync(tmp, { force:true }); } catch (_) {}
    throw error;
  }
  return readFeishuSettings(file);
}

module.exports = { readFeishuSettings, writeFeishuSettings, validateFeishuSettings };
