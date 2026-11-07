// Shared setup for the board / stage UI tests: the real page with an in-memory /api/data + /api/save,
// and real-mouse helpers (mouse.down / move / up for HTML5 drag and drop, real right clicks).
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'trade-order-system.html'), 'utf8');
const pad = n => String(n).padStart(2, '0');
const today = new Date();
const month = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
const day = n => `${month}-${pad(n)}`;
const base = { currency:'USD', logisticsStatus:'未发货', createdAt:day(1), orderMonth:month, logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', shipments:[], attachments:[] };

async function launchBrowser() {
  try { return await chromium.launch({ headless:true }); }
  catch (_) { return chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium' }); }
}

// data: the stored app data (orders, doneTasks, …). Returns { page, store, errors, dialogs }.
async function openBoard(browser, data, { width = 1440, height = 920, theme = 'light', port = 47990 } = {}) {
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
    if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
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
  clearToasts: page => page.evaluate(() => document.querySelectorAll('#toast .toast-item').forEach(el => el.remove())),
  flush: page => page.evaluate(() => window.flushPendingSave?.()),
  center: async (page, selector) => {
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    return { x:box.x + box.width / 2, y:box.y + box.height / 2, box };
  },
  columnPoint: async (page, stage) => {
    const box = await page.locator(`#pipeline .board-column[data-stage="${stage}"]`).boundingBox();
    return { x:box.x + box.width / 2, y:box.y + Math.min(box.height - 20, 160) };
  },
  // 真实鼠标拖拽：按下卡片、分几步移到目标列、（可选）在松手前检查、松手。
  async drag(page, id, stage, { beforeUp = null } = {}) {
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
  },
  async rightClick(page, id) {
    const point = await h.center(page, `#pipeline .board-card[data-id="${id}"]`);
    await page.mouse.click(point.x, point.y, { button:'right' });
    await page.waitForSelector('.board-menu');
    return point;
  },
  // 等到页面里的时钟走过 ms 毫秒（证明某件事「没有」发生时用；比固定 sleep 少等、不受测试机快慢影响）。
  waitPageTime: async (page, ms) => {
    const start = await page.evaluate(() => performance.now());
    await page.waitForFunction(end => performance.now() >= end, start + ms, { polling:50 });
  }
};

module.exports = { launchBrowser, openBoard, h, base, month, day, html };
