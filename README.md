# Order Track System (OTS) V3.160

Local macOS trade-order and customer management, SQLite storage, logistics/AI helpers, and the KME WhatsApp customer-sync Chrome extension. This is a privacy-sanitized **source export**, not a production database or installed application.

## Requirements

- macOS 13.5 or later; Xcode command-line tools with Swift 6.0 or later.
- Node.js 22.5 or later with node:sqlite; npm.
- Python 3 with Pillow for the icon regression test.
- Chromium via Playwright for isolated UI tests.

## Build and verify

Run from this directory:

```sh
npm ci
npm run test:install-browser
./mac-app/build-native-mac-app.sh
npm test
node scripts/check-release.js --app mac-app/TradeOrderSystem.app
```

npm test runs every regression script, in parallel where safe, and prints a summary of all passes and failures; pass a name fragment to run a subset (for example node scripts/run-tests.js whatsapp). It also works on a clean checkout without a build: the server then reads the frontend and seed from the repository root. macOS-only checks (icon, Swift) are reported as skipped on other systems. GitHub Actions runs the suite on Linux and, with the native build, on macOS.

The build runs the board-layout gate, compiles the native host, bundles Node, and verifies an ad-hoc signature. It does **not** install or restart the application. This is a local build, not a notarized distribution. On a clean Mac install Pillow in an appropriate Python environment before testing.

## Install and update (GitHub Releases)

Every time a merged change left a note in release-notes/next/ and CI has passed for that commit on main, .github/workflows/release.yml takes the next version number, builds the app on a macOS runner, starts the packaged server once (scripts/smoke-test-app-bundle.js: /api/health and a page load) and publishes release vX.YY with two files: a .dmg for the first install and a .zip the app uses to update itself (Apple Silicon / arm64 only, because the runner bundles its own arm64 Node).

- First install: open the .dmg from the latest release and drag the app into Applications. The app is ad-hoc signed, not notarized, so macOS blocks the first launch: open System Settings → Privacy & Security and click "Open Anyway" (or run `xattr -dr com.apple.quarantine /Applications/TradeOrderSystem.app`). Updates do not need this again.
- Updates: a few seconds after launch (and again every few hours while the app stays open) the app checks releases/latest and, if there is a newer version, marks the "更新" button next to the version number in the sidebar ("有更新"). Clicking it, the bell card, or the app menu "检查更新…" first stops if a form has unsaved changes, then asks once ("现在安装并重启 / 以后再说", with the release notes). Installing draws progress on the button while it downloads the zip, checks its SHA-256 against GitHub's asset digest, verifies the bundle id, version and code signature, flushes pending saves and makes a database backup labelled 安装更新前; then the app quits and a small script swaps the bundle in place and reopens it. The old version is deleted only after the new one has loaded its page; if it has not within 120 seconds, the script stops it, puts the old version back, reopens it, and the old version explains what happened (log: ~/Library/Logs/TradeOrderSystem-update.log). A failed update also deletes its temporary files. Data in Application Support is untouched.
- Publishing a new version: a pull request adds a short note under release-notes/next/ and leaves VERSION alone. After the merge, when CI has passed on main, the release workflow takes the next number, commits it and publishes (scripts/prepare-release.js). Minor numbers compare as integers: 3.89 → 3.90 → 3.91, never 3.9.

## Safe local development

The local server reads frontend resources from the generated app when one is built, otherwise from the repository root. Use a newly created, isolated data directory so development cannot open your production database:

```sh
OTS_DEV_DATA_DIR="$(mktemp -d /tmp/ots-development.XXXXXX)"
TRADE_APP_DATA_DIR="$OTS_DEV_DATA_DIR" TRADE_APP_PORT=47829 npm start
```

Open the startup URL printed by the server; the URL contains a local session token and must not be shared. If the port is occupied, choose a different one. Without TRADE_APP_DATA_DIR the application uses the current user's normal Application Support directory: do not run an unreviewed source export against live data.

In browser mode the API token lives only in the tab that opened the startup URL (it is handed over in the `#` part of the redirect and kept in that tab's sessionStorage). The session cookie can load the page and attachment images but cannot call any `/api/*` route, and requests sent from other sites or other ports on 127.0.0.1 (`Sec-Fetch-Site: same-site` / `cross-site`) are refused. A tab opened by hand without the startup URL cannot load data; open the startup URL again. Even so, avoid opening untrusted local services in the same browser while OTS runs; for daily use prefer the Mac app.

The bundled seed contains **three synthetic demo orders**, not an empty production database. Both seed files are intentionally identical and contain only example.com email addresses; no tracking numbers are supplied.

## External services and secrets

Configure AI/logistics settings and keys through Settings. Keys remain outside source in the selected local data directory. The AI default in source is OpenRouter / DeepSeek V4.1 Flash; no claim about availability or price is made by this export. .env.example is documentation, not an automatically loaded application configuration.

Feishu notifications read the existing CLI profile name, group display label and target group ID from the independent local `feishu-settings.json` file in Application Support. Credentials remain in the CLI profile. See [local configuration](docs/feishu-local-configuration.md). The file is never bundled or published; compatible updates retain it, and the updater blocks incompatible packages when it exists. Every CLI operation retains `--as bot` and an explicit `--profile`. Tests do not send real group messages.

Tests use stubs or isolated data directories. npm run test:api is an **opt-in live logistics request** and is not part of npm test. The paid live AI benchmark probe and its results are excluded. WhatsApp real-account compatibility is not established by the synthetic tests; see chrome-extension/whatsapp-sync/README.md.

## Project map

- trade-order-system.html: canonical frontend; do not edit generated app resources.
- mac-app/: local server, stores, build script and Swift native host.
- scripts/: automated regression tests and release checks.
- chrome-extension/whatsapp-sync/: Chrome extension, pinned WA-JS distribution and third-party license.
- data/demo-data.json and trade-order-data.json: synthetic seed only.

## Public source repository

Repository: https://github.com/Kr1xxxx/OTS . This repository is public and is the only source of the app. Never upload generated apps, local databases, attachments, credentials, caches, or the ZIP itself. Before future updates, review the staged diff and repeat privacy checks; .gitignore does not protect values embedded in source or tests.

## Changes since V3.88

- New 续费 page (formerly 订阅; VPS, domains, software memberships) (sidebar 管理 group, after 数据与目标) for personal subscriptions: monthly total with a rolling-digit hero, what is due in the next 30 days, category filter, in-page search, detail drawer, cancel/resume and hold-to-delete with a 6-second undo in the app toast stack, and a USD→CNY rate that only this page uses (default 7.1, edited inline in the hero).
- The page follows docs/ui-prototype/ots-ui.html and reads the app-wide design tokens, so the 配色 accent picker and dark mode apply to it as well.
- Subscriptions live in their own SQLite tables (mac-app/subscription-store.js) behind /api/subscriptions routes. They are never part of the order state, dashboard, reports, global search records, JSON export or import; SQLite backups include them.
- Mac backups (SQLite + attachments) keep every backup from the last 48 hours, one per day for 30 days and one per week for 12 weeks; snapshots taken before an import, a demo reset, a restore or a customer merge are kept 90 days. Settings → 数据管理 →「从备份恢复…」previews a backup against the current data and restores it after backing up the current data first. A missing attachment no longer blocks a backup; it is listed in `<backup>.missing.json`. Every backup has its own complete attachments folder, but a file the previous backup already holds is not written again: it is cloned (same APFS volume) or hard-linked to the previous backup's copy, and only new files are copied (mac-app/backup-attachments.js).
- Charge dates clamp month-end starts (Jan 31 → Feb 28 → Mar 31), use the local calendar day, and stop at a cancelled subscription's end date.

## Changes since V3.85

- Recover contact email literals when AI extraction omits them, without mixing identified payment emails into contact fields or saving automatically.
- Show complete summary monetary values with one fractional digit across the dashboard, reports, targets, analysis and customer summaries; support narrow layouts without clipping.
- Use the shorter order-count caption. Individual order amounts, stored values, exchange rates and AI-cost precision are unchanged.
- This is the HTML/JavaScript application with a Swift native host, not the separate unfinished SwiftUI rewrite.

## Licensing

Publication is authorized by the owner, but no open-source license is granted for project-owned code by this export. Bundled third-party code retains its upstream license; see THIRD_PARTY_NOTICES.md.
