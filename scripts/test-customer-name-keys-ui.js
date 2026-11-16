#!/usr/bin/env node
// 按客户名字记的东西只有一份清单（moveCustomerNameKeys / dropCustomerNameKeys）。一位客户在每个按名字记的地方都留一条：
// 三栏订单、物流查询记录、已处理的复购、暂缓的复购、「不是同一人」。分别走「档案里改名」「合并到别人」「另一窗口改名后的重放」
// 「合并导入改名前的文件」四条路，之后旧名字在整个数据里一处都不剩（变更记录的文字除外）。以后往 state 里加按名字记的新东西
// 而没加进那份清单，这里的「一处都不剩」会先红。另外：删除客户只清这位的（「Acme」不连「Acme-EU」），撤销合并后暂缓回到原名下。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base } = require('./helpers/board-page');

const OLD = 'Old Co';
const order = (id, extra = {}) => ({ ...base, id, num:`N-${id}`, client:OLD, customerId:'cust-old-01', amount:500, paidAmount:500, stage:'done', createdAt:'2026-06-01', orderMonth:'2026-06', updated:'2026-06-01 10:00', ...extra });
const fixture = () => ({
  orders:[order('o1'), { ...order('v1'), client:'old co', customerId:'cust-variant-01' }, { ...order('t1'), client:'Target Co', customerId:'cust-target-01' }],
  trashOrders:[order('o2', { trashedAt:'2026-07-01 10:00' })],
  deletedOrders:[order('o3', { deletedAt:'2026-07-02 10:00' })],
  customers:{
    [OLD]:{ id:'cust-old-01', client:OLD, repurchaseCycle:'30', note:'made-up' },
    'old co':{ id:'cust-variant-01', client:'old co' },
    'Target Co':{ id:'cust-target-01', client:'Target Co' },
    'Other Co':{ id:'cust-other-01', client:'Other Co' },
    Acme:{ id:'cust-acme-01', client:'Acme' },
    'Acme-EU':{ id:'cust-acme-eu-01', client:'Acme-EU' }
  },
  trackingLookups:[{ id:'lk1', orderId:'o1', client:OLD, trackingNumber:'1234567890', carrier:'DHL', checkedAt:'2026-06-03 10:00' }],
  doneTasks:{ [`repurchase-${OLD}-2026-07-01`]:{ at:'2026-07-01 10:00', until:'' }, 'repurchase-Acme-EU-2026-07-01':{ at:'2026-07-01 10:00', until:'' }, 'repurchase-Acme-2026-07-01':{ at:'2026-07-01 10:00', until:'' } },
  customerDuplicateIgnores:[[OLD, 'Other Co'].sort().join('\u0000'), ['Acme', 'Other Co'].sort().join('\u0000')]
});

// 整个数据里还有没有这个名字：值或键等于它、「不是同一人」的一半是它、复购的键是它的。客户档案的变更记录文字不算。
function leftoversIn(data, name) {
  const found = [];
  const named = text => text === name || String(text).split('\u0000').includes(name) || new RegExp(`^repurchase-${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d{4}-\\d{2}-\\d{2})?$`).test(text);
  const walk = (value, path) => {
    if (/^customers\.[^.]+\.history/.test(path)) return;
    if (typeof value === 'string') { if (named(value)) found.push(path); return; }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => {
      if (named(key)) found.push(`${path}.${key} (key)`);
      walk(child, `${path}.${key}`);
    });
  };
  walk(data, '');
  return found.map(path => path.replace(/^\./, ''));
}

(async () => {
  const browser = await launchBrowser();
  try {
    const open = async () => {
      const board = await openBoard(browser, fixture());
      await board.page.evaluate(name => { snoozedTasks.add(`repurchase-${name}`); snoozedTasks.add('repurchase-Acme'); }, OLD);
      return board;
    };
    const stateNow = page => page.evaluate(() => JSON.parse(JSON.stringify(state)));
    const confirmAndWait = async (page, toast) => {
      await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      await h.click(page, '#confirmOkBtn', 'confirm');
      await h.waitToast(page, toast);
    };

    // ---- 1. 档案里改名 ----
    {
      const { page, context, errors } = await open();
      await page.evaluate(name => openCustomerModal(name, { viewOnly:false }), OLD);
      await page.locator('#customerModal.open').waitFor();
      await h.settle(page, '#customerModal .modal');
      await page.locator('#customerForm input[name="name"]').fill('New Co');
      await h.click(page, '#customerFooterSaveBtn', 'save customer');
      await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
      const data = await stateNow(page);
      assert.deepEqual(leftoversIn(data, OLD), [], 'nothing keyed by the old name after a rename');
      assert.equal(data.orders.find(o => o.id === 'v1').client, 'old co', 'a case variant that is its own customer keeps its order');
      assert.equal(data.snoozedTasks['repurchase-New Co'] !== undefined, true, 'the snoozed repurchase follows the new name');
      assert.ok(data.doneTasks['repurchase-New Co-2026-07-01']);
      assert.equal(data.trackingLookups[0].client, 'New Co');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 2. 合并到另一位客户；撤销后暂缓回到原名下 ----
    {
      const { page, context, errors } = await open();
      page.evaluate(name => mergeDuplicateCustomers('Target Co', name), OLD).catch(() => {});
      await confirmAndWait(page, '已合并到 Target Co');
      const data = await stateNow(page);
      assert.deepEqual(leftoversIn(data, OLD), [], 'nothing keyed by the merged name after a merge');
      assert.ok(data.snoozedTasks['repurchase-Target Co'] !== undefined);
      await h.clickUndo(page, '已合并到 Target Co');
      await h.waitToast(page, '已撤销合并');
      const undone = await stateNow(page);
      assert.ok(undone.snoozedTasks[`repurchase-${OLD}`] !== undefined, 'undo puts the snoozed repurchase back under the old name');
      assert.equal(undone.snoozedTasks['repurchase-Target Co'], undefined);
      assert.equal(undone.orders.find(o => o.id === 'o1').client, OLD);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 3. 另一窗口改了名，这边的数据（含暂缓、物流记录）重放那次改名 ----
    {
      const { page, context, errors } = await open();
      const replayed = await page.evaluate(name => replayCustomerRename(JSON.parse(JSON.stringify(state)), { id:'cust-old-01', from:name, to:'New Co' }), OLD);
      assert.deepEqual(leftoversIn(replayed, OLD), [], 'nothing keyed by the old name after replaying a rename');
      assert.equal(replayed.orders.find(o => o.id === 'v1').client, 'old co');
      // 合并导入一份改名之前导出的文件：订单跟着编号走到现在的名字，旧名字不回来。
      const imported = await page.evaluate(([current, name]) => {
        const incoming = JSON.parse(JSON.stringify(state));
        return mergeImportedState(current, incoming).state;
      }, [replayed, OLD]);
      assert.deepEqual(leftoversIn(imported, OLD), [], 'importing a file from before the rename brings nothing back under the old name');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 4. 删除客户：只清这一位的（Acme-EU 的已处理复购留着），暂缓和「不是同一人」一起清 ----
    {
      const { page, context, errors } = await open();
      page.evaluate(() => deleteCustomerProfile('Acme')).catch(() => {});
      await confirmAndWait(page, '已删除客户 Acme');
      const data = await stateNow(page);
      assert.deepEqual(leftoversIn(data, 'Acme'), [], 'nothing keyed by a deleted customer');
      assert.ok(data.doneTasks['repurchase-Acme-EU-2026-07-01'], 'another customer whose name starts with it keeps its done key');
      await h.clickUndo(page, '已删除客户 Acme');
      await h.waitToast(page, '已撤销');
      const undone = await stateNow(page);
      assert.ok(undone.snoozedTasks['repurchase-Acme'] !== undefined && undone.doneTasks['repurchase-Acme-2026-07-01'], 'undo brings them back');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Customer name keys UI passed: rename, merge (+ undo), replayed rename, import of an older file and delete leave nothing keyed by the old name; Acme-EU kept when Acme is deleted.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
