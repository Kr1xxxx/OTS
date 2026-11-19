// 在 WA-JS 加载前给它配置：关掉它自带的 Google Analytics 统计上报（默认是开的），也不用它的链接预览服务器。
// 必须排在 manifest 里 vendor/wppconnect-wa.js 前面：WA-JS 只在加载时读一次 window.WPPConfig。
window.WPPConfig = { disableGoogleAnalytics: true, linkPreviewApiServers: [] };
