// Calls to the AI provider for paste recognition: builds the chat request for the configured endpoint,
// records what each call cost, and turns failures into text the page can show.
//
// The server passes in how to read the AI settings and key and where usage is recorded; tests pass
// fixtures for those and for the request itself.
const { httpError } = require('./http-error');
const outbound = require('./outbound-http');

function aiChatEndpoint(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  return /\/chat\/completions$/.test(clean) ? clean : `${clean}/chat/completions`;
}

function boundedAiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  if (messages.length > 64) throw httpError(400, 'too many AI messages');
  return messages.map(message => {
    const role = String(message?.role || 'user');
    const content = String(message?.content || '');
    if (content.length > 200000) throw httpError(400, 'AI message is too large');
    return { ...message, role, content };
  });
}

function createAiChat({ readAiSettings, readAiApiKey, aiUsageStore, requestJsonResponse = outbound.requestJsonResponse }) {
  async function queryAiChat(body = {}) {
    const settings = readAiSettings();
    const apiKey = readAiApiKey();
    if (settings.enabled !== '是') return { ok: false, message: 'AI 识别未启用。' };
    if (!apiKey) return { ok: false, message: 'AI API Key 未保存。' };
    if (!settings.baseUrl || !settings.model) return { ok: false, message: 'AI Base URL 或模型名称未设置。' };
    // 先在本地检查消息：太长 / 太多条时直接回中文提示，不调用上游，也不记一条「请求失败」的费用记录。
    let messages;
    try {
      messages = boundedAiMessages(body.messages);
    } catch (error) {
      const tooLarge = /too large/i.test(String(error?.message || ''));
      return { ok: false, status: 413, message: tooLarge ? '粘贴内容太长：AI 一次最多读 20 万字，请只粘贴和这笔订单有关的部分。' : '一次发给 AI 的消息太多。' };
    }
    let response, requestError;
    const startedAt = Date.now();
    try {
      response = await requestJsonResponse(aiChatEndpoint(settings.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        timeout: body.testOnly ? 20000 : 45000,
        body: JSON.stringify({
          model: settings.model,
          messages,
          // 智谱和 DeepSeek 官方接口都关掉深度思考：识别只要字段，思考会拖慢速度并占用输出额度
          thinking: settings.provider === 'zhipu' || new URL(settings.baseUrl).hostname === 'api.deepseek.com' ? { type: 'disabled' } : undefined,
          reasoning: new URL(settings.baseUrl).hostname === 'openrouter.ai' && settings.model === 'deepseek/deepseek-v4.1-flash' ? { enabled: false } : undefined,
          // DeepSeek 官方接口支持 JSON 模式：识别请求强制返回 JSON 对象，测试连接不用
          response_format: !body.testOnly && new URL(settings.baseUrl).hostname === 'api.deepseek.com' ? { type: 'json_object' } : undefined,
          max_tokens: body.testOnly ? 256 : 1024,
          temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0
        })
      });
    } catch (error) {
      requestError = error;
    }
    let accountingWarning = '';
    try {
      aiUsageStore.record({
        baseUrl:settings.baseUrl, model:settings.model, purpose:body.purpose, testOnly:body.testOnly,
        durationMs:Date.now() - startedAt,
        status:!requestError && response.status >= 200 && response.status < 300 && !response.data?.error ? 'success' : 'failed',
        data:response?.data
      });
    } catch (_) {
      accountingWarning = '本次 AI 费用记录失败，请检查设置中的费用记录。';
    }
    if (requestError) {
      const message = /timeout/i.test(String(requestError?.message || ''))
        ? 'AI 请求超时，请减少粘贴内容后重试，或稍后再试。'
        : `AI 请求失败：${requestError?.message || '未知错误'}`;
      return { ok: false, message, ...(accountingWarning ? { accountingWarning } : {}) };
    }
    // 有的中转接口出错也回 200，只在正文里放 error：同样当失败处理（费用记录那边已经这么算）。
    if (response.status < 200 || response.status >= 300 || response.data?.error) {
      const error = (typeof response.data.error === 'object' && response.data.error) || response.data.errors?.[0] || {};
      if (typeof response.data.error === 'string') error.message = response.data.error;
      return { ok: false, status: response.status, message: error.message || response.data.message || `AI 接口 HTTP ${response.status}`, ...(accountingWarning ? { accountingWarning } : {}) };
    }
    return { ok: true, ...response.data, ...(accountingWarning ? { accountingWarning } : {}) };
  }

  async function checkAiApiStatus() {
    const settings = readAiSettings();
    if (settings.enabled !== '是') return { ok: false, disabled: true, label: 'AI', message: 'AI 识别未开启' };
    if (!readAiApiKey()) return { ok: false, disabled: true, label: 'AI', message: 'AI API Key 未保存' };
    const checkedAt = new Date().toISOString();
    const result = await queryAiChat({
      testOnly: true,
      temperature: 0,
      messages: [{ role: 'user', content: 'ping' }]
    });
    return result.ok
      ? { ok: true, label: 'AI', checkedAt, message: 'AI API 可连接', ...(result.accountingWarning ? {accountingWarning:result.accountingWarning} : {}) }
      : { ok: false, label: 'AI', checkedAt, message: result.message || 'AI 检测失败', ...(result.accountingWarning ? {accountingWarning:result.accountingWarning} : {}) };
  }

  return { queryAiChat, checkAiApiStatus };
}

module.exports = { createAiChat, aiChatEndpoint };
