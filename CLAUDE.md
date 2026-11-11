# OTS engineering notes

Local macOS trade-order app. Three parts that ship together:

- `trade-order-system.html`: the whole frontend (CSS, markup, one large inline script). Canonical; never edit the copy inside a built app.
- `mac-app/server.js` plus the stores next to it: local HTTP server on loopback, SQLite through `node:sqlite`.
- `mac-app/native/`: Swift host (WKWebView window, starts the bundled Node, in-app updater).

The repository is public. Business data, attachments, backups, settings files and API keys never go into Git, tests or fixtures; use made-up values.

## Finding code in the page

`grep -n '^// #region' trade-order-system.html` lists the sections of the main script, about fifty, with their line numbers. Read the section, not the file. New code goes into the section it belongs to; a new section gets its own `// #region Name` and `// #endregion` lines (`npm run check` fails when they do not pair up).

The page stays one file on purpose. Splitting it into source files would put a build step in front of every test, the lint and the app build, and the gain would be navigation only: the scripts would still share one global scope, and Git already merges changes to different parts of one file.

## Before pushing

```sh
npm run lint    # ESLint over mac-app, scripts, the extension and every inline script of the page
npm run check   # version numbers agree, required files exist
npm test        # every scripts/test-*.js; set OTS_TEST_CONCURRENCY=2 on a small machine
```

The lint has no warnings level worth keeping: a finding is fixed or the rule is off. An unused top-level function in the page is dead code and fails the lint; the allowlist in `eslint.config.js` is only for entry points called from outside the page (the Swift host, tests).

## Rules that are easy to break

- The app runs in WebKit (WKWebView); every UI test in `npm test` runs in Chromium, and `npm run test:webkit` only simulates WebKit's focus behaviour inside Chromium. The one check in the real window is `scripts/smoke-test-real-app.js` (macOS CI and before every release): the built app starts and its page reports in. It does not show that focus, IME, selection, drag or downloads work.
- The page saves by posting the whole state to `/api/save` with `baseRevision` and `saveId`. A 409 means another window saved first; the page merges and retries. Do not add a second write path for order or customer data.
- An update counts as installed only when the page posts `appBooted` (last statement of the main script plus the first draw from the database, see `reportAppBooted`); otherwise the installer rolls back after 120 s. Keep `appScriptCompleted = true; reportAppBooted();` as the last statements of the main script.
- Functions the Swift host calls by name must keep their names: `otsFlushBeforeQuit`, `flushPendingSave`, `otsBackupBeforeUpdate`, `otsUnsavedForms`, `nativeDialog`, `otsAppUpdateStatus`, `uiToast`, `setPage`, `otsUiZoomChanged`.
- Many tests pull a function out of the HTML by name and run it in `vm`. Renaming or moving a function means updating those tests in the same change.
- Tests must not depend on the current version number or on wall-clock dates.
- Server tests take a free port from `scripts/helpers/free-port.js`; never a fixed one.
- `.node-version` is the Node the released app bundles and the Node CI runs. Changing it makes every user download the full update once instead of the small one; do it on purpose.

## Versions and releases

- A pull request never changes `VERSION`. Several threads of work are open at once, and numbers claimed in branches collided.
- A change that should reach the installed app adds one file to `release-notes/next/` (see the README there): one to three short lines in Chinese on what the user will notice. The app shows them in the "发现新版本" dialog.
- After the merge, once CI has passed on main, the release workflow takes the next number (`scripts/prepare-release.js`), commits "Release V3.NN" to main as `github-actions[bot]`, builds and publishes. Pull main before continuing work: that commit is on it.
- A change that needs no release (tooling, tests, docs) adds no note, and nothing is published.
- If a release build fails after the number was taken, re-run the failed job of that workflow run (or run the Release workflow by hand on main); do not bump again.

## Ask the owner first

- Changes to how the app looks (the UI spec is the reference for every dialog).
- Changes to business rules: stages, payments, what counts as paid.
