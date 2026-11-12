#!/bin/zsh
# Packages a built app for GitHub Releases and proves the small update package works.
# Usage: scripts/package-mac-release.sh <TradeOrderSystem.app> <out-dir> <version> [--dmg]
#   TradeOrderSystem-<v>-mac-<arch>.zip        full app (first install fallback, older updaters)
#   TradeOrderSystem-<v>-mac-<arch>-lite.zip   same app without Resources/node-runtime (~2 MB);
#                                              V3.142+ updaters copy their own runtime in when
#                                              Info.plist OTSNodeRuntimeSHA256 matches
#   *.zip.sha256                               checksums for the release-page fallback
#   TradeOrderSystem-<v>-mac-<arch>.dmg        with --dmg
set -euo pipefail

APP="${1:?app path}"; OUT="${2:?output dir}"; VERSION="${3:?version}"; DMG="${4:-}"
ARCH="$(uname -m)"
ZIP="$OUT/TradeOrderSystem-$VERSION-mac-$ARCH.zip"
LITE="$OUT/TradeOrderSystem-$VERSION-mac-$ARCH-lite.zip"
WORK="$(mktemp -d "${TMPDIR:-/private/tmp}/ots-package.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
mkdir -p "$WORK/lite"
ditto "$APP" "$WORK/lite/TradeOrderSystem.app"
rm "$WORK/lite/TradeOrderSystem.app/Contents/Resources/node-runtime"
ditto -c -k --sequesterRsrc --keepParent "$WORK/lite/TradeOrderSystem.app" "$LITE"
for file in "$ZIP" "$LITE"; do
  (cd "$OUT" && shasum -a 256 "$(basename "$file")" > "$(basename "$file").sha256")
done

# Rebuild the app from the small zip exactly as AppUpdater does and require the same bundle.
mkdir -p "$WORK/check"
ditto -x -k "$LITE" "$WORK/check"
CHECK_APP="$WORK/check/TradeOrderSystem.app"
RUNTIME="$APP/Contents/Resources/node-runtime"
EXPECTED="$(/usr/libexec/PlistBuddy -c 'Print :OTSNodeRuntimeSHA256' "$CHECK_APP/Contents/Info.plist")"
ACTUAL="$(shasum -a 256 "$RUNTIME" | cut -d' ' -f1)"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "OTSNodeRuntimeSHA256 ($EXPECTED) does not match node-runtime ($ACTUAL)" >&2
  exit 1
fi
ditto --noextattr --norsrc "$RUNTIME" "$CHECK_APP/Contents/Resources/node-runtime"
codesign --verify --deep --strict "$CHECK_APP"
diff -r "$APP" "$CHECK_APP"
echo "Small update package rebuilds the same signed app."

if [ "$DMG" = "--dmg" ]; then
  mkdir -p "$WORK/dmg-root"
  ditto "$APP" "$WORK/dmg-root/TradeOrderSystem.app"
  ln -s /Applications "$WORK/dmg-root/Applications"
  # Give the image a size instead of letting hdiutil estimate one from -srcfolder: Release run 77
  # (V3.155) failed with "No space left on device" inside /Volumes/<volume>/ because the estimate
  # was too small for the app. -size overrides the estimate (man hdiutil, -srcfolder); the margin
  # covers HFS+ overhead. UDZO compresses the free space away, so the dmg does not grow.
  SIZE_MB=$(( $(du -sm "$WORK/dmg-root" | cut -f1) * 11 / 10 + 64 ))
  hdiutil create -volname "外贸订单跟进系统 V$VERSION" -srcfolder "$WORK/dmg-root" \
    -size "${SIZE_MB}m" -fs HFS+ -ov -format UDZO \
    "$OUT/TradeOrderSystem-$VERSION-mac-$ARCH.dmg"
fi
ls -lh "$OUT"
