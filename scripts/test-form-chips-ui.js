#!/usr/bin/env node
// 表单选项控件：5 个以上选项（收款方式）渲染成可换行 chip 组并占整行，文字不被裁切；
// 2～4 个选项的分段控件和输入框同高；新建订单和订单设置，深浅色都检查。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { h } = require('./helpers/board-page');

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-form-chips-'));
const port = 47100 + (process.pid % 800);
const token = 'f'.repeat(40);
let server = null;

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try { const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers:{ Authorization:`Bearer ${token}` } }); if (res.ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

function inspect(selectName) {
  const select = document.querySelector(`select[name="${selectName}"]`);
  const field = select.closest('.field');
  const wrap = select.nextElementSibling;
  const grid = field.parentElement.getBoundingClientRect();
  const options = [...wrap.querySelectorAll('.binary-option')];
  return {
    chips: wrap.classList.contains('binary-chips'),
    fieldChips: field.classList.contains('field-chips'),
    fullRow: Math.abs(field.getBoundingClientRect().width - grid.width) < 2,
    clipped: options.filter(o => o.scrollWidth > o.clientWidth + 1).map(o => o.textContent.trim()),
    count: options.length,
    pressed: options.filter(o => o.getAttribute('aria-pressed') === 'true').length,
    height: Math.round(wrap.getBoundingClientRect().height)
  };
}

(async () => {
  fs.copyFileSync(path.join(root, 'trade-order-data.json'), path.join(dataDir, 'trade-order-data.json'));
  server = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], { env:{ ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1' }, stdio:'ignore' });
  await waitForServer();
  const browser = await chromium.launch({ headless:true, ...(process.env.BROWSER_CHANNEL ? { channel:process.env.BROWSER_CHANNEL } : {}) });
  try {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport:{ width:1440, height:920 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${port}/trade-order-system.html?token=${token}#dashboard`);
      await page.waitForFunction(() => typeof openOrder === 'function');
      await page.evaluate(t => { document.documentElement.dataset.theme = t; openOrder(); }, theme);
      // Measure once the modal has finished growing in (sizes are compared to the pixel).
      await h.quiet(page);
      const payment = await page.evaluate(inspect, 'paymentChannel');
      assert.equal(payment.count, 6, 'six payment channels');
      assert(payment.chips && payment.fieldChips, `${theme}: payment channel should be a chip group`);
      assert(payment.fullRow, `${theme}: payment chip field should span the whole row`);
      assert.deepEqual(payment.clipped, [], `${theme}: payment chips clipped`);
      assert.equal(payment.pressed, 1, 'exactly one chip pressed');
      const orderType = await page.evaluate(inspect, 'orderType');
      const inputHeight = await page.evaluate(() => Math.round(document.querySelector('#orderForm input[name="country"]').getBoundingClientRect().height));
      assert(!orderType.chips, 'two options stay a segmented control');
      assert(Math.abs(orderType.height - inputHeight) <= 1, `${theme}: segmented ${orderType.height}px vs input ${inputHeight}px`);
      assert.deepEqual(orderType.clipped, []);
      // 点 chip 会写回隐藏的 select。
      await page.click('select[name="paymentChannel"] + .binary-segment [data-binary-value="Zelle"]');
      assert.equal(await page.$eval('#orderForm select[name="paymentChannel"]', s => s.value), 'Zelle');
      assert.equal(await page.$eval('#orderForm [data-binary-value="Zelle"]', b => b.getAttribute('aria-pressed')), 'true');

      await page.evaluate(() => { closeOrder(); setPage('settings'); document.querySelector('[data-settings-tab="order"]').click(); });
      await h.quiet(page);
      const defaults = await page.evaluate(inspect, 'defaultPaymentChannel');
      assert(defaults.chips && defaults.fullRow, `${theme}: default payment channel chips should span the row`);
      assert.deepEqual(defaults.clipped, []);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Form chips passed: payment chips full-row, segmented height = input, light/dark.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  server?.kill();
  try { fs.rmSync(dataDir, { recursive:true, force:true }); } catch (_) {}
});
