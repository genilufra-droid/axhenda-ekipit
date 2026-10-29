const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const assistant=html.slice(html.indexOf('/* TASK ASSISTANT:'),html.indexOf('/* ADD TASK */'));
const ids=new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]));

test('every element the assistant touches exists in the page',()=>{
  const used=new Set([...assistant.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m=>m[1]));
  const missing=[...used].filter(id=>!ids.has(id));
  assert.deepEqual(missing,[],'missing ids: '+missing.join(', '));
});

test('the dictation engine is loaded before the app script',()=>{
  const engine=html.indexOf('<script src="voice-dictation.js"></script>');
  const app=html.indexOf('<script src="task-assistant.js"></script>');
  const inline=html.indexOf('<script>',app);
  assert.ok(engine>0&&app>0);
  assert.ok(engine<inline,'voice-dictation.js must load before the inline application code');
  assert.ok(app<inline);
  assert.ok(fs.existsSync(path.join(__dirname,'../voice-dictation.js')));
  assert.ok(fs.existsSync(path.join(__dirname,'../task-assistant.js')));
});

test('the confirmation window has the required labels and fields',()=>{
  assert.match(html,/id="voiceConfirm"[^>]*>✅ Konfirmo dhe dërgo</);
  assert.match(html,/id="voiceCancel"[^>]*>Anulo</);
  for(const id of ['voiceDraftTitle','voiceDraftDesc','voiceDraftAssignee','voiceDraftDue','voiceDraftPriority','voiceDraftNotify'])
    assert.ok(ids.has(id),'missing field '+id);
  assert.match(html,/id="voiceLive"/);
  assert.match(html,/id="voiceLiveState"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html,/id="voiceLiveText"/,'the panel must not duplicate the composer transcript');
  assert.match(html,/id="voiceLiveCancel"/);
  assert.doesNotMatch(html.match(/<input[^>]*id="tTitle"[^>]*>/)[0],/aria-live/,'individual dictated words must not be announced as a live region');
});

test('the app never records without the dictation engine',()=>{
  assert.match(html,/VoiceDictation\.create\(/);
  assert.ok(!/setTimeout\(\(\)=>finish\(session\),5000\)/.test(html),'the old recognition-only silence timer is gone');
  assert.match(html,/speechThreshold|noteLevel/);
});

test('the page reads recogniser events through the engine, never by hand',()=>{
  const app=html.slice(0,html.indexOf('/* ADD TASK */'));
  assert.match(app,/VoiceDictation\.readResults\(event,consumedFinal\)/);
  assert.match(app,/consumedFinal=-1/,'a restarted session numbers its results from zero again');
  assert.doesNotMatch(app,/for\(let i=event\.resultIndex/,'the resultIndex-only loop dropped unfinished words');
  assert.match(app,/session\.recognition!==recognition/,'a replaced or released recogniser can never write again');
  assert.match(app,/recognitionFatal/,'a hopeless recogniser is not restarted in a loop');
  assert.match(app,/language-not-supported/,'a browser that does not know Albanian says so');
});

test('the microphone order that works on phones is untouched',()=>{
  const app=html.slice(0,html.indexOf('/* ADD TASK */'));
  const recorder=app.indexOf('startRecorder(session,stream);');
  const recogniser=app.indexOf('startRecognitionSoon(session,session.mobile');
  assert.ok(recorder>0&&recogniser>recorder,'the recorder takes the microphone before the recogniser');
  assert.match(app,/const RECOGNITION_DELAY_MS=200;/,'the recogniser still waits 200 ms only on touch with a recorder');
  assert.match(app,/session\.mobile&&session\.recordAudio\?RECOGNITION_DELAY_MS:0/);
  assert.match(app,/if\(engine&&state!=='idle'\)engine\.flushInterim\(\);/, 'onend still flushes the unfinished words');
  assert.match(app,/const RESTART_WINDOW_MS=2000, RESTART_STORM=3, RESTART_BACKOFF_MS=150;/,'the restart backoff is unchanged');
  assert.match(app,/const interrupted=!!\(session\.restarts>0\|\|session\.liveFailed\|\|!session\.useRecognition\);/,'the audio is sent under the same conditions');
});

test('the final server transcript stays authoritative and the live text stays the fallback',()=>{
  const app=html.slice(0,html.indexOf('/* ADD TASK */'));
  assert.match(app,/if\(dictationSession&&serverTranscript\)liveComposer\(dictationSession,serverTranscript\);/);
  assert.match(app,/const fallback=serverTranscript\|\|text;/);
  assert.match(app,/showVoiceDraft\(fallback,null,'Përpunim lokal — AI nuk u përdor'/);
});

test('the dictation panel explains the language case and keeps the diagnostics honest',()=>{
  assert.match(html,/nuk njeh shqipen për tekst live/);
  assert.match(html,/function dictationDiag\(session\)/);
  assert.match(html,/dallimi live\/final/);
  assert.match(html,/pajisja: '\+deviceSummary\(\)/);
});
