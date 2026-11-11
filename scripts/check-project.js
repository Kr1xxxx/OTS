#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { serverDir, serverFiles } = require('./helpers/server-files');

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

// The main script of the page is one long file by choice; "// #region Name" lines are its table of
// contents (grep -n '^// #region' trade-order-system.html). They have to pair up and carry a name.
{
  const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');
  let open = '';
  let count = 0;
  html.split('\n').forEach((line, index) => {
    if (!/^\/\/ #(end)?region\b/.test(line)) return;
    const where = `trade-order-system.html:${index + 1}`;
    if (line === '// #endregion') {
      assert.ok(open, `${where}: #endregion without a #region before it`);
      open = '';
      return;
    }
    const name = /^\/\/ #region (\S.*)$/.exec(line)?.[1];
    assert.ok(name, `${where}: write "// #region Name" or "// #endregion"`);
    assert.ok(!open, `${where}: "${name}" starts before "${open}" was closed with // #endregion`);
    open = name;
    count += 1;
  });
  assert.ok(!open, `trade-order-system.html: region "${open}" is never closed`);
  assert.ok(count >= 20, 'the main script lost its section markers (// #region)');
}

// The app ships every .js directly in mac-app/, and nothing the server loads lives anywhere else:
// a module outside that folder would work from a checkout and fail in the packaged app.
{
  const buildScript = fs.readFileSync(path.join(root, 'mac-app', 'build-native-mac-app.sh'), 'utf8');
  assert.ok(buildScript.includes('for module in "$ROOT"/mac-app/*.js; do'), 'build-native-mac-app.sh no longer copies every mac-app/*.js into the app');
  for (const file of serverFiles()) {
    execFileSync(process.execPath, ['--check', path.join(serverDir, file)], { stdio: 'inherit' });
    const source = fs.readFileSync(path.join(serverDir, file), 'utf8');
    for (const match of source.matchAll(/require\((['"])(\.[^'"]*)\1\)/g)) {
      assert.match(match[2], /^\.\/[\w-]+(?:\.js)?$/, `mac-app/${file} loads ${match[2]}, which is outside mac-app/ and not in the app`);
      assert.ok(serverFiles().includes(`${path.basename(match[2], '.js')}.js`), `mac-app/${file} loads ${match[2]}, which does not exist`);
    }
  }
}

const expectedVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
assert.match(expectedVersion, /^\d+\.\d+$/, 'VERSION must use major.minor format');
assert.equal(require(path.join(root, 'package.json')).version, `${expectedVersion}.0`, 'package.json version differs from VERSION');
const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');
assert.match(html, new RegExp(`class="app-version"[^>]*>V${escapeRegExp(expectedVersion)}<`), 'visible HTML version differs from VERSION');

// 每个没有兜底值的 var(--x) 都要有定义：用了未定义的变量，整条样式规则失效（全局搜索的选中高亮就这样丢过）。
const definedCssVars = new Set([
  ...[...html.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]),
  ...[...html.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)].map(match => match[1])
]);
const undefinedCssVars = [...new Set([...html.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map(match => match[1]).filter(name => !definedCssVars.has(name)))];
assert.deepEqual(undefinedCssVars, [], `CSS variables used without a definition: ${undefinedCssVars.join(', ')}`);

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

// Notes waiting for the next release must be short enough for the update dialog; a bad one would
// otherwise only fail on main, in the release workflow.
const noteProblems = require('./prepare-release').checkPendingNotes(root);
assert.deepEqual(noteProblems, [], `release-notes/next: ${noteProblems.join('; ')}`);

console.log('Project check passed.');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
