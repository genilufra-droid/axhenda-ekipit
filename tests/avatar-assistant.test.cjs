const {test}=require('node:test');
const assert=require('node:assert/strict');
const Avatar=require('../avatar-assistant.js');

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function clock(){
  let t=0,seq=0;const queue=new Map();
  return {
    now:()=>t,
    timers:{set(fn,ms){const id=++seq;queue.set(id,{fn,at:t+ms});return id;},clear(id){queue.delete(id);}},
    async advance(ms){
      const target=t+ms;
      for(;;){
        const due=[...queue.entries()].filter(([,x])=>x.at<=target).sort((a,b)=>a[1].at-b[1].at);
        if(!due.length)break;
        const [id,job]=due[0];queue.delete(id);t=job.at;job.fn();await tick();
      }
      t=target;
    },
  };
}
/* 24 kHz mono, 16-bit little endian: [0, 16384, -16384] */
const PCM=Buffer.from(new Int16Array([0,16384,-16384]).buffer).toString('base64');

function audio(){
  const log={started:0,stopped:0,created:[]};
  let ended=null;
  const ctx={state:'suspended',resumed:0,destination:{},
    resume(){this.resumed++;this.state='running';return Promise.resolve();},
    createBuffer(channels,length,rate){const data=new Float32Array(length);log.created.push({channels,length,rate});
      return {data,getChannelData(){return data;}};},
    createBufferSource(){return {connect(){},start(){log.started++;},stop(){log.stopped++;},set onended(fn){ended=fn;},get onended(){return ended;}};}};
  return {ctx,log,finish(){const fn=ended;if(fn)fn();}};
}
function synth(voices){
  const log={spoken:[],cancelled:0};
  const speechSynthesis={getVoices:()=>voices,cancel(){log.cancelled++;},speak(u){log.spoken.push(u);log.last=u;}};
  class Utterance{constructor(text){this.text=text;}}
  return {speechSynthesis,Utterance,log};
}

/* ---------- dates and summary ---------- */
test('dates are spoken the way people say them',()=>{
  const today='2026-10-29';
  assert.equal(Avatar.speakDate('2026-10-29',today),'sot');
  assert.equal(Avatar.speakDate('2026-10-30',today),'nesër');
  assert.equal(Avatar.speakDate('2026-10-31',today),'pasnesër');
  assert.equal(Avatar.speakDate('2026-11-05',today),'5 nëntor');
  assert.equal(Avatar.speakDate('2027-01-02',today),'2 janar 2027');
  assert.equal(Avatar.speakDate('2026-12-31','2026-12-30'),'nesër');
  assert.equal(Avatar.speakDate('',today),'');
  assert.equal(Avatar.speakDate('not-a-date',today),'');
});
test('the summary reads every field the owner must check',()=>{
  const text=Avatar.summarize({title:'Përgatit raportin',assignee:'Arben Kola',due:'2026-10-30',priority:'Lart'},{today:'2026-10-29'});
  assert.match(text,/E përgatita detyrën: Përgatit raportin\./);
  assert.match(text,/Për Arben Kola\./);
  assert.match(text,/Afati: nesër\./);
  assert.match(text,/Prioriteti e lartë\./);
  assert.match(text,/Konfirmo dhe dërgo/);
  assert.match(text,/Njoftimin e zgjedh vetë/,'the avatar never claims it notifies anyone');
});
test('missing fields are said plainly, never invented',()=>{
  const text=Avatar.summarize({title:'Raporti',assignee:'',due:'',priority:'x'},{today:'2026-10-29'});
  assert.match(text,/Nuk ka punonjës të zgjedhur\./);
  assert.match(text,/Nuk ka afat\./);
  assert.match(text,/Prioriteti e mesme\./);
  assert.doesNotMatch(Avatar.summarize({},{}),/undefined|null/);
});
test('a very long title is shortened for speech',()=>{
  const text=Avatar.summarize({title:'x'.repeat(500)},{today:''});
  assert.ok(text.length<420);assert.match(text,/…/);
});
test('PCM from the voice service is decoded to samples',()=>{
  const samples=Avatar.pcmToFloat32(PCM);
  assert.equal(samples.length,3);
  assert.equal(samples[0],0);assert.equal(samples[1],0.5);assert.equal(samples[2],-0.5);
});

/* ---------- speaker ---------- */
test('server voice: plays the decoded audio and remembers it',async()=>{
  const a=audio();let calls=0;
  const speaker=Avatar.createSpeaker({invoke:async(name,opts)=>{calls++;assert.equal(name,'assistant-speak');assert.equal(opts.body.text,'Përshëndetje');
    return {data:{audioBase64:PCM,mimeType:'audio/pcm;rate=24000'}};},getAudioContext:()=>a.ctx});
  const first=speaker.speak('Përshëndetje');await tick();await tick();
  assert.equal(a.log.started,1);assert.deepEqual(a.log.created[0],{channels:1,length:3,rate:24000});
  a.finish();assert.equal(await first,'server');
  const second=speaker.speak('Përshëndetje');await tick();a.finish();
  assert.equal(await second,'server');assert.equal(calls,1,'the same sentence is not requested twice');
});
test('unlock resumes a suspended audio context inside a tap',()=>{
  const a=audio();const speaker=Avatar.createSpeaker({getAudioContext:()=>a.ctx});
  speaker.unlock();assert.equal(a.ctx.resumed,1);
});
test('server failure falls back to the browser Albanian voice',async()=>{
  const a=audio(),s=synth([{lang:'en-US'},{lang:'sq-AL',name:'Albanian'}]);
  const speaker=Avatar.createSpeaker({invoke:async()=>({error:{context:{status:500}}}),getAudioContext:()=>a.ctx,
    speechSynthesis:s.speechSynthesis,Utterance:s.Utterance});
  const done=speaker.speak('Detyra u ruajt');await tick();await tick();
  assert.equal(s.log.spoken.length,1);assert.equal(s.log.last.voice.lang,'sq-AL');assert.equal(s.log.last.lang,'sq-AL');
  s.log.last.onend();assert.equal(await done,'browser');
});
test('no server and no Albanian voice: text only, and it takes a believable time',async()=>{
  const c=clock(),s=synth([{lang:'en-US'},{lang:'sq-AL'}].slice(0,1));
  const speaker=Avatar.createSpeaker({timers:c.timers,now:c.now,speechSynthesis:s.speechSynthesis,Utterance:s.Utterance});
  let result=null;speaker.speak('Po e kuptoj detyrën').then(r=>{result=r;});
  await tick();assert.equal(result,null,'still "talking"');assert.equal(s.log.spoken.length,0,'an English voice never reads Albanian');
  await c.advance(7000);assert.equal(result,'text');
});
test('a failing voice service is not retried on every sentence',async()=>{
  const c=clock();let calls=0;const a=audio();
  const speaker=Avatar.createSpeaker({timers:c.timers,now:c.now,getAudioContext:()=>a.ctx,invoke:async()=>{calls++;return {error:{context:{status:500}}};}});
  const one=speaker.speak('Një');await tick();await tick();await c.advance(7000);await one;
  const two=speaker.speak('Dy');await tick();await c.advance(7000);await two;
  assert.equal(calls,1);
  await c.advance(61000);
  const three=speaker.speak('Tre');await tick();await tick();await c.advance(7000);await three;
  assert.equal(calls,2,'it tries again after the pause');
});
test('a slow voice service gives way to the fallback',async()=>{
  const c=clock(),a=audio();
  const speaker=Avatar.createSpeaker({timers:c.timers,now:c.now,getAudioContext:()=>a.ctx,invoke:()=>new Promise(()=>{})});
  let result=null;speaker.speak('Diçka').then(r=>{result=r;});
  await tick();await c.advance(16100);await c.advance(7000);
  assert.equal(result,'text');
});
test('a suspended AudioContext after microphone capture is resumed before playing',async()=>{
  const a=audio();
  assert.equal(a.ctx.state,'suspended');
  const speaker=Avatar.createSpeaker({getAudioContext:()=>a.ctx,invoke:async()=>({data:{audioBase64:PCM,sampleRate:24000}})});
  let result=null;speaker.speak('Përshëndetje').then(r=>{result=r;});
  await tick();await tick();await tick();
  assert.equal(a.ctx.resumed,1,'resumed before starting buffer source');
  assert.equal(a.ctx.state,'running');
  assert.equal(a.log.started,1);
  a.finish();
  await tick();
  assert.equal(result,'server');
});
test('when AudioContext stays locked on mobile, server voice falls back to WAV audio element',async()=>{
  const a=audio();
  a.ctx.state='interrupted';
  a.ctx.resume=async()=>{a.ctx.resumed++;/* mobile Safari keeps it interrupted */};
  let wavHeader='',endWav=null;
  const speaker=Avatar.createSpeaker({
    getAudioContext:()=>a.ctx,
    invoke:async()=>({data:{audioBase64:PCM,sampleRate:24000}}),
    playWav:(bytes,onEnd)=>{
      wavHeader=Buffer.from(bytes.buffer,bytes.byteOffset,12).toString('ascii');
      endWav=onEnd;
      return {started:Promise.resolve(true),stop(){}};
    },
  });
  let result=null;speaker.speak('Përshëndetje').then(r=>{result=r;});
  await tick();await tick();await tick();await tick();
  assert.equal(wavHeader.slice(0,4),'RIFF');
  assert.equal(wavHeader.slice(8,12),'WAVE');
  assert.equal(result,null,'waiting for WAV audio to finish');
  endWav();
  await tick();
  assert.equal(result,'server');
});
test('pcmToWav wraps 16-bit PCM into a valid mono RIFF WAVE file',()=>{
  const wav=Avatar.pcmToWav(PCM,24000);
  assert.equal(Buffer.from(wav.slice(0,4)).toString('ascii'),'RIFF');
  assert.equal(Buffer.from(wav.slice(8,12)).toString('ascii'),'WAVE');
  assert.equal(Buffer.from(wav.slice(12,16)).toString('ascii'),'fmt ');
  assert.equal(Buffer.from(wav.slice(36,40)).toString('ascii'),'data');
  const view=new DataView(wav.buffer,wav.byteOffset,wav.byteLength);
  assert.equal(view.getUint16(22,true),1,'mono');
  assert.equal(view.getUint32(24,true),24000,'24 kHz');
  assert.equal(view.getUint16(34,true),16,'16-bit');
  assert.equal(wav.byteLength,44+6);
});
test('status 0 does not poison backoff, while real HTTP failures report an Albanian reason',async()=>{
  const c=clock(),a=audio(),errors=[];
  let status=0,calls=0;
  const speaker=Avatar.createSpeaker({
    timers:c.timers,now:c.now,getAudioContext:()=>a.ctx,
    onError:msg=>errors.push(msg),
    invoke:async()=>{
      calls++;
      if(status===0)return {error:{context:{status:0}}};
      if(status===404)return {error:{context:{status:404}}};
      return {data:{audioBase64:PCM}};
    },
  });
  const first=speaker.speak('Para hyrjes');await tick();await tick();await c.advance(7000);await first;
  status=200;
  const second=speaker.speak('Pas hyrjes');await tick();await tick();await tick();a.finish();
  assert.equal(await second,'server','not blocked for 60s by initial status 0');
  assert.equal(calls,2);
  status=404;
  const third=speaker.speak('Kur mungon funksioni');await tick();await tick();await c.advance(7000);await third;
  assert.ok(errors.some(e=>e.includes('404')),'reports 404 deployment error to UI');
});
test('stop silences the voice, and a late answer from the service is not played',async()=>{
  const a=audio();let release;
  const speaker=Avatar.createSpeaker({getAudioContext:()=>a.ctx,invoke:()=>new Promise(r=>{release=r;})});
  const done=speaker.speak('Fol');await tick();
  speaker.stop();release({data:{audioBase64:PCM}});
  assert.equal(await done,'stopped');await tick();
  assert.equal(a.log.started,0);
});
test('a newer sentence replaces the one being spoken',async()=>{
  const a=audio();
  const speaker=Avatar.createSpeaker({getAudioContext:()=>a.ctx,invoke:async()=>({data:{audioBase64:PCM}})});
  const first=speaker.speak('Një');await tick();await tick();
  const second=speaker.speak('Dy');
  assert.equal(await first,'stopped');
  await tick();await tick();a.finish();assert.equal(await second,'server');
});
test('texts too long for the voice service are only shown',async()=>{
  const c=clock();let calls=0;
  const speaker=Avatar.createSpeaker({timers:c.timers,now:c.now,getAudioContext:()=>audio().ctx,invoke:async()=>{calls++;return {data:{audioBase64:PCM}};}});
  const done=speaker.speak('x'.repeat(601));await tick();await c.advance(7000);
  assert.equal(await done,'text');assert.equal(calls,0);
});

/* ---------- window controller ---------- */
function element(){
  const classes=new Set(),attrs={};
  return {textContent:'',value:'',title:'',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)},
    setAttribute(k,v){attrs[k]=v;},getAttribute(k){return attrs[k];}};
}
function windowFor(speakImpl){
  const els={};for(const k of ['stage','body','pill','chat','liveField','avatar','mic','mute'])els[k]=element();
  const spoken=[];let stops=0,unlocks=0,resolvers=[];
  const speaker={
    speak:text=>{spoken.push(text);return speakImpl?speakImpl(text):new Promise(r=>resolvers.push(r));},
    stop(){stops++;},unlock(){unlocks++;},
  };
  const win=Avatar.create({els,speaker,today:()=>'2026-10-29'});
  return {win,els,spoken,resolvers,get stops(){return stops;},get unlocks(){return unlocks;}};
}
const draft={title:'Përgatit raportin',assignee:'Arben Kola',due:'2026-10-30',priority:'Lart'};

test('opening shows the window with a greeting and unlocks audio',()=>{
  const w=windowFor();w.win.open();
  assert.ok(w.els.stage.classList.contains('show'));assert.equal(w.win.state,'idle');
  assert.match(w.els.chat.textContent,/Përshëndetje/);assert.equal(w.unlocks,1);
});
test('listening, live words and thinking drive the status and the avatar',()=>{
  const w=windowFor();w.win.beforeListen();w.win.listening();
  assert.equal(w.win.state,'listening');assert.equal(w.els.pill.textContent,'Po të dëgjoj…');
  assert.ok(w.els.body.classList.contains('listening'));assert.ok(w.els.mic.classList.contains('listening'));
  w.win.heard('Cakto Arben Kola');assert.equal(w.els.liveField.value,'Cakto Arben Kola');
  w.win.thinking();assert.equal(w.win.state,'thinking');assert.equal(w.els.pill.textContent,'Po e përgatis detyrën…');
  assert.ok(!w.els.body.classList.contains('listening'));
});
test('the avatar never talks over the microphone',()=>{
  const w=windowFor();w.win.open();w.win.draft(draft);assert.equal(w.win.state,'speaking');
  const before=w.stops;w.win.beforeListen();
  assert.ok(w.stops>before,'speech is stopped before listening starts');assert.equal(w.win.state,'idle');
  assert.ok(!w.els.body.classList.contains('talking'));
});
test('a proposal is read out and written, then the window is ready again',async()=>{
  const w=windowFor(()=>Promise.resolve('server'));w.win.open();
  const done=w.win.draft(draft);
  assert.equal(w.win.state,'speaking');assert.ok(w.els.body.classList.contains('talking'));
  assert.match(w.els.chat.textContent,/Për Arben Kola\./);assert.equal(w.spoken.length,1);
  await done;assert.equal(w.win.state,'idle');assert.ok(!w.els.body.classList.contains('talking'));
});
test('an older sentence finishing late cannot undo a newer state',async()=>{
  const w=windowFor();w.win.open();
  const first=w.win.draft(draft);
  w.win.listening();                        // the owner talks again
  w.resolvers[0]('server');await first;
  assert.equal(w.win.state,'listening');
});
test('muting silences the avatar and only writes',async()=>{
  const w=windowFor();w.win.open();
  assert.equal(w.win.toggleMute(),true);assert.equal(w.els.mute.textContent,'🔇');
  const r=await w.win.draft(draft);
  assert.equal(r,'muted');assert.equal(w.spoken.length,0);
  assert.match(w.els.chat.textContent,/E përgatita detyrën/,'it is still written');
  assert.equal(w.win.toggleMute(),false);assert.equal(w.els.mute.textContent,'🔊');
});
test('Escape closes an idle window, stops speech first, and leaves busy work to the caller',()=>{
  const w=windowFor();
  assert.equal(w.win.escape(),false,'closed: nothing to do');
  w.win.open();w.win.draft(draft);
  assert.equal(w.win.escape(),true);assert.equal(w.win.state,'idle');assert.ok(w.els.stage.classList.contains('show'));
  assert.equal(w.win.escape(),true);assert.equal(w.win.state,'closed');assert.ok(!w.els.stage.classList.contains('show'));
  w.win.open();w.win.listening();
  assert.equal(w.win.escape(),false,'the dictation is cancelled by the caller');
});
test('closing stops speech and clears the talking state',()=>{
  const w=windowFor();w.win.open();w.win.draft(draft);
  const before=w.stops;w.win.close();
  assert.ok(w.stops>before);assert.equal(w.win.state,'closed');assert.ok(!w.els.body.classList.contains('talking'));
});
test('the reminder and the saved messages say what really happened',async()=>{
  const w=windowFor(()=>Promise.resolve('text'));w.win.open();
  await w.win.reminder();assert.match(w.spoken.at(-1),/NUK do të njoftohet/);
  await w.win.saved({notified:false});assert.equal(w.spoken.at(-1),'Detyra u ruajt. Asnjë njoftim nuk u dërgua.');
  await w.win.saved({notified:true});assert.match(w.spoken.at(-1),/u njoftuan/);
  assert.equal(w.els.liveField.value,'');assert.equal(w.win.state,'idle');
});
test('discarding or failing says so without speaking',()=>{
  const w=windowFor();w.win.open();
  w.win.discarded();assert.match(w.els.chat.textContent,/Asgjë nuk u ruajt/);assert.equal(w.spoken.length,0);
  w.win.idle('Nuk u kap zë. Provo përsëri.');assert.equal(w.els.chat.textContent,'Nuk u kap zë. Provo përsëri.');assert.equal(w.win.state,'idle');
});
test('a closed window ignores every event',async()=>{
  const w=windowFor();
  w.win.listening();w.win.heard('x');w.win.thinking();w.win.idle('x');w.win.discarded();
  assert.equal(await w.win.draft(draft),'closed');assert.equal(await w.win.reminder(),'closed');assert.equal(await w.win.saved({}),'closed');
  assert.equal(w.win.state,'closed');assert.equal(w.spoken.length,0);assert.ok(!w.els.stage.classList.contains('show'));
});

test('index.html carries the avatar window, loads its script before use and ships no inline photo', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  for (const id of ['assistantOpenCard', 'assistantStage', 'assistantStageSub', 'assistantStageBody', 'assistantStagePill',
    'assistantStageText', 'assistantLiveField', 'assistantStageAvatar', 'assistantStageMic', 'assistantMute', 'assistantStageClose']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.ok(html.includes('#assistantStage.show ~ #voiceConfirmOverlay'), 'confirmation modal docks below visible avatar');
  assert.ok(html.includes("['owner','pronar']"), 'accepts both owner and pronar role values');
  assert.ok(html.indexOf('avatar-assistant.js') < html.indexOf('const assistantAvatar'));
  assert.ok(!/data:image\/(png|jpeg);base64,[A-Za-z0-9+/]{5000}/.test(html), 'photo must stay a separate file');
  assert.ok(fs.existsSync(require('node:path').join(__dirname, '..', 'assistant-avatar.jpg')));
  assert.ok(fs.existsSync(require('node:path').join(__dirname, '..', '.nojekyll')));
});
