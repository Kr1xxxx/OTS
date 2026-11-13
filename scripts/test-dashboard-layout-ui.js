const assert = require('node:assert/strict');
const vm = require('node:vm');
const { launchBrowser, openBoard, base } = require('./helpers/board-page');
const { extractFunction } = require('./helpers/page-source');

// 工作台布局（点看板右上角「布局」）：四个模块在 12 格网格里改宽、改高、换位置、收起，存成界面偏好 ots-dashboard-layout-v1。
// 全部用真鼠标拖把手和标签（pointer 事件），Chromium 和 WebKit 都跑。

// 1. normalizer：坏 JSON、多余 / 缺的 id、超出范围的宽和高、看板被收起，结果都是合法布局。
{
  const context = {};
  vm.runInNewContext(`${extractFunction('dashboardModuleSpecs')}\n${extractFunction('normalizeDashboardLayout')}\nthis.normalize = normalizeDashboardLayout;`, context);
  const normalize = value => JSON.parse(JSON.stringify(context.normalize(value)));
  const defaults = { v:1, items:[{ id:'kpi', span:12 }, { id:'board', span:12, h:'fill' }, { id:'tasks', span:7, h:'auto' }, { id:'recent', span:5, h:'auto' }], hidden:[] };
  assert.deepEqual(normalize(null), defaults);
  assert.deepEqual(normalize('{oops'), defaults);
  assert.deepEqual(normalize('[1,2]'), defaults);
  const odd = normalize(JSON.stringify({ items:[{ id:'recent', span:0, h:-5 }, { id:'nope', span:6 }, { id:'board', span:99, h:13 }, { id:'recent', span:9 }, { id:'tasks', span:'7', h:'fill' }], hidden:['board', 'tasks', 'tasks', 'ghost'] }));
  assert.deepEqual(odd, { v:1, items:[{ id:'recent', span:3, h:200 }, { id:'board', span:12, h:320 }, { id:'tasks', span:7, h:'auto' }, { id:'kpi', span:12 }], hidden:['tasks'] });
  assert.deepEqual(normalize({ items:[{ id:'tasks', span:4.4, h:5000 }] }).items[0], { id:'tasks', span:4, h:1400 });
}

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
// 生产中、很久没动的订单会进待办（跟进），待办里就有按钮可点。
const orders = Array.from({ length:6 }, (_, i) => ({ ...base, id:`o${i}`, num:`L${i}`, client:`Layout Buyer ${i}`, amount:200 + i, paidAmount:200 + i, orderType:'全款订单', stage:i < 4 ? 'production' : 'quote', createdAt:daysAgo(40 + i), orderMonth:daysAgo(40 + i).slice(0, 7), updated:`${daysAgo(40 + i)} 09:00` }));

const rects = page => page.evaluate(() => Object.fromEntries(['kpi', 'board', 'tasks', 'recent'].map(id => {
  const el = document.querySelector(`[data-dash-module="${id}"]`);
  const r = el.getBoundingClientRect();
  return [id, { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height, hidden:el.hidden, order:Number(getComputedStyle(el).order) }];
})));
const boardColumnHeight = page => page.evaluate(() => document.querySelector('#pipeline .board-column').getBoundingClientRect().height);
const stored = page => page.evaluate(() => localStorage.getItem('ots-dashboard-layout-v1'));
const near = (a, b, tolerance, message) => assert(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);
// 把某个把手 / 标签拖动 (dx, dy)：先滚到看得见，按下、分几步移动，返回松手的函数（松手前可以量拖动中的样子）。
async function grab(page, selector) {
  const handle = page.locator(selector);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  const start = { x:box.x + box.width / 2, y:box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return {
    start,
    async to(x, y) { for (let i = 1; i <= 8; i += 1) await page.mouse.move(start.x + (x - start.x) * i / 8, start.y + (y - start.y) * i / 8); },
    release:() => page.mouse.up()
  };
}
async function dragBy(page, selector, dx, dy) {
  const drag = await grab(page, selector);
  await drag.to(drag.start.x + dx, drag.start.y + dy);
  await drag.release();
}
const colStep = page => page.evaluate(() => {
  const width = document.getElementById('page-dashboard').getBoundingClientRect().width;
  return (width - 11 * 16) / 12 + 16;
});
const enter = async page => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('#dashLayoutBtn');
  await page.waitForSelector('#dashLayoutBar');
};

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, context, errors, dialogs } = await openBoard(browser, { orders }, { width:1694, height:1082 });
    await page.evaluate(() => window.scrollTo(0, 0));

    // 2. 默认：看板撑满第一屏（列高 746），待办 7 格、最近订单 5 格在同一行。
    let r = await rects(page);
    near(await boardColumnHeight(page), 746, 2, '默认看板列高');
    near(r.tasks.top, r.recent.top, 0.5, '待办和最近订单同一行');
    near(r.tasks.width, 818, 2, '待办 7 格宽');
    near(r.recent.width, 580, 2, '最近订单 5 格宽');
    assert(r.tasks.top > r.board.bottom, '待办在看板下面');
    assert.equal(await stored(page), null, '没调整过就不存');

    // 3. 进入调整：提示条、四个标签、把手；看板没有眼睛；指标卡没有下把手；模块里的东西点不到。
    await enter(page);
    const chrome = await page.evaluate(() => ({
      chips:[...document.querySelectorAll('#page-dashboard .dash-chip')].map(el => el.closest('[data-dash-module]').dataset.dashModule),
      eyes:[...document.querySelectorAll('#page-dashboard [data-dash-hide]')].map(el => el.closest('[data-dash-module]').dataset.dashModule),
      hx:document.querySelectorAll('#page-dashboard .dash-hx').length,
      hy:[...document.querySelectorAll('#page-dashboard .dash-hy')].map(el => el.closest('[data-dash-module]').dataset.dashModule),
      inert:['#pipeline', '#taskList', '#recentOrderList', '#activeOrdersStat'].map(sel => Boolean(document.querySelector(sel).closest('[inert]'))),
      layoutBtnShown:document.getElementById('dashLayoutBtn').getClientRects().length > 0
    }));
    assert.deepEqual(chrome.chips.sort(), ['board', 'kpi', 'recent', 'tasks']);
    assert.deepEqual(chrome.eyes.sort(), ['kpi', 'recent', 'tasks'], '看板不能收起');
    assert.equal(chrome.hx, 4);
    assert.deepEqual(chrome.hy.sort(), ['board', 'recent', 'tasks'], '指标卡没有下边的把手');
    assert.deepEqual(chrome.inert, [true, true, true, true], '模块里的内容在调整时点不到');
    assert.equal(chrome.layoutBtnShown, false, '调整时「布局」按钮收起来，用提示条上的「完成」');
    const card = page.locator('#pipeline .board-card').first();
    const cardBox = await card.boundingBox();
    await page.mouse.click(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('.modal-backdrop.open'))), false, '调整时点订单卡片不打开订单');

    // 4. 改宽：待办拖到 4 格，看板拖到 8 格，待办排到看板右边；拖的时候才有 12 格参考线和尺寸提示。
    const step = await colStep(page);
    await dragBy(page, '[data-dash-module="tasks"] .dash-hx', -3 * step, 0);
    r = await rects(page);
    near(r.tasks.width, 4 * step - 16, 2, '待办 4 格宽');
    let drag = await grab(page, '[data-dash-module="board"] .dash-hx');
    await drag.to(drag.start.x - 4 * step, drag.start.y);
    const during = await page.evaluate(() => ({ guides:document.querySelectorAll('#dashLayoutGuides i').length, badge:document.querySelector('[data-dash-module="board"] .dash-badge')?.textContent || '' }));
    await drag.release();
    assert.equal(during.guides, 12, '拖的时候显示 12 格参考线');
    assert.match(during.badge, /^宽 8 \/ 12 格 · 高 \d+$/);
    assert.equal(await page.evaluate(() => Boolean(document.getElementById('dashLayoutGuides') || document.querySelector('.dash-badge'))), false, '松手后参考线和提示消失');
    r = await rects(page);
    near(r.tasks.top, r.board.top, 0.5, '待办和看板同一行');
    assert(r.tasks.left > r.board.right, '待办在看板右边');
    assert.match(await page.textContent('[data-dash-module="board"] .dash-chip-size'), /^宽 8\/12 · 撑满窗口$/);

    // 5. 改高：待办的高按 20 一档，最小 240；双击下把手回到自动。
    await dragBy(page, '[data-dash-module="tasks"] .dash-hy', 0, -47);
    let tasksH = await page.evaluate(() => getComputedStyle(document.getElementById('tasks')).getPropertyValue('--dash-h'));
    assert.match(tasksH, /^\d+px$/, `待办有了定高 ${tasksH}`);
    assert.equal(parseInt(tasksH, 10) % 20, 0, `高按 20 一档 ${tasksH}`);
    await dragBy(page, '[data-dash-module="tasks"] .dash-hy', 0, -900);
    near((await rects(page)).tasks.height, 240, 0.5, '待办最矮 240');
    await page.locator('[data-dash-module="tasks"] .dash-hy').dblclick();
    assert.equal(await page.evaluate(() => document.getElementById('tasks').hasAttribute('data-dash-h')), false, '双击回到自动高度');
    assert.match(await page.textContent('[data-dash-module="tasks"] .dash-chip-size'), /高度自动/);

    // 6. 吸附：待办的下边拖到离看板底边 6 像素，松手后两个底边对齐。
    await page.evaluate(() => { const el = document.querySelector('.board-panel'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120); });
    r = await rects(page);
    drag = await grab(page, '[data-dash-module="tasks"] .dash-hy');
    await drag.to(drag.start.x, drag.start.y + (r.board.bottom - 6 - r.tasks.bottom));
    await drag.release();
    r = await rects(page);
    near(r.tasks.bottom, r.board.bottom, 0.5, '待办吸到看板的底边');

    // 7. 拖「最近订单」的标签到最前；键盘 → 往后挪一位。
    await page.evaluate(() => window.scrollTo(0, 0));
    drag = await grab(page, '[data-dash-module="recent"] .dash-chip-grip');
    const kpiBox = (await rects(page)).kpi;
    await drag.to(kpiBox.left + 30, kpiBox.top + 40);
    assert.equal(await page.evaluate(() => document.querySelector('[data-dash-module="recent"]').classList.contains('is-dash-lifted') && Boolean(document.getElementById('dashDropLine'))), true, '拖起来半透明跟手、有插入线');
    await drag.release();
    r = await rects(page);
    assert.equal(Math.min(...Object.values(r).map(item => item.order)), r.recent.order, '最近订单排到第一个');
    near(r.recent.top, Math.min(r.kpi.top, r.recent.top), 0.5, '最近订单在最上面');
    await page.focus('[data-dash-module="recent"] .dash-chip-grip');
    await page.keyboard.press('ArrowRight');
    r = await rects(page);
    assert(r.recent.order > r.kpi.order && r.recent.order < r.board.order, '→ 往后挪一位：排到指标卡后面');
    await page.keyboard.press('ArrowLeft');
    r = await rects(page);
    assert(r.recent.order < r.kpi.order, '← 往前挪一位');

    // 8. 收起最近订单：消失，底下出现「已收起的模块」；点一下放回来，排在最后，大小不变。
    const recentSpan = await page.evaluate(() => getComputedStyle(document.getElementById('recentOrders')).getPropertyValue('--dash-span').trim());
    await page.click('[data-dash-module="recent"] [data-dash-hide]');
    assert.equal((await rects(page)).recent.hidden, true);
    assert.match(await page.textContent('#dashLayoutTray'), /已收起的模块.*最近订单/);
    await page.click('#dashLayoutTray [data-dash-show="recent"]');
    r = await rects(page);
    assert.equal(r.recent.hidden, false);
    assert.equal(Math.max(...Object.values(r).map(item => item.order)), r.recent.order, '放回来排在最后');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('recentOrders')).getPropertyValue('--dash-span').trim()), recentSpan, '放回来还是原来的宽');
    assert.equal(await page.evaluate(() => Boolean(document.getElementById('dashLayoutTray'))), false, '没有收起的就没有那一条');

    // 9. 完成：存进本机，退出调整，刷新后布局还在。
    await page.click('[data-dash-action="done"]');
    const saved = JSON.parse(await stored(page));
    assert.deepEqual(saved.items.map(item => [item.id, item.span]), [['kpi', 12], ['board', 8], ['tasks', 4], ['recent', 5]]);
    assert.equal(saved.items.find(item => item.id === 'tasks').h, Math.round(r.board.bottom - r.tasks.top), '吸附后的高原样存下');
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('#page-dashboard.dash-editing, #dashLayoutBar, .dash-edit, [data-dash-inert]'))), false, '退出后外框都拿掉');
    assert.equal(await page.evaluate(() => document.querySelector('#pipeline').closest('[inert]')), null, '退出后看板又能点');
    await page.reload();
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => window.scrollTo(0, 0));
    r = await rects(page);
    near(r.tasks.top, r.board.top, 0.5, '刷新后待办还在看板右边');
    near(r.tasks.bottom, r.board.bottom, 0.5, '刷新后底边还对齐');

    // 10. 取消和 Esc：草稿丢掉，存着的不动，画面回到进来之前。
    const before = await stored(page);
    for (const way of ['cancel', 'escape']) {
      await enter(page);
      await dragBy(page, '[data-dash-module="board"] .dash-hx', 4 * step, 0);
      assert(Math.abs((await rects(page)).board.width - (await rects(page)).kpi.width) < 1, `${way}: 拖到 12 格`);
      if (way === 'cancel') await page.click('[data-dash-action="cancel"]');
      else { await page.focus('[data-dash-module="board"] .dash-chip-grip'); await page.keyboard.press('Escape'); }
      assert.equal(await page.evaluate(() => Boolean(document.getElementById('dashLayoutBar'))), false, `${way}: 退出调整`);
      r = await rects(page);
      near(r.tasks.top, r.board.top, 0.5, `${way}: 回到进来之前的排法`);
      assert.equal(await stored(page), before, `${way}: 不写本机存储`);
    }

    // 11. 切到别的页面等于取消。
    await enter(page);
    await page.click('[data-dash-module="tasks"] [data-dash-hide]');
    await page.evaluate(() => setPage('order-list'));
    await page.evaluate(() => setPage('dashboard'));
    assert.equal(await page.evaluate(() => Boolean(document.getElementById('dashLayoutBar'))), false, '换页面后不在调整状态');
    assert.equal((await rects(page)).tasks.hidden, false, '换页面丢掉草稿');

    // 12. 收起待办并存下，点「今日待办」卡：待办放回来、存一次、滚到视口里。
    await enter(page);
    await page.click('[data-dash-module="tasks"] [data-dash-hide]');
    await page.click('[data-dash-action="done"]');
    assert.deepEqual(JSON.parse(await stored(page)).hidden, ['tasks']);
    assert.equal((await rects(page)).tasks.hidden, true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#todayTasksStat');
    await page.waitForFunction(() => { const r = document.getElementById('tasks').getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.top < window.innerHeight; });
    assert.deepEqual(JSON.parse(await stored(page)).hidden, [], '放回来的也存下');

    // 13. 窄窗口（1000）：不用网格，四个模块各占一行，没有「布局」按钮；拉回来排法还在。
    await page.evaluate(() => window.scrollTo(0, 0));
    const wide = await rects(page);
    await page.setViewportSize({ width:1000, height:900 });
    await page.waitForFunction(() => window.innerWidth === 1000);
    r = await rects(page);
    const visible = Object.entries(r).filter(([, item]) => !item.hidden).sort((a, b) => a[1].top - b[1].top);
    assert(visible.every(([, item]) => Math.abs(item.width - visible[0][1].width) < 1), '窄窗口每个模块一样宽（各占一行）');
    assert.equal(await page.evaluate(() => document.getElementById('dashLayoutBtn').getClientRects().length), 0, '窄窗口没有「布局」按钮');
    await page.setViewportSize({ width:1694, height:1082 });
    await page.waitForFunction(() => window.innerWidth === 1694);
    await page.evaluate(() => window.scrollTo(0, 0));
    r = await rects(page);
    assert.deepEqual(r, wide, '拉回来后排法和窄之前一样');

    // 14. 恢复默认再完成：回到第 2 条的样子。
    await enter(page);
    await page.click('[data-dash-action="reset"]');
    assert.equal(await page.evaluate(() => Boolean(document.getElementById('dashLayoutBar'))), true, '恢复默认后还在调整状态');
    await page.click('[data-dash-action="done"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    r = await rects(page);
    near(await boardColumnHeight(page), 746, 2, '恢复默认后看板列高');
    near(r.tasks.width, 818, 2, '恢复默认后待办 7 格');
    near(r.tasks.top, r.recent.top, 0.5, '恢复默认后待办和最近订单同一行');

    // 15. 指标卡拖到 6 格（不到 900 宽）：排 3 列；取消后回到 5 列。用键盘改宽。
    const statColumns = () => page.evaluate(() => getComputedStyle(document.getElementById('dashboard')).gridTemplateColumns.split(' ').length);
    assert.equal(await statColumns(), 5);
    await enter(page);
    await page.focus('[data-dash-module="kpi"] .dash-hx');
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
    assert.match(await page.textContent('[data-dash-module="kpi"] .dash-chip-size'), /^宽 6\/12$/);
    assert.equal(await statColumns(), 3, '指标卡窄了排 3 列');
    await page.click('[data-dash-action="cancel"]');
    assert.equal(await statColumns(), 5, '取消后回到 5 列');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    await context.close();
    console.log('Dashboard layout passed: default 1B layout; edit mode chips, handles and inert content; width, height (20 px steps, min, double-click auto, snap), move by drag and keys, hide and restore; done saves the UI pref and survives a reload; cancel, Esc and leaving the page drop the draft; 今日待办 brings hidden tasks back; narrow windows stack the modules; reset; normalizer.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
