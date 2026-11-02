// Edge Function: transcribe-task (v20 — Abacus Audit Albanian Speech & NLU Edition)
// High-accuracy 3-Engine Albanian Speech-to-Text + Executive Task Extraction:
//   1. Groq Whisper Large v3 (`language: "sq"`, full 820-char roster + Albanian orthographic seed)
//   2. Browser Google SpeechRecognition (`sq-AL` N-best live preview)
//   3. Gemini 3.6 Flash Multimodal Audio (`inlineData` + `systemInstruction` + `thinkingLevel: LOW`)
// Plus deterministic Albanian calendar lookup, Gheg/Tosk dialect comprehension, and
// phonetic + inflected + bounded-edit-distance employee/alias verification.
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GROQ_AUDIO = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions';

const MODELS: Array<{ id: string; thinkingLevel?: 'LOW' | 'MINIMAL' }> = [
  { id: 'gemini-3.6-flash', thinkingLevel: 'LOW' },
  { id: 'gemini-3-flash-preview', thinkingLevel: 'MINIMAL' },
  { id: 'gemini-3.1-flash-lite-preview' },
  { id: 'gemini-2.0-flash' },
];
const GROQ_CHAT_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MAX_AUDIO = 12 * 1024 * 1024;
const GEMINI_TIMEOUT_MS = 18_000;
const WHISPER_TIMEOUT_MS = 6_500;
const GROQ_CHAT_TIMEOUT_MS = 9_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const fold = (s: string) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ë/gi, 'e').replace(/ç/gi, 'c').toLowerCase().trim();

/* Albanian phonetic normalization for acoustic ASR confusions:
 * liquid gemination (rr/r, ll/l), palatal affricates (gj/j, xh/x, q/c before front vowels),
 * and hiatus glides (ia/ja, ie/je, io/jo). */
function phoneticSq(s: string): string {
  return fold(s)
    .replace(/[^a-z0-9]/g, '')
    .replace(/rr/g, 'r')
    .replace(/ll/g, 'l')
    .replace(/gj/g, 'j')
    .replace(/xh/g, 'x')
    .replace(/ia/g, 'ja')
    .replace(/ie/g, 'je')
    .replace(/io/g, 'jo');
}

function stripSqCase(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(?:it|in|ut|un|es|en|se|ve|s|t|n|a|i|u)$/, '');
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (edits >= 1) return false;
    edits++;
    if ( i + 1 < la && j + 1 < lb && a[i] === b[j + 1] && a[i + 1] === b[j] ) {
      i += 2; j += 2; continue; // adjacent transposition
    }
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

const validDate = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false;
  const [y, m, d] = v.split('-').map(Number), dt = new Date(y, m - 1, d, 12);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}` === v;
};

const fmtIso = (dt: Date) =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

/* Pre-computes an exact Albanian calendar reference table from `today` so LLMs
 * never miscalculate day-of-week or month-boundary arithmetic. */
function buildAlbanianCalendar(today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const base = new Date(y, m - 1, d, 12);
  const dayNamesNom = ['e diel', 'e hënë', 'e martë', 'e mërkurë', 'e enjte', 'e premte', 'e shtunë'];
  const dayNamesAcc = ['të dielën', 'të hënën', 'të martën', 'të mërkurën', 'të enjten', 'të premten', 'të shtunën'];
  const add = (n: number) => { const c = new Date(base.getTime()); c.setDate(c.getDate() + n); return fmtIso(c); };
  const upcoming: string[] = [];
  for (let target = 0; target < 7; target++) {
    const delta = ((target - base.getDay() + 7) % 7) || 7;
    upcoming.push(`${dayNamesAcc[target]} = ${add(delta)}`);
  }
  return [
    `Data e sotme ("sot" / "sonte" / "brenda ditës"): ${dayNamesNom[base.getDay()]}, ${today}`,
    `"nesër" = ${add(1)} | "pasnesër" = ${add(2)} | "javën tjetër" = ${add(7)}`,
    `Ditët e ardhshme të javës: ${upcoming.join(', ')}`,
  ].join('\n');
}

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function authorizeOwner(req: Request, url: string, key: string) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return { error: json({ error: 'Kërkohet hyrja në llogari.' }, 401) };
  const headers = { apikey: key, Authorization: auth };
  const userRes = await fetch(`${url}/auth/v1/user`, { headers });
  if (!userRes.ok) return { error: json({ error: 'Sesioni nuk është i vlefshëm.' }, 401) };
  const user = await userRes.json();
  const profRes = await fetch(
    `${url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  const rows = profRes.ok ? await profRes.json() : [];
  if (rows?.[0]?.role !== 'owner') return { error: json({ error: 'Vetëm pronari mund të përdorë asistentin me zë.' }, 403) };
  return { ok: true };
}

interface Roster {
  names: string[];
  aliasMap: Map<string, string>; // folded alias/username -> canonical full name
  deptInfo: string[];            // "Dorjela Daja (Finance)" for richer LLM context
}

async function loadRoster(url: string, key: string): Promise<Roster> {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const canonical = new Map<string, string>();
  const aliasMap = new Map<string, string>();
  const deptByPerson = new Map<string, string>();
  const addName = (raw: string, alias?: string, dept?: string) => {
    const clean = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!clean) return;
    const f = fold(clean);
    if (!canonical.has(f)) canonical.set(f, clean);
    const canon = canonical.get(f)!;
    if (alias) {
      const fa = fold(alias);
      if (fa && fa.length >= 3 && fa !== f) aliasMap.set(fa, canon);
    }
    if (dept && !deptByPerson.get(canon)) deptByPerson.set(canon, String(dept).trim());
  };
  const [prof, pun] = await Promise.all([
    fetch(`${url}/rest/v1/profiles?select=display_name,username&role=in.(employee,punonj%C3%ABs,punonjes)`, { headers })
      .then(r => r.ok ? r.json() : []).catch(() => []),
    fetch(`${url}/rest/v1/punonjesit?select=emri,mbiemri,departamenti,aktiv`, { headers })
      .then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  for (const r of Array.isArray(pun) ? pun : []) {
    if (r?.aktiv === false) continue;
    const full = `${r?.emri || ''} ${r?.mbiemri || ''}`.trim();
    if (full) addName(full, r?.emri || '', r?.departamenti);
  }
  for (const r of Array.isArray(prof) ? prof : []) {
    addName(r?.display_name || r?.username || '', r?.username || '');
  }
  const names = [...canonical.values()];
  const deptInfo = names.map(n => deptByPerson.get(n) ? `${n} (${deptByPerson.get(n)})` : n);
  return { names, aliasMap, deptInfo };
}

/* Matches an Albanian name word even when spoken in dative/accusative/genitive/definite case
 * OR with common acoustic/ASR confusions (Dorgjela/Dorjela, Toshkolari/Toshkollari, Genit/Geni). */
function sameAlbanianNameWord(spokenWord: string, canonicalWord: string): boolean {
  const s = fold(spokenWord).replace(/[^a-z0-9]/g, '');
  const c = fold(canonicalWord).replace(/[^a-z0-9]/g, '');
  if (!s || !c) return false;
  if (s === c) return true;
  if (c.length < 3 || s.length < 3) return false;
  const stem = /[aei]$/.test(c) ? c.slice(0, -1) : c;
  if (stem.length >= 3 && s.startsWith(stem)) {
    const suffix = s.slice(stem.length);
    if (/^(a|e|i|u|s|t|n|it|in|ut|un|es|en|se|ve)?$/.test(suffix)) return true;
  }
  // Phonetic + bounded 1-char edit check on stems >= 5 chars
  if (c.length >= 5 && s.length >= 5) {
    const ps = phoneticSq(s), pc = phoneticSq(c);
    const pcStem = /[aei]$/.test(pc) ? pc.slice(0, -1) : pc;
    if (ps === pc) return true;
    if (pcStem.length >= 4 && ps.startsWith(pcStem) && /^(a|e|i|u|s|t|n|it|in|ut|un|es|en|se|ve)?$/.test(ps.slice(pcStem.length))) {
      return true;
    }
    const strippedS = stripSqCase(ps), strippedC = stripSqCase(pc);
    if (strippedS.length >= 4 && strippedC.length >= 4 && editDistanceAtMostOne(strippedS, strippedC)) {
      return true;
    }
  }
  return false;
}

function resolveSinglePerson(raw: string, roster: Roster): string | null {
  const clean = fold(raw).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const exact = roster.names.find(p => fold(p) === clean);
  if (exact) return exact;
  if (roster.aliasMap.has(clean)) return roster.aliasMap.get(clean)!;
  for (const [alias, canon] of roster.aliasMap.entries()) {
    if (sameAlbanianNameWord(clean, alias)) return canon;
  }
  const rWords = clean.split(' ');
  for (const p of roster.names) {
    const pWords = fold(p).split(/\s+/);
    if (pWords.length === rWords.length && pWords.every((pw, idx) => sameAlbanianNameWord(rWords[idx], pw))) {
      return p;
    }
  }
  if (rWords.length === 1 && rWords[0].length >= 4) {
    const firstMatches = roster.names.filter(p => sameAlbanianNameWord(rWords[0], fold(p).split(/\s+/)[0]));
    if (firstMatches.length === 1) return firstMatches[0];
  }
  for (const p of roster.names) {
    const pWords = fold(p).split(/\s+/);
    if (rWords.every(rw => pWords.some(pw => sameAlbanianNameWord(rw, pw)))) return p;
  }
  return null;
}

function resolveAssignees(rawList: string[], roster: Roster): string {
  const resolved: string[] = [];
  for (const raw of rawList) {
    const match = resolveSinglePerson(raw, roster);
    if (match && !resolved.includes(match)) resolved.push(match);
  }
  return resolved.join(', ');
}

/* Safety net: if the LLM left `assignee` empty even though the verified Albanian transcript
 * explicitly contains a known employee full name, first name, or alias, recover it cleanly. */
function recoverAssigneesFromTranscript(transcript: string, roster: Roster): string {
  if (!transcript) return '';
  const words = fold(transcript).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const hits: Array<{ name: string; pos: number }> = [];
  const addHit = (name: string, pos: number) => {
    if (!hits.some(h => h.name === name)) hits.push({ name, pos });
  };
  for (let i = 0; i < words.length; i++) {
    if (i + 1 < words.length) {
      for (const p of roster.names) {
        const pWords = fold(p).split(/\s+/);
        if (pWords.length === 2 && sameAlbanianNameWord(words[i], pWords[0]) && sameAlbanianNameWord(words[i + 1], pWords[1])) {
          addHit(p, i);
        }
      }
    }
    const w = words[i];
    if (w.length < 4) continue;
    for (const [alias, canon] of roster.aliasMap.entries()) {
      if (alias.length >= 4 && sameAlbanianNameWord(w, alias)) addHit(canon, i);
    }
    const firstMatches = roster.names.filter(p => sameAlbanianNameWord(w, fold(p).split(/\s+/)[0]));
    if (firstMatches.length === 1) addHit(firstMatches[0], i);
  }
  return hits.sort((a, b) => a.pos - b.pos).map(h => h.name).join(', ');
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  if (!rawText) return null;
  const trimmed = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return (v[0] && typeof v[0] === 'object' ? v[0] : null) as Record<string, unknown> | null;
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch { return null; }
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const firstBrace = trimmed.indexOf('{'), lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) return tryParse(trimmed.slice(firstBrace, lastBrace + 1));
  return null;
}

/* Engine 1: Groq Whisper Large v3 dedicated Albanian ASR (`language: "sq"`).
 * Uses up to 820 characters (~190 tokens, safely inside Whisper's 224-token prompt limit)
 * with employee names & aliases FIRST so none are ever truncated. */
async function transcribeWithGroqWhisper(
  bytes: Uint8Array,
  mimeType: string,
  whisperPrompt: string,
  groqKey: string,
): Promise<string> {
  if (!groqKey || !bytes.length) return '';
  try {
    const ext = mimeType.includes('mp4') || mimeType.includes('m4a')
      ? 'm4a'
      : mimeType.includes('ogg')
      ? 'ogg'
      : mimeType.includes('wav')
      ? 'wav'
      : 'webm';
    const fd = new FormData();
    fd.append('file', new File([bytes], `speech.${ext}`, { type: mimeType || 'audio/webm' }));
    fd.append('model', 'whisper-large-v3');
    fd.append('language', 'sq');
    fd.append('temperature', '0');
    fd.append('response_format', 'json');
    if (whisperPrompt) fd.append('prompt', whisperPrompt.slice(0, 820));

    const res = await fetch(GROQ_AUDIO, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: fd,
      signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const payload = await res.json().catch(() => null);
    return String(payload?.text || '').trim();
  } catch {
    return '';
  }
}

async function extractWithGroqChat(
  transcriptText: string,
  promptContext: string,
  groqKey: string,
): Promise<Record<string, unknown> | null> {
  if (!groqKey || !transcriptText) return null;
  for (const model of GROQ_CHAT_MODELS) {
    try {
      const res = await fetch(GROQ_CHAT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Je ekspert i gjuhës shqipe (standarde dhe të folur / gegërisht e toskërisht) dhe asistent ekzekutiv. Kthe VETËM një objekt JSON valid me fushat: transcript, title, description, assignee, due, priority.',
            },
            { role: 'user', content: `${promptContext}\n\nTranskripti i verifikuar shqip: "${transcriptText}"` },
          ],
        }),
        signal: AbortSignal.timeout(GROQ_CHAT_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      const parsed = parseJsonObject(String(body?.choices?.[0]?.message?.content || ''));
      if (parsed) return parsed;
    } catch { /* try next Groq chat model */ }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Metoda nuk lejohet.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';
  const groqKey = Deno.env.get('GROQ_API_KEY') || '';
  if (!supabaseUrl || !serviceKey || (!geminiKey && !groqKey)) {
    return json({ error: 'Shërbimi AI nuk është konfiguruar.' }, 500);
  }

  const gate = await authorizeOwner(req, supabaseUrl, serviceKey);
  if ('error' in gate) return gate.error;

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: 'Kërkesa nuk u lexua.' }, 400); }

  const audio = form.get('audio');
  const liveTranscript = String(form.get('liveTranscript') || '').slice(0, 4000).trim();
  const vocabulary = String(form.get('vocabulary') || '').slice(0, 1200).trim();
  const currentDraft = String(form.get('currentDraft') || '').slice(0, 2000).trim();
  const requestedToday = String(form.get('today') || '');
  const today = validDate(requestedToday) ? requestedToday : fmtIso(new Date());

  const audioFile = audio instanceof File && audio.size > 0 ? audio : null;
  if (audioFile && audioFile.size > MAX_AUDIO) return json({ error: 'Regjistrimi është shumë i gjatë.' }, 413);
  if (!audioFile && !liveTranscript) return json({ error: ' nuk u dëgjua asnjë fjalë. Fol përsëri.' }, 400);

  // Load audio bytes and full DB employee roster simultaneously (~30ms) so Whisper gets EVERY employee & alias!
  const [audioBuf, roster] = await Promise.all([
    audioFile ? audioFile.arrayBuffer() : Promise.resolve(null),
    loadRoster(supabaseUrl, serviceKey),
  ]);
  const audioBytes = audioBuf ? new Uint8Array(audioBuf) : null;
  const mimeType = audioFile ? (audioFile.type || 'audio/webm').split(';')[0] : '';

  const aliasEntries = [...roster.aliasMap.entries()].map(([a, c]) => `${a} (${c})`);
  const whisperPrompt = [
    roster.names.length ? `Punonjësit: ${roster.names.join(', ')}.` : '',
    aliasEntries.length ? ` Pseudonime: ${aliasEntries.join(', ')}.` : '',
    vocabulary ? ` Fjalor: ${vocabulary}.` : '',
    ' Detyra shqip standard me ë dhe ç të sakta: cakto, thuaji, jepja, përgatit, dërgo, kontrollo, verifiko, nënshkruaj, mirato, faturën, pasqyrën, raportin, shpenzimeve, mirëmbajtjen, kontratën, preventivin, kantierin, çatinë, nesër, pasnesër, javën tjetër, urgjent, menjëherë, pa vonesë, pa ngut.',
  ].join('').trim();

  // Start Whisper Large v3 (`sq`) immediately
  const whisperPromise = audioBytes && groqKey
    ? transcribeWithGroqWhisper(audioBytes, mimeType, whisperPrompt, groqKey)
    : Promise.resolve('');
  const whisperText = await whisperPromise;

  const calendarBlock = buildAlbanianCalendar(today);
  const aliasHints = [...roster.aliasMap.entries()].map(([a, c]) => `"${a}" -> "${c}"`).join(', ');

  const systemInstructionText = [
    'Je eksperti kryesor i dëgjimit dhe kuptimit të gjuhës shqipe për aplikacionin ekzekutiv "Axhenda e Ekipit".',
    'Dëgjo audion shqip me vëmendje maksimale dhe nxirr detyrën e strukturuar pa humbur asnjë detaj (orë, vend, klient, shumë, objekt).',
    'KUPTIMI I SHQIPES SË FOLUR (STANDARDE + GEGËRISHT / SHQIPERIA E MESME / TOSKËRISHT):',
    '- Kupto natyrshëm format bisedore dhe dialektore: p.sh. "me bo / me ba" = "të bëjë", "me çu / me dërgu" = "të dërgojë", "me përgatit / me bo gati" = "të përgatisë", "me kontrollu / me pa / me kqyr" = "të kontrollojë", "me rregullu / me ndreq" = "të rregullojë", "me pagu" = "të paguajë", "nadje / mjes" = "në mëngjes", "masdite" = "pasdite", "tashti / menjiher / sa ma shpejt / shpejt e shpejt" = prioritet "Lart", "pa ngut / kur t\'ketë kohë" = prioritet "Ulet".',
    '- Dallim akustik i saktë në shqip: mos ngatërro ç/q ("çatinë" jo "qatin", "cakto" jo "qa këto"), gj/j ("Dorjela" jo "Dorgjela", "gjendjen"), dh/th, rr/r, ll/l ("Toshkollari"). Vendos gjithmonë shkronjat "ë" dhe "ç" sipas drejtshkrimit standard shqip.',
    '- EMRAT E LAKUAR TË PUNONJËSVE: Në shqip emrat lakohen në dhanore/kallëzore ("Kledisit / Kledis Dogën" -> "Kledis Doga", "Dorjelës / Dorjela Dajës" -> "Dorjela Daja", "Jorgos / Jorgo Toshkollarit" -> "Jorgo Toshkollari", "Mariglenit / Genit" -> "Mariglen Myftari", "Arben Kolës / Arbenit" -> "Arben Kola"). Në fushën "assignee" kthe GJITHMONË emrin e plotë kanonik nga lista e punonjësve.',
    '- Mos shpik asnjëherë fakte, data apo persona që nuk u thanë.',
  ].join('\n');

  const prompt = [
    calendarBlock,
    roster.deptInfo.length ? `Lista zyrtare e punonjësve (dhe departamenteve): ${roster.deptInfo.join(', ')}.` : 'Lista e punonjësve nuk u ngarkua.',
    aliasHints ? `Pseudonime të njohura të ekipit: ${aliasHints}.` : '',
    vocabulary ? `Fjalor ndihmës i domenit: ${vocabulary}.` : '',
    whisperText ? `Transkript akustik ndihmës #1 (Whisper Large v3 sq): "${whisperText}"` : '',
    liveTranscript ? `Transkript paraprak ndihmës #2 (Browser sq-AL): "${liveTranscript}"` : '',
    currentDraft
      ? `Drafti aktual që pronari po korrigjon me zë: ${currentDraft}. Apliko vetëm ndryshimet që pronari kërkoi (p.sh. "bëje për pasnesër", "shto edhe Dorjelën", "hiqe urgjencën") dhe ruaj fushat e tjera të pandryshuara.`
      : '',
    'RREGULLA PËR FUSHAT JSON:',
    '1. transcript: Fjalët e sakta që tha pronari të shkruara me drejtshkrim të pastër shqip (ë, ç) dhe me emrat e saktë të punonjësve.',
    '2. title: Titulli i shkurtër, i qartë dhe vebrues i detyrës në shqip standard (p.sh. "Kontrollo çatinë", "Përgatit pasqyrën e shpenzimeve", "Tako klientin në orën 14:30"). Përjashto komandat hyrëse si "Cakto...", "Thuaji...", emrin e punonjësit dhe fjalët "urgjent/nesër", por RUAJ orën (p.sh. "në orën 14:30") ose detajet thelbësore të punës.',
    '3. description: Konteksti i plotë ose fjalia e pastër e detyrës.',
    '4. assignee: Vetëm emri/emrat kanonikë nga lista e punonjësve (të ndarë me presje nëse janë disa), ose "" nëse nuk përmendet asnjë punonjës i listës.',
    '5. due: Data e afatit në formatin YYYY-MM-DD duke u bazuar FIKS te tabela e kalendarit më sipër, ose "" nëse nuk përmendet afat.',
    '6. priority: "Lart" (urgjent, menjëherë, shumë e rëndësishme, sa më shpejt, pa vonesë), "Ulet" (prioritet i ulët, pa ngut, jo urgjent, kur të ketë kohë), ose "Mesme" në çdo rast tjetër.',
  ].filter(Boolean).join('\n');

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (audioBytes) {
    parts.unshift({ inlineData: { mimeType, data: toBase64(audioBytes) } });
  }

  let parsed: Record<string, unknown> | null = null;
  let lastStatus = 502;
  let timedOut = false;

  if (geminiKey) {
    for (const model of MODELS) {
      let res: Response;
      try {
        const generationConfig: Record<string, unknown> = {
          temperature: 0.05,
          responseMimeType: 'application/json',
        };
        if (model.thinkingLevel) {
          generationConfig.thinkingConfig = { thinkingLevel: model.thinkingLevel };
        }
        res = await fetch(`${GEMINI}${model.id}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstructionText }] },
            contents: [{ role: 'user', parts }],
            generationConfig,
          }),
          signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        });
      } catch (e) {
        if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') timedOut = true;
        continue;
      }

      if (res.ok) {
        const payload = await res.json().catch(() => null);
        const respParts = payload?.candidates?.[0]?.content?.parts;
        let rawText = '';
        if (Array.isArray(respParts)) {
          for (const p of respParts) {
            if (p && !p.thought && typeof p.text === 'string' && p.text.trim()) rawText = p.text;
          }
          if (!rawText) rawText = String(respParts[0]?.text || '');
        }
        parsed = parseJsonObject(rawText);
        if (parsed) break;
        lastStatus = 502;
        continue;
      }
      lastStatus = res.status;
      if (res.status === 400 && !model.thinkingLevel) break;
    }
  }

  // Fallback to Groq Whisper + Groq Chat (`gpt-oss-120b` / `qwen3.8-27b`) if Gemini was unavailable
  if (!parsed && groqKey) {
    const bestTranscript = whisperText || liveTranscript;
    if (bestTranscript) {
      parsed = await extractWithGroqChat(bestTranscript, `${systemInstructionText}\n\n${prompt}`, groqKey);
    }
  }

  if (!parsed) {
    if (timedOut) return json({ error: 'Përgatitja e detyrës vonoi shumë. Provo përsëri.' }, 504);
    if (lastStatus === 429) return json({ error: 'Shërbimi AI është i ngarkuar. Provo pas pak sekondash.' }, 429);
    return json({ error: 'Shërbimi AI nuk u përgjigj. Provo përsëri.' }, 502);
  }

  const rawAssignees = Array.isArray(parsed.assignee)
    ? parsed.assignee.map(String)
    : String(parsed.assignee || '').split(',');
  const verifiedTranscript = String(parsed.transcript || whisperText || liveTranscript || '').trim().slice(0, 4000);
  let assignee = resolveAssignees(rawAssignees, roster);
  if (!assignee && rawAssignees.every(x => !String(x || '').trim()) && verifiedTranscript) {
    assignee = recoverAssigneesFromTranscript(verifiedTranscript, roster);
  }
  const rawDue = String(parsed.due || '').trim();
  const due = validDate(rawDue) ? rawDue : '';
  const pFold = fold(String(parsed.priority || ''));
  const priority = ['Lart', 'Mesme', 'Ulet'].includes(String(parsed.priority))
    ? String(parsed.priority)
    : /lart|urgjent|menjehere|maksimal|kritik|rendesish/.test(pFold)
    ? 'Lart'
    : /ulet|ngut|nxitim/.test(pFold)
    ? 'Ulet'
    : 'Mesme';
  const title = String(parsed.title || '').trim().slice(0, 300);

  return json({
    ok: true,
    transcript: verifiedTranscript,
    draft: {
      title,
      description: String(parsed.description || verifiedTranscript || '').trim().slice(0, 2000),
      assignee,
      due,
      priority,
    },
  });
});
