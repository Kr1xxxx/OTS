#!/bin/zsh
set -euo pipefail
resources='/Applications/TradeOrderSystem.app/Contents/Resources'
if [[ ! -f "$resources/whatsapp-native-host.js" || ! -x "$resources/node-runtime" ]]; then
  print '请先安装外贸订单跟进系统 V3.73 或更新版本，再运行本文件。'
  exit 1
fi
"$resources/node-runtime" -e '
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const helper = path.join(os.homedir(), "Library", "Application Support", "TradeOrderSystem", "whatsapp-sync");
const manifestDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
fs.mkdirSync(helper, {recursive:true, mode:0o700});
fs.mkdirSync(manifestDir, {recursive:true});
const launcher = path.join(helper, "launch-host.sh");
fs.writeFileSync(launcher, "#!/bin/sh\nexec /Applications/TradeOrderSystem.app/Contents/Resources/node-runtime /Applications/TradeOrderSystem.app/Contents/Resources/whatsapp-native-host.js\n", {mode:0o700});
const manifest = { name:"com.tradeordersystem.whatsapp", description:"Trade Order System WhatsApp Sync", path:launcher, type:"stdio", allowed_origins:["chrome-extension://kngglcbmpjeldcidpdmgofbmjklcaglh/"] };
fs.writeFileSync(path.join(manifestDir, "com.tradeordersystem.whatsapp.json"), JSON.stringify(manifest, null, 2), {mode:0o600});
console.log("本机连接助手已配置。下一步：Chrome 打开 chrome://extensions，开启开发者模式，加载本文件所在的文件夹。");
'
