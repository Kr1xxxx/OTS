#!/usr/bin/env node
// 窗口缩到最窄、界面大小是默认值时，页面不截掉日期和单号（真实页面，数据是编的）。
// 默认缩放从 85% 改成 90% 以后，最小窗口（当时 1104 点宽）的页面只有约 1227 px 宽，比 85% 时窄了 70 px：
// 客户列表「订单动态」一栏的单号、「已完成 · 2026-11-0…」的日期被省略号截掉，工作台卡片右上角的下单日期整个挤没了。
// 这里从 main.swift 读最小窗口宽度和默认缩放，按两者算出的页面宽度打开页面再核对，以后改其中一个数也会被拦下。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchBrowser, openBoard, base, day } = require('./helpers/board-page');

const swift = fs.readFileSync(path.join(__dirname, '..', 'mac-app/native/Sources/TradeOrderSystemNative/main.swift'), 'utf8');
const minWidth = Number(/window\.minSize = NSSize\(width: (\d+)/.exec(swift)?.[1]);
const minHeight = Number(/window\.minSize = NSSize\(width: \d+, height: (\d+)/.exec(swift)?.[1]);
const zoom = Number(/private static let uiZoomDefault = ([\d.]+)/.exec(swift)?.[1]);
assert.ok(minWidth > 1100 && minHeight > 0 && zoom > 0, `main.swift: minimum window ${minWidth}×${minHeight}, default zoom ${zoom}`);
const width = Math.floor(minWidth / zoom);
const height = Math.floor(minHeight / zoom);
assert.ok(width >= 1299, `the smallest window at the default zoom is ${width} px wide in the page; the layout is tuned for 1299 px and up`);

const clients = ['Narrow Lane Hair Co', 'Minimum Window Wigs Ltd', 'Small Frame Lashes', 'Tight Fit Beauty Supply'];
// 地区用名字最长的几个（四个字），属性里一个三个字的标签：最窄时这两栏也要放得下。
const countries = ['🇳🇬 尼日利亚 Nigeria', '🇦🇺 澳大利亚 Australia', '🇿🇼 津巴布韦 Zimbabwe', '🇬🇧 英国 United Kingdom'];
const stages = ['done', 'shipment', 'production', 'quote'];
const customers = {};
const orders = [];
clients.forEach((client, i) => {
  customers[client] = { client, country:countries[i], currency:'USD', contact:`Buyer ${i + 1}`, email:`buyer${i + 1}@example.com`, tags:['回头客'] };
  for (let k = 0; k < 3; k++) {
    const n = i * 3 + k;
    const stage = stages[(i + k) % stages.length];
    const amount = 10000 + n * 1370;
    orders.push({ ...base, id:`m${n}`, num:`SO2611${String(20 + n).padStart(4, '0')}`, client, stage, orderType:'定金订单', amount, depositAmount:3000,
      paidAmount:stage === 'done' ? amount : stage === 'quote' ? 0 : 3000, urgentOrder:n % 4 === 0, createdAt:day(1 + n), updated:`${day(1 + n)} 10:00`,
      ...(stage === 'shipment' || stage === 'done' ? { trackingNumber:`1Z999AA10123456${String(70 + n)}`, carrier:'UPS', shippedAt:day(1 + n), logisticsStatus:stage === 'done' ? '已签收' : '运输中' } : {}) });
  }
});

// 客户列表：「订单动态」一栏（几单 · 最近单号 / 阶段 · 日期）完整显示，表格不用横向滚动。
async function checkCustomerList(page, label) {
  await page.evaluate(() => setPage('customers'));
  await page.waitForSelector('.customer-row:not(.head)');
  const table = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.customer-row:not(.head)')];
    // 文字的自然宽度（不取整）至少比格子窄 1 px。不同机器上「单」字的字体不同：本机 121.1 px，Linux CI 123.7 px（以前的比例在 1300 px 页面里格子只有 121 px）。
    const natural = el => { const copy = el.cloneNode(true); copy.style.cssText = 'position:absolute;width:max-content;max-width:none'; el.parentNode.appendChild(copy); const w = copy.getBoundingClientRect().width; copy.remove(); return w; };
    const cutIn = (row, i, keep = () => true) => [...row.children[i].querySelectorAll('*')].filter(el => keep(el) && natural(el) + 1 > el.getBoundingClientRect().width).map(el => `${el.textContent.trim()} (${natural(el).toFixed(1)} / ${el.getBoundingClientRect().width.toFixed(1)} px)`);
    // 地区一栏的国家名（第一行，地址那行本来就会省略），属性一栏的等级和第一个标签（标签放不下时折到看不见的第二行）。
    const country = rows.flatMap(row => cutIn(row, 1, el => !/\d/.test(el.textContent)));
    const tagHidden = rows.filter(row => { const stack = row.children[2].querySelector('.customer-tag-stack'); const tag = stack?.querySelector('.level-tag'); return !tag || tag.getBoundingClientRect().bottom > stack.getBoundingClientRect().bottom + 0.5; }).map(row => row.children[0].textContent.trim().slice(0, 30));
    const cut = rows.flatMap(row => cutIn(row, 3));
    const scroll = document.querySelector('.customer-table');
    const fonts = [...document.fonts].map(font => `${font.family} ${font.status}`).join(', ');
    return { rows:rows.length, cut, country, tagHidden, scrollX:scroll.scrollWidth - scroll.clientWidth, fonts, columns:getComputedStyle(rows[0]).gridTemplateColumns, inner:innerWidth };
  });
  assert.equal(table.rows, clients.length);
  assert.deepEqual(table.cut, [], `${label}: order numbers and dates in the customer list are not cut (columns ${table.columns}, window ${table.inner}, fonts: ${table.fonts})`);
  assert.deepEqual(table.country, [], `${label}: country names in the customer list are not cut (columns ${table.columns})`);
  assert.deepEqual(table.tagHidden, [], `${label}: the first tag next to the level is not pushed out (columns ${table.columns})`);
  assert.ok(table.scrollX <= 1, `${label}: the customer list does not scroll sideways (${table.scrollX})`);
}

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, context, errors } = await openBoard(browser, { orders, customers }, { port:47964, width, height });
    // 页面内嵌的 Inter 是 font-display:swap：先等字体加载完再量，免得量到后备字体。
    await page.evaluate(() => document.fonts.ready);

    // 工作台卡片：每张卡（也包括带「加急」的）右上角都看得到下单日期，金额不带省略号。
    const cards = await page.evaluate(() => [...document.querySelectorAll('#pipeline .board-card')].map(card => {
      const row = card.querySelector('.oc-r1').getBoundingClientRect();
      const date = card.querySelector('.oc-date')?.getBoundingClientRect();
      const amount = card.querySelector('.board-card-amount');
      return { id:card.dataset.id, date:!!date && date.width > 0 && date.top >= row.top - 1 && date.bottom <= row.bottom + 1 && date.right <= row.right + 1,
        amountCut:!!amount && amount.scrollWidth > amount.clientWidth + 1 };
    }));
    assert.ok(cards.length >= 9, `board cards rendered (${cards.length})`);
    assert.deepEqual(cards.filter(card => !card.date).map(card => card.id), [], `${width}×${height}: every board card shows its order date`);
    assert.deepEqual(cards.filter(card => card.amountCut).map(card => card.id), [], `${width}×${height}: no board card amount is cut`);

    await checkCustomerList(page, `${width}×${height}`);

    assert.deepEqual(errors, []);
    await context.close();

    // 界面大小选 100% 时页面和窗口一样宽（最小窗口的宽度）：客户列表的单号和日期也不被截。
    // 工作台卡片这时放不下「加急」和日期两样，日期让位（.oc-r1 折行藏起），不在这里核对。
    const full = await openBoard(browser, { orders, customers }, { port:47965, width:minWidth, height:minHeight });
    await full.page.evaluate(() => document.fonts.ready);
    await checkCustomerList(full.page, `${minWidth}×${minHeight} at 100%`);
    assert.deepEqual(full.errors, []);
    await full.context.close();
    console.log(`Min window UI passed: at ${minWidth}×${minHeight} and ${Math.round(zoom * 100)}% (${width}×${height} in the page) board dates and amounts and the customer list's order numbers and dates are whole; at 100% the customer list too.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
