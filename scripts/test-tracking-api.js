#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
loadEnv(path.join(root, '.env'));

const carrierArg = String(process.argv[2] || 'all').toLowerCase();
const numberArg = String(process.argv[3] || '').trim();

const defaults = {
  dhl: numberArg || '9188335262',
  fedex: numberArg || '871032796510'
};

main().catch(error => {
  console.error(`API test failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const targets = carrierArg === 'all' ? ['dhl', 'fedex'] : [carrierArg];
  for (const target of targets) {
    if (target === 'dhl') await testDhl(defaults.dhl);
    else if (target === 'fedex') await testFedEx(defaults.fedex);
    else throw new Error('Usage: npm run test:api -- [DHL|FedEx|all] [trackingNumber]');
  }
}

async function testDhl(trackingNumber) {
  const key = process.env.DHL_API_KEY;
  const endpoint = process.env.DHL_TRACKING_ENDPOINT || 'https://api-eu.dhl.com/track/shipments';
  if (!key) {
    console.log('DHL skipped: set DHL_API_KEY in .env first.');
    return;
  }
  const url = `${endpoint}?trackingNumber=${encodeURIComponent(cleanTracking(trackingNumber))}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'DHL-API-Key': key },
    cache: 'no-store'
  });
  const data = await readJson(res);
  const shipment = data.shipments?.[0];
  console.log(JSON.stringify({
    carrier: 'DHL',
    ok: res.ok,
    httpStatus: res.status,
    trackingNumber,
    status: shipment?.status?.description || shipment?.status?.status || data.detail || data.message || '',
    updatedAt: shipment?.status?.timestamp || '',
    eventCount: Array.isArray(shipment?.events) ? shipment.events.length : 0
  }, null, 2));
}

async function testFedEx(trackingNumber) {
  const key = process.env.FEDEX_API_KEY;
  const secret = process.env.FEDEX_API_SECRET;
  if (!key || !secret) {
    console.log('FedEx skipped: set FEDEX_API_KEY and FEDEX_API_SECRET in .env first.');
    return;
  }
  const baseUrl = String(process.env.FEDEX_ENV || 'test').toLowerCase() === 'prod'
    ? 'https://apis.fedex.com'
    : 'https://apis-sandbox.fedex.com';
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: key,
      client_secret: secret
    }).toString()
  });
  const tokenData = await readJson(tokenRes);
  if (!tokenRes.ok || !tokenData.access_token) {
    console.log(JSON.stringify({ carrier: 'FedEx', ok: false, step: 'oauth', httpStatus: tokenRes.status, error: tokenData }, null, 2));
    return;
  }
  const trackRes = await fetch(`${baseUrl}/track/v1/trackingnumbers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: cleanTracking(trackingNumber) } }],
      includeDetailedScans: true
    })
  });
  const data = await readJson(trackRes);
  const track = data.output?.completeTrackResults?.[0]?.trackResults?.[0];
  console.log(JSON.stringify({
    carrier: 'FedEx',
    ok: trackRes.ok,
    httpStatus: trackRes.status,
    trackingNumber,
    status: track?.latestStatusDetail?.statusByLocale || data.errors?.[0]?.message || data.message || '',
    updatedAt: track?.dateAndTimes?.[0]?.dateTime || '',
    eventCount: Array.isArray(track?.scanEvents) ? track.scanEvents.length : 0
  }, null, 2));
}

function cleanTracking(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

async function readJson(res) {
  return res.json().catch(async () => ({ text: await res.text().catch(() => '') }));
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

