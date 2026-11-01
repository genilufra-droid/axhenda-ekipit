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
    if (url.includes('select=display_name')) return json([{ display_name: 'Arben Kola' }, { display_name: 'Ana Hoxha' }]);
    return provider ? provider(url, options) : json({});
  };
  vm.runInNewContext(load(name), {
    Deno: { env: { get: (k) => vars[k] }, serve: (fn) => { handler = fn; } },
    fetch, Request, Response, File, FormData, Uint8Array, Array, btoa, JSON, String, Date, Set, Promise, AbortSignal, DOMException, setTimeout, console: { error() {}, log() {} },
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
test('transcribe: only the owner, only signed in, and nothing empty', async () => {
  const employee = endpoint('transcribe-task', { role: 'employee' });
  assert.equal((await employee.handler(post(form({ liveTranscript: 'a' })))).status, 403);
  assert.equal(employee.geminiCalls().length, 0);
  assert.equal((await endpoint('transcribe-task', { badSession: true }).handler(post(form({ liveTranscript: 'a' })))).status, 401);
  assert.equal((await endpoint('transcribe-task').handler(post(form({ liveTranscript: 'a' }), null))).status, 401);
  assert.equal((await endpoint('transcribe-task').handler(post(form({})))).status, 400);
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
test('speak: owner gets audio, others and signed-out callers do not', async () => {
  const ok = () => json({ candidates: [{ content: { parts: [{ inlineData: { data: 'QUJD', mimeType: 'audio/pcm;rate=24000' } }] } }] });
  const body = JSON.stringify({ text: 'Përshëndetje' });
  const res = await endpoint('assistant-speak', { provider: ok }).handler(post(body));
  assert.deepEqual(await res.json(), { ok: true, audioBase64: 'QUJD', mimeType: 'audio/pcm;rate=24000' });
  assert.equal((await endpoint('assistant-speak', { role: 'employee', provider: ok }).handler(post(body))).status, 403);
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
  assert.match(seen[0], /gemini-3\.5-flash-lite/, 'fast live-verified model is first');
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

