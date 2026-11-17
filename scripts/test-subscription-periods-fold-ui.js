#!/usr/bin/env node
// 续费页整理（页面第二轮 6a / 6b / 6d）：只改摆法和文字，数字的算法不动。
// - 6a 列表页概览：小标写「N 项续费中」；没有不再续费的就不写「0 项不再续费」。
// - 6b 分析页「每月扣费」标题旁是两个图例（已扣 / 还没到扣费日），操作提示进 title；「类型占比」只写「按月均花费」。
// - 6d 详情「周期费用」：未来第二期起同价的几期并成一行「第 6 到 10 期都是 $15.00」，展开后逐期列出（改价铅笔都在），
//   单独改价的那一期单独成行；资料里没填的预计停止、付款方式、服务商不列，不写「未设置」。
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSubscriptionStore } = require('../mac-app/subscription-store');
const { launchBrowser, h } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

const now = new Date('2026-11-16T10:00:00+08:00');

(async () => {
  const store = createSubscriptionStore(new DatabaseSync(':memory:'));
  // Monthly $15 since 8/9: periods 1–4 happened (4 = 本期), 5 is next, 6–10 are the same price.
  const plain = store.save({ name:'fold-plain.test', amount:15, currency:'USD', cycleUnit:'month', cycleCount:1, startDate:'2026-08-09', category:'VPS', color:'#1971c2' }).item;
  // Same, with 2027-02-09 (period 7) priced on its own: 6 alone, 7 alone, 8–10 fold.
  store.save({ name:'fold-once.test', amount:15, currency:'USD', cycleUnit:'month', cycleCount:1, startDate:'2026-08-09', category:'VPS', provider:'Made-up Host', paymentMethod:'PayPal', color:'#0f9d8a',
    priceChanges:[{ from:'2027-02-09', amount:12, once:true }] });
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, timezoneId:'Asia/Shanghai', locale:'zh-CN' });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', '2026-11-16'); } catch (_) {} });
    const page = await context.newPage();
    await page.clock.setFixedTime(now);
    page.on('pageerror', error => errors.push(error.message));
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
    await page.goto('http://127.0.0.1:47996/trade-order-system.html#subscriptions');
    await page.waitForFunction(() => subscriptionState.loaded && subscriptionState.items.length === 2);
    await page.locator('#subsList .subs-row').first().waitFor();
    await h.quiet(page);
    const row = name => page.locator('#subsList .subs-row', { hasText:name });
    const click = locator => h.click(page, locator, String(locator));
    const drawer = page.locator('#subscriptionDrawer');
    // Each row of 周期费用 as text: 「第 N 期|tag|amount|edit?」, a folded row as its own text.
    const listed = () => drawer.locator('.subs-pers-list > *').evaluateAll(rows => rows.map(row => row.classList.contains('fold')
      ? [...row.children].map(child => child.textContent.replace(/\s+/g, ' ').trim()).join(' ')
      : [row.querySelector('.subs-per-n b').textContent, row.querySelector('.subs-pill').textContent, row.querySelector('.subs-per-v b').textContent, row.querySelector('[data-sub-period]') ? 'edit' : ''].join('|')));

    // ---- 6a: nothing cancelled, no 「0 项」 ----
    const side = await page.locator('#subsHeroSide').innerText();
    assert.match(side, /^2 项续费中\n/);
    assert.doesNotMatch(side, /0 项|不再续费/);

    // ---- 6d: future periods at the same price fold into one row ----
    await click(row('fold-plain.test'));
    await drawer.locator('.subs-per').first().waitFor();
    const header = await drawer.locator('.subs-pers-h').innerText();
    assert.match(header, /已发生 4 期 \$60\.00 · 未来 6 期 \$90\.00/, 'the header counts every period as before');
    assert.deepEqual(await listed(), [
      '第 2 期|已发生|$15.00|edit', '第 3 期|已发生|$15.00|edit', '第 4 期|本期|$15.00|edit', '第 5 期|未来|$15.00|edit',
      '第 6 到 10 期都是 $15.00 展开'
    ]);
    await click(drawer.locator('[data-sub-action="periods-future"]'));
    await page.waitForFunction(() => document.activeElement?.dataset.subAction === 'periods-future-fold', null, { timeout:3000 });
    const expanded = await listed();
    assert.equal(expanded.length, 9);
    assert.deepEqual(expanded.slice(4), ['第 6 期|未来|$15.00|edit', '第 7 期|未来|$15.00|edit', '第 8 期|未来|$15.00|edit', '第 9 期|未来|$15.00|edit', '第 10 期|未来|$15.00|edit'],
      'expanded, each period has its own row and price pencil');
    assert.equal(await drawer.locator('[data-sub-action="periods-future-fold"]').innerText(), '收起');
    await click(drawer.locator('[data-sub-action="periods-future-fold"]'));
    await page.waitForFunction(() => document.activeElement?.dataset.subAction === 'periods-future', null, { timeout:3000 });
    assert.equal((await listed()).length, 5);
    // Not filled in: no 未设置 rows.
    const kv = await drawer.locator('.subs-kv').innerText();
    assert.doesNotMatch(kv, /未设置|未填写/);
    assert.doesNotMatch(kv, /预计停止|付款方式|服务商/);
    assert.match(kv, /扣费周期[\s\S]*币种/);
    // Expanded, then reopened: folded again.
    await click(drawer.locator('[data-sub-action="periods-future"]'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('subscriptionDrawer').classList.contains('open'));

    // ---- 6d: a period priced on its own stays on its own row ----
    await click(row('fold-once.test'));
    await drawer.locator('.subs-per').first().waitFor();
    assert.deepEqual((await listed()).slice(3), ['第 5 期|未来|$15.00|edit', '第 6 期|未来|$15.00|edit', '第 7 期|未来|$12.00|edit', '第 8 到 10 期都是 $15.00 展开'],
      'the one-off period splits the run: 6 alone, 7 alone (单独改价), 8–10 folded');
    assert.match(await drawer.locator('.subs-per[data-period="2027-02-09"]').innerText(), /单独改价/);
    assert.match(await drawer.locator('.subs-kv').innerText(), /服务商\s*Made-up Host[\s\S]*付款方式\s*PayPal/, 'filled-in rows stay');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('subscriptionDrawer').classList.contains('open'));
    await click(row('fold-plain.test'));
    await drawer.locator('.subs-per').first().waitFor();
    assert.equal(await drawer.locator('.subs-per.fold').count(), 1, 'another item opened in between: folded again');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('subscriptionDrawer').classList.contains('open'));
    assert.equal(store.list().items.find(item => item.id === plain.id).updatedAt, plain.updatedAt, 'folding saves nothing');

    // ---- 6b: legend next to the chart title, hints in title ----
    await page.evaluate(() => setPage('subs-analysis'));
    await page.locator('#subsArcBars .arc-scrubber').waitFor();
    const barsHeader = page.locator('#subsArcBars').locator('xpath=preceding-sibling::header');
    assert.deepEqual(await barsHeader.locator('.subs-chart-key li').allInnerTexts(), ['已扣', '还没到扣费日（本月待扣和之后 6 个月的预计）']);
    assert.equal(await barsHeader.locator('p').count(), 0, 'the long sentence is gone');
    assert.equal(await page.locator('#subsArcBars').getAttribute('title'), '鼠标在图上移动或按方向键查看每个月');
    assert.match(await page.locator('#subsArcBars .arc-scrubber').getAttribute('aria-label'), /按月份查看/, 'the slider still names itself for screen readers');
    const keyColors = await barsHeader.locator('.subs-chart-key i').evaluateAll(marks => marks.map(mark => { const s = getComputedStyle(mark); return [s.backgroundColor, s.borderStyle]; }));
    const barColors = await page.evaluate(() => ['.arc-bar-mark:not(.plan)', '.arc-bar-mark.plan'].map(selector => getComputedStyle(document.querySelector(`#subsArcBars ${selector}`)).fill));
    assert.deepEqual(keyColors.map(([color]) => color), barColors, 'the legend uses the bars’ own fills');
    assert.equal(keyColors[1][1], 'dashed');
    const categoryHeader = page.locator('#subsArcCategory').locator('xpath=preceding-sibling::header');
    assert.equal(await categoryHeader.locator('p').innerText(), '按月均花费');
    assert.match(await page.locator('#subsArcCategory').getAttribute('title'), /点图例（或按空格）显示或隐藏/);
    assert.match(await page.locator('#subsArcCategory .arc-legend').getAttribute('aria-label'), /空格/, 'the legend keeps its keyboard hint for screen readers');

    assert.deepEqual(errors, []);
    console.log('Subscription page tidy passed: hero says N 项续费中 without 0 项不再续费; future periods at one price fold into one row (expand / collapse, one-off price on its own row, reset on reopen); empty detail rows left out; chart legends instead of the long notes.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
