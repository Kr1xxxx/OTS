const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const browser = await chromium.launch({headless:true, ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
  try {
    const page = await browser.newPage();
    for (const width of [1200, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({width, height:800});
      let baseline;
      for (const count of [1, 6, 30]) {
        const card = `<article class="board-card product-lash"><div class="board-card-head"><div class="board-card-title">Test Customer</div></div><div class="board-info-grid"><div class="board-info-item"><div class="board-info-label">订单号</div><div class="board-info-value">SO26091001</div></div><div class="board-info-item"><div class="board-info-label">下单时间</div><div class="board-info-value">09-10</div></div></div><div class="board-card-footer"><div class="board-card-meta"><span class="tag">睫毛</span></div><div class="board-card-amount">$402 USD</div></div></article>`;
        await page.setContent(`<html data-theme="${theme}"><head><style>${styles}</style></head><body><div id="page-dashboard"><div class="board-column" style="width:220px"><div class="board-column-head">生产中 ${count}</div><div class="board-card-list">${card.repeat(count)}</div></div></div></body></html>`);
        const result = await page.evaluate(() => {
          const list = document.querySelector('.board-card-list');
          const cards = [...list.children];
          const heights = cards.map(c => c.getBoundingClientRect().height);
          const clipped = cards.some(c => [...c.querySelectorAll('.board-info-value')].some(v => v.getBoundingClientRect().bottom > v.closest('.board-info-grid').getBoundingClientRect().bottom));
          list.scrollTop = list.scrollHeight;
          return {heights, clipped, overflowing:list.scrollHeight > list.clientHeight, lastVisible:cards.at(-1).getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1};
        });
        baseline ??= result.heights[0];
        assert(result.heights.every(h => Math.abs(h-baseline)<1), `${width}/${theme}/${count}: cards compressed`);
        assert(!result.clipped, 'Order information clipped');
        if (count === 30) assert(result.overflowing, 'Long lists must scroll');
        assert(result.lastVisible, 'Last order must be reachable');
      }
    }
    console.log('Board layout passed: 1/6/30 cards, desktop/mobile, light/dark.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
