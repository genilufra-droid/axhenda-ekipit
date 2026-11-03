// Axhenda: reads a short text aloud in Albanian with Gemini TTS. Only the owner may call it.
// Returns { ok, audioBase64, mimeType } (raw PCM, 24 kHz). Errors are short Albanian messages.
// Optional secret GEMINI_TTS_MODEL is tried first, then the names below.
const MODELS = [
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
];
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Vetëm POST lejohet.', 405);
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!url || !serviceKey || !geminiKey) return fail('Zëri nuk është konfiguruar.', 500);

    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return fail('Hyr përsëri në aplikacion.', 401);
    const who = await timed(url + '/auth/v1/user', { headers: { apikey: serviceKey, Authorization: 'Bearer ' + token } });
    if (!who.ok) return fail('Hyr përsëri në aplikacion.', 401);
    const user = await who.json();
    const roleRes = await timed(url + '/rest/v1/profiles?select=role&id=eq.' + encodeURIComponent(user.id),
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } });
    if (!roleRes.ok) return fail('Nuk u verifikua roli.', 502);
    const role = String((await roleRes.json())?.[0]?.role || '').trim().toLowerCase();
    if (!['owner', 'pronar', 'manager', 'menaxher', 'employee', 'punonjës', 'punonjes'].includes(role)) {
      return fail('Roli nuk ka qasje te zëri.', 403);
    }

    let body: any = null;
    try { body = await req.json(); } catch { body = null; }
    const text = String(body?.text || '').trim().slice(0, 600);
    if (!text) return fail('Teksti mungon.', 400);

    const custom = (Deno.env.get('GEMINI_TTS_MODEL') || '').trim();
    const { res: ai, body: raw } = await askGemini([...new Set([custom, ...MODELS].filter(Boolean))].map((model) => ({ model })), geminiKey, {
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    }, 10000);
    if (!ai) return fail('Zëri u vonua.', 504);
    if (!ai.ok) return fail('Zëri nuk u gjenerua.', ai.status === 429 ? 429 : 502);
    let inline: any = null;
    try { inline = JSON.parse(raw)?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData; } catch { inline = null; }
    if (!inline?.data) return fail('Zëri nuk u gjenerua.', 502);
    return json({ ok: true, audioBase64: inline.data, mimeType: inline.mimeType || 'audio/pcm;rate=24000' });
  } catch (error) {
    console.error('ASSISTANT_SPEAK_FATAL', String(error));
    if (timedOut(error)) return fail('Zëri u vonua.', 504);
    return fail('Zëri nuk u gjenerua.', 502);
  }
});
