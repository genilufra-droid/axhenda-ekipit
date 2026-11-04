// Axhenda: sends SMS messages through TextBee API v1 (/gateway/devices/:deviceId/send-sms).
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function normalizePhone(raw: unknown): string {
  let s = String(raw ?? '').trim().replace(/[\s\-().]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    return digits.length >= 8 ? '+' + digits : '';
  }
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('355') && digits.length >= 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length >= 9) return '+355' + digits.slice(1);
  if (/^[67]\d{7,8}$/.test(digits)) return '+355' + digits;
  return digits.length >= 8 ? '+' + digits : '';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Vetëm POST lejohet' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const rawList = Array.isArray(body?.recipients)
      ? body.recipients
      : body?.to
        ? [body.to]
        : [];
    const recipients = rawList.map(normalizePhone).filter(Boolean);
    const message = String(body?.message || '').trim();

    if (!recipients.length || !message) {
      return new Response(JSON.stringify({ error: 'Mungon numri ose mesazhi' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const apiKey = (Deno.env.get('TEXTBEE_API_KEY') || '').trim();
    const deviceId = (Deno.env.get('TEXTBEE_DEVICE_ID') || '').trim();
    if (!apiKey || !deviceId) {
      return new Response(JSON.stringify({ error: 'TextBee nuk është konfiguruar në server' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const primaryUrl = `https://api.textbee.dev/api/v1/gateway/devices/${encodeURIComponent(deviceId)}/send-sms`;
    let response = await fetch(primaryUrl, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients, message }),
      signal: AbortSignal.timeout(15000),
    });
    let text = await response.text();

    if (response.status === 404 && /Cannot POST/i.test(text)) {
      response = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients, message, deviceId }),
        signal: AbortSignal.timeout(15000),
      });
      text = await response.text();
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          success: false,
          error: String(parsed?.message || parsed?.error || text || 'TextBee status ' + response.status),
        }),
        { status: response.status, headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        success: true,
        data: parsed?.data ?? parsed ?? { success: true },
      }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, success: false, error: String(error) }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
