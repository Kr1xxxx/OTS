#!/usr/bin/env node
// 「打开、什么都不改、保存，数据不变」：真实 mac-app/server.js（临时数据目录）+ 固定时钟 2026-11-16 10:00（上海）。
// - 订单弹窗：三百多种订单（阶段 × 收款 × 运单 × 加急 / 部分发货 / 备注），表单读出来再按表单建回去，逐栏比；
// - 客户档案：资料填满的一份、什么都没填的一份，在档案里点保存；
// - 设置页每张表单（订单设置、我方邮箱、等级门槛、汇率、卡片设置、物流接口、AI）：提交前后比数据和服务端设置；
// - 续费编辑：二十来种续费项（调价、单期价、历史设置、停止日、手动 / 提前续费、自定义周期、已停止）；
// - 每个数据键存进数据库再读回来一样。
// 允许的差别写在下面的 allowed 表里，每一行带原因；表以外的差别就是失败。等用户定的那几行，用户定了就从表里删掉。
// 空值的不同写法（没有这个键、''、[]、null）算一样；对象按键排序后比。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchBrowser, h } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const root = path.resolve(__dirname, '..');
const TODAY = '2026-11-16';
const NOW = new Date(`${TODAY}T10:00:00+08:00`);

// ---- 允许的差别（key, 什么时候, 原因） ----
const allowed = {
  order:[
    { key:'updated', why:'保存时间' },
    { key:'logs', why:'订单记录' },
    { key:'owner', when:(a, b) => b === 'Kris', why:'等用户定：保存把负责人写成默认负责人 Kris' },
    { key:'depositAmount', when:(a, b, o) => o.orderType === '定金订单' && !Number(a), why:'等用户定：定金留空时把已收当定金' },
    { key:'depositPercent', when:(a, b, o) => o.orderType === '定金订单' && !Number(o.depositAmount), why:'同上，跟着定金金额算' },
    { key:'carrier', when:(a, b, o) => b === 'auto' && !(o.shipments || []).length, why:'没有运单时承运商回到「自动」，不影响显示和计算' }
  ],
  customer:[
    { key:'history', why:'变更记录' },
    { key:'updated', why:'保存时间' },
    { key:'createdAt', when:a => !a, why:'旧档案没有建档日，第一次保存补上' },
    { key:'owner', when:(a, b) => !a && b === 'Kris', why:'等用户定：保存把负责人写成默认负责人 Kris' },
    { key:'paymentMethod', when:(a, b) => !a && b === '阿里巴巴', why:'没填付款方式的档案读进来就显示阿里巴巴（normalizeCustomerProfiles）' }
  ],
  settings:[
    { key:'orderSettings.defaultNext', when:(a, b) => !b, why:'早就不用的旧键，保存订单设置时清掉' }
  ],
  renewal:[
    { key:'updatedAt', why:'保存时间' }
  ]
};

const empty = value => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
const canonical = value => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function diffRecord(kind, before, after, context = before) {
  const out = [];
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = before?.[key];
    const b = after?.[key];
    if ((empty(a) && empty(b)) || canonical(a) === canonical(b)) continue;
    if (allowed[kind].some(rule => rule.key === key && (!rule.when || rule.when(a, b, context)))) continue;
    out.push(`${key}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  return out;
}
function diffSettings(before, after) {
  const out = [];
  for (const group of Object.keys(before)) {
    if (before[group] && typeof before[group] === 'object' && !Array.isArray(before[group])) {
      for (const key of new Set([...Object.keys(before[group]), ...Object.keys(after[group] || {})])) {
        const a = before[group][key];
        const b = after[group]?.[key];
        if ((empty(a) && empty(b)) || canonical(a) === canonical(b)) continue;
        if (allowed.settings.some(rule => rule.key === `${group}.${key}` && (!rule.when || rule.when(a, b)))) continue;
        out.push(`${group}.${key}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      }
    } else if (!(empty(before[group]) && empty(after[group])) && canonical(before[group]) !== canonical(after[group])) {
      out.push(`${group}: ${JSON.stringify(before[group])} -> ${JSON.stringify(after[group])}`);
    }
  }
  return out;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-noop-save-'));
  const port = freePortSync();
  const token = `noop-save-${process.pid}`;
  const server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env:{ ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1' }, stdio:'ignore' });
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

    // ---- 续费项（经服务端存进去） ----
    const renewal = (name, extra) => ({ name, amount:89, currency:'CNY', cycleUnit:'month', cycleCount:1, startDate:'2026-08-08', category:'软件', autoRenew:true, color:'#1971c2', ...extra });
    const renewals = [
      renewal('auto monthly', {}),
      renewal('auto usd yearly', { currency:'USD', cycleCount:12, startDate:'2025-10-12', amount:120.5, provider:'Example Co', paymentMethod:'信用卡', note:'made-up note' }),
      renewal('manual yearly due soon', { cycleCount:12, startDate:'2025-11-21', autoRenew:false, renewedThrough:'2025-11-21' }),
      renewal('manual yearly overdue', { cycleCount:12, startDate:'2025-11-11', autoRenew:false, renewedThrough:'2025-11-11' }),
      renewal('manual renewed early', { cycleCount:12, startDate:'2025-11-21', autoRenew:false, renewedThrough:'2026-11-21' }),
      renewal('with stop future', { stopOn:'2026-12-26' }),
      renewal('with stop past', { stopOn:'2026-11-06' }),
      renewal('cancelled', { status:'cancelled', endsOn:'2026-11-28' }),
      renewal('remind 7', { extra:{ remindDays:7 } }),
      renewal('remind none', { extra:{ remindDays:-1, providerCancelledOn:'2026-11-13' } }),
      renewal('price onward', { priceChanges:[{ from:'2026-10-08', amount:99 }] }),
      renewal('price once', { priceChanges:[{ from:'2026-09-08', amount:9, once:true }] }),
      renewal('price both', { priceChanges:[{ from:'2026-09-08', amount:9, once:true }, { from:'2026-10-08', amount:99 }, { from:'2027-02-08', amount:120 }] }),
      renewal('terms', { startDate:'2026-10-07', terms:[{ startDate:'2025-10-12', until:'2026-10-07', amount:50, currency:'USD', cycleUnit:'month', cycleCount:12, priceChanges:[], paymentMethod:'Paypal', category:'域名' }] }),
      renewal('daily 30', { cycleUnit:'day', cycleCount:30, startDate:'2026-08-13' }),
      renewal('future start', { startDate:'2026-12-06' }),
      renewal('3 months end of month', { cycleCount:3, startDate:'2026-08-31' }),
      renewal('custom type', { category:'自定义类型', paymentMethod:'某张卡', color:'#ff8800' })
    ];
    for (const item of renewals) await api('/api/subscriptions/save', { item });

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, timezoneId:'Asia/Shanghai', locale:'zh-CN' });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', '2026-11-16'); } catch (_) {} });
    const page = await context.newPage();
    await page.clock.setFixedTime(NOW);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(`native dialog: ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
    await page.goto(`${url}/trade-order-system.html?token=${token}`);
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const reload = async () => {
      await page.reload();
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    };

    // ---- 种数据：经页面存进数据库，重新加载（档案的固定编号顺带补上） ----
    const order = (id, extra = {}) => ({ id, num:`K${id}`, client:'Acme Hair', amount:650, paidAmount:0, orderType:'定金订单', depositAmount:195, depositPercent:30, stage:'quote', currency:'USD', logisticsStatus:'未发货', createdAt:'2026-03-10', orderMonth:'2026-03', updated:'2026-03-10 10:00', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'Kris', country:'🇩🇪 德国 Germany', shipments:[], attachments:[], ...extra });
    const history = Array.from({ length:30 }, (_, i) => ({ time:`2026-0${1 + (i % 9)}-1${i % 10} 10:00`, text:`made-up change ${i}` }));
    await page.evaluate(({ orders, history }) => {
      state.orders = orders;
      state.trashOrders = []; state.deletedOrders = []; state.demoCleared = true; state.demoCustomersCleared = true;
      state.customers = {
        'Acme Hair':{ client:'Acme Hair', country:'🇩🇪 德国 Germany', contacts:['Smith, John', 'Jane'], contact:'Smith, John', phones:['+49 151 0000001', '+49 151 0000002'], phone:'+49 151 0000001', emails:['buyer@example.test', 'second@example.test'], email:'buyer@example.test', addresses:['1 Example Str, 10115 Berlin', 'Warehouse 2, Hamburg'], address:'1 Example Str, 10115 Berlin', currency:'EUR', productType:'睫毛', owner:'Kris', level:'B级翡翠客户', paymentMethod:'T/T', paymentEmail:'pay@example.test', alibabaId:'ali-0001', primaryContactMethod:'WhatsApp', alternativeContactMethods:['邮箱', '微信'], repurchaseCycle:'60', tags:['老客户', 'VIP'], nextFollow:'2026-12-06', note:'made-up note', permanentNote:'always ship DHL', createdAt:'2026-01-05 09:00', updated:'2026-06-01 09:00', history },
        'Blank Co':{ client:'Blank Co' }
      };
      state.orderSettings = { orderPrefix:'Q', serialDigits:4, defaultCurrency:'EUR', defaultCountry:'🇩🇪 德国 Germany', defaultOwner:'Kris', defaultStage:'production', defaultProductType:'睫毛', defaultPaymentChannel:'T/T', defaultOrderType:'全款订单', defaultDepositPercent:50, defaultCarrier:'FedEx', defaultUrgentOrder:'是', ownEmails:['me@example.test'], copyStatusTemplate:'legacy template', defaultNext:'legacy next' };
      state.exchangeSettings = { ...state.exchangeSettings, monthlyRates:{ ...(state.exchangeSettings?.monthlyRates || {}), '2026-10':7.05, '2026-11':7.11, '2026-12':7.2 } };
      state.customerLevelRules = { A:30000, B:12000, C:4000, D:1500 };
      state.performanceTargets = { '2026-11':20000, '2026-12':25000 };
      state.customerTags = ['老客户', 'VIP', '样品'];
      state.paymentMethods = [...(state.paymentMethods || []), '西联'];
      state.owners = ['Kris', 'Mia'];
      state.boardCardSettings = { ...state.boardCardSettings, showAmount:false, productTint:false };
      state.doneTasks = { 'follow-a1':{ at:'2026-11-10 10:00', until:'2026-11-20' }, 'repurchase-Acme Hair-2026-11-01':{ at:'2026-11-10 10:00', until:'2026-12-01' } };
      state.snoozedTasks = { 'follow-a2':'2026-11-16' };
      state.customerDuplicateIgnores = [['Acme Hair', 'Blank Co'].sort().join('\u0000')];
      state.trackingLookups = [{ id:'l1', trackingNumber:'1234567890', carrier:'DHL', status:'运输中', checkedAt:'2026-11-15 10:00', pinned:true, orderId:'a1', client:'Acme Hair' }];
      state = normalizeState(state);
      render();
    }, { orders:[order('a1', { stage:'done', paidAmount:650 }), order('a2', { stage:'production', paidAmount:195 })], history });
    assert.equal(await page.evaluate(() => flushPendingSave()), true);
    await reload();

    // ---- 每个数据键存进去读出来一样 ----
    const roundTripKeys = ['orders', 'customers', 'doneTasks', 'snoozedTasks', 'customerDuplicateIgnores', 'performanceTargets', 'customerTags', 'customerLevels', 'paymentMethods', 'owners', 'customerLevelRules', 'boardCardSettings', 'exchangeSettings', 'trackingLookups', 'orderSettings', 'demoCleared', 'demoCustomersCleared'];
    const pick = () => page.evaluate(keys => JSON.parse(JSON.stringify(Object.fromEntries(keys.map(key => [key, state[key]])))), roundTripKeys);
    // 设成用户能设出来的样子（不经 normalizeState）：删掉了几个内置标签、只留一种付款方式。
    await page.evaluate(() => { state.customerTags = ['VIP', '老客户']; state.paymentMethods = ['西联']; render(); });
    const beforeTrip = await pick();
    await page.evaluate(() => { saveState(); return flushPendingSave(); });
    await reload();
    const afterTrip = await pick();
    const tripDiff = roundTripKeys.filter(key => canonical(beforeTrip[key]) !== canonical(afterTrip[key]))
      .filter(key => key !== 'trackingLookups' || canonical(beforeTrip[key].map(item => Object.fromEntries(Object.entries(item).filter(([, v]) => !empty(v))))) !== canonical(afterTrip[key].map(item => Object.fromEntries(Object.entries(item).filter(([, v]) => !empty(v))))));
    assert.deepEqual(tripDiff, [], `round trip changed: ${tripDiff.map(key => `${key}: ${canonical(beforeTrip[key]).slice(0, 200)} -> ${canonical(afterTrip[key]).slice(0, 200)}`).join('\n')}`);
    assert.ok(Object.keys(afterTrip.snoozedTasks).length && Object.keys(afterTrip.doneTasks).length, 'the round trip carried real values');

    // ---- 订单弹窗：表单读出来再建回去 ----
    const orderDiffs = await page.evaluate(() => {
      const d4 = '2026-11-12';
      const base = { num:'K1', client:'Acme Hair', amount:650, currency:'USD', productType:'假发', paymentChannel:'Paypal', owner:'Aimee', country:'🇺🇸 美国 United States', createdAt:'2026-11-07', orderMonth:'2026-11', updated:'2026-11-07 10:00', logs:[], attachments:[] };
      const ship = (n, c, s, extra = {}) => ({ id:`s-${n}`, trackingNumber:n, carrier:c, status:s, updated:s === '已发货' || s === '未发货' ? '' : `${d4} 09:00`, shippedAt:s === '未发货' ? '' : d4, ...extra });
      const pays = [
        { orderType:'定金订单', depositAmount:195, depositPercent:30, paidAmount:0 },
        { orderType:'定金订单', depositAmount:195, depositPercent:30, paidAmount:195 },
        { orderType:'定金订单', depositAmount:195, depositPercent:30, paidAmount:400 },
        { orderType:'定金订单', depositAmount:195, depositPercent:30, paidAmount:650 },
        { orderType:'定金订单', depositAmount:0, depositPercent:0, paidAmount:100 },
        { orderType:'定金订单', depositAmount:195, depositPercent:30, paidAmount:195, paidBeforeDeposit:0, depositAutoPaid:195 },
        { orderType:'全款订单', depositAmount:650, depositPercent:100, paidAmount:0 },
        { orderType:'全款订单', depositAmount:650, depositPercent:100, paidAmount:300 },
        { orderType:'全款订单', depositAmount:650, depositPercent:100, paidAmount:650 },
        { orderType:'全款订单', depositAmount:650, depositPercent:100, paidAmount:650, paidBeforeDeposit:0, depositAutoPaid:650 }
      ];
      const ships = [
        [], [ship('1111111111', 'DHL', '未发货')], [ship('1111111111', 'DHL', '已发货')],
        [ship('1111111111', 'DHL', '运输中', { rawStatus:'Arrived', trackOkAt:'2026-11-16 08:00', checkedAt:'2026-11-16 08:00' })],
        [ship('1111111111', 'DHL', '已签收'), ship('1Z999AA10123456784', 'UPS', '已发货')], [ship('871032796510', 'UPS', '已发货')],
        [ship('1111111111', 'DHL', '异常', { rawStatus:'Shipment on hold', trackError:{ code:'timeout', message:'x', at:'2026-11-16 08:00' } })]
      ];
      const variants = [];
      let i = 0;
      ['quote', 'production', 'balance', 'shipment', 'done'].forEach(stage => pays.forEach(pay => ships.forEach(sh => {
        if (pay.orderType === '全款订单' && stage === 'balance') return;
        // 已发货 / 已完成的单不会有还写「未发货」的批次（进已发货时批次一起标成已发货），不造这种数据。
        if (['shipment', 'done'].includes(stage) && sh.some(item => item.status === '未发货')) return;
        const extra = [{}, { partialShipment:true }, { urgentOrder:true, customerRequiredDate:d4, latestShipDate:d4 }, { orderDetail:'a\nb', note:'n' }][i % 4];
        const settled = ['shipment', 'done'].includes(stage);
        variants.push(normalizeActiveOrder({ ...base, id:`v${i++}`, num:`K${i}`, stage, ...pay, ...(settled && pay.paidAmount < 650 ? { paidBeforeSettle:pay.paidAmount, paidAmount:650 } : {}), shipments:JSON.parse(JSON.stringify(sh)), ...(settled ? { shippedAt:d4, logisticsStatus:'已发货', logisticsUpdated:`${d4} 09:00` } : {}), ...extra }));
      })));
      return variants.map(o => ({ before:o, after:JSON.parse(JSON.stringify(buildOrderFromFormData(orderFormDataFromOrder(o), { existing:o, isDraft:false, stageTouched:false }))) }));
    });
    assert.ok(orderDiffs.length > 280, `${orderDiffs.length} order shapes`);
    const orderFailures = orderDiffs.flatMap(({ before, after }) => diffRecord('order', before, after).map(line => `${before.id} ${before.stage} ${before.orderType} paid ${before.paidAmount}: ${line}`));
    assert.deepEqual(orderFailures.slice(0, 12), [], `${orderFailures.length} order fields changed on an unchanged save`);

    // ---- 客户档案：在档案里点保存 ----
    for (const name of ['Acme Hair', 'Blank Co']) {
      const before = await page.evaluate(name => JSON.parse(JSON.stringify(state.customers[name])), name);
      await page.evaluate(name => openCustomerModal(name, { viewOnly:false }), name);
      await page.locator('#customerModal.open').waitFor();
      await h.settle(page, '#customerModal .modal');
      await h.click(page, '#customerFooterSaveBtn', `save ${name}`);
      await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
      const after = await page.evaluate(name => JSON.parse(JSON.stringify(state.customers[name])), name);
      assert.deepEqual(diffRecord('customer', before, after), [], `customer ${name} changed on an unchanged save`);
    }

    // ---- 设置页每张表单 ----
    const settingsSnap = async () => ({
      ...(await page.evaluate(() => JSON.parse(JSON.stringify({ orderSettings:state.orderSettings, exchangeSettings:state.exchangeSettings, customerLevelRules:state.customerLevelRules, boardCardSettings:state.boardCardSettings, customerLevels:state.customerLevels, owners:state.owners })))),
      trackingServer:await api('/api/tracking-settings'),
      aiServer:await api('/api/ai-settings')
    });
    await page.evaluate(() => setPage('settings'));
    const forms = [
      ['orderSettingsForm', '订单设置已保存'], ['ownEmailsForm', '我方邮箱'], ['levelRuleForm', '等级规则已保存'], ['exchangeSettingsForm', '汇率设置已保存'],
      ['boardCardSettingsForm', '卡片设置已保存'], ['trackingApiSettingsForm', '物流追踪设置已保存'], ['aiSettingsForm', 'AI 设置已保存']
    ];
    for (const [id, toast] of forms) {
      await h.clearToasts(page);
      const before = await settingsSnap();
      if (id === 'boardCardSettingsForm') await page.evaluate(() => openBoardCardSettings());
      await page.evaluate(id => document.getElementById(id).requestSubmit(), id);
      await h.waitToast(page, toast);
      await page.evaluate(() => flushPendingSave());
      const after = await settingsSnap();
      assert.deepEqual(diffSettings(before, after), [], `${id} changed data on an unchanged save`);
    }
    await page.evaluate(() => { if (document.getElementById('boardCardSettingsModal')?.classList.contains('open')) setModalOpenState('boardCardSettingsModal', false); });

    // ---- 续费编辑：不改直接保存 ----
    await page.evaluate(() => setPage('subscriptions'));
    await page.waitForFunction(n => subscriptionState.loaded && subscriptionState.items.length === n, renewals.length);
    const items = await page.evaluate(() => JSON.parse(JSON.stringify(subscriptionState.items)));
    for (const before of items) {
      await page.evaluate(id => openSubscriptionEditor(id), before.id);
      await page.locator('#subscriptionEditModal.open').waitFor();
      assert.equal(await page.evaluate(() => JSON.stringify(subscriptionDraft) === subscriptionDraftClean), true, `${before.name}: the editor opens clean`);
      page.evaluate(() => saveSubscriptionDraft()).catch(() => {});
      await page.waitForFunction(() => !document.getElementById('subscriptionEditModal').classList.contains('open') || document.getElementById('confirmModal').classList.contains('open'));
      assert.equal(await page.evaluate(() => document.getElementById('confirmModal').classList.contains('open')), false, `${before.name}: an unchanged save asks nothing`);
      const after = await page.evaluate(id => JSON.parse(JSON.stringify(findSubscription(id))), before.id);
      assert.deepEqual(diffRecord('renewal', before, after), [], `renewal ${before.name} changed on an unchanged save`);
    }

    assert.deepEqual(errors, []);
    console.log(`No-op save UI passed: round trip of ${roundTripKeys.length} keys, ${orderDiffs.length} order shapes, 2 customer profiles, ${forms.length} settings forms, ${items.length} renewals unchanged (allowed differences listed with reasons).`);
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exit(1); });
