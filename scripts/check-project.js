#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const required = [
  'VERSION',
  'trade-order-system.html',
  'trade-order-data.json',
  '.env.example',
  'package.json',
  'data/demo-data.json',
  'docs/project-notes.md',
  'mac-app/server.js',
  'mac-app/build-native-mac-app.sh',
  'mac-app/native/Package.swift',
  'mac-app/native/Sources/TradeOrderSystemCore/RuntimePolicy.swift',
  'mac-app/native/Sources/TradeOrderSystemNative/main.swift',
  'mac-app/native/Sources/TradeOrderSystemCoreTests/main.swift',
  'scripts/check-release.js',
  'scripts/test-tracking-api.js',
  'scripts/test-sqlite-storage.js',
  'scripts/test-server-security.js',
  'scripts/test-feishu-order-notification.js',
  'scripts/test-feishu-order-ui.js'
];

for (const file of required) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) throw new Error(`Missing required file: ${file}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-order-check-'));
try {
  const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
  const tempScript = path.join(tempDir, 'trade-order-system-check.js');
  fs.writeFileSync(tempScript, scripts);
  execFileSync(process.execPath, ['--check', tempScript], { stdio: 'inherit' });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

for (const file of [
  'mac-app/server.js',
  'scripts/check-release.js',
  'scripts/test-tracking-api.js',
  'scripts/test-sqlite-storage.js',
  'scripts/test-server-security.js',
  'scripts/test-feishu-order-notification.js',
  'scripts/test-feishu-order-ui.js'
]) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
}

const expectedVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
assert.match(expectedVersion, /^\d+\.\d+$/, 'VERSION must use major.minor format');
assert.equal(require(path.join(root, 'package.json')).version, `${expectedVersion}.0`, 'package.json version differs from VERSION');
const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');
assert.match(html, new RegExp(`class="app-version"[^>]*>V${escapeRegExp(expectedVersion)}<`), 'visible HTML version differs from VERSION');

const secretPatterns = [
  /API Key\s+[A-Za-z0-9_-]{12,}/i,
  /API Secret\s+[A-Za-z0-9_-]{12,}/i,
  /secret:\s*['"][A-Za-z0-9_-]{12,}['"]/i,
  /client_secret\s*[:=]\s*['"][A-Za-z0-9_-]{12,}['"]/i
];
for (const file of [
  'trade-order-system.html',
  'mac-app/server.js',
  'scripts/test-tracking-api.js',
  'docs/project-notes.md',
  '.env.example',
  'data/demo-data.json'
]) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) throw new Error(`Possible real secret found in ${file}`);
  }
}

console.log('Project check passed.');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
