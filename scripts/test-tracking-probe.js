#!/usr/bin/env node
// Exercise the opt-in CLI with local carrier responses, including exits visible to automation.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

(async () => {
  let dhlStatus = 503;
  let oauthStatus = 401;
  let trackingError = false;
  const credentials = { FEDEX_CLIENT_ID: 'fixture-id', FEDEX_CLIENT_SECRET: 'fixture' };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url.startsWith('/dhl?')) return reply(dhlStatus, { shipments: [{ status: { description: 'In transit' } }] });
    if (req.url === '/oauth/token') {
      const form = new URLSearchParams(body);
      if (form.get('client_id') !== credentials.FEDEX_CLIENT_ID || form.get('client_secret') !== credentials.FEDEX_CLIENT_SECRET) return reply(403, {});
      return reply(oauthStatus, oauthStatus === 200 ? { access_token: 'fixture-token' } : {});
    }
    if (req.url === '/track/v1/trackingnumbers' && req.headers.authorization === 'Bearer fixture-token') {
      const track = trackingError ? { error: { message: 'Not found' } } : { latestStatusDetail: { statusByLocale: 'In transit' } };
      return reply(200, { output: { completeTrackResults: [{ trackResults: [track] }] } });
    }
    reply(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, DHL_TRACKING_ENDPOINT: base + '/dhl', OTS_FEDEX_API_HOST: base,
      DHL_API_KEY: '', FEDEX_CLIENT_ID: '', FEDEX_CLIENT_SECRET: '', FEDEX_API_KEY: '', FEDEX_API_SECRET: '' };
    const probe = (target, extra = {}) => new Promise(resolve => {
      execFile(process.execPath, [path.join(__dirname, 'test-tracking-api.js'), target], { env: { ...env, ...extra }, timeout: 10000 }, (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
    });
    const skipped = await probe('all');
    assert.equal(skipped.code, 2, skipped.stderr);
    assert.match(skipped.stdout, /FedEx skipped/);
    const failed = await probe('all', { ...credentials, DHL_API_KEY: 'fixture-key' });
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stdout, /"httpStatus": 503/);
    assert.match(failed.stdout, /"httpStatus": 401/);
    oauthStatus = dhlStatus = 200;
    trackingError = true;
    const missingShipment = await probe('FedEx', credentials);
    assert.equal(missingShipment.code, 1, missingShipment.stderr);
    assert.equal(JSON.parse(missingShipment.stdout).status, 'Not found');
    trackingError = false;
    const passed = await probe('all', { ...credentials, DHL_API_KEY: 'fixture-key' });
    assert.equal(passed.code, 0, passed.stderr);
    assert.equal(passed.stdout.match(/"ok": true/g)?.length, 2);
    Object.assign(process.env, credentials, { OTS_FEDEX_API_HOST: base });
    const { createCarrierTracking } = require('../mac-app/carrier-tracking');
    const tracking = createCarrierTracking({ readTrackingSettings: () => ({ fedexApiEnabled: '是' }) });
    assert.equal((await tracking.checkFedExApiStatus()).ok, true, 'FedEx status accepts environment-only credentials');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('Tracking probe passed for success, missing credentials, transport status and shipment errors.');
})().catch(error => { console.error(error); process.exitCode = 1; });
