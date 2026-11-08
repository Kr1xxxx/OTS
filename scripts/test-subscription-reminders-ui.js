#!/usr/bin/env node
// 续费提醒与新增：每项自己的「提前提醒」、按「下次扣费日」录入在用的服务、停止后提醒去服务商取消自动续费、
// 窄窗口的 列表 / 分析 / 历史 切换、分析页数字动画的 @keyframes 没有被多余的 } 吞掉。
// 真实 mac-app/server.js（临时数据目录）+ 真实鼠标键盘；每次点击前确认那一点最上层就是目标。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const pad = n => String(n).padStart(2, '0');
const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const addDays = (text, days) => { const [y, m, d] = text.split('-').map(Number); return localDate(new Date(y, m - 1, d + days)); };
const addMonths = (text, months) => {
  const [y, m, d] = text.split('-').map(Number);
  const last = new Date(y, m - 1 + months + 1, 0).getDate();
  return localDate(new Date(y, m - 1 + months, Math.min(d, last)));
};

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-subscription-reminders-'));
  const port = freePortSync();
  const token = `subscription-reminders-${process.pid}`;
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1' };
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
    const record = async name => (await api('/api/subscriptions')).items.find(item => item.name === name);

    const today = localDate();
    // Auto-renewing monthly, charged in two days, but planned to stop tomorrow: the provider still bills unless turned off there.
    const netflixCharge = addDays(today, 2);
    await api('/api/subscriptions/save', { item:{ name:'Netflix', amount:68, currency:'CNY', cycleUnit:'month', cycleCount:1, startDate:addMonths(netflixCharge, -1), stopOn:addDays(today, 1), category:'软件', provider:'Netflix', color:'#e0336f' } });

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, locale:'zh-CN' });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    await page.goto(`${url}/trade-order-system.html?token=${token}`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('subscriptions'));
    await page.locator('#subsList .subs-row').first().waitFor();

    // Re-locates the element every attempt, waits until it has stopped moving, checks elementFromPoint (see h.click).
    const click = (selector, { locator = null } = {}) => h.click(page, locator || selector, selector || String(locator));
    const bellCards = () => page.locator('#notifList .notif-card[data-sub-id]:not([data-sub-id=""])');

    // ---- 1. Stopped here, still auto-renewing at the provider: the bell says to cancel there ----
    await click('#notifBtn');
    const cancelCard = bellCards().filter({ hasText:'Netflix' });
    await cancelCard.waitFor();
    assert.equal(await cancelCard.locator('.notif-cd').innerText(), '记得取消自动续费');
    assert.match(await cancelCard.locator('small').innerText(), new RegExp(`扣费前去服务商关掉自动续费`));
    // A background redraw while the panel is open (focus reload, a logged event, render()) keeps the same card nodes
    // and does not replay their entrance: the card being clicked is never swapped out from under the mouse.
    await h.settle(page, '#notifList .notif-card');
    const kept = await page.evaluate(() => {
      const before = [...document.querySelectorAll('#notifList .notif-card')];
      uiRenderNotifs();
      render();
      const after = [...document.querySelectorAll('#notifList .notif-card')];
      return { same:before.length === after.length && before.every((el, i) => el === after[i]), running:after.some(el => el.getAnimations().some(a => a.playState === 'running')) };
    });
    assert.deepEqual(kept, { same:true, running:false });
    await click('', { locator:cancelCard });
    await page.locator('#subscriptionDrawer.open [data-sub-action="provider-cancelled"]').waitFor();
    await click('#subscriptionDrawer [data-sub-action="provider-cancelled"]');
    await h.waitToast(page, '在服务商那里取消了自动续费');
    assert.equal((await record('Netflix')).extra.providerCancelledOn, today);
    await page.locator('#subscriptionDrawer [data-sub-action="provider-cancelled"]').waitFor({ state:'detached' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('subscriptionDrawer').classList.contains('open'));
    await click('#notifBtn');
    await page.locator('#notifList').waitFor();
    assert.equal(await bellCards().filter({ hasText:'Netflix' }).count(), 0, 'no reminder once it is cancelled at the provider');
    await page.keyboard.press('Escape');

    // ---- 2. Recording a service already in use: 下次扣费日 sets the start, 提前提醒 is per item ----
    const next = addDays(today, 10);
    await click('#subsAddBtn');
    await page.locator('#subscriptionEditModal.open').waitFor();
    await h.settle(page, '#subscriptionEditModal .subs-modal');
    await page.keyboard.type('Vultr');
    await click('#subscriptionAmount');
    await page.keyboard.type('42');
    assert.equal(await page.locator('#subscriptionNextField').isVisible(), true, 'a new record offers 下次扣费日');
    await click('#subscriptionNext');
    // A date input orders its parts by the browser's own language (月/日/年 in an English Chromium, 年/月/日 in a
    // Chinese one) and moves on by itself after each part: step to the first part, type the digits, and try the
    // next order if the value is not right.
    const [nextYear, nextMonth, nextDay] = next.split('-');
    const parts = { y:nextYear, m:nextMonth, d:nextDay };
    for (const order of ['mdy', 'ymd', 'dmy']) {
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
      await page.keyboard.type([...order].map(key => parts[key]).join(''));
      if (await page.locator('#subscriptionNext').inputValue() === next) break;
    }
    await page.waitForFunction(value => document.getElementById('subscriptionNext').value === value, next);
    assert.equal(await page.locator('#subscriptionStart').inputValue(), addMonths(next, -1), 'the start moves back one cycle');
    // 提前提醒: the in-app select, picked with the mouse.
    const remindButton = page.locator('#subscriptionRemind').locator('xpath=..').locator('.app-select-button');
    assert.match(await remindButton.innerText(), /默认（提前 7 天）/);
    await click('', { locator:remindButton });
    const option = page.locator('.app-select-option', { hasText:'提前 14 天' });
    await click('', { locator:option });
    await page.waitForFunction(() => document.getElementById('subscriptionRemind').value === '14');
    assert.match(await page.locator('#subscriptionAutoRenewText').innerText(), /提前 14 天提醒/);
    assert.match(await page.locator('#subscriptionPreviewWhen').innerText(), /10天后扣费/);
    await click('#subscriptionSaveBtn');
    await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
    await h.waitToast(page, 'Vultr 已添加');
    const vultr = await record('Vultr');
    assert.deepEqual({ startDate:vultr.startDate, remindDays:vultr.extra.remindDays, amount:vultr.amount }, { startDate:addMonths(next, -1), remindDays:14, amount:42 });
    assert.match(await page.locator('#subscriptionDrawer').innerText(), /自动续费，扣费前 14 天提醒/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('subscriptionDrawer').classList.contains('open'));
    // Ten days ahead is inside its own 14-day window (the default 7 would not show it yet).
    await click('#notifBtn');
    const vultrCard = bellCards().filter({ hasText:'Vultr' });
    await vultrCard.waitFor();
    assert.equal(await vultrCard.locator('.notif-cd').innerText(), '10天后扣费');
    await page.keyboard.press('Escape');

    // ---- 3. Analysis: the number animation's keyframes are parsed (a stray } used to swallow them) ----
    await page.evaluate(() => setPage('subs-analysis'));
    await page.locator('#subsAnalysis .arc-metric').first().waitFor();
    const keyframes = await page.evaluate(() => [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules]; } catch (_) { return []; } })
      .filter(rule => rule.type === CSSRule.KEYFRAMES_RULE).map(rule => rule.name));
    assert.ok(keyframes.includes('arcRise') && keyframes.includes('arcLeave'), `arcRise / arcLeave keyframes exist: ${keyframes.join(', ')}`);
    assert.equal(await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.className = 'arc-digit in';
      document.getElementById('subsAnalysis').append(probe);
      const name = getComputedStyle(probe).animationName;
      probe.remove();
      return name;
    }), 'arcRise');

    // ---- 4. Narrow window: the sidebar sub-menu is hidden, the page carries 列表 / 分析 / 历史 ----
    const subnav = page.locator('#page-subs-analysis .subs-subnav');
    assert.equal(await subnav.isVisible(), false, 'wide windows use the sidebar sub-menu');
    await page.setViewportSize({ width:390, height:860 });
    await subnav.waitFor({ state:'visible' });
    assert.equal(await subnav.locator('.active').innerText(), '分析');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scrolling at 390px');
    await click('', { locator:subnav.locator('[data-page="subs-history"]') });
    await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'page-subs-history');
    assert.equal(await page.locator('#page-subs-history .subs-subnav .active').innerText(), '历史');

    assert.deepEqual(dialogs, [], 'no native alert / confirm / prompt');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Subscription reminders UI test passed: provider-cancel reminder and 已在服务商取消, 下次扣费日 start, per-item 提前提醒 in the editor, drawer and bell, arcRise keyframes, narrow-window sub-navigation, real server.');
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); setTimeout(resolve, 3000); });
    try { fs.rmSync(dataDir, { recursive:true, force:true }); } catch (_) {}
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
