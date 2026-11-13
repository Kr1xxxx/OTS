// Preloaded into every test process by scripts/run-tests.js (node --require), next to stable-evaluate.js.
//
// Why: test-stage-undo-ui failed now and then on CI (2026-11-07, 2026-11-13): it clicked 「撤销」 on a toast right after
// the toast appeared, click() returned without error, and yet the undo never ran. For the first few frames after a
// heavy render a new element's entry animation is still pending (not started by the compositor), so the element
// does not move. Playwright counts "same box two frames in a row" as stable, computes the click point from the
// animation's first keyframe, and the animation then starts and moves the element. The press lands on its edge,
// the release lands on whatever slid under the pointer, and the browser sends `click` to the common ancestor
// instead of the button. Playwright checks the hit target only on the press, so it reports success.
//
// What: before frame/page/locator .click(), .dblclick() and .tap() (all go through the client Frame), wait until no
// animation on the target or on any of its ancestors is still pending. Only the start is awaited, not the end: once
// an animation runs, the element moves every frame and Playwright's own stability check waits for it to stop, so an
// endless spinner does not block and a click pays no extra animation time. force and trial clicks are untouched;
// page.mouse.* and dispatchEvent are untouched too (a test using them owns its coordinates and timing).
const playwright = require('playwright');

const factories = playwright._connection?._objectFactories;
const makeFrame = factories?.get?.('Frame');
let patched = false;

// Runs in the page once per animation frame until it returns true. A target that left the page counts as done here;
// the caller then looks the selector up again.
function animationsStarted(el) {
  return !el.isConnected || !document.getAnimations().some(animation => {
    const target = animation.pending && animation.effect?.target;
    return target && (target === el || target.contains(el));
  });
}

async function waitForPendingAnimations(frame, selector, options) {
  // The first match can be removed while we wait (a toast that was already leaving when a new one with the same
  // button arrived): then wait again for whatever the selector matches now. Three rounds are plenty.
  for (let round = 0; round < 3; round++) {
    let handle;
    try {
      handle = await frame.waitForSelector(selector, { state: 'attached', strict: options?.strict, timeout: options?.timeout });
    } catch (error) {
      // The element never appeared within the click's own timeout: the click would wait as long again and fail the
      // same way, so report it now instead of doubling the wait. Anything else (strict-mode violation, navigation,
      // a closed page) is left to the real call, which reports its own error.
      if (error?.name === 'TimeoutError') throw error;
      return;
    }
    try {
      const t0 = Date.now();
      const before = process.env.OTS_SETTLED_LOG ? await handle.evaluate(el => document.getAnimations().filter(a => a.pending && a.effect?.target && (a.effect.target === el || a.effect.target.contains(el))).map(a => `${a.animationName || a.transitionProperty || a.id}@${a.effect.target.id || a.effect.target.className}:${a.playState}:${a.currentTime}`)) : null;
      const t1 = Date.now();
      await frame.waitForFunction(animationsStarted, handle, { polling: 'raf', timeout: options?.timeout });
      if (process.env.OTS_SETTLED_LOG) require('node:fs').appendFileSync(process.env.OTS_SETTLED_LOG, `${process.argv[process.argv.length - 1].split('/').pop()} ${selector} probe=${t1 - t0}ms wait=${Date.now() - t1}ms pending=${JSON.stringify(before)}\n`);
      if (await handle.evaluate(el => el.isConnected)) return;
    } catch (_) {
      // An animation that never starts, a page that went away: click as Playwright would have.
      return;
    } finally {
      await handle.dispose().catch(() => {});
    }
  }
}

function wrap(proto, name) {
  const original = proto[name];
  if (typeof original !== 'function' || original.__otsSettled) return;
  async function settled(selector, options) {
    if (!options?.force && !options?.trial) await waitForPendingAnimations(this, selector, options);
    return original.call(this, selector, options);
  }
  settled.__otsSettled = true;
  proto[name] = settled;
}

if (typeof makeFrame === 'function') {
  factories.set('Frame', (...args) => {
    const frame = makeFrame(...args);
    if (!patched) {
      patched = true;
      const proto = Object.getPrototypeOf(frame);
      for (const name of ['click', 'dblclick', 'tap']) wrap(proto, name);
    }
    return frame;
  });
} else {
  // A Playwright update moved the internals: say so instead of silently testing without the fix.
  console.warn('[settled-click] Playwright internals changed; click is not patched');
}
