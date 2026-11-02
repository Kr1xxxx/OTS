#!/usr/bin/env node
// 续费：每期价格（已发生/未来）、单期或从某期起改价、预计停止快捷选项、列表行编辑按钮与对齐。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { createSubscriptionStore } = require('../mac-app/subscription-store');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
const now = new Date('2026-11-02T10:00:00+08:00');
async function capture(page, name, options = {}) {
  if (!process.env.UI_SCREENSHOT) return;
  await page.waitForTimeout(700);
  await page.screenshot({ path:`${process.env.UI_SCREENSHOT}.${name}.png`, ...options });
}

(async () => {
  const store = createSubscriptionStore(new DatabaseSync(':memory:'));
  const vps = store.save({ name:'搬瓦工', amount:49.99, currency:'USD', cycleUnit:'month', cycleCount:3, startDate:'2025-08-20', category:'VPS', provider:'搬瓦工', paymentMethod:'PayPal', color:'#1f1f23' }).item;
  store.save({ name:'Github 组织x2', amount:8, currency:'USD', cycleUnit:'month', cycleCount:1, startDate:'2026-06-02', category:'软件', provider:'Stripe', color:'#7747ff' });
  store.save({ name:'阿里云域名', note:'example.com', amount:69, currency:'CNY', cycleUnit:'month', cycleCount:12, startDate:'2024-03-25', category:'域名', provider:'阿里云', paymentMethod:'支付宝', autoRenew:false, color:'#e8590c' });
  const errors = [];
  const browser = await chromium.launch({ headless:true });
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport:{ width:1440, height:920 }, timezoneId:'Asia/Shanghai', locale:'zh-CN', colorScheme:theme });
      const page = await context.newPage();
      await page.clock.setFixedTime(now);
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(value => { try { localStorage.setItem('ots-theme', value); } catch (_) {} }, theme);
      await page.route('**/*', async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
        if (pathname === '/api/data') return route.fulfill({ json:{ app:'trade-order-system', revision:1, data:{ orders:[], customers:{}, trashOrders:[], deletedOrders:[], demoCleared:true, demoCustomersCleared:true } } });
        if (pathname.startsWith('/api/subscriptions')) {
          try {
            const body = request.postData() ? JSON.parse(request.postData()) : {};
            const result = pathname === '/api/subscriptions' ? store.list()
              : pathname === '/api/subscriptions/save' ? store.save(body.item)
              : pathname === '/api/subscriptions/options' ? store.setOptions(body) : store.setRate(body);
            return route.fulfill({ json:result });
          } catch (error) {
            return route.fulfill({ status:error.status || 500, json:{ ok:false, message:error.message } });
          }
        }
        return route.fulfill({ json:{ ok:true } });
      });
      await page.goto('http://127.0.0.1:47999/trade-order-system.html#subscriptions');
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const rows = page.locator('#subsList .subs-row');
      await rows.first().waitFor();
      await page.waitForTimeout(900);

      // Alignment: names and meta lines start at the same x in every row; prices and pills end at the same x.
      const geometry = await page.evaluate(() => [...document.querySelectorAll('#subsList .subs-row')].map(row => {
        const box = selector => row.querySelector(selector).getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        return { name:box('.subs-name').left - rowBox.left, meta:box('.subs-meta').left - rowBox.left, amt:rowBox.right - box('.subs-amt').right, pill:rowBox.right - box('.subs-pill').right, height:rowBox.height };
      }));
      geometry.forEach(row => {
        assert.ok(Math.abs(row.name - row.meta) < 1, `name and meta share a left edge: ${JSON.stringify(row)}`);
        assert.ok(Math.abs(row.amt - row.pill) < 1, `price and pill share a right edge: ${JSON.stringify(row)}`);
        assert.ok(Math.abs(row.name - geometry[0].name) < 1 && Math.abs(row.amt - geometry[0].amt) < 1 && Math.abs(row.height - geometry[0].height) < 1, 'every row lines up the same');
      });
      if (theme === 'light') await capture(page, 'list', { clip:{ x:220, y:0, width:1220, height:620 } });

      // The row's edit button opens the editor straight away, not the drawer.
      await rows.filter({ hasText:'搬瓦工' }).locator('[data-sub-edit]').click();
      await page.locator('#subscriptionEditModal.open').waitFor();
      assert.equal(await page.locator('#subscriptionDrawer').evaluate(el => el.classList.contains('open')), false);
      assert.equal(await page.inputValue('#subscriptionName'), '搬瓦工');
      // 预计停止: 本月底 preset.
      const stopChips = page.locator('#subscriptionEditForm [data-sub-opts="stop"] [data-opt-value]');
      assert.deepEqual(await stopChips.allInnerTexts(), ['不停止', '本月底（11/30）', '下个月底（12/31）', '自定义日期']);
      if (theme === 'light') {
        await page.locator('#subscriptionEditForm [data-sub-opts="stop"] [data-opt-value="custom"]').click();
        assert.equal(await page.locator('[data-sub-stop-custom]').isVisible(), true);
        await page.locator('#subscriptionEditForm [data-sub-opts="stop"] [data-opt-value="next"]').click();
        assert.equal(await page.locator('[data-sub-stop-custom]').isVisible(), false);
        assert.match(await page.locator('#subscriptionStopHint').innerText(), /扣费算到 2026-12-31/);
        await page.locator('#subscriptionStopLabel').scrollIntoViewIfNeeded();
        await capture(page, 'editor-stop');
        await page.click('#subscriptionSaveBtn');
        await page.locator('#subscriptionDrawer.open').waitFor();
        await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
        assert.equal(store.list().items.find(item => item.id === vps.id).stopOn, '2026-12-31');
      } else {
        await page.keyboard.press('Escape');
        await rows.filter({ hasText:'搬瓦工' }).click();
        await page.locator('#subscriptionDrawer.open').waitFor();
      }

      // Detail: past periods with their real price, future ones up to the planned stop.
      const periods = page.locator('#subscriptionDrawer .subs-per');
      if (theme === 'light') {
        // Quarterly from 2025-08-20: Aug 20, Nov 20, Feb 20, May 20, Aug 20 happened; Nov 20 is ahead; stop on Dec 31.
        assert.match(await page.locator('.subs-pers-h').innerText(), /已发生 5 期 \$249\.95 · 未来 1 期 \$49\.99/);
        assert.match(await page.locator('.subs-pers-foot').innerText(), /预计 2026-12-31 停止/);
        assert.match(await page.locator('#subscriptionDrawer .subs-kv').innerText(), /预计停止\s*2026-12-31/);
        // Past: record that February actually cost $45.
        await page.locator('[data-sub-action="periods-all"]').click();
        await page.locator('[data-sub-period="2026-02-20"]').click();
        await page.locator('#subscriptionPriceModal.open').waitFor();
        assert.equal(await page.locator('[data-price-scope] [aria-pressed="true"]').innerText(), '只改这一期', 'a paid period defaults to a one-off');
        await page.fill('#subscriptionPriceAmount', '45');
        await page.click('#subscriptionPriceSave');
        await page.waitForFunction(() => !document.getElementById('subscriptionPriceModal').classList.contains('open'));
        await page.waitForFunction(() => /已发生 5 期 \$244\.96/.test(document.querySelector('.subs-pers-h')?.textContent || ''));
        // Future: a price rise from the Nov 20 period on.
        await page.locator('[data-sub-period="2026-11-20"]').click();
        await page.locator('#subscriptionPriceModal.open').waitFor();
        assert.equal(await page.locator('[data-price-scope] [aria-pressed="true"]').innerText(), '从这一期起');
        await page.fill('#subscriptionPriceAmount', '59.99');
        await capture(page, 'price-modal');
        await page.click('#subscriptionPriceSave');
        await page.waitForFunction(() => /\$59\.99/.test(document.querySelector('.subs-price')?.textContent || ''));
        const saved = store.list().items.find(item => item.id === vps.id);
        assert.deepEqual(saved.priceChanges, [{ from:'2026-02-20', amount:45, once:true }, { from:'2026-11-20', amount:59.99, once:false }]);
        assert.match(await periods.filter({ hasText:'第 3 期' }).innerText(), /\$45\.00[\s\S]*单独改价/);
        assert.match(await periods.filter({ hasText:'第 6 期' }).innerText(), /未来[\s\S]*\$59\.99[\s\S]*起调价/);
        await capture(page, 'detail');
        // Restore the one-off price.
        await page.locator('[data-sub-period="2026-02-20"]').click();
        await page.locator('#subscriptionPriceModal.open').waitFor();
        assert.equal(await page.locator('#subscriptionPriceReset').isVisible(), true);
        await page.click('#subscriptionPriceReset');
        await page.waitForFunction(() => /已发生 5 期 \$249\.95/.test(document.querySelector('.subs-pers-h')?.textContent || ''));
        // History uses each charge's own price.
        await page.keyboard.press('Escape');
        await page.evaluate(() => setPage('subs-history'));
        await page.locator('#subsHistory .subs-h-row').first().waitFor();
        assert.match(await page.locator('#subsHistory').innerText(), /搬瓦工[\s\S]*\$49\.99/);
      } else {
        assert.ok(await periods.count() >= 4);
        await capture(page, 'detail-dark');
        await page.locator('[data-sub-period]').last().click();
        await page.locator('#subscriptionPriceModal.open').waitFor();
        await capture(page, 'price-modal-dark');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('subscriptionPriceModal').classList.contains('open'));
        assert.equal(await page.locator('#subscriptionDrawer').evaluate(el => el.classList.contains('open')), true, 'Escape closes only the price dialog');
      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log('Subscription periods UI test passed: aligned rows, row edit button, stop presets, per-period prices (one-off, onward, reset), history, both themes.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
