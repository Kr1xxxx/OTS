// Preloaded into every test process by scripts/run-tests.js when OTS_TEST_NOW is set (node --require).
//
// Runs the tests as if it were another moment: `Date` (new Date(), Date(), Date.now()) in the test process, in
// every Node process it starts (mac-app/server.js among them, through NODE_OPTIONS) and in every page Playwright
// opens is moved by the same offset. Time still passes at its real speed. Timers and performance.now() are left
// alone on purpose: taking them over (as Playwright's clock.install does) would make the UI tests' waits flaky.
//
// What it does not move: the pages of a test that drives their time with Playwright's clock (page.clock.install and
// the rest; that test sets the time itself, and the clock and this shift would each take the other for the real one),
// file times written by the system (fs.stat mtime), the clock of a browser extension's service worker, and code that
// runs in a vm context created without the Date of this process. run-tests.js lists the tests that cannot run
// shifted, with the reason, in notWithShiftedClock.
//
// The offset comes from OTS_TEST_CLOCK_OFFSET (milliseconds), which run-tests.js works out once from OTS_TEST_NOW,
// so every process of one run sees the same shifted clock.
const offset = Number(process.env.OTS_TEST_CLOCK_OFFSET || 0);

// Also sent into pages as source text, so it uses nothing from this file.
function shiftDate(offset) {
  const Real = Date;
  if (!offset || Real.__otsShifted) return;
  function ShiftedDate(...args) {
    // Date() without new returns the current time as a string.
    if (!new.target) return new Real(Real.now() + offset).toString();
    return Reflect.construct(Real, args.length ? args : [Real.now() + offset], new.target);
  }
  Object.setPrototypeOf(ShiftedDate, Real);
  Object.defineProperty(ShiftedDate, 'prototype', { value: Real.prototype });
  Object.defineProperty(ShiftedDate, 'length', { value: Real.length });
  Object.defineProperty(ShiftedDate, 'name', { value: 'Date' });
  ShiftedDate.now = () => Real.now() + offset;
  ShiftedDate.__otsShifted = true;
  globalThis.Date = ShiftedDate;
}

if (offset) {
  shiftDate(offset);

  // Node children (the server a test starts, a script it runs) load this file too.
  const requireThis = `--require ${JSON.stringify(__filename)}`;
  if (!String(process.env.NODE_OPTIONS || '').includes(requireThis)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, requireThis].filter(Boolean).join(' ');
  }

  // Pages: every browser context Playwright creates gets the same Date before any script of the page runs, unless the
  // test drives page time with Playwright's clock.
  const testFile = process.argv[1] || '';
  let usesPlaywrightClock = false;
  try { usesPlaywrightClock = /\.clock\.\w+\(/.test(require('node:fs').readFileSync(testFile, 'utf8')); } catch (_) {}
  const pageScript = `(${shiftDate.toString()})(${offset})`;
  const Module = require('node:module');
  const load = Module._load;
  const patched = new WeakSet();
  Module._load = function (request, ...rest) {
    const mod = load.call(this, request, ...rest);
    if (!usesPlaywrightClock && (request === 'playwright' || request === 'playwright-core') && mod && !patched.has(mod)) {
      patched.add(mod);
      for (const type of [mod.chromium, mod.webkit, mod.firefox].filter(Boolean)) {
        const launch = type.launch.bind(type);
        type.launch = async (...args) => {
          const browser = await launch(...args);
          const newContext = browser.newContext.bind(browser);
          browser.newContext = async (...options) => {
            const context = await newContext(...options);
            await context.addInitScript(pageScript);
            return context;
          };
          // browser.newPage makes a context of its own that closes with the page; do the same through the shifted one.
          browser.newPage = async (...options) => {
            const context = await browser.newContext(...options);
            const page = await context.newPage();
            page.once('close', () => { context.close().catch(() => {}); });
            return page;
          };
          return browser;
        };
        const launchPersistentContext = type.launchPersistentContext.bind(type);
        type.launchPersistentContext = async (...args) => {
          const context = await launchPersistentContext(...args);
          await context.addInitScript(pageScript);
          return context;
        };
      }
    }
    return mod;
  };
}
