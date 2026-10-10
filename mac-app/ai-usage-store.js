const fs = require('node:fs');
const crypto = require('node:crypto');

// This ledger contains usage metadata only, never prompts, outputs or credentials.
function createAiUsageStore({ file, atomicWrite }) {
  const finiteCost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  function load() {
    if (!fs.existsSync(file)) return { version:1, startedAt:null, records:[] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.records) || data.records.some(row => !row || typeof row.id !== 'string' || (row.costUsd !== null && finiteCost(row.costUsd) === null))) {
      throw new Error('AI usage ledger is invalid');
    }
    return data;
  }
  function record(input = {}) {
    const data = load();
    let endpointHost = '';
    try { endpointHost = new URL(input.baseUrl).hostname; } catch (_) {}
    const generationId = typeof input.data?.id === 'string' ? input.data.id.slice(0,200) : '';
    if (generationId && data.records.some(row => row.generationId === generationId && row.endpointHost === endpointHost)) return;
    const time = input.time || new Date().toISOString();
    const usage = input.data?.usage || {};
    const row = {
      id:crypto.randomUUID(), time, endpointHost, generationId,
      model:String(input.data?.model || input.model || '').slice(0,160),
      purpose:input.testOnly || input.purpose === 'test' ? 'test' : ['customer','order'].includes(input.purpose) ? input.purpose : 'recognition',
      status:input.status === 'success' ? 'success' : 'failed',
      durationMs:Math.max(0, Math.round(Number(input.durationMs) || 0)),
      costUsd:endpointHost === 'openrouter.ai' ? finiteCost(usage.cost) : null,
      promptTokens:tokens(usage.prompt_tokens), completionTokens:tokens(usage.completion_tokens)
    };
    data.startedAt ||= time;
    data.records.push(row);
    atomicWrite(file, JSON.stringify(data));
  }
  function read({ page=1, pageSize=20, model='', endpointHost='' } = {}) {
    const data = load();
    const month = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'}).format(new Date());
    const monthOf = value => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'}).format(new Date(value));
    const sum = rows => Number(rows.reduce((total,row) => total + (row.costUsd ?? 0),0).toFixed(12));
    const summarize = rows => ({
      startedAt:rows[0]?.time || null, totalCostUsd:sum(rows),
      monthCostUsd:sum(rows.filter(row => monthOf(row.time) === month)),
      totalCalls:rows.length, unknownCostCalls:rows.filter(row => row.costUsd === null).length
    });
    const groups = new Map();
    data.records.forEach(row => {
      const key = JSON.stringify([row.endpointHost,row.model]);
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(row);
    });
    const models = [...groups.values()].map(rows => ({endpointHost:rows[0].endpointHost,model:rows[0].model,...summarize(rows)}));
    const selected = data.records.filter(row => (!model || row.model === model) && (!endpointHost || row.endpointHost === endpointHost));
    pageSize = Math.max(1,Math.min(50,Number.parseInt(pageSize,10) || 20));
    const pages = Math.max(1,Math.ceil(selected.length/pageSize));
    page = Math.max(1,Math.min(pages,Number.parseInt(page,10) || 1));
    return {
      ...summarize(selected), models,
      page,pages,records:selected.slice().reverse().slice((page-1)*pageSize,page*pageSize)
    };
  }
  return { record,read };
}
module.exports = { createAiUsageStore };
