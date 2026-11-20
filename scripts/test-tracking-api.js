#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
loadEnv(path.join(root, '.env'));
const { fedexCredentials, fedexApiHost } = require('../mac-app/carrier-tracking');

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
  const probes = { dhl: testDhl, fedex: testFedEx };
  if (!targets.every(target => Object.hasOwn(probes, target))) throw new Error('Usage: npm run test:api -- [DHL|FedEx|all] [trackingNumber]');
  let executed = 0;
  for (const target of targets) {
    try {
      const ok = await probes[target](defaults[target]);
      if (ok === undefined) continue;
      executed++;
      if (!ok) process.exitCode = 1;
    } catch (error) {
      executed++;
      console.error(`${target} API test failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (!executed) process.exitCode = 2;
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
  const ok = res.ok && Boolean(shipment);
  console.log(JSON.stringify({
    carrier: 'DHL',
    ok,
    httpStatus: res.status,
    trackingNumber,
    status: shipment?.status?.description || shipment?.status?.status || data.detail || data.message || '',
    updatedAt: shipment?.status?.timestamp || '',
    eventCount: Array.isArray(shipment?.events) ? shipment.events.length : 0
  }, null, 2));
  return ok;
}

async function testFedEx(trackingNumber) {
  const { clientId, clientSecret } = fedexCredentials({
    fedexApiKey: process.env.FEDEX_API_KEY, fedexApiSecret: process.env.FEDEX_API_SECRET
  });
  if (!clientId || !clientSecret) {
    console.log('FedEx skipped: set FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET in .env first.');
    return;
  }
  const baseUrl = fedexApiHost({ fedexEnv: String(process.env.FEDEX_ENV || 'test').toLowerCase() });
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });
  const tokenData = await readJson(tokenRes);
  if (!tokenRes.ok || !tokenData.access_token) {
    console.log(JSON.stringify({ carrier: 'FedEx', ok: false, step: 'oauth', httpStatus: tokenRes.status }, null, 2));
    return false;
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
  const ok = trackRes.ok && Boolean(track) && !track.error;
  console.log(JSON.stringify({
    carrier: 'FedEx',
    ok,
    httpStatus: trackRes.status,
    trackingNumber,
    status: track?.latestStatusDetail?.statusByLocale || track?.error?.message || data.errors?.[0]?.message || data.message || '',
    updatedAt: track?.dateAndTimes?.[0]?.dateTime || '',
    eventCount: Array.isArray(track?.scanEvents) ? track.scanEvents.length : 0
  }, null, 2));
  return ok;
}

function cleanTracking(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

async function readJson(res) {
  return (await res.json().catch(() => null)) || {};
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

