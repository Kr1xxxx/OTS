(() => {
  'use strict';
  if (document.getElementById('trade-whatsapp-assistant')) return;
  const host = document.createElement('div'); host.id = 'trade-whatsapp-assistant';
  const shadow = host.attachShadow({ mode:'closed' });
  shadow.innerHTML = `
    <style>
      :host { all:initial; position:fixed; inset:0 0 auto auto; z-index:2147483000; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#243c36; }
      * { box-sizing:border-box; } button,input,select { font:inherit; } button { cursor:pointer; }
      .launcher { position:fixed; right:20px; bottom:24px; border:0; border-radius:12px; padding:12px 18px; background:#127d68; color:white; box-shadow:0 5px 24px #122e3433; font-weight:600; }
      .panel { position:fixed; top:16px; right:16px; bottom:16px; width:340px; max-width:calc(100vw - 32px); overflow:auto; border:1px solid #deded5; border-radius:18px; background:#faf9f5; box-shadow:0 12px 48px #112a3430; padding:24px; }
      [hidden] { display:none !important; } h1 { margin:0; font-size:20px; font-weight:650; letter-spacing:-.5px; } h2 { font-size:16px; line-height:1.5; overflow-wrap:anywhere; margin:6px 0; }
      .eyebrow { color:#648076; font-size:11px; letter-spacing:2px; margin-bottom:6px; } .close { position:absolute; right:16px; top:16px; border:0; background:transparent; color:#72827b; font-size:22px; }
      .sub { color:#78847b; font-size:12px; margin:8px 0 0; } .section { padding:20px 0; border-bottom:1px solid #e4e5dc; }
      details.section summary { cursor:pointer; font-size:12px; color:#6b8074; } details[open] summary { margin-bottom:12px; }
      label { display:block; font-size:12px; font-weight:600; margin:0 0 6px; } input[type=text], select { width:100%; min-height:40px; padding:8px 10px; color:#243c36; background:#fff; border:1px solid #dadfd6; border-radius:8px; outline:0; }
      :is(input,select,button):focus-visible { outline:2px solid #127d68; outline-offset:2px; } .row { display:flex; gap:8px; margin-top:9px; } .row input { min-width:0; }
      .btn { border:1px solid #d3ded5; border-radius:8px; background:#fff; padding:8px 12px; color:#315649; white-space:nowrap; } .primary { background:#127d68; border-color:#127d68; color:#fff; width:100%; font-weight:600; min-height:42px; }
      button:disabled { opacity:.45; cursor:default; } .binding { padding:10px 12px; background:#e9f2eb; color:#28654e; border-radius:8px; font-size:13px; margin:12px 0; overflow-wrap:anywhere; }
      .check { display:flex; align-items:center; gap:8px; font-weight:500; margin:14px 0; } input[type=checkbox] { width:16px; height:16px; accent-color:#127d68; }
      .status { margin-top:14px; color:#507165; font-size:12px; overflow-wrap:anywhere; } .error { color:#a34731; } .count { font-size:32px; font-weight:600; letter-spacing:-1px; } .note { font-size:12px; color:#79857e; margin:16px 0; line-height:1.7; }
      .badge { display:inline-block; color:#537364; border:1px solid #d9e5db; border-radius:5px; padding:2px 6px; font-size:11px; }
      @media(prefers-color-scheme:dark) { .panel { background:#1c2421; border-color:#37423b; color:#e1e8e0; } .section { border-color:#37423b; } input[type=text],select,.btn { background:#253029; border-color:#465347; color:#d9e5dc; } .primary,.launcher { background:#268971; color:#fff; } .binding { background:#263b30; color:#b7d9c1; } .status { color:#a0bcac; } .error { color:#ffb49e; } }
    </style>
    <button class="launcher">客户同步</button>
    <aside class="panel" hidden aria-label="KME WhatsApp 客户同步">
      <button class="close" aria-label="关闭侧栏">×</button>
      <div class="eyebrow">KME WhatsApp 客户同步</div><h1>让沟通留在客户档案</h1><p class="sub">WhatsApp → 本机外贸订单系统</p>
      <details class="section" id="accountSection"><summary id="accountSummary">正在识别 WhatsApp 账号</summary><label for="account">当前 WhatsApp 账号（自动识别）</label><input id="account" type="text" readonly placeholder="等待 WA-JS 连接"><div class="row"><button class="btn" id="connection">检测本机连接</button></div><p class="sub">由 WA-JS 读取当前登录账号；换号后需重新确认客户关联。</p></details>
      <section class="section"><span class="badge">当前聊天</span><h2 id="title">等待打开聊天</h2><p class="sub" id="phone"></p><div class="binding" id="binding">尚未关联客户</div>
        <div id="linkControls"><label for="query">查找订单系统中的客户</label><div class="row"><input id="query" type="text" placeholder="输入客户姓名" maxlength="100"><button class="btn" id="search">查找</button></div>
        <div class="row"><select id="customers" aria-label="选择关联客户"><option value="">请先查找客户</option></select></div><div class="row"><button class="btn primary" id="bind">确认关联此客户</button></div></div>
      </section>
      <section class="section"><div><span class="count" id="count">0</span> <span class="sub">条消息已在网页加载</span></div><label class="check"><input id="auto" type="checkbox">自动同步这个聊天</label><button class="btn primary" id="sync">同步当前已加载消息</button><p class="status" id="status" role="status" aria-live="polite">等待 WA-JS 识别账号与当前聊天。</p></section>
      <p class="note">仅保存当前打开且已关联的单人聊天。向上滚动加载旧消息后，可继续补同步。网页关闭后无法接收消息。<br><br>文字会保存；图片、语音、视频和文件只保存类型提示，原文件尚未同步。记录按采集顺序展示。</p>
    </aside>`;
  document.documentElement.append(host);
  const $ = id => shadow.getElementById(id);
  const panel = shadow.querySelector('.panel');
  let account = '', enabled = {}, current = null, binding = null, busy = false, scanBusy = false, candidatesKey = '', selectionKey = '';
  const acknowledged = new Map();
  const signature = message => JSON.stringify([message.text, message.kind, message.timestamp]);
  const rpc = (action, payload = {}) => new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish({ ok:false, message:'本机连接超时，请重试；重复消息会自动去重' }), 15000);
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    try { chrome.runtime.sendMessage({ action, payload }, response => finish(chrome.runtime.lastError ? { ok:false, message:'插件已更新，请刷新 WhatsApp 网页' } : response || { ok:false, message:'连接失败' })); }
    catch { finish({ ok:false, message:'插件已更新，请刷新 WhatsApp 网页' }); }
  });
  const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
  const key = () => account && current?.ok ? JSON.stringify([account, current.chatId]) : '';
  const snapshotKey = snapshot => snapshot?.ok ? JSON.stringify([snapshot.accountId, snapshot.chatId]) : '';
  function updateButtons() {
    $('linkControls').hidden = Boolean(binding);
    $('accountSummary').textContent = account ? `WA-JS 已连接 · ${account.split('@')[0]}` : 'WA-JS 尚未连接';
    $('account').value = account;
    $('bind').disabled = !current?.ok || !account || ! $('customers').value || !!binding || busy || scanBusy || selectionKey !== key();
    $('sync').disabled = !current?.ok || !account || !binding || busy || scanBusy;
    $('search').disabled = !current?.ok || busy || scanBusy;
    $('auto').disabled = !binding || !account || !current?.ok || scanBusy;
    $('auto').checked = !!enabled[key()];
  }
  function showCandidates(result) {
    selectionKey = key();
    $('customers').replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = result.customers?.length ? '选择客户并确认关联' : '没有匹配客户，请按姓名查找'; $('customers').append(placeholder);
    for (const customer of result.customers || []) {
      const option = document.createElement('option'); option.value = customer.name; option.textContent = customer.name; $('customers').append(option);
    }
    if (result.customers?.length === 1 && result.customers[0].exactPhone) $('customers').value = result.customers[0].name;
    updateButtons();
  }
  function adopt(snapshot) {
    const previous = key(); current = snapshot; account = snapshot.ok ? snapshot.accountId : '';
    $('title').textContent = snapshot.ok ? snapshot.title : snapshot.message;
    $('phone').textContent = snapshot.phone || (snapshot.ok ? '网页未公开电话号码，可手动关联客户' : '');
    $('count').textContent = snapshot.messages?.length || 0;
    if (previous !== key()) { binding = null; candidatesKey = ''; selectionKey = ''; $('binding').textContent = '尚未关联客户'; acknowledged.clear(); showCandidates({ customers:[] }); status(snapshot.ok ? '账号已自动识别，请确认当前聊天关联的客户。' : snapshot.message, !snapshot.ok); }
    updateButtons();
  }
  async function identify() {
    if (scanBusy || busy) return;
    scanBusy = true; updateButtons();
    try {
      const snapshot = await TradeWhatsAppCollector.snapshot(); adopt(snapshot);
      if (!snapshot.ok) { status(snapshot.message, true); return; }
      const capturedKey = key();
      if (candidatesKey !== capturedKey) {
        const result = await rpc('search', { account, chatId:snapshot.chatId, phone:snapshot.phone });
        adopt(await TradeWhatsAppCollector.snapshot());
        if (capturedKey !== key()) return;
        if (result.ok) { candidatesKey = capturedKey; binding = result.binding; $('binding').textContent = binding ? `已关联 · ${binding.customer}` : '尚未关联客户'; showCandidates(result); }
        else status(result.message, true);
      }
    } finally { scanBusy = false; updateButtons(); }
    if (enabled[key()] && binding && !busy) await sync(false);
  }
  async function sync(manual = true) {
    if (busy || scanBusy || !binding || !account) return;
    const capturedKey = key(), capturedAccount = account;
    busy = true; updateButtons(); status('正在读取并同步…');
    let total = 0, updated = 0;
    try {
      const snapshot = await TradeWhatsAppCollector.snapshot();
      if (snapshotKey(snapshot) !== capturedKey) { adopt(snapshot); return; }
      const pending = snapshot.messages.filter(message => acknowledged.get(message.id) !== signature(message));
      if (!pending.length) { status('当前已加载消息均已同步。'); return; }
      // Native requests are limited to 4 MiB. Count encoded JSON bytes, not characters.
      const encoder = new TextEncoder();
      const envelopeBytes = encoder.encode(JSON.stringify({ action:'sync', payload:{ account:capturedAccount, chatId:snapshot.chatId, messages:[] } })).length;
      for (let start = 0; start < pending.length;) {
        const visible = await TradeWhatsAppCollector.snapshot();
        if (snapshotKey(visible) !== capturedKey) { adopt(visible); break; }
        if (capturedKey !== key() || (!manual && !enabled[capturedKey])) break;
        const batch = [];
        let bytes = envelopeBytes;
        while (start < pending.length && batch.length < 100) {
          const message = pending[start];
          const extra = encoder.encode(JSON.stringify(message)).length + (batch.length ? 1 : 0);
          if (bytes + extra > 3 * 1024 * 1024) {
            if (!batch.length) throw new Error('单条消息超过本机通信限制，未截断或保存');
            break;
          }
          batch.push(message); bytes += extra; start++;
        }
        const result = await rpc('sync', { account:capturedAccount, chatId:snapshot.chatId, messages:batch });
        if (!result.ok) throw new Error(result.message);
        if (capturedKey !== key()) break;
        batch.forEach(message => acknowledged.set(message.id, signature(message))); total += result.inserted; updated += result.updated || 0;
      }
      if (capturedKey === key()) status(`已同步，新增 ${total} 条${updated ? `、补全 ${updated} 条` : ''} · ${new Date().toLocaleTimeString()}`);
    } catch (error) { status(`${error.message}。保留在网页中的消息可重试。`, true); }
    finally { busy = false; updateButtons(); }
  }
  shadow.querySelector('.launcher').onclick = () => { panel.hidden = !panel.hidden; identify(); };
  shadow.querySelector('.close').onclick = () => { panel.hidden = true; };
  chrome.runtime.onMessage.addListener(message => { if (message.action === 'toggle-panel') { panel.hidden = !panel.hidden; identify(); } });
  $('connection').onclick = async () => { const result = await rpc('status'); status(result.ok ? `本机连接正常，已保存 ${result.messages} 条消息。` : result.message, !result.ok); };
  $('search').onclick = async () => {
    if (!current?.ok || !account || busy || scanBusy) return;
    const capturedKey = key();
    scanBusy = true; updateButtons();
    try {
      const result = await rpc('search', { account, chatId:current.chatId, query:$('query').value });
      adopt(await TradeWhatsAppCollector.snapshot());
      if (capturedKey !== key()) return;
      if (!result.ok) return status(result.message, true);
      showCandidates(result);
    } finally { scanBusy = false; updateButtons(); }
  };
  $('customers').onchange = updateButtons;
  $('bind').onclick = async () => {
    const capturedKey = key(), customer = $('customers').value;
    if (busy || scanBusy || selectionKey !== capturedKey || !customer || binding) return;
    busy = true; updateButtons();
    try {
      const visible = await TradeWhatsAppCollector.snapshot();
      if (snapshotKey(visible) !== capturedKey) { adopt(visible); return; }
      const result = await rpc('bind', { account, chatId:visible.chatId, title:visible.title, customer });
      adopt(await TradeWhatsAppCollector.snapshot());
      if (capturedKey !== key()) return;
      if (!result.ok) return status(result.message, true);
      binding = { customer:result.customer }; $('binding').textContent = `已关联 · ${result.customer}`; status('关联完成，可以同步。');
    } finally { busy = false; updateButtons(); }
  };
  $('auto').onchange = async () => {
    if (!key()) return;
    enabled[key()] = $('auto').checked;
    await chrome.storage.local.set({ tradeWhatsAppEnabled:enabled });
    status($('auto').checked ? '自动同步已开启，仅针对当前关联聊天。' : '已暂停自动同步。');
    if ($('auto').checked) await sync(false);
  };
  $('sync').onclick = () => sync(true);
  chrome.storage.local.get(['tradeWhatsAppEnabled']).then(saved => {
    enabled = saved.tradeWhatsAppEnabled || {}; identify();
  });
  // Polling reads only the active chat; it does not open other chats or load history.
  setInterval(identify, 4000);
})();
