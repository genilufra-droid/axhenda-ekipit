const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const load = (name) => stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../supabase/functions/' + name + '/index.ts'), 'utf8'));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const SECRET = 'gemini-secret-key';

function endpoint(name, { role = 'owner', badSession = false, provider = null, env = {} } = {}) {
  let handler;
  const calls = [];
  const vars = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srv', GEMINI_API_KEY: SECRET, ...env };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return json({ id: 'u1' }, badSession ? 401 : 200);
    if (url.includes('select=role')) return json([{ role }]);
    if (url.includes('select=display_name')) return json([{ display_name: 'Arben Kola', username: 'arben' }, { display_name: 'Ana Hoxha', username: 'ana' }, { display_name: 'Mariglen Myftari', username: 'geni' }]);
    if (url.includes('/rest/v1/punonjesit')) return json([{ emri: 'Dorjela', mbiemri: 'Daja', departamenti: 'Finance', aktiv: true }]);
    return provider ? provider(url, options) : json({});
  };
  vm.runInNewContext(load(name), {
    Deno: { env: { get: (k) => vars[k] }, serve: (fn) => { handler = fn; } },
    fetch, Request, Response, File, FormData, Uint8Array, Array, Map, btoa, JSON, String, Date, Set, Promise, AbortSignal, DOMException, setTimeout, console: { error() {}, log() {} },
  });
  const geminiCalls = () => calls.filter((c) => c.url.includes('generativelanguage'));
  return { handler, calls, geminiCalls };
}
const gemini = (obj) => () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const post = (body, token = 'Bearer jwt') => new Request('https://f', { method: 'POST', headers: token ? { Authorization: token } : {}, body });
const form = (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f; };

test('transcribe: text without audio becomes a draft with the verified fields', async () => {
  const e = endpoint('transcribe-task', { provider: gemini({ transcript: 'Arben Kola raportin nesër', title: 'Raporti', assignee: 'Arben Kola, Person imagjinar', due: '2026-02-30', priority: 'urgjent' }) });
  const res = await e.handler(post(form({ liveTranscript: 'Arben Kola raportin nesër', today: '2026-11-01' })));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.draft.assignee, 'Arben Kola', 'invented people are dropped');
  assert.equal(data.draft.due, '', 'impossible dates are dropped');
  assert.equal(data.draft.priority, 'Lart');
  assert.equal(e.geminiCalls().length, 1);
  assert.ok(e.geminiCalls()[0].options.body.includes('2026-11-01'), 'uses the date the app sends');
});
test('transcribe: audio is sent to Gemini inline and the key never appears in the URL', async () => {
  const e = endpoint('transcribe-task', { provider: gemini({ transcript: 'x', title: 'T' }) });
  const f = form({ today: '2026-11-01' });
  f.append('audio', new File([new Uint8Array([1, 2, 3])], 'task.webm', { type: 'audio/webm' }));
  const res = await e.handler(post(f));
  assert.equal(res.status, 200);
  const call = e.geminiCalls()[0];
  assert.ok(call.options.body.includes('inlineData'));
  assert.ok(!call.url.includes(SECRET));
});
test('transcribe: requires signed-in team member, blocks unknown roles, and scopes employee to employeeProposal only', async () => {
  const guest = endpoint('transcribe-task', { role: 'guest' });
  assert.equal((await guest.handler(post(form({ liveTranscript: 'a' })))).status, 403);
  assert.equal(guest.geminiCalls().length, 0);
  const emptyRole = endpoint('transcribe-task', { role: '' });
  assert.equal((await emptyRole.handler(post(form({ liveTranscript: 'a' })))).status, 403);
  assert.equal((await endpoint('transcribe-task', { badSession: true }).handler(post(form({ liveTranscript: 'a' })))).status, 401);
  assert.equal((await endpoint('transcribe-task').handler(post(form({ liveTranscript: 'a' }), null))).status, 401);
  assert.equal((await endpoint('transcribe-task').handler(post(form({})))).status, 400);

  // Employee mode returns employeeProposal (never owner draft) and rejects foreign taskId
  const myTasks = JSON.stringify([
    { id: 'emp-1', title: 'Dërgo faturat', due: '2026-11-04', priority: 'Lart', done: false },
    { id: 'emp-2', title: 'Përgatit pasqyrën', due: '', priority: 'Mesme', done: false },
  ]);
  const empOk = endpoint('transcribe-task', {
    role: 'employee',
    provider: gemini({ transcript: 'E përfundova dërgimin e faturave', action: 'complete', taskId: 'emp-1', note: 'U dërguan me email' }),
  });
  const empRes = await empOk.handler(post(form({ liveTranscript: 'E përfundova dërgimin e faturave', myTasks, today: '2026-11-03' })));
  const empData = await empRes.json();
  assert.equal(empRes.status, 200);
  assert.equal(empData.mode, 'employee');
  assert.equal(empData.draft, undefined, 'employee never receives owner task creation draft');
  assert.equal(empData.employeeProposal.action, 'complete');
  assert.equal(empData.employeeProposal.taskId, 'emp-1');

  // Negated completion ("Nuk e përfundova dot...") is downgraded to "report" on the server too
  const empNeg = endpoint('transcribe-task', {
    role: 'punonjës',
    provider: gemini({ transcript: 'Nuk e përfundova dot faturën sepse mungon vula', action: 'complete', taskId: 'foreign-999', note: 'Mungon vula' }),
  });
  const negData = await (await empNeg.handler(post(form({ liveTranscript: 'Nuk e përfundova dot', myTasks })))).json();
  assert.equal(negData.employeeProposal.action, 'report');
  assert.equal(negData.employeeProposal.taskId, '', 'foreign taskId not in myTasks is stripped');
});
test('transcribe: provider failures return a short Albanian message, never provider text or secrets', async () => {
  const leak = () => new Response('RAW PROVIDER DETAIL ' + SECRET, { status: 500 });
  const bad = await endpoint('transcribe-task', { provider: leak }).handler(post(form({ liveTranscript: 'a' })));
  const text = await bad.text();
  assert.equal(bad.status, 502);
  assert.ok(!text.includes('RAW') && !text.includes(SECRET));
  const limited = await endpoint('transcribe-task', { provider: () => new Response('quota', { status: 429 }) }).handler(post(form({ liveTranscript: 'a' })));
  assert.equal(limited.status, 429);
  const garbage = await endpoint('transcribe-task', { provider: () => json({ candidates: [{ content: { parts: [{ text: 'jo json' }] } }] }) }).handler(post(form({ liveTranscript: 'a' })));
  assert.equal(garbage.status, 502);
  assert.ok(!(await garbage.text()).includes('jo json'));
  assert.equal((await endpoint('transcribe-task', { env: { GEMINI_API_KEY: '' } }).handler(post(form({ liveTranscript: 'a' })))).status, 500);
});
test('speak: signed-in owner and employee get audio, unauthorized roles and signed-out callers do not', async () => {
  const ok = () => json({ candidates: [{ content: { parts: [{ inlineData: { data: 'QUJD', mimeType: 'audio/pcm;rate=24000' } }] } }] });
  const body = JSON.stringify({ text: 'Përshëndetje' });
  const res = await endpoint('assistant-speak', { provider: ok }).handler(post(body));
  assert.deepEqual(await res.json(), { ok: true, audioBase64: 'QUJD', mimeType: 'audio/pcm;rate=24000' });
  const empRes = await endpoint('assistant-speak', { role: 'employee', provider: ok }).handler(post(body));
  assert.deepEqual(await empRes.json(), { ok: true, audioBase64: 'QUJD', mimeType: 'audio/pcm;rate=24000' });
  assert.equal((await endpoint('assistant-speak', { role: 'guest', provider: ok }).handler(post(body))).status, 403);
  assert.equal((await endpoint('assistant-speak', { provider: ok }).handler(post(body, null))).status, 401);
  assert.equal((await endpoint('assistant-speak', { provider: ok }).handler(post('{}'))).status, 400);
});
test('speak: provider failure is generic and the text is capped', async () => {
  const e = endpoint('assistant-speak', { provider: () => new Response('RAW ' + SECRET, { status: 500 }) });
  const res = await e.handler(post(JSON.stringify({ text: 'a'.repeat(5000) })));
  const text = await res.text();
  assert.equal(res.status, 502);
  assert.ok(!text.includes('RAW') && !text.includes(SECRET));
  assert.ok(e.geminiCalls()[0].options.body.length < 1500, 'long text is cut');
});
test('a provider that hangs ends with a short timeout message instead of hanging', async () => {
  const hang = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  });
  const e = endpoint('assistant-speak', { provider: hang });
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('t', 'TimeoutError')), 20);
    return c.signal;
  };
  try {
    const res = await e.handler(post(JSON.stringify({ text: 'a' })));
    assert.equal(res.status, 504);
  } finally { AbortSignal.timeout = realTimeout; }
});
test('an unknown or hanging first model falls through to the next one', async () => {
  const seen = [];
  const provider = (url) => {
    seen.push(url);
    if (seen.length < 2) return new Response('no such model', { status: 404 });
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: 'x', title: 'T' }) }] } }] });
  };
  const e = endpoint('transcribe-task', { provider });
  const res = await e.handler(post(form({ liveTranscript: 'a' })));
  assert.equal(res.status, 200);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /gemini-3\.6-flash/, 'high-accuracy Albanian multimodal model is first');
  assert.match(seen[1], /gemini-3-flash-preview/, 'second high-accuracy model follows immediately');
});

test('transcribe: runs Whisper Large v3 (sq) in parallel with Gemini 3.6 Flash, skips thought parts, and resolves inflected Albanian names & aliases', async () => {
  const seenUrls = [];
  let geminiBody = '';
  const ensembleProvider = (url, options) => {
    seenUrls.push(url);
    if (url.includes('audio/transcriptions')) {
      return json({ text: 'Thuaj Genit dhe Dorgjela Dajes të kontrollojnë qatin nesër urgjent' });
    }
    if (url.includes('generativelanguage')) {
      geminiBody = String(options.body || '');
      return json({
        candidates: [{
          content: {
            parts: [
              { thought: true, text: 'Duke verifikuar audion me shqipen standarde...' },
              {
                text: JSON.stringify({
                  transcript: 'Thuaji Genit dhe Dorjela Dajës të kontrollojnë çatinë nesër urgjent.',
                  title: 'Kontrollo çatinë',
                  description: 'Thuaji Genit dhe Dorjela Dajës të kontrollojnë çatinë nesër urgjent.',
                  assignee: ['Genit', 'Dorjelës', 'Person imagjinar'],
                  due: '2026-11-02',
                  priority: 'Lart',
                }),
              },
            ],
          },
        }],
      });
    }
    return new Response('unexpected', { status: 500 });
  };
  const e = endpoint('transcribe-task', { env: { GROQ_API_KEY: 'gsk-test' }, provider: ensembleProvider });
  const f = form({ today: '2026-11-01', vocabulary: 'Mariglen Myftari, Dorjela Daja', liveTranscript: 'thuaji genit dorgjela qatin neser' });
  f.append('audio', new File([new Uint8Array([9, 8, 7, 6])], 'task.webm', { type: 'audio/webm' }));
  const res = await e.handler(post(f));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.transcript, 'Thuaji Genit dhe Dorjela Dajës të kontrollojnë çatinë nesër urgjent.');
  assert.equal(data.draft.assignee, 'Mariglen Myftari, Dorjela Daja', 'resolves alias Genit -> Mariglen Myftari and inflected Dorjelës -> Dorjela Daja while dropping hallucinated names');
  assert.ok(seenUrls.some((u) => u.includes('audio/transcriptions')), 'Whisper sq ran in parallel');
  assert.ok(geminiBody.includes('Dorgjela Dajes'), 'Whisper acoustic anchor was supplied to Gemini');
  assert.ok(geminiBody.includes('thuaji genit dorgjela qatin neser'), 'Browser Google sq-AL preview was also supplied to Gemini');
});

test('transcribe: unwraps array JSON and falls back to Groq Whisper + Llama when Gemini fails', async () => {
  const arrayProvider = () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify([{ transcript: 'Cakto Arben Kola raportin', title: 'Raporti', assignee: 'Arben Kola', priority: 'Lart' }]) }] } }] });
  const r1 = await endpoint('transcribe-task', { provider: arrayProvider }).handler(post(form({ liveTranscript: 'x', today: '2026-11-01' })));
  assert.equal(r1.status, 200);
  const d1 = await r1.json();
  assert.equal(d1.draft.title, 'Raporti');
  assert.equal(d1.draft.assignee, 'Arben Kola');

  const seenUrls = [];
  const groqFallbackProvider = (url) => {
    seenUrls.push(url);
    if (url.includes('generativelanguage')) return new Response('unavailable', { status: 503 });
    if (url.includes('audio/transcriptions')) return json({ text: 'Cakto Arben Kola të dërgojë faturën nesër urgjent' });
    if (url.includes('chat/completions')) {
      return json({
        choices: [{
          message: {
            content: JSON.stringify({
              transcript: 'Cakto Arben Kola të dërgojë faturën nesër urgjent',
              title: 'Dërgo faturën',
              description: 'Cakto Arben Kola të dërgojë faturën nesër urgjent',
              assignee: 'Arben Kola',
              due: '2026-11-02',
              priority: 'Lart',
            }),
          },
        }],
      });
    }
    return new Response('unexpected', { status: 500 });
  };
  const e2 = endpoint('transcribe-task', { env: { GROQ_API_KEY: 'gsk-test' }, provider: groqFallbackProvider });
  const f = form({ today: '2026-11-01', vocabulary: 'Arben Kola' });
  f.append('audio', new File([new Uint8Array([1, 2, 3, 4])], 'task.webm', { type: 'audio/webm' }));
  const r2 = await e2.handler(post(f));
  assert.equal(r2.status, 200);
  const d2 = await r2.json();
  assert.equal(d2.ok, true);
  assert.equal(d2.transcript, 'Cakto Arben Kola të dërgojë faturën nesër urgjent');
  assert.equal(d2.draft.title, 'Dërgo faturën');
  assert.equal(d2.draft.assignee, 'Arben Kola');
  assert.equal(d2.draft.due, '2026-11-02');
  assert.equal(d2.draft.priority, 'Lart');
  assert.ok(seenUrls.some((u) => u.includes('api.groq.com/openai/v1/audio/transcriptions')));
  assert.ok(seenUrls.some((u) => u.includes('api.groq.com/openai/v1/chat/completions')));
});

test('speak: uses gemini-3.8-flash-lite-tts with raw text and zero instruction prefix bleed', async () => {
  const ok = () => json({ candidates: [{ content: { parts: [{ inlineData: { data: 'QUJD', mimeType: 'audio/pcm;rate=24000' } }] } }] });
  const phrase = 'Përshëndetje Besnik Koci! Çfarë detyre do të shkruajmë?';
  const e = endpoint('assistant-speak', { provider: ok });
  const res = await e.handler(post(JSON.stringify({ text: phrase })));
  assert.equal(res.status, 200);
  const call = e.geminiCalls()[0];
  assert.match(call.url, /gemini-3\.8-flash-lite-tts/);
  const sent = JSON.parse(call.options.body);
  assert.equal(sent.contents[0].parts[0].text, phrase, 'raw phrase only so TTS never speaks an instruction prefix');
});

test('transcribe v20: sends full untruncated roster to Whisper, injects exact Albanian calendar table, and recovers phonetic/omitted assignees', async () => {
  let whisperPrompt = '';
  let geminiPayload = '';
  const provider = (url, options) => {
    if (url.includes('audio/transcriptions')) {
      whisperPrompt = String(options.body.get('prompt') || '');
      return json({ text: 'Thuaji Dorgjelës dhe Mariglen Miftarit me dërgu bilancin javën tjetër pa ngut' });
    }
    if (url.includes('generativelanguage')) {
      geminiPayload = String(options.body || '');
      return json({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                transcript: 'Thuaji Dorjelës dhe Mariglen Myftarit të dërgojnë bilancin javën tjetër pa ngut.',
                title: 'Dërgo bilancin',
                description: 'Thuaji Dorjelës dhe Mariglen Myftarit të dërgojnë bilancin javën tjetër pa ngut.',
                assignee: '', // omitted by LLM -> recovered from verified transcript!
                due: '2026-11-09',
                priority: 'pa ngut',
              }),
            }],
          },
        }],
      });
    }
    return new Response('unexpected', { status: 500 });
  };
  const e = endpoint('transcribe-task', { env: { GROQ_API_KEY: 'gsk-test' }, provider });
  const longVocab = 'Kledis Doga, Jorgo Toshkollari, Nevila Koci, Fitim Basha, Mersin Leka, Eniana Dervishi, Oksana Prifti';
  const f = form({ today: '2026-11-02', vocabulary: longVocab });
  f.append('audio', new File([new Uint8Array([4, 5, 6])], 'task.webm', { type: 'audio/webm' }));
  const res = await e.handler(post(f));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(whisperPrompt.length > 260, 'Whisper prompt is no longer truncated at 224 characters');
  assert.ok(whisperPrompt.includes('Dorjela Daja') && whisperPrompt.includes('Oksana Prifti'), 'all roster & vocabulary names reach Whisper');
  const promptSent = JSON.parse(geminiPayload).contents[0].parts[1].text;
  assert.ok(promptSent.includes('"nesër" = 2026-11-03') && promptSent.includes('"javën tjetër" = 2026-11-09'), 'deterministic Albanian calendar table is injected');
  assert.equal(data.draft.assignee, 'Dorjela Daja, Mariglen Myftari', 'recovers canonical assignees from transcript when LLM left assignee blank');
  assert.equal(data.draft.due, '2026-11-09');
  assert.equal(data.draft.priority, 'Ulet');
});


