#!/usr/bin/env node
// 第五轮 UI 修复，真实页面，一条修复一段（窗口取软件的实际情况：最小窗口 1100×720 pt 在 85% 界面大小下是 1294×847，100% 时 1100×720）：
// 1. 调整布局时眼睛和把手的可点范围扩到 28 px，不抢名字标签，也碰不到相邻模块；
// 2. 最近订单拖到 3 格时标题栏仍是一行，和 5 格一样高；
// 3. 订单弹窗里的「还有批次没发（部分发货）」是开关，和抽屉里一样大，保存和关闭保护照旧；
// 4. 没有时间的附件下面只写类型，不以「·」「-」结尾；
// 5. 两个搜索框的提示文字出省略号，顶栏的不伸到 ⌘K 底下；
// 6. 看板窄列里金额很长时，左边「产品 · 收款」至少留「假发…」，不露半个字；
// 8. 订单页国家名放得下；客户页客户属性列没有被切一半的标签。
// （7 是 Mac 窗口最小宽，在 Swift 里，这里测不到。）
// 截图：OTS_SHOTS=<目录> 时把关键画面存下来（人看的），不设就不存。
const assert = require('node:assert/strict');
const path = require('node:path');
const { launchBrowser, openBoard, base, day } = require('./helpers/board-page');

const shotsDir = process.env.OTS_SHOTS || '';
const waitIdle = page => page.evaluate(() => new Promise(resolve => {
  const check = () => (document.getAnimations().some(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime)) ? requestAnimationFrame(check) : resolve());
  requestAnimationFrame(check);
}));
const shot = async (page, name) => {
  if (!shotsDir) return;
  await waitIdle(page);
  await page.screenshot({ path:path.join(shotsDir, `${name}.png`) });
};

const countries = ['🇦🇺 澳大利亚 Australia', '🇳🇬 尼日利亚 Nigeria', '🇦🇪 阿联酋 United Arab Emirates', '🇺🇸 美国 United States'];
// 待收 $16,799.99 USD 这样的长金额排在「待发货」列（看板上的待收只在报价之后的阶段出现）。
const orders = [
  ...countries.map((country, i) => ({ ...base, id:`c${i}`, num:`R50${i}0`, client:`Round Five Buyer ${i}`, country, stage:'production', amount:300, paidAmount:300, orderType:'全款订单', createdAt:day(2), updated:`${day(2)} 10:0${i}` })),
  { ...base, id:'due', num:'R5100', client:'Long Due Buyer', productType:'假发', paymentChannel:'信用卡', stage:'balance', amount:20000, paidAmount:3200.01, orderType:'定金订单', createdAt:day(3), updated:`${day(3)} 10:00` },
  { ...base, id:'ship', num:'R5200', client:'Shipped Buyer', stage:'shipment', amount:500, paidAmount:500, orderType:'全款订单', createdAt:day(3), updated:`${day(3)} 11:00`,
    trackingNumber:'1234567890', carrier:'DHL', logisticsStatus:'运输中', shipments:[{ trackingNumber:'1234567890', carrier:'DHL', status:'运输中' }],
    attachments:[{ name:'报价单链接', type:'文件', link:'https://example.com/quote' }, { name:'付款截图', type:'付款截图', link:'https://example.com/pay', time:`${day(3)} 11:00` }] }
];
const customers = {
  'Round Five Buyer 0':{ client:'Round Five Buyer 0', level:'A级钻石客户', tags:['高复购', '样品客户', '大客户'] },
  'Round Five Buyer 1':{ client:'Round Five Buyer 1', level:'B级翡翠客户', tags:['高复购', '样品客户'] }
};
const data = { orders, customers };

(async () => {
  const browser = await launchBrowser();
  try {
    // ---- 1、2：最小窗口（85%）里调整布局 ----
    {
      const { page, context, errors, dialogs } = await openBoard(browser, data, { width:1294, height:847 });
      // 3 格宽的最近订单排在 9 格宽的待办右边，看板下面一行：两行之间有相邻的把手和标签。
      await page.evaluate(() => {
        saveDashboardLayout({ items:[{ id:'kpi', span:12 }, { id:'board', span:12, h:'fill' }, { id:'tasks', span:9, h:'auto' }, { id:'recent', span:3, h:'auto' }], hidden:[] });
        applyDashboardLayout();
        window.scrollTo(0, 0);
      });
      // 2. 3 格（约 242 px）时副标题收起、「全部订单 →」一行，标题栏和 5 格时一样高。
      const head = () => page.evaluate(() => {
        const sectionHead = document.querySelector('#recentOrders > .section-head');
        const link = sectionHead.querySelector('.link-btn');
        return { width:document.getElementById('recentOrders').getBoundingClientRect().width, height:sectionHead.getBoundingClientRect().height,
          linkLines:Math.round(link.getBoundingClientRect().height / parseFloat(getComputedStyle(link).lineHeight || '20')), linkHeight:link.getBoundingClientRect().height,
          meta:sectionHead.querySelector('.section-meta').getClientRects().length > 0 };
      });
      const narrow = await head();
      assert(narrow.width < 260, `最近订单 3 格：${narrow.width}`);
      assert.equal(narrow.meta, false, '窄的时候副标题收起');
      await page.locator('#recentOrders').scrollIntoViewIfNeeded();
      await shot(page, '2-最近订单3格');
      await page.evaluate(() => { saveDashboardLayout({ items:[{ id:'kpi', span:12 }, { id:'board', span:12, h:'fill' }, { id:'tasks', span:7, h:'auto' }, { id:'recent', span:5, h:'auto' }], hidden:[] }); applyDashboardLayout(); });
      const wide = await head();
      assert.equal(wide.meta, true, '5 格时副标题照常显示');
      assert(Math.abs(narrow.height - wide.height) < 0.5, `标题栏高度 3 格 ${narrow.height} / 5 格 ${wide.height}`);
      assert(Math.abs(narrow.linkHeight - wide.linkHeight) < 0.5, `「全部订单 →」一行：${narrow.linkHeight} / ${wide.linkHeight}`);
      await page.evaluate(() => { saveDashboardLayout({ items:[{ id:'kpi', span:12 }, { id:'board', span:12, h:'fill' }, { id:'tasks', span:9, h:'auto' }, { id:'recent', span:3, h:'auto' }], hidden:[] }); applyDashboardLayout(); window.scrollTo(0, 0); });

      // 1. 调整布局：把手中心线外 8 px、眼睛 28×28 的范围里点到的都是它们自己。
      await page.click('#dashLayoutBtn');
      await page.waitForSelector('#dashLayoutBar');
      await page.locator('[data-dash-module="tasks"]').scrollIntoViewIfNeeded();
      const hits = await page.evaluate(() => {
        const at = (x, y) => document.elementFromPoint(x, y);
        const out = { misses:[] };
        const check = (el, x, y, label) => { const got = at(x, y); if (got !== el) out.misses.push(`${label} → ${got ? got.className || got.tagName : 'null'}`); };
        document.querySelectorAll('#page-dashboard [data-dash-module]:not([hidden])').forEach(module => {
          const id = module.dataset.dashModule;
          const hx = module.querySelector(':scope > .dash-edit > .dash-hx');
          const hy = module.querySelector(':scope > .dash-edit > .dash-hy');
          const eye = module.querySelector(':scope > .dash-edit .dash-chip-hide');
          const grip = module.querySelector(':scope > .dash-edit .dash-chip-grip');
          if (hx) {
            const r = hx.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (cy > 0 && cy < innerHeight) { check(hx, cx - 8, cy, `${id} 宽把手左 8`); check(hx, cx + 8, cy, `${id} 宽把手右 8`); }
          }
          if (hy) {
            const r = hy.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (cy > 8 && cy < innerHeight - 8) { check(hy, cx, cy - 8, `${id} 高把手上 8`); check(hy, cx, cy + 8, `${id} 高把手下 8`); }
          }
          if (eye) {
            const r = eye.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (cy > 14 && cy < innerHeight - 14) {
              // 28×28：中心上下左右各 13.5 px 以内都是眼睛。
              for (const [dx, dy] of [[-12, 0], [13.5, 0], [0, -13.5], [0, 13.5], [-11, -13], [13, 13]]) check(eye, cx + dx, cy + dy, `${id} 眼睛 ${dx},${dy}`);
              // 名字标签的拖动区不被眼睛抢走：标签右边缘内 1 px 还是标签。
              const g = grip.getBoundingClientRect();
              const got = at(g.right - 1, g.top + g.height / 2);
              if (!grip.contains(got)) out.misses.push(`${id} 名字标签右边被抢 → ${got?.className}`);
            }
          }
        });
        // 相邻模块：下一行最近订单 / 待办的名字标签不被上面看板的高把手盖住；待办的宽把手不盖住右边最近订单的内容区域以外的标签。
        ['tasks', 'recent'].forEach(id => {
          const grip = document.querySelector(`[data-dash-module="${id}"] .dash-chip-grip`).getBoundingClientRect();
          for (let x = grip.left + 2; x < grip.right - 2; x += 4) {
            const got = at(x, grip.top + 2);
            if (!got?.closest?.(`[data-dash-module="${id}"] .dash-chip`)) { out.misses.push(`${id} 名字标签顶边 ${Math.round(x - grip.left)} → ${got?.className}`); break; }
          }
        });
        out.scroll = document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth;
        return out;
      });
      assert.deepEqual(hits.misses, [], '把手和眼睛的可点范围');
      assert(hits.scroll <= 0, `调整布局时页面不横向滚动：${hits.scroll}`);
      await shot(page, '1-调整布局');
      // 真鼠标：在宽把手中心线左边 8 px 处按下拖动，待办变窄一格。
      const step = await page.evaluate(() => (document.getElementById('page-dashboard').getBoundingClientRect().width - 11 * 16) / 12 + 16);
      const hx = await page.locator('[data-dash-module="tasks"] .dash-hx').boundingBox();
      const start = { x:hx.x + hx.width / 2 - 8, y:hx.y + hx.height / 2 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) await page.mouse.move(start.x - step * i / 8, start.y);
      await page.mouse.up();
      assert.equal(await page.evaluate(() => document.querySelector('[data-dash-module="tasks"]').dataset.dashSpan), '8', '从扩出来的范围也能拖');
      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, []);
      await context.close();
    }

    // ---- 3、4：订单弹窗和抽屉 ----
    {
      const { page, context, store, errors, dialogs } = await openBoard(browser, data, { width:1694, height:1082 });
      // 4. 抽屉附件页：没有时间的那条只写「文件」。
      await page.evaluate(() => openOrderDetail('ship', { tab:'attachments' }));
      const drawerMeta = await page.$$eval('#orderDetailDrawer .detail-attachment small', els => els.map(el => el.textContent.trim()));
      assert.equal(drawerMeta.length, 2);
      assert.equal(drawerMeta[0], '文件');
      assert.match(drawerMeta[1], /^付款截图 · \d{4}-\d{2}-\d{2} 11:00$/);
      // 3. 抽屉物流页的开关大小。
      await page.evaluate(() => openOrderDetail('ship', { tab:'logistics' }));
      const drawerSwitch = await page.evaluate(() => {
        const i = document.querySelector('#orderDetailDrawer [data-dedit="partialShipment"] + i');
        const cs = getComputedStyle(i);
        return { width:cs.width, height:cs.height, radius:cs.borderTopLeftRadius };
      });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('orderDetailDrawer')?.classList.contains('open'));

      await page.evaluate(() => { openOrder('ship'); document.querySelectorAll('#orderForm .order-section.is-folded').forEach(el => el.classList.remove('is-folded')); });
      // 4. 订单弹窗附件列表。
      const modalMeta = await page.$$eval('#attachmentList .attachment-item .muted:not(.attachment-note)', els => els.map(el => el.textContent.trim()).filter(t => t !== '无链接'));
      assert.equal(modalMeta[0], '文件');
      assert.match(modalMeta[1], /^付款截图 · \d{4}-\d{2}-\d{2} 11:00$/);
      modalMeta.forEach(text => assert.doesNotMatch(text, /[·-]\s*$/, text));
      // 3. 订单弹窗里的部分发货是开关：和抽屉一样大，选中时变强调色。
      const input = page.locator('#orderForm input[name="partialShipment"]');
      await input.scrollIntoViewIfNeeded();
      const modalSwitch = await input.evaluate(el => {
        const cs = getComputedStyle(el);
        return { width:cs.width, height:cs.height, radius:cs.borderTopLeftRadius, appearance:cs.appearance, role:el.getAttribute('role') };
      });
      assert.deepEqual({ width:modalSwitch.width, height:modalSwitch.height }, { width:drawerSwitch.width, height:drawerSwitch.height }, '订单弹窗和抽屉的开关一样大');
      assert.equal(modalSwitch.appearance, 'none');
      assert.equal(modalSwitch.role, 'switch');
      const offBg = await input.evaluate(el => getComputedStyle(el).backgroundColor);
      await shot(page, '3-订单弹窗部分发货开关-关');
      assert.deepEqual(await page.evaluate(() => otsUnsavedForms()), [], '打开时没有未保存修改');
      await page.locator('#orderForm .shipment-partial-field').click({ position:{ x:20, y:20 } });
      assert.equal(await input.isChecked(), true, '点开关那一行就勾上');
      assert.notEqual(await input.evaluate(el => getComputedStyle(el).backgroundColor), offBg, '勾上后颜色变了');
      await shot(page, '3-订单弹窗部分发货开关-开');
      assert.equal((await page.evaluate(() => otsUnsavedForms())).length, 1, '关闭保护认得这个改动');
      const saves = store.saves;
      await page.click('#orderSaveBtn');
      await page.waitForFunction(() => state.orders.find(o => o.id === 'ship')?.partialShipment === true);
      for (let i = 0; i < 100 && !(store.saves > saves && store.current.data.orders.find(o => o.id === 'ship')?.partialShipment === true); i += 1) await page.waitForTimeout(50);
      assert.equal(store.current.data.orders.find(o => o.id === 'ship')?.partialShipment, true, '存进数据库的是 partialShipment: true');
      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, []);
      await context.close();
    }

    // ---- 5、6、8：窄窗口 ----
    {
      const { page, context, errors } = await openBoard(browser, data, { width:1100, height:720 });
      // 5. 100% 最小窗口：顶栏搜索框的提示不伸到 ⌘K 底下，出省略号。
      const top = await page.evaluate(() => {
        const input = document.getElementById('searchInput');
        const kbd = document.querySelector('.search-kbd');
        return { inputRight:input.getBoundingClientRect().right, kbdLeft:kbd.getBoundingClientRect().left, kbdWidth:kbd.getBoundingClientRect().width, kbdScroll:kbd.scrollWidth - kbd.clientWidth,
          overflow:getComputedStyle(input).textOverflow, placeholderOverflow:getComputedStyle(input, '::placeholder').textOverflow };
      });
      assert(top.inputRight <= top.kbdLeft + 0.5, `顶栏搜索提示和 ⌘K 重叠：${top.inputRight} / ${top.kbdLeft}`);
      assert(top.kbdScroll <= 0, '⌘K 标记没被压扁');
      assert.equal(top.overflow, 'ellipsis');
      // 6. 看板窄列：左边产品 · 收款至少 3 个字宽，金额自己出省略号。
      const card = await page.evaluate(() => {
        const row = document.querySelector('.board-card[data-id="due"] .oc-r3');
        const meta = row.querySelector('.oc-meta');
        const amount = row.querySelector('.board-card-amount');
        return { meta:meta.getBoundingClientRect().width, font:parseFloat(getComputedStyle(meta).fontSize), amountOverflow:getComputedStyle(amount).textOverflow,
          rowRight:row.getBoundingClientRect().right, amountRight:amount.getBoundingClientRect().right };
      });
      assert(card.meta >= card.font * 3 - 0.5, `看板窄列左边至少 3 个字宽：${card.meta}`);
      assert.equal(card.amountOverflow, 'ellipsis');
      assert(card.amountRight <= card.rowRight + 0.5, '金额不伸出卡片');
      await page.locator('.board-card[data-id="due"]').scrollIntoViewIfNeeded();
      await shot(page, '6-看板窄列长金额');
      await page.setViewportSize({ width:1294, height:847 });
      // 5. 订单页筛选栏搜索框。
      await page.evaluate(() => setPage('order-list'));
      await page.waitForSelector('#orderTableBody td.col-country');
      const listSearch = await page.evaluate(() => {
        const input = document.getElementById('orderListSearch');
        return { overflow:getComputedStyle(input).textOverflow };
      });
      assert.equal(listSearch.overflow, 'ellipsis');
      // 8. 国家名（最长 4 个汉字）放得下。
      const cut = await page.$$eval('#orderTableBody td.col-country .order-table-ellipsis', els => els.filter(el => el.scrollWidth > el.clientWidth + 0.5).map(el => el.textContent));
      assert.deepEqual(cut, [], '国家名被截');
      await shot(page, '5-8-订单页1294');
      // 8. 客户页：客户属性列里看得见的标签都完整。
      await page.evaluate(() => setPage('customers'));
      await page.waitForSelector('.customer-tag-stack');
      const tags = await page.$$eval('.customer-tag-stack', stacks => stacks.flatMap(stack => {
        const box = stack.getBoundingClientRect();
        return [...stack.children].filter(el => {
          const r = el.getBoundingClientRect();
          return r.top < box.bottom && r.bottom > box.top && r.left < box.right && r.right > box.left;
        }).filter(el => {
          const r = el.getBoundingClientRect();
          return r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5;
        }).map(el => el.textContent);
      }));
      assert.deepEqual(tags, [], '客户属性列有被切的标签');
      await shot(page, '8-客户页1294');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('UI round 5 passed: layout-edit eye and handles hit 28 px without stealing the chip; 最近订单 header one line at 3 columns; 部分发货 is a switch the size of the drawer one, saves and trips the close guard; attachment meta without dangling dots; search placeholders end in an ellipsis and stay off ⌘K; narrow board cards keep 3 characters of meta; country names and customer tags fit at 1294.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
