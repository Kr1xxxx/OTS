# Local Feishu notification configuration

Order notifications read `~/Library/Application Support/TradeOrderSystem/feishu-settings.json`. This file is local deployment data; it must never be bundled, committed or uploaded. Application replacement preserves it because it is outside the app bundle. Bot credentials continue to live in the existing lark-cli profile, not this file.

The JSON object contains three strings: `profile` (the existing CLI profile name), `chatName` (the group display label), and `chatId` (the group's oc_ identifier). Create it with owner-only permissions (0600) and restart OTS after changing it. Missing or malformed settings disable notifications with a clear error while order storage remains available. Notifications always run with an explicit profile and `--as bot`.

New releases declare `OTSFeishuSettingsVersion = 1` in Info.plist and bundle `feishu-settings.js`. The updater refuses a release without this support when a local settings file exists, before quitting or replacing the current application. Compatible releases keep normal updates; a user without local Feishu configuration does not gain this update restriction. This gate prevents older public packages from silently reconnecting to placeholder settings; future release builds must retain the reader and metadata.

Automated notification tests use a fake CLI and synthetic group/profile data. They cover app replacement with the same independent settings directory, missing configuration, exact bot identity, image messages, idempotency and controlled retry. They do not send real group messages.
