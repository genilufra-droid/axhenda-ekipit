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
  assert.match(html,/id="voiceLiveText"/);
  assert.match(html,/id="voiceLiveCancel"/);
});

test('the app never records without the dictation engine',()=>{
  assert.match(html,/VoiceDictation\.create\(/);
  assert.ok(!/setTimeout\(\(\)=>finish\(session\),5000\)/.test(html),'the old recognition-only silence timer is gone');
  assert.match(html,/speechThreshold|noteLevel/);
});
