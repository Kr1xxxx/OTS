// Preloaded into every test process by scripts/run-tests.js when OTS_TEST_BROWSER=webkit (node --require).
//
// The app runs in WKWebView and the UI tests ask Playwright for Chromium. With this loaded the same tests get
// Playwright's WebKit: on macOS that is WebKit's Mac port, so the page's JavaScript, layout, DOM and focus rules
// (a clicked button does not take focus, for one) are the app's engine and not Chromium's. No test file changes.
//
// What it is not: the app's window. The Swift host, downloads and the system input method are not part of it;
// scripts/smoke-test-real-app.js is the check that starts the real one.
const { chromium, webkit } = require('playwright');

// Chromium-only launch options (executablePath, channel, args) mean nothing to WebKit.
chromium.launch = (options = {}) => webkit.launch({ headless: options.headless !== false });
