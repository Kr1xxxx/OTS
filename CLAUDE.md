# OTS engineering notes

Local macOS trade-order app. Three parts that ship together:

- `trade-order-system.html`: the whole frontend (CSS, markup, one large inline script). Canonical; never edit the copy inside a built app.
- `mac-app/server.js` plus the stores next to it: local HTTP server on loopback, SQLite through `node:sqlite`.
- `mac-app/native/`: Swift host (WKWebView window, starts the bundled Node, in-app updater).

The repository is public. Business data, attachments, backups, settings files and API keys never go into Git, tests or fixtures; use made-up values.

## Before pushing

```sh
npm run lint    # ESLint over mac-app, scripts, the extension and every inline script of the page
npm run check   # version numbers agree, required files exist
npm test        # every scripts/test-*.js; set OTS_TEST_CONCURRENCY=2 on a small machine
```

The lint has no warnings level worth keeping: a finding is fixed or the rule is off. An unused top-level function in the page is dead code and fails the lint; the allowlist in `eslint.config.js` is only for entry points called from outside the page (the Swift host, tests).

## Rules that are easy to break

- The app runs in WebKit (WKWebView); every UI test runs in Chromium, and `npm run test:webkit` only simulates WebKit's focus behaviour inside Chromium. A green test run does not show that focus, IME, selection, drag or downloads work in the real app.
- The page saves by posting the whole state to `/api/save` with `baseRevision` and `saveId`. A 409 means another window saved first; the page merges and retries. Do not add a second write path for order or customer data.
- Functions the Swift host calls by name must keep their names: `otsFlushBeforeQuit`, `flushPendingSave`, `otsBackupBeforeUpdate`, `otsUnsavedForms`, `nativeDialog`, `otsAppUpdateStatus`, `uiToast`, `setPage`, `otsUiZoomChanged`.
- Many tests pull a function out of the HTML by name and run it in `vm`. Renaming or moving a function means updating those tests in the same change.
- Tests must not depend on the current version number or on wall-clock dates.
- Server tests take a free port from `scripts/helpers/free-port.js`; never a fixed one.
- `.node-version` is the Node the released app bundles and the Node CI runs. Changing it makes every user download the full update once instead of the small one; do it on purpose.

## Versions and releases

- `npm run bump-version -- 3.NN` updates every file that carries the version. Minor numbers compare as integers (3.99 → 3.100).
- A merge to main that changes `VERSION` is released automatically once CI passes on main. A change that needs no release (tooling, tests, docs) leaves `VERSION` alone.
- Several threads of work can be open at once: take the next free version from main just before merging, not when starting.

## Ask the owner first

- Changes to how the app looks (the UI spec is the reference for every dialog).
- Changes to business rules: stages, payments, what counts as paid.
