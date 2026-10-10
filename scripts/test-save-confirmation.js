const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
function extract(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert(start >= 0, `Missing ${name}`);
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] !== '}') continue;
    const source = html.slice(start, i + 1);
    try { new vm.Script(source); return source; } catch (_) {}
  }
  throw Error(name);
}
async function scenario(readOnly, saveOK) {
  const events = [];
  let resolveSave;
  const pending = new Promise(resolve => { resolveSave = resolve; });
  const ctx = vm.createContext({
    state:{customers:{},orders:[]}, macDataLoaded:true, macStorageReadOnly:readOnly,
    isMacAppMode:()=>true, macSaveLastError:'test disk failure', editingId:null,
    FormData:class { entries() { return [['name','Test Buyer'],['originalName',''],['client','Test Buyer']]; } },
    customerMultiFieldData:()=>({}), customerContactPreferenceData:()=>({}), autoCapitalizeCustomerName:x=>x,
    confirmDuplicateCustomerSave:async()=>true,
    buildCustomerSavePayload:()=>({newName:'Test Buyer',nextProfile:{client:'Test Buyer'}}),
    commitCustomerSavePayload:()=>events.push('mutated'),
    closeCustomerModal:()=>events.push('closed'), openPendingCombinedOrder:()=>false,
    render:()=>{}, toast:message=>events.push(message), flushPendingSave:()=>pending,
    orderShipmentsFromForm:()=>[], orderAttachmentsFromForm:()=>[],
    buildOrderFromFormData:(data,{existing})=>({id:existing?.id || 'order-'+(++ctx.sequence),client:'Test Buyer'}),
    sequence:0, shouldRequestOrderNotification:()=>false, normalizeFeishuNotification:x=>x,
    closeOrder:()=>events.push('closed'), completeOrderNotification:()=>events.push('notified')
  });
  for (const name of ['canSubmitStoredData','persistFormState']) {
    if (html.includes(`function ${name}(`)) vm.runInContext(extract(name),ctx);
  }
  vm.runInContext(extract('saveCustomer'),ctx);
  vm.runInContext(extract('upsertOrder'),ctx);
  const form = {dataset:{}, elements:{name:{value:''},originalName:{value:''}}};
  const save = ctx.saveCustomer(form);
  await new Promise(resolve=>setImmediate(resolve));
  if (readOnly) assert(!events.includes('mutated'), 'Read-only mode must not mutate customer data');
  assert(!events.includes('closed'), 'Must not close before database confirmation');
  resolveSave(saveOK);
  await save;
  assert.equal(events.includes('closed'), !readOnly && saveOK);
  assert.equal(events.includes('客户档案已保存'), !readOnly && saveOK);
  events.length=0;
  const orderForm = {dataset:{},elements:{}};
  await ctx.upsertOrder(orderForm);
  assert.equal(events.includes('closed'), !readOnly && saveOK);
  if (!readOnly && !saveOK) {
    await ctx.upsertOrder(orderForm);
    assert.equal(ctx.state.orders.length,1,'Retry must not duplicate an unsaved new order');
  }
  if (readOnly) assert.equal(ctx.state.orders.length,0);
}
(async()=>{
  await scenario(true,false); await scenario(false,false); await scenario(false,true);
  console.log('Save confirmation passed: read-only, pending, failure, success, retry without duplication.');
})().catch(error=>{console.error(error);process.exitCode=1;});
