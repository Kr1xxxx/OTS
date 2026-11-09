#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFeishuSettings, writeFeishuSettings } = require('../mac-app/feishu-settings');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-feishu-settings-'));
const file = path.join(dir, 'feishu-settings.json');
const valid = { profile:'OTS_TEST_BOT', chatName:'Synthetic order notifications', chatId:'oc_synthetic123' };
try {
  assert.equal(readFeishuSettings(file).configured, false, 'missing configuration must disable sending');
  assert.equal(readFeishuSettings(file).state, 'missing', 'a missing file is "not configured", not "invalid"');
  fs.writeFileSync(file, JSON.stringify(valid), { mode:0o600 });
  assert.deepEqual(readFeishuSettings(file), { ...valid, cliPath:'', configured:true, state:'configured', reason:'' });
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
    assert.equal(result.state, 'invalid');
    assert.ok(result.reason, `invalid settings say why: ${JSON.stringify(bad)}`);
    assert.equal(result.profile, '');
    assert.equal(result.chatId, '');
  }
  fs.writeFileSync(file, '{not-json');
  assert.equal(readFeishuSettings(file).configured, false, 'bad JSON must not crash the application');
  assert.match(readFeishuSettings(file).reason, /不是有效的 JSON/);
  fs.writeFileSync(file, `\ufeff${JSON.stringify(valid)}`);
  assert.equal(readFeishuSettings(file).configured, true, 'a UTF-8 BOM from a text editor is accepted');
  fs.writeFileSync(file, JSON.stringify(valid).replace(/"/g, '\u201c'));
  assert.match(readFeishuSettings(file).reason, /弯引号/, 'curly quotes from TextEdit are named');

  // Saving from the settings page: validated with the same rules, 0600, blank secrets keep the saved ones.
  fs.rmSync(file);
  assert.throws(() => writeFeishuSettings(file, { ...valid, chatId:'oc_bad-id' }), /oc_/);
  assert.equal(fs.existsSync(file), false, 'an invalid form writes nothing');
  assert.equal(writeFeishuSettings(file, valid).configured, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(writeFeishuSettings(file, { profile:'', chatId:'', chatName:'新群名' }).chatName, '新群名');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...valid, chatName:'新群名' }, 'blank profile / chat id keep the saved values');
  fs.rmSync(file);
  const linkTarget = path.join(dir, 'link-target.json');
  fs.writeFileSync(linkTarget, '{}');
  fs.symlinkSync(linkTarget, file);
  assert.throws(() => writeFeishuSettings(file, { profile:'', chatId:'', chatName:'x' }), /profile/, 'a symbolic link is not read as the saved settings');
  writeFeishuSettings(file, valid);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false, 'saving replaces a symbolic link instead of writing through it');
  assert.equal(fs.readFileSync(linkTarget, 'utf8'), '{}');
  fs.rmSync(linkTarget);
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
  console.log('Feishu local settings passed: persistence, validation with reasons, BOM, curly quotes, saving (0600, keeps blank secrets, replaces links), placeholders, malformed files and nonblocking file safety.');
} finally {
  fs.rmSync(dir, { recursive:true, force:true });
}
