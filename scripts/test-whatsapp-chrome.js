const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { installWhatsAppFixture } = require('./helpers/whatsapp-fixture');
const extension = path.resolve(__dirname, '../chrome-extension/whatsapp-sync');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kme-extension-chrome-'));
let context;
(async () => {
  context = await chromium.launchPersistentContext(profile, { channel:'chromium', headless:true,
    viewport:{ width:1100, height:820 }, args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.match(worker.url(), /kngglcbmpjeldcidpdmgofbmjklcaglh/);
  // Keep this real-extension test entirely away from the user's native host/data.
  await worker.evaluate(() => {
    globalThis.fixtureNativeCalls = [];
    chrome.runtime.sendNativeMessage = (host, message, callback) => {
      fixtureNativeCalls.push({ host, action:message.action });
      callback(message.action === 'search' ? { ok:true, customers:[{ name:'Alice', exactPhone:true }], binding:null } : { ok:true, messages:0 });
    };
  });
  await context.route('**/*', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><html><body style="font:16px sans-serif;background:#e9efeb;padding:40px"><main id="main">Isolated WhatsApp API fixture — no real account</main></body></html>' }));
  const page = await context.newPage();
  await page.goto('https://web.whatsapp.com/');
  await page.waitForFunction(() => window.WPP?.version === '4.5.0');
  assert.equal(await page.evaluate(() => typeof window.WPP.chat.getActiveChat), 'function', 'official packaged library actually starts in MAIN world');
  await page.waitForSelector('#trade-whatsapp-assistant', { state:'attached' });
  await page.evaluate(() => { window.fixtureSnapshots=[]; window.addEventListener('message', e => { if(e.data?.type==='snapshot-result') fixtureSnapshots.push(e.data.result); }); });
  await installWhatsAppFixture(page);
  await page.waitForFunction(() => fixtureSnapshots.some(s => s.ok && s.accountId === '15550001111@c.us'), null, { timeout:15000 });
  await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    await chrome.tabs.sendMessage(tabs.find(tab => tab.id && tab.url?.includes('whatsapp'))?.id || tabs.at(-1).id, { action:'toggle-panel' });
  });
  const cdp = await context.newCDPSession(page);
  let text='';
  for(let i=0;i<30;i++) {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    text=nodes.map(n=>n.name?.value || '').join('\n');
    if(text.includes('WA-JS 已连接') && text.includes('确认关联此客户')) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.match(text, /WA-JS 已连接/);
  assert.match(text, /Alice/);
  assert.match(text, /确认关联此客户/);
  await page.evaluate(() => window.postMessage({ channel:'KME_WA_READ_V1', type:'sync', action:'sync', payload:{ customer:'attacker' }, requestId:crypto.randomUUID() }, location.origin));
  const calls=await worker.evaluate(()=>fixtureNativeCalls);
  assert.ok(calls.some(call=>call.action==='search'));
  assert.ok(calls.every(call=>call.action==='search'), 'page bridge cannot trigger native writes');
  if(process.env.WA_SCREENSHOT) await page.screenshot({ path:`${process.env.WA_SCREENSHOT}.real-extension.png` });
  console.log('Actual isolated Chrome extension passed: manifest ID, official WA-JS MAIN load, isolated bridge, auto-account sidebar and native command isolation.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(context) await context.close();
  fs.rmSync(profile,{recursive:true,force:true});
});
