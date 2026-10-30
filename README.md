# Order Track System (OTS) V3.94

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

Every time VERSION changes on main, .github/workflows/release.yml builds the app on a macOS runner and publishes release vX.YY with two files: a .dmg for the first install and a .zip the app uses to update itself (Apple Silicon / arm64 only, because the runner bundles its own arm64 Node).

- First install: open the .dmg from the latest release and drag the app into Applications. The app is ad-hoc signed, not notarized, so macOS blocks the first launch: open System Settings → Privacy & Security and click "Open Anyway" (or run `xattr -dr com.apple.quarantine /Applications/TradeOrderSystem.app`). Updates do not need this again.
- Updates: a few seconds after launch the app checks releases/latest and, if there is a newer version, highlights the "更新" button next to the version number in the sidebar. Clicking it (or the app menu "检查更新…") installs straight away with no dialog: progress is drawn on the button while it downloads the zip, checks its SHA-256 against GitHub's asset digest, verifies the bundle id, version and code signature, and flushes pending saves; then the app quits and a small script swaps the bundle in place, reopens it and deletes the download, unpacked copy and old version (log: ~/Library/Logs/TradeOrderSystem-update.log). A failed update also deletes its temporary files. Data in Application Support is untouched.
- Publishing a new version: `npm run bump-version -- 3.90`, then `node scripts/update-export-checksums.js`, commit and merge to main. Minor numbers compare as integers, so go 3.89 → 3.90 → 3.91, never 3.9.

## Safe local development

The local server reads frontend resources from the generated app when one is built, otherwise from the repository root. Use a newly created, isolated data directory so development cannot open your production database:

```sh
OTS_DEV_DATA_DIR="$(mktemp -d /tmp/ots-development.XXXXXX)"
TRADE_APP_DATA_DIR="$OTS_DEV_DATA_DIR" TRADE_APP_PORT=47829 npm start
```

Open the startup URL printed by the server; the URL contains a local session token and must not be shared. If the port is occupied, choose a different one. Without TRADE_APP_DATA_DIR the application uses the current user's normal Application Support directory: do not run an unreviewed source export against live data.

The bundled seed contains **three synthetic demo orders**, not an empty production database. Both seed files are intentionally identical and contain only example.com email addresses; no tracking numbers are supplied.

## External services and secrets

Configure AI/logistics settings and keys through Settings. Keys remain outside source in the selected local data directory. The AI default in source is OpenRouter / DeepSeek V4.1 Flash; no claim about availability or price is made by this export. .env.example is documentation, not an automatically loaded application configuration.

Feishu's profile, display name, and destination ID have been replaced with explicit CONFIGURE placeholders in mac-app/server.js; the frontend has a generic group display name. To enable notifications in your own deployment, configure your own application identity and target group, rebuild, and approve a real test message. Every CLI operation must retain --as bot and an explicit --profile. This package does not send any real test messages.

Tests use stubs or isolated data directories. npm run test:api is an **opt-in live logistics request** and is not part of npm test. The paid live AI benchmark probe and its results are excluded. WhatsApp real-account compatibility is not established by the synthetic tests; see chrome-extension/whatsapp-sync/README.md.

## Project map

- trade-order-system.html: canonical frontend; do not edit generated app resources.
- mac-app/: local server, stores, build script and Swift native host.
- scripts/: automated regression tests and release checks.
- chrome-extension/whatsapp-sync/: Chrome extension, pinned WA-JS distribution and third-party license.
- data/demo-data.json and trade-order-data.json: synthetic seed only.
- docs/export-verification.md: scoped validation and export differences.

## Public source repository

Repository: https://github.com/Kr1xxxx/OTS . This V3.89 export continues the clean public history; it does not import any commits from the previous private repository. Only files in SOURCE_MANIFEST.txt are published. Never upload generated apps, local databases, attachments, credentials, caches, or the ZIP itself. Before future updates, review the staged diff and repeat privacy checks; .gitignore does not protect values embedded in source or tests.

## Changes since V3.88

- New 订阅 page (sidebar 管理 group, after 数据与目标) for personal subscriptions: monthly total with a rolling-digit hero, what is due in the next 30 days, category filter, in-page search, detail drawer, cancel/resume and hold-to-delete with a 6-second undo in the app toast stack, and a USD→CNY rate that only this page uses (default 7.1, edited inline in the hero).
- The page follows docs/ui-prototype/ots-ui.html and reads the app-wide design tokens, so the 配色 accent picker and dark mode apply to it as well.
- Subscriptions live in their own SQLite tables (mac-app/subscription-store.js) behind /api/subscriptions routes. They are never part of the order state, dashboard, reports, global search records, JSON export or import; SQLite backups include them.
- Charge dates clamp month-end starts (Jan 31 → Feb 28 → Mar 31), use the local calendar day, and stop at a cancelled subscription's end date.

## Changes since V3.85

- Recover contact email literals when AI extraction omits them, without mixing identified payment emails into contact fields or saving automatically.
- Show complete summary monetary values with one fractional digit across the dashboard, reports, targets, analysis and customer summaries; support narrow layouts without clipping.
- Use the shorter order-count caption. Individual order amounts, stored values, exchange rates and AI-cost precision are unchanged.
- This is the HTML/JavaScript application with a Swift native host, not the separate unfinished SwiftUI rewrite.

## Licensing

Publication is authorized by the owner, but no open-source license is granted for project-owned code by this export. Bundled third-party code retains its upstream license; see THIRD_PARTY_NOTICES.md.
