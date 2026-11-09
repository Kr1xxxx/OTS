const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, day } = require('./helpers/board-page');

// 看板布局用真实的 renderPipeline 卡片测：4 列表头结构和高度一致；所有卡片同高（有 / 没有「下一步」、加急、草稿、
// 超长客户名、有 / 没有待收、带运单号、部分发货、没有国旗），多种宽度、浅色 / 深色都一样。
// 以前这里拼的是旧卡片结构，「没写下一步」那一行被全局 .empty 样式套成虚线大框、卡片高 29px 也测不出来。
const orders = [
  { ...base, id:'q1', num:'K1', client:'Quote Deposit', amount:1000, paidAmount:0, depositAmount:300, orderType:'定金订单', stage:'quote', updated:`${day(1)} 09:01` },
  { ...base, id:'q2', num:'K2', client:'A Very Long Customer Name International Trading Company Limited', country:'', amount:1500, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(1)} 09:02` },
  { ...base, id:'d1', num:'K3', client:'Draft Buyer', amount:900, paidAmount:0, orderType:'定金订单', stage:'quote', isDraft:true, updated:`${day(1)} 09:03` },
  { ...base, id:'p1', num:'K4', client:'Prod Full', amount:1000, paidAmount:1000, orderType:'全款订单', stage:'production', updated:`${day(1)} 09:04` },
  { ...base, id:'p2', num:'K5', client:'Prod Urgent', amount:700, paidAmount:300, orderType:'定金订单', stage:'production', urgentOrder:true, next:'Call supplier about the very long next step text that should be truncated in one line', updated:`${day(1)} 09:05` },
  { ...base, id:'b1', num:'K6', client:'Balance Co', amount:2000, paidAmount:600, depositAmount:600, orderType:'定金订单', stage:'balance', next:'Send PI', updated:`${day(1)} 09:06` },
  { ...base, id:'s1', num:'K7', client:'Ship Tracked', amount:1200, paidAmount:1200, orderType:'全款订单', stage:'shipment', logisticsStatus:'运输中', shippedAt:day(2), trackingNumber:'1234567890', carrier:'DHL', shipments:[{ id:'x1', trackingNumber:'1234567890', carrier:'DHL', status:'运输中', shippedAt:day(2) }], updated:`${day(1)} 09:07` },
  { ...base, id:'s2', num:'K8', client:'Ship Partial', amount:900, paidAmount:900, orderType:'全款订单', stage:'shipment', partialShipment:true, logisticsStatus:'已发货', shippedAt:day(2), trackingNumber:'1Z999AA10123456784', carrier:'UPS', shipments:[{ id:'x2', trackingNumber:'1Z999AA10123456784', carrier:'UPS', status:'已发货', shippedAt:day(2) }], updated:`${day(1)} 09:08` },
  { ...base, id:'s3', num:'K9', client:'Ship NoTrack', amount:900, paidAmount:900, orderType:'全款订单', stage:'shipment', logisticsStatus:'已发货', shippedAt:day(2), updated:`${day(1)} 09:09` }
];
// 一列 30 张：列表要能滚，最后一张能滚到。
const many = Array.from({ length:30 }, (_, i) => ({ ...base, id:`m${i}`, num:`M${i}`, client:`Many ${i}`, amount:100 + i, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(2)} 10:${String(i).padStart(2, '0')}` }));

const measure = page => page.evaluate(() => {
  const columns = [...document.querySelectorAll('#pipeline .board-column[data-stage]')];
  const cards = [...document.querySelectorAll('#pipeline .board-card[data-id]')];
  const emptyNext = document.querySelector('#pipeline .oc-next.is-empty');
  const emptyStyle = emptyNext ? getComputedStyle(emptyNext) : null;
  return {
    stages:columns.map(col => col.dataset.stage),
    titles:columns.map(col => col.querySelector('.board-column-title')?.textContent.trim() || ''),
    heads:columns.map(col => {
      const head = col.querySelector('.board-column-head');
      return { h:Math.round(head.getBoundingClientRect().height * 10) / 10, parts:[...head.querySelectorAll('.board-column-title, .board-column-meta, .board-column-sub')].length };
    }),
    columnHeights:columns.map(col => Math.round(col.getBoundingClientRect().height)),
    cards:cards.map(card => ({ id:card.dataset.id, h:Math.round(card.getBoundingClientRect().height * 10) / 10, next:card.querySelector('.oc-next')?.className || '' })),
    oldEmptyClass:document.querySelectorAll('#pipeline .oc-next.empty').length,
    emptyStyle:emptyStyle && { borderStyle:emptyStyle.borderBottomStyle, paddingLeft:emptyStyle.paddingLeft, height:emptyNext.getBoundingClientRect().height, setHeight:document.querySelector('#pipeline .oc-next:not(.is-empty)')?.getBoundingClientRect().height }
  };
});

(async () => {
  const browser = await launchBrowser();
  try {
    for (const theme of ['light', 'dark']) {
      const { page, context, errors, dialogs } = await openBoard(browser, { orders:[...orders, ...many] }, { theme });
      for (const width of [1440, 1294, 1100, 820, 390]) {
        await page.setViewportSize({ width, height:900 });
        await page.waitForFunction(w => window.innerWidth === w, width);
        const result = await measure(page);
        const label = `${theme}/${width}`;
        assert.deepEqual(result.stages, ['quote', 'production', 'balance', 'shipment'], `${label}: 看板列顺序不变`);
        // 「尾款」列 2026-11-09 改名「待发货」（key 还是 balance）。
        assert(result.titles[2].includes('待发货') && !result.titles.some(t => t.includes('尾款')), `${label}: 第 3 列叫「待发货」 ${JSON.stringify(result.titles)}`);
        assert.equal(new Set(result.heads.map(item => item.h)).size, 1, `${label}: 4 列表头高度不一致 ${JSON.stringify(result.heads)}`);
        assert(result.heads.every(item => item.parts === 3), `${label}: 每列表头都要有标题、数量金额、副标题`);
        assert.equal(new Set(result.columnHeights).size, 1, `${label}: 4 列高度不一致 ${result.columnHeights}`);
        const heights = result.cards.map(card => card.h);
        assert(Math.max(...heights) - Math.min(...heights) < 0.6, `${label}: 卡片不同高 ${JSON.stringify(result.cards.filter(card => Math.abs(card.h - heights[0]) >= 0.6))} vs ${heights[0]}`);
        assert(result.cards.every(card => card.next), `${label}: 有一张写了下一步，所有卡片都留「下一步」这一行`);
        assert.equal(result.oldEmptyClass, 0, '没写下一步的那一行不能再叫 .empty（会撞上全局空状态样式）');
        assert.notEqual(result.emptyStyle.borderStyle, 'dashed', `${label}: 「未设下一步」被画成了虚线框`);
        assert(Math.abs(result.emptyStyle.height - result.emptyStyle.setHeight) < 0.6, `${label}: 「未设下一步」行 ${result.emptyStyle.height}px，写了下一步的行 ${result.emptyStyle.setHeight}px`);
        // 一列 30 张：能滚动，最后一张能滚到。
        const scroll = await page.evaluate(() => {
          const list = document.querySelector('#pipeline .board-column[data-stage="quote"] .board-card-list');
          list.scrollTop = list.scrollHeight;
          const last = list.lastElementChild.getBoundingClientRect();
          return { overflowing:list.scrollHeight > list.clientHeight, lastVisible:last.bottom <= list.getBoundingClientRect().bottom + 1 };
        });
        assert(scroll.overflowing, `${label}: 长列表必须能滚动`);
        assert(scroll.lastVisible, `${label}: 最后一张卡片滚不到`);
      }
      // 放不下四列（Mac App 最小窗口 + 120% 缩放 ≈ 917px 宽）：右侧渐隐，提示右边还有列；横向滚到底后换成左侧渐隐。
      await page.setViewportSize({ width:917, height:900 });
      await page.waitForFunction(() => window.innerWidth === 917);
      const boardMax = await page.evaluate(() => { const b = document.querySelector('.workspace-board'); b.scrollLeft = 0; return b.scrollWidth - b.clientWidth; });
      assert(boardMax > 0, `${theme}/917: 这个宽度下看板本来就放不下四列`);
      await page.waitForFunction(() => { const b = document.querySelector('.workspace-board'); return b.hasAttribute('data-more-right') && !b.hasAttribute('data-more-left'); });
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.workspace-board')).maskImage), 'none', `${theme}/917: 右侧要有渐隐`);
      const headBox = await page.locator('#pipeline .board-column[data-stage="quote"] .board-column-head').boundingBox();
      await page.mouse.move(headBox.x + headBox.width / 2, headBox.y + headBox.height / 2);
      await page.mouse.wheel(boardMax + 50, 0);
      await page.waitForFunction(() => { const b = document.querySelector('.workspace-board'); return b.hasAttribute('data-more-left') && !b.hasAttribute('data-more-right'); });
      await page.setViewportSize({ width:1440, height:900 });
      await page.waitForFunction(() => { const b = document.querySelector('.workspace-board'); return !b.hasAttribute('data-more-left') && !b.hasAttribute('data-more-right'); });
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.workspace-board')).maskImage), 'none', `${theme}/1440: 四列放得下时不渐隐`);

      // 一张都没写下一步：不留这一行，照样同高。
      await page.evaluate(() => { state.orders.forEach(o => { o.next = ''; }); renderPipeline(); });
      const plain = await measure(page);
      assert(plain.cards.every(card => !card.next), '没人写下一步时卡片不留这一行');
      assert.equal(new Set(plain.cards.map(card => card.h)).size, 1, `都没写下一步时卡片也要同高 ${[...new Set(plain.cards.map(card => card.h))]}`);
      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, [], '看板不能弹原生对话框');
      await context.close();
    }
    console.log('Board layout passed: real cards (next / no next, urgent, draft, long name, due, tracking, partial) are the same height and the 4 column heads match at 1440/1294/1100/820/390, light and dark; long lists scroll; a board that does not fit fades on the side with more columns.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
