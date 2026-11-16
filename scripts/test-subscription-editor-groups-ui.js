#!/usr/bin/env node
// 续费编辑器分四组：费用、时间、续费和提醒、归类。每组一个小标题，13 个字段一个不少；
// 每一行两栏都填满（没有空着的半行）；同一行顶端对齐，提示多一行时旁边的输入框不跟着下移；
// Tab 顺序就是看到的顺序；打开时焦点在「名称」。
// 编辑已有项时「下次扣费日」真的藏住（以前 .subs-field 的 display:flex 盖掉了 hidden，填了日期会改掉开始日期），
// 「开始日期」占满整行。窄窗口单栏。
// 真实 mac-app/server.js（临时数据目录）+ 真实鼠标键盘。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');

const GROUPS = [
  { title:'费用', fields:['名称', '金额', '扣费周期'] },
  { title:'时间', fields:['开始日期', '下次扣费日', '预计停止'] },
  { title:'续费和提醒', fields:['续费方式', '提前提醒', '付款方式'] },
  { title:'归类', fields:['类型', '服务商', '备注', '样式'] }
];

// Every group, its title and the visible fields with their boxes, read in one go.
const readLayout = page => page.evaluate(() => {
  const form = document.getElementById('subscriptionEditForm');
  const box = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, width:r.width }; };
  const groups = [...form.querySelectorAll('.subs-grp')].map(group => ({
    title:group.querySelector(':scope > .subs-grp-h')?.firstChild?.textContent.trim() || '',
    labelled:document.getElementById(group.getAttribute('aria-labelledby'))?.closest('.subs-grp') === group,
    box:box(group),
    fields:[...group.querySelectorAll(':scope > .subs-field')].filter(field => field.getClientRects().length).map(field => ({
      id:field.id,
      label:field.querySelector(':scope > label, :scope > .subs-label')?.firstChild?.textContent.trim() || '',
      box:box(field)
    }))
  }));
  return { groups, fieldCount:form.querySelectorAll('.subs-field').length };
});

// A row is the fields that share a top edge; together they reach from the group's left edge to its right edge.
const assertRowsFilled = (layout, label) => {
  for (const group of layout.groups) {
    const rows = new Map();
    group.fields.forEach(field => {
      const key = [...rows.keys()].find(top => Math.abs(top - field.box.top) < 2) ?? field.box.top;
      rows.set(key, [...(rows.get(key) || []), field]);
    });
    for (const fields of rows.values()) {
      const left = Math.min(...fields.map(field => field.box.left));
      const right = Math.max(...fields.map(field => field.box.right));
      assert.ok(Math.abs(left - group.box.left) < 1.5 && Math.abs(right - group.box.right) < 1.5,
        `${label}: the row ${fields.map(field => field.label).join(' ｜ ')} in ${group.title} fills both columns (${left}–${right} of ${group.box.left}–${group.box.right})`);
    }
  }
};

const inputTop = (page, id) => page.locator(`#${id}`).evaluate(el => {
  // The in-app select hides the native one and shows a button in its place.
  const shown = el.getClientRects().length ? el : el.parentElement.querySelector('.app-select-button');
  return shown.getBoundingClientRect().top;
});

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-subscription-editor-groups-'));
  const port = freePortSync();
  const token = `subscription-editor-groups-${process.pid}`;
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
    // Made-up record, priced in USD so the 金额 field shows its two-line conversion hint.
    await api('/api/subscriptions/save', { item:{ name:'Example VPS', amount:10, currency:'USD', cycleUnit:'month', cycleCount:1, startDate:'2026-01-07', category:'VPS', provider:'Example Host', color:'#0f9d8a' } });
    const saved = (await api('/api/subscriptions')).items.find(item => item.name === 'Example VPS');

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, locale:'zh-CN' });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    await page.goto(`${url}/trade-order-system.html?token=${token}`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => setPage('subscriptions'));
    await page.locator('#page-subscriptions .subs-row').first().waitFor();
    const click = (selector, label) => h.click(page, selector, label);
    const isOpen = () => page.evaluate(() => document.getElementById('subscriptionEditModal').classList.contains('open'));

    // ---- 1. A new record: four groups, every field, 下次扣费日 beside 开始日期 ----
    await click('#subsAddBtn', '新增续费项');
    await page.locator('#subscriptionEditModal.open').waitFor();
    await h.settle(page, '#subscriptionEditModal .subs-modal');
    await page.waitForFunction(() => document.activeElement?.id === 'subscriptionName');
    let layout = await readLayout(page);
    assert.equal(layout.fieldCount, 13, 'all 13 fields are still there');
    assert.deepEqual(layout.groups.map(group => ({ title:group.title, fields:group.fields.map(field => field.label) })), GROUPS);
    assert.ok(layout.groups.every(group => group.labelled), 'each group is named by its own heading');
    assert.equal(await page.locator('#subscriptionGroupSort small').innerText(), '不影响金额');
    assertRowsFilled(layout, 'new record');
    assert.equal(await page.locator('#subscriptionNextField').isVisible(), true, 'a new record offers 下次扣费日');
    // 下次扣费日 has a two-line hint and 开始日期 none: the two inputs still start on the same line.
    assert.ok(Math.abs(await inputTop(page, 'subscriptionStart') - await inputTop(page, 'subscriptionNext')) < 1, '开始日期 and 下次扣费日 are top-aligned');
    assert.ok(Math.abs(await inputTop(page, 'subscriptionRemind') - await page.locator('#subscriptionEditForm .subs-renew').evaluate(el => el.getBoundingClientRect().top)) < 1, 'the 续费方式 switch row and 提前提醒 start on the same line');
    // What you see top to bottom, left to right, is the order of the page (and so of Tab).
    const visual = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('#subscriptionEditForm .subs-field')].filter(field => field.getClientRects().length);
      const sorted = [...fields].sort((a, b) => { const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect(); return Math.abs(ra.top - rb.top) < 2 ? ra.left - rb.left : ra.top - rb.top; });
      return sorted.every((field, i) => field === fields[i]);
    });
    assert.equal(visual, true, 'the visual order matches the order in the page');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'subscriptionAmount', 'Tab goes from 名称 to 金额 beside it');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));

    // ---- 2. Editing: 下次扣费日 is really hidden and 开始日期 takes the whole row ----
    await click(`#page-subscriptions [data-sub-edit="${saved.id}"]`, '编辑 Example VPS');
    await page.locator('#subscriptionEditModal.open').waitFor();
    await h.settle(page, '#subscriptionEditModal .subs-modal');
    assert.equal(await page.locator('#subscriptionEditTitle').innerText(), '编辑续费项');
    assert.equal(await page.locator('#subscriptionNextField').isVisible(), false, 'an existing record does not show 下次扣费日');
    assert.equal(await page.locator('#subscriptionNext').isVisible(), false);
    layout = await readLayout(page);
    assert.deepEqual(layout.groups[1].fields.map(field => field.label), ['开始日期', '预计停止']);
    assertRowsFilled(layout, 'existing record');
    // The amount hint takes two lines; 名称 beside it stays where it was.
    assert.ok((await page.locator('#subscriptionAmountHint').innerText()).length > 0, 'a USD price shows its conversion');
    assert.ok(Math.abs(await inputTop(page, 'subscriptionName') - await inputTop(page, 'subscriptionAmount')) < 1, '名称 and 金额 are top-aligned');
    // Tabbing from 开始日期 never lands in the hidden field.
    await click('#subscriptionStart', '开始日期');
    await page.locator('#datePickerPopover').waitFor({ state:'visible' });
    await page.keyboard.press('Escape'); // closes the calendar, not the dialog
    await page.locator('#datePickerPopover').waitFor({ state:'hidden' });
    assert.equal(await isOpen(), true);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'subscriptionNext', 'Tab skips the hidden 下次扣费日');
    }
    assert.equal(await page.locator('#subscriptionStart').inputValue(), '2026-01-07', 'the start date is untouched');
    await click('#subscriptionEditCancelBtn', '取消');
    await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));

    // ---- 3. Narrow window: one column, every field the width of its group ----
    await page.setViewportSize({ width:600, height:900 });
    await click('#subsAddBtn', '新增续费项');
    await page.locator('#subscriptionEditModal.open').waitFor();
    await h.settle(page, '#subscriptionEditModal .subs-modal');
    layout = await readLayout(page);
    for (const group of layout.groups) {
      for (const field of group.fields) assert.ok(Math.abs(field.box.width - group.box.width) < 1.5, `narrow: ${field.label} takes the whole width`);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open'));
    assert.equal(await isOpen(), false);

    assert.equal((await api('/api/subscriptions')).items.find(item => item.id === saved.id).startDate, '2026-01-07', 'nothing was saved');
    assert.deepEqual(dialogs, [], 'no native alert / confirm / prompt');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Subscription editor groups UI test passed: four titled groups with all 13 fields, no half-empty rows, top-aligned rows, visual = Tab order, 下次扣费日 hidden when editing with 开始日期 on the whole row, single column when narrow, real server.');
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
