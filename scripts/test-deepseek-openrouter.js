#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const model = 'deepseek/deepseek-v4.1-flash';
const messages = [{role:'user',content:'Only return {"ok":true}'}];

function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0, `missing production function ${name}`);
  for (let end = source.indexOf('{', start); end < source.length; end++) {
    if (source[end] !== '}') continue;
    const code = source.slice(start, end + 1);
    try { new vm.Script(code); return code; } catch (_) {}
  }
  throw new Error(`unclosed production function ${name}`);
}

// Payload assertions protect the external API contract, not a source string.
// Only the external network and credential boundary are replaced with fixtures.
async function testSurface(surface) {
  const source = fs.readFileSync(path.join(root, surface === 'server' ? 'mac-app/server.js' : 'trade-order-system.html'), 'utf8');
  let settings, payload, endpoint;
  const result = {choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]};
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    process:{env:{}},
    aiUsageStore:{record(){}},
    isMacAppMode:()=>false,
    readAiSettings:()=>settings,
    readAiApiKey:()=> 'TEST_ONLY_NOT_A_REAL_KEY',
    boundedAiMessages:value=>value,
    requestJsonResponse:async(url,options)=>{
      endpoint=url;payload=JSON.parse(options.body);
      return {status:200,data:result};
    },
    fetch:async(url,options)=>{
      endpoint=url;payload=JSON.parse(options.body);
      return {ok:true,json:async()=>result};
    }
  });
  for (const name of surface === 'server'
    ? ['aiChatEndpoint','queryAiChat']
    : ['aiChatEndpoint','friendlyAiErrorMessage','requestAiChat']) {
    vm.runInContext(extractFunction(source,name),context);
  }
  async function run(baseUrl, selectedModel, provider='custom', testOnly=false) {
    settings={enabled:'是',provider,baseUrl,model:selectedModel,apiKey:'TEST_ONLY_NOT_A_REAL_KEY'};
    const response = surface === 'server'
      ? await context.queryAiChat({messages,temperature:0,testOnly})
      : await context.requestAiChat(settings,messages,{temperature:0,testOnly});
    assert.equal(response.choices[0].message.content,'{"ok":true}');
    assert.deepEqual(payload.messages,messages,'existing extraction messages must remain intact');
    assert.equal(payload.model,selectedModel);
    assert.equal(payload.max_tokens,testOnly?256:1024);
  }
  for (const testOnly of [false,true]) {
    await run('https://openrouter.ai/api/v1',model,'custom',testOnly);
    assert.equal(endpoint,'https://openrouter.ai/api/v1/chat/completions');
    assert.deepEqual(payload.reasoning,{enabled:false},`${surface}: DeepSeek must not consume the extraction budget on reasoning`);
    assert.equal(payload.thinking,undefined);
  }
  await run('https://openrouter.ai/api/v1/chat/completions',model);
  assert.deepEqual(payload.reasoning,{enabled:false},'full endpoint URL must behave the same');
  for (const [baseUrl,selectedModel,provider] of [
    ['https://openrouter.ai/api/v1','google/gemini-3.1-flash-lite','custom'],
    ['https://openrouter.ai/api/v1','deepseek/deepseek-v3.2','custom'],
    ['https://openrouter.ai.example/api/v1',model,'custom'],
    ['https://example.invalid/v1',model,'custom'],
    ['https://open.bigmodel.cn/api/paas/v4','glm-4.7-flash','zhipu']
  ]) {
    await run(baseUrl,selectedModel,provider);
    assert.equal(payload.reasoning,undefined,'unrelated models/endpoints must not change reasoning behavior');
    assert.deepEqual(payload.thinking,provider==='zhipu'?{type:'disabled'}:undefined);
  }
  console.log(`${surface}: DeepSeek non-reasoning contract and unrelated-model isolation passed.`);
}
(async()=>{
  const mode=process.argv[2] || 'all';
  if(mode!=='client') await testSurface('server');
  if(mode!=='server') await testSurface('client');
})().catch(error=>{console.error(error);process.exitCode=1;});
