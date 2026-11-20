// 运单号小卡（拖进已发货后右下角弹出的「补运单号」）不和底下的提示重叠：提示有两三行、带「撤销」、叠了几条时，小卡往上顶；
// 提示走了小卡回到原位（离底 92px）。以前小卡固定离底 92px，只够让开一条一行的提示，三行的「不再提醒补运单号」盖在小卡下面。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const orders = [
  { ...base, id:'p1', num:'K201', client:'Track Card Buyer', amount:700, paidAmount:700, orderType:'全款订单', stage:'production', updated:`${day(1)} 09:01` }
];

const settle = page => h.waitPageTime(page, 800);
const boxes = page => page.evaluate(() => {
  const r = el => { const b = el.getBoundingClientRect(); return { top:b.top, bottom:b.bottom, left:b.left, right:b.right }; };
  const card = document.querySelector('.track-card:not(.leaving)');
  return {
    card:card ? r(card) : null,
    toasts:[...document.querySelectorAll('#toast .toast-item:not(.leaving):not(.is-hidden)')].map(r),
    viewport:window.innerHeight
  };
});
const assertApart = (b, label) => {
  assert.ok(b.card, `${label}: card shown`);
  for (const t of b.toasts) {
    const overlap = t.top < b.card.bottom && t.bottom > b.card.top && t.left < b.card.right && t.right > b.card.left;
    assert.ok(!overlap, `${label}: toast ${JSON.stringify(t)} under card ${JSON.stringify(b.card)}`);
  }
};

(async () => {
  const browser = await launchBrowser();
  try {
    for (const [width, height] of [[1440, 900], [760, 820]]) {
      const { page, errors } = await openBoard(browser, { orders }, { width, height });
      // The board's drop and the stage menu both end here; it shows the 「已移动到已发货」 toast with 撤销 and the card.
      await page.evaluate(() => moveOrderToStage('p1', 'shipment'));
      await page.waitForSelector('#trackingQuickCard');
      await settle(page);
      assertApart(await boxes(page), `${width}: after the move`);

      // A three-line toast with an undo button, like 「…补运单号 / 这张单不再提醒补运单号 · 可在「已处理」里恢复」.
      await page.evaluate(() => uiToast('K26100801 Track Card Buyer 不再提醒补运单号', { desc:'这张单不再提醒补运单号 · 可在「已处理」里恢复', undo:() => {} }));
      await settle(page);
      let b = await boxes(page);
      assertApart(b, `${width}: tall toast`);
      // Pushed up just above the stack, not to the top of the window.
      const stackTop = Math.min(...b.toasts.map(t => t.top));
      assert.ok(stackTop - b.card.bottom <= 24, `${width}: card sits right above the toasts (${stackTop - b.card.bottom}px gap)`);

      // Three stacked toasts.
      await page.evaluate(() => { uiToast('第二条提示', { desc:'带一行说明' }); uiToast('第三条提示，文字长一点会折成两行，看看小卡会不会让开', { desc:'说明' }); });
      await settle(page);
      assertApart(await boxes(page), `${width}: three toasts`);

      // Toasts gone: the card goes back to where the stylesheet puts it.
      await page.evaluate(() => document.querySelectorAll('#toast .toast-item').forEach(item => item.__dismiss?.()));
      await settle(page);
      b = await boxes(page);
      assert.equal(b.toasts.length, 0);
      const cssBottom = await page.evaluate(() => { const card = document.querySelector('.track-card'); return { inline:card.style.bottom, computed:parseFloat(getComputedStyle(card).bottom) }; });
      assert.equal(cssBottom.inline, '', `${width}: inline position cleared`);
      assert.ok(Math.abs(b.viewport - b.card.bottom - cssBottom.computed) < 1, `${width}: back at the stylesheet's place`);

      assert.deepEqual(errors, []);
      await page.context().close();
    }
    console.log('track card stays above the toasts');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
