const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { installWhatsAppFixture } = require('./helpers/whatsapp-fixture');
(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../chrome-extension/whatsapp-sync/manifest.json')));
  const extensionId = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(extensionId, 'kngglcbmpjeldcidpdmgofbmjklcaglh');
  let clicked, messagesSent = 0, tabsOpened = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../chrome-extension/whatsapp-sync/background.js'), 'utf8'), { chrome:{
    runtime:{ onMessage:{ addListener() {} } }, action:{ onClicked:{ addListener(fn) { clicked = fn; } } },
    tabs:{ async sendMessage() { messagesSent++; }, create() { tabsOpened++; } }
  } });
  // Without broad tabs/activeTab permission Chrome may omit tab.url; still toggle existing content.
  await clicked({ id:7 });
  assert.equal(messagesSent, 1);
  assert.equal(tabsOpened, 0);
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage();
    await page.route('https://web.whatsapp.com/**', route => route.fulfill({ contentType:'text/html', body:'<main id="main"><header>Alice</header></main>' }));
    await page.goto('https://web.whatsapp.com/');
    await installWhatsAppFixture(page);
    await page.addScriptTag({ path:path.join(__dirname, '../chrome-extension/whatsapp-sync/wa-page.js') });
    await page.addScriptTag({ path:path.join(__dirname, '../chrome-extension/whatsapp-sync/collector.js') });
    let result = await page.evaluate(() => TradeWhatsAppCollector.snapshot(document));
    assert.equal(result.accountId, '15550001111@c.us', 'bridge must return actual WhatsApp login identity');
    assert.equal(result.chatId, '15551234567@c.us');
    assert.equal(result.phone, '+15551234567');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].direction, 'in');
    await page.evaluate(() => { fixtureWA.peer='888@g.us'; });
    result = await page.evaluate(() => TradeWhatsAppCollector.snapshot(document));
    assert.equal(result.ok, false, 'group chat snapshots cannot be synced');
    await page.evaluate(() => { fixtureWA.peer='999@lid'; fixtureWA.messages=[]; });
    result = await page.evaluate(() => TradeWhatsAppCollector.snapshot(document));
    assert.equal(result.phone, '', 'WhatsApp lid must never be mistaken for a phone number');
    assert.equal(result.chatId, '999@lid');
    await page.evaluate(() => { fixtureWA.ready=false; });
    assert.equal((await page.evaluate(() => TradeWhatsAppCollector.snapshot())).ok, false);
    console.log('WhatsApp collector passed: async page bridge, auto account identity, group rejection, LID safety and readiness.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
