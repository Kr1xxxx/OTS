#!/usr/bin/env node
// 订阅的二级菜单、分析子页和历史子页：数字按扣费周期推算，只读订阅数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { createSubscriptionStore } = require('../mac-app/subscription-store');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
async function capture(page, name, options = {}) {
  if (!process.env.UI_SCREENSHOT) return;
  await page.waitForTimeout(900);
  await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.${name}.png`, ...options });
}
const now = new Date('2026-03-18T07:00:00+08:00');

function seededStore() {
  const store = createSubscriptionStore(new DatabaseSync(':memory:'));
  [
    { name:'1Password', note:'家庭版', amount:35.88, currency:'USD', cycleMonths:12, startDate:'2022-05-18', category:'工具效率', color:'#2f6fde' },
    { name:'ChatGPT Plus', note:'个人账号', amount:20, currency:'USD', cycleMonths:1, startDate:'2025-11-18', category:'AI', color:'#5b3cc4', paymentMethod:'信用卡' },
    { name:'阿里云域名', note:'', amount:69, currency:'CNY', cycleMonths:12, startDate:'2025-03-25', category:'其他', color:'#e8590c', paymentMethod:'支付宝' },
    { name:'Spotify', note:'', amount:15, currency:'CNY', cycleMonths:1, startDate:'2025-06-01', category:'其他', color:'#0f9d8a', paymentMethod:'微信支付', status:'cancelled', endsOn:'2026-01-01' }
  ].forEach(item => store.save(item));
  return store;
}

(async () => {
  const browser = await chromium.launch({ headless:true });
  const errors = [];
  try {
    const store = seededStore();
    const context = await browser.newContext({ viewport:{ width:1360, height:900 }, timezoneId:'Asia/Shanghai', locale:'zh-CN' });
    const page = await context.newPage();
    await page.clock.setFixedTime(now);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:1, data:{ orders:[], customers:{}, trashOrders:[], deletedOrders:[], demoCleared:true, demoCustomersCleared:true } } });
      if (pathname === '/api/subscriptions') return route.fulfill({ json:store.list() });
      return route.fulfill({ json:{ ok:true } });
    });

    // The second-level menu stays closed until a subscription page opens.
    await page.goto('http://127.0.0.1:47999/trade-order-system.html#dashboard');
    const sub = page.locator('#navSubs');
    assert.equal(await sub.evaluate(el => el.classList.contains('open')), false);
    assert.equal(await sub.evaluate(el => el.getBoundingClientRect().height), 0);
    await page.locator('.nav-item[data-page="subscriptions"]').click();
    await page.locator('#subsList .subs-row').first().waitFor();
    assert.equal(await sub.evaluate(el => el.classList.contains('open')), true);
    assert.deepEqual(await sub.locator('.nav-sub-item').allInnerTexts(), ['订阅列表', '分析', '历史']);
    assert.equal(await sub.locator('.nav-sub-item.active').innerText(), '订阅列表');

    // Analysis: KPIs, 18 monthly bars, category and payment-method shares, top list.
    await sub.locator('[data-page="subs-analysis"]').click();
    await page.locator('#subsAnalysis .subs-kpi').first().waitFor();
    assert.equal(await page.locator('.page-title').innerText(), '订阅分析');
    assert.equal(new URL(page.url()).hash, '#subs-analysis');
    assert.equal(await page.locator('.nav-item[data-page="subscriptions"]').getAttribute('class'), 'nav-item active', 'the parent item stays lit');
    assert.equal(await sub.locator('.nav-sub-item.active').innerText(), '分析');
    const kpis = await page.locator('#subsAnalysis .subs-kpi').allInnerTexts();
    assert.match(kpis[0], /本月扣费\s*¥211\.00\s*已扣 ¥142 · 待扣 ¥69/);
    assert.match(kpis[1], /2026 年已付\s*¥426\.00\s*3 笔扣费/);
    assert.match(kpis[2], /未来 12 个月预计\s*¥2,027\.75/);
    assert.match(kpis[3], /累计已付\s*¥1,902\.99/);
    const bars = page.locator('#subsAnalysis .subs-bar');
    assert.equal(await bars.count(), 18);
    assert.deepEqual(await bars.evaluateAll(list => list.map(bar => bar.className.replace('subs-bar ', '')).join(',')),
      [...Array(11).fill('past'), 'now', ...Array(6).fill('plan')].join(','));
    assert.match(await bars.nth(11).getAttribute('aria-label'), /2026年3月，AI ¥142\.00，其他 ¥69\.00，合计 ¥211\.00（已扣 ¥142\.00）/);
    await bars.nth(13).hover();
    assert.match(await page.locator('#subsAnalysis .subs-tip').innerText(), /2026年5月[\s\S]*工具效率 ¥254\.75[\s\S]*AI ¥142\.00[\s\S]*合计 ¥396\.75（预计）/);
    const panels = page.locator('#subsAnalysis .subs-panel');
    assert.match(await page.locator('.subs-donut-c').innerText(), /¥169\s*每月/);
    assert.match(await panels.nth(1).innerText(), /工具效率\s*1 项\s*¥21\.23\s*13%[\s\S]*AI\s*1 项\s*¥142\.00\s*84%[\s\S]*其他\s*1 项\s*¥5\.75\s*3\.4%/);
    assert.match(await panels.nth(2).innerText(), /信用卡[\s\S]*未填写[\s\S]*支付宝/);
    assert.deepEqual(await page.locator('#subsAnalysis .subs-top-n b').allInnerTexts(), ['ChatGPT Plus', '1Password', '阿里云域名']);
    await capture(page, 'analysis', { fullPage:true });

    // A category row jumps to the list filtered to that category.
    await page.locator('[data-subs-go-filter="AI"]').click();
    await page.locator('#subsFilter [aria-pressed="true"]', { hasText:'AI' }).waitFor();
    assert.deepEqual(await page.locator('#subsList .subs-name').allInnerTexts(), ['ChatGPT Plus']);
    await page.locator('#subsFilter [data-sub-filter="all"]').click();

    // History: newest month first, 12 months at a time, an ended subscription shows once.
    await sub.locator('[data-page="subs-history"]').click();
    await page.locator('#subsHistory .subs-h-row').first().waitFor();
    assert.equal(await page.locator('.page-title').innerText(), '订阅历史');
    assert.equal(await page.locator('#subsHistoryMeta').innerText(), '共 17 笔 · 合计 ¥1,902.99');
    const heads = page.locator('#subsHistory .subs-h-head b');
    assert.equal(await heads.count(), 12);
    assert.deepEqual((await heads.allInnerTexts()).slice(0, 3), ['2026年3月', '2026年2月', '2026年1月']);
    assert.match(await page.locator('#subsHistory .subs-h-month').first().innerText(), /2026年3月\s*1 笔 · ¥142\.00[\s\S]*18\s*3月 · 周三[\s\S]*ChatGPT Plus\s*第 5 次扣费 · 月付 · 信用卡\s*\$20\.00\s*≈¥142\.00/);
    assert.match(await page.locator('#subsHistory .subs-h-month').nth(2).innerText(), /Spotify\s*已取消，到期停用\s*已到期/);
    await capture(page, 'history', { fullPage:true });
    await page.locator('[data-subs-history-more]').click();
    assert.equal(await heads.count(), 15);
    assert.match(await page.locator('#subsHistory .subs-h-month').last().innerText(), /2022年5月[\s\S]*1Password\s*首次扣费 · 年付\s*\$35\.88/);
    assert.equal(await page.locator('[data-subs-history-more]').count(), 0);
    await page.locator('#subsHistoryFilter [data-sub-history-filter="AI"]').click();
    assert.equal(await page.locator('#subsHistoryMeta').innerText(), '共 5 笔 · 合计 ¥710.00');
    await page.locator('#subsHistorySearch').fill('spotify');
    await page.locator('#subsHistory .subs-empty').waitFor();
    await page.locator('#subsHistorySearch').fill('');
    await page.locator('#subsHistoryFilter [data-sub-history-filter="all"]').click();
    await page.locator('#subsHistory .subs-h-row', { hasText:'阿里云域名' }).click();
    await page.locator('.subs-drawer .subs-card').first().waitFor();
    assert.equal(await page.locator('.page-title').innerText(), '订阅');
    await page.keyboard.press('Escape');

    // Leaving the subscription pages closes the menu.
    await page.locator('.nav-item[data-page="settings"]').click();
    assert.equal(await sub.evaluate(el => el.classList.contains('open')), false);

    // Dark mode and narrow screens fit without horizontal scrolling; phones switch pages with in-page tabs.
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => applyTheme(value), theme);
      for (const target of ['subs-analysis', 'subs-history']) {
        await page.evaluate(value => setPage(value), target);
        for (const width of [1360, 900, 390]) {
          await page.setViewportSize({ width, height:900 });
          await page.waitForTimeout(120);
          const fit = await page.evaluate(id => {
            const el = document.getElementById(`page-${id}`);
            const tooWide = [...el.querySelectorAll('.subs-panel, .subs-kpi, .subs-h-row, .subs-toolbar, .subs-tabs')]
              .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className);
            return { page:document.documentElement.scrollWidth > window.innerWidth + 1, tooWide };
          }, target);
          assert.deepEqual(fit, { page:false, tooWide:[] }, `${target} must fit at ${width}px in ${theme} theme`);
          assert.equal(await page.locator(`#page-${target} .subs-tabs`).isVisible(), width === 390);
          if (theme === 'dark' && width !== 900) await capture(page, `${target}.${theme}.${width}`, { fullPage:true });
        }
      }
    }
    await page.locator('#page-subs-history .subs-tabs [data-page="subs-analysis"]').click();
    assert.equal(await page.locator('.page-title').innerText(), '订阅分析');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Subscription analysis UI test passed: second-level menu, KPIs, monthly bars and tooltip, shares, top list, filter jump, history months/more/filter/search/detail, themes and widths.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
