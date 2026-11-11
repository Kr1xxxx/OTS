// The AI and carrier settings of the local server: two plain JSON files in the data folder, with the
// keys kept apart in secrets/ (files readable by the user only). Values are checked when they arrive
// from the page and again when a file is read, so a hand-edited or old file cannot put anything else in.
const fs = require('fs');
const path = require('path');
const { httpError } = require('./http-error');
const { atomicWrite, readJson } = require('./file-store');

const trackingSecretKeys = ['dhlApiKey', 'fedexApiKey', 'fedexApiSecret'];
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

const defaultAiSettings = {
  enabled: '否',
  provider: 'custom',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'deepseek/deepseek-v4.1-flash',
  lastTestAt: '',
  lastTestStatus: '尚未测试连接'
};

// 设置里的一个文字字段：只认文字（数字也行），别的类型（对象、数组）当没填；超长的截断。读旧文件、写新值都过这一步。
function settingText(value, max, fallback = '') {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const text = String(value).trim();
  return text ? text.slice(0, max) : fallback;
}
// 设置接口收到的字段：类型不对、长度超了回 400（说清是哪个字段），别原样写进设置文件。不认识的字段不管（读写时会被丢掉）。
function assertSettingFields(body, limits) {
  for (const [key, max] of Object.entries(limits)) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number') throw httpError(400, `${key} 必须是文字`);
    if (String(value).length > max) throw httpError(400, `${key} 太长了（最多 ${max} 个字符）`);
  }
}
const aiSettingLimits = { enabled: 10, provider: 20, baseUrl: 500, model: 200, apiKey: 1000, lastTestAt: 64, lastTestStatus: 500 };
const trackingSettingLimits = {
  dhlApiEnabled: 10, dhlApiKey: 1000, fedexApiEnabled: 10, fedexApiKey: 1000, fedexApiSecret: 1000, fedexEnv: 10,
  autoDhlUpdate: 10, autoRunTimes: 100, lastCheckedAt: 64, lastStatus: 500, lastDhlCheckedAt: 64, lastDhlStatus: 500,
  lastFedexCheckedAt: 64, lastFedexStatus: 500, lastAutoRunAt: 64, lastAutoRunSlot: 64, lastAutoOkCount: 12, lastAutoFailCount: 12
};
// 自动更新时间：逗号分隔的「时:分」，例如 09:00,18:00；空着用默认值。
function assertAutoRunTimes(value) {
  if (value === undefined || value === null) return;
  const parts = String(value).split(/[,，]/).map(item => item.trim()).filter(Boolean);
  const valid = parts.every(item => {
    const match = item.match(/^(\d{1,2}):(\d{2})$/);
    return match && Number(match[1]) < 24 && Number(match[2]) < 60;
  });
  if (!valid || parts.length > 6) throw httpError(400, '自动更新时间要写成 09:00,18:00 这样');
}

function normalizeAiSettings(raw = {}) {
  const rawModel = settingText(raw.model, aiSettingLimits.model, defaultAiSettings.model);
  return {
    enabled: raw.enabled === '是' ? '是' : '否',
    provider: raw.provider === 'zhipu' ? 'zhipu' : 'custom',
    baseUrl: settingText(raw.baseUrl, aiSettingLimits.baseUrl, defaultAiSettings.baseUrl).replace(/\/+$/, ''),
    model: rawModel,
    lastTestAt: settingText(raw.lastTestAt, aiSettingLimits.lastTestAt),
    lastTestStatus: settingText(raw.lastTestStatus, aiSettingLimits.lastTestStatus, defaultAiSettings.lastTestStatus)
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
    autoRunTimes: settingText(raw.autoRunTimes, trackingSettingLimits.autoRunTimes, defaultTrackingSettings.autoRunTimes),
    lastCheckedAt: settingText(raw.lastCheckedAt, trackingSettingLimits.lastCheckedAt),
    lastStatus: settingText(raw.lastStatus, trackingSettingLimits.lastStatus, defaultTrackingSettings.lastStatus),
    lastDhlCheckedAt: settingText(raw.lastDhlCheckedAt, trackingSettingLimits.lastDhlCheckedAt),
    lastDhlStatus: settingText(raw.lastDhlStatus, trackingSettingLimits.lastDhlStatus, defaultTrackingSettings.lastDhlStatus),
    lastFedexCheckedAt: settingText(raw.lastFedexCheckedAt, trackingSettingLimits.lastFedexCheckedAt),
    lastFedexStatus: settingText(raw.lastFedexStatus, trackingSettingLimits.lastFedexStatus, defaultTrackingSettings.lastFedexStatus),
    lastAutoRunAt: settingText(raw.lastAutoRunAt, trackingSettingLimits.lastAutoRunAt),
    lastAutoRunSlot: settingText(raw.lastAutoRunSlot, trackingSettingLimits.lastAutoRunSlot),
    lastAutoOkCount: Number(raw.lastAutoOkCount || 0) || 0,
    lastAutoFailCount: Number(raw.lastAutoFailCount || 0) || 0
  };
}

function maskSecret(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 6) return `${text.slice(0, 1)}***${text.slice(-1)}`;
  return `${text.slice(0, 3)}******${text.slice(-3)}`;
}

function withoutTrackingSecrets(settings) {
  const copy = { ...settings };
  trackingSecretKeys.forEach(key => { delete copy[key]; });
  return copy;
}

// ensureStorage: makes the data folder and secrets/ (the server's own, it also prepares the backup folder).
function createAppSettings({ supportDir, secretsDir, ensureStorage }) {
  const trackingSettingsFile = path.join(supportDir, 'tracking-settings.json');
  const aiSettingsFile = path.join(supportDir, 'ai-settings.json');
  const aiApiKeyFile = path.join(secretsDir, 'ai-api-key');
  const trackingSecretsFile = path.join(secretsDir, 'tracking-credentials.json');

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

  return {
    readAiApiKey, migrateLegacyAiApiKey, publicAiSettings, readAiSettings, writeAiSettings,
    migrateLegacyTrackingSecrets, readTrackingSettings, writeTrackingSettings
  };
}

module.exports = { createAppSettings, aiSettingLimits, trackingSettingLimits, assertSettingFields, assertAutoRunTimes, maskSecret };
