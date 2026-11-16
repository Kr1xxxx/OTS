#!/usr/bin/env node
// 设置页的四个开关（物流追踪的 DHL 官方查询 / 自动更新物流 / FedEx 官方查询，AI 识别），真实本地服务 + 真实鼠标键盘：
// - 开关和服务端存的值一致；点一下、键盘空格都能切换；切换算表单改动（离开设置页会问），但不自己保存；
// - 下面那行跟着开关、Key、自动更新时间实时变：开和关各一句，自动更新写表单里填的时间；
//   开着但缺 Key（DHL、FedEx 的 Key / Secret、AI 的 API Key）、自动更新没有可查的承运商或时间填错时用警示色；
// - 点「保存」后服务端存的仍是「是」/「否」，和以前分段控件存的一样；
// - 窄窗口单列，说明行换行不撑破网格；警示色在两个主题下都看得清。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-settings-switches-'));
  const port = freePortSync();
  const token = `settings-switches-${process.pid}`;
  // 本机环境里的 Key 不能带进来：服务端会把它们当成「已保存」。
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1' };
  ['AI_API_KEY', 'DHL_API_KEY', 'FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET'].forEach(key => delete env[key]);
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${url}/api/health`)).ok; } catch (_) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'server starts');
    const api = async (route, body) => {
      const response = await fetch(url + route, { method:body ? 'POST' : 'GET', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) });
      const data = await response.json();
      assert.ok(response.ok, `${route}: ${data.message}`);
      return data;
    };
    // 起点：三个都开着、没有 Key、默认时间。
    await api('/api/tracking-settings', { dhlApiEnabled:'是', fedexApiEnabled:'是', autoDhlUpdate:'是', autoRunTimes:'09:00,18:00' });
    const trackingBefore = await api('/api/tracking-settings');
    const aiBefore = await api('/api/ai-settings');

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 } });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
    await page.goto(`${url}/trade-order-system.html?token=${token}`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => { setPage('settings'); uiSettingsTab('tracking-api'); });

    const T = '#trackingApiSettingsForm';
    const A = '#aiSettingsForm';
    const sw = (form, name) => `${form} input[role="switch"][name="${name}"]`;
    const desc = (form, name) => page.evaluate(([form, name]) => {
      const small = document.querySelector(`${form} [data-switch-desc="${name}"]`);
      return { text:small.textContent, warning:small.classList.contains('is-warning') };
    }, [form, name]);
    const checked = selector => page.locator(selector).isChecked();
    const dirty = form => page.evaluate(form => uiFormDirty(document.querySelector(form)), form);

    // ---- 1. 打开时和服务端一致 ----
    assert.equal(await checked(sw(T, 'dhlApiEnabled')), trackingBefore.dhlApiEnabled === '是');
    assert.equal(await checked(sw(T, 'autoDhlUpdate')), trackingBefore.autoDhlUpdate === '是');
    assert.equal(await checked(sw(T, 'fedexApiEnabled')), trackingBefore.fedexApiEnabled === '是');
    assert.deepEqual([trackingBefore.dhlApiEnabled, trackingBefore.fedexApiEnabled, trackingBefore.autoDhlUpdate, trackingBefore.dhlApiKeySaved], ['是', '是', '是', false]);
    assert.equal(await page.locator(`${T} select[name="dhlApiEnabled"], ${T} select[name="autoDhlUpdate"], ${T} select[name="fedexApiEnabled"]`).count(), 0, 'no segmented on/off left');
    assert.equal(await page.locator(`${T} select[name="fedexEnv"]`).count(), 1, 'the FedEx environment stays a two-way choice');
    assert.deepEqual(await desc(T, 'dhlApiEnabled'), { text:'已开启，但还没填 DHL API Key，查不了', warning:true });
    assert.deepEqual(await desc(T, 'fedexApiEnabled'), { text:'已开启，但还没填 FedEx API Key 和 Secret，查不了', warning:true });
    assert.deepEqual(await desc(T, 'autoDhlUpdate'), { text:'每天 09:00 和 18:00 自动查没签收的 DHL / FedEx 包裹；到点时软件没开，打开后补查', warning:false });
    assert.equal(await dirty(T), false);

    // ---- 2. 点一下切换：说明跟着变，算改动，但不自己保存 ----
    await page.locator(sw(T, 'dhlApiEnabled')).click();
    assert.equal(await checked(sw(T, 'dhlApiEnabled')), false);
    assert.deepEqual(await desc(T, 'dhlApiEnabled'), { text:'已关闭：DHL 单号不查状态，可以点「官网」去 DHL 网站看', warning:false });
    assert.deepEqual(await desc(T, 'autoDhlUpdate'), { text:'每天 09:00 和 18:00 自动查没签收的 FedEx 包裹；到点时软件没开，打开后补查', warning:false });
    assert.equal(await dirty(T), true, 'flipping a switch is an unsaved change');
    assert.equal((await api('/api/tracking-settings')).dhlApiEnabled, '是', 'a switch alone does not save');
    // 键盘空格切回来。
    await page.locator(sw(T, 'dhlApiEnabled')).focus();
    await page.keyboard.press('Space');
    assert.equal(await checked(sw(T, 'dhlApiEnabled')), true, 'Space flips the switch');
    assert.equal(await dirty(T), false, 'flipped back to how it was saved');

    // ---- 3. Key、自动更新时间 ----
    await page.fill(`${T} input[name="dhlApiKey"]`, 'made-up-dhl-key');
    assert.deepEqual(await desc(T, 'dhlApiEnabled'), { text:'已开启：DHL 单号用 DHL 官方接口查物流状态', warning:false });
    await page.fill(`${T} input[name="fedexApiKey"]`, 'made-up-fedex-id');
    assert.deepEqual(await desc(T, 'fedexApiEnabled'), { text:'已开启，但还没填 FedEx Secret，查不了', warning:true });
    await page.fill(`${T} input[name="autoRunTimes"]`, '08:30, 20:15');
    assert.equal((await desc(T, 'autoDhlUpdate')).text, '每天 08:30 和 20:15 自动查没签收的 DHL / FedEx 包裹；到点时软件没开，打开后补查');
    await page.fill(`${T} input[name="autoRunTimes"]`, '8点');
    assert.deepEqual(await desc(T, 'autoDhlUpdate'), { text:'已开启，但自动更新时间没填对（例如 09:00,18:00），不会自动查', warning:true });
    await page.fill(`${T} input[name="autoRunTimes"]`, '07:45');
    assert.equal((await desc(T, 'autoDhlUpdate')).text, '每天 07:45 自动查没签收的 DHL / FedEx 包裹；到点时软件没开，打开后补查');
    await page.locator(sw(T, 'dhlApiEnabled')).click();
    await page.locator(sw(T, 'fedexApiEnabled')).click();
    assert.deepEqual(await desc(T, 'autoDhlUpdate'), { text:'已开启，但 DHL 和 FedEx 官方查询都关着，不会自动查', warning:true });
    await page.locator(sw(T, 'autoDhlUpdate')).click();
    assert.deepEqual(await desc(T, 'autoDhlUpdate'), { text:'已关闭：只在你点「立即更新物流」或包裹旁的「更新」时查', warning:false });
    await page.locator(sw(T, 'dhlApiEnabled')).click();

    // ---- 4. 保存：服务端存的还是「是」/「否」 ----
    await h.clearToasts(page);
    await page.locator(`${T} button[type="submit"]`).click();
    await h.waitToast(page, '物流追踪设置已保存');
    const trackingAfter = await api('/api/tracking-settings');
    assert.equal(trackingAfter.dhlApiEnabled, '是');
    assert.equal(trackingAfter.fedexApiEnabled, '否');
    assert.equal(trackingAfter.autoDhlUpdate, '否');
    assert.equal(trackingAfter.autoRunTimes, '07:45');
    assert.equal(trackingAfter.dhlApiKeySaved, true);
    assert.equal(trackingAfter.fedexEnv, trackingBefore.fedexEnv, 'the environment is untouched');
    assert.equal(await dirty(T), false, 'clean after saving');
    assert.equal(await checked(sw(T, 'fedexApiEnabled')), false, 'the form shows what was saved');
    assert.deepEqual(await desc(T, 'dhlApiEnabled'), { text:'已开启：DHL 单号用 DHL 官方接口查物流状态', warning:false }, 'a saved key counts once the field is empty again');
    assert.equal(await page.inputValue(`${T} input[name="dhlApiKey"]`), '');

    // ---- 5. AI 识别 ----
    await page.evaluate(() => uiSettingsTab('ai'));
    assert.equal(aiBefore.enabled, '否');
    assert.equal(await page.locator(`${A} select[name="enabled"]`).count(), 0);
    assert.equal(await checked(sw(A, 'enabled')), false);
    assert.deepEqual(await desc(A, 'enabled'), { text:'已关闭：点「AI 识别」不会发给 AI，只能用本地识别', warning:false });
    await page.locator(sw(A, 'enabled')).focus();
    await page.keyboard.press('Space');
    assert.deepEqual(await desc(A, 'enabled'), { text:'已开启，但还没填 API Key，识别会失败', warning:true });
    await page.fill(`${A} input[name="apiKey"]`, 'sk-made-up-key');
    assert.deepEqual(await desc(A, 'enabled'), { text:'已开启：点「AI 识别」时把粘贴的文字发给下面填的 AI 接口', warning:false });
    await h.clearToasts(page);
    await page.locator(`${A} button[type="submit"]`).click();
    await h.waitToast(page, 'AI 设置已保存');
    const aiAfter = await api('/api/ai-settings');
    assert.equal(aiAfter.enabled, '是');
    assert.equal(aiAfter.apiKeySaved, true);
    assert.equal(await checked(sw(A, 'enabled')), true);
    // 再关掉保存：存成「否」。
    await page.locator(sw(A, 'enabled')).click();
    await h.clearToasts(page);
    await page.locator(`${A} button[type="submit"]`).click();
    await h.waitToast(page, 'AI 设置已保存');
    assert.equal((await api('/api/ai-settings')).enabled, '否');

    // ---- 6. 警示色看得清（两个主题），窄窗口单列 ----
    await page.evaluate(() => uiSettingsTab('tracking-api'));
    await page.locator(sw(T, 'fedexApiEnabled')).click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => setThemeMode(theme), theme);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      const colors = await page.evaluate(() => {
        const ctx = Object.assign(document.createElement('canvas'), { width:1, height:1 }).getContext('2d');
        const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const bg = el => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent|\/ 0\)/.test(c)) return rgb(c); } return [255, 255, 255]; };
        const warn = document.querySelector('#trackingApiSettingsForm [data-switch-desc="fedexApiEnabled"]');
        const plain = document.querySelector('#trackingApiSettingsForm [data-switch-desc="dhlApiEnabled"]');
        return { warn:rgb(getComputedStyle(warn).color), plain:rgb(getComputedStyle(plain).color), bg:bg(warn) };
      });
      const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      assert.notDeepEqual(colors.warn, colors.plain, `${theme}: the warning has its own colour`);
      assert.ok(contrast(colors.warn, colors.bg) >= 3, `${theme}: warning readable (${colors.warn} on ${colors.bg})`);
      assert.ok(contrast(colors.plain, colors.bg) >= 3, `${theme}: description readable (${colors.plain} on ${colors.bg})`);
    }
    await page.evaluate(() => setThemeMode('light'));
    for (const width of [1440, 900, 520]) {
      await page.setViewportSize({ width, height:920 });
      const box = await page.evaluate(() => {
        const form = document.getElementById('trackingApiSettingsForm');
        const f = form.getBoundingClientRect();
        const rows = [...form.querySelectorAll('.settings-switch')].map(row => row.getBoundingClientRect());
        return { formLeft:f.left, formRight:f.right, rows:rows.map(r => ({ left:r.left, right:r.right, width:r.width })), scroll:document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      box.rows.forEach(row => assert.ok(row.left >= box.formLeft - 1 && row.right <= box.formRight + 1, `${width}px: switch row stays inside the form`));
      assert.ok(box.scroll <= 1, `${width}px: no horizontal scroll`);
      if (width === 520) box.rows.forEach(row => assert.ok(row.width > (box.formRight - box.formLeft) * 0.9, '520px: one column'));
    }

    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
    console.log('Settings switches UI passed: switches match the server, click / Space flip without saving, live descriptions with times and missing-key warnings, saved as 是 / 否, readable warnings in both themes, one column when narrow.');
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exit(1); });
