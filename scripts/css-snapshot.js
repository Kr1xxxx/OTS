#!/usr/bin/env node
// Computed-style snapshot of the page, the safety net for refactoring its stylesheets (merging the two generations of
// styles, deleting rules nobody uses). A tool, not a test: nothing in `npm test` runs it.
//
// It opens trade-order-system.html in Chromium with fixed data and a fixed clock, walks a fixed list of states (every
// page, every dialog and drawer, light and dark, every accent, the Mac window, several widths, empty data) and records,
// for every rendered element, every computed property of the element and of its ::before / ::after / ::placeholder.
// In the full configurations it also forces :hover, :focus, :focus-visible, :focus-within, :active, :disabled and
// :checked (through the DevTools protocol) on the elements the stylesheet has such rules for, and records what that changes nearby.
//
//   node scripts/css-snapshot.js --base origin/main        snapshot the page at that git ref and the working tree,
//                                                          print every difference; exit 1 when there is one
//   node scripts/css-snapshot.js --base-file old.html      the same, against a file
//   node scripts/css-snapshot.js --out snap.json           write one snapshot of the working tree (or --html <file>)
//   node scripts/css-snapshot.js --compare a.json b.json   compare two written snapshots
//
// Options: --only <regex> (states whose name matches), --quick (light and dark at 1440 only), --jobs <n>,
// --list (print the states and exit), --limit <n> (differences printed per state, default 40),
// --shots <dir> (a screenshot of every state of the working tree, to see that each state shows what its name says).
//
// It also compares the @keyframes by name, as text, because the styles are read with every animation at its end.
//
// What it does not see, so a change there needs its own proof: any engine but Chromium (the app runs in WebKit);
// vendor pseudo-elements (::-webkit-scrollbar, the number spin buttons, ::-webkit-details-marker); a state that is
// not in the list below (a class or attribute the script sets only in some situation); and the moment before the
// main script sets data-theme on <html>.
//
// A refactor is done when `--base origin/main` reports nothing. Two snapshots written with --out on different days
// can differ in dates the page computes from the real calendar; compare in one run with --base instead.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { createSubscriptionStore } = require('../mac-app/subscription-store');

const root = path.resolve(__dirname, '..');
const pagePath = path.join(root, 'trade-order-system.html');

// ---------------------------------------------------------------------------------------------------------------
// Command line

function parseArgs(argv) {
  const args = { jobs:Math.max(1, Math.min(4, (os.availableParallelism?.() || os.cpus().length))), limit:40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--base') args.base = next();
    else if (a === '--base-file') args.baseFile = next();
    else if (a === '--html') args.html = next();
    else if (a === '--out') args.out = next();
    else if (a === '--compare') { args.compare = [next(), next()]; }
    else if (a === '--only') args.only = new RegExp(next());
    else if (a === '--jobs') args.jobs = Math.max(1, Number(next()) || 1);
    else if (a === '--limit') args.limit = Math.max(1, Number(next()) || 40);
    else if (a === '--quick') args.quick = true;
    else if (a === '--shots') args.shots = next();
    else if (a === '--list') args.list = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------------------------------------------
// Fixed data. The orders are the page's own demo orders (read from the page once), plus shipments, attachments,
// tracking lookups, deleted orders and renewals so that every page has something to draw.

const FIXED_NOW = '2026-04-30T10:00:00+08:00';
const TODAY = '2026-04-30';
// 1×1 PNG, served for every attachment image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function enrichData(demo) {
  const orders = JSON.parse(JSON.stringify(demo.orders));
  const byId = id => orders.find(order => order.id === id);
  const attach = (order, n) => {
    const url = `/attachments/${order.num}/${order.num}-${n}.png`;
    return { name:`${order.num}-${n}`, type:'图片附件', link:url, fileUrl:url, thumbUrl:url, size:2048, optimized:true, optimizer:'本地压缩' };
  };
  const o8 = byId('o8');
  if (o8) {
    o8.shipments = [
      { id:'o8-1', trackingNumber:'1234567890', carrier:'DHL', status:'运输中', shippedAt:'2026-04-25', updated:'2026-04-27 09:00' },
      { id:'o8-2', trackingNumber:'1Z999AA10123456784', carrier:'UPS', status:'已签收', shippedAt:'2026-04-20', updated:'2026-04-24 15:00' }
    ];
    o8.attachments = [attach(o8, 1), attach(o8, 2)];
  }
  const o4 = byId('o4');
  if (o4) o4.attachments = [attach(o4, 1)];
  const o6 = byId('o6');
  if (o6) o6.shipments = [{ id:'o6-1', trackingNumber:'2222222222', carrier:'DHL', status:'异常', shippedAt:'2026-04-22', updated:'2026-04-29 12:00' }];
  const deletedOrders = [{ ...JSON.parse(JSON.stringify(orders.at(-1))), id:'x1', num:'SO251001099', deletedAt:'2026-04-29 10:00' }];
  const trackingLookups = [
    { id:'lk-1', trackingNumber:'1234567890', carrier:'DHL', checkedAt:'2026-04-29 08:00', orderId:'o8', client:o8?.client || '', displayClient:'', orderNum:o8?.num || '', shippedAt:'2026-04-25', status:'运输中', statusUpdatedAt:'2026-04-29 08:00', queryMessage:'DHL API 已同步：运输中', online:'是', pinned:false, events:[{ time:'2026-04-29 08:00', title:'Processed at LEIPZIG', location:'Leipzig' }, { time:'2026-04-26 18:00', title:'Shipment picked up', location:'Guangzhou' }] },
    { id:'lk-2', trackingNumber:'2222222222', carrier:'DHL', checkedAt:'2026-04-29 12:00', orderId:'o6', client:o6?.client || '', displayClient:'', orderNum:o6?.num || '', shippedAt:'2026-04-22', status:'异常', statusUpdatedAt:'2026-04-29 12:00', queryMessage:'', online:'是', pinned:false, events:[{ time:'2026-04-29 12:00', title:'Shipment on hold', location:'Sydney' }] },
    { id:'lk-3', trackingNumber:'9999999999', carrier:'DHL', checkedAt:'2026-04-28 09:00', orderId:'', client:'Prospect Sample', displayClient:'Prospect Sample', orderNum:'-', status:'运输中', statusUpdatedAt:'2026-04-28 09:00', online:'是', pinned:true, events:[] }
  ];
  return {
    ...demo,
    orders,
    deletedOrders,
    trashOrders:[],
    trackingLookups,
    performanceTargets:{ '2026-04':{ amount:80000 } },
    doneTasks:{},
    demoCleared:true,
    demoCustomersCleared:true
  };
}

function subscriptionList() {
  const store = createSubscriptionStore(new DatabaseSync(':memory:'));
  [
    { name:'Vault Tool', note:'家庭版', amount:35.88, currency:'USD', cycleMonths:12, startDate:'2022-05-18', category:'软件', color:'#2f6fde' },
    { name:'Chat Helper', note:'个人账号', amount:20, currency:'USD', cycleMonths:1, startDate:'2025-11-18', category:'AI', color:'#5b3cc4' },
    { name:'Example Domain', note:'', amount:69, currency:'CNY', cycleMonths:12, startDate:'2025-05-03', category:'域名', color:'#e8590c' },
    { name:'Tiny VPS', note:'', amount:5, currency:'USD', cycleMonths:1, startDate:'2026-01-02', category:'VPS', color:'#0f9d8a' }
  ].forEach(item => store.save(item));
  return store.list();
}

const emptyData = { orders:[], customers:{}, deletedOrders:[], trashOrders:[], trackingLookups:[], doneTasks:{}, demoCleared:true, demoCustomersCleared:true };

// ---------------------------------------------------------------------------------------------------------------
// Configurations and states

const W = { wide:1600, std:1440, w1360:1360, w1300:1300, w1200:1200, w1180:1180, min:1100, w1050:1050, w950:950, w880:880, w840:840, w800:800, w740:740, w710:710, w680:680, w620:620, w560:560, w480:480, phone:390 };

// Each configuration loads the page fresh for every state it runs.
// states: 'all' = pages and overlays; 'pages' = pages only; or a list of state names.
function configurations(quick) {
  const list = [
    { name:'light', theme:'light', width:W.std, states:'all', force:true },
    { name:'dark', theme:'dark', width:W.std, states:'all', force:true }
  ];
  if (quick) return list;
  for (const theme of ['light', 'dark']) {
    list.push({ name:`${theme}-1180`, theme, width:W.w1180, states:'all' });
    list.push({ name:`${theme}-1100`, theme, width:W.min, states:'all' });
    list.push({ name:`${theme}-mac`, theme, width:W.std, mac:true, states:'all' });
    list.push({ name:`${theme}-mac-fullscreen`, theme, width:W.std, mac:true, fullscreen:true, states:['page:dashboard', 'page:settings:appearance'] });
    list.push({ name:`${theme}-empty`, theme, width:W.std, data:'empty', states:'pages' });
    list.push({ name:`${theme}-phone`, theme, width:W.phone, height:844, touch:true, states:'all' });
    for (const accent of ['blue', 'teal', 'orange', 'rose', 'ink']) {
      list.push({ name:`${theme}-accent-${accent}`, theme, width:W.std, accent, states:['page:dashboard', 'page:order-list', 'page:settings:appearance', 'overlay:order-new', 'overlay:detail-info', 'overlay:customer-view', 'overlay:confirm', 'overlay:toasts', 'page:subscriptions'] });
    }
  }
  list.push({ name:'light-reduced-motion', theme:'light', width:W.std, motion:'reduce', states:['page:dashboard', 'overlay:order-new', 'page:subscriptions', 'overlay:toasts'] });
  // One width inside every interval between the stylesheet's max-width / min-width breakpoints.
  for (const [key, width] of Object.entries(W)) {
    if ([W.std, W.w1180, W.min, W.phone].includes(width)) continue;
    list.push({ name:`light-${key}`, theme:'light', width, states:'pages' });
  }
  list.push({ name:'dark-800', theme:'dark', width:W.w800, states:'pages' });
  return list;
}

const settingsTabs = ['data', 'order', 'customer', 'exchange', 'tracking-api', 'ai', 'feishu', 'api', 'appearance'];
const PAGES = [
  ['dashboard', p => p.evaluate(() => setPage('dashboard'))],
  ['order-list', p => p.evaluate(() => setPage('order-list'))],
  ['search-results', p => p.evaluate(() => { openFullSearchResults('Trading'); })],
  ['logistics', p => p.evaluate(() => setPage('logistics'))],
  ['amount', p => p.evaluate(() => setPage('amount'))],
  ['targets', p => p.evaluate(() => setPage('targets'))],
  ['calendar', p => p.evaluate(() => setPage('calendar'))],
  ['customers', p => p.evaluate(() => setPage('customers'))],
  ['deleted', p => p.evaluate(() => setPage('deleted'))],
  ['subscriptions', p => p.evaluate(() => setPage('subscriptions'))],
  ['subs-analysis', p => p.evaluate(() => setPage('subs-analysis'))],
  ['subs-history', p => p.evaluate(() => setPage('subs-history'))],
  ...settingsTabs.map(tab => [`settings:${tab}`, p => p.evaluate(tab => { setPage('settings'); uiSettingsTab(tab); }, tab)])
].map(([name, run]) => ({ name:`page:${name}`, kind:'page', run }));

const firstClient = p => p.evaluate(() => state.orders.find(order => order.id === 'o1')?.client || state.orders[0]?.client || '');
const click = (p, selector) => p.evaluate(selector => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  el.click();
}, selector);
const detail = tab => async p => {
  await p.evaluate(() => setPage('dashboard'));
  await p.evaluate(tab => openOrderDetail('o8', { tab }), tab);
};
const OVERLAYS = [
  ['order-new', p => click(p, '#newOrderBtn')],
  ['order-new-invalid', async (p, settle) => {
    await click(p, '#newOrderBtn');
    await settle(p);
    await click(p, '#orderSaveBtn');
    await settle(p);
    if (!(await p.evaluate(() => document.querySelectorAll('#orderForm [aria-invalid="true"]').length))) throw new Error('saving an empty order marked no field');
  }],
  ['order-edit', p => p.evaluate(() => openOrder('o8'))],
  ['order-edit-deposit', p => p.evaluate(() => openOrder('o6'))],
  ['detail-info', detail('info')],
  ['detail-payment', detail('payment')],
  ['detail-logistics', detail('logistics')],
  ['detail-attachments', detail('attachments')],
  ['detail-records', detail('records')],
  ['customer-view', async p => { const name = await firstClient(p); await p.evaluate(name => openCustomerModal(name), name); }],
  ['customer-activity', async p => { const name = await firstClient(p); await p.evaluate(name => { openCustomerModal(name); uiCustomerDetailTab('activity', true); }, name); }],
  ['customer-whatsapp', async p => { const name = await firstClient(p); await p.evaluate(name => { openCustomerModal(name); uiCustomerDetailTab('whatsapp', true); }, name); }],
  ['customer-edit', async p => { const name = await firstClient(p); await p.evaluate(name => openCustomerModal(name, { viewOnly:false }), name); }],
  ['customer-new', p => p.evaluate(() => { setPage('customers'); openCustomerModal('', { viewOnly:false }); })],
  ['combined-new', p => p.evaluate(() => openCombinedCustomerOrderModal({}))],
  ['confirm', p => p.evaluate(() => { appConfirm({ title:'删除这张订单？', message:'删除后可以在「已删除订单」里恢复。', confirmText:'删除', danger:true }); })],
  ['attachment-preview', p => p.evaluate(() => openAttachmentPreview({ image:'/attachments/SO1/SO1-1.png', name:'SO1-1' }))],
  ['board-card-settings', p => p.evaluate(() => { setPage('dashboard'); openBoardCardSettings(); })],
  ['board-menu', async (p, settle) => {
    await p.evaluate(() => setPage('dashboard'));
    await settle(p);
    await p.evaluate(() => {
    const card = document.querySelector('#pipeline .board-card');
    const r = card.getBoundingClientRect();
    uiOpenBoardMenu(card, { x:r.left + 20, y:r.top + 20 });
    });
  }],
  ['board-drag', p => p.evaluate(() => {
    setPage('dashboard');
    const cards = document.querySelectorAll('#pipeline .board-card');
    const columns = document.querySelectorAll('#pipeline .board-column');
    cards[0]?.classList.add('dragging');
    columns[1]?.classList.add('drag-over');
    columns[2]?.classList.add('drag-invalid');
    document.getElementById('trashDrop')?.classList.add('drag-over');
  })],
  ['notifications', p => p.evaluate(() => uiToggleNotifs(true))],
  ['global-search', p => p.evaluate(() => {
    const input = document.getElementById('searchInput');
    input.focus();
    input.value = 'SO26';
    input.dispatchEvent(new Event('input', { bubbles:true }));
    renderGlobalSearchPanel({ forceOpen:true });
  })],
  ['client-menu', async (p, settle) => {
    await click(p, '#newOrderBtn');
    await settle(p);
    await p.evaluate(() => { const input = document.querySelector('#orderModal [name="client"], #orderModal #client, #orderModal input[data-client-input]'); input?.focus(); openClientMenu(input); });
  }],
  ['date-picker', async (p, settle) => {
    await click(p, '#newOrderBtn');
    await settle(p);
    await p.evaluate(() => { const input = document.querySelector('#orderModal [data-date-input], #orderModal input[name="createdAt"], #orderModal .date-input'); input?.focus(); openDatePicker(input); });
  }],
  ['app-select', async (p, settle) => {
    await click(p, '#newOrderBtn');
    await settle(p);
    await p.evaluate(() => {
      const button = [...document.querySelectorAll('#orderModal .app-select-button')].find(el => el.getClientRects().length);
      if (!openAppSelectFromButton(button)) throw new Error('no select button in the order dialog');
    });
  }],
  ['suggest-menu', async (p, settle) => {
    await click(p, '#newOrderBtn');
    await settle(p);
    await p.evaluate(() => { const input = document.querySelector('#orderModal input[name="country"], #orderModal #country'); if (input) { input.focus(); openSuggestMenu(input); } });
  }],
  ['calendar-day', p => p.evaluate(today => { setPage('calendar'); openCalendarTaskDrawer(today); }, TODAY)],
  ['tracking-detail', p => p.evaluate(() => { setPage('logistics'); openTrackingDetail('lk-1'); })],
  ['subs-detail', p => p.evaluate(() => { setPage('subscriptions'); const id = document.querySelector('[data-sub-id]')?.dataset.subId; if (id) openSubscriptionDetail(id); })],
  ['subs-edit', p => p.evaluate(() => { setPage('subscriptions'); openSubscriptionEditor(); })],
  ['subs-edit-existing', p => p.evaluate(() => { setPage('subscriptions'); const id = document.querySelector('[data-sub-id]')?.dataset.subId; if (id) openSubscriptionEditor(id); })],
  ['subs-price', p => p.evaluate(today => { setPage('subscriptions'); openSubscriptionPriceEditor(today); }, TODAY)],
  ['toasts', p => p.evaluate(() => {
    uiToast('已保存订单', { undo:() => {} });
    uiToast('运单已更新', { tone:'ok', desc:'DHL 1234567890' });
    uiToast('保存失败', { tone:'danger' });
  })],
  ['update-available', p => p.evaluate(() => otsAppUpdateStatus({ state:'available', version:'9.99' }))],
  ['update-downloading', p => p.evaluate(() => otsAppUpdateStatus({ state:'downloading', version:'9.99', progress:0.42, received:4200000, total:10000000 }))]
].map(([name, run]) => ({ name:`overlay:${name}`, kind:'overlay', run }));
const STATES = [...PAGES, ...OVERLAYS];

function jobsFor(configs, only) {
  const jobs = [];
  for (const config of configs) {
    const states = config.states === 'all' ? STATES : config.states === 'pages' ? PAGES : STATES.filter(s => config.states.includes(s.name));
    for (const s of states) {
      const name = `${config.name} ${s.name}`;
      if (!only || only.test(name)) jobs.push({ name, config, state:s });
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------------------------------------------
// In the page

// Selectors of the elements to force state pseudo-classes on: for every rule with :hover, :focus, :focus-visible,
// :focus-within, :active, :disabled or :checked (outside :not()), the part of the selector up to the compound that carries
// it, with the interaction pseudo-classes and pseudo-elements taken out. `.board-card:hover .quick` → `.board-card`.
function pageForceSelectors() {
  const out = new Map();
  const splitTop = text => {
    const parts = [];
    let depth = 0, start = 0, quote = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(text.slice(start).trim());
    return parts;
  };
  const strip = sel => sel.replace(/::?(?:before|after|placeholder|-webkit-[a-z-]+)\b/g, '').replace(/:(?:focus-visible|focus-within|hover|active|focus|disabled|checked)\b/g, '').trim();
  const add = (sel, pseudo) => {
    const cleaned = strip(sel).replace(/\s*[>+~]\s*$/, '').trim();
    if (!cleaned || cleaned === '*') return;
    try { document.querySelector(cleaned); } catch (_) { return; }
    if (!out.has(cleaned)) out.set(cleaned, new Set());
    out.get(cleaned).add(pseudo);
  };
  const scan = sel => {
    const re = /:(focus-visible|focus-within|hover|active|focus|disabled|checked)\b/g;
    let m;
    while ((m = re.exec(sel))) {
      // Depth and the functional pseudo-class we are inside.
      const stack = [];
      for (let i = 0; i < m.index; i++) {
        const c = sel[i];
        if (c === '(') { const fn = /:([a-z-]+)$/.exec(sel.slice(0, i)); stack.push(fn ? fn[1] : ''); }
        else if (c === ')') stack.pop();
      }
      if (stack.includes('not')) continue;
      const hasAt = stack.lastIndexOf('has');
      if (hasAt >= 0) {
        // `.x:has(input:focus)` → force on `.x input`.
        const open = (() => { let depth = 0; for (let i = m.index; i >= 0; i--) { if (sel[i] === ')') depth++; if (sel[i] === '(') { if (depth === 0 && sel.slice(0, i).endsWith(':has')) return i; depth = Math.max(0, depth - 1); } } return -1; })();
        if (open < 0) continue;
        let end = m.index + m[0].length;
        while (end < sel.length && !/[\s,)>+~]/.test(sel[end])) end++;
        const inner = sel.slice(open + 1, end).replace(/^\s*[>+~]\s*/, '');
        const outer = sel.slice(0, open - 4);
        add(`${outer} ${inner}`, m[1]);
        continue;
      }
      // Extend to the end of the compound selector at depth 0.
      let end = m.index + m[0].length, depth = stack.length;
      for (; end < sel.length; end++) {
        const c = sel[end];
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (depth === 0 && /[\s>+~]/.test(c)) break;
      }
      add(sel.slice(0, end), m[1]);
    }
  };
  const walk = rules => {
    for (const rule of rules) {
      if (rule.selectorText) splitTop(rule.selectorText).forEach(scan);
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch (_) {} }
  return [...out].map(([selector, set]) => [selector, [...set].sort()]);
}

// The @keyframes in effect, by name (the last one in the page wins). A snapshot reads styles with every animation
// stopped at its end, so what an animation does on the way is compared here, as text.
function pageKeyframes() {
  const out = {};
  const walk = rules => {
    for (const rule of rules) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) out[rule.name] = [...rule.cssRules].map(frame => frame.cssText).join(' ');
      else if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch (_) {} }
  return out;
}

// Stops every CSS animation and transition where it ends (endless ones at their start), so that computed values are
// the resting ones. Finishing can start new ones (animationend handlers), hence the loop.
function pageSettleAnimations() {
  for (let round = 0; round < 5; round++) {
    const running = document.getAnimations().filter(a => a.playState === 'running' || a.playState === 'pending' || (a.playState === 'paused' && a.currentTime !== 0 && a.effect?.getComputedTiming?.().endTime === Infinity));
    if (!running.length) return;
    for (const a of running) {
      try {
        if (a.effect?.getComputedTiming?.().endTime === Infinity) { a.pause(); a.currentTime = 0; }
        else a.finish();
      } catch (_) {}
    }
  }
}

// The snapshot of the rendered elements: every element whose own display is not `none` and that has no `display:none`
// ancestor (an element that is `display:none` itself is recorded, its subtree is not). Paths are child-index chains
// from <html>; labels (tag#id.classes) are for reading the report only.
function pageCapture({ names, region = null, keep = false, pseudoOnly = false }) {
  pageSettleAnimations();
  const SEP = '\u0001';
  const styles = new Map();
  const labels = new Map();
  const idx = (map, key) => { if (!map.has(key)) map.set(key, map.size); return map.get(key); };
  const styleString = cs => { let s = ''; for (const name of names) s += cs.getPropertyValue(name) + SEP; return s; };
  const customString = (cs, parentCs) => {
    const own = [];
    for (let i = 0; i < cs.length; i++) {
      const name = cs[i];
      if (!name.startsWith('--')) continue;
      const value = cs.getPropertyValue(name);
      if (!parentCs || parentCs.getPropertyValue(name) !== value) own.push(`${name}:${value}`);
    }
    return own.sort().join(SEP);
  };
  const pathOf = el => {
    const parts = [];
    for (let node = el; node !== document.documentElement; node = node.parentElement) {
      if (!node.parentElement) throw new Error(`element left the document while it was recorded: ${node.outerHTML.slice(0, 120)}`);
      parts.push([...node.parentElement.children].indexOf(node));
    }
    return parts.reverse().join('.');
  };
  const labelOf = el => {
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).map(c => `.${c}`).join('');
    return `${el.localName}${el.id ? `#${el.id}` : ''}${cls}`;
  };
  const base = window.__snapBase || (window.__snapBase = new WeakMap());
  const entries = [];
  const pseudoNames = ['::before', '::after'];
  const record = el => {
    const cs = getComputedStyle(el);
    const main = styleString(cs);
    const parent = el.parentElement;
    const custom = customString(cs, parent ? getComputedStyle(parent) : null);
    const extra = [];
    for (const p of pseudoNames) {
      const ps = getComputedStyle(el, p);
      const content = ps.getPropertyValue('content');
      if (content !== 'none' && content !== 'normal') extra.push(`${p}${SEP}${styleString(ps)}`);
    }
    if ((el.localName === 'input' || el.localName === 'textarea') && el.hasAttribute('placeholder')) extra.push(`::placeholder${SEP}${styleString(getComputedStyle(el, '::placeholder'))}`);
    const full = `${main}\u0002${custom}\u0002${extra.join('\u0003')}`;
    if (keep) base.set(el, full);
    else if (region && base.get(el) === full) return cs;
    const e = [pathOf(el), idx(labels, labelOf(el)), idx(styles, main), idx(styles, custom), extra.map(x => idx(styles, x))];
    entries.push(e);
    return cs;
  };
  const walk = el => {
    if (el.localName === 'script' || el.localName === 'style' || el.localName === 'head' || el.localName === 'template' || el.namespaceURI === 'http://www.w3.org/2000/svg' && el.localName !== 'svg') return;
    const cs = record(el);
    if (cs.display === 'none') return;
    for (const child of el.children) walk(child);
  };
  if (region) {
    // A forced pseudo-class on window.__snapTargets[region - 1]: the element with its subtree, the next two siblings
    // with theirs (`:focus-visible + i`), and its ancestors (`:has()`).
    const target = window.__snapTargets[region - 1][0];
    walk(target);
    for (let sib = target.nextElementSibling, n = 0; sib && n < 2; sib = sib.nextElementSibling, n++) walk(sib);
    for (let node = target.parentElement; node; node = node.parentElement) record(node);
    return { entries, styles:[...styles.keys()], labels:[...labels.keys()], target:pathOf(target) };
  } else {
    walk(document.documentElement);
  }
  return { entries, styles:[...styles.keys()], labels:[...labels.keys()] };
}

// Elements to force each pseudo-class on, at most two rendered matches per selector.
function pageForceTargets(selectors) {
  const seen = new Map();
  const list = [];
  for (const [selector, pseudos] of selectors) {
    let matches;
    try { matches = document.querySelectorAll(selector); } catch (_) { continue; }
    let taken = 0;
    for (const el of matches) {
      if (taken >= 2) break;
      if (!el.getClientRects().length) continue;
      taken++;
      for (const pseudo of pseudos) {
        if (!seen.has(el)) seen.set(el, new Set());
        if (seen.get(el).has(pseudo)) continue;
        seen.get(el).add(pseudo);
        list.push([el, pseudo]);
      }
    }
  }
  window.__snapTargets = list;
  return list.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Driving the browser

// Advances the page's (fake) clock so timers, requestAnimationFrame callbacks and count-up animations run to the end,
// then stops the CSS animations at their end.
async function settle(page, ms = 1500) {
  for (let i = 0; i < 3; i++) {
    await page.clock.runFor(ms / 3);
    await inPage(page, 'pageSettleAnimations');
  }
  await page.evaluate(() => document.fonts.ready.then(() => true));
  // Images (attachment thumbnails and previews) still loading change the layout a moment later, and with it what the
  // page measures: on a busy machine the size of an attachment preview came out 1px different run to run.
  // Wait for every image to be decoded (a broken one counts as done), then let the page react to the new sizes.
  const images = await page.evaluate(() => Promise.all([...document.images].filter(img => img.getAttribute('src')).map(img => img.decode().catch(() => {}))).then(list => list.length));
  if (images) {
    await page.clock.runFor(100);
    await inPage(page, 'pageSettleAnimations');
  }
}

// The page-side functions above, defined as globals of the page (they call each other).
const helperSource = [pageForceSelectors, pageKeyframes, pageSettleAnimations, pageCapture, pageForceTargets].map(fn => `window.${fn.name} = ${fn.toString()};`).join('\n');
const inPage = (page, name, arg) => page.evaluate(([name, arg]) => window[name](arg), [name, arg]);

async function loadPage(context, html, data, subs, config) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
  // Paused: the page's timers, requestAnimationFrame and Date move only when settle() advances them, so nothing
  // (a toast timing out, a clock ticking) changes between two reads.
  await page.clock.install({ time:new Date(new Date(FIXED_NOW).getTime() - 60000) });
  await page.clock.pauseAt(new Date(FIXED_NOW));
  await page.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
    if (pathname.startsWith('/attachments/')) return route.fulfill({ contentType:'image/png', body:PNG });
    let json = { ok:true };
    if (pathname === '/api/data') json = { app:'trade-order-system', revision:1, data };
    else if (pathname === '/api/save') json = { ok:true, revision:2, backup:{ ok:true, skipped:true } };
    else if (pathname === '/api/health') json = { ok:true, storageMode:'sqlite', counts:{ orders:(data.orders || []).length }, backups:{ sqliteCount:3, lastBackupAt:'2026-04-30T01:00:00.000Z' } };
    else if (pathname === '/api/ui-prefs') json = { ok:true, prefs:{} };
    else if (pathname === '/api/ecb-rates') json = { ok:true, rates:[] };
    else if (pathname === '/api/track') json = { ok:false, status:'待 API 查询', message:'offline' };
    else if (pathname === '/api/subscriptions') json = data.orders.length ? subs : { ...subs, items:[] };
    else if (pathname === '/api/backups') json = { ok:true, backups:[] };
    return route.fulfill({ json });
  });
  await page.goto('http://127.0.0.1:47123/trade-order-system.html');
  await page.evaluate(helperSource);
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate(() => Boolean(window.pendingSaveStatus?.().loaded))) break;
    await page.clock.runFor(100);
  }
  if (!(await page.evaluate(() => Boolean(window.pendingSaveStatus?.().loaded)))) throw new Error(`page did not load: ${errors.join(' | ') || 'no error'}`);
  if (config.mac) {
    await page.evaluate(fullscreen => {
      window.otsUiZoomChanged?.(0.85);
      document.documentElement.classList.toggle('mac-fullscreen', fullscreen);
    }, Boolean(config.fullscreen));
  }
  await settle(page, 3000);
  // Toasts from booting (zoom, greeting) are not part of any state.
  await page.evaluate(() => document.querySelectorAll('#toast .toast-item').forEach(el => el.remove()));
  return { page, errors };
}

async function runJob(browser, job, ctx) {
  const { config, state } = job;
  const context = await browser.newContext({
    viewport:{ width:config.width, height:config.height || 920 },
    deviceScaleFactor:1,
    hasTouch:Boolean(config.touch),
    isMobile:Boolean(config.touch),
    timezoneId:'Asia/Shanghai',
    locale:'zh-CN',
    reducedMotion:'no-preference'
  });
  await context.addInitScript(({ theme, accent, motion, mac, today }) => {
    try {
      localStorage.setItem('trade-order-system-theme', theme);
      localStorage.setItem('ots-greet-v1', today);
      if (accent) localStorage.setItem('ots-accent-v1', accent);
    } catch (_) {}
    if (mac) {
      const handler = { postMessage() {} };
      window.webkit = { messageHandlers:new Proxy({}, { get:() => handler }) };
    }
    if (motion) document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.motion = motion; });
  }, { theme:config.theme, accent:config.accent || '', motion:config.motion || '', mac:Boolean(config.mac), today:TODAY });
  try {
    const data = config.data === 'empty' ? emptyData : ctx.data;
    const { page, errors } = await loadPage(context, ctx.html, data, ctx.subs, config);
    if (config.motion) await page.evaluate(motion => { document.documentElement.dataset.motion = motion; }, config.motion);
    await state.run(page, settle);
    await settle(page);
    const snap = await inPage(page, 'pageCapture', { names:ctx.names, keep:Boolean(config.force) });
    if (ctx.shots) await page.screenshot({ path:path.join(ctx.shots, `${job.name.replace(/[^\w-]+/g, '_')}.png`) });
    const result = { base:snap, forced:[], errors };
    if (config.force) {
      const count = await inPage(page, 'pageForceTargets', ctx.forceSelectors);
      const cdp = await context.newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      await cdp.send('DOM.getDocument', { depth:0 });
      const { result:list } = await cdp.send('Runtime.evaluate', { expression:'window.__snapTargets.map(t => t[0])' });
      const { result:props } = await cdp.send('Runtime.getProperties', { objectId:list.objectId, ownProperties:true });
      const pseudos = await page.evaluate(() => window.__snapTargets.map(t => t[1]));
      for (let i = 0; i < count; i++) {
        const objectId = props.find(prop => prop.name === String(i))?.value?.objectId;
        const { nodeId } = objectId ? await cdp.send('DOM.requestNode', { objectId }) : {};
        if (!nodeId) continue;
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses:[pseudos[i]] });
        const forced = await inPage(page, 'pageCapture', { names:ctx.names, region:i + 1 });
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses:[] });
        result.forced.push({ key:`${forced.target}:${pseudos[i]}`, snap:forced });
      }
      await cdp.detach();
    }
    return result;
  } finally {
    await context.close();
  }
}

// Global tables shared by all states of one snapshot.
function makeSnapshot(meta) {
  return { meta, styles:[], labels:[], states:{}, _styleIdx:new Map(), _labelIdx:new Map() };
}
function intern(snapshot, part) {
  const s = i => {
    const key = part.styles[i];
    if (!snapshot._styleIdx.has(key)) { snapshot._styleIdx.set(key, snapshot.styles.length); snapshot.styles.push(key); }
    return snapshot._styleIdx.get(key);
  };
  const l = i => {
    const key = part.labels[i];
    if (!snapshot._labelIdx.has(key)) { snapshot._labelIdx.set(key, snapshot.labels.length); snapshot.labels.push(key); }
    return snapshot._labelIdx.get(key);
  };
  return part.entries.map(([p, label, main, custom, extra]) => [p, l(label), s(main), s(custom), extra.map(s)]);
}

async function pool(items, size, worker) {
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; await worker(items[i], i); } };
  await Promise.all(Array.from({ length:Math.min(size, items.length) }, run));
}

async function launch() {
  try { return await chromium.launch({ headless:true }); }
  catch (_) { return chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium' }); }
}

// One prepass per page version: the demo orders (from the first version), the property list and the force selectors.
async function prepass(browser, html) {
  const context = await browser.newContext({ viewport:{ width:1440, height:920 }, timezoneId:'Asia/Shanghai' });
  try {
    const { page } = await loadPage(context, html, { orders:[], customers:{}, doneTasks:{} }, { ok:true, items:[] }, {});
    const info = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const names = [];
      for (let i = 0; i < cs.length; i++) if (!cs[i].startsWith('--')) names.push(cs[i]);
      return { demo:{ orders:state.orders, customers:state.customers }, names:names.sort() };
    });
    return { ...info, forceSelectors:await inPage(page, 'pageForceSelectors'), keyframes:await inPage(page, 'pageKeyframes') };
  } finally {
    await context.close();
  }
}

async function snapshotAll(browser, versions, args) {
  const configs = configurations(args.quick);
  const jobs = jobsFor(configs, args.only);
  const pre = [];
  for (const v of versions) pre.push(await prepass(browser, v.html));
  const data = enrichData(pre[0].demo);
  const subs = subscriptionList();
  const names = pre[0].names;
  if (pre.some(p => p.names.join() !== names.join())) throw new Error('property lists differ between versions');
  // The union of both versions' selectors, so both are forced on the same elements.
  const merged = new Map();
  for (const p of pre) for (const [sel, pseudos] of p.forceSelectors) merged.set(sel, [...new Set([...(merged.get(sel) || []), ...pseudos])].sort());
  const forceSelectors = [...merged].sort((a, b) => a[0].localeCompare(b[0]));
  // A name counts as used when the page mentions it anywhere but in its own @keyframes line (a rule or the script).
  const keyframeNames = [...new Set(pre.flatMap(p => Object.keys(p.keyframes)))];
  const used = html => keyframeNames.filter(name => html.split(name).length - 1 > html.split(`@keyframes ${name}`).length - 1);
  const snapshots = versions.map((v, i) => makeSnapshot({ label:v.label, names, states:jobs.map(j => j.name), forceSelectors:forceSelectors.length, keyframes:pre[i].keyframes, keyframesUsed:used(v.html) }));
  const tasks = [];
  versions.forEach((v, vi) => jobs.forEach(job => tasks.push({ job, vi, html:v.html })));
  let done = 0;
  const started = Date.now();
  await pool(tasks, args.jobs, async ({ job, vi, html }) => {
    let result;
    for (let attempt = 1; ; attempt++) {
      try { result = await runJob(browser, job, { html, data, subs, names, forceSelectors, shots:vi === versions.length - 1 ? args.shots : '' }); break; }
      catch (error) {
        if (attempt >= 2) throw new Error(`${versions[vi].label} ${job.name}: ${error.message}`);
      }
    }
    const snap = snapshots[vi];
    snap.states[job.name] = {
      entries:intern(snap, result.base),
      forced:Object.fromEntries(result.forced.map(f => [f.key, intern(snap, f.snap)])),
      errors:result.errors
    };
    done++;
    if (process.stderr.isTTY || done % 25 === 0 || done === tasks.length) {
      process.stderr.write(`\r${done}/${tasks.length} states, ${Math.round((Date.now() - started) / 1000)}s${process.stderr.isTTY ? '' : '\n'}`);
    }
  });
  if (process.stderr.isTTY) process.stderr.write('\n');
  return snapshots.map(s => { delete s._styleIdx; delete s._labelIdx; return s; });
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing

function diffValues(namesA, a, b) {
  const va = a.split('\u0001');
  const vb = b.split('\u0001');
  const out = [];
  for (let i = 0; i < namesA.length; i++) if (va[i] !== vb[i]) out.push(`${namesA[i]}: ${va[i]} → ${vb[i]}`);
  return out;
}

function diffCustom(a, b) {
  const map = text => new Map(text ? text.split('\u0001').map(kv => { const i = kv.indexOf(':'); return [kv.slice(0, i), kv.slice(i + 1)]; }) : []);
  const ma = map(a), mb = map(b);
  const out = [];
  for (const key of new Set([...ma.keys(), ...mb.keys()])) if (ma.get(key) !== mb.get(key)) out.push(`${key}: ${ma.has(key) ? ma.get(key) : '(inherited)'} → ${mb.has(key) ? mb.get(key) : '(inherited)'}`);
  return out;
}

function diffPseudo(names, sa, a, sb, b) {
  const split = (snap, list) => new Map(list.map(i => { const text = snap.styles[i]; const at = text.indexOf('\u0001'); return [text.slice(0, at), text.slice(at + 1)]; }));
  const pa = split(sa, a), pb = split(sb, b);
  const out = [];
  for (const key of new Set([...pa.keys(), ...pb.keys()])) {
    if (!pa.has(key)) out.push(`${key} appears`);
    else if (!pb.has(key)) out.push(`${key} disappears`);
    else if (pa.get(key) !== pb.get(key)) diffValues(names, pa.get(key), pb.get(key)).forEach(d => out.push(`${key} ${d}`));
  }
  return out;
}

function entryDiff(sa, a, sb, b) {
  const names = sa.meta.names;
  if (!a || !b) return [a ? 'only in the first snapshot (not rendered in the second)' : 'only in the second snapshot (not rendered in the first)'];
  const lines = [];
  if (sa.styles[a[2]] !== sb.styles[b[2]]) lines.push(...diffValues(names, sa.styles[a[2]], sb.styles[b[2]]));
  if (sa.styles[a[3]] !== sb.styles[b[3]]) lines.push(...diffCustom(sa.styles[a[3]], sb.styles[b[3]]));
  const pa = a[4].map(i => sa.styles[i]).join('\u0003');
  const pb = b[4].map(i => sb.styles[i]).join('\u0003');
  if (pa !== pb) lines.push(...diffPseudo(names, sa, a[4], sb, b[4]));
  return lines;
}

// Without base maps: element by element. With them (a forced pseudo-class): an element missing from a forced record
// looks as it does in the base, and only differences the base snapshot does not already show are reported.
function compareEntries(sa, ea, sb, eb, baseA = null, baseB = null) {
  const ma = new Map(ea.map(e => [e[0], e]));
  const mb = new Map(eb.map(e => [e[0], e]));
  const diffs = [];
  for (const key of new Set([...ma.keys(), ...mb.keys()])) {
    const a = ma.get(key) || baseA?.get(key);
    const b = mb.get(key) || baseB?.get(key);
    let lines = entryDiff(sa, a, sb, b);
    if (baseA && lines.length) {
      const already = new Set(entryDiff(sa, baseA.get(key), sb, baseB.get(key)));
      lines = lines.filter(line => !already.has(line));
    }
    if (lines.length) diffs.push({ path:key, label:(a ? sa.labels[a[1]] : sb.labels[b[1]]), lines });
  }
  return diffs;
}

function compareSnapshots(sa, sb, limit) {
  if (sa.meta.names.join() !== sb.meta.names.join()) throw new Error('the snapshots were taken with different browsers (property lists differ)');
  const report = [];
  let total = 0;
  // An animation that is gone is a difference only while the page that lost it still names it.
  const ka = sa.meta.keyframes || {}, kb = sb.meta.keyframes || {};
  for (const name of new Set([...Object.keys(ka), ...Object.keys(kb)])) {
    const missing = !(name in ka) ? sa : !(name in kb) ? sb : null;
    if (missing ? !missing.meta.keyframesUsed.includes(name) : ka[name] === kb[name]) continue;
    total++;
    report.push(`@keyframes ${name}: ${name in ka ? ka[name] : '(none)'} → ${name in kb ? kb[name] : '(none)'}`);
  }
  const states = [...new Set([...Object.keys(sa.states), ...Object.keys(sb.states)])];
  for (const name of states) {
    const a = sa.states[name], b = sb.states[name];
    if (!a || !b) { report.push(`${name}: only in ${a ? 'the first' : 'the second'} snapshot`); total++; continue; }
    const lines = [];
    const add = (prefix, diffs) => diffs.forEach(d => { total++; lines.push({ head:`${prefix}${d.label} [${d.path}]`, lines:d.lines }); });
    add('', compareEntries(sa, a.entries, sb, b.entries));
    const baseA = new Map(a.entries.map(e => [e[0], e]));
    const baseB = new Map(b.entries.map(e => [e[0], e]));
    for (const key of new Set([...Object.keys(a.forced), ...Object.keys(b.forced)])) {
      const fa = a.forced[key], fb = b.forced[key];
      if (!fa || !fb) { total++; lines.push({ head:`forced ${key}`, lines:[`only in ${fa ? 'the first' : 'the second'} snapshot`] }); continue; }
      add(`forced ${key} › `, compareEntries(sa, fa, sb, fb, baseA, baseB));
    }
    const errA = a.errors.join(' | '), errB = b.errors.join(' | ');
    if (errA !== errB) { total++; lines.push({ head:'page errors', lines:[`${errA || '(none)'} → ${errB || '(none)'}`] }); }
    if (!lines.length) continue;
    report.push(`\n${name}: ${lines.length} element(s) differ`);
    for (const item of lines.slice(0, limit)) {
      report.push(`  ${item.head}`);
      item.lines.slice(0, 12).forEach(l => report.push(`      ${l}`));
      if (item.lines.length > 12) report.push(`      … ${item.lines.length - 12} more properties`);
    }
    if (lines.length > limit) report.push(`  … ${lines.length - limit} more elements`);
  }
  return { total, report };
}

// ---------------------------------------------------------------------------------------------------------------

function usage() {
  const text = fs.readFileSync(__filename, 'utf8').split('\n').slice(1).filter(line => line.startsWith('//')).map(line => line.replace(/^\/\/ ?/, ''));
  console.log(text.slice(0, text.findIndex(line => line.startsWith('A refactor')) + 2).join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (args.list) {
    jobsFor(configurations(args.quick), args.only).forEach(job => console.log(job.name));
    return;
  }
  if (args.compare) {
    const [a, b] = args.compare.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    const { total, report } = compareSnapshots(a, b, args.limit);
    console.log(total ? report.join('\n') : 'No differences.');
    process.exitCode = total ? 1 : 0;
    return;
  }
  const current = { label:args.html ? args.html : 'working tree', html:fs.readFileSync(args.html || pagePath, 'utf8') };
  let baseVersion = null;
  if (args.base) baseVersion = { label:args.base, html:execFileSync('git', ['show', `${args.base}:trade-order-system.html`], { cwd:root, encoding:'utf8', maxBuffer:64 * 1024 * 1024 }) };
  else if (args.baseFile) baseVersion = { label:args.baseFile, html:fs.readFileSync(args.baseFile, 'utf8') };
  if (!baseVersion && !args.out) { usage(); process.exitCode = 2; return; }
  if (args.shots) fs.mkdirSync(args.shots, { recursive:true });
  const browser = await launch();
  try {
    const versions = baseVersion ? [baseVersion, current] : [current];
    const snapshots = await snapshotAll(browser, versions, args);
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(snapshots.at(-1)));
    if (baseVersion) {
      const { total, report } = compareSnapshots(snapshots[0], snapshots[1], args.limit);
      const states = Object.keys(snapshots[1].states).length;
      const forced = Object.values(snapshots[1].states).reduce((sum, s) => sum + Object.keys(s.forced).length, 0);
      console.log(total ? report.join('\n') : `No differences: ${states} states, ${forced} forced pseudo-class checks.`);
      process.exitCode = total ? 1 : 0;
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 2; });
}

module.exports = { compareSnapshots, configurations, jobsFor };
