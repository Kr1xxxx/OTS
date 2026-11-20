// TEMPORARY measurement for the scroll PR, removed before merge. Fails on purpose so run-tests prints the numbers.
const { launchBrowser, openBoard, base, day } = require('./helpers/board-page');
const stages = ['production', 'quote', 'ready', 'shipped'];
const orders = Array.from({ length:60 }, (_, i) => ({ ...base, id:`o${i}`, num:`L${i}`, client:`Buyer ${i % 30}`, amount:200 + i, paidAmount:i % 3 ? 100 : 200 + i, orderType:'定金订单', stage:stages[i % 4], createdAt:day(i % 20), updated:`${day(i % 20)} 09:00` }));
const oldCss = `
@keyframes probeAwake { 0% { box-shadow:0 0 6px color-mix(in oklab, var(--s-green) 70%, transparent), 0 0 0 0 color-mix(in oklab, var(--s-green) 55%, transparent); } 100% { box-shadow:0 0 6px color-mix(in oklab, var(--s-green) 70%, transparent), 0 0 0 7px transparent; } }
html[data-theme] .world-clock.is-awake::after { display:none !important; }
html[data-theme] .world-clock.is-awake::before { animation:probeAwake 2.4s var(--ease) infinite !important; }`;
(async () => {
  const browser = await launchBrowser();
  const results = {};
  try {
    for (const variant of ['old', 'anim', 'wheel', 'new', 'old', 'anim', 'wheel', 'new']) {
      const { page } = await openBoard(browser, { orders }, { width:1440, height:900 });
      await page.evaluate(({ css, old }) => {
        document.querySelectorAll('.world-clock').forEach(c => c.classList.add('is-awake'));
        if (old === 'old' || old === 'anim') { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }
        if (old === 'old' || old === 'wheel') {
          document.addEventListener('wheel', e => { if (e.target.closest?.('.modal-backdrop.open')) e.preventDefault(); }, { capture:true, passive:false });
        }
      }, { css:oldCss, old:variant });
      await page.waitForTimeout(1200);
      // Idle: how late do 0 ms timers fire (main thread busy painting the animation shows up here).
      const idleLag = await page.evaluate(() => new Promise(resolve => {
        const lags = []; const end = performance.now() + 1500;
        const step = () => { const t = performance.now(); setTimeout(() => { lags.push(performance.now() - t); if (performance.now() < end) step(); else resolve({ n:lags.length, mean:lags.reduce((a, b) => a + b, 0) / lags.length }); }, 0); };
        step();
      }));
      await page.mouse.move(700, 500);
      await page.evaluate(() => { window.__f = []; window.__s = []; let last = performance.now(); const tick = t => { window.__f.push(t - last); last = t; if (window.__f.length < 600) requestAnimationFrame(tick); }; requestAnimationFrame(tick); window.addEventListener('scroll', () => window.__s.push(performance.now()), { passive:true }); });
      const t0 = Date.now();
      for (let i = 0; i < 60; i += 1) { await page.mouse.wheel(0, i < 30 ? 80 : -80); await page.waitForTimeout(16); }
      const wall = Date.now() - t0;
      const m = await page.evaluate(() => { const f = window.__f.slice(2).sort((a, b) => a - b); return { frames:f.length, p50:f[Math.floor(f.length * 0.5)], p95:f[Math.floor(f.length * 0.95)], max:f[f.length - 1], over25:f.filter(x => x > 25).length, scrollEvents:window.__s.length }; });
      (results[variant] ||= []).push({ idleLag, wall, ...m });
      await page.context().close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(results, null, 1));
  process.exitCode = 1;
})();
