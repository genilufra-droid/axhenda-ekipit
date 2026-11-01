// Axhenda: high-accuracy Albanian speech/text -> task draft. Only the owner may call it.
// Uses a multi-engine Albanian STT pipeline:
//   1. Dedicated acoustic Albanian STT (`whisper-large-v3` with `language=sq`, `temperature=0`, team vocabulary) in parallel
//   2. Browser live Google Speech (`sq-AL`) transcript when available (`liveTranscript`)
//   3. Google Gemini multimodal native audio (`gemini-3.6-flash` low-thinking -> `gemini-3-flash-preview` -> `gemini-3.5-flash-lite`)
//      cross-verifying raw audio + acoustic Whisper + Google `sq-AL` preview + Standard Albanian orthography (ë, ç) + team aliases
//   4. Automatic Groq LLM backup (`openai/gpt-oss-120b` / `qwen/qwen3.8-27b`) if Gemini is unavailable.
// Contract: multipart `audio` (optional), `liveTranscript` (optional), `today`, `vocabulary`, `currentDraft`.
// Returns { ok, transcript, draft:{title,description,assignee,due,priority} }.

const GEMINI_ATTEMPTS: { model: string; config?: Record<string, unknown> }[] = [
  { model: 'gemini-3.6-flash', config: { thinkingConfig: { thinkingLevel: 'LOW' } } },
  { model: 'gemini-3-flash-preview', config: { thinkingConfig: { thinkingLevel: 'MINIMAL' } } },
  { model: 'gemini-3.5-flash-lite' },
  { model: 'gemini-flash-lite-latest' },
  { model: 'gemini-3.1-flash-lite' },
];
const GROQ_WHISPER_MODELS = ['whisper-large-v3', 'whisper-large-v3-turbo'];
const GROQ_CHAT_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];
const MAX_AUDIO = 10 * 1024 * 1024;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const fail = (message: string, status: number) => json({ error: message }, status);
const timed = (target: string, init: RequestInit = {}, ms = 15000) => fetch(target, { ...init, signal: AbortSignal.timeout(ms) });
const timedOut = (error: unknown) => error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');

async function askGemini(attempts: { model: string; config?: Record<string, unknown> }[], key: string, payload: any, perModelMs: number) {
  let last: Response | null = null;
  let lastBody = '';
  for (const { model, config } of attempts) {
    const started = Date.now();
    try {
      const res = await timed(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(config ? { ...payload, generationConfig: { ...payload.generationConfig, ...config } } : payload),
      }, perModelMs);
      const body = await res.text();
      console.log('STAGE gemini', model, config ? JSON.stringify(config) : '', res.status, Date.now() - started, 'ms');
      if (res.ok || res.status === 429) return { res, body };
      console.error('GEMINI_MODEL_FAILED', model, res.status, body.slice(0, 300));
      last = res; lastBody = body;
    } catch (error) {
      console.error('GEMINI_MODEL_TIMEOUT', model, String(error), Date.now() - started, 'ms');
    }
  }
  return { res: last, body: lastBody };
}

async function transcribeAlbanianWhisper(
  groqKey: string,
  audio: File,
  vocabulary: string,
): Promise<{ text: string; status: number }> {
  const ext = (audio.type || '').includes('mp4') ? 'mp4' : (audio.type || '').includes('ogg') ? 'ogg' : (audio.type || '').includes('wav') ? 'wav' : 'webm';
  const orthoSeed = ('Shqip standard me ë dhe ç të sakta (cakto, përgatit, dërgo, kontrollo, faturën, pasqyrën, mirëmbajtjen, shpenzimeve, nesër, urgjent, pa vonesë): ' + vocabulary).slice(0, 224);
  let lastStatus = 502;
  for (const model of GROQ_WHISPER_MODELS) {
    const started = Date.now();
    try {
      const fd = new FormData();
      fd.append('file', audio, 'task.' + ext);
      fd.append('model', model);
      fd.append('language', 'sq');
      fd.append('temperature', '0');
      fd.append('prompt', orthoSeed);
      const tr = await timed('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + groqKey },
        body: fd,
      }, 9000);
      lastStatus = tr.status;
      if (tr.ok) {
        const tj = await tr.json();
        const text = typeof tj?.text === 'string' ? tj.text.trim() : '';
        console.log('STAGE whisper', model, tr.status, Date.now() - started, 'ms', text.length, 'chars');
        if (text) return { text, status: 200 };
      } else {
        console.error('GROQ_WHISPER_FAILED', model, tr.status);
        if (tr.status === 429) break;
      }
    } catch (e) {
      console.error('GROQ_WHISPER_TIMEOUT', model, String(e));
      lastStatus = timedOut(e) ? 504 : 502;
    }
  }
  return { text: '', status: lastStatus };
}

async function askGroqChatBackup(
  groqKey: string,
  spoken: string,
  promptText: string,
): Promise<{ ok: true; result: any } | { ok: false; status: number }> {
  if (!spoken) return { ok: false, status: 400 };
  let lastStatus = 502;
  for (const model of GROQ_CHAT_MODELS) {
    try {
      const chat = await timed('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.05,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: promptText },
            { role: 'user', content: spoken },
          ],
        }),
      }, 10000);
      lastStatus = chat.status;
      if (!chat.ok) {
        if (chat.status === 429) return { ok: false, status: 429 };
        continue;
      }
      const cj = await chat.json();
      const raw = cj?.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(cleanJsonText(raw));
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (obj && typeof obj === 'object') {
        if (!obj.transcript) obj.transcript = spoken;
        return { ok: true, result: obj };
      }
    } catch (e) {
      console.error('GROQ_CHAT_ERROR', model, String(e));
      lastStatus = timedOut(e) ? 504 : 502;
    }
  }
  return { ok: false, status: lastStatus };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function cleanJsonText(text: string) {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
}
function validDate(value: unknown) {
  const text = String(value || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? text : '';
}
function priorityOf(value: unknown, fallback: unknown) {
  const text = String(value || '').toLowerCase();
  if (['lart', 'lartë', 'high', 'urgjent'].includes(text)) return 'Lart';
  if (['ulet', 'ulët', 'low'].includes(text)) return 'Ulet';
  if (['mesme', 'mesëm', 'medium'].includes(text)) return 'Mesme';
  return ['Ulet', 'Mesme', 'Lart'].includes(String(fallback)) ? String(fallback) : 'Mesme';
}

function foldSq(value: string) {
  return String(value || '').toLowerCase().replace(/ë/g, 'e').replace(/ç/g, 'c').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function sameAlbanianNameWord(spokenWord: string, canonicalWord: string) {
  if (!spokenWord || !canonicalWord) return false;
  if (spokenWord === canonicalWord) return true;
  if (canonicalWord.length < 4) return false;
  const stem = /[aei]$/.test(canonicalWord) && canonicalWord.length >= 5
    ? canonicalWord.slice(0, -1)
    : canonicalWord;
  if (!spokenWord.startsWith(stem)) return false;
  return /^(a|i|u|s|t|n|it|in|ut|un|es|en|se)?$/.test(spokenWord.slice(stem.length));
}

function resolveAssignees(rawValue: unknown, names: string[], aliasMap: Map<string, string>) {
  const items = Array.isArray(rawValue)
    ? rawValue.map((x) => String(x || '').trim())
    : String(rawValue || '').split(',').map((x) => x.trim());
  if (!names.length) return items.filter(Boolean).join(', ');
  const byFold = new Map<string, string>();
  for (const n of names) byFold.set(foldSq(n), n);
  for (const [alias, canonical] of aliasMap.entries()) byFold.set(foldSq(alias), canonical);

  const matched: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!raw) continue;
    const f = foldSq(raw);
    if (!f) continue;
    let resolved = byFold.get(f) || '';
    if (!resolved) {
      const fWords = f.split(' ');
      // 1. Multi-word inflected full name (e.g. "Kledis Dogën" -> "Kledis Doga", "Dorjela Dajës" -> "Dorjela Daja")
      if (fWords.length >= 2) {
        for (const [kf, canonical] of byFold.entries()) {
          const kWords = kf.split(' ');
          if (kWords.length === fWords.length && kWords.every((kw, idx) => sameAlbanianNameWord(fWords[idx], kw))) {
            resolved = canonical;
            break;
          }
        }
      }
      // 2. Single-word inflected first name or alias (e.g. "Genit" -> "Mariglen Myftari", "Dorjelës" -> "Dorjela Daja", "Rokledit" -> "Rokled")
      if (!resolved && fWords.length === 1) {
        for (const [kf, canonical] of byFold.entries()) {
          const first = kf.split(' ')[0];
          if (sameAlbanianNameWord(fWords[0], first)) {
            resolved = canonical;
            break;
          }
        }
      }
    }
    if (resolved && !seen.has(resolved.toLowerCase())) {
      seen.add(resolved.toLowerCase());
      matched.push(resolved);
    }
  }
  return matched.join(', ');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Vetëm POST lejohet.', 405);
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const geminiKey = (Deno.env.get('GEMINI_API_KEY') || '').trim();
    const groqKey = (Deno.env.get('GROQ_API_KEY') || '').trim();
    if (!url || !serviceKey || (!geminiKey && !groqKey)) return fail('Asistenti nuk është konfiguruar. Lajmëro administratorin.', 500);

    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return fail('Hyr përsëri në aplikacion.', 401);
    const rest = (path: string, bearer = serviceKey) => timed(url + path, { headers: { apikey: serviceKey, Authorization: 'Bearer ' + bearer } });

    const who = await timed(url + '/auth/v1/user', { headers: { apikey: serviceKey, Authorization: 'Bearer ' + token } });
    if (!who.ok) return fail('Hyr përsëri në aplikacion.', 401);
    const user = await who.json();
    const roleRes = await rest('/rest/v1/profiles?select=role&id=eq.' + encodeURIComponent(user.id));
    if (!roleRes.ok) return fail('Nuk u verifikua roli. Provo përsëri.', 502);
    const role = String((await roleRes.json())?.[0]?.role || '').trim().toLowerCase();
    if (!['owner', 'pronar'].includes(role)) return fail('Vetëm Pronari mund të përdorë asistentin.', 403);

    console.log('STAGE owner ok');
    const form = await req.formData();
    const audio = form.get('audio');
    const audioFile = audio instanceof File ? audio : null;
    const liveTranscript = String(form.get('liveTranscript') || '').trim().slice(0, 4000);
    const vocabulary = String(form.get('vocabulary') || '').trim().slice(0, 1500);
    let currentDraft: any = null;
    try { currentDraft = JSON.parse(String(form.get('currentDraft') || '') || 'null'); } catch { currentDraft = null; }
    const today = validDate(form.get('today')) || new Date().toISOString().slice(0, 10);

    if (audioFile) {
      if (!audioFile.size) return fail('Audioja është bosh. Provo përsëri.', 400);
      if (audioFile.size > MAX_AUDIO) return fail('Audioja është shumë e gjatë (maksimumi 10 MB).', 413);
    } else if (!liveTranscript) {
      return fail('Nuk u dëgjua asgjë. Provo përsëri.', 400);
    }

    // Run team roster lookup, audio byte reading, and dedicated Albanian Whisper STT concurrently.
    const loadRoster = async () => {
      const names: string[] = [];
      const seen = new Set<string>();
      const aliasMap = new Map<string, string>();
      const addName = (full: string, alias = '') => {
        const clean = String(full || '').trim();
        if (!clean) return;
        const key = clean.toLowerCase();
        if (!seen.has(key)) { seen.add(key); names.push(clean); }
        const a = String(alias || '').trim();
        if (a && a.toLowerCase() !== key) aliasMap.set(a, clean);
      };
      const [staffRes, empRes] = await Promise.allSettled([
        rest('/rest/v1/profiles?select=display_name,username&role=in.(employee,punonj%C3%ABs,punonjes)'),
        rest('/rest/v1/punonjesit?select=emri,mbiemri,departamenti,aktiv'),
      ]);
      if (staffRes.status === 'fulfilled' && staffRes.value.ok) {
        try {
          const rows = await staffRes.value.json();
          if (Array.isArray(rows)) {
            for (const p of rows) addName(p.display_name || p.username, p.username);
          }
        } catch { /* ignore */ }
      }
      if (empRes.status === 'fulfilled' && empRes.value.ok) {
        try {
          const rows = await empRes.value.json();
          if (Array.isArray(rows)) {
            for (const e of rows) {
              if (e?.aktiv === false) continue;
              const full = [e?.emri, e?.mbiemri].filter(Boolean).join(' ').trim();
              if (full) addName(full, e?.emri);
            }
          }
        } catch { /* ignore */ }
      }
      return { names, aliasMap };
    };

    const [{ names, aliasMap }, audioBytes, whisperOut] = await Promise.all([
      loadRoster(),
      audioFile ? audioFile.arrayBuffer().then((b) => new Uint8Array(b)) : Promise.resolve(null),
      audioFile && groqKey ? transcribeAlbanianWhisper(groqKey, audioFile, vocabulary) : Promise.resolve({ text: '', status: 0 }),
    ]);

    const parts: any[] = [];
    if (audioBytes && audioFile) {
      parts.push({ inlineData: { mimeType: audioFile.type || 'audio/webm', data: bytesToBase64(audioBytes) } });
    }

    const aliasHints = [...aliasMap.entries()].map(([k, v]) => `${k} -> ${v}`);
    const whisperTranscript = whisperOut.text;

    const instruction = `Je ekspert i gjuhës shqipe standarde dhe asistenti i aplikacionit Axhenda. Dëgjo me vëmendje maksimale çdo rrokje të audios së pronarit (ose analizo tekstin kur nuk ka audio) dhe kthe vetëm një objekt JSON valid, pa markdown:
{"transcript":"fjalët e plota në shqip standard me ë dhe ç të sakta","title":"titulli i qartë në shqip","description":"detajet e plota","assignee":"emrat e saktë me presje","due":"YYYY-MM-DD ose bosh","priority":"Ulet|Mesme|Lart"}
Rregulla strikte për gjuhën shqipe:
1. Audioja është burimi kryesor i së vërtetës. Krahasoje audion me transkriptin akustik ndihmës dhe parapamjen live për të mos humbur asnjë fjalë, por korrigjo çdo deformim fonetik (p.sh. mos ngatërro ç/q si "çatinë"/"qatin", gj/xh, dh/th, rr/r, ll/l, sh/zh; shkruaj saktë shkronjat "ë" dhe "ç" sipas drejtshkrimit të shqipes standarde, p.sh. "nesër", "përgatisë", "dërgojë", "pasqyrën", "faturën", "furnitorëve", "mirëmbajtjen", "pa vonesë").
2. Njih lakimet e emrave të punonjësve në të folurën shqipe (p.sh. Kledisit/Kledisin/Kledis Dogën = Kledis Doga; Dorjelës/Dorit = Dorjela Daja; Jorgos/Jorgo Toshkollarit = Jorgo Toshkollari; Mariglenit/Genit = Mariglen Myftari; Rokledit = Rokled; Oksanës = Oksana; Enianës = Eniana; Nevilës = Nevila; Fitimit = Fitim; Mersinit = Mersin; Ilirit = Ilir; Kevinit = Kevin). Te "assignee" vendos vetëm emrat zyrtarë nga lista e punonjësve; mos shpik persona ose fakte që nuk u thanë.
3. "sot" = ${today}, "nesër" = dita pas saj, "pasnesër" = 2 ditë pas saj; "urgjent" ose "prioritet i lartë" = Lart; "prioritet i ulët" = Ulet; pa prioritet = Mesme. Nëse ka draft ekzistues dhe kërkohet ndryshim, ndrysho vetëm atë pjesë. Mos e ruaj dhe mos e dërgo detyrën, vetëm përgatit draftin.
Punonjësit zyrtarë: ${JSON.stringify(names)}
Shkurtesa emrash: ${JSON.stringify(aliasHints)}
Fjalor ndihmës: ${vocabulary}
Data e sotme: ${today}
Drafti ekzistues: ${JSON.stringify(currentDraft || {})}
Transkriptim akustik Whisper (shqip): ${whisperTranscript}
Parapamja live (Google sq-AL): ${liveTranscript}`;

    parts.push({ text: instruction });

    let result: any = null;
    let lastStatus = 502;

    if (geminiKey) {
      console.log('STAGE calling gemini', parts.length, 'whisperChars=', whisperTranscript.length, 'liveChars=', liveTranscript.length);
      const custom = (Deno.env.get('GEMINI_MODEL') || '').trim();
      const attempts = custom
        ? [{ model: custom }, ...GEMINI_ATTEMPTS.filter((a) => a.model !== custom)]
        : GEMINI_ATTEMPTS;
      const { res: ai, body: aiBody } = await askGemini(attempts, geminiKey,
        { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 1000 } }, 12000);
      if (!ai) {
        lastStatus = 504;
      } else if (!ai.ok) {
        lastStatus = ai.status === 429 ? 429 : 502;
      } else {
        try {
          const candidateParts = JSON.parse(aiBody)?.candidates?.[0]?.content?.parts || [];
          const nonThought = candidateParts.filter((p: any) => typeof p?.text === 'string' && !p.thought).map((p: any) => p.text).join('');
          const text = nonThought || candidateParts.find((p: any) => typeof p?.text === 'string')?.text || '';
          const parsed = JSON.parse(cleanJsonText(text));
          const obj = Array.isArray(parsed) ? parsed[0] : parsed;
          if (obj && typeof obj === 'object') result = obj;
        } catch {
          console.error('GEMINI_PARSE_ERROR', aiBody.slice(0, 500));
          lastStatus = 502;
        }
      }
    }

    if (!result && groqKey) {
      console.log('STAGE calling groq chat backup');
      const spoken = whisperTranscript || liveTranscript;
      if (!spoken && audioFile) {
        lastStatus = whisperOut.status === 429 ? 429 : whisperOut.status === 504 ? 504 : 502;
      } else {
        const groq = await askGroqChatBackup(groqKey, spoken, instruction);
        if (groq.ok) result = groq.result;
        else if (!geminiKey) lastStatus = groq.status === 429 ? 429 : groq.status === 504 ? 504 : 502;
      }
    }

    if (!result) {
      if (lastStatus === 504) return fail('Serveri u vonua. Provo përsëri.', 504);
      if (lastStatus === 429) return fail('Kufiri falas i AI u arrit. Provo pas pak ose përdor përpunimin lokal.', 429);
      return fail(geminiKey ? 'AI nuk u përgjigj. Provo përsëri.' : 'Ndodhi një gabim. Provo përsëri.', 502);
    }

    const transcript = String(result.transcript || whisperTranscript || liveTranscript || result.description || result.title || '').trim();
    const assignee = resolveAssignees(result.assignee ?? currentDraft?.assignee ?? '', names, aliasMap);
    return json({
      ok: true,
      transcript,
      draft: {
        title: String(result.title || currentDraft?.title || transcript).trim().slice(0, 200),
        description: String(result.description || currentDraft?.description || transcript).trim(),
        assignee,
        due: validDate(result.due) || validDate(currentDraft?.due),
        priority: priorityOf(result.priority, currentDraft?.priority),
      },
    });
  } catch (error) {
    console.error('TRANSCRIBE_TASK_FATAL', String(error));
    if (timedOut(error)) return fail('Serveri u vonua. Provo përsëri.', 504);
    return fail('Ndodhi një gabim. Provo përsëri.', 502);
  }
});
