const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const TaskAssistant=require('../task-assistant.js');
const VoiceDictation=require('../voice-dictation.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const code=html.slice(html.indexOf('/* TASK ASSISTANT:'),html.indexOf('/* ADD TASK */'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

/* ---------- deterministic browser-ish environment ---------- */
function clock(){
  let t=0,seq=0;const queue=new Map();
  return {
    now:()=>t,
    setTimeout(fn,ms){const id=++seq;queue.set(id,{fn,at:t+Math.max(0,Number(ms)||0),id});return id;},
    clearTimeout(id){queue.delete(id);},
    advance(ms){
      const target=t+ms;
      for(;;){
        const due=[...queue.values()].filter(x=>x.at<=target).sort((a,b)=>a.at-b.at||a.id-b.id);
        if(!due.length)break;
        const next=due[0];queue.delete(next.id);t=next.at;next.fn();
      }
      t=target;
    },
  };
}
function analysers(){const list=[];return list;}

function setup({invoke,mediaDevices,MediaRecorder,SpeechRecognition,role='owner',AudioContext=true,notify}={}){
  const els=new Map(),events={},windowEvents={};
  let saved=0,stopped=0,notified=0;
  const $=selector=>{
    if(!els.has(selector)){
      const classes=new Set();
      els.set(selector,{value:'',checked:false,disabled:false,textContent:'',hidden:false,style:{},
        classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,on){on?classes.add(c):classes.delete(c);}},
        setAttribute(){},focus(){document.activeElement=this;},addEventListener(name,fn){this[name]=fn;},querySelectorAll(){return [];}});
    }return els.get(selector);
  };
  const document={activeElement:null,addEventListener(name,fn){events[name]=fn;}};
  const state={chat:{contacts:[{name:'Arben Kola'}]},priority:'Mesme'};
  const time=clock();
  const rafQueue=new Map();let rafSeq=0;
  const requestAnimationFrame=cb=>{const id=++rafSeq;rafQueue.set(id,cb);return id;};
  const cancelAnimationFrame=id=>rafQueue.delete(id);
  const flushFrame=()=>{const due=[...rafQueue.values()];rafQueue.clear();due.forEach(cb=>cb(time.now()));};

  class FakeDate extends Date{constructor(...args){if(!args.length)super(time.now());else super(...args);}static now(){return time.now();}}

  let lastRecognizer=null;
  class FakeRecognition{
    constructor(){lastRecognizer=this;this.lang='';this.interimResults=false;this.continuous=false;this.started=0;this.stoppedAt=null;}
    start(){this.started++;}
    stop(){this.stoppedAt=this.stoppedAt??time.now();if(this.onend)this.onend();}
    abort(){this.aborted=true;if(this.onend)this.onend();}
    result(list){
      const results=list.map(item=>{const alt=[{transcript:item.text}];alt.isFinal=!!item.final;return alt;});
      this.onresult&&this.onresult({resultIndex:0,results});
    }
  }

  const analyserList=[];
  class FakeAnalyser{
    constructor(){this.fftSize=1024;this.level=0;analyserList.push(this);}
    getByteTimeDomainData(buffer){buffer.fill(Math.round(128+this.level*127));}
    connect(){}disconnect(){}
  }
  class FakeAudioContext{
    constructor(){this.state='running';this.closed=false;this.analyser=new FakeAnalyser();}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    createAnalyser(){return this.analyser;}
    resume(){return Promise.resolve();}
    close(){this.closed=true;return Promise.resolve();}
  }

  const stream={getTracks:()=>[{stop(){stopped++;}}]};
  const context=vm.createContext({
    $,$$:()=>[],document,state,cloud:{role},TaskAssistant,VoiceDictation,
    authClient:invoke?{functions:{invoke}}:null,toast(){},addTask(){saved++;},
    async notifyTaskChannels(){notified++;},
    Date:FakeDate,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,
    requestAnimationFrame,cancelAnimationFrame,
    window:{MediaRecorder,...(AudioContext?{AudioContext:FakeAudioContext}:{}),...(SpeechRecognition?{SpeechRecognition:FakeRecognition}:{}),
      addEventListener(name,fn){windowEvents[name]=fn;}},
    navigator:{mediaDevices:mediaDevices||{getUserMedia:async()=>stream}},
    MediaRecorder,AbortController,FormData,Blob,console,
  });
  vm.runInContext(code,context);

  const app={
    $,events,windowEvents,context,stream,
    get saved(){return saved;},
    get stopped(){return stopped;},
    get notified(){return notified;},
    get recognizer(){return lastRecognizer;},
    advance:time.advance,
    /* feed the microphone energy in 16 ms animation frames */
    feed(ms,level){
      const steps=Math.round(ms/16);
      for(let i=0;i<steps;i++){time.advance(16);const a=analyserList.at(-1);if(a)a.level=level;flushFrame();}
    },
    speak(ms,level=0.09){app.feed(ms,level);},
    quiet(ms,level=0.002){app.feed(ms,level);},
  };
  return app;
}
/* A recorder that emits one chunk when stopped. */
function recorderClass(){
  return class Recorder{
    static isTypeSupported(){return true;}
    constructor(){this.state='inactive';this.mimeType='audio/webm';}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable({data:new Blob(['audio'])});this.onstop();}
  };
}
const draft={transcript:'Arben Kola përgatit raportin nesër',draft:{title:'Përgatit raportin',assignee:'Arben Kola',due:'2026-10-29',priority:'Lart'}};

/* ---------- confirmation window: saving semantics ---------- */
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
  assert.equal(app.$('#voiceLive').classList.contains('show'),false);
});
test('cancel during permission prompt stops a late arriving media stream',async()=>{
  let resolve;const app=setup({mediaDevices:{getUserMedia:()=>new Promise(r=>{resolve=r;})},MediaRecorder:class{}});
  const pending=app.$('#voiceTaskBtn').onclick();app.events.keydown({key:'Escape'});resolve(app.stream);await pending;
  assert.equal(app.stopped,1);assert.equal(app.$('#voiceTaskBtn').disabled,false);assert.equal(app.saved,0);
});

/* ---------- live dictation ---------- */
test('one tap starts dictation and the transcript appears live',async()=>{
  const app=setup({SpeechRecognition:true,invoke:async()=>({data:draft})});
  await app.$('#voiceTaskBtn').onclick();
  assert.ok(app.$('#voiceLive').classList.contains('show'));
  assert.equal(app.$('#voiceLiveState').textContent,'Po dëgjoj…');
  assert.equal(app.recognizer.lang,'sq-AL');
  assert.equal(app.recognizer.interimResults,true);
  app.speak(400);
  app.recognizer.result([{text:'Arben Kola',final:false}]);
  assert.equal(app.$('#voiceLiveText').textContent,'Arben Kola','interim words shown immediately');
  app.recognizer.result([{text:'Arben Kola përgatit raportin',final:false}]);
  assert.equal(app.$('#voiceLiveText').textContent,'Arben Kola përgatit raportin');
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false,'nothing is confirmed while talking');
  assert.equal(app.saved,0);
  app.events.keydown({key:'Escape'});
  assert.equal(app.stopped,1);
});

test('three seconds of real silence stop the mic and open the confirmation',async()=>{
  let calls=0;
  const app=setup({SpeechRecognition:true,MediaRecorder:recorderClass(),
    invoke:async()=>{calls++;return {data:draft};}});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(500);
  app.recognizer.result([{text:'Arben Kola përgatit raportin',final:true}]);
  app.quiet(2800);
  assert.equal(app.stopped,0,'the microphone is still open before 3 s of silence');
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
  app.quiet(300);                                    // past 3 s
  await tick();
  assert.equal(app.stopped,1,'the microphone is released automatically');
  assert.equal(app.recognizer.stoppedAt!==null,true,'recognition stopped without a second tap');
  assert.equal(app.$('#voiceLive').classList.contains('show'),false);
  assert.equal(calls,1,'one AI proposal');
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
  assert.equal(app.$('#voiceDraftTitle').value,'Përgatit raportin');
  assert.equal(app.$('#voiceDraftDesc').value,'Arben Kola përgatit raportin nesër');
  assert.equal(app.$('#voiceDraftAssignee').value,'Arben Kola');
  assert.equal(app.$('#voiceDraftDue').value,'2026-10-29');
  assert.equal(app.$('#voiceDraftPriority').value,'Lart');
  assert.equal(app.$('#voiceDraftNotify').checked,false,'no notification is pre-selected');
  assert.equal(app.saved,0,'nothing is saved before confirmation');
  app.$('#voiceCancel').onclick();
  assert.equal(app.saved,0);assert.equal(app.notified,0);
});

test('talking again inside the 3 seconds restarts the countdown',async()=>{
  const app=setup({SpeechRecognition:true,MediaRecorder:recorderClass(),invoke:async()=>({data:draft})});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(400);
  app.recognizer.result([{text:'Dërgo faturat',final:false}]);
  app.quiet(2000);
  app.speak(400);                                    // owner resumes
  app.recognizer.result([{text:'Dërgo faturat te Arben Kola',final:false}]);
  app.quiet(2000);
  assert.equal(app.stopped,0,'the silence window restarted');
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
  app.quiet(1200);
  await tick();
  assert.equal(app.stopped,1);
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
});

test('no voice at all never opens the confirmation window',async()=>{
  let calls=0;
  const app=setup({SpeechRecognition:true,MediaRecorder:recorderClass(),invoke:async()=>{calls++;return {data:draft};}});
  await app.$('#voiceTaskBtn').onclick();
  app.quiet(3000);
  assert.equal(app.stopped,0,'silence alone does not end a dictation');
  app.advance(60000);
  await tick();
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
  assert.equal(calls,0,'no AI request for an empty recording');
  assert.equal(app.saved,0);
  assert.match(app.$('#assistantStatus').textContent,/Nuk u kap zë/);
});

test('the last words are kept and interim results are not repeated',async()=>{
  const app=setup({SpeechRecognition:true,MediaRecorder:recorderClass(),
    invoke:async()=>({data:{draft:draft.draft}})});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(600);
  app.recognizer.result([{text:'Arben Kola përgatit',final:false}]);
  app.recognizer.result([{text:'Arben Kola përgatit raportin',final:false}]);
  app.recognizer.result([{text:'Arben Kola përgatit raportin nesër',final:true}]);
  app.quiet(3100);
  await tick();
  const description=app.$('#voiceDraftDesc').value;
  assert.match(description,/nesër$/,'the final word is kept');
  assert.equal(description.match(/raportin/g).length,1,'no duplicated interim text');
  app.events.keydown({key:'Escape',preventDefault(){}});
});

test('cancelling a dictation releases the mic and sends nothing',async()=>{
  let calls=0;
  const app=setup({SpeechRecognition:true,MediaRecorder:recorderClass(),invoke:async()=>{calls++;return {data:draft};}});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(500);
  app.recognizer.result([{text:'Fshije këtë',final:false}]);
  app.events.keydown({key:'Escape'});
  app.advance(5000);
  await tick();
  assert.equal(app.stopped,1,'microphone released');
  assert.equal(app.$('#voiceLive').classList.contains('show'),false);
  assert.equal(calls,0,'no AI request after cancel');
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
  assert.equal(app.saved,0);
});

test('confirmation notifies only when the owner ticks it, and only once',async()=>{
  const app=setup({SpeechRecognition:true,MediaRecorder:recorderClass(),invoke:async()=>({data:draft})});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(500);
  app.recognizer.result([{text:'Arben Kola përgatit raportin nesër',final:true}]);
  app.quiet(3100);
  await tick();
  app.$('#voiceConfirm').onclick();
  assert.equal(app.saved,0,'the first confirm only reminds the owner about notifying');
  app.$('#voiceConfirm').onclick();
  assert.equal(app.saved,1);assert.equal(app.$('#notifyAllChannels').checked,false);
  assert.equal(app.notified,0,'no SMS/Email without an explicit choice');
});
test('unticked notification: the owner is reminded once, then can save without notifying',async()=>{
  const app=setup();app.$('#tTitle').value='Arben Kola përgatit raportin nesër';app.$('#aiTaskBtn').onclick();await tick();
  app.$('#voiceConfirm').onclick();
  assert.equal(app.saved,0,'nothing is saved on the reminder click');
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'),'the confirmation stays open');
  assert.match(app.$('#voiceDraftWarnings').textContent,/Kujtesë: punonjësi NUK do të njoftohet/);
  assert.equal(app.$('#voiceDraftNotify').checked,false,'the app never ticks the box for the owner');
  app.$('#voiceConfirm').onclick();app.$('#voiceConfirm').onclick();
  assert.equal(app.saved,1);assert.equal(app.$('#notifyAllChannels').checked,false);assert.equal(app.notified,0);
});
test('ticked notification: saved at once, no reminder',async()=>{
  const app=setup();app.$('#tTitle').value='Arben Kola përgatit raportin nesër';app.$('#aiTaskBtn').onclick();await tick();
  app.$('#voiceDraftNotify').checked=true;app.$('#voiceConfirm').onclick();
  assert.equal(app.saved,1);assert.equal(app.$('#notifyAllChannels').checked,true);
  assert.doesNotMatch(app.$('#voiceDraftWarnings').textContent,/Kujtesë/);
});
test('the reminder is shown again for every new proposal',async()=>{
  const app=setup();
  app.$('#tTitle').value='Raporti nesër';app.$('#aiTaskBtn').onclick();await tick();
  app.$('#voiceConfirm').onclick();app.$('#voiceCancel').onclick();
  app.$('#aiTaskBtn').onclick();await tick();app.$('#voiceConfirm').onclick();
  assert.equal(app.saved,0,'a new draft starts with a fresh reminder');
});

test('a browser without live transcription says so and still transcribes the audio',async()=>{
  let received=null;
  const app=setup({MediaRecorder:recorderClass(),invoke:async(name,options)=>{received=options.body;return {data:draft};}});
  await app.$('#voiceTaskBtn').onclick();
  assert.match(app.$('#voiceLiveHint').textContent,/nuk transkripton drejtpërdrejt/);
  app.speak(400);
  await app.$('#voiceTaskBtn').onclick();           // manual stop, no recogniser available
  await tick();await tick();
  assert.ok(received instanceof FormData,'the audio is sent to the server for transcription');
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
  assert.equal(app.stopped,1);
});

test('a browser without an audio meter still ends the dictation',async()=>{
  const app=setup({AudioContext:false,SpeechRecognition:true,MediaRecorder:recorderClass(),invoke:async()=>({data:draft})});
  await app.$('#voiceTaskBtn').onclick();
  assert.match(app.$('#voiceLiveHint').textContent,/nuk mat zërin/);
  app.advance(1000);
  app.recognizer.result([{text:'Raporti',final:true}]);   // recognition activity drives the timer
  app.advance(3000);
  await tick();
  assert.equal(app.stopped,1);
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
});


/* ---------- making failures visible (mobile without devtools) ---------- */
function httpError(status,body){
  const response={status,json:async()=>body,clone(){return response;}};
  return {context:response,name:'FunctionsHttpError',message:'Edge Function returned a non-2xx status code'};
}
test('a server failure is reported with its real reason and details',async()=>{
  const app=setup({MediaRecorder:recorderClass(),
    invoke:async()=>({error:httpError(404,{code:404,message:'Requested function was not found'})})});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(500);
  await app.$('#voiceTaskBtn').onclick();
  await tick();await tick();
  assert.match(app.$('#assistantStatus').textContent,/Audioja nuk u transkriptua: Requested function was not found/);
  assert.ok(app.$('#assistantDiagBox').classList.contains('show'),'the details box is visible');
  const details=app.$('#assistantDiag').textContent;
  assert.match(details,/arsyeja: Requested function was not found/);
  assert.match(details,/hyrja:/);
  assert.match(details,/audio: /);
  assert.equal(app.saved,0);
});
test('a missing key or expired session is quoted from the function body',async()=>{
  const app=setup({invoke:async()=>({data:{error:'Sesioni ka skaduar. Hyr përsëri.'}})});
  app.$('#tTitle').value='Raporti';app.$('#aiTaskBtn').onclick();await tick();
  assert.match(app.$('#assistantStatus').textContent,/Sesioni ka skaduar/);
});
test('audio recorded without a MIME type is still sent as a valid container',async()=>{
  let body=null;
  class Untyped extends recorderClass(){
    constructor(){super();this.mimeType='';}            // Samsung Internet reports an empty type
  }
  const app=setup({MediaRecorder:Untyped,invoke:async(name,options)=>{body=options.body;return {data:draft};}});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(500);
  await app.$('#voiceTaskBtn').onclick();
  await tick();await tick();
  const file=body.get('audio');
  assert.equal(file.type,'audio/webm','a usable container type is supplied');
  assert.ok(file.size>0);
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
});
test('a recorder without isTypeSupported still records',async()=>{
  let body=null;
  class Simple{
    constructor(){this.state='inactive';this.mimeType='';}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable({data:new Blob(['audio'])});this.onstop();}
  }
  delete Simple.isTypeSupported;
  const app=setup({MediaRecorder:Simple,invoke:async(name,options)=>{body=options.body;return {data:draft};}});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(500);
  await app.$('#voiceTaskBtn').onclick();
  await tick();await tick();
  assert.ok(body,'the audio reaches the server');
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
});
test('no recorded audio and no transcript never calls the AI',async()=>{
  let calls=0;
  class Silent{constructor(){this.state='inactive';this.mimeType='audio/webm';}
    start(){this.state='recording';}stop(){this.state='inactive';this.onstop();}}  // no data chunks
  const app=setup({MediaRecorder:Silent,invoke:async()=>{calls++;return {data:draft};}});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(500);
  await app.$('#voiceTaskBtn').onclick();
  await tick();await tick();
  assert.equal(calls,0,'an empty request is never sent');
  assert.match(app.$('#assistantStatus').textContent,/Mikrofoni nuk dha audio/);
  assert.equal(app.saved,0);
});
test('live transcript sends ONLY text and never uploads recorded audio',async()=>{
  let sentBody=null;
  const app=setup({
    SpeechRecognition:true,
    MediaRecorder:recorderClass(),
    invoke:async(_name,options)=>{sentBody=options.body;return {data:draft};},
  });
  await app.$('#voiceTaskBtn').onclick();
  app.speak(500);
  app.recognizer.result([{text:'Cakto Arben Kola të përgatisë raportin nesër urgjent',final:true}]);
  app.quiet(3100);
  await tick();await tick();
  assert.equal(sentBody instanceof FormData,false,'must never upload FormData audio when live text exists');
  assert.equal(typeof sentBody.text,'string');
  assert.equal(sentBody.text,'Cakto Arben Kola të përgatisë raportin nesër urgjent');
  assert.equal('audio' in sentBody,false);
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
});
test('server down or missing provider falls back to TaskAssistant.parse and opens confirmation with clear local note',async()=>{
  for(const failure of [
    httpError(503,{error:'Asnjë ofrues AI nuk është konfiguruar. Përdor përpunimin lokal.',code:'no_provider'}),
    httpError(429,{error:'Kredia e ofruesit AI ka mbaruar. Përdor një çelës falas (Groq) ose shto kredi.',code:'quota_exceeded'}),
    new Error('Failed to fetch'),
  ]){
    const app=setup({
      SpeechRecognition:true,
      MediaRecorder:recorderClass(),
      invoke:async()=>({error:failure}),
    });
    await app.$('#voiceTaskBtn').onclick();
    app.speak(500);
    app.recognizer.result([{text:'Cakto Arben Kola përgatit raportin nesër urgjent',final:true}]);
    app.quiet(3100);
    await tick();await tick();
    assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'),'confirmation opens automatically with local draft');
    assert.equal(app.$('#voiceDraftSource').textContent,'Përpunim lokal — AI nuk u përdor');
    assert.equal(app.$('#voiceDraftTitle').value,'Përgatit raportin');
    assert.equal(app.$('#voiceDraftAssignee').value,'Arben Kola');
    assert.equal(app.$('#voiceDraftPriority').value,'Lart');
    assert.equal(app.saved,0,'nothing saved before explicit confirmation');
    app.$('#voiceCancel').onclick();
  }
});
test('empty server transcript never opens confirmation',async()=>{
  const app=setup({
    MediaRecorder:recorderClass(),
    invoke:async()=>({data:{transcript:'   ',draft:{title:'Halucinim',assignee:'',due:'',priority:'Mesme'}}}),
  });
  await app.$('#voiceTaskBtn').onclick();
  app.speak(500);
  await app.$('#voiceTaskBtn').onclick();
  await tick();await tick();
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
  assert.equal(app.saved,0);
});
test('pagehide releases microphone and discards late AI responses',async()=>{
  let calls=0,resolve;
  const app=setup({
    SpeechRecognition:true,
    MediaRecorder:recorderClass(),
    invoke:()=>{calls++;return new Promise(r=>{resolve=r;});},
  });
  await app.$('#voiceTaskBtn').onclick();
  app.speak(400);
  app.windowEvents.pagehide();
  assert.equal(app.stopped,1,'microphone released on pagehide');
  assert.equal(calls,0,'no AI call made when pagehide aborts dictation');

  app.$('#tTitle').value='Raporti nesër';
  app.$('#aiTaskBtn').onclick();
  assert.equal(calls,1);
  app.windowEvents.pagehide();
  resolve({data:draft});
  await tick();
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false,'late AI response discarded after pagehide');
});

