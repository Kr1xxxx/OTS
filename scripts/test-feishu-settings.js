#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFeishuSettings } = require('../mac-app/feishu-settings');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-feishu-settings-'));
const file = path.join(dir, 'feishu-settings.json');
const valid = { profile:'OTS_TEST_BOT', chatName:'Synthetic order notifications', chatId:'oc_synthetic123' };
try {
  assert.equal(readFeishuSettings(file).configured, false, 'missing configuration must disable sending');
  fs.writeFileSync(file, JSON.stringify(valid), { mode:0o600 });
  assert.deepEqual(readFeishuSettings(file), { ...valid, configured:true });
  assert.equal(readFeishuSettings(file).profile, 'OTS_TEST_BOT', 'fresh application load must retain the external configuration');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), valid, 'reading must not rewrite local configuration');

  for (const bad of [
    null, [], {}, { ...valid, profile:'OTS_BOT_CONFIGURE' }, { ...valid, profile:'--as user' },
    { ...valid, profile:'bot\nuser' }, { ...valid, chatId:'oc_CONFIGURE_TARGET_CHAT_ID' },
    { ...valid, chatId:'wrong' }, { ...valid, chatId:'oc_bad\nvalue' },
    { ...valid, chatName:'bad\u0000name' }, { ...valid, profile:42 }
  ]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    const result = readFeishuSettings(file);
    assert.equal(result.configured, false, 'invalid settings must not become a CLI target');
    assert.equal(result.profile, '');
    assert.equal(result.chatId, '');
  }
  fs.writeFileSync(file, '{not-json');
  assert.equal(readFeishuSettings(file).configured, false, 'bad JSON must not crash the application');
  fs.writeFileSync(file, ' '.repeat(16385));
  assert.equal(readFeishuSettings(file).configured, false, 'oversize input must be rejected');
  fs.rmSync(file);
  const target = path.join(dir, 'separate.json');
  fs.writeFileSync(target, JSON.stringify(valid));
  fs.symlinkSync(target, file);
  assert.equal(readFeishuSettings(file).configured, false, 'symbolic links must not be followed');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(readFeishuSettings(file).configured, false, 'directories must not be read as configuration');
  fs.rmdirSync(file);
  require('node:child_process').execFileSync('/usr/bin/mkfifo', [file]);
  const started = Date.now();
  assert.equal(readFeishuSettings(file).configured, false, 'FIFO must be rejected without blocking');
  assert.ok(Date.now() - started < 1000, 'configuration input blocked the application');
  console.log('Feishu local settings passed: persistence, validation, placeholders, malformed files and nonblocking file safety.');
} finally {
  fs.rmSync(dir, { recursive:true, force:true });
}
