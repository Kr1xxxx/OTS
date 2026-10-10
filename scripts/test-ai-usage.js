const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
function extract(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0, `missing ${name}`);
  for (let end = source.indexOf('{', start); end < source.length; end++) {
    if (source[end] !== '}') continue;
    const code = source.slice(start, end + 1);
    try { new vm.Script(code); return code; } catch (_) {}
  }
  throw new Error(`unclosed ${name}`);
}
async function storeTest() {
  const modulePath = path.join(root, 'mac-app/ai-usage-store.js');
  assert(fs.existsSync(modulePath), 'AI expenses must have a persistent production store');
  const { createAiUsageStore } = require(modulePath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-ai-usage-'));
  try {
    const file = path.join(dir, 'usage.json');
    const context = vm.createContext({fs,path,crypto:require('node:crypto'),process});
    vm.runInContext(extract(fs.readFileSync(path.join(root,'mac-app/server.js'),'utf8'),'atomicWrite'),context);
    const make = () => createAiUsageStore({file,atomicWrite:context.atomicWrite});
    const store = make();
    assert.equal(store.read().totalCostUsd,0);
    const now = '2026-10-06T12:00:00.000Z';
    const item = {time:now,baseUrl:'https://openrouter.ai/api/v1',model:'model-a',purpose:'customer',durationMs:1200,status:'success',data:{id:'gen-a',model:'model-a',usage:{cost:0.01,prompt_tokens:20,completion_tokens:10}},messages:['PRIVATE_INPUT'],apiKey:'PRIVATE_KEY'};
    store.record(item); store.record(item);
    store.record({...item,purpose:'test',data:{id:'gen-b',usage:{cost:0.02}}});
    store.record({...item,status:'failed',data:{id:'gen-c',usage:{cost:null}}});
    store.record({...item,baseUrl:'https://other.example/v1',data:{id:'gen-d',usage:{cost:99}}});
    store.record({...item,model:'free',data:{id:'gen-e',usage:{cost:0}}});
    const saved = make().read({page:1,pageSize:2});
    assert.equal(saved.totalCostUsd,0.03,'known actual costs must accumulate once per generation');
    assert.equal(saved.totalCalls,5); assert.equal(saved.unknownCostCalls,2);
    assert.equal(saved.records.length,2); assert.equal(saved.pages,3);
    assert.equal(make().read({page:3,pageSize:2}).records.length,1);
    const selected=make().read({model:'model-a',endpointHost:'openrouter.ai',pageSize:2});
    assert.equal(selected.totalCalls,3,'model totals must not include other endpoint/model calls');
    assert.equal(selected.totalCostUsd,0.03);
    assert.equal(selected.unknownCostCalls,1);
    assert.equal(selected.pages,2);
    assert(selected.records.every(row=>row.model==='model-a'&&row.endpointHost==='openrouter.ai'));
    const free=make().read({model:'free',endpointHost:'openrouter.ai'});
    assert.equal(free.totalCalls,1); assert.equal(free.totalCostUsd,0);
    assert.equal(make().read({model:'not-yet-used',endpointHost:'openrouter.ai'}).totalCalls,0,'a new model must start its own empty totals');
    assert.equal(selected.models.length,3,'model summaries must cover the entire ledger, not the current page');
    const text = fs.readFileSync(file,'utf8');
    assert(!text.includes('PRIVATE_INPUT') && !text.includes('PRIVATE_KEY'),'ledger must exclude secrets and customer text');
    assert.equal(fs.statSync(file).mode & 0o777,0o600);
    fs.writeFileSync(file,'broken ledger');
    assert.throws(()=>make().read());
    assert.throws(()=>make().record(item));
    assert.equal(fs.readFileSync(file,'utf8'),'broken ledger','corrupt ledger must not be reset silently');
    console.log('AI usage store: costs, zero vs unknown, deduplication, pagination, privacy, persistence, corruption protection passed.');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
async function serverTest() {
  const modulePath=path.join(root,'mac-app/ai-usage-store.js');
  assert(fs.existsSync(modulePath),'missing usage store');
  const {createAiUsageStore}=require(modulePath);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trade-ai-contract-'));
  try {
    const source=fs.readFileSync(path.join(root,'mac-app/server.js'),'utf8');
    let response={status:200,data:{id:'gen-contract',model:'deepseek/deepseek-v4.1-flash',choices:[{message:{content:'{}'}}],usage:{cost:0.00001234,prompt_tokens:12,completion_tokens:3}}};
    const context=vm.createContext({URL,Date,fs,path,crypto:require('node:crypto'),process:{env:{},pid:process.pid},readAiSettings:()=>({enabled:'是',provider:'custom',baseUrl:'https://openrouter.ai/api/v1',model:'deepseek/deepseek-v4.1-flash'}),readAiApiKey:()=> 'TEST_KEY',boundedAiMessages:values=>values,requestJsonResponse:async()=>{if(response instanceof Error)throw response;return response;}});
    vm.runInContext(extract(source,'atomicWrite'),context);
    context.aiUsageStore=createAiUsageStore({file:path.join(dir,'usage.json'),atomicWrite:context.atomicWrite});
    for(const name of ['aiChatEndpoint','queryAiChat']) vm.runInContext(extract(source,name),context);
    await context.queryAiChat({messages:[],purpose:'customer'});
    assert.equal(context.aiUsageStore.read().totalCostUsd,0.00001234,'real server request must persist billed cost');
    response=new Error('network timeout');
    assert.equal((await context.queryAiChat({messages:[],testOnly:true})).ok,false);
    const summary=context.aiUsageStore.read();
    assert.equal(summary.totalCalls,2); assert.equal(summary.unknownCostCalls,1);
    assert.equal(summary.records[0].purpose,'test'); assert.equal(summary.records[0].status,'failed');
    context.aiUsageStore={record(){throw new Error('disk failed');}};
    response={status:200,data:{choices:[{message:{content:'{}'}}],usage:{cost:0.01}}};
    const result=await context.queryAiChat({messages:[]});
    assert.equal(result.ok,true,'ledger write failure must not destroy an already-paid recognition result');
    assert(result.accountingWarning,'ledger write failure must be exposed');
    response={status:429,data:{error:{message:'fixture limit'}}};
    const httpFailure=await context.queryAiChat({messages:[]});
    assert(httpFailure.accountingWarning,'upstream HTTP error must retain ledger failure warning');
    vm.runInContext(extract(source,'checkAiApiStatus'),context);
    response={status:200,data:{choices:[{message:{content:'pong'}}],usage:{cost:0.01}}};
    const connection=await context.checkAiApiStatus();
    assert.equal(connection.ok,true);
    assert(connection.accountingWarning,'connection status must retain accounting warning');
    console.log('AI usage server: real request accounting, unknown timeout cost, write-failure warning passed.');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
async function uiTest() {
  const browser=await chromium.launch({headless:true});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trade-ai-model-ui-'));
  try {
    const page=await browser.newPage({viewport:{width:1360,height:1000}});
    const {createAiUsageStore}=require(path.join(root,'mac-app/ai-usage-store.js'));
    const ledger=createAiUsageStore({file:path.join(dir,'usage.json'),atomicWrite:(file,text)=>fs.writeFileSync(file,text)});
    const record=(model,cost,purpose)=>ledger.record({baseUrl:'https://openrouter.ai/api/v1',model,purpose,status:'success',durationMs:1200,data:{usage:{cost,prompt_tokens:12,completion_tokens:3}}});
    record('deepseek/deepseek-v4.1-flash',0.00001234,'customer');
    record('google/gemini-3.1-flash-lite',0.01,'order');
    record('other',null,'test');
    let unavailable=false;
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/trade-order-system.html')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'trade-order-system.html'),'utf8')});
      if(url.pathname==='/api/data')return route.fulfill({json:{app:'trade-order-system',revision:0,data:{demoCleared:true,demoCustomersCleared:true,orders:[],customers:{}}}});
      if(url.pathname==='/api/ai-settings')return route.fulfill({json:{enabled:'是',provider:'custom',baseUrl:'https://openrouter.ai/api/v1',model:'deepseek/deepseek-v4.1-flash',apiKeySaved:true}});
      if(url.pathname==='/api/ai-usage')return route.fulfill({json:unavailable?{ok:false}:{ok:true,...ledger.read({page:url.searchParams.get('page'),model:url.searchParams.get('model')||'',endpointHost:url.searchParams.get('host')||''})}});
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(()=>window.pendingSaveStatus?.().loaded);
    assert.equal(await page.locator('.app-version').evaluate(el=>getComputedStyle(el).cursor),'default','version hover must keep arrow cursor');
    assert.equal(await page.locator('[data-api-check="ai"]').evaluate(el=>getComputedStyle(el).cursor),'default','AI hover must keep arrow cursor');
    await page.waitForFunction(()=>document.querySelector('[data-api-check="ai"]').title.includes('0.000012'));
    const title=await page.locator('[data-api-check="ai"]').getAttribute('title');
    assert.match(title,/deepseek\/deepseek-v4.1-flash/);
    await page.locator('[data-page="settings"]').click();
    await page.locator('[data-settings-tab="ai"]').click();
    await page.waitForFunction(()=>document.getElementById('aiUsageRecords')?.textContent.includes('0.000012'));
    assert.match(await page.locator('#aiUsageRecords').innerText(),/客户识别/);
    assert.equal(await page.locator('#aiUsageTotal').innerText(),'USD 0.000012','default fee panel must isolate the saved current model');
    assert.doesNotMatch(await page.locator('#aiUsageRecords').innerText(),/gemini|连接测试/);
    assert.doesNotMatch(await page.locator('#aiSettingsForm').innerText(),/智谱|glm-4.7|open.bigmodel/,'obsolete Zhipu preset and guidance must be absent from settings');
    await page.locator('#aiUsageModel').selectOption(JSON.stringify(['openrouter.ai','google/gemini-3.1-flash-lite']),{force:true});
    await page.waitForFunction(()=>document.getElementById('aiUsageTotal').textContent==='USD 0.010000');
    assert.match(await page.locator('#aiUsageRecords').innerText(),/gemini/);
    assert.doesNotMatch(await page.locator('#aiUsageRecords').innerText(),/deepseek/);
    const hover=await page.locator('[data-api-check="ai"]').getAttribute('title');
    assert.match(hover,/0.000012/,'selecting another model in history must not change current-model hover cost');
    assert.doesNotMatch(hover,/0.010000/);
    await page.locator('#aiUsageModel').selectOption(JSON.stringify(['openrouter.ai','other']),{force:true});
    await page.waitForFunction(()=>document.getElementById('aiUsageRecords').textContent.includes('连接测试'));
    assert.match(await page.locator('#aiUsageRecords').innerText(),/未知/);
    await page.locator('#aiUsageModel').selectOption(JSON.stringify(['openrouter.ai','deepseek/deepseek-v4.1-flash']),{force:true});
    await page.waitForFunction(()=>document.getElementById('aiUsageTotal').textContent==='USD 0.000012');
    for(const theme of ['light','dark']){
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      if(process.env.UI_SCREENSHOT)await page.locator('#aiUsagePanel').screenshot({path:process.env.UI_SCREENSHOT+'.'+theme+'.png'});
    }
    await page.setViewportSize({width:390,height:844});
    assert(await page.locator('#aiUsagePanel').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'usage panel must fit narrow layouts');
    if(process.env.UI_SCREENSHOT)await page.locator('#aiUsagePanel').screenshot({path:process.env.UI_SCREENSHOT+'.mobile.png'});
    unavailable=true;
    await page.evaluate(()=>refreshAiUsage());
    assert.match(await page.locator('[data-api-check="ai"]').getAttribute('title'),/费用.*无法读取/);
    assert.match(await page.locator('#aiUsagePanel').innerText(),/无法读取/);
    console.log('AI usage UI: arrow cursors, model/cost tooltip, records, unknown/unavailable and narrow layouts passed.');
  }finally{await browser.close();fs.rmSync(dir,{recursive:true,force:true});}
}
(async()=>{
  const mode=process.argv[2]||'all';
  if(mode==='all'||mode==='store')await storeTest();
  if(mode==='all'||mode==='server')await serverTest();
  if(mode==='all'||mode==='ui')await uiTest();
})().catch(error=>{console.error(error);process.exitCode=1;});
