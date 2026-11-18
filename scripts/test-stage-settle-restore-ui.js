const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

// 阶段不动钱（用户 2026-11-18：「仅已发货也不一定是收齐」）：进已发货 / 已完成不再把没收的尾款记成已收，
// 退回前面的阶段也不改已收。每个入口都测一遍：
// - 真实鼠标拖到已发货：已收照旧，没有「视为已收齐」的记录；工作台「待收款」、金额页、订单列表、抽屉四处待收一致；
// - 已发货的单在卡片上点「收齐」：已收 = 金额；再拖回待发货已收不变；
// - 旧数据（以前进已发货时按全额记、真实已收存在 paidBeforeSettle）：载入、拖回待发货、保存再载入，已收一直是全额；
// - 载入 / 导入文件里已发货、只收了一部分的单：按文件里的已收；
// - 编辑弹窗选「已发货」、第一次补单号进已发货、新建直接选「已发货」：已收都按表单里填的，提示不再说「按已收齐记」；
// - 抽屉里已发货的单已付金额能改、有「收齐」按钮；
// - 卡片上的「收齐」马上撤销：已收、阶段还原，操作记录只追加不删除；阶段名写成中文 / 大小写不同也认得出来。
const deposit = { orderType:'定金订单', amount:1000, depositAmount:300 };

const field = (page, name) => page.locator(`#orderForm [name="${name}"]`);
const stageHint = page => page.locator('#orderForm [data-stage-hint]').evaluate(el => el.hidden ? '' : el.textContent.trim());
async function openEdit(page, id) {
  await h.rightClick(page, id);
  await page.locator('.board-menu [data-board-menu="edit"]').click();
  await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
}
async function saveModal(page) {
  await page.getByRole('button', { name:'保存订单' }).click();
  await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
  await page.waitForFunction(() => { const s = window.pendingSaveStatus(); return !s.pending && !s.saving; });
}
async function skipTrackingCard(page) {
  if (await page.locator('#trackingQuickCard [data-track-skip]').count()) {
    await page.locator('#trackingQuickCard [data-track-skip]').click();
    await page.waitForFunction(() => !document.getElementById('trackingQuickCard'));
  }
}
const noSettleLog = order => assert(!order.logs.some(log => /视为已收齐|按已收齐记/.test(log.text)), `不能再写「视为已收齐」：${JSON.stringify(order.logs.map(log => log.text))}`);

(async () => {
  const browser = await launchBrowser();
  try {
    // 第一页：只放这三张单，工作台「待收款」、金额页合计就是 s1 一张单的待收。
    {
      const orders = [
        { ...base, ...deposit, id:'s1', num:'K601', client:'Drag Ship', paidAmount:300, stage:'production', updated:`${day(4)} 09:01` },
        // 旧数据：以前进已发货时已收按全额记，真实的 300 存在 paidBeforeSettle。
        { ...base, ...deposit, id:'s2', num:'K602', client:'Legacy Ship', paidAmount:1000, paidBeforeSettle:300, stage:'shipment', logisticsStatus:'已发货', shippedAt:day(2), updated:`${day(4)} 09:02` },
        { ...base, ...deposit, id:'s3', num:'K603', client:'Legacy Done', amount:800, depositAmount:200, paidAmount:800, paidBeforeSettle:200, stage:'done', logisticsStatus:'已签收', shippedAt:day(2), updated:`${day(4)} 09:03` }
      ];
      const { page, store, errors, dialogs } = await openBoard(browser, { orders }, { width:1440, height:920 });
      let s2 = await h.order(page, 's2');
      assert.equal(s2.paidAmount, 1000, '旧单载入后已收仍是全额');
      assert.equal(s2.paidBeforeSettle, 300, '旧单的 paidBeforeSettle 留在数据里');

      // 1. 拖到已发货：已收仍 300，待收 700，没有「视为已收齐」。
      await h.clearToasts(page);
      await h.drag(page, 's1', 'shipment');
      await page.waitForFunction(() => state.orders.find(o => o.id === 's1').stage === 'shipment');
      let s1 = await h.order(page, 's1');
      assert.equal(s1.paidAmount, 300, '进已发货不改已收');
      assert.equal(s1.paidBeforeSettle, undefined, '不再产生新的 paidBeforeSettle');
      noSettleLog(s1);
      assert.equal(await page.evaluate(() => orderDueValue(state.orders.find(o => o.id === 's1'))), 700);
      assert(!(await h.toasts(page)).some(text => /收齐/.test(text)), `移动提示不能再说收齐：${await h.toasts(page)}`);
      await skipTrackingCard(page);

      // 四处待收一致：工作台「待收款」卡、金额页「待收」、订单列表这一行、抽屉。
      const dashboard = await page.locator('#statPayment').textContent();
      assert.match(dashboard, /\$700(?!\d)/, `工作台待收款：${dashboard}`);
      await page.evaluate(() => setPage('amount'));
      await page.waitForFunction(() => /700/.test(document.getElementById('reportDue')?.textContent || ''));
      assert.match(await page.locator('#reportDue').textContent(), /\$700(?!\d)/);
      await page.evaluate(() => setPage('order-list'));
      const row = page.locator('#orderListBody tr[data-order-list-id="s1"], tr[data-order-list-id="s1"]').first();
      await row.waitFor();
      assert.match(await row.locator('.order-table-due-line').textContent(), /\$700(?!\d)/);
      assert.equal(await row.locator('[data-order-list-quick="paid"]').count(), 1, '订单列表：已发货有欠款的单也有「收齐」');
      await page.evaluate(() => setPage('dashboard'));
      await h.openDrawer(page, 's1', 'payment');
      assert.match(await page.locator('#orderDetailBody .order-detail-payment-head').textContent(), /待收\s*\$700(?!\d)/);
      // 抽屉里已发货的单已付金额能改，有「收齐」。
      assert.equal(await page.locator('#orderDetailBody [data-dedit="paidAmount"]').evaluate(el => el.readOnly), false, '已发货的单已付金额能改');
      assert.equal(await page.locator('#orderDetailBody [data-detail-paid-full]').count(), 1);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));

      // 2. 卡片上点「收齐尾款」：已收 1000；再拖回待发货，已收仍 1000。
      await h.clearToasts(page);
      await h.clickQuick(page, 's1', 'paid');
      await page.waitForFunction(() => state.orders.find(o => o.id === 's1').paidAmount === 1000);
      assert.equal((await h.order(page, 's1')).stage, 'shipment', '收齐后留在已发货');
      await h.drag(page, 's1', 'balance');
      await page.waitForFunction(() => state.orders.find(o => o.id === 's1').stage === 'balance');
      s1 = await h.order(page, 's1');
      assert.equal(s1.paidAmount, 1000, '退回待发货不改已收');

      // 4. 旧单拖回待发货：已收仍是全额（不再按 paidBeforeSettle 还原）。
      await h.drag(page, 's2', 'balance');
      await page.waitForFunction(() => state.orders.find(o => o.id === 's2').stage === 'balance');
      s2 = await h.order(page, 's2');
      assert.equal(s2.paidAmount, 1000, '旧单退回待发货已收不变');
      assert.doesNotMatch(s2.logs[0].text, /已付款恢复/);
      // 抽屉阶段条：旧的已完成单点回生产中，已收也不变。
      await h.openDrawer(page, 's3', 'info');
      await h.click(page, '#detailStageBar [data-detail-stage="production"]', 'stage bar production');
      await page.waitForFunction(() => state.orders.find(o => o.id === 's3').stage === 'production');
      assert.equal((await h.order(page, 's3')).paidAmount, 800, '阶段条退回也不改已收');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('orderDetailDrawer').classList.contains('open'));

      // 保存再载入：数不变。
      await h.flush(page);
      const saved = id => store.current.data.orders.find(o => o.id === id);
      assert.equal(saved('s1').paidAmount, 1000);
      assert.equal(saved('s2').paidAmount, 1000);
      await page.reload();
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
      assert.equal((await h.order(page, 's2')).paidAmount, 1000, '旧单保存再载入已收不变');
      assert.equal((await h.order(page, 's3')).paidAmount, 800);
      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, []);
      await page.context().close();
    }

    // 第二页：载入 / 导入、编辑弹窗、新建、收齐撤销、阶段名、环图颜色。
    {
      const orders = [
        { ...base, ...deposit, id:'e1', num:'K501', client:'Modal Ship', paidAmount:300, stage:'production', updated:`${day(4)} 09:01` },
        // 5. 文件里已发货、只收了 300（没有 paidBeforeSettle）：载入后按 300。
        { ...base, ...deposit, id:'e2', num:'K502', client:'Loaded Ship', paidAmount:300, stage:'shipment', logisticsStatus:'已发货', shippedAt:day(2), updated:`${day(4)} 09:02` },
        { ...base, id:'e4', num:'K504', client:'Paid Undo', amount:500, paidAmount:0, orderType:'全款订单', stage:'quote', updated:`${day(4)} 09:04`, logs:[{ time:`${day(1)} 08:00`, text:'创建订单' }] },
        { ...base, ...deposit, id:'e5', num:'K505', client:'First Tracking', paidAmount:300, stage:'production', updated:`${day(4)} 09:05` },
        // 导入文件里阶段写成中文名 / 大小写不同的英文：认得出来，不再一律放进报价。
        { ...base, ...deposit, id:'e6', num:'K506', client:'Chinese Stage', paidAmount:300, stage:'尾款', updated:`${day(4)} 09:06` },
        { ...base, id:'e7', num:'K507', client:'Cased Stage', amount:600, paidAmount:600, orderType:'全款订单', stage:' Production ', updated:`${day(4)} 09:07` }
      ];
      const { page, store, errors, dialogs } = await openBoard(browser, { orders }, { width:1440, height:920, port:47991 });

      let e2 = await h.order(page, 'e2');
      assert.equal(e2.paidAmount, 300, '载入已发货的单：按文件里的已收');
      assert.equal(e2.paidBeforeSettle, undefined);
      assert.equal((await h.order(page, 'e6')).stage, 'balance', '阶段写成「尾款」的单放进待发货（旧名兼容）');
      assert.equal((await h.order(page, 'e7')).stage, 'production', '阶段写成「 Production 」的单放进生产中');
      assert.equal(await page.locator('#pipeline .board-column[data-stage="balance"] .board-card[data-id="e6"]').count(), 1);
      // 已发货有欠款的单：看板卡片和右键菜单也有「收齐」。
      await h.rightClick(page, 'e2');
      assert.equal(await page.locator('.board-menu [data-board-menu="paid"]').count(), 1, '看板菜单：已发货有欠款的单也有「收齐」');
      await page.keyboard.press('Escape');

      // 导入旧导出文件：已发货、已收 300 / 金额 1000 → 300；「收齐前已付」那一列照样能读。
      const imported = await page.evaluate(() => prepareImportedData({ app:'trade-order-system', data:{ orders:[
        { id:'i1', num:'K701', client:'Import Ship', stage:'shipment', orderType:'定金订单', amount:1000, paidAmount:300, currency:'USD' },
        { id:'i2', num:'K702', client:'Import Old', stage:'done', orderType:'定金订单', amount:1000, paidAmount:'1,000', paidBeforeSettle:'300', currency:'USD' }
      ], customers:{} } }).data.orders.map(o => ({ id:o.id, paid:o.paidAmount, before:o.paidBeforeSettle, due:orderDueValue(o) })));
      assert.deepEqual(imported, [{ id:'i1', paid:300, before:undefined, due:700 }, { id:'i2', paid:1000, before:300, due:0 }]);

      // 编辑弹窗选「已发货」：不再提示按已收齐记，保存后已收仍 300。
      await openEdit(page, 'e1');
      await page.locator('#orderForm [data-binary-value="shipment"]').click();
      assert.doesNotMatch(await stageHint(page), /收齐/);
      await h.clearToasts(page);
      await saveModal(page);
      const e1 = await h.order(page, 'e1');
      assert.equal(e1.stage, 'shipment');
      assert.equal(e1.paidAmount, 300, '编辑弹窗进已发货不改已收');
      noSettleLog(e1);
      assert(!(await h.toasts(page)).some(text => /收齐/.test(text)), `保存提示不能再说收齐：${await h.toasts(page)}`);
      await skipTrackingCard(page);

      // 编辑弹窗第一次补单号，按单号进已发货：已收照旧。
      await openEdit(page, 'e5');
      await field(page, 'trackingNumber').click();
      await page.keyboard.type('1Z999AA10123456784');
      await page.waitForFunction(() => /按物流单号自动放到「已发货」/.test(document.querySelector('#orderForm [data-stage-hint]')?.textContent || ''));
      assert.doesNotMatch(await stageHint(page), /收齐/);
      await saveModal(page);
      const e5 = await h.order(page, 'e5');
      assert.equal(e5.stage, 'shipment');
      assert.equal(e5.paidAmount, 300, '补单号进已发货不改已收');

      // 已发货的单编辑弹窗改回待发货：已收不变；没有物流记录的发货状态照旧清掉。
      await openEdit(page, 'e2');
      await page.locator('#orderForm [data-binary-value="balance"]').click();
      await saveModal(page);
      e2 = await h.order(page, 'e2');
      assert.equal(e2.stage, 'balance', '用户选的阶段照用');
      assert.equal(e2.paidAmount, 300);
      assert.equal(e2.logisticsStatus, '未发货');
      assert.equal(e2.shippedAt, '');

      // 7. 新建一张直接选「已发货」、已收填 0 的单：保存后已收 0。
      await page.evaluate(() => openOrder());
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
      await page.evaluate(() => {
        const f = document.getElementById('orderForm').elements;
        f.client.value = 'New Shipped';
        f.orderType.value = '定金订单';
        f.orderType.dispatchEvent(new Event('change', { bubbles:true }));
        f.amount.value = '1000';
        f.amount.dispatchEvent(new Event('input', { bubbles:true }));
        f.paidAmount.value = '0';
        f.paidAmount.dispatchEvent(new Event('input', { bubbles:true }));
      });
      await page.locator('#orderForm [data-binary-value="shipment"]').click();
      assert.doesNotMatch(await stageHint(page), /收齐/);
      await saveModal(page);
      await skipTrackingCard(page);
      const created = await page.evaluate(() => JSON.parse(JSON.stringify(state.orders.find(o => o.client === 'New Shipped'))));
      assert.equal(created.stage, 'shipment');
      assert.equal(created.paidAmount, 0, '新建直接进已发货：已收按填的 0');
      noSettleLog(created);

      // 卡片上的「收齐全款」马上撤销：已收、阶段还原；操作记录只追加，原来的和「收齐」那条都还在。
      await h.clearToasts(page);
      await h.clickQuick(page, 'e4', 'paid');
      await page.waitForFunction(() => state.orders.find(o => o.id === 'e4').paidAmount === 500);
      await h.clickUndo(page, 'K504 Paid Undo 已收齐');
      await page.waitForFunction(() => state.orders.find(o => o.id === 'e4').paidAmount === 0);
      const e4 = await h.order(page, 'e4');
      assert.equal(e4.stage, 'quote');
      const texts = e4.logs.map(log => log.text);
      assert(texts.includes('创建订单'), '原来的记录不能被删');
      assert(texts.some(text => /^收齐全款/.test(text)), `「收齐」那条记录保留：${texts}`);
      assert(/撤销/.test(texts[0]), `最新一条是撤销：${texts}`);

      // 金额页「阶段金额构成」：每个阶段的颜色和看板列圆点一样（以前按排第几配色，生产中用了报价的颜色……）。
      await page.locator('.nav-item[data-page="amount"]').click();
      await page.waitForSelector('#amountSideChart .side-dot');
      const colors = await page.evaluate(() => {
        const byName = Object.fromEntries(stageDefs.map(s => [s.name, s.key]));
        return [...document.querySelectorAll('#amountSideChart .side-bar-row')].map(row => {
          const name = row.querySelector('.side-bar-head span').textContent.split(' · ')[0].trim();
          const key = byName[name];
          const head = document.querySelector(`#pipeline .board-column[data-stage="${key}"] .board-column-title`);
          return { name, dot:getComputedStyle(row.querySelector('.side-dot')).backgroundColor, board:head ? getComputedStyle(head, '::before').backgroundColor : '' };
        });
      });
      assert(colors.filter(item => item.board && item.board !== 'rgba(0, 0, 0, 0)').length >= 3, `阶段金额里至少有生产中、尾款、已发货，并能量到看板圆点颜色：${JSON.stringify(colors)}`);
      colors.filter(item => item.board).forEach(item => assert.equal(item.dot, item.board, `「${item.name}」环图颜色和看板圆点不一样`));
      assert.equal(new Set(colors.map(item => item.dot)).size, colors.length, '每个阶段颜色不同');

      await h.flush(page);
      assert.equal(store.current.data.orders.find(o => o.id === 'e1').paidAmount, 300, '已收已保存');
      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, [], '不能出现原生 alert / confirm');
    }
    console.log('Stage keeps paid UI passed: drag, modal, first tracking and a new order into 已发货 keep the real paid amount and log no 视为已收齐; dashboard, amount page, order list and drawer show the same balance; 收齐 shows on shipped cards, list rows, board menu and the drawer; moving back changes nothing; legacy full-paid orders and imports keep their numbers; 收齐 undo only appends logs; Chinese / cased stage names load; the stage donut uses the board colours.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
