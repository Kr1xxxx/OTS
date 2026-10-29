# Source-export verification — 2026-10-29

## Scope

Owner-authorized publication of formal V3.88 source to the existing clean public OTS history. This is the HTML/JavaScript application with its Swift native host, not the separate unfinished SwiftUI rewrite. No production installation, restart, real notification, live logistics request or paid AI request was performed.

## Curated source and privacy transformations

The 87-entry allowlist includes maintained application source, assets, pinned third-party code, regression tests, documentation and synthetic demo seeds. It excludes databases, attachments, backups, secrets/settings files, logs, generated applications, build/dependency directories, old copies, private history, live benchmarks and local audit/OpenSpec tooling.

The prior public synthetic fixtures are retained. Current V3.88 frontend, version/package metadata, dashboard regression and new email/summary regressions are included. Reviewed frontend differences from production are only a fictional UK phone example and a generic notification-group placeholder. Backend notification profile and destination remain explicit configuration placeholders. The two JSON seeds are identical synthetic examples, not production data.

Canonical source and installed application files were hashed before export work and checked unchanged afterward. Export preparation does not modify historical customer/order records or implement new production behavior.

## Local privacy comparison

A read-only SQLite connection compared 35 customer records and 58 order records, deriving 311 distinct personal/order values. The comparison covered names, contacts, emails, formatted phone variants, addresses, tracking/order/chat identifiers and longer notes/filenames. Values remain local and are not included in this export or its audit output.

No unresolved matches remained. One exact match inside the pinned third-party bundle was reviewed as an unrelated MIME-type substring, not customer data. Its upstream checksum remains unchanged. Canonical synthetic seed matches were separately attributed to the existing example datasets, not live business records.

Credential-pattern and literal review found no unresolved candidates. Two short fixed unit-test dummy inputs exercise local settings/masking or ledger filtering, not authentication requests. The Chrome extension manifest key is public extension identity material, not a private credential. No actual key file was read for comparison. Non-example email-pattern hits were reviewed as WhatsApp protocol suffixes and icon filenames, not mailboxes.

These checks reduce risk; they are not proof against every unknown credential format or identifying value absent from the current database.

## Local verification results

- Pinned development dependencies installed with npm ci --ignore-scripts.
- Missing pinned Playwright Chromium was installed into the test browser cache; no daily browser profile or native messaging registration was modified.
- Native production build passed before full tests; strict ad-hoc signature and source/package release checks passed for V3.88.
- Full npm test passed, including recognition/email recovery, financial summary precision/responsiveness, isolated extension integration, SQLite migration/save/backup/reload, server authentication/CAS/recovery, native runtime policy, form saves and board layout.
- The first full run hit a pre-existing timing-sensitive retry assertion (0.1 seconds versus an exact 0.0-second expectation). The unchanged test passed in isolation and the subsequent complete run passed. No production timer change or assertion relaxation was made.
- WA-JS remains version 4.5.0 and matches its declared SHA-256.

The production application was not launched or replaced by this work. Passing export tests does not establish new installed-app UI acceptance, real-account WhatsApp compatibility, external API availability or Apple notarization. Existing heuristic-only parser edge cases are not repaired by source synchronization; extraction previews still require review.

## Publication integrity

Only SOURCE_MANIFEST.txt entries are eligible for publication. EXPORT_CHECKSUMS.sha256 covers every listed file except itself. Generated apps and all local tooling remain excluded. Publication must fast-forward the current public main branch without importing the old private history, then verify remote version, file list and bytes from an independent public download before local synchronization state is reset.
