const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(require('node:path').join(__dirname,'../supabase/functions/transcribe-task/index.ts'),'utf8'));

const GROQ='https://api.groq.com/openai/v1/', OPENAI='https://api.openai.com/v1/';
const NO_CREDITS={error:{message:'You have no credits remaining',type:'insufficient_quota'}};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const modelDraft={title:'Raporti',assignee:'Arben Kola, Person imagjinar',due:'2026-02-30',priority:'urgent'};
const chatOk=(draft=modelDraft,fence=false)=>({status:200,body:{choices:[{message:{content:fence?'```json\n'+JSON.stringify(draft)+'\n```':JSON.stringify(draft)}}]}});
const speechOk={status:200,body:{text:'Arben Kola raportin nesër'}};

/* secrets: which provider keys exist; behavior: how each provider answers (default = success) */
function endpoint({role='owner',invalidSession=false,secrets={OPENAI_API_KEY:'test-key'},behavior={}}={}){
  let handler;const calls=[];
  const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',...secrets};
  const fetch=async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/auth/v1/user'))return json({id:'verified-user'},invalidSession?401:200);
    if(url.includes('select=role'))return json([{role}]);
    if(url.includes('select=display_name'))return json([{display_name:'Arben Kola'}]);
    const name=url.startsWith(GROQ)?'groq':url.startsWith(OPENAI)?'openai':null;
    if(!name)throw new Error('unexpected external call '+url);
    const step=url.endsWith('audio/transcriptions')?'transcribe':'chat';
    const planned=behavior[name]?.[step]||(step==='transcribe'?speechOk:chatOk());
    return json(planned.body,planned.status);
  };
  vm.runInNewContext(source,{Deno:{env:{get:name=>env[name]},serve:fn=>{handler=fn;}},
    fetch,Request,Response,File,FormData,Uint8Array,TextDecoder,AbortSignal,Intl});
  return {handler,calls,
    provider:name=>calls.filter(c=>c.url.startsWith(name==='groq'?GROQ:OPENAI)),
    external:()=>calls.filter(c=>c.url.startsWith(GROQ)||c.url.startsWith(OPENAI))};
}
const post=(body={text:'Arben Kola raportin nesër',today:'2026-10-28'},headers={})=>new Request('https://example.test/functions/v1/transcribe-task',{
  method:'POST',headers:{Authorization:'Bearer user-token','Content-Type':'application/json',...headers},body:JSON.stringify(body),
});
const audioPost=()=>{
  const form=new FormData();form.append('audio',new Blob(['audio'],{type:'audio/webm'}),'task.webm');form.append('today','2026-10-28');
  return new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer user-token'},body:form});
};
const body=call=>JSON.parse(call.options.body);
const bothKeys={GROQ_API_KEY:'groq-secret',OPENAI_API_KEY:'openai-secret'};
const SAFE=data=>{const text=JSON.stringify(data);assert.ok(!/groq-secret|openai-secret|test-key|no credits|insufficient_quota|Bearer/i.test(text),'nothing technical or secret reaches the browser');};

/* ---------- existing guarantees ---------- */
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
    const app=endpoint({...options,secrets:bothKeys});const result=await app.handler(post());
    assert.equal(result.status,options.invalidSession?401:403);
    assert.equal(app.external().length,0);
    if(options.invalidSession)assert.match((await result.json()).error,/Sesioni ka skaduar/);
  }
});
test('rejects oversized requests and invalid text before provider usage',async()=>{
  for(const request of [post(undefined,{'Content-Length':String(11*1024*1024)}),post({text:37}),post({text:'x'.repeat(6001)})]){
    const app=endpoint({secrets:bothKeys});const result=await app.handler(request);
    assert.ok([400,413].includes(result.status));assert.equal(app.external().length,0);
  }
});
test('valid requests use verified contacts and sanitize model output',async()=>{
  const app=endpoint();const result=await app.handler(post());assert.equal(result.status,200);
  const data=await result.json();
  assert.deepEqual(Object.keys(data).sort(),['draft','transcript'],'response contract: {transcript, draft}');
  assert.deepEqual(Object.keys(data.draft).sort(),['assignee','due','priority','title']);
  assert.equal(data.transcript,'Arben Kola raportin nesër');
  assert.equal(data.draft.assignee,'Arben Kola');assert.equal(data.draft.due,'');assert.equal(data.draft.priority,'Mesme');
  const request=body(app.provider('openai')[0]);const context=JSON.parse(request.messages[1].content);
  assert.deepEqual(context.people,['Arben Kola']);assert.equal(context.today,'2026-10-28');
  assert.equal(result.headers.get('Cache-Control'),'no-store');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'),'*');
  SAFE(data);
});

/* ---------- provider selection by secret ---------- */
test('only GROQ_API_KEY: audio and proposal go to Groq, OpenAI is never called',async()=>{
  const app=endpoint({secrets:{GROQ_API_KEY:'groq-secret'}});
  const result=await app.handler(audioPost());assert.equal(result.status,200);
  const data=await result.json();assert.equal(data.transcript,'Arben Kola raportin nesër');assert.equal(data.draft.assignee,'Arben Kola');
  assert.equal(app.provider('openai').length,0);
  const [speech,chat]=app.provider('groq');
  assert.equal(speech.url,'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(speech.options.body.get('model'),'whisper-large-v3-turbo');assert.equal(speech.options.body.get('language'),'sq');
  assert.equal(speech.options.headers.Authorization,'Bearer groq-secret');
  assert.equal(chat.url,'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(body(chat).model,'llama-3.3-70b-versatile');assert.deepEqual(body(chat).response_format,{type:'json_object'});
  assert.match(body(chat).messages[0].content,/JSON/);
  SAFE(data);
});
test('only OPENAI_API_KEY keeps the current behaviour',async()=>{
  const app=endpoint({secrets:{OPENAI_API_KEY:'openai-secret'}});
  const result=await app.handler(audioPost());assert.equal(result.status,200);
  assert.equal(app.provider('groq').length,0);
  const [speech,chat]=app.provider('openai');
  assert.equal(speech.options.body.get('model'),'whisper-1');assert.equal(speech.options.body.get('language'),'sq');
  assert.equal(body(chat).model,'gpt-4o-mini');assert.equal(body(chat).response_format.type,'json_schema');
  assert.equal(speech.options.headers.Authorization,'Bearer openai-secret');
});
test('both keys: Groq is preferred and OpenAI stays unused while Groq works',async()=>{
  const app=endpoint({secrets:bothKeys});
  const result=await app.handler(audioPost());assert.equal(result.status,200);
  assert.equal(app.provider('groq').length,2);assert.equal(app.provider('openai').length,0);
});
test('no provider secret: 503 with no external call',async()=>{
  for(const request of [post(),audioPost()]){
    const app=endpoint({secrets:{}});const result=await app.handler(request);
    assert.equal(result.status,503);const data=await result.json();
    assert.match(data.error,/konfiguruar/);assert.equal(data.code,'no_provider');
    assert.equal(app.external().length,0);
  }
});
test('task model overrides come from secrets',async()=>{
  const app=endpoint({secrets:{...bothKeys,GROQ_TASK_MODEL:'groq-custom'}});await app.handler(post());
  assert.equal(body(app.provider('groq')[0]).model,'groq-custom');
});
test('Groq answers wrapped in a code fence are still parsed',async()=>{
  const app=endpoint({secrets:{GROQ_API_KEY:'groq-secret'},behavior:{groq:{chat:chatOk({title:'Raporti',assignee:'Arben Kola',due:'2026-10-29',priority:'Lart'},true)}}});
  const data=await (await app.handler(post())).json();
  assert.deepEqual(data.draft,{title:'Raporti',assignee:'Arben Kola',due:'2026-10-29',priority:'Lart'});
});

/* ---------- fallback between providers ---------- */
test('audio: Groq out of quota falls back to OpenAI for transcription and proposal',async()=>{
  const app=endpoint({secrets:bothKeys,behavior:{groq:{transcribe:{status:429,body:NO_CREDITS}}}});
  const result=await app.handler(audioPost());assert.equal(result.status,200);
  const data=await result.json();assert.equal(data.transcript,'Arben Kola raportin nesër');assert.equal(data.draft.assignee,'Arben Kola');
  assert.equal(app.provider('groq').length,1,'Groq tried once and abandoned');
  assert.equal(app.provider('openai').length,2,'OpenAI did the transcription and the proposal');
  SAFE(data);
});
test('text: an unusable Groq proposal falls back to OpenAI',async()=>{
  const app=endpoint({secrets:bothKeys,behavior:{groq:{chat:{status:200,body:NO_CREDITS}}}});
  // 200 with an error body is an invalid proposal -> next provider
  const data=await (await app.handler(post())).json();
  assert.equal(app.provider('groq').length,1);assert.equal(app.provider('openai').length,1);
  assert.equal(data.draft.title,'Raporti');
});
test('fallback also covers quota reported with a 429 on the proposal step',async()=>{
  const app=endpoint({secrets:bothKeys,behavior:{groq:{chat:{status:429,body:NO_CREDITS}}}});
  const result=await app.handler(post());assert.equal(result.status,200);
  assert.equal(app.provider('openai').length,1);
});
test('transcription done by OpenAI keeps OpenAI first for the proposal',async()=>{
  const app=endpoint({secrets:bothKeys,behavior:{groq:{transcribe:{status:500,body:{}}}}});
  await app.handler(audioPost());
  assert.deepEqual(app.external().map(c=>c.url.replace(/^https:\/\/api\.(\w+)\..*\/(audio|chat)\/.*/,'$1:$2')),['groq:audio','openai:audio','openai:chat']);
});

/* ---------- readable, safe errors ---------- */
test('"no credits" is reported with the new message and no provider text',async()=>{
  const app=endpoint({secrets:{OPENAI_API_KEY:'test-key'},behavior:{openai:{chat:{status:429,body:NO_CREDITS}}}});
  const result=await app.handler(post());assert.equal(result.status,429);
  const data=await result.json();
  assert.equal(data.error,'Kredia e ofruesit AI ka mbaruar. Përdor një çelës falas (Groq) ose shto kredi.');
  assert.equal(data.code,'quota');SAFE(data);
  assert.equal(result.headers.get('Cache-Control'),'no-store');
});
test('quota reported by text on a non-429 status is still recognised',async()=>{
  const app=endpoint({secrets:{OPENAI_API_KEY:'test-key'},behavior:{openai:{transcribe:{status:400,body:NO_CREDITS}}}});
  const result=await app.handler(audioPost());assert.equal(result.status,429);
  const data=await result.json();assert.equal(data.code,'quota');SAFE(data);
});
test('every provider out of credits gives the quota message',async()=>{
  const app=endpoint({secrets:bothKeys,behavior:{groq:{transcribe:{status:429,body:NO_CREDITS}},openai:{transcribe:{status:429,body:NO_CREDITS}}}});
  const result=await app.handler(audioPost());assert.equal(result.status,429);
  assert.equal((await result.json()).code,'quota');assert.equal(app.external().length,2);
});
test('provider outages and rejected provider keys never look like an expired session',async()=>{
  const down=endpoint({secrets:bothKeys,behavior:{groq:{chat:{status:500,body:{}}},openai:{chat:{status:503,body:{}}}}});
  const a=await down.handler(post());assert.equal(a.status,502);assert.equal((await a.json()).code,'provider_failed');
  const badKey=endpoint({secrets:{GROQ_API_KEY:'groq-secret'},behavior:{groq:{chat:{status:401,body:{error:{message:'Invalid API Key groq-secret'}}}}}});
  const b=await badKey.handler(post());assert.equal(b.status,502,'a 401 from the provider is not the user\'s 401');
  const data=await b.json();assert.equal(data.code,'provider_auth');SAFE(data);
});
test('audio is transcribed once; if the proposal fails the transcript is returned for local parsing',async()=>{
  const app=endpoint({secrets:bothKeys,behavior:{groq:{chat:{status:429,body:NO_CREDITS}},openai:{chat:{status:429,body:NO_CREDITS}}}});
  const result=await app.handler(audioPost());assert.equal(result.status,200);
  const data=await result.json();
  assert.equal(data.transcript,'Arben Kola raportin nesër');assert.equal(data.draft,null);
  assert.equal(data.code,'quota');assert.match(data.warning,/Kredia e ofruesit AI ka mbaruar/);SAFE(data);
  assert.equal(app.calls.filter(c=>c.url.endsWith('audio/transcriptions')).length,1,'transcription is never paid twice');
});
test('empty transcription is a safe 422',async()=>{
  const app=endpoint({secrets:{GROQ_API_KEY:'groq-secret'},behavior:{groq:{transcribe:{status:200,body:{text:'  '}}}}});
  const result=await app.handler(audioPost());assert.equal(result.status,422);
  assert.equal(app.provider('groq').length,1,'no proposal request for an empty transcript');
});
