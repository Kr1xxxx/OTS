#!/usr/bin/env node
// Measures page render and save cost with synthetic data. Not part of npm test.
// Usage: node scripts/bench-render-save.js [orderCount ...]   (default 58 500 2000 10000)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
const counts = process.argv.slice(2).map(Number).filter(Boolean);
const sizes = counts.length ? counts : [58, 500, 2000, 10000];
const pages = ['dashboard', 'order-list', 'amount', 'analysis', 'customers', 'logistics'];
const stages = ['quote', 'production', 'shipping', 'settled'];

function syntheticData(orderCount) {
  const customerCount = Math.max(5, Math.round(orderCount * 0.6));
  const customers = {};
  for (let i = 0; i < customerCount; i += 1) {
    customers[`Bench Buyer ${i}`] = { name: `Bench Buyer ${i}`, country: 'United States', currency: 'USD', email: `buyer${i}@example.com` };
  }
  const orders = Array.from({ length: orderCount }, (_, i) => {
    const month = `202${4 + (i % 3)}-${String(1 + (i % 12)).padStart(2, '0')}`;
    return {
      id: `bench-${i}`, num: `BENCH-${String(i).padStart(6, '0')}`, client: `Bench Buyer ${i % customerCount}`,
      country: 'United States', currency: 'USD', amount: 500 + (i % 97) * 13.5, paidAmount: (i % 3) * 200,
      orderMonth: month, createdAt: `${month}-10`, updated: `${month}-12 10:00`, stage: stages[i % stages.length],
      productType: '睫毛', paymentChannel: 'Paypal', note: 'synthetic benchmark order',
      logs: [{ time: `${month}-10 09:00`, text: 'created' }, { time: `${month}-11 09:00`, text: 'updated' }], attachments: []
    };
  });
  return { demoCleared: true, demoCustomersCleared: true, customers, orders, trashOrders: [], deletedOrders: [], trackingLookups: [] };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const rows = [];
  try {
    for (const size of sizes) {
      const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const data = syntheticData(size);
      let saveBytes = 0;
      await page.route('**/*', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/trade-order-system.html') return route.fulfill({ contentType: 'text/html', body: html });
        if (pathname === '/api/data') return route.fulfill({ json: { app: 'trade-order-system', revision: 0, data } });
        if (pathname === '/api/save') {
          saveBytes = route.request().postData()?.length || 0;
          return route.fulfill({ json: { ok: true, revision: 1 } });
        }
        return route.fulfill({ json: { ok: true } });
      });
      const loadStart = Date.now();
      await page.goto('http://127.0.0.1:47999/trade-order-system.html');
      await page.waitForFunction(() => window.pendingSaveStatus?.().loaded, null, { timeout: 120000 });
      const loadMs = Date.now() - loadStart;
      const result = await page.evaluate(names => {
        const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const timings = {};
        for (const name of names) {
          setPage(name);
          const samples = [];
          for (let i = 0; i < 3; i += 1) {
            const start = performance.now();
            render();
            samples.push(performance.now() - start);
          }
          timings[name] = median(samples);
        }
        const stringifySamples = [];
        for (let i = 0; i < 3; i += 1) {
          const start = performance.now();
          JSON.stringify(state);
          stringifySamples.push(performance.now() - start);
        }
        return { timings, stringifyMs: median(stringifySamples), stateBytes: JSON.stringify(state).length };
      }, pages);
      await page.evaluate(() => flushPendingSave());
      rows.push({ size, loadMs, ...result, saveBytes, errors: errors.length });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const header = ['orders', 'load', ...pages, 'stringify', 'state KB', 'save KB', 'errors'];
  console.log(header.join('\t'));
  for (const row of rows) {
    console.log([
      row.size, `${row.loadMs}ms`, ...pages.map(name => `${row.timings[name].toFixed(0)}ms`),
      `${row.stringifyMs.toFixed(1)}ms`, (row.stateBytes / 1024).toFixed(0), (row.saveBytes / 1024).toFixed(0), row.errors
    ].join('\t'));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
