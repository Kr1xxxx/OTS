# OTS engineering notes

Local macOS trade-order app. Three parts that ship together:

- `trade-order-system.html`: the whole frontend (CSS, markup, one large inline script). Canonical; never edit the copy inside a built app.
- `mac-app/server.js` plus the modules next to it: local HTTP server on loopback, SQLite through `node:sqlite`. Every `.js` directly in `mac-app/` ships in the app; a server module loads only Node built-ins and `./` siblings (`npm run check` enforces it). New server code that does not need the server's own state goes into a module, and its tests `require` it instead of cutting functions out of `server.js`.
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

The lint has no warnings level worth keeping: a finding is fixed or the rule is off. An unused top-level function in the page is dead code and fails the lint; the allowlist in `eslint.config.js` holds `nativeDialog` only, which the Swift host calls. A function kept alive for a test is still dead code: the test calls what the page calls.

A change to the page's styles that must not change how anything looks (tidying, merging, deleting rules) is checked with `node scripts/css-snapshot.js --base origin/main`: it compares the computed style of every element in about a thousand states (pages, dialogs, both themes, accents, widths, hover and focus) between main and the working tree, in Chromium only, and must report nothing. `--quick` runs the two themes at 1440 px.

## Rules that are easy to break

- The app runs in WebKit (WKWebView). `npm test` runs every UI test in Chromium; the `test-webkit` job in CI runs the tests that open a browser once more in Playwright's WebKit on macOS (`OTS_TEST_BROWSER=webkit npm test`, macOS only). A test has to pass in both. A difference is either a fault of the page in the app's engine, which gets fixed, or a Chromium habit in the test, which gets corrected; `notInWebkit` in `scripts/run-tests.js` is only for tests that cannot run there at all. `npm run test:webkit` is older and imitates WebKit's focus behaviour inside Chromium. None of this is the app's window: the one check there is `scripts/smoke-test-real-app.js` (macOS CI and before every release), where the built app starts and its page reports in. It does not show that the system input method, drags from other apps or downloads work.
- The page saves by posting the whole state to `/api/save` with `baseRevision` and `saveId`. A 409 means another window saved first; the page merges and retries. Do not add a second write path for order or customer data.
- A customer profile has a fixed `id`, and each order of that customer carries it as `customerId` (`mac-app/customer-ids.js`). The name is still the key everywhere: `state.customers`, `order.client`, the customers table, the WhatsApp chats. The id only says who is who: the server reads a rename as "the same id under another name" and moves the chats. The page fills both fields in `ensureCustomerIds()` right before a save, so nothing else has to write them, but code that builds a profile from scratch has to carry `id` over from the profile it replaces (`buildCustomerSavePayload` does); without it the customer arrives as a new one and a rename leaves its chats behind. A database from before ids gets them from the server at the first start, after a backup named `-before-migrate`; when that backup cannot be made the data stays as it is, and the page, which then reads profiles without ids, does not fill them either (`customerIdsInDatabase`).
- The save engine's state is declared in one section of the page, "Save engine state and phases", with the list of phases. `macStorageMode` is one of `loading`, `ready`, `load-failed`, `conflict` and changes only through `macSetStorageMode()`; every successful save ends in `macSaveSettled()`. Ask `macSavePhase()`, `macIsReadOnly()` or `macStorageMode` instead of combining variables, and do not add another boolean for a new case: it is either a phase or it is not state. `scripts/test-save-phases-ui.js` walks every phase.
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
- A "Release V3.NN" commit on main only says the number was taken, not that the version shipped. The thread that merged the PR with the release note says "V3.NN 已发布" only once `releases/latest` has the tag `v3.NN` (or the `gate` and `mac` jobs of that Release run are green). A failed run opens an issue "V3.NN 发版失败" assigned to the owner, and the next successful publish of that version closes it.
- If a release build fails after the number was taken, re-run the failed job of that workflow run (or run the Release workflow by hand on main); do not bump again. If the re-run fails too, find the cause before trying again.

## Ask the owner first

- Changes to how the app looks (the UI spec is the reference for every dialog).
- Changes to business rules: stages, payments, what counts as paid.
