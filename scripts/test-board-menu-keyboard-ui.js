const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

// 看板卡片的键盘操作和右键菜单：
// - Tab 能走到卡片，回车打开详情；Shift+F10 打开菜单（贴着卡片，不在屏幕左上角），焦点进菜单，↑↓ Home End 选择，Esc 关闭后焦点回到卡片；
// - 键盘推进阶段（菜单里的「推进到…」、卡片里的快捷按钮）；报价单写「收齐全款」、尾款单写「收齐尾款」；
// - 页面滚动、列内滚动、窗口大小变化、按「/」打开搜索都会关菜单；贴着右下角打开也不超出窗口；
// - 菜单上和看板空白处右键不弹浏览器自带菜单。
const orders = [
  { ...base, id:'k1', num:'K301', client:'Key Balance', amount:1000, paidAmount:300, depositAmount:300, orderType:'定金订单', stage:'balance', updated:`${day(3)} 09:01` },
  { ...base, id:'k2', num:'K302', client:'Key Quote', amount:800, paidAmount:0, depositAmount:240, orderType:'定金订单', stage:'quote', updated:`${day(3)} 09:02` },
  { ...base, id:'k3', num:'K303', client:'Key Production', amount:500, paidAmount:200, depositAmount:200, orderType:'定金订单', stage:'production', updated:`${day(3)} 09:03` },
  ...Array.from({ length:14 }, (_, i) => ({ ...base, id:`s${i}`, num:`S${400 + i}`, client:`Ship ${i}`, amount:100, paidAmount:100, orderType:'全款订单', stage:'shipment', logisticsStatus:'已发货', shippedAt:day(2), updated:`${day(2)} 10:${String(10 + i)}` }))
];

const active = page => page.evaluate(() => {
  const el = document.activeElement;
  return { card:el?.closest?.('.board-card')?.dataset.id || '', menu:el?.dataset?.boardMenu || '', quick:el?.dataset?.quick || '', tag:el?.tagName };
});
const settledMenuBox = async page => {
  await page.waitForFunction(() => { const m = document.querySelector('.board-menu'); return m && !m.getAnimations().some(a => a.playState === 'running'); });
  return page.evaluate(() => { const r = document.querySelector('.board-menu').getBoundingClientRect(); return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, vw:innerWidth, vh:innerHeight }; });
};

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { width:1294, height:760 });
    await page.evaluate(() => {
      window.__ctx = [];
      document.addEventListener('contextmenu', e => window.__ctx.push({ where:e.target.closest?.('.board-menu') ? 'menu' : e.target.closest?.('.board-card') ? 'card' : e.target.closest?.('.board-column') ? 'column' : 'other', prevented:e.defaultPrevented }));
    });

    // 1. Tab 能走到卡片（以前卡片不能聚焦）。
    await page.locator('#boardProductFilter [data-board-product="睫毛"]').focus();
    let reached = '';
    for (let i = 0; i < 25 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = (await active(page)).card;
    }
    assert(reached, 'Tab 走不到看板卡片');

    // 2. 回车打开详情。
    await page.locator('#pipeline .board-card[data-id="k2"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open') && detailOrderId === 'k2');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));

    // 2b. 卡片还在做 transform 动画（页面刚切回来的入场上浮、悬停上浮的弹簧）时打开菜单，随后来一个和卡片无关的滚动事件
    // （关抽屉时重置滚动、打开前那次滚动迟到的事件）：菜单不能关。以前按卡片的 getBoundingClientRect 判断「卡片动了」，
    // 它带着动画里的 transform，macOS CI 上偶发菜单一打开就没了。动画用一段 10 秒、每秒 40px 的位移代替，结果和机器快慢无关。
    await page.locator('#pipeline .board-card[data-id="k1"]').evaluate(card => { window.__moving = card.animate([{ transform:'translateY(400px)' }, { transform:'translateY(0)' }], { duration:10000 }); });
    await page.locator('#pipeline .board-card[data-id="k1"]').focus();
    await page.keyboard.press('Shift+F10');
    await page.waitForSelector('.board-menu');
    // 等卡片从打开菜单那一刻起又移动了 5px 以上（40px/秒），再来滚动事件。
    const openedAt = await page.evaluate(() => window.__moving.currentTime);
    await page.waitForFunction(t => window.__moving.currentTime > t + 150, openedAt);
    const lateScroll = await page.evaluate(() => {
      document.querySelector('#pipeline .board-card-list').dispatchEvent(new Event('scroll'));
      return { moving:window.__moving.playState, open:!!document.querySelector('.board-menu') };
    });
    assert.deepEqual(lateScroll, { moving:'running', open:true }, '卡片还在动画里时，无关的滚动事件不能关掉刚打开的菜单');
    await settledMenuBox(page);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.board-menu'));
    await page.evaluate(() => window.__moving.cancel());

    // 3. Shift+F10 打开菜单：贴着卡片，焦点在第一项；↑↓ Home End；Esc 关闭后焦点回到卡片。
    await page.locator('#pipeline .board-card[data-id="k1"]').focus();
    await page.keyboard.press('Shift+F10');
    await page.waitForSelector('.board-menu');
    const cardBox = await page.locator('#pipeline .board-card[data-id="k1"]').boundingBox();
    const keyMenu = await settledMenuBox(page);
    assert(keyMenu.left >= cardBox.x && keyMenu.left <= cardBox.x + cardBox.width, `键盘打开的菜单应该贴着卡片：${JSON.stringify(keyMenu)} / ${JSON.stringify(cardBox)}`);
    assert(Math.abs(keyMenu.top - cardBox.y) < 80, '菜单不能出现在屏幕左上角');
    assert.equal((await active(page)).menu, 'open', '焦点进了菜单第一项');
    assert.equal(await page.locator('.board-menu').getAttribute('aria-label'), 'Key Balance · K301 的操作');
    const labels = await page.locator('.board-menu [role="menuitem"]').allTextContents();
    assert(labels.some(text => /^收齐尾款 \$700/.test(text.trim())), `尾款单写「收齐尾款」：${labels}`);
    await page.keyboard.press('ArrowDown');
    assert.equal((await active(page)).menu, 'paid');
    await page.keyboard.press('End');
    assert.equal((await active(page)).menu, 'delete');
    await page.keyboard.press('ArrowDown');
    assert.equal((await active(page)).menu, 'open', '↓ 到底后回到第一项');
    await page.keyboard.press('ArrowUp');
    assert.equal((await active(page)).menu, 'delete');
    await page.keyboard.press('Home');
    assert.equal((await active(page)).menu, 'open');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.board-menu'));
    assert.equal((await active(page)).card, 'k1', 'Esc 关闭菜单后焦点回到卡片');

    // 4. 键盘推进阶段：菜单里 ↓ 到「推进到生产中」，回车。
    await page.keyboard.press('Shift+F10');
    await page.waitForSelector('.board-menu');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal((await active(page)).menu, 'advance');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'k1').stage === 'production');
    await h.waitToast(page, 'K301 Key Balance 已移动到生产中');

    // 报价单的菜单写「收齐全款」（还没收过定金，不是尾款）。
    await page.locator('#pipeline .board-card[data-id="k2"]').focus();
    await page.keyboard.press('Shift+F10');
    await page.waitForSelector('.board-menu');
    assert((await page.locator('.board-menu [role="menuitem"]').allTextContents()).some(text => /^收齐全款 \$800/.test(text.trim())), '报价单写「收齐全款」');
    await page.keyboard.press('Escape');

    // 5. 卡片里的快捷按钮也能用 Tab 走到：Tab → 收齐 → Tab → 推进，回车推进。
    await page.locator('#pipeline .board-card[data-id="k3"]').focus();
    await page.keyboard.press('Tab');
    assert.equal((await active(page)).quick, 'paid');
    assert.equal(await page.evaluate(() => document.activeElement.title), '收齐尾款 $300 USD');
    await page.keyboard.press('Tab');
    assert.equal((await active(page)).quick, 'advance');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.orders.find(o => o.id === 'k3').stage === 'shipment');
    await page.locator('#trackingQuickCard [data-track-skip]').click();
    await page.waitForFunction(() => !document.getElementById('trackingQuickCard'));
    // 点「先跳过」后小卡还要淡出 200ms：这段时间它不能再接点击 / 滚轮（以前在 macOS 上第 6 步正好点在淡出的小卡上，
    // 点不到下面的列表）。淡出中的提示也一样，不能挡住下面那条的「撤销」。关掉和检查放在同一次执行里，结果和机器快慢无关。
    const fading = await page.evaluate(() => {
      uiTrackingQuickCard('k3');
      const card = document.getElementById('trackingQuickCard');
      uiTrackingQuickCardClose('k3');
      toast('fading toast check');
      const item = [...document.querySelectorAll('#toast .toast-item')].at(-1);
      item.__dismiss();
      const probe = el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el || el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); };
      return { card:[card.classList.contains('leaving'), getComputedStyle(card).pointerEvents, probe(card)], toast:[item.classList.contains('leaving'), getComputedStyle(item).pointerEvents, probe(item)] };
    });
    assert.deepEqual(fading, { card:[true, 'none', false], toast:[true, 'none', false] }, '淡出中的运单号小卡 / 提示不能再挡住下面的内容');

    // 6. 滚动关菜单：整页滚动（Mac App 里滚的是页面）、列内滚动。
    await h.rightClick(page, 'k2');
    const statsBox = await page.locator('.board-panel .section-head').boundingBox();
    await page.mouse.move(statsBox.x + 10, statsBox.y + 5);
    const scrolledBefore = await page.evaluate(() => document.scrollingElement.scrollTop);
    await page.mouse.wheel(0, 240);
    await page.waitForFunction(before => document.scrollingElement.scrollTop !== before, scrolledBefore);
    await page.waitForFunction(() => !document.querySelector('.board-menu'));
    // 列表先回到顶上，右键第一张，再在列表里滚轮往下滚。
    const firstShip = await page.evaluate(() => {
      document.querySelector('.board-panel').scrollIntoView({ block:'start' });
      const list = document.querySelector('#pipeline .board-column[data-stage="shipment"] .board-card-list');
      list.scrollTop = 0;
      return list.querySelector('.board-card[data-id]').dataset.id;
    });
    await h.rightClick(page, firstShip);
    assert.equal(await page.evaluate(() => document.querySelector('#pipeline .board-column[data-stage="shipment"] .board-card-list').scrollTop), 0);
    const listBox = await page.locator('#pipeline .board-column[data-stage="shipment"] .board-card-list').boundingBox();
    // 鼠标放在列表左下（避开菜单，菜单在点击处右下方）。
    await page.mouse.move(listBox.x + 16, listBox.y + listBox.height - 30);
    assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.board-card-list'), [listBox.x + 16, listBox.y + listBox.height - 30]), true);
    assert.equal(await page.locator('.board-menu').count(), 1, '刚打开的菜单不能被打开前那次滚动的迟到事件关掉');
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('#pipeline .board-column[data-stage="shipment"] .board-card-list').scrollTop > 0);
    await page.waitForFunction(() => !document.querySelector('.board-menu'));
    // 窗口大小变了：关。
    await h.rightClick(page, 'k2');
    await page.setViewportSize({ width:1280, height:760 });
    await page.waitForFunction(() => !document.querySelector('.board-menu'));
    // 按「/」打开搜索：菜单收起，不盖在搜索结果上。
    await h.rightClick(page, 'k2');
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.activeElement?.id === 'searchInput');
    await page.waitForFunction(() => !document.querySelector('.board-menu'));
    await page.keyboard.press('Escape');

    // 7. 贴着右下角打开：菜单完整留在窗口里（至少 8px 边距）。
    await page.setViewportSize({ width:1100, height:720 });
    await h.clearToasts(page); // 右下角的提示会挡住卡片
    await page.evaluate(() => { document.querySelector('.board-panel').scrollIntoView({ block:'end' }); document.querySelector('#pipeline .board-column[data-stage="shipment"]').scrollIntoView({ inline:'end', block:'nearest' }); });
    const corner = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#pipeline .board-column[data-stage="shipment"] .board-card')];
      const list = document.querySelector('#pipeline .board-column[data-stage="shipment"] .board-card-list').getBoundingClientRect();
      const visible = cards.map(card => card.getBoundingClientRect()).filter(r => r.bottom <= Math.min(list.bottom, innerHeight) && r.top >= list.top);
      const r = visible[visible.length - 1];
      // 离卡片右下角各留十来像素（圆角外面点不到卡片）。
      const x = Math.min(r.right, innerWidth) - 14;
      const y = r.bottom - 10;
      return { x, y, hit:document.elementFromPoint(x, y)?.closest('.board-card')?.dataset.id || document.elementFromPoint(x, y)?.className };
    });
    assert(/^s\d+$/.test(corner.hit), `右下角那一点要落在卡片上：${JSON.stringify(corner)}`);
    await page.mouse.click(corner.x, corner.y, { button:'right' });
    await page.waitForSelector('.board-menu');
    const edge = await settledMenuBox(page);
    assert(edge.right <= edge.vw - 8 + 0.5 && edge.bottom <= edge.vh - 8 + 0.5 && edge.left >= 8 && edge.top >= 8, `菜单超出窗口：${JSON.stringify(edge)}`);

    // 8. 菜单上、看板空白处右键：不弹浏览器自带菜单。
    await page.locator('.board-menu .board-menu-title').click({ button:'right' });
    await page.keyboard.press('Escape');
    await page.locator('#pipeline .board-column[data-stage="quote"] .board-column-head').click({ button:'right' });
    const ctx = await page.evaluate(() => window.__ctx);
    assert(ctx.filter(item => item.where === 'menu').every(item => item.prevented), '菜单上的右键要拦下');
    assert(ctx.filter(item => item.where === 'column').length && ctx.filter(item => item.where === 'column').every(item => item.prevented), '看板列上的右键要拦下');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], '不能出现原生 alert / confirm');
    console.log('Board menu keyboard UI passed: cards reachable by Tab, Enter opens, Shift+F10 menu near the card with focus, arrows / Home / End, Esc returns focus, keyboard advance via menu and card buttons, 收齐全款 / 收齐尾款 wording, menu closes on page / list scroll, resize and search, stays inside the viewport, native context menu blocked on the menu and columns.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
