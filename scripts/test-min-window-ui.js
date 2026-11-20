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
const stages = ['done', 'shipment', 'production', 'quote'];
const customers = {};
const orders = [];
clients.forEach((client, i) => {
  customers[client] = { client, country:'🇬🇧 英国 United Kingdom', currency:'USD', contact:`Buyer ${i + 1}`, email:`buyer${i + 1}@example.com`, tags:['复购客户'] };
  for (let k = 0; k < 3; k++) {
    const n = i * 3 + k;
    const stage = stages[(i + k) % stages.length];
    const amount = 10000 + n * 1370;
    orders.push({ ...base, id:`m${n}`, num:`SO2611${String(20 + n).padStart(4, '0')}`, client, stage, orderType:'定金订单', amount, depositAmount:3000,
      paidAmount:stage === 'done' ? amount : stage === 'quote' ? 0 : 3000, urgentOrder:n % 4 === 0, createdAt:day(1 + n), updated:`${day(1 + n)} 10:00`,
      ...(stage === 'shipment' || stage === 'done' ? { trackingNumber:`1Z999AA10123456${String(70 + n)}`, carrier:'UPS', shippedAt:day(1 + n), logisticsStatus:stage === 'done' ? '已签收' : '运输中' } : {}) });
  }
});

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors } = await openBoard(browser, { orders, customers }, { port:47964, width, height });

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

    // 客户列表：「订单动态」一栏（几单 · 最近单号 / 阶段 · 日期）完整显示，表格不用横向滚动。
    await page.evaluate(() => setPage('customers'));
    await page.waitForSelector('.customer-row:not(.head)');
    const table = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.customer-row:not(.head)')];
      // 留 3 px 余量：字体（Mac 的苹方、CI 的 Linux 字体）稍有出入时，正好卡边的文字就会被截。
      const natural = el => { const copy = el.cloneNode(true); copy.style.cssText = 'position:absolute;width:max-content;max-width:none'; el.parentNode.appendChild(copy); const w = copy.getBoundingClientRect().width; copy.remove(); return w; };
      const cut = rows.flatMap(row => [...row.children[3].querySelectorAll('*')].filter(el => natural(el) + 3 > el.getBoundingClientRect().width).map(el => el.textContent.trim()));
      const scroll = document.querySelector('.customer-table');
      return { rows:rows.length, cut, scrollX:scroll.scrollWidth - scroll.clientWidth };
    });
    assert.equal(table.rows, clients.length);
    assert.deepEqual(table.cut, [], `${width}×${height}: order numbers and dates in the customer list are not cut`);
    assert.ok(table.scrollX <= 1, `${width}×${height}: the customer list does not scroll sideways (${table.scrollX})`);

    assert.deepEqual(errors, []);
    console.log(`Min window UI passed: at ${minWidth}×${minHeight} and ${Math.round(zoom * 100)}% (${width}×${height} in the page) board dates and amounts and the customer list's order numbers and dates are whole.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
