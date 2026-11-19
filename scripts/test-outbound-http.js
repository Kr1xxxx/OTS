#!/usr/bin/env node
// Requests to the outside settle whatever the far side does. A body cut off after the headers used to leave
// the promise pending for good, and the exchange-rate refresh that shares it then kept handing out the old
// rate until the app restarted. Everything here runs against a made-up server on 127.0.0.1.
const assert = require('node:assert/strict');
const http = require('node:http');
const { requestText } = require('../mac-app/outbound-http');
const { freePortSync } = require('./helpers/free-port');

const settledWithin = (promise, ms) => Promise.race([
  promise.then(value => ({ value }), error => ({ error })),
  new Promise(resolve => setTimeout(() => resolve({ pending:true }), ms))
]);

(async () => {
  const port = freePortSync();
  const server = http.createServer((req, res) => {
    if (req.url === '/cut') {
      // Promises 5000 bytes, sends a few, then closes the connection cleanly (FIN, no reset).
      res.writeHead(200, { 'Content-Type':'application/json', 'Content-Length':'5000' });
      res.write('{"data":[');
      setTimeout(() => res.socket.end(), 50);
      return;
    }
    if (req.url === '/chunked-cut') {
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.write('{"data":[');
      setTimeout(() => res.socket.end(), 50);
      return;
    }
    res.writeHead(200, { 'Content-Type':'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.deepEqual(await settledWithin(requestText(`${base}/ok`), 3000), { value:'{"ok":true}' });
    for (const route of ['/cut', '/chunked-cut']) {
      const result = await settledWithin(requestText(`${base}${route}`), 3000);
      assert.ok(!result.pending, `${route}: a body cut off after the headers must not leave the request pending`);
      assert.ok(result.error instanceof Error, `${route}: rejected, so the caller can retry`);
    }
  } finally {
    server.close();
  }
  console.log('Outbound HTTP passed: a response cut off after its headers rejects instead of hanging.');
})().catch(error => { console.error(error); process.exitCode = 1; });
