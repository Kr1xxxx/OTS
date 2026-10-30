#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}/.."
NATIVE="$ROOT/mac-app/native"
APP="$ROOT/mac-app/TradeOrderSystem.app"
STAGING_ROOT="$(mktemp -d "${TMPDIR:-/private/tmp}/trade-order-mac-build.XXXXXX")"
STAGING_APP="$STAGING_ROOT/TradeOrderSystem.app"
CONTENTS="$STAGING_APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
EXECUTABLE="$MACOS/TradeOrderSystem"
NODE_RUNTIME="$RESOURCES/node-runtime"
ICONSET="$STAGING_ROOT/AppIcon.iconset"
APP_VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
BUILD_VERSION="${APP_VERSION//./}"
CODE_SIGN_IDENTITY="${TRADE_CODE_SIGN_IDENTITY:--}"
cleanup() { rm -rf "$STAGING_ROOT"; }
trap cleanup EXIT

if [[ ! "$APP_VERSION" =~ '^[0-9]+\.[0-9]+$' ]]; then
  echo "VERSION 格式无效：$APP_VERSION" >&2
  exit 1
fi

NODE_SOURCE="${TRADE_NODE_SOURCE:-$(command -v node || true)}"
if [ -z "$NODE_SOURCE" ] || [ ! -x "$NODE_SOURCE" ]; then
  echo "未找到可打包的 Node.js 运行环境" >&2
  exit 1
fi

for source in \
  "$ROOT/mac-app/server.js" \
  "$ROOT/trade-order-system.html" \
  "$ROOT/trade-order-data.json" \
  "$ROOT/mac-app/AppIcon-1024.png"; do
  if [ ! -f "$source" ]; then
    echo "缺少构建源文件：$source" >&2
    exit 1
  fi
done

cd "$NATIVE"
# Layout regressions block packaging, not just an optional local check.
(cd "$ROOT" && npm run test:board-layout)
swift build -c release --product TradeOrderSystemNative

mkdir -p "$MACOS" "$RESOURCES" "$ICONSET"
install -m 755 "$NATIVE/.build/release/TradeOrderSystemNative" "$EXECUTABLE"
install -m 644 "$ROOT/mac-app/server.js" "$RESOURCES/server.js"
install -m 644 "$ROOT/mac-app/ai-usage-store.js" "$RESOURCES/ai-usage-store.js"
install -m 644 "$ROOT/mac-app/whatsapp-store.js" "$RESOURCES/whatsapp-store.js"
install -m 644 "$ROOT/mac-app/subscription-store.js" "$RESOURCES/subscription-store.js"
install -m 644 "$ROOT/mac-app/whatsapp-native-host.js" "$RESOURCES/whatsapp-native-host.js"
install -m 644 "$ROOT/trade-order-system.html" "$RESOURCES/trade-order-system.html"
install -m 644 "$ROOT/trade-order-data.json" "$RESOURCES/trade-order-data.json"

if lipo -info "$NODE_SOURCE" 2>/dev/null | grep -q "Architectures in the fat file"; then
  lipo "$NODE_SOURCE" -thin "$(uname -m)" -output "$NODE_RUNTIME"
else
  install -m 755 "$NODE_SOURCE" "$NODE_RUNTIME"
fi
chmod +x "$NODE_RUNTIME"
"$NODE_RUNTIME" -e 'require("node:sqlite")' >/dev/null

sips -z 16 16 "$ROOT/mac-app/AppIcon-1024.png" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$ROOT/mac-app/AppIcon-1024.png" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$ROOT/mac-app/AppIcon-1024.png" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$ROOT/mac-app/AppIcon-1024.png" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$ROOT/mac-app/AppIcon-1024.png" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$ROOT/mac-app/AppIcon-1024.png" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$ROOT/mac-app/AppIcon-1024.png" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$ROOT/mac-app/AppIcon-1024.png" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$ROOT/mac-app/AppIcon-1024.png" --out "$ICONSET/icon_512x512.png" >/dev/null
install -m 644 "$ROOT/mac-app/AppIcon-1024.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>外贸订单跟进系统</string>
  <key>CFBundleExecutable</key>
  <string>TradeOrderSystem</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.local.tradeordersystem</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>外贸订单跟进系统</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$APP_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUILD_VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.5</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

plutil -lint "$CONTENTS/Info.plist" >/dev/null

# The Node Foundation runtime keeps its upstream Developer ID signature. The outer
# app seal authenticates it as a nested resource. A release identity may be supplied
# with TRADE_CODE_SIGN_IDENTITY; local builds use an explicit ad-hoc signature.
if [ "$CODE_SIGN_IDENTITY" = "-" ]; then
  codesign --force --sign - --identifier com.local.tradeordersystem --timestamp=none "$STAGING_APP"
else
  codesign --force --options runtime --timestamp --sign "$CODE_SIGN_IDENTITY" --identifier com.local.tradeordersystem "$STAGING_APP"
fi
codesign --verify --deep --strict --verbose=2 "$STAGING_APP"

if [ "$CODE_SIGN_IDENTITY" != "-" ]; then
  codesign --verify --deep --strict --verbose=2 "$STAGING_APP"
  if [ "${TRADE_SKIP_GATEKEEPER:-0}" != "1" ]; then
    spctl --assess --type execute --verbose=2 "$STAGING_APP"
  fi
fi

node "$ROOT/scripts/check-release.js" --app "$STAGING_APP"

rm -rf "$APP.new"
mv "$STAGING_APP" "$APP.new"
rm -rf "$APP"
mv "$APP.new" "$APP"

echo "Mac App 已构建并验证：$APP（V$APP_VERSION）"
