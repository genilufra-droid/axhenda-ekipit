// Axhenda: reads a short text aloud in Albanian with Gemini TTS. Only the owner may call it.
// Returns { ok, audioBase64, mimeType } (raw PCM, 24 kHz). Errors are short Albanian messages.
const MODEL = 'gemini-3.8-flash-tts';
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
    const who = await fetch(url + '/auth/v1/user', { headers: { apikey: serviceKey, Authorization: 'Bearer ' + token } });
    if (!who.ok) return fail('Hyr përsëri në aplikacion.', 401);
    const user = await who.json();
    const roleRes = await fetch(url + '/rest/v1/profiles?select=role&id=eq.' + encodeURIComponent(user.id),
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } });
    if (!roleRes.ok) return fail('Nuk u verifikua roli.', 502);
    const role = String((await roleRes.json())?.[0]?.role || '').trim().toLowerCase();
    if (!['owner', 'pronar'].includes(role)) return fail('Vetëm Pronari mund ta përdorë zërin.', 403);

    let body: any = null;
    try { body = await req.json(); } catch { body = null; }
    const text = String(body?.text || '').trim().slice(0, 600);
    if (!text) return fail('Teksti mungon.', 400);

    const ai = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Lexoje qartë dhe natyrshëm në shqip, me zë të ngrohtë e profesional, pa shtuar fjalë: ' + text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
      }),
    });
    const raw = await ai.text();
    if (!ai.ok) {
      console.error('GEMINI_TTS_ERROR', ai.status, raw.slice(0, 500));
      return fail('Zëri nuk u gjenerua.', ai.status === 429 ? 429 : 502);
    }
    let inline: any = null;
    try { inline = JSON.parse(raw)?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData; } catch { inline = null; }
    if (!inline?.data) return fail('Zëri nuk u gjenerua.', 502);
    return json({ ok: true, audioBase64: inline.data, mimeType: inline.mimeType || 'audio/pcm;rate=24000' });
  } catch (error) {
    console.error('ASSISTANT_SPEAK_FATAL', String(error));
    return fail('Zëri nuk u gjenerua.', 502);
  }
});
