const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(require('node:path').join(__dirname,'../supabase/functions/transcribe-task/index.ts'),'utf8'));
function endpoint({role='owner',key='test-key',invalidSession=false,providerStatus=200}={}){
  let handler;const calls=[];
  const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',OPENAI_API_KEY:key};
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  const fetch=async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/auth/v1/user'))return json({id:'verified-user'},invalidSession?401:200);
    if(url.includes('select=role'))return json([{role}]);
    if(url.includes('select=display_name'))return json([{display_name:'Arben Kola'}]);
    if(url.endsWith('audio/transcriptions'))return json({text:'Arben Kola raportin nesër'});
    return json({choices:[{message:{content:JSON.stringify({title:'Raporti',assignee:'Arben Kola, Person imagjinar',due:'2026-02-30',priority:'urgent'})}}]},providerStatus);
  };
  vm.runInNewContext(source,{Deno:{env:{get:name=>env[name]},serve:fn=>{handler=fn;}},
    fetch,Request,Response,File,FormData,Uint8Array,TextDecoder,AbortSignal,Intl});
  return {handler,calls};
}
const post=(body={text:'Arben Kola raportin nesër',today:'2026-10-28'},headers={})=>new Request('https://example.test/functions/v1/transcribe-task',{
  method:'POST',headers:{Authorization:'Bearer user-token','Content-Type':'application/json',...headers},body:JSON.stringify(body),
});
test('handles CORS without calling external services',async()=>{
  const app=endpoint();const result=await app.handler(new Request('https://example.test',{method:'OPTIONS'}));
  assert.equal(result.status,200);assert.equal(app.calls.length,0);assert.match(result.headers.get('Access-Control-Allow-Methods'),/POST/);
});
test('rejects unsupported methods and missing authentication',async()=>{
  const app=endpoint();assert.equal((await app.handler(new Request('https://example.test'))).status,405);
  assert.equal((await app.handler(post(undefined,{Authorization:''}))).status,401);assert.equal(app.calls.length,0);
});
test('expired sessions and employee roles cannot incur provider usage',async()=>{
  for(const options of [{invalidSession:true},{role:'employee'}]){
    const app=endpoint(options);const result=await app.handler(post());
    assert.equal(result.status,options.invalidSession?401:403);
    assert.ok(app.calls.every(c=>!c.url.includes('openai')));
  }
});
test('missing provider setup returns a safe actionable failure',async()=>{
  const app=endpoint({key:''});const result=await app.handler(post());
  assert.equal(result.status,503);assert.match((await result.json()).error,/konfiguruar/);
});
test('rejects oversized requests and invalid text before provider usage',async()=>{
  for(const request of [post(undefined,{'Content-Length':String(11*1024*1024)}),post({text:37}),post({text:'x'.repeat(6001)})]){
    const app=endpoint();const result=await app.handler(request);
    assert.ok([400,413].includes(result.status));assert.ok(app.calls.every(c=>!c.url.includes('openai')));
  }
});
test('valid requests use verified contacts and sanitize model output',async()=>{
  const app=endpoint();const result=await app.handler(post());assert.equal(result.status,200);
  const data=await result.json();assert.equal(data.draft.assignee,'Arben Kola');assert.equal(data.draft.due,'');assert.equal(data.draft.priority,'Mesme');
  const call=app.calls.find(c=>c.url.includes('openai'));
  const request=JSON.parse(call.options.body);const context=JSON.parse(request.messages[1].content);
  assert.deepEqual(context.people,['Arben Kola']);assert.equal(context.today,'2026-10-28');
  assert.equal(result.headers.get('Cache-Control'),'no-store');
});
test('audio is transcribed before creating a draft',async()=>{
  const app=endpoint();const form=new FormData();form.append('audio',new Blob(['audio'],{type:'audio/webm'}),'task.webm');form.append('today','2026-10-28');
  const result=await app.handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer user-token'},body:form}));
  assert.equal(result.status,200);assert.equal(app.calls.filter(c=>c.url.includes('openai')).length,2);
  assert.equal((await result.json()).transcript,'Arben Kola raportin nesër');
});
test('provider errors are not exposed verbatim to the browser',async()=>{
  const app=endpoint({providerStatus:429});const result=await app.handler(post());assert.equal(result.status,429);
  const data=await result.json();assert.match(data.error,/ngarkuar/);assert.ok(!JSON.stringify(data).includes('test-key'));
});
