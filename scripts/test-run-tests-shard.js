#!/usr/bin/env node
// OTS_TEST_SHARD=K/N (scripts/run-tests.js): the N parts together start every test exactly once, in the Chromium
// list and in the WebKit list, so a test cannot drop out of CI by the way the list is split. A value that names
// no part stops the run instead of running nothing and reporting success.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, 'run-tests.js');
function list(env, args = []) {
  const result = spawnSync(process.execPath, [runner, '--list', ...args], {
    env: { ...process.env, OTS_TEST_BROWSER: '', OTS_TEST_SHARD: '', ...env }, encoding: 'utf8'
  });
  return { status: result.status, names: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

for (const browser of ['', 'webkit']) {
  const whole = list({ OTS_TEST_BROWSER: browser });
  assert.equal(whole.status, 0, whole.stderr);
  assert.ok(whole.names.length > 50, `the ${browser || 'chromium'} list has ${whole.names.length} tests`);
  assert.equal(new Set(whole.names).size, whole.names.length, 'a name is listed twice');
  for (const parts of [1, 2, 3]) {
    const seen = new Map();
    for (let part = 1; part <= parts; part += 1) {
      const shard = list({ OTS_TEST_BROWSER: browser, OTS_TEST_SHARD: `${part}/${parts}` });
      assert.equal(shard.status, 0, shard.stderr);
      shard.names.forEach(name => seen.set(name, (seen.get(name) || 0) + 1));
      // Dealt out in turn: no part is more than one test longer than another (check-project is in each).
      const share = whole.names.filter(name => name !== 'check-project').length / parts;
      const own = shard.names.filter(name => name !== 'check-project').length;
      assert.ok(Math.abs(own - share) < 1, `part ${part}/${parts} has ${own} tests of ${whole.names.length}`);
    }
    assert.deepEqual([...seen.keys()].sort(), [...whole.names].sort(), `${parts} parts do not add up to the ${browser || 'chromium'} list`);
    for (const [name, count] of seen) {
      // check-project takes under a second and goes first in every part.
      assert.equal(count, name === 'check-project' ? parts : 1, `${name} runs in ${count} of ${parts} parts`);
    }
  }
}

// A name filter narrows a part; it does not move tests between parts.
const filtered = list({ OTS_TEST_SHARD: '2/2' }, ['customer']);
const second = list({ OTS_TEST_SHARD: '2/2' });
assert.ok(filtered.names.length > 0 && filtered.names.every(name => name.includes('customer') && second.names.includes(name)));

for (const bad of ['0/2', '3/2', '2', '1/0', 'a/b', '1/2/3', '-1/2']) {
  const result = list({ OTS_TEST_SHARD: bad });
  assert.notEqual(result.status, 0, `OTS_TEST_SHARD=${bad} was accepted`);
  assert.match(result.stderr, /OTS_TEST_SHARD/);
  assert.equal(result.names.length, 0);
}

console.log('Test shards passed: the parts add up to the whole list in Chromium and WebKit, and a wrong value stops the run.');
