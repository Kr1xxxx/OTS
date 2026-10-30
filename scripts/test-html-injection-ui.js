#!/usr/bin/env node
// Fills every user-editable text field with markup and checks that no page or modal turns it into elements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const marker = 'ots-injection-probe';
const payload = tag => `${tag}"'><img src="x" class="${marker}" onerror="window.__injected.push('${tag}')"><b class="${marker}">${tag}</b>`;

const client = payload('client');
const data = {
  demoCleared: true, demoCustomersCleared: true,
  customers: {
    [client]: {
      name: client, country: payload('country'), email: 'probe@example.com', contact: payload('contact'),
      address: payload('address'), note: payload('customer-note'), notes: payload('customer-notes'),
      tags: [payload('tag')], company: payload('company'), source: payload('source'), level: '自动判断'
    }
  },
  orders: [{
    id: 'probe-order', num: payload('num'), client, country: payload('order-country'), currency: 'USD',
    amount: 1200, paidAmount: 300, orderMonth: '2026-10', createdAt: '2026-10-01', updated: '2026-10-16 12:00',
    stage: 'production', productType: payload('product'), paymentChannel: payload('payment'),
    note: payload('order-note'), trackingNumber: payload('tracking'), carrier: 'DHL', latestShipDate: '2026-10-17',
    logs: [{ time: '2026-10-02 09:00', text: payload('log') }],
    attachments: [{ name: payload('attachment'), type: '图片附件', fileUrl: '/attachments/probe.png', thumbUrl: '/attachments/probe.png' }]
  }],
  trashOrders: [], deletedOrders: [],
  trackingLookups: [{ id: 'probe-lookup', trackingNumber: payload('lookup'), carrier: 'DHL', status: payload('lookup-status'), checkedAt: '2026-10-16 12:00', events: [{ time: '2026-10-16 11:00', description: payload('event'), location: payload('location') }] }]
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.clock.install({ time: new Date('2026-10-16T12:00:00+08:00') });
    await page.addInitScript(() => { window.__injected = []; });
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType: 'text/html', body: html });
      if (pathname === '/api/data') return route.fulfill({ json: { app: 'trade-order-system', revision: 0, data } });
      if (pathname === '/api/health') return route.fulfill({ json: { ok: true, storageMode: 'sqlite', counts: { orders: 1 }, backups: { sqliteCount: 0 } } });
      if (pathname === '/api/save') return route.fulfill({ json: { ok: true, revision: 1, backup: { ok: true, skipped: true } } });
      if (pathname.startsWith('/attachments/')) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    const surfaces = [
      ['dashboard', () => setPage('dashboard')],
      ['order-list', () => setPage('order-list')],
      ['logistics', () => setPage('logistics')],
      ['amount', () => setPage('amount')],
      ['targets', () => setPage('targets')],
      ['calendar', () => setPage('calendar')],
      ['analysis', () => setPage('analysis')],
      ['customers', () => setPage('customers')],
      ['deleted', () => setPage('deleted')],
      ['settings', () => setPage('settings')],
      ['search', () => openFullSearchResults('client')],
      ['order detail', () => openOrderDetail('probe-order')],
      ['order editor', () => openOrder('probe-order')],
      ['customer profile', () => openCustomerModal(Object.keys(state.customers)[0])],
      ['tracking detail', () => { setPage('logistics'); openTrackingDetail('probe-lookup'); }],
      ['order paste preview', () => renderPasteAssistResults(analyzePasteText(`客户：${'<img src="x" class="ots-injection-probe" onerror="window.__injected.push(1)">'}\n订单号：<b class="ots-injection-probe">P-1</b>\n金额：100 USD`))],
      ['customer paste preview', () => renderCustomerPasteResults(analyzeCustomerPasteText(`Name: <img src="x" class="ots-injection-probe" onerror="window.__injected.push(2)">\nEmail: probe@example.com\nAddress: <b class="ots-injection-probe">1 Main St</b>`))]
    ];
    const findings = [];
    for (const [name, open] of surfaces) {
      const error = await page.evaluate(fn => {
        document.querySelectorAll('.modal-backdrop.open').forEach(el => el.classList.remove('open'));
        try { (0, eval)(`(${fn})`)(); return ''; } catch (e) { return e.message; }
      }, open.toString());
      await page.clock.fastForward(500);
      const injected = await page.evaluate(selector => [...document.querySelectorAll(selector)].map(el => el.outerHTML.slice(0, 120)), `.${marker}`);
      if (error) findings.push(`${name}: threw ${error}`);
      if (injected.length) findings.push(`${name}: ${injected.length} injected element(s), e.g. ${injected[0]}`);
    }
    const executed = await page.evaluate(() => window.__injected);
    if (executed.length) findings.push(`event handlers executed for: ${[...new Set(executed)].join(', ')}`);
    assert.deepEqual(findings, [], `user text was rendered as HTML:\n${findings.join('\n')}`);
    console.log(`HTML injection UI passed: ${surfaces.length} pages and dialogs render markup in user fields as text.`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
