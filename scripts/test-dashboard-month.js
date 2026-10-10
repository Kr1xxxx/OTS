#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function: ${name}`);
  const bodyStart = html.indexOf('{', start);
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const candidate = html.slice(start, index + 1);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error(`Unclosed function: ${name}`);
}

class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : ['2026-08-27T08:00:00+08:00']));
  }
  static now() { return new FixedDate().getTime(); }
}

const values = new Map([
  ['trade-order-dashboard-amount-month', 'all'],
  ['trade-order-dashboard-amount-month-auto', '2026-07']
]);
const localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); }
};

const context = vm.createContext({
  Date:FixedDate,
  localStorage,
  normalizeMonth() { return '2026-08'; },
  orderMonths() { return ['2026-08', '2026-07']; }
});
vm.runInContext(`const dashboardAmountMonthKey = 'trade-order-dashboard-amount-month'; const dashboardAmountMonthAutoKey = 'trade-order-dashboard-amount-month-auto';`, context);
vm.runInContext(extractFunction('dashboardAmountMonthValue'), context);
vm.runInContext(extractFunction('saveDashboardAmountMonth'), context);

const options = ['all', '2026-08', '2026-07'];
context.testOptions = options;
assert.equal(vm.runInContext('dashboardAmountMonthValue(testOptions)', context), '2026-08', '每个月首次打开首页时订单总额必须默认本月');
assert.equal(values.get('trade-order-dashboard-amount-month'), '2026-08', '本月默认值必须保存，避免同月重复重置');

vm.runInContext(`saveDashboardAmountMonth('all')`, context);
assert.equal(vm.runInContext('dashboardAmountMonthValue(testOptions)', context), 'all', '同月手动选择全部后必须保留用户选择');

console.log('Dashboard month test passed: current-month default and manual selection persistence verified.');

// Exercise the actual dashboard: only the amount card follows the selected month.
(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({viewport:{width:1360,height:900}});
    const errors=[]; let saves=0;
    page.on('pageerror', error=>errors.push(error.message));
    const orders = [
      {id:'old-due',num:'TEST-1',client:'History Buyer',orderMonth:'2026-07',stage:'deposit',amount:300,paidAmount:100,currency:'USD'},
      {id:'current-due',num:'TEST-2',client:'Current Buyer',orderMonth:'2026-08',stage:'production',amount:200,paidAmount:50,currency:'USD'},
      {id:'quote-due',num:'TEST-3',client:'Quote Buyer',orderMonth:'2026-08',stage:'quote',amount:80,paidAmount:20,currency:'USD'},
      {id:'settled',num:'TEST-4',client:'Settled Buyer',orderMonth:'2026-08',stage:'shipment',amount:500,paidAmount:0,currency:'USD'},
      {id:'draft',num:'TEST-5',client:'Draft Buyer',orderMonth:'2026-07',stage:'deposit',amount:900,paidAmount:0,currency:'USD',isDraft:true}
    ];
    await page.route('**/*',route=>{
      const pathname = new URL(route.request().url()).pathname;
      if(pathname==='/trade-order-system.html') return route.fulfill({contentType:'text/html',body:html});
      if(pathname==='/api/data') return route.fulfill({json:{app:'trade-order-system',revision:1,data:{orders,customers:{},trashOrders:[{id:'trash',amount:9999,stage:'deposit'}],deletedOrders:[{id:'deleted',amount:9999,stage:'deposit'}],demoCleared:true,demoCustomersCleared:true}}});
      if(pathname==='/api/save') saves++;
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    for(const [month,total] of [['2026-08',780],['2026-07',300],['all',1080]]) {
      await page.locator('#totalRange').selectOption(month,{force:true});
      assert.equal(await page.locator('#statPayment').innerText(),'$410 USD','historical receivables must remain unchanged when switching amount months');
      assert.equal(await page.locator('#statAmount').innerText(),`$${total.toLocaleString('en-US')} USD`,'order total must still follow the selected month');
      assert.match(await page.locator('#statPayment').locator('..').innerText(),/历史累计/);
    }
    for(const theme of ['light','dark']) {
      await page.evaluate(t=>applyTheme(t),theme);
      if(process.env.UI_SCREENSHOT) await page.locator('#statPayment').locator('..').screenshot({path:`${process.env.UI_SCREENSHOT}.${theme}.png`});
    }
    assert.equal(saves,0,'changing a dashboard month must not save business data');
    assert.deepEqual(errors,[]);
    console.log('Dashboard historical receivables UI passed: month isolation, draft/deleted exclusion and settled-stage invariants.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
