#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { serverDir, serverFiles } = require('./helpers/server-files');

const root = path.resolve(__dirname, '..');
const appArg = process.argv.indexOf('--app');
const app = path.resolve(appArg >= 0 ? process.argv[appArg + 1] : path.join(root, 'mac-app', 'TradeOrderSystem.app'));
const resources = path.join(app, 'Contents', 'Resources');
const plist = path.join(app, 'Contents', 'Info.plist');
const executable = path.join(app, 'Contents', 'MacOS', 'TradeOrderSystem');
const expectedVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

for (const file of [
  app,
  plist,
  executable,
  path.join(resources, 'node-runtime'),
  path.join(resources, 'server.js'),
  path.join(resources, 'trade-order-system.html'),
  path.join(resources, 'trade-order-data.json')
]) {
  assert(fs.existsSync(file), `Missing release artifact: ${file}`);
}

for (const file of serverFiles()) assertFilesEqual(path.join(serverDir, file), path.join(resources, file));
assert(!fs.existsSync(path.join(resources, 'feishu-settings.json')), 'Private Feishu deployment configuration must not be bundled');
assertFilesEqual(path.join(root, 'trade-order-system.html'), path.join(resources, 'trade-order-system.html'));
assertFilesEqual(path.join(root, 'trade-order-data.json'), path.join(resources, 'trade-order-data.json'));

const plistVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { encoding: 'utf8' }).trim();
const buildVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist], { encoding: 'utf8' }).trim();
assert.equal(plistVersion, expectedVersion, 'Info.plist app version differs from VERSION');
const [expectedMajor, expectedMinor] = expectedVersion.split('.').map(Number);
assert.equal(buildVersion, String(expectedMajor * 10000 + expectedMinor), 'Info.plist build version differs from VERSION (major * 10000 + minor)');
const feishuSettingsVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :OTSFeishuSettingsVersion', plist], { encoding:'utf8' }).trim();
assert.equal(feishuSettingsVersion, '1', 'App must retain external Feishu configuration support');

const nodeRuntimeDigest = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :OTSNodeRuntimeSHA256', plist], { encoding:'utf8' }).trim();
const nodeRuntimeActual = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(resources, 'node-runtime'))).digest('hex');
assert.equal(nodeRuntimeDigest, nodeRuntimeActual, 'Info.plist OTSNodeRuntimeSHA256 must match Contents/Resources/node-runtime (small updates rely on it)');

const packageVersion = require(path.join(root, 'package.json')).version;
assert.equal(packageVersion, `${expectedVersion}.0`, 'package.json version differs from VERSION');

const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');
assert.match(html, new RegExp(`class="app-version"[^>]*>V${escapeRegExp(expectedVersion)}<`), 'visible HTML version differs from VERSION');
assert.match(html, /function\s+flushPendingSave\s*\(/, 'HTML is missing flushPendingSave()');

const server = fs.readFileSync(path.join(root, 'mac-app', 'server.js'), 'utf8');
for (const required of ['TRADE_APP_PORT', 'TRADE_API_TOKEN', 'TRADE_INSTANCE_NONCE', 'instanceNonce']) {
  assert(server.includes(required), `server.js is missing runtime contract: ${required}`);
}

execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
console.log(`Release check passed: ${app} (V${expectedVersion}).`);

function assertFilesEqual(source, bundled) {
  const sourceData = fs.readFileSync(source);
  const bundledData = fs.readFileSync(bundled);
  assert(sourceData.equals(bundledData), `Bundled file differs from source: ${path.relative(root, bundled)}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
