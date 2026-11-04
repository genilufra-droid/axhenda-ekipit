// Axhenda: issues a 6-digit password reset code via SMS (TextBee) or Email (Brevo / Resend).
// Public endpoint (verify_jwt = false) with per-user cooldown and SHA-256 hashed one-time codes.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const timed = (target: string, init: RequestInit = {}, ms = 15000) =>
  fetch(target, { ...init, signal: AbortSignal.timeout(ms) });

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

function cleanRealEmail(raw: unknown): string {
  const e = String(raw ?? '').trim().toLowerCase();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return '';
  if (e.endsWith('@axhenda.local') || e.endsWith('.local')) return '';
  return e;
}

function maskDestination(dest: string, channel: 'sms' | 'email'): string {
  if (channel === 'sms') {
    if (dest.length <= 7) return dest;
    return dest.slice(0, 6) + '***' + dest.slice(-3);
  }
  const [local, domain] = dest.split('@');
  if (!domain) return dest;
  const shown = local.length <= 2 ? (local[0] || '*') : local.slice(0, 2);
  return `${shown}***@${domain}`;
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateSixDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

const clean = (v: unknown) => String(v ?? '').trim().toLowerCase();
const normName = (v: unknown) => clean(v).replace(/\s+/g, ' ');

interface ResolvedResetUser {
  userId: string;
  displayName: string;
  username: string;
  loginHint: string;
  email: string;
  phone: string;
}

function matchResetUser(
  rawIdentifier: string,
  profiles: any[],
  employees: any[],
  authUsers: any[],
  ownerPhoneSetting = '',
): ResolvedResetUser | null {
  const ident = String(rawIdentifier ?? '').trim();
  if (!ident) return null;
  const identLower = ident.toLowerCase();
  const localAlias = identLower.endsWith('@axhenda.local')
    ? identLower.slice(0, -'@axhenda.local'.length)
    : '';
  const identPhone = /^[+\d][\d\s\-().]{6,}$/.test(ident) ? normalizePhone(ident) : '';
  const ownerPhone = normalizePhone(ownerPhoneSetting);

  const profileMap = new Map<string, any>();
  for (const p of profiles || []) {
    if (p?.id) profileMap.set(String(p.id), p);
  }

  const userIds = new Set<string>([
    ...profileMap.keys(),
    ...(authUsers || []).map((u: any) => String(u?.id || '')).filter(Boolean),
  ]);

  const authMap = new Map<string, any>();
  for (const u of authUsers || []) {
    if (u?.id) authMap.set(String(u.id), u);
  }

  const candidates: Array<{
    userId: string;
    displayName: string;
    username: string;
    authEmail: string;
    emails: string[];
    phones: string[];
  }> = [];

  for (const userId of userIds) {
    const p = profileMap.get(userId) || null;
    const u = authMap.get(userId) || null;
    // Must exist in auth.users to be able to reset Supabase Auth password
    if (!u) continue;

    const authEmail = clean(u.email);
    const meta = u.user_metadata || {};
    const role = clean(p?.role || meta.role);
    const username = clean(
      p?.username ||
        meta.username ||
        (authEmail.endsWith('@axhenda.local') ? authEmail.slice(0, -'@axhenda.local'.length) : ''),
    );

    const pPhone = normalizePhone(p?.phone || meta.phone);
    const baseName = (p?.display_name || meta.display_name || meta.full_name || '').trim();

    const matchedEmps = (employees || []).filter((emp: any) => {
      if (!emp) return false;
      if (String(emp.id || '') === userId || String(emp.perdorues_id || '') === userId) return true;
      const empPhone = normalizePhone(emp.telefon);
      if (pPhone && empPhone && pPhone === empPhone) return true;
      const empName = normName(`${emp.emri || ''} ${emp.mbiemri || ''}`);
      if (baseName && empName && empName === normName(baseName)) return true;
      return false;
    });

    const empName = matchedEmps.length
      ? `${matchedEmps[0].emri || ''} ${matchedEmps[0].mbiemri || ''}`.trim()
      : '';
    const displayName = baseName || empName || username || cleanRealEmail(authEmail) || 'Përdorues';

    const emailSet = new Set<string>();
    const addEmail = (val: unknown) => {
      const ce = cleanRealEmail(val);
      if (ce) emailSet.add(ce);
    };
    addEmail(p?.notification_email);
    addEmail(u.email);
    for (const emp of matchedEmps) addEmail(emp?.email);

    const phoneSet = new Set<string>();
    const addPhone = (val: unknown) => {
      const cp = normalizePhone(val);
      if (cp) phoneSet.add(cp);
    };
    addPhone(p?.phone);
    addPhone(meta.phone);
    for (const emp of matchedEmps) addPhone(emp?.telefon);
    if ((role === 'owner' || role === 'pronar') && ownerPhone) addPhone(ownerPhone);

    candidates.push({
      userId,
      displayName,
      username,
      authEmail,
      emails: [...emailSet],
      phones: [...phoneSet],
    });
  }

  let hit =
    candidates.find((c) => c.username && (c.username === identLower || (localAlias && c.username === localAlias))) ||
    candidates.find((c) => c.authEmail && c.authEmail === identLower) ||
    candidates.find((c) => c.emails.includes(identLower)) ||
    (identPhone ? candidates.find((c) => c.phones.includes(identPhone)) : undefined);

  if (!hit) {
    const byName = candidates.filter((c) => normName(c.displayName) === normName(ident));
    if (byName.length === 1) hit = byName[0];
  }
  if (!hit) return null;

  const chosenEmail = hit.emails.includes(identLower) ? identLower : hit.emails[0] || '';
  const chosenPhone = identPhone && hit.phones.includes(identPhone) ? identPhone : hit.phones[0] || '';
  const loginHint = hit.username || cleanRealEmail(hit.authEmail) || chosenEmail;

  return {
    userId: hit.userId,
    displayName: hit.displayName,
    username: hit.username,
    loginHint,
    email: chosenEmail,
    phone: chosenPhone,
  };
}

async function loadDirectory(url: string, serviceKey: string) {
  const headers = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
  const [profRes, empRes, usersRes, setRes] = await Promise.all([
    timed(`${url}/rest/v1/profiles?select=id,display_name,username,phone,notification_email,role`, { headers }),
    timed(`${url}/rest/v1/punonjesit?select=id,emri,mbiemri,email,telefon,perdorues_id`, { headers }),
    timed(`${url}/auth/v1/admin/users?page=1&per_page=1000`, { headers }),
    timed(`${url}/rest/v1/settings?select=key,value&key=eq.owner_phone&limit=1`, { headers }),
  ]);

  if (!profRes.ok) throw new Error('Nuk u lexuan profilet (' + profRes.status + ')');
  if (!usersRes.ok) throw new Error('Nuk u lexuan llogaritë Auth (' + usersRes.status + ')');

  const profiles = await profRes.json();
  const employees = empRes.ok ? await empRes.json() : [];
  const usersJson = await usersRes.json();
  const authUsers = Array.isArray(usersJson) ? usersJson : usersJson?.users || [];
  const settingsRows = setRes.ok ? await setRes.json() : [];
  const ownerPhone = Array.isArray(settingsRows) && settingsRows[0]?.value ? String(settingsRows[0].value) : '';

  return { profiles, employees, authUsers, ownerPhone };
}

async function sendTextBeeSms(phone: string, message: string, apiKey: string, deviceId: string) {
  const recipients = [normalizePhone(phone)].filter(Boolean);
  const primaryUrl = `https://api.textbee.dev/api/v1/gateway/devices/${encodeURIComponent(deviceId)}/send-sms`;
  let res = await timed(primaryUrl, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipients, message }),
  });
  let raw = await res.text();
  if (res.status === 404 && /Cannot POST/i.test(raw)) {
    res = await timed('https://api.textbee.dev/api/v1/gateway/send-sms', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients, message, deviceId }),
    });
    raw = await res.text();
  }
  return { ok: res.ok, status: res.status, raw };
}

async function sendResetEmail(toEmail: string, toName: string, code: string) {
  const subject = 'Kodi 6-shifror për rivendosjen e fjalëkalimit — Axhenda Online';
  const textContent =
    `Përshëndetje ${toName || ''},\n\n` +
    `Kodi yt 6-shifror për rivendosjen e fjalëkalimit në Axhenda Online është: ${code}\n\n` +
    `Ky kod është i vlefshëm për 10 minuta.\n` +
    `Nëse nuk e kërkove ti këtë ndryshim, injoroje këtë mesazh.\n\n` +
    `Axhenda Online`;
  const htmlContent =
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px;border:1px solid #e4e8ee;border-radius:12px">` +
    `<h2 style="margin:0 0 12px;color:#1c2b33">🔐 Rivendosja e fjalëkalimit</h2>` +
    `<p style="color:#1c2b33;font-size:14px">Përshëndetje <strong>${(toName || '').replace(/[<>&"]/g, '')}</strong>,</p>` +
    `<p style="color:#1c2b33;font-size:14px">Kodi yt për rivendosjen e fjalëkalimit në <strong>Axhenda Online</strong> është:</p>` +
    `<div style="font-size:28px;font-weight:800;letter-spacing:6px;text-align:center;padding:14px;background:#f6f8fa;border-radius:10px;color:#2b5bd0;margin:16px 0">${code}</div>` +
    `<p style="color:#667781;font-size:12px">Kodi skadon pas 10 minutash. Nëse nuk e kërkove ti këtë ndryshim, mos e përdor kodin.</p>` +
    `</div>`;

  const errors: string[] = [];
  const brevoKey = (Deno.env.get('BREVO_API_KEY') || '').trim();
  const senderEmail = (Deno.env.get('BREVO_SENDER_EMAIL') || Deno.env.get('RESEND_REPLY_TO') || 'biobes89@gmail.com').trim();

  if (brevoKey) {
    try {
      const res = await timed('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Axhenda Online', email: senderEmail },
          to: [{ email: toEmail, name: toName || toEmail }],
          replyTo: { email: senderEmail, name: 'Axhenda Online' },
          subject,
          textContent,
          htmlContent,
        }),
      });
      const raw = await res.text();
      if (res.ok) return { ok: true, provider: 'brevo' };
      console.error('BREVO_RESET_ERROR', res.status, raw);
      errors.push(`Brevo (${res.status}): ${raw.slice(0, 180)}`);
    } catch (e) {
      errors.push(`Brevo: ${String(e)}`);
    }
  }

  const resendKey = (Deno.env.get('RESEND_API_KEY') || '').trim();
  if (resendKey) {
    const rawFrom = (Deno.env.get('RESEND_FROM_EMAIL') || '').trim();
    const from = rawFrom || 'Axhenda Online <onboarding@resend.dev>';
    try {
      const res = await timed('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [toEmail],
          reply_to: senderEmail,
          subject,
          text: textContent,
          html: htmlContent,
        }),
      });
      const raw = await res.text();
      if (res.ok) return { ok: true, provider: 'resend' };
      console.error('RESEND_RESET_ERROR', res.status, raw);
      errors.push(`Resend (${res.status}): ${raw.slice(0, 180)}`);
    } catch (e) {
      errors.push(`Resend: ${String(e)}`);
    }
  }

  if (!brevoKey && !resendKey) {
    return { ok: false, error: 'Shërbimi i email-it nuk është konfiguruar në server (mungon BREVO_API_KEY / RESEND_API_KEY).' };
  }
  return { ok: false, error: 'Dërgimi i email-it dështoi — ' + errors.join(' | ') };
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Vetëm POST lejohet.' }, 405);

  try {
    const url = (Deno.env.get('SUPABASE_URL') || '').trim();
    const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
    if (!url || !serviceKey) return json({ error: 'Konfigurimi i serverit mungon.' }, 500);

    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const identifier = String(body?.identifier || '').trim();
    let channel = String(body?.channel || '').trim().toLowerCase().replace(/[\s-]/g, '');
    if (channel === 'e-mail') channel = 'email';

    if (!identifier) {
      return json({ error: 'Shkruaj username-in, email-in ose numrin e telefonit.' }, 400);
    }
    if (channel !== 'sms' && channel !== 'email') {
      return json({ error: 'Zgjidh mënyrën e dërgimit: SMS ose Email.' }, 400);
    }

    const { profiles, employees, authUsers, ownerPhone } = await loadDirectory(url, serviceKey);
    const target = matchResetUser(identifier, profiles, employees, authUsers, ownerPhone);

    if (!target) {
      return json({ error: 'Nuk u gjet asnjë llogari me "' + identifier + '". Kontrollo username-in, email-in ose numrin.' }, 404);
    }

    const destination = channel === 'email' ? target.email : target.phone;
    if (!destination) {
      if (channel === 'email' && target.phone) {
        return json(
          {
            error: 'Ky përdorues nuk ka email të regjistruar — zgjidh SMS për ta marrë kodin në telefon.',
            suggestChannel: 'sms',
            hasSms: true,
          },
          400,
        );
      }
      if (channel === 'sms' && target.email) {
        return json(
          {
            error: 'Ky përdorues nuk ka numër telefoni të regjistruar — zgjidh Email për ta marrë kodin.',
            suggestChannel: 'email',
            hasEmail: true,
          },
          400,
        );
      }
      return json(
        { error: channel === 'email' ? 'Ky përdorues nuk ka email të regjistruar.' : 'Ky përdorues nuk ka numër telefoni të regjistruar.' },
        400,
      );
    }

    const dbHeaders = {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
    };

    // Cooldown: prevent duplicate sends within 30 seconds on the same channel
    const recentRes = await timed(
      `${url}/rest/v1/password_reset_tokens?select=id,created_at&user_id=eq.${encodeURIComponent(target.userId)}&channel=eq.${encodeURIComponent(channel)}&used_at=is.null&order=created_at.desc&limit=1`,
      { headers: dbHeaders },
    );
    if (recentRes.ok) {
      const recent = await recentRes.json();
      const createdMs = recent?.[0]?.created_at ? Date.parse(recent[0].created_at) : 0;
      if (createdMs && Date.now() - createdMs < 30_000) {
        const waitSec = Math.max(1, Math.ceil((30_000 - (Date.now() - createdMs)) / 1000));
        return json({ error: `Një kod sapo u dërgua. Prit edhe ${waitSec} sekonda ose kontrollo mesazhet.` }, 429);
      }
    }

    const code = generateSixDigitCode();
    const tokenHash = await sha256(code);

    // Send code FIRST so we never wipe valid codes if an external gateway is unreachable
    if (channel === 'sms') {
      const textbeeKey = (Deno.env.get('TEXTBEE_API_KEY') || '').trim();
      const deviceId = (Deno.env.get('TEXTBEE_DEVICE_ID') || '').trim();
      if (!textbeeKey || !deviceId) {
        return json({ error: 'Shërbimi SMS (TextBee) nuk është konfiguruar në server.' }, 500);
      }
      const msg = `Axhenda Online: Kodi yt 6-shifror për fjalëkalimin është ${code}. Skadon pas 10 minutash.`;
      const smsOut = await sendTextBeeSms(destination, msg, textbeeKey, deviceId);
      if (!smsOut.ok) {
        console.error('TEXTBEE_RESET_ERROR', smsOut.status, smsOut.raw);
        let detail = smsOut.raw.slice(0, 160);
        try {
          const parsed = JSON.parse(smsOut.raw);
          detail = String(parsed?.message || parsed?.error || detail);
        } catch {
          // keep text slice
        }
        return json(
          {
            error: `Dërgimi i SMS dështoi (${smsOut.status}): ${detail}. Kontrollo që telefoni i TextBee të jetë online ose provo me Email.`,
            suggestChannel: target.email ? 'email' : undefined,
          },
          502,
        );
      }
    } else {
      const mailOut = await sendResetEmail(destination, target.displayName, code);
      if (!mailOut.ok) {
        return json(
          {
            error: mailOut.error + (target.phone ? ' Mund të provosh edhe me SMS.' : ''),
            suggestChannel: target.phone ? 'sms' : undefined,
          },
          502,
        );
      }
    }

    // Invalidate previous unused tokens for this user and store the new hash
    await timed(
      `${url}/rest/v1/password_reset_tokens?user_id=eq.${encodeURIComponent(target.userId)}&used_at=is.null`,
      { method: 'DELETE', headers: dbHeaders },
    );

    const insRes = await timed(`${url}/rest/v1/password_reset_tokens`, {
      method: 'POST',
      headers: { ...dbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: target.userId,
        channel,
        destination,
        token_hash: tokenHash,
        attempts: 0,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
    });

    if (!insRes.ok) {
      const errText = await insRes.text();
      console.error('TOKEN_INSERT_ERROR', insRes.status, errText);
      return json({ error: 'Kodi u dërgua por nuk u ruajt në databazë: ' + errText.slice(0, 140) }, 500);
    }

    const masked = maskDestination(destination, channel as 'sms' | 'email');
    return json({
      ok: true,
      channel,
      maskedDestination: masked,
      loginHint: target.loginHint,
      message:
        channel === 'email'
          ? `Kodi 6-shifror u dërgua me Email te ${masked}.`
          : `Kodi 6-shifror u dërgua me SMS te ${masked}.`,
    });
  } catch (error) {
    console.error('REQUEST_PASSWORD_RESET_FATAL', String(error));
    return json({ error: 'Gabim gjatë dërgimit të kodit: ' + String((error as any)?.message || error) }, 500);
  }
}

Deno.serve(handleRequest);
