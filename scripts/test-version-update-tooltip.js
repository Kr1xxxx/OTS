#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

// Catches startup-time substitution, stale hover ages, malformed/future dates,
// and accidental persistence while merely viewing release information.
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({timezoneId:'Asia/Taipei'});
    let updatedAt = '2026-10-06T09:00:00.000Z', saves = 0;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({time:new Date('2026-10-06T09:08:30Z')});
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'trade-order-system.html'),'utf8')});
      if (pathname === '/api/data') return route.fulfill({json:{app:'trade-order-system',revision:0,data:{demoCleared:true,demoCustomersCleared:true,orders:[],customers:{}}}});
      if (pathname === '/api/health') return route.fulfill({json:{ok:true,storageMode:'sqlite',appUpdatedAt:updatedAt}});
      if (pathname === '/api/save') saves++;
      return route.fulfill({json:{ok:true,enabled:'否'}});
    });
    async function load() {
      await page.goto('http://127.0.0.1:47999/trade-order-system.html');
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    }
    await load();
    const badge = page.locator('.app-version');
    const version = await badge.innerText();
    assert.equal(await badge.getAttribute('title'),'8 分钟前更新\n更新时间：2026-10-06 17:00:00');
    await page.clock.setSystemTime(new Date('2026-10-06T11:08:30Z'));
    await badge.hover();
    assert.equal(await badge.getAttribute('title'),'2 小时前更新\n更新时间：2026-10-06 17:00:00','hover must derive fresh age');
    await load();
    assert.equal(await badge.getAttribute('title'),'2 小时前更新\n更新时间：2026-10-06 17:00:00','reload must preserve update time');
    await page.clock.setSystemTime(new Date('2026-10-09T09:08:30Z'));
    await badge.focus();
    assert.equal(await badge.getAttribute('title'),'3 天前更新\n更新时间：2026-10-06 17:00:00');
    assert.equal(await badge.getAttribute('aria-label'),`${version}，3 天前更新，更新时间：2026-10-06 17:00:00`);
    updatedAt = '2026-10-09T09:08:00Z'; await load();
    assert.match(await badge.getAttribute('title'),/^刚刚更新\n/);
    updatedAt = '2026-10-09T09:07:00Z'; await load();
    assert.match(await badge.getAttribute('title'),/^1 分钟前更新\n/);
    for (const invalid of [undefined,'','not-a-date']) {
      updatedAt = invalid; await load();
      assert.equal(await badge.getAttribute('title'),'更新时间未知','missing metadata must not pretend to be a new release');
    }
    updatedAt = '2026-10-10T09:00:00Z'; await load();
    assert.equal(await badge.getAttribute('title'),'更新时间待确认\n更新时间：2026-10-10 17:00:00','future time must not invent a negative age');
    assert.equal(await badge.innerText(),version,'tooltip must not change badge content');
    assert.equal(saves,0,'hover/focus/reload must not save business records');
    assert.deepEqual(errors,[]);
    console.log('Version tooltip passed: build timestamp, fresh hover/focus age, reload, unknown/future dates, no saves.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
