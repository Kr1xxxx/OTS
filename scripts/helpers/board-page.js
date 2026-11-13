// Shared setup for the board / stage UI tests: the real page with an in-memory /api/data + /api/save,
// and real-mouse helpers (mouse.down / move / up for HTML5 drag and drop, real right clicks).
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { html } = require('./page-source');

const pad = n => String(n).padStart(2, '0');
const today = new Date();
const month = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
const day = n => `${month}-${pad(n)}`;
const base = { currency:'USD', logisticsStatus:'未发货', createdAt:day(1), orderMonth:month, logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[] };

async function launchBrowser() {
  try { return await chromium.launch({ headless:true }); }
  catch (_) { return chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium' }); }
}

// data: the stored app data (orders, doneTasks, …). ecbRates: what /api/ecb-rates returns. Returns { page, store, errors, dialogs }.
async function openBoard(browser, data, { width = 1440, height = 920, theme = 'light', port = 47990, ecbRates = [] } = {}) {
  const context = await browser.newContext({ viewport:{ width, height } });
  await context.addInitScript(t => {
    try {
      localStorage.setItem('trade-order-system-theme', t);
      localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10));
    } catch (_) {}
  }, theme);
  const page = await context.newPage();
  const store = { current:{ app:'trade-order-system', data:{ customers:{}, doneTasks:{}, demoCleared:true, demoCustomersCleared:true, ...data }, revision:0 }, saves:0 };
  const errors = [];
  const dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  // 页面内的弹窗一律用 appConfirm：出现原生 alert / confirm 就记下来，测试最后断言为空。
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    let response = { ok:true };
    if (pathname === '/api/data') response = store.current;
    if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:(data.orders || []).length }, backups:{ sqliteCount:0 } };
    if (pathname === '/api/ecb-rates') response = { ok:true, rates:ecbRates };
    if (pathname === '/api/track') response = { ok:false, status:'待 API 查询', message:'offline' };
    if (pathname === '/api/save') {
      const body = route.request().postDataJSON();
      store.current = { ...body.state, revision:store.current.revision + 1 };
      store.saves += 1;
      response = { ok:true, revision:store.current.revision, backup:{ ok:true, skipped:true } };
    }
    return route.fulfill({ json:response });
  });
  await page.goto(`http://127.0.0.1:${port}/trade-order-system.html`);
  await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
  await page.evaluate(() => { setPage('dashboard'); document.querySelector('.board-panel')?.scrollIntoView({ block:'start' }); });
  await page.waitForSelector('#pipeline .board-column');
  return { page, context, store, errors, dialogs };
}

const h = {
  order: (page, id) => page.evaluate(id => {
    const o = state.orders.find(item => item.id === id);
    return o ? JSON.parse(JSON.stringify(o)) : null;
  }, id),
  deleted: (page, id) => page.evaluate(id => (state.deletedOrders || []).some(item => item.id === id), id),
  toasts: page => page.evaluate(() => [...document.querySelectorAll('#toast .toast-item:not(.leaving)')].map(el => el.textContent.replace(/\s+/g, ' ').trim())),
  waitToast: (page, text) => page.waitForFunction(text => [...document.querySelectorAll('#toast .toast-item:not(.leaving)')].some(el => el.textContent.includes(text)), text),
  // 让某条提示先别自己消失，和用户把鼠标停在它上面一样：页面收到 pointermove 就停掉这条提示的计时，鼠标离开它才重新计时。
  // 带「撤销」的提示只留 6 秒；之后还要做真鼠标拖拽这类在慢机器上一次就要几秒的事、回头才点它的撤销时用
  // （2026-11-13 WebKit CI：两次拖拽之后 K106 的提示已经过期，clickUndo 等了 30 秒）。
  holdToast: (page, text) => page.locator('#toast .toast-item:not(.leaving)', { hasText:text }).last().dispatchEvent('pointermove'),
  // 点某条提示（按文字找）的「撤销」：和用户一样先把鼠标放到提示堆上让它展开，等展开动画停下再点。
  // 新提示弹入是 580ms 的弹簧动画：机器快的时候（macOS CI）在动画中途量到的位置，等鼠标移过去时提示已经挪开，
  // 提示堆没展开，量到的是叠在下面的旧位置，点到了最新那条上。所以先等弹入停下，确认提示堆真的展开（:hover）再量，
  // 点之前再确认那一点就是这个「撤销」按钮。
  clickUndo: async (page, text) => {
    const item = page.locator('#toast .toast-item:not(.leaving)', { hasText:text }).last();
    await item.waitFor();
    const settled = () => page.waitForFunction(() => [...document.querySelectorAll('#toast .toast-item')].every(el => !el.getAnimations().some(a => a.playState === 'running')));
    await settled();
    const newest = await page.locator('#toast .toast-item:not(.leaving)').last().boundingBox();
    await page.mouse.move(newest.x + newest.width / 3, newest.y + newest.height / 2);
    await page.waitForFunction(() => document.getElementById('toast')?.matches(':hover'));
    await settled();
    const undo = item.locator('.toast-undo');
    const box = await undo.boundingBox();
    const point = { x:box.x + box.width / 2, y:box.y + box.height / 2 };
    const onTop = await undo.evaluate((el, p) => document.elementFromPoint(p.x, p.y)?.closest('.toast-undo') === el, point);
    if (!onTop) throw new Error(`「${text}」的撤销按钮被挡住了：${await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.outerHTML.slice(0, 160), point)}`);
    await page.mouse.click(point.x, point.y);
  },
  // 点卡片上悬停才出现的快捷按钮（收齐 / 推进）：和用户一样先把卡片放到顶栏下面看得见的地方，鼠标移到卡片上，
  // 等悬停上浮的弹簧过渡停下、按钮出现，确认那一点就是这个按钮，再在那一点点下去。
  // 不用 locator.click()：按钮在 sticky 顶栏底下（或卡片还在动）时它会换几种对齐方式重新滚动页面，滚完鼠标已经不在卡片上，
  // 按钮跟着悬停消失，之后一直是「element is not visible」直到超时（macOS CI 上出现过）。
  clickQuick: async (page, id, action) => {
    const card = page.locator(`#pipeline .board-card[data-id="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    await page.evaluate(id => {
      const el = document.querySelector(`#pipeline .board-card[data-id="${id}"]`);
      const topbar = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
      const top = el.getBoundingClientRect().top;
      if (top < topbar + 8) window.scrollBy(0, top - topbar - 16);
    }, id);
    const box = await card.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 24));
    const btn = card.locator(`[data-quick="${action}"]`);
    await btn.waitFor({ state:'visible' });
    await page.waitForFunction(id => !document.querySelector(`#pipeline .board-card[data-id="${id}"]`).getAnimations({ subtree:true }).some(a => a.playState === 'running'), id);
    const b = await btn.boundingBox();
    const point = { x:b.x + b.width / 2, y:b.y + b.height / 2 };
    const onTop = await btn.evaluate((el, p) => document.elementFromPoint(p.x, p.y)?.closest('[data-quick]') === el, point);
    if (!onTop) throw new Error(`卡片 ${id} 的「${action}」按钮被挡住了：${await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.outerHTML.slice(0, 160), point)}`);
    await page.mouse.click(point.x, point.y);
  },
  clearToasts: page => page.evaluate(() => document.querySelectorAll('#toast .toast-item').forEach(el => el.remove())),
  flush: page => page.evaluate(() => window.flushPendingSave?.()),
  // 等元素停稳：它自己、它里面、它的祖先上没有在跑的（有尽头的）动画——卡片入场上浮、悬停弹簧、菜单弹出的缩放。
  // 动画中途量到的位置，等鼠标过去时已经变了（macOS CI 机器快、慢都会碰上）。
  settle: (page, selector) => page.locator(selector).first().evaluate(el => new Promise(resolve => {
    const moving = () => document.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming?.().endTime !== Infinity && a.effect.target instanceof Element && (a.effect.target.contains(el) || el.contains(a.effect.target)));
    const check = () => (el.isConnected && moving() ? requestAnimationFrame(check) : resolve());
    check();
  })),
  // 元素中心点：滚进视野、等停稳再量。中途元素被重新渲染换掉（render() 重画看板）就重新找一次再量；
  // 元素真的没了（菜单被关掉）照样报错，不掩盖问题。
  center: async (page, selector) => {
    const locator = page.locator(selector).first();
    for (let attempt = 1; ; attempt++) {
      try {
        await locator.waitFor({ state:'visible' });
        await locator.scrollIntoViewIfNeeded();
        await h.settle(page, selector);
        const box = await locator.boundingBox();
        if (!box) throw new Error(`${selector} is not attached to the DOM`);
        return { x:box.x + box.width / 2, y:box.y + box.height / 2, box };
      } catch (error) {
        if (attempt >= 3 || !/not attached|detached/i.test(error.message)) throw error;
      }
    }
  },
  // 真实鼠标点元素中心。每一轮都按 locator 重新找元素（中途被重画换掉就找新的那个），滚进视野，
  // 等它和祖先上的动画跑完、连续两帧位置不变，再用 elementFromPoint 确认中心点上就是它（没被提示条、遮罩挡住），然后才按下鼠标。
  // 只有「元素被换掉 / 还在动 / 被挡住」会重试；找不到元素、超时等其它错误照常抛出。
  click: async (page, target, label = String(target)) => {
    const locator = typeof target === 'string' ? page.locator(target).first() : target;
    let last = '';
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await locator.waitFor({ state:'visible' });
        const result = await locator.evaluate(el => new Promise(resolve => {
          el.scrollIntoView({ block:'nearest', inline:'nearest' });
          const moving = () => document.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming?.().endTime !== Infinity && a.effect.target instanceof Element && (a.effect.target.contains(el) || el.contains(a.effect.target)));
          const started = performance.now();
          let prev = '';
          let steady = 0;
          const check = () => {
            if (!el.isConnected) return resolve({ detached:true });
            const r = el.getBoundingClientRect();
            const key = [r.x, r.y, r.width, r.height].map(v => v.toFixed(1)).join();
            steady = !moving() && key === prev ? steady + 1 : 0;
            prev = key;
            if (steady < 2 && performance.now() - started < 5000) return requestAnimationFrame(check);
            if (steady < 2) return resolve({ unstable:key });
            const point = { x:r.x + r.width / 2, y:r.y + r.height / 2 };
            const top = document.elementFromPoint(point.x, point.y);
            resolve(top === el || el.contains(top) ? { point } : { covered:(top?.outerHTML || 'nothing').slice(0, 160) });
          };
          requestAnimationFrame(check);
        }));
        if (result.point) return page.mouse.click(result.point.x, result.point.y);
        last = result.detached ? 'detached while settling' : result.unstable ? `still moving at ${result.unstable}` : `covered by ${result.covered}`;
      } catch (error) {
        if (!/not attached|detached|Execution context was destroyed/i.test(error.message)) throw error;
        last = error.message.split('\n')[0];
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    throw new Error(`${label} could not be clicked: ${last}`);
  },
  // 打开订单抽屉并切到某个页签，像用户一样真的点页签。抽屉刚打开时还在滑入：locator.click() 在机器忙时会把还在动的
  // 页签判成「稳了」，按下和松开之间抽屉又滑了一段，click 落到两个页签之间的 #detailTabs 上，页签没切（2026-11-12
  // test-shipments-partial-ui 偶发超时）。h.click 等抽屉停稳、确认点上就是这个页签再按。
  openDrawer: async (page, id, tab = 'info') => {
    await page.evaluate(id => openOrderDetail(id), id);
    await h.click(page, `#detailTabs [data-detail-tab-btn="${tab}"]`, `drawer tab ${tab}`);
    await page.waitForFunction(tab => !document.querySelector(`#orderDetailBody [data-detail-tab="${tab}"]`)?.hidden, tab);
  },
  columnPoint: async (page, stage) => {
    const box = await page.locator(`#pipeline .board-column[data-stage="${stage}"]`).boundingBox();
    return { x:box.x + box.width / 2, y:box.y + Math.min(box.height - 20, 160) };
  },
  // 真实鼠标拖拽：按下卡片、分几步移到目标列、（可选）在松手前检查、松手。
  // 松手后核对 drop 真的落在了目标列上；没有的话当场报错，带上这次拖拽里浏览器派了哪些事件。
  async drag(page, id, stage, { beforeUp = null } = {}) {
    await page.evaluate(() => {
      const seen = window.__dragTrace = [];
      const types = ['dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend'];
      const note = e => {
        const column = e.target.closest?.('.board-column[data-stage], #trashDrop');
        const label = `${e.type}:${column ? column.dataset.stage || 'trash' : (e.target.nodeName || '').toLowerCase()}`;
        if (seen.at(-1) !== label) seen.push(label);
      };
      types.forEach(type => document.addEventListener(type, note, true));
      window.__dragTraceStop = () => types.forEach(type => document.removeEventListener(type, note, true));
    });
    const from = await h.center(page, `#pipeline .board-card[data-id="${id}"]`);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 8, from.y + 8, { steps:2 });
    await page.waitForFunction(id => document.querySelector(`#pipeline .board-card[data-id="${id}"]`)?.classList.contains('dragging'), id);
    const to = await h.columnPoint(page, stage);
    await page.mouse.move(to.x, to.y, { steps:10 });
    if (beforeUp) await beforeUp();
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('#pipeline .dragging, #pipeline .drag-over, #pipeline .drag-invalid'));
    const trace = await page.evaluate(() => { window.__dragTraceStop(); return window.__dragTrace; });
    if (!trace.includes(`drop:${stage}`)) {
      throw new Error(`Dragging ${id} from (${Math.round(from.x)}, ${Math.round(from.y)}) to "${stage}" at (${Math.round(to.x)}, ${Math.round(to.y)}): no drop on that column. Events: ${trace.join(' ') || 'none'}`);
    }
  },
  // 右键卡片：等菜单是这张卡的、弹出动画停下，之后量菜单里的按钮位置才准。
  async rightClick(page, id) {
    const point = await h.center(page, `#pipeline .board-card[data-id="${id}"]`);
    await page.mouse.click(point.x, point.y, { button:'right' });
    await page.waitForFunction(id => document.querySelector('.board-menu')?.dataset.orderId === id, id);
    await h.settle(page, '.board-menu');
    return point;
  },
  // 等到页面里的时钟走过 ms 毫秒。只用来证明某件事在这段时间里「没有」发生（Esc 之后面板没再弹出、没有多发一次保存），
  // 调用处写明在等页面的哪个计时器、毫秒数从哪来。等「某件事发生」用 endsOn / waitForFunction / quiet，不用它。
  waitPageTime: async (page, ms) => {
    const start = await page.evaluate(() => performance.now());
    await page.waitForFunction(end => performance.now() >= end, start + ms, { polling:50 });
  },
  // 读到最终值为止：反复 read()，直到结果符合 expected（正则就 match，否则 deepEqual）或超时，再断言最后读到的那次。
  // 数字滚动、标签切换、弹窗开关这类「最后会变成什么」的东西用它：机器忙的时候动画跑得慢，固定等待会读到半路的值
  // （2026-11-11 WebKit 上读到 ¥189.07 / ¥211.00）。读到了就立刻往下走，不多等。
  endsOn: async (read, expected, message, { timeout = 8000 } = {}) => {
    const matches = value => {
      if (expected instanceof RegExp) return expected.test(value);
      try { assert.deepStrictEqual(value, expected); return true; } catch (_) { return false; }
    };
    const deadline = Date.now() + timeout;
    let value = await read();
    while (!matches(value) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      value = await read();
    }
    if (expected instanceof RegExp) assert.match(value, expected, message);
    else assert.deepStrictEqual(value, expected, message);
  },
  // 等页面画完 count 帧：布局、ResizeObserver 回调、requestAnimationFrame 里的重画都跑过了（改窗口大小之后量尺寸用）。
  frames: (page, count = 2) => page.evaluate(n => new Promise(resolve => {
    const step = left => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
    step(n);
  }), count),
  // 等页面安静下来：连续两帧没有在跑的（有尽头的）CSS 动画或过渡——弹窗开合、抽屉滑入、提示弹入、菜单缩放。
  // 代替以前的「等 250 毫秒」：动画跑完就往下走，机器慢就多等。无限循环的动画（加载转圈）不算。
  // 只管动画；页面里用 setTimeout 推迟的事（确认框 50ms 后才聚焦按钮、保存防抖）要等那件事本身。
  quiet: async page => {
    const still = await page.evaluate(() => new Promise(resolve => {
      const started = performance.now();
      let calm = 0;
      const check = () => {
        const moving = document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getComputedTiming?.().endTime !== Infinity);
        calm = moving.length ? 0 : calm + 1;
        if (calm >= 2) return resolve('');
        if (performance.now() - started > 10000) return resolve(moving.map(a => `${a.animationName || a.transitionProperty || 'animation'} on ${a.effect.target?.outerHTML?.slice(0, 80)}`).join('; '));
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    }));
    if (still) throw new Error(`the page kept animating for 10 s: ${still}`);
  }
};

module.exports = { launchBrowser, openBoard, h, base, month, day, html };
