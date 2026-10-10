# KME WhatsApp 客户同步 0.2.0

适用：本机 Chrome 111 或更新版本 + WhatsApp Web + 外贸订单跟进系统 V3.73 或更新版本。

## 安装

1. 安装新版外贸订单跟进系统并打开一次。
2. 双击本目录的 `install-mac.command`，注册仅允许此插件访问的本机连接助手。
3. Chrome 地址栏打开 `chrome://extensions`，打开“开发者模式”，点“加载已解压的扩展程序”，选择包含 manifest.json 的本目录。
4. 刷新 WhatsApp 网页。右下角出现“客户同步”。

如 macOS 阻止运行，请在终端执行 `zsh `（末尾空格），将 `install-mac.command` 拖进终端后回车。无需管理员权限。

## 使用

打开客户单人聊天 → 点“客户同步” → 等待显示“WA-JS 已连接” → 检测本机连接。账号由当前 WhatsApp 登录状态自动读取，无需手填。

完整号码唯一匹配时会推荐客户；仍需点“确认关联此客户”。没有号码或有多个同号客户时，输入客户姓名查找并选择。客户须先在订单系统建档。

确认后可手动同步，也可勾选“自动同步这个聊天”。每个聊天单独控制。到订单系统客户详情展开“WhatsApp 聊天记录”，即可读取；保持详情打开时可点“刷新记录”。

## 范围与限制

- 只同步当前已打开、网页已经加载的单人聊天。要补旧记录，先在 WhatsApp 中向上滚动加载，再同步。不会自动遍历其他会话。
- 网页关闭、电脑休眠或插件暂停时不能接收新消息。自动同步每四秒检查当前聊天。
- 保存文字、方向和消息模型中的时间；图片、语音、视频、文件仅保存类型提示及可用说明文字，不保存原文件或宣称完整备份。
- WhatsApp 可能使用不包含电话号码的 LID；只有实际号码映射可作为号码推荐客户。映射缺失或超时可按姓名手动关联，不会把 LID 当成电话号码。
- 登录账号或当前聊天改变时，清除旧候选和绑定显示并重新识别；不同账号的消息独立保存。
- 消息按稳定 ID 去重，正文延迟加载时会补全空记录。已保存的非空内容不会跟随 WhatsApp 的编辑/撤回变化。
- 按采集顺序展示。WA-JS 消息时间保存为 ISO UTC；缺失时留空，不猜测日/月顺序。
- 已关联有效客户后不能随意覆盖聊天归属。建议先确认客户再开启同步。
- 此开发版的关联使用客户名称；关联后请暂勿重命名客户，改名后的关联迁移尚未支持。
- 一次最多读取 2000 条已加载消息、总正文 200 万字符，单条正文最多 20000 字符；超出时明确提示并暂停，不静默截断。同步按条数及 UTF-8 字节数分批，失败可重试，已保存消息去重。
- WhatsApp 网页更新可能导致 WA-JS 读取失效。未就绪、身份无法确认或结构不兼容时暂停并显示原因，不回退到猜测式 DOM 采集。

## 从 0.1.0 升级

替换扩展目录后，在 Chrome 扩展管理页重新加载，并刷新 WhatsApp 网页。扩展 ID 保持不变。

旧版手填账号标识不会自动认领到新版账号。若旧标识与自动识别出的完整账号 ID 不一致，需要重新确认客户关联；旧记录保留，不做未经确认的合并。

## WA-JS 来源

内置固定版本 `@wppconnect/wa-js 4.5.0`，使用官方 npm 包原始构建，校验信息见 `vendor/SOURCE.json`，Apache-2.0 许可见 `vendor/LICENSE`。没有运行时下载脚本，KME 只调用读取接口，不调用发送、标已读、删除或历史遍历接口。

WA-JS 是第三方非官方项目，不是 WhatsApp 官方 API，也不是小满助手的源码。网页升级兼容性及账号使用规则风险需要自行评估；不能承诺永久兼容或零账号风险。

## 数据与权限

聊天仅存本机 `~/Library/Application Support/TradeOrderSystem/trade-order-system.sqlite` 中的 whatsapp_conversations 与 whatsapp_messages 表。现有 SQLite 整库备份包含它们；订单系统 JSON 导出不包含聊天记录。

插件只在 `https://web.whatsapp.com/` 运行；只使用 storage 和 nativeMessaging 权限。连接助手仅接受本插件 ID `kngglcbmpjeldcidpdmgofbmjklcaglh`，仅提供连接检测、客户查找、关联和同步操作。不读取 Cookies、密码、业务 API Key，不调用 WhatsApp 私有发送接口，无云服务器和统计上报。

## 卸载

Chrome 扩展管理中移除此扩展即可停止采集。需移除连接助手时，可将以下两项移到废纸篓（聊天数据库不受影响）：

- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tradeordersystem.whatsapp.json`
- `~/Library/Application Support/TradeOrderSystem/whatsapp-sync/`

## 验证状态

此开发版包含 SQLite、WA-JS 接口固定样本、Native Messaging 协议、客户详情与真实隔离 Chrome 扩展加载测试。真实 Chrome 测试验证官方包能在 MAIN world 加载，并用合成账号/聊天验证跨 world 通信；没有登录或读取你的真实聊天。

真实账号兼容性仍需在安装后执行“检测本机连接”，并选定一个客户实际同步验收；上述测试通过不代表所有 WhatsApp 版本兼容。
