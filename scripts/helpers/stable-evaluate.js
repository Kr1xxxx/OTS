// Preloaded into every test process by scripts/run-tests.js (node --require).
//
// Why: on CI, page.evaluate(fn) whose fn returns a page-side promise that stays pending for a while (a save going
// through page.route, a fetch, a timer) now and then fails with "page.evaluate: Resulting promise was garbage
// collected" although the page finished the work. Chrome's DevTools protocol (Runtime.callFunctionOn with
// awaitPromise) lost track of the pending promise; keeping it on window or holding it with a timer did not help.
// page.evaluate cannot retry by itself (the page function may have side effects), so every test that awaited a save
// this way failed at random (test-audit-v3117 / v3138 and others, macOS and Linux).
//
// What: when the page function returns a promise, page.evaluate now only starts it, keeps the promise on window, and
// waits for its outcome with page.waitForFunction. waitForFunction just reads a value, so Playwright retries it on
// its own when the same protocol error happens. Plain (synchronous) page functions run exactly as before. Results,
// thrown errors, handles passed as the argument and "no timeout" behave the same as the original page.evaluate.
const playwright = require('playwright');

const factories = playwright._connection?._objectFactories;
const makeFrame = factories?.get?.('Frame');
let patched = false;

function patchFrame(proto) {
  const originalEvaluate = proto.evaluate;
  if (typeof originalEvaluate !== 'function' || originalEvaluate.__otsStable) return;
  async function evaluate(pageFunction, arg, options) {
    if (typeof pageFunction !== 'function' || options?.exposeFunctions) return originalEvaluate.call(this, pageFunction, arg, options);
    let start;
    try {
      // Same source Playwright would send, wrapped so that a returned promise is parked on window instead of awaited.
      start = new Function('__otsArg', `
        const __otsFn = (${String(pageFunction)});
        const __otsResult = __otsFn(__otsArg);
        if (!__otsResult || typeof __otsResult.then !== 'function') return { sync:true, value:__otsResult };
        const box = window.__otsStableEvaluate || (window.__otsStableEvaluate = { seq:0, pending:{} });
        const id = ++box.seq;
        const entry = box.pending[id] = { done:false, promise:__otsResult };
        __otsResult.then(value => { entry.done = true; entry.ok = true; entry.value = value; },
          error => { entry.done = true; entry.ok = false; entry.error = error instanceof Error ? (error.stack || String(error)) : String(error); });
        return { sync:false, id };
      `);
    } catch (_) {
      // Source that cannot be wrapped (e.g. a method shorthand): let Playwright handle it as usual.
      return originalEvaluate.call(this, pageFunction, arg, options);
    }
    const started = await originalEvaluate.call(this, start, arg);
    if (started.sync) return started.value;
    // A reload or navigation while waiting loses the parked promise: fail like page.evaluate would, instead of
    // waiting forever.
    await this.waitForFunction(id => {
      const entry = window.__otsStableEvaluate?.pending?.[id];
      if (!entry) throw new Error('Execution context was destroyed, most likely because of a navigation.');
      return entry.done;
    }, started.id, { timeout:0 });
    const outcome = await originalEvaluate.call(this, id => {
      const box = window.__otsStableEvaluate.pending;
      const { ok, value, error } = box[id];
      delete box[id];
      return { ok, value, error };
    }, started.id);
    if (outcome.ok) return outcome.value;
    throw new Error(outcome.error);
  }
  evaluate.__otsStable = true;
  proto.evaluate = evaluate;
}

if (typeof makeFrame === 'function') {
  factories.set('Frame', (...args) => {
    const frame = makeFrame(...args);
    if (!patched) {
      patched = true;
      patchFrame(Object.getPrototypeOf(frame));
    }
    return frame;
  });
} else {
  // A Playwright update moved the internals: say so instead of silently testing without the fix.
  console.warn('[stable-evaluate] Playwright internals changed; page.evaluate is not patched');
}
