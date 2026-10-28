const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create,mergeTranscript,clean}=require('../voice-dictation.js');

/* Deterministic clock: no real waiting, timers fire in order when time moves. */
function fakeClock(){
  let t=0,seq=0;const queue=new Map();
  return {
    now:()=>t,
    timers:{
      set(fn,ms){const id=++seq;queue.set(id,{fn,at:t+Math.max(0,Number(ms)||0),id});return id;},
      clear(id){queue.delete(id);},
    },
    advance(ms){
      const target=t+ms;
      for(;;){
        const due=[...queue.values()].filter(x=>x.at<=target).sort((a,b)=>a.at-b.at||a.id-b.id);
        if(!due.length)break;
        const next=due[0];queue.delete(next.id);t=next.at;
        try{next.fn();}catch(e){throw e;}
      }
      t=target;
    },
    pending:()=>queue.size,
  };
}
const VOICE=0.09,SILENCE=0.002; // clear voice, quiet room
function rig(config){
  const clock=fakeClock(),log={status:[],transcript:[],results:[],cancels:[],errors:[],stops:0,releases:0};
  let monitorOn=null;
  const engine=create({
    now:clock.now,timers:clock.timers,config,
    onStatus:s=>log.status.push(s),
    onTranscript:t=>log.transcript.push(t),
    onResult:r=>log.results.push(r),
    onCancel:c=>log.cancels.push(c),
    onError:m=>log.errors.push(m),
    onStop:()=>{log.stops++;},
    onRelease:()=>{log.releases++;monitorOn=null;},
  });
  // Simulate the browser: the audio monitor feeds levels until released.
  function feed(ms,level){
    const steps=Math.round(ms/20);
    for(let i=0;i<steps;i++){clock.advance(20);engine.noteLevel(level);}
  }
  const speak=(ms,level=VOICE)=>feed(ms,level);
  const quiet=(ms,level=SILENCE)=>feed(ms,level);
  return {clock,engine,log,speak,quiet,get monitor(){return monitorOn;}};
}

test('merges interim restatements without duplicating words',()=>{
  assert.equal(mergeTranscript('Arben Kola','Arben Kola përgatit'),'Arben Kola përgatit');
  assert.equal(mergeTranscript('Arben Kola përgatit','Arben Kola përgatit'),'Arben Kola përgatit');
  assert.equal(mergeTranscript('raportin','raportin nesër'),'raportin nesër');
  assert.equal(mergeTranscript('Arben Kola raportin','raportin'),'Arben Kola raportin');
  assert.equal(mergeTranscript('Arben Kola','nesër'),'Arben Kola nesër');
  assert.equal(mergeTranscript('',''),'');
  assert.equal(clean('  a   b  '),'a b');
});

test('live transcript updates continuously while listening',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(200);
  r.engine.setInterim('Arben');
  r.engine.setInterim('Arben Kola');
  r.speak(200);
  r.engine.setInterim('Arben Kola përgatit raportin');
  assert.deepEqual(r.log.transcript,['Arben','Arben Kola','Arben Kola përgatit raportin']);
  assert.equal(r.engine.transcript(),'Arben Kola përgatit raportin');
  assert.equal(r.log.results.length,0); // nothing is delivered while the owner is still talking
  assert.equal(r.engine.state,'listening');
});

test('three full seconds of silence stop the recording and free the microphone',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(600);r.engine.setInterim('Raporti vjetor');
  r.quiet(2980);
  assert.equal(r.log.stops,0,'must not stop before 3 s');
  assert.equal(r.engine.state,'listening');
  r.quiet(20);                                  // 3010 ms without voice
  assert.equal(r.log.stops,1,'stops on its own');
  assert.equal(r.engine.state,'stopping');
  r.clock.advance(900);                         // grace for the final word
  assert.equal(r.engine.state,'idle');
  assert.equal(r.log.releases,1,'microphone released exactly once');
  assert.equal(r.log.results.length,1);
  assert.equal(r.log.results[0].transcript,'Raporti vjetor');
  assert.equal(r.log.results[0].reason,'silence');
  assert.equal(r.log.results[0].heardSpeech,true);
});

test('talking again inside the 3 seconds restarts the countdown',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(400);r.engine.setInterim('Dërgo');
  r.quiet(2000);
  assert.ok(r.engine.remaining()>0&&r.engine.remaining()<=1500);
  r.speak(300);                                  // owner resumes
  r.engine.setInterim('Dërgo faturat');
  r.quiet(2000);
  assert.equal(r.log.stops,0,'the silence window restarted with the new speech');
  r.quiet(1100);
  assert.equal(r.log.stops,1);
  r.clock.advance(900);
  assert.equal(r.log.results[0].transcript,'Dërgo faturat');
});

test('short pauses and low voice never cut the dictation short',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  for(let i=0;i<3;i++){
    r.speak(500,0.045);          // quiet voice
    r.quiet(1200);               // natural pause, well below 3 s
    r.engine.setInterim('fraza '+(i+1));
  }
  assert.equal(r.log.stops,0);
  assert.equal(r.engine.state,'listening');
  r.quiet(2500);
  assert.equal(r.log.stops,1);
});

test('no voice at all never produces a result to confirm',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.quiet(3000);
  assert.equal(r.log.results.length,0,'silence alone does not stop the mic');
  r.clock.advance(60000);
  assert.equal(r.log.results.length,1);
  assert.equal(r.log.results[0].transcript,'');
  assert.equal(r.log.results[0].heardSpeech,false);
  assert.equal(r.log.releases,1);
});

test('a cough shorter than the minimum speech length keeps listening',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(60);                   // one blip : ~40-60 ms of voiced energy
  r.quiet(3200);
  assert.equal(r.log.stops,0,'a blip is not speech');
  assert.equal(r.engine.state,'listening');
  assert.equal(r.engine.heardSpeech,false);
});

test('cancelling saves nothing, releases the microphone and ignores late results',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(400);r.engine.setInterim('Raporti');
  r.engine.cancel();
  assert.equal(r.log.cancels.length,1);
  assert.equal(r.log.releases,1);
  assert.equal(r.engine.state,'idle');
  r.engine.addFinal('Raporti i vjetër');   // a straggler from SpeechRecognition
  r.clock.advance(10000);
  assert.equal(r.log.results.length,0,'no draft after cancel');
});

test('the last words survive and interim text is never duplicated',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(800);
  r.engine.setInterim('Arben Kola përgatit');
  r.engine.setInterim('Arben Kola përgatit raportin');
  r.engine.addFinal('Arben Kola përgatit raportin nesër');   // final result carries the last word
  r.engine.setInterim('');                                   // interim resets
  r.quiet(3100);
  r.clock.advance(900);
  const text=r.log.results[0].transcript;
  assert.equal(text,'Arben Kola përgatit raportin nesër');
  assert.equal(text.match(/raportin/g).length,1,'no repetition from interim results');
});

test('stopping twice (silence + manual tap) delivers exactly one result',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(500);r.engine.setInterim('Raporti');
  r.engine.stop('manual');
  r.engine.stop('manual');
  r.quiet(4000);
  r.engine.stop();
  r.clock.advance(900);
  assert.equal(r.log.results.length,1);
  assert.equal(r.log.releases,1);
  assert.equal(r.log.stops,1);
});

test('the caller can complete early when the recogniser flushes its final result',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(500);r.engine.setInterim('Raporti');
  r.clock.advance(3100);
  assert.equal(r.engine.state,'stopping');
  r.engine.addFinal('Raporti vjetor');   // arrives during the grace window
  r.engine.complete();                   // recogniser fired onend
  assert.equal(r.log.results[0].transcript,'Raporti vjetor');
  r.clock.advance(5000);
  assert.equal(r.log.results.length,1,'the grace timer cannot deliver twice');
});

test('a denied microphone reports an error without leaving state behind',()=>{
  const r=rig();r.engine.start();
  assert.equal(r.engine.state,'starting');
  r.engine.fail('Mikrofoni nuk u hap');
  assert.deepEqual(r.log.errors,['Mikrofoni nuk u hap']);
  assert.equal(r.engine.state,'idle');
  assert.equal(r.engine.start(),true,'the engine can be used again');
});

test('degraded mode counts a recognition result as speech',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.clock.advance(500);r.engine.markSpeech();      // one recognition result, no audio meter
  r.engine.setInterim('Raporti');
  r.clock.advance(2900);
  assert.equal(r.engine.state,'listening');
  r.clock.advance(200);
  assert.equal(r.engine.state,'stopping','the silence window still ends the dictation');
  r.clock.advance(900);
  assert.equal(r.log.results[0].heardSpeech,true);
  assert.equal(r.log.results[0].transcript,'Raporti');
});

test('statuses are explicit for every phase',()=>{
  const r=rig();r.engine.start();
  assert.equal(r.log.status.at(-1).state,'starting');
  r.engine.begin();
  assert.equal(r.log.status.at(-1).label,'Po dëgjoj…');
  r.speak(500);
  r.clock.advance(3100);
  assert.equal(r.log.status.at(-1).label,'Po përfundoj regjistrimin…');
});

/* ---------- half sentences are never lost when the recogniser restarts ---------- */
test('flushInterim keeps the words the browser never marked as final',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(400);
  r.engine.setInterim('Arben Kola përgatit');
  assert.equal(r.engine.flushInterim(),true,'there was an unfinished sentence');
  assert.equal(r.engine.transcript(),'Arben Kola përgatit');
  assert.deepEqual(r.log.transcript.at(-1),'Arben Kola përgatit','the panel keeps the words');
  assert.equal(r.engine.flushInterim(),false,'nothing left to flush');
  r.engine.setInterim('raportin nesër');            // the restarted session speaks on
  assert.equal(r.engine.transcript(),'Arben Kola përgatit raportin nesër');
});

test('a restart mid-sentence neither loses nor duplicates the first words',()=>{
  const r=rig();r.engine.start();r.engine.begin();
  r.speak(500);
  r.engine.setInterim('Cakto Arben Kola të përgatisë');   // onend arrives, no isFinal
  r.engine.flushInterim();                                 // the caller flushes on onend
  r.speak(400);
  r.engine.setInterim('përgatisë raportin nesër');         // restart repeats the last word
  r.speak(300);
  r.engine.setInterim('raportin nesër urgjent');
  assert.equal(r.engine.transcript(),'Cakto Arben Kola të përgatisë raportin nesër urgjent');
  assert.equal(r.engine.transcript().match(/përgatisë/g).length,1,'no duplicated junction');
  r.quiet(3100);r.clock.advance(900);
  assert.equal(r.log.results[0].transcript,'Cakto Arben Kola të përgatisë raportin nesër urgjent');
});

test('flushing has no effect while idle and never creates text from nothing',()=>{
  const r=rig();
  assert.equal(r.engine.flushInterim(),false);
  r.engine.start();r.engine.begin();
  assert.equal(r.engine.flushInterim(),false,'empty interim');
  assert.equal(r.engine.transcript(),'');
  assert.equal(r.log.results.length,0,'flushing never delivers a draft on its own');
});

test('the opening state is explicit and never pretends to listen',()=>{
  const r=rig();r.engine.start();
  assert.equal(r.log.status.at(-1).label,'Po hap mikrofonin… prit një çast');
  assert.equal(r.log.status.at(-1).state,'starting');
  r.engine.begin();
  assert.equal(r.log.status.at(-1).state,'listening');
});
