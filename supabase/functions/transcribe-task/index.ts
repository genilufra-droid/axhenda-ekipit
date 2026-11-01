// Axhenda: voice/text -> task draft with Gemini (and Groq Whisper + Llama backup). Only the owner may call it.
// Contract: multipart `audio` (optional), `liveTranscript` (optional), `today`, `vocabulary`, `currentDraft`.
// Returns { ok, transcript, draft:{title,description,assignee,due,priority} }.
// Errors are short Albanian messages; provider details stay in the function logs.
// Optional secret GEMINI_MODEL is tried first, then the fast current models below.
const MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite'];
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

// Tries each model in turn; a model that is unknown, slow or failing is skipped, a quota error stops.
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

async function askGroqBackup(
  groqKey: string,
  audio: File | null,
  liveTranscript: string,
  promptText: string,
  vocabulary: string,
): Promise<{ ok: true; result: any } | { ok: false; status: number }> {
  try {
    let spoken = liveTranscript;
    if (audio) {
      const fd = new FormData();
      const ext = (audio.type || '').includes('mp4') ? 'mp4' : (audio.type || '').includes('ogg') ? 'ogg' : (audio.type || '').includes('wav') ? 'wav' : 'webm';
      fd.append('file', audio, 'task.' + ext);
      fd.append('model', 'whisper-large-v3-turbo');
      fd.append('language', 'sq');
      if (vocabulary) fd.append('prompt', vocabulary.slice(0, 220));
      const tr = await timed('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + groqKey },
        body: fd,
      }, 12000);
      if (!tr.ok) {
        console.error('GROQ_WHISPER_FAILED', tr.status);
        if (!spoken) return { ok: false, status: tr.status };
      } else {
        const tj = await tr.json();
        if (typeof tj?.text === 'string' && tj.text.trim()) spoken = tj.text.trim();
      }
    }
    if (!spoken) return { ok: false, status: 400 };
    const chat = await timed('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: promptText },
          { role: 'user', content: spoken },
        ],
      }),
    }, 12000);
    if (!chat.ok) return { ok: false, status: chat.status };
    const cj = await chat.json();
    const raw = cj?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(cleanJsonText(raw));
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== 'object') return { ok: false, status: 502 };
    if (!obj.transcript) obj.transcript = spoken;
    return { ok: true, result: obj };
  } catch (e) {
    console.error('GROQ_BACKUP_ERROR', String(e));
    return { ok: false, status: timedOut(e) ? 504 : 502 };
  }
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

    const parts: any[] = [];
    if (audioFile) {
      if (!audioFile.size) return fail('Audioja është bosh. Provo përsëri.', 400);
      if (audioFile.size > MAX_AUDIO) return fail('Audioja është shumë e gjatë (maksimumi 10 MB).', 413);
      parts.push({ inlineData: { mimeType: audioFile.type || 'audio/webm', data: bytesToBase64(new Uint8Array(await audioFile.arrayBuffer())) } });
    } else if (!liveTranscript) {
      return fail('Nuk u dëgjua asgjë. Provo përsëri.', 400);
    }

    const staff = await rest('/rest/v1/profiles?select=display_name,username&role=in.(employee,punonj%C3%ABs,punonjes)');
    const names = staff.ok ? (await staff.json()).map((p: any) => p.display_name || p.username).filter(Boolean) : [];

    const instruction = `Je asistenti i aplikacionit Axhenda. Dëgjo audion ose analizo tekstin e pronarit dhe kthe vetëm një objekt JSON valid, pa markdown:
{"transcript":"fjalët e plota","title":"titulli","description":"detajet","assignee":"emrat me presje","due":"YYYY-MM-DD ose bosh","priority":"Ulet|Mesme|Lart"}
Rregulla: shkruaj saktë fjalët e pronarit; mos shpik persona ose fakte; përdor vetëm emra nga lista; përfshi të gjithë të përmendurit; "sot" = data e sotme, "nesër" = dita pas saj; "urgjent" ose "prioritet i lartë" = Lart; "prioritet i ulët" = Ulet; pa prioritet = Mesme. Nëse ka draft dhe kërkohet ndryshim, ndrysho vetëm atë pjesë. Mos e ruaj dhe mos e dërgo detyrën, vetëm përgatit draftin.
Punonjësit: ${JSON.stringify(names)}
Fjalë të shpeshta: ${vocabulary}
Data e sotme: ${today}
Drafti ekzistues: ${JSON.stringify(currentDraft || {})}
Teksti live: ${liveTranscript}`;

    parts.push({ text: instruction });

    let result: any = null;
    let lastStatus = 502;

    if (geminiKey) {
      console.log('STAGE calling gemini', parts.length);
      const custom = (Deno.env.get('GEMINI_MODEL') || '').trim();
      const candidates = [...new Set([custom, ...MODELS].filter(Boolean))];
      const attempts = candidates.map((model) => ({ model }));
      const { res: ai, body: aiBody } = await askGemini(attempts, geminiKey,
        { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 1000 } }, 12000);
      if (!ai) {
        lastStatus = 504;
      } else if (!ai.ok) {
        lastStatus = ai.status === 429 ? 429 : 502;
      } else {
        try {
          const text = JSON.parse(aiBody)?.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || '';
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
      console.log('STAGE calling groq backup');
      const groq = await askGroqBackup(groqKey, audioFile, liveTranscript, instruction, vocabulary);
      if (groq.ok) result = groq.result;
      else if (!geminiKey) lastStatus = groq.status === 429 ? 429 : groq.status === 504 ? 504 : 502;
    }

    if (!result) {
      if (lastStatus === 504) return fail('Serveri u vonua. Provo përsëri.', 504);
      if (lastStatus === 429) return fail('Kufiri falas i AI u arrit. Provo pas pak ose përdor përpunimin lokal.', 429);
      return fail(geminiKey ? 'AI nuk u përgjigj. Provo përsëri.' : 'Ndodhi një gabim. Provo përsëri.', 502);
    }

    const transcript = String(result.transcript || liveTranscript || result.description || result.title || '').trim();
    const known = new Set(names.map((n: string) => n.toLowerCase()));
    const assignee = String(result.assignee || currentDraft?.assignee || '').split(',').map((n) => n.trim())
      .filter((n) => n && (!known.size || known.has(n.toLowerCase()))).join(', ');
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
