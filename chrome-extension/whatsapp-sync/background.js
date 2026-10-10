'use strict';
const nativeHost = 'com.tradeordersystem.whatsapp';
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url?.startsWith('https://web.whatsapp.com/')) return false;
  if (!['status','search','bind','sync'].includes(message?.action)) return false;
  chrome.runtime.sendNativeMessage(nativeHost, message, response => {
    if (chrome.runtime.lastError) return reply({ ok:false, message:'本机连接未就绪，请安装连接助手并确认订单系统已经初始化。' });
    reply(response || { ok:false, message:'本机连接没有返回结果' });
  });
  return true;
});
chrome.action.onClicked.addListener(tab => {
  // No broad tabs/activeTab permission: tab.url may be omitted. Only our WhatsApp
  // content script can receive this message; otherwise open the supported site.
  if (!tab.id) return;
  return chrome.tabs.sendMessage(tab.id, { action:'toggle-panel' })
    .catch(() => chrome.tabs.create({ url:'https://web.whatsapp.com/' }));
});
