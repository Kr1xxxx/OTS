# Export verification — 2026-10-10

## Scope

Preparation of a fresh-history public V3.85 source repository, authorized by the owner. The previous repository remains private. No deployment, installation, restart, live message or paid API call is performed.

## Additional privacy review

The earlier private export missed a customer name and a tracking identifier embedded in regression tests. Both have been replaced with synthetic samples in this public export; no old commit history is imported. Additional test order numbers overlapping real order numbers were also replaced. The new export was compared locally against 32 current customer records and 47 order records: 222 distinct identifiers/text values, including names, contacts, emails, phone format variants, addresses, tracking identifiers, order numbers and long notes. No remaining matches were found. A reviewed vendor MIME-type substring is unrelated to customer data; pinned vendor code remains unchanged. Private comparison values and the database are never included in the package or audit output. Pattern checks supplement this comparison; they do not constitute proof against every possible identifying format or historical data no longer present in the current database.

## Privacy transformations (export copies only)

- Whitelisted maintained source, offline regression tests, assets and pinned third-party code.
- Replaced customer-derived names, non-example email, phone variants and address fixtures with synthetic examples; input and expected values transformed together.
- Replaced notification profile/group/destination with explicit placeholders.
- Replaced production/legacy seed with the existing synthetic demo dataset, without logistics identifiers; order prefix uses K.
- Replaced outdated environment example/docs, added comprehensive ignore rules and retained upstream licensing.
- Omitted obsolete copies, business-data JSON, .app files, caches/dependencies, backups, historical handoffs/design/benchmark reports and the live AI benchmark script.

These transformations do not modify canonical source or existing customer data. The export is not byte-identical to the production frontend/server because identifying placeholders were sanitized. Before installation, review deployment configuration and use the original production dataset separately; never import synthetic demo data into production.

## Results

Canonical source: full npm test passed on 2026-10-08; its 74 maintained source-file hashes were rechecked unchanged on 2026-10-10. The public export retains the same V3.85 software version.
Sanitized export: npm ci completed (npm reported zero dependency vulnerabilities), focused recognition/search tests and full npm test passed. Native production build, strict ad-hoc signature and source/bundle release consistency checks passed. Tests exercised isolated UI layouts, SQLite migration/save/backup/reload, authentication/CAS/limits, notification stubs and AI usage accounting; no real external message/API test was sent.

Fresh public export on 2026-10-10: the full npm test suite, native production build/signature and source/bundle release check passed again, using the existing pinned test dependencies. The build was performed before the final full test run as required for bundled-resource tests. The five modified test fixtures were exercised by that run; only test samples and export documentation changed. Generated app and Swift build outputs are excluded from publication.

The final ZIP is assembled from an explicit source manifest, not a directory-wide archive. Every entry is checked after ZIP creation against its pre-archive bytes; SHA-256 sums are supplied. Original maintained source files are checked against their initial hashes to ensure export work did not change them.

Privacy checks: no unresolved credential-pattern candidates, Clipbox secret references, private-key blocks, absolute user-home paths or original notification destination remain in the curated entries. The one API-key-like literal is the verified synthetic `TEST_ONLY_NOT_A_REAL_KEY` fixture. The Chrome manifest key is a public extension-ID key, not a credential. Pinned WA-JS remains byte-for-byte unchanged and its SHA-256 matches SOURCE.json.

Installed application version was read as V3.84. It was not replaced or restarted; successful V3.85 source/export checks do not establish a V3.85 production deployment.

## Non-blocking finding in the existing local fallback parser

A synthetic regression probe using `Jordan M` followed by a valid US street/city/state/postcode returned the address and country but omitted the customer name. This was reproduced against unchanged canonical source: a name containing a country word can be filtered too aggressively by the local heuristic parser. The current AI-first path was not exercised by this probe. It is an existing edge case, not an export regression; no behavioral fix was made as part of this read-only audit. Review the preview or use AI recognition for this class of input until a separately approved fix is verified.

Scope limitation: automated pattern checks and a curated file review reduce exposure; they are not a formal proof that every possible personal identifier or credential format has been detected. Real WhatsApp account, external API availability, production notifications and installed-app acceptance were not tested.
