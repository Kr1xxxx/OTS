#!/usr/bin/env node
// 续费：改价 / 改周期不再倒推历史、手动续费要点「已续费」、两个窗口同时改同一项、编辑器键盘操作。
// 真实 mac-app/server.js（临时数据目录、真实 SQLite）+ 真实鼠标键盘；每次点击前确认那一点最上层就是目标。
// - 「从下一期起」：已经发生的扣费保持当时的价格和周期，撤销后原样回来，数据库里没有丢东西；
// - 手动续费过了到期日没点「已续费」：列表、铃铛显示「已过期 N 天」，点「已续费」后顺延一年，可撤销；
// - 编辑时另一个窗口先保存了：不再悄悄覆盖，问「用我的覆盖 / 放弃我的改动」；
// - 选项组只占一个 Tab 位，← → 换选项；弹窗一律是页面里的确认框，没有原生 alert / confirm。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const pad = n => String(n).padStart(2, '0');
const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const addDays = (text, days) => { const [y, m, d] = text.split('-').map(Number); return localDate(new Date(y, m - 1, d + days)); };
const addMonths = (text, months) => {
  const [y, m, d] = text.split('-').map(Number);
  const last = new Date(y, m - 1 + months + 1, 0).getDate();
  return localDate(new Date(y, m - 1 + months, Math.min(d, last)));
};

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-subscription-edits-'));
  const port = freePortSync();
  const token = `subscription-edits-${process.pid}`;
  const env = { ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1' };
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env, stdio:'ignore' });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${url}/api/health`)).ok; } catch (_) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'server starts');
    const api = async (route, body) => {
      const response = await fetch(url + route, { method:body ? 'POST' : 'GET', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) });
      const data = await response.json();
      assert.ok(response.ok, `${route}: ${data.message}`);
      return data;
    };
    const record = async name => (await api('/api/subscriptions')).items.find(item => item.name === name);

    // Monthly ¥10 since the 1st, four months ago: five charges so far (this month's included).
    const today = localDate();
    const start = `${addMonths(today, -4).slice(0, 7)}-01`;
    const nextCharge = `${addMonths(today, 1).slice(0, 7)}-01`;
    await api('/api/subscriptions/save', { item:{ name:'Linode', amount:10, currency:'CNY', cycleUnit:'month', cycleCount:1, startDate:start, category:'VPS', provider:'Akamai', color:'#0f9d8a' } });
    // A yearly domain renewed by hand, due five days ago and not renewed yet.
    const due = addDays(today, -5);
    const domainStart = addMonths(due, -12);
    await api('/api/subscriptions/save', { item:{ name:'example.net', amount:60, currency:'CNY', cycleUnit:'month', cycleCount:12, startDate:domainStart, category:'域名', provider:'Namecheap', autoRenew:false, renewedThrough:domainStart, color:'#e8590c' } });

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 } });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    await page.goto(`${url}/trade-order-system.html?token=${token}`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('subscriptions'));
    await page.locator('#subsList .subs-row').first().waitFor();

    // Real mouse click on the element's centre, after checking nothing (a toast, an animation) covers it.
    const click = async (selector, { locator = null } = {}) => {
      let hit = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const target = locator || page.locator(selector).first();
        await target.waitFor({ state:'visible' });
        await target.scrollIntoViewIfNeeded();
        await target.evaluate(el => new Promise(resolve => {
          const moving = () => document.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming?.().endTime !== Infinity && a.effect.target instanceof Element && (a.effect.target.contains(el) || el.contains(a.effect.target)));
          const check = () => (el.isConnected && moving() ? requestAnimationFrame(check) : resolve());
          check();
        }));
        const box = await target.boundingBox();
        const point = { x:box.x + box.width / 2, y:box.y + box.height / 2 };
        hit = await target.evaluate((el, p) => { const top = document.elementFromPoint(p.x, p.y); return top === el || el.contains(top) ? '' : (top?.outerHTML || 'nothing').slice(0, 160); }, point);
        if (!hit) return page.mouse.click(point.x, point.y);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      assert.fail(`${selector} is covered: ${hit}`);
    };
    const row = name => page.locator('#subsList .subs-row', { hasText:name });
    const confirmOpen = async () => {
      await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      await h.settle(page, '#confirmModal .modal');
      return page.evaluate(() => ({ title:document.getElementById('confirmTitle').textContent, message:document.getElementById('confirmMessage').textContent, ok:document.getElementById('confirmOkBtn').textContent, alt:document.getElementById('confirmAltBtn').hidden ? '' : document.getElementById('confirmAltBtn').textContent, cancel:document.getElementById('confirmCancelBtn').textContent }));
    };
    const confirmClosed = () => page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    const editorClosed = () => page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
    const holdToast = async text => {
      await h.waitToast(page, text);
      const box = await page.locator('#toast .toast-item:not(.leaving)', { hasText:text }).last().boundingBox();
      await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 3 + 2, box.y + box.height / 2);
    };
    const undoToast = async text => {
      await holdToast(text);
      await click('', { locator:page.locator('#toast .toast-item:not(.leaving)', { hasText:text }).last().locator('.toast-undo') });
    };

    // ---- 1. Manual renewal past its date: overdue everywhere until 「已续费」 ----
    const domainPill = row('example.net').locator('.subs-pill');
    assert.match(await domainPill.innerText(), /已过期 5 天/);
    assert.match(await domainPill.getAttribute('class'), /\bred solid\b/);
    await click('#notifBtn');
    const bellCard = page.locator('#notifList .notif-card', { hasText:'example.net' });
    await bellCard.waitFor();
    assert.match(await bellCard.getAttribute('class'), /\bis-error\b/);
    assert.equal(await bellCard.locator('.notif-cd').innerText(), '已过期 5 天，未续费');
    assert.equal(await page.locator('#notifList .notif-card').first().evaluate(card => card.dataset.subId !== ''), true, 'the overdue renewal is first in the bell');
    await click('', { locator:bellCard });
    await page.locator('#subscriptionDrawer.open [data-sub-action="renewed"]').waitFor();
    assert.match(await page.locator('#subscriptionDrawer .subs-card').first().innerText(), /已过期/);
    await click('#subscriptionDrawer [data-sub-action="renewed"]');
    await holdToast('example.net 已续费');
    assert.equal((await record('example.net')).renewedThrough, due, 'the overdue renewal is recorded');
    assert.match(await domainPill.innerText(), new RegExp(`${addMonths(due, 12).slice(due.slice(0, 4) === addMonths(due, 12).slice(0, 4) ? 5 : 0)}`));
    assert.doesNotMatch(await domainPill.innerText(), /已过期/);
    await undoToast('example.net 已续费');
    await h.waitToast(page, '已撤销');
    assert.equal((await record('example.net')).renewedThrough, domainStart, 'undo puts the renewal back to unpaid');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('subscriptionDrawer').classList.contains('open'));

    // ---- 2. 改价 + 改周期 from the next period: what was charged keeps its price and cycle ----
    await click('', { locator:row('Linode').locator('[data-sub-edit]') });
    await page.locator('#subscriptionEditModal.open').waitFor();
    await h.settle(page, '#subscriptionEditModal .subs-modal');
    // Option groups are one Tab stop each; ← → move inside and pick.
    const cycleGroup = page.locator('#subscriptionEditForm [data-sub-opts="cycle"]');
    assert.equal(await cycleGroup.locator('[data-opt-value][tabindex="0"]').count(), 1);
    assert.equal(await cycleGroup.locator('[data-opt-value][tabindex="0"]').getAttribute('data-opt-value'), 'month:1');
    await page.locator('#subscriptionAmount').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('20');
    await cycleGroup.locator('[data-opt-value="month:1"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.activeElement?.dataset.optValue === 'month:3' && document.activeElement.getAttribute('aria-pressed') === 'true');
    assert.equal(await cycleGroup.locator('[data-opt-value][tabindex="0"]').getAttribute('data-opt-value'), 'month:3');
    await click('#subscriptionSaveBtn');
    const plan = await confirmOpen();
    assert.equal(plan.title, '这次修改从哪一期起生效？');
    assert.match(plan.message, new RegExp(`默认从下一期 ${nextCharge}（第 6 期）起按新的价格、扣费周期计，已经发生的 5 笔 ¥50\\.00 保持不变`));
    assert.match(plan.message, /更正全部历史/);
    assert.deepEqual([plan.ok, plan.alt, plan.cancel], ['从下一期起', '更正全部历史', '继续编辑']);
    await click('#confirmOkBtn');
    await confirmClosed();
    await editorClosed();
    await holdToast('Linode 已保存');
    const split = await record('Linode');
    assert.deepEqual({ startDate:split.startDate, amount:split.amount, cycleCount:split.cycleCount }, { startDate:nextCharge, amount:20, cycleCount:3 });
    assert.deepEqual(split.terms.map(term => ({ startDate:term.startDate, until:term.until, amount:term.amount, cycleCount:term.cycleCount })), [{ startDate:start, until:nextCharge, amount:10, cycleCount:1 }],
      'the old price and cycle are kept for the charges already made');
    // History still lists the five ¥10 charges.
    await click('[data-page="subs-history"].nav-sub-item');
    await page.locator('#subsHistory .subs-h-row').first().waitFor();
    const linodeRows = page.locator('#subsHistory .subs-h-row', { hasText:'Linode' });
    assert.equal(await linodeRows.count(), 5);
    assert.deepEqual([...new Set(await linodeRows.locator('.subs-h-v b').allInnerTexts())], ['¥10.00']);
    assert.match(await linodeRows.first().innerText(), /第 5 次扣费 · VPS · 月付/);
    // The drawer opens over the history; old periods are marked with the old settings.
    await click('', { locator:linodeRows.first() });
    await page.locator('#subscriptionDrawer.open .subs-per').first().waitFor();
    assert.equal(await page.locator('.page-title').innerText(), '续费历史');
    assert.match(await page.locator('#subscriptionDrawer .subs-pers').innerText(), /月付·旧设置/);
    assert.match(await page.locator('#subscriptionDrawer .subs-card').nth(2).innerText(), /¥50\.00[\s\S]*已扣费 5 次/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.closest?.('.subs-h-row')?.textContent.includes('Linode'));
    // Undo the edit: back to one monthly ¥10 setting, nothing lost.
    await undoToast('Linode 已保存');
    await h.waitToast(page, '已撤销');
    const undone = await record('Linode');
    assert.deepEqual({ startDate:undone.startDate, amount:undone.amount, cycleCount:undone.cycleCount, terms:undone.terms }, { startDate:start, amount:10, cycleCount:1, terms:[] });

    // ---- 3. Two windows: the other one saved first ----
    await click('[data-page="subscriptions"].nav-sub-item');
    await row('Linode').waitFor();
    await click('', { locator:row('Linode').locator('[data-sub-edit]') });
    await page.locator('#subscriptionEditModal.open').waitFor();
    await page.locator('#subscriptionNote').click();
    await page.keyboard.type('这边写的备注');
    const fresh = await record('Linode');
    await api('/api/subscriptions/save', { item:{ ...fresh, note:'另一个窗口的备注' } });
    await click('#subscriptionSaveBtn');
    const conflict = await confirmOpen();
    assert.equal(conflict.title, '这一项在别处改过');
    assert.deepEqual([conflict.ok, conflict.alt, conflict.cancel], ['用我的覆盖', '放弃我的改动', '继续编辑']);
    await click('#confirmCancelBtn');
    await confirmClosed();
    assert.equal(await page.locator('#subscriptionNote').inputValue(), '这边写的备注', '继续编辑 keeps what was typed');
    await click('#subscriptionSaveBtn');
    await confirmOpen();
    await click('#confirmAltBtn');
    await confirmClosed();
    await editorClosed();
    await h.waitToast(page, '已换成另一个窗口保存的版本');
    assert.equal((await record('Linode')).note, '另一个窗口的备注', 'the other window’s save is not overwritten');
    assert.match(await row('Linode').locator('.subs-meta').innerText(), /另一个窗口的备注/);

    assert.deepEqual(dialogs, [], 'no native alert / confirm / prompt');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Subscription history/edits UI test passed: overdue manual renewal (row, bell, 已续费, undo), from-next-period price + cycle change keeps history (history, drawer, undo), edit conflict with another window, option keyboard roving, real server.');
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); setTimeout(resolve, 3000); });
    try { fs.rmSync(dataDir, { recursive:true, force:true }); } catch (_) {}
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
