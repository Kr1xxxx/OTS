(() => {
  'use strict';
  let pending;
  const bad = () => ({ ok:false, message:'WA-JS 数据格式不兼容，已暂停同步' });
  function validate(result) {
    if (!result?.ok) return { ok:false, message:typeof result?.message === 'string' ? result.message.slice(0, 200) : 'WA-JS 读取失败' };
    const jid = /^\d{1,30}@(c\.us|s\.whatsapp\.net|lid)$/;
    if (typeof result.accountId !== 'string' || !jid.test(result.accountId) || typeof result.chatId !== 'string' || !jid.test(result.chatId) || typeof result.title !== 'string' || result.title.length > 300 || typeof result.phone !== 'string' || (result.phone && !/^\+\d{8,15}$/.test(result.phone)) || !Array.isArray(result.messages) || result.messages.length > 2000) return bad();
    let total = 0;
    const messages = [];
    for (const m of result.messages) {
      if (!m || typeof m.id !== 'string' || !m.id || m.id.length > 400 || !['in','out'].includes(m.direction) || !['text','image','audio','video','file','sticker','other'].includes(m.kind) || typeof m.text !== 'string' || m.text.length > 20000 || typeof m.timestamp !== 'string' || m.timestamp.length > 200) return bad();
      total += m.text.length;
      if (total > 2000000) return bad();
      messages.push({ id:m.id, direction:m.direction, kind:m.kind, text:m.text, timestamp:m.timestamp });
    }
    return { ok:true, accountId:result.accountId, chatId:result.chatId, title:result.title, phone:result.phone, messages, source:'WA-JS' };
  }
  function snapshot() {
    if (pending) return pending;
    pending = new Promise(resolve => {
      const requestId = crypto.randomUUID();
      let timer;
      const finish = result => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(result); };
      const receive = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'KME_WA_READ_V1' || event.data.type !== 'snapshot-result' || event.data.requestId !== requestId) return;
        finish(validate(event.data.result));
      };
      window.addEventListener('message', receive);
      timer = setTimeout(() => finish({ ok:false, message:'WA-JS 连接超时，请刷新 WhatsApp 后重试' }), 5000);
      window.postMessage({ channel:'KME_WA_READ_V1', type:'snapshot', requestId }, location.origin);
    }).finally(() => { pending = null; });
    return pending;
  }
  globalThis.TradeWhatsAppCollector = { snapshot };
})();
