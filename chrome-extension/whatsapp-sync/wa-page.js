/* KME read-only adapter. This file runs in the WhatsApp page's MAIN world. */
(function () {
  'use strict';
  const identity = wid => {
    const value = typeof wid === 'string' ? wid : wid?._serialized || (wid?.user && wid?.server ? `${wid.user}@${wid.server}` : '');
    return typeof value === 'string' && /^\d{1,30}@(c\.us|s\.whatsapp\.net|lid)$/.test(value) ? value : '';
  };
  const phone = wid => {
    const value = identity(wid);
    return /^\d{8,15}@(c\.us|s\.whatsapp\.net)$/.test(value) ? `+${value.split('@')[0]}` : '';
  };
  async function readSnapshot(wpp) {
    try {
      if (!wpp?.isReady || !wpp.conn?.isAuthenticated?.()) return { ok:false, message:'WA-JS 尚未就绪，请确认 WhatsApp 已登录并等待加载' };
      const accountId = identity(wpp.conn.getMyUserId());
      const chat = wpp.chat.getActiveChat();
      const chatId = identity(chat?.id);
      if (!accountId) return { ok:false, message:'未能确认当前 WhatsApp 账号，已暂停同步' };
      if (!chatId || chat.isGroup || chat.isBroadcast) return { ok:false, message:'请打开客户的单人聊天；群聊和广播暂不支持' };
      let resolvedPhone = phone(chatId);
      if (!resolvedPhone && chatId.endsWith('@lid') && wpp.contact?.getPnLidEntry) {
        let timer;
        try {
          const mapping = await Promise.race([wpp.contact.getPnLidEntry(chatId), new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
          resolvedPhone = phone(mapping?.phoneNumber);
        } catch { /* A missing mapping is not a phone; manual customer confirmation remains available. */ }
        finally { clearTimeout(timer); }
      }
      const models = chat.msgs?.getModelsArray?.();
      if (!Array.isArray(models)) return { ok:false, message:'当前 WhatsApp 消息结构暂不兼容，已暂停同步' };
      if (models.length > 2000) return { ok:false, message:'当前加载超过 2000 条消息，请刷新并分段加载后同步' };
      const peers = new Set([chatId]);
      if (resolvedPhone) { peers.add(`${resolvedPhone.slice(1)}@c.us`); peers.add(`${resolvedPhone.slice(1)}@s.whatsapp.net`); }
      const seen = new Set(), messages = [];
      const kinds = { chat:'text', image:'image', video:'video', ptt:'audio', audio:'audio', document:'file', sticker:'sticker' };
      let totalText = 0;
      for (const model of models) {
        if (model.isNotification || model.isStatusV3 || model.isGroupMsg || ['revoked','e2e_notification','notification_template'].includes(model.type)) continue;
        const id = model.id?._serialized;
        const direction = model.id?.fromMe;
        if (typeof id !== 'string' || id.length > 400 || typeof direction !== 'boolean' || !peers.has(identity(model.id.remote)) || seen.has(id)) continue;
        const parsed = id.match(/^(true|false)_([^_]+)_(.+)$/);
        if (!parsed || (parsed[1] === 'true') !== direction || !peers.has(parsed[2])) continue;
        seen.add(id);
        const kind = kinds[model.type] || 'other';
        const value = kind === 'text' ? model.body : model.caption;
        const text = typeof value === 'string' ? value : '';
        if (text.length > 20000) return { ok:false, message:'单条消息正文超过 20000 字符，已暂停同步；未截断或保存该批消息' };
        totalText += text.length;
        if (totalText > 2000000) return { ok:false, message:'当前消息正文过多，请分段加载后同步' };
        const timestamp = Number(model.t);
        const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : null;
        messages.push({ id, direction:direction ? 'out' : 'in', timestamp:date && Number.isFinite(date.getTime()) ? date.toISOString() : '', text, kind });
      }
      // LID lookups are async: never return data under a different login/chat.
      if (!wpp.conn.isAuthenticated() || identity(wpp.conn.getMyUserId()) !== accountId || identity(wpp.chat.getActiveChat()?.id) !== chatId) return { ok:false, message:'账号或聊天已切换，请稍后重试' };
      return { ok:true, accountId, chatId, phone:resolvedPhone, title:String(chat.formattedTitle || chat.name || resolvedPhone || '当前客户').slice(0, 300), messages, source:'WA-JS' };
    } catch { return { ok:false, message:'WA-JS 读取暂时失败，已暂停同步；可刷新 WhatsApp 后重试' }; }
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { readSnapshot }; return; }
  let reading = false;
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== 'KME_WA_READ_V1' || data.type !== 'snapshot' || typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId)) return;
    if (reading) return;
    reading = true;
    try { window.postMessage({ channel:'KME_WA_READ_V1', type:'snapshot-result', requestId:data.requestId, result:await readSnapshot(window.WPP) }, location.origin); }
    finally { reading = false; }
  });
})();
