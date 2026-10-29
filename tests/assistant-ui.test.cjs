const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const TaskAssistant=require('../task-assistant.js');
const VoiceDictation=require('../voice-dictation.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const code=html.slice(html.indexOf('/* TASK ASSISTANT:'),html.indexOf('/* ADD TASK */'));
const composerCode=html.slice(html.indexOf('/* COMPOSER: expand desc on focus */'),html.indexOf('/* FILES */'));
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

function setup({invoke,mediaDevices,MediaRecorder,SpeechRecognition,role='owner',AudioContext=true,notify,userAgent='',maxTouchPoints=0}={}){
  const els=new Map(),events={},windowEvents={};
  let saved=0,stopped=0,notified=0;
  const $=selector=>{
    if(!els.has(selector)){
      const classes=new Set(),listeners={};
      els.set(selector,{value:'',checked:false,disabled:false,textContent:'',hidden:false,style:{},
        selectionStart:0,selectionEnd:0,scrollLeft:0,scrollWidth:800,focusCount:0,
        classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,on){on?classes.add(c):classes.delete(c);}},
        setAttribute(){},
        setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},
        focus(){this.focusCount++;document.activeElement=this;(listeners.focus||[]).forEach(fn=>fn({target:this}));},
        addEventListener(name,fn){(listeners[name]||=[]).push(fn);},
        dispatchEvent(event){(listeners[event.type]||[]).forEach(fn=>fn(event));},
        querySelectorAll(){return [];}});
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
    navigator:{mediaDevices:mediaDevices||{getUserMedia:async()=>stream},userAgent,maxTouchPoints},
    MediaRecorder,AbortController,FormData,Blob,console,
  });
  vm.runInContext(composerCode,context);
  vm.runInContext(code,context);

  const app={
    $,document,events,windowEvents,context,stream,
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
  assert.equal(app.$('#tTitle').value,'Arben Kola','interim words shown immediately');
  app.recognizer.result([{text:'Arben Kola përgatit raportin',final:false}]);
  assert.equal(app.$('#tTitle').value,'Arben Kola përgatit raportin');
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false,'nothing is confirmed while talking');
  assert.equal(app.saved,0);
  app.events.keydown({key:'Escape'});
  assert.equal(app.$('#tTitle').value,'','cancelling restores an originally empty composer');
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


/* ---------- real phones: one microphone owner, full audio, no cut words ---------- */
const PHONE_UA='Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

test('on a phone the live text appears while talking and the full audio still goes to the server',async()=>{
  let sent=null,calls=0;
  const app=setup({
    userAgent:PHONE_UA,maxTouchPoints:5,
    SpeechRecognition:true,MediaRecorder:recorderClass(),
    invoke:async(_name,options)=>{calls++;sent=options.body;return {data:draft};},
  });
  await app.$('#voiceTaskBtn').onclick();
  assert.equal(app.recognizer,null,'the recorder takes the microphone first; the recogniser follows');
  assert.equal(app.$('#voiceLiveState').textContent,'Po dëgjoj…');
  assert.doesNotMatch(app.$('#voiceLiveHint').textContent,/mikrofonin e mban regjistrimi/,'the old phone hint is gone');
  app.advance(200);                                  // the recogniser joins a moment later
  assert.ok(app.recognizer,'live text is available on the phone too');
  assert.equal(app.recognizer.lang,'sq-AL');
  app.speak(500);
  app.recognizer.result([{text:'Cakto Arben Kola',final:false}]);
  assert.equal(app.$('#tTitle').value,'Cakto Arben Kola','the words appear WHILE the owner speaks');
  app.recognizer.result([{text:'Cakto Arben Kola të përgatisë raportin',final:false}]);
  assert.equal(app.$('#tTitle').value,'Cakto Arben Kola të përgatisë raportin');
  assert.equal(app.$('#voiceLiveMeterBar').style.transform.includes('scaleX'),true,'the live meter still works');
  app.quiet(2800);
  assert.equal(app.stopped,0,'the microphone is still open before 3 s of silence');
  assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false,'nothing is sent while talking');
  app.quiet(400);
  await tick();await tick();
  assert.equal(calls,1,'exactly one request');
  assert.ok(sent instanceof FormData,'the complete recording is uploaded, never the live preview');
  assert.ok(sent.get('audio').size>0);
  assert.equal(app.stopped,1,'the microphone is released');
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
  assert.equal(app.$('#voiceDraftSource').textContent,'Propozim nga AI — kontrolloje para ruajtjes');
  app.$('#voiceCancel').onclick();
  assert.equal(app.saved,0);
});

test('the live words are a preview: the final text still comes from the complete audio',async()=>{
  const heard='Cakto Arben Kola të përgatisë raportin për nesër';
  let sent=null;
  const app=setup({
    userAgent:PHONE_UA,maxTouchPoints:5,
    SpeechRecognition:true,MediaRecorder:recorderClass(),
    invoke:async(_name,options)=>{sent=options.body;return {data:{transcript:heard,draft:draft.draft}};},
  });
  await app.$('#voiceTaskBtn').onclick();
  app.advance(200);
  app.speak(500);
  app.recognizer.result([{text:'cakto arben kola',final:false}]);   // the imperfect preview
  assert.equal(app.$('#tTitle').value,'cakto arben kola','the composer shows the words immediately');
  app.recognizer.result([{text:'cakto arben kola raportin',final:true}]);
  app.quiet(3100);
  await tick();await tick();
  assert.ok(sent instanceof FormData,'the audio is what the server transcribes');
  assert.ok(sent.get('audio').size>0);
  assert.equal(app.$('#tTitle').value,heard,'the server transcript replaces the live preview when the prefix is empty');
  assert.equal(app.$('#voiceDraftDesc').value,heard,'the saved text is the one the audio produced, not the preview');
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
  app.$('#voiceCancel').onclick();
});

test('on a phone without a signed-in server the live text still appears (offline mode)',async()=>{
  const app=setup({userAgent:PHONE_UA,maxTouchPoints:5,SpeechRecognition:true,MediaRecorder:recorderClass()});
  await app.$('#voiceTaskBtn').onclick();
  assert.equal(app.recognizer,null,'the recogniser waits for the recorder to grab the microphone');
  app.advance(200);
  assert.ok(app.recognizer,'offline the recogniser still supplies the live text');
  assert.equal(app.$('#voiceLiveState').textContent,'Po dëgjoj…');
  app.speak(400);
  app.recognizer.result([{text:'Raporti',final:false}]);
  assert.equal(app.$('#tTitle').value,'Raporti');
  app.events.keydown({key:'Escape'});
  assert.equal(app.stopped,1);
});

test('a desktop recognition that restarts sends the complete audio, not the cut text',async()=>{
  let sent=null;
  const app=setup({
    SpeechRecognition:true,MediaRecorder:recorderClass(),
    invoke:async(_name,options)=>{sent=options.body;return {data:draft};},
  });
  await app.$('#voiceTaskBtn').onclick();
  app.speak(400);
  app.recognizer.result([{text:'Cakto Arben Kola',final:false}]);
  app.recognizer.onend();                       // Chrome closes the session on a short pause
  app.advance(0);                               // restart without the old 250 ms gap
  assert.equal(app.recognizer.started,2,'the session is restarted immediately');
  assert.equal(app.$('#tTitle').value,'Cakto Arben Kola','the first words are never erased');
  app.speak(300);
  app.recognizer.result([{text:'përgatit raportin nesër',final:false}]);
  assert.equal(app.$('#tTitle').value,'Cakto Arben Kola përgatit raportin nesër');
  app.quiet(3100);
  await tick();await tick();
  assert.ok(sent instanceof FormData,'the full recording goes to Whisper');
  assert.ok(sent.get('audio').size>0);
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
  app.$('#voiceCancel').onclick();
});

test('a normal restart is immediate while a storm of restarts gets a short breather',async()=>{
  const app=setup({SpeechRecognition:true,MediaRecorder:recorderClass(),invoke:async()=>({data:draft})});
  await app.$('#voiceTaskBtn').onclick();
  app.speak(400);
  for(let i=1;i<=3;i++){
    const before=app.recognizer.started;
    app.recognizer.onend();
    app.advance(0);
    assert.equal(app.recognizer.started,before+1,'restart '+(i+1)+' happens at once: no syllable is lost');
  }
  const started=app.recognizer.started;
  app.recognizer.onend();                       // a fourth restart inside 2 s
  app.advance(149);
  assert.equal(app.recognizer.started,started,'a restart storm waits before touching the microphone again');
  app.advance(1);
  assert.equal(app.recognizer.started,started+1,'after the short pause the live text resumes');
  app.events.keydown({key:'Escape'});
  assert.equal(app.stopped,1);
});

test('a failed live recogniser also uploads the audio',async()=>{
  let sent=null;
  const app=setup({
    SpeechRecognition:true,MediaRecorder:recorderClass(),
    invoke:async(_name,options)=>{sent=options.body;return {data:draft};},
  });
  await app.$('#voiceTaskBtn').onclick();
  app.speak(400);
  app.recognizer.onerror({error:'network'});
  app.recognizer.result([{text:'Raporti',final:false}]);
  app.quiet(3100);
  await tick();await tick();
  assert.ok(sent instanceof FormData,'liveFailed means the text is only a fallback');
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
  app.$('#voiceCancel').onclick();
});

test('when Whisper is unreachable the captured words still open a local proposal',async()=>{
  let sent=null;
  const app=setup({
    SpeechRecognition:true,MediaRecorder:recorderClass(),
    invoke:async(_name,options)=>{
      sent=options.body;
      return {error:httpError(503,{error:'Asnjë ofrues AI nuk është konfiguruar.',code:'no_provider'})};
    },
  });
  await app.$('#voiceTaskBtn').onclick();
  app.speak(400);
  app.recognizer.result([{text:'Cakto Arben Kola të përgatisë raportin',final:false}]);
  app.recognizer.onend();                       // an interruption forces the audio path
  app.advance(0);
  app.speak(300);
  app.recognizer.result([{text:'raportin nesër urgjent',final:false}]);
  app.quiet(3100);
  await tick();await tick();
  assert.ok(sent instanceof FormData,'the audio was uploaded first');
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'),'the local fallback still opens');
  assert.equal(app.$('#voiceDraftSource').textContent,'Përpunim lokal — AI nuk u përdor');
  assert.equal(app.$('#tTitle').value,'Cakto Arben Kola të përgatisë raportin nesër urgjent');
  assert.equal(app.$('#voiceDraftAssignee').value,'Arben Kola');
  assert.equal(app.$('#voiceDraftPriority').value,'Lart');
  assert.match(app.$('#assistantStatus').textContent,/AI në server nuk u përdor/);
  assert.equal(app.saved,0,'nothing is saved before confirmation');
  app.$('#voiceCancel').onclick();
});

/* ---------- readiness: never claim "listening" before the hardware is open ---------- */
test('the panel stays on "opening the microphone" until the recorder is really running',async()=>{
  let openStream;
  const app=setup({
    SpeechRecognition:true,MediaRecorder:recorderClass(),
    mediaDevices:{getUserMedia:()=>new Promise(resolve=>{openStream=resolve;})},
    invoke:async()=>({data:draft}),
  });
  const pending=app.$('#voiceTaskBtn').onclick();
  assert.ok(app.$('#voiceLive').classList.contains('show'),'the panel confirms the tap at once');
  assert.equal(app.$('#voiceLiveState').textContent,'Po hap mikrofonin… prit një çast');
  assert.match(app.$('#assistantStatus').textContent,/Po hap mikrofonin/);
  assert.equal(app.recognizer,null,'nothing may touch the microphone before it is open');
  openStream(app.stream);
  await pending;
  assert.equal(app.$('#voiceLiveState').textContent,'Po dëgjoj…');
  assert.ok(app.recognizer,'recognition starts only once the capture is ready');
  app.events.keydown({key:'Escape'});
  assert.equal(app.stopped,1);
});

test('a recorder that never starts reports an error instead of pretending to listen',async()=>{
  class Broken{
    constructor(){this.state='inactive';this.mimeType='audio/webm';}
    start(){/* stays inactive */}
    stop(){if(this.onstop)this.onstop();}
  }
  const app=setup({MediaRecorder:Broken,invoke:async()=>({data:draft})});
  await app.$('#voiceTaskBtn').onclick();
  assert.notEqual(app.$('#voiceLiveState').textContent,'Po dëgjoj…');
  assert.match(app.$('#assistantStatus').textContent,/Regjistrimi i audios nuk nisi dot/);
  assert.equal(app.$('#voiceTaskBtn').disabled,false);
  assert.equal(app.$('#aiTaskBtn').disabled,false);
  assert.equal(app.stopped,1,'the microphone is freed');
});

test('a broken recorder falls back to live recognition instead of doing nothing',async()=>{
  class Broken{
    constructor(){this.state='inactive';this.mimeType='audio/webm';}
    start(){/* stays inactive */}
    stop(){if(this.onstop)this.onstop();}
  }
  let body=null;
  const app=setup({SpeechRecognition:true,MediaRecorder:Broken,
    invoke:async(_name,options)=>{body=options.body;return {data:draft};}});
  await app.$('#voiceTaskBtn').onclick();
  assert.ok(app.recognizer,'the recogniser takes over when the recorder is unusable');
  assert.equal(app.$('#voiceLiveState').textContent,'Po dëgjoj…');
  app.speak(400);
  app.recognizer.result([{text:'Arben Kola përgatit raportin nesër',final:true}]);
  app.quiet(3100);
  await tick();await tick();
  assert.equal(body instanceof FormData,false,'no audio was recorded, so only text is sent');
  assert.equal(body.text,'Arben Kola përgatit raportin nesër');
  assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
  app.$('#voiceCancel').onclick();
});

/* ---------- the composer is the live preview, never the authoritative audio ---------- */
for(const [device,deviceOptions] of [
  ['phone',{userAgent:PHONE_UA,maxTouchPoints:5}],
  ['desktop',{}],
]){
  test(`${device}: live text stays in the composer until the audio transcript replaces it`,async()=>{
    let sent=null,resolveResponse;
    const preview='cakto arben kola raportin';
    const heard='Cakto Arben Kola të përgatisë raportin për nesër';
    const app=setup({...deviceOptions,SpeechRecognition:true,MediaRecorder:recorderClass(),
      invoke:(_name,options)=>{sent=options.body;return new Promise(resolve=>{resolveResponse=resolve;});}});
    const title=app.$('#tTitle'),mic=app.$('#voiceTaskBtn');
    title.value='Shënim paraprak';
    mic.focus();
    await mic.onclick();
    if(device==='phone')app.advance(200);
    const status=app.$('#assistantStatus').textContent;
    app.speak(500);
    app.recognizer.result([{text:'cakto arben kola',final:false}]);
    assert.equal(title.value,'Shënim paraprak cakto arben kola','interim text is visible immediately');
    assert.equal(title.selectionStart,title.value.length);
    assert.equal(title.selectionEnd,title.value.length,'the caret follows the last word');
    assert.equal(title.scrollLeft,title.scrollWidth,'long input scrolls to the last word even without focus');
    assert.equal(title.focusCount,0,'dictation must not open the phone keyboard');
    assert.equal(app.document.activeElement,mic,'dictation does not steal focus');
    assert.equal(app.saved,0,'programmatic updates must not trigger Enter/addTask');
    assert.equal(app.$('#assistantStatus').textContent,status,'the live status does not announce every word');
    assert.equal(app.$('#voiceLiveState').textContent,'Po dëgjoj…');
    assert.doesNotMatch(html,/id="voiceLiveText"/,'the status panel does not duplicate the transcript');

    if(device==='desktop'){
      app.recognizer.onend();                         // a restart requires the complete audio
      app.advance(0);
      app.recognizer.result([{text:'raportin',final:false}]);
    }else app.recognizer.result([{text:preview,final:false}]);
    assert.equal(title.value,'Shënim paraprak '+preview);
    app.quiet(3100);
    await tick();await tick();
    assert.ok(sent instanceof FormData,'the complete recording, not the preview, is sent');
    assert.ok(sent.get('audio').size>0);
    assert.equal(title.value,'Shënim paraprak '+preview,'the preview remains while the server is pending');
    assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);

    resolveResponse({data:{transcript:heard,draft:draft.draft}});
    await tick();await tick();
    assert.equal(title.value,'Shënim paraprak '+heard,'the server transcript replaces only the preview');
    assert.equal(title.selectionEnd,title.value.length);
    assert.equal(app.$('#voiceDraftDesc').value,heard,'the confirmation uses the audio transcript');
    assert.equal(app.$('#voiceDraftTitle').value,'Përgatit raportin');
    assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
    assert.equal(app.saved,0);
    app.$('#voiceDraftNotify').checked=true;
    app.$('#voiceConfirm').onclick();
    assert.equal(title.value,'Përgatit raportin','the proposed task title is applied only on confirmation');
    assert.equal(app.$('#tDesc').value,heard);
    assert.equal(app.saved,1);
  });
}

test('programmatic composer updates neither focus the input nor dispatch the real Enter handler',async()=>{
  const app=setup({SpeechRecognition:true,MediaRecorder:recorderClass()});
  const title=app.$('#tTitle'),mic=app.$('#voiceTaskBtn');
  mic.focus();
  await mic.onclick();
  app.speak(400);
  app.recognizer.result([{text:'Një detyrë mjaft e gjatë që duhet të rrëshqasë deri te fjala e fundit',final:false}]);
  assert.equal(title.focusCount,0);
  assert.equal(app.document.activeElement,mic);
  assert.equal(title.selectionStart,title.value.length);
  assert.equal(title.selectionEnd,title.value.length);
  assert.equal(title.scrollLeft,title.scrollWidth);
  assert.equal(app.saved,0);
  app.$('#voiceLiveCancel').onclick();
  let prevented=false;
  title.dispatchEvent({type:'keydown',key:'Enter',shiftKey:false,preventDefault(){prevented=true;}});
  assert.equal(prevented,true,'the actual composer Enter handler was installed');
  assert.equal(app.saved,1,'only a real Enter event calls addTask');
});

test('live updates preserve an already focused composer without focusing it again',async()=>{
  const app=setup({SpeechRecognition:true});
  const title=app.$('#tTitle');title.value='Para';title.focus();
  await app.$('#voiceTaskBtn').onclick();
  app.speak(400);
  app.recognizer.result([{text:'fundi',final:false}]);
  assert.equal(app.document.activeElement,title);
  assert.equal(title.focusCount,1);
  assert.equal(title.value,'Para fundi');
  assert.equal(title.selectionEnd,title.value.length);
  assert.equal(app.saved,0);
  app.events.keydown({key:'Escape'});
  assert.equal(title.value,'Para');
  assert.equal(title.focusCount,1);
});

for(const [method,cancel] of [
  ['Escape',app=>app.events.keydown({key:'Escape'})],
  ['the live cancel button',app=>app.$('#voiceLiveCancel').onclick()],
  ['pagehide',app=>app.windowEvents.pagehide()],
]){
  test(`${method} restores the exact pre-dictation prefix and ignores late words`,async()=>{
    const app=setup({SpeechRecognition:true,MediaRecorder:recorderClass()});
    const title=app.$('#tTitle'),prefix='Tekst i shkruar  ';
    title.value=prefix;
    await app.$('#voiceTaskBtn').onclick();
    app.speak(400);
    const recognizer=app.recognizer;
    recognizer.result([{text:'gjysmë fjale',final:false}]);
    assert.equal(title.value,prefix+'gjysmë fjale','existing trailing spaces are preserved');
    cancel(app);
    assert.equal(title.value,prefix);
    assert.equal(title.focusCount,0);
    assert.equal(app.stopped,1);
    recognizer.result([{text:'rezultat i vonuar',final:false}]);
    assert.equal(title.value,prefix,'a late recognition callback cannot reinsert the preview');
    assert.equal(app.saved,0);
  });
}

for(const [method,cancel] of [
  ['Escape',app=>app.events.keydown({key:'Escape'})],
  ['pagehide',app=>app.windowEvents.pagehide()],
]){
  test(`${method} during the server request restores the prefix and rejects its late response`,async()=>{
    let resolveResponse,signal;
    const app=setup({userAgent:PHONE_UA,maxTouchPoints:5,SpeechRecognition:true,MediaRecorder:recorderClass(),
      invoke:(_name,options)=>{signal=options.signal;return new Promise(resolve=>{resolveResponse=resolve;});}});
    const title=app.$('#tTitle');title.value='Para';
    await app.$('#voiceTaskBtn').onclick();app.advance(200);app.speak(500);
    app.recognizer.result([{text:'parapamje e pjesshme',final:false}]);
    app.quiet(3100);await tick();await tick();
    assert.ok(signal,'the audio request is pending');
    assert.equal(title.value,'Para parapamje e pjesshme');
    cancel(app);
    assert.equal(title.value,'Para');
    assert.equal(signal.aborted,true,'cancellation aborts the pending request');
    resolveResponse({data:draft});await tick();await tick();
    assert.equal(title.value,'Para');
    assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
  });
}

for(const [method,cancel] of [
  ['Escape',app=>app.events.keydown({key:'Escape'})],
  ['pagehide',app=>app.windowEvents.pagehide()],
]){
  test(`${method} while the recorder is flushing cannot start a late server request`,async()=>{
    let recorder,calls=0;
    class DelayedRecorder{
      static isTypeSupported(){return true;}
      constructor(){recorder=this;this.state='inactive';this.mimeType='audio/webm';}
      start(){this.state='recording';}
      stop(){this.state='inactive';}                    // onstop arrives later
      flush(){this.ondataavailable({data:new Blob(['audio'])});this.onstop();}
    }
    const app=setup({userAgent:PHONE_UA,maxTouchPoints:5,SpeechRecognition:true,MediaRecorder:DelayedRecorder,
      invoke:async()=>{calls++;return {data:draft};}});
    const title=app.$('#tTitle');title.value='Para';
    await app.$('#voiceTaskBtn').onclick();app.advance(200);app.speak(500);
    app.recognizer.result([{text:'tekst live',final:false}]);
    app.$('#voiceTaskBtn').onclick();                  // stops recognition before onstop arrives
    assert.equal(title.value,'Para tekst live');
    cancel(app);
    assert.equal(title.value,'Para');
    recorder.flush();await tick();await tick();
    assert.equal(calls,0);
    assert.equal(title.value,'Para');
    assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
  });
}

for(const [method,cancel] of [
  ['the confirmation cancel button',app=>app.$('#voiceCancel').onclick()],
  ['Escape in confirmation',app=>app.events.keydown({key:'Escape',preventDefault(){}})],
  ['pagehide in confirmation',app=>app.windowEvents.pagehide()],
]){
  test(`${method} discards a voice draft and restores its composer prefix`,async()=>{
    const app=setup({userAgent:PHONE_UA,maxTouchPoints:5,SpeechRecognition:true,MediaRecorder:recorderClass(),
      invoke:async()=>({data:draft})});
    const title=app.$('#tTitle');title.value='Para';
    await app.$('#voiceTaskBtn').onclick();app.advance(200);app.speak(500);
    app.recognizer.result([{text:'parapamje',final:false}]);
    app.quiet(3100);await tick();await tick();
    assert.equal(title.value,'Para '+draft.transcript);
    assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
    cancel(app);
    assert.equal(title.value,'Para');
    assert.equal(app.$('#voiceConfirmOverlay').classList.contains('show'),false);
    assert.equal(app.saved,0);
  });
}

test('when audio transcription fails, the local fallback keeps the live text in the composer',async()=>{
  for(const offline of [true,false]){
    let sent;
    const app=setup({userAgent:PHONE_UA,maxTouchPoints:5,SpeechRecognition:true,MediaRecorder:recorderClass(),
      ...(offline?{}:{invoke:async(_name,options)=>{sent=options.body;return {error:httpError(503,{error:'Asnjë ofrues AI nuk është konfiguruar.'})};}})});
    const title=app.$('#tTitle'),prefix='Udhëzim';
    const live='Cakto Arben Kola të përgatisë raportin nesër urgjent';
    title.value=prefix;
    await app.$('#voiceTaskBtn').onclick();app.advance(200);app.speak(500);
    app.recognizer.result([{text:live,final:false}]);
    assert.equal(title.value,prefix+' '+live);
    app.quiet(3100);await tick();await tick();
    if(!offline)assert.ok(sent instanceof FormData,'audio was attempted first');
    assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
    assert.equal(app.$('#voiceDraftSource').textContent,'Përpunim lokal — AI nuk u përdor');
    assert.equal(title.value,prefix+' '+live,'local fallback must not erase the preview');
    assert.equal(app.$('#voiceDraftDesc').value,live);
    assert.equal(app.saved,0);
    app.$('#voiceCancel').onclick();
    assert.equal(title.value,prefix,'an explicit cancellation still discards the voice text');
  }
});

test('a valid audio transcript remains authoritative even when the server omits its draft',async()=>{
  for(const hasPreview of [true,false]){
    let sent;
    const heard='Transkript i plotë nga audioja';
    const app=setup({userAgent:PHONE_UA,maxTouchPoints:5,SpeechRecognition:hasPreview,MediaRecorder:recorderClass(),
      invoke:async(_name,options)=>{sent=options.body;return {data:{transcript:heard}};}});
    const title=app.$('#tTitle');title.value='Para';
    await app.$('#voiceTaskBtn').onclick();
    if(hasPreview)app.advance(200);
    app.speak(500);
    if(hasPreview)app.recognizer.result([{text:'fjalë paraprake',final:false}]);
    app.$('#voiceTaskBtn').onclick();
    await tick();await tick();
    assert.ok(sent instanceof FormData);
    assert.equal(title.value,'Para '+heard);
    assert.equal(app.$('#voiceDraftDesc').value,heard);
    assert.equal(app.$('#voiceDraftSource').textContent,'Përpunim lokal — AI nuk u përdor');
    assert.ok(app.$('#voiceConfirmOverlay').classList.contains('show'));
    app.$('#voiceCancel').onclick();
    assert.equal(title.value,'Para');
  }
});
