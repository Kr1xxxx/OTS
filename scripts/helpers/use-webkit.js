// Preloaded into every test process by scripts/run-tests.js when OTS_TEST_BROWSER=webkit (node --require).
//
// The app runs in WKWebView and the UI tests ask Playwright for Chromium. With this loaded the same tests get
// Playwright's WebKit: on macOS that is WebKit's Mac port, so the page's JavaScript, layout, DOM and focus rules
// (a clicked button does not take focus, for one) are the app's engine and not Chromium's. No test file changes.
//
// What it is not: the app's window. The Swift host, downloads and the system input method are not part of it;
// scripts/smoke-test-real-app.js is the check that starts the real one.
const playwright = require('playwright');

const { chromium, webkit } = playwright;

// Chromium-only launch options (executablePath, channel, args) mean nothing to WebKit.
chromium.launch = (options = {}) => webkit.launch({ headless: options.headless !== false });

// A request the page starts while it is on its way out (the last moments before a reload or a navigation replaces
// it, or in pagehide / unload) is not a page error. WebKit refuses it and writes
// "Fetch API cannot load <url> due to access control checks." to the console, and Playwright's WebKit hands every
// console error that comes from JavaScript to the test as a 'pageerror' (Chromium reports nothing there).
// Tests expect no page errors, and the page has timers that ask the server again, so a test that reloaded just
// then failed now and then (test-order-list-density-ui, test-followup-tasks-ui, test-dashboard-layout-ui).
// The line is dropped here, for every test at once. An exception the page throws, and a rejection nobody handles,
// still arrive: those are other messages. scripts/test-cancelled-fetch-page-error-ui.js checks both, and fails
// when WebKit stops reporting the line, which is when this block can go.
const isCutOffRequest = error => /^Fetch API cannot load https?$/.test(error?.name || '') && / due to access control checks\.$/.test(error?.message || '');
const factories = playwright._connection?._objectFactories;
const makePage = factories?.get?.('Page');
if (typeof makePage === 'function') {
  let patched = false;
  factories.set('Page', (...args) => {
    const page = makePage(...args);
    if (!patched) {
      patched = true;
      const proto = Object.getPrototypeOf(page);
      const emit = proto.emit;
      proto.emit = function (event, ...rest) {
        if (event === 'pageerror' && isCutOffRequest(rest[0])) return false;
        return emit.call(this, event, ...rest);
      };
    }
    return page;
  });
} else {
  // A Playwright update moved the internals: say so instead of silently testing without it.
  console.warn('[use-webkit] Playwright internals changed; cut-off requests are reported as page errors');
}

// A test that starts another script which opens a browser (scripts/smoke-test-app-bundle.js) gets WebKit there too.
const requireThis = `--require ${JSON.stringify(__filename)}`;
if (!String(process.env.NODE_OPTIONS || '').includes(requireThis)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, requireThis].filter(Boolean).join(' ');
}
