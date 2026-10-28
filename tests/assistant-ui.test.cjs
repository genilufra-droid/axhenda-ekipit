const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const TaskAssistant=require('../task-assistant.js');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const code=html.slice(html.indexOf('/* TASK ASSISTANT:'),html.indexOf('/* ADD TASK */'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup({invoke,mediaDevices,MediaRecorder,role='owner'}={}){
  const els=new Map(),events={},windowEvents={};let saved=0,stopped=0;
  const $=selector=>{
    if(!els.has(selector)){
      const classes=new Set();
      els.set(selector,{value:'',checked:false,disabled:false,textContent:'',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(){}},
        setAttribute(){},focus(){document.activeElement=this;},addEventListener(name,fn){this[name]=fn;},querySelectorAll(){return [];}});
    }return els.get(selector);
  };
  const document={activeElement:null,addEventListener(name,fn){events[name]=fn;}};
  const state={chat:{contacts:[{name:'Arben Kola'}]},priority:'Mesme'};
  const context=vm.createContext({$, $$:()=>[],document,state,cloud:{role},TaskAssistant,
    authClient:invoke?{functions:{invoke}}:null,toast(){},addTask(){saved++;},
    window:{MediaRecorder,addEventListener(name,fn){windowEvents[name]=fn;}},navigator:{mediaDevices},MediaRecorder,
    AbortController,FormData,Blob,setTimeout,clearTimeout,console});
  vm.runInContext(code,context);
  return {$,events,windowEvents,context,get saved(){return saved;},stream:{getTracks:()=>[{stop(){stopped++;}}]},get stopped(){return stopped;}};
}
test('offline text creates only a review draft; cancelling preserves composer',async()=>{
  const app=setup();app.$('#tTitle').value='Arben Kola përgatit raportin nesër';
  app.$('#aiTaskBtn').onclick();await tick();
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
  assert.equal(app.saved,0);assert.equal(app.$('#voiceDraftNotify').checked,false);
  assert.match(app.$('#voiceDraftSource').textContent,/lokal/);
  app.$('#voiceCancel').onclick();assert.match(app.$('#tTitle').value,/Arben/);assert.equal(app.saved,0);
});
test('empty title keeps draft open; confirmation saves exactly once',async()=>{
  const app=setup();app.$('#tTitle').value='Arben Kola raportin sot';app.$('#aiTaskBtn').onclick();await tick();
  app.$('#voiceDraftTitle').value=' ';app.$('#voiceConfirm').onclick();assert.equal(app.saved,0);
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
  app.$('#voiceDraftTitle').value='Raporti';app.$('#voiceConfirm').onclick();app.$('#voiceConfirm').onclick();
  assert.equal(app.saved,1);assert.equal(app.$('#notifyAllChannels').checked,false);
});
test('notification opt-in requires an assignee',async()=>{
  const app=setup();app.$('#tTitle').value='Raporti nesër';app.$('#aiTaskBtn').onclick();await tick();
  app.$('#voiceDraftNotify').checked=true;app.$('#voiceConfirm').onclick();assert.equal(app.saved,0);
  app.$('#voiceDraftAssignee').value='Arben Kola';app.$('#voiceConfirm').onclick();assert.equal(app.saved,1);
  assert.equal(app.$('#notifyAllChannels').checked,true);
});
test('late AI responses cannot reopen cancelled requests',async()=>{
  let resolve;const app=setup({invoke:()=>new Promise(r=>{resolve=r;})});
  app.$('#tTitle').value='Raporti';app.$('#aiTaskBtn').onclick();
  app.events.keydown({key:'Escape'});
  resolve({data:{transcript:'Raporti',draft:{title:'Raporti'}}});await tick();
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
  assert.equal(app.$('#aiTaskBtn').disabled,false);assert.equal(app.saved,0);
});
test('repeated clicks do not launch concurrent AI requests',async()=>{
  let calls=0,resolve;const app=setup({invoke:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  app.$('#tTitle').value='Raporti';app.$('#aiTaskBtn').onclick();app.$('#aiTaskBtn').onclick();
  assert.equal(calls,1);resolve({error:new Error('offline')});await tick();assert.equal(app.saved,0);
});
test('employees cannot prepare or confirm a task',async()=>{
  const app=setup({role:'employee'});app.$('#tTitle').value='Raporti';app.$('#aiTaskBtn').onclick();
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
  vm.runInContext("showVoiceDraft('Raporti')",app.context);app.$('#voiceConfirm').onclick();assert.equal(app.saved,0);
});
test('microphone permission failure restores usable controls',async()=>{
  const app=setup({mediaDevices:{getUserMedia:async()=>{throw new Error('denied');}},MediaRecorder:class{}});
  await app.$('#voiceTaskBtn').onclick();assert.equal(app.$('#voiceTaskBtn').disabled,false);
  assert.equal(app.$('#aiTaskBtn').disabled,false);assert.match(app.$('#assistantStatus').textContent,/Mikrofoni nuk u hap/);
});
test('cancel during permission prompt stops a late arriving media stream',async()=>{
  let resolve;const app=setup({mediaDevices:{getUserMedia:()=>new Promise(r=>{resolve=r;})},MediaRecorder:class{}});
  const pending=app.$('#voiceTaskBtn').onclick();app.events.keydown({key:'Escape'});resolve(app.stream);await pending;
  assert.equal(app.stopped,1);assert.equal(app.$('#voiceTaskBtn').disabled,false);assert.equal(app.saved,0);
});
test('manual recording stop releases microphone and sends audio once',async()=>{
  let recorder,calls=0;
  class Recorder{
    static isTypeSupported(){return true;}
    constructor(){recorder=this;this.state='inactive';this.mimeType='audio/webm';}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable({data:new Blob(['audio'])});this.onstop();}
  }
  const app=setup({MediaRecorder:Recorder,mediaDevices:{getUserMedia:async()=>app.stream},
    invoke:async()=>{calls++;return {data:{transcript:'Raporti nesër',draft:{title:'Raporti',due:'2026-10-29'}}};}});
  await app.$('#voiceTaskBtn').onclick();assert.equal(recorder.state,'recording');
  await app.$('#voiceTaskBtn').onclick();await tick();
  assert.equal(recorder.state,'inactive');assert.equal(app.stopped,1);assert.equal(calls,1);
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));assert.equal(app.saved,0);
});
