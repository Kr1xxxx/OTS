# Native macOS host

Build from the project root with ./mac-app/build-native-mac-app.sh. The script compiles Swift, packages the server/frontend/synthetic seed and Node runtime, and verifies the result. Generated app output is deliberately excluded from the source archive.

Do not replace /Applications/TradeOrderSystem.app or restart a user's application without explicit deployment approval. Refer to the root README for development-data isolation, prerequisites, secrets, and notification placeholders.
