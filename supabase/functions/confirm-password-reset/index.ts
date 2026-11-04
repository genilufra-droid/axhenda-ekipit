// Axhenda: verifies the 6-digit reset code and updates the user's Supabase Auth password.
// Public endpoint (verify_jwt = false) protected by SHA-256 hash comparison, 10-min expiry, and 5-attempt lockout.

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

const MAX_ATTEMPTS = 5;

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

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const clean = (v: unknown) => String(v ?? '').trim().toLowerCase();
const normName = (v: unknown) => clean(v).replace(/\s+/g, ' ');

function matchResetUser(
  rawIdentifier: string,
  profiles: any[],
  employees: any[],
  authUsers: any[],
  ownerPhoneSetting = '',
) {
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

  const loginHint = hit.username || cleanRealEmail(hit.authEmail) || hit.emails[0] || '';
  return { userId: hit.userId, loginHint };
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
    const code = String(body?.code || '').trim().replace(/\s+/g, '');
    const newPassword = String(body?.new_password || '');

    if (!identifier || !code || !newPassword) {
      return json({ error: 'Plotëso username/email, kodin 6-shifror dhe fjalëkalimin e ri.' }, 400);
    }
    if (!/^\d{6}$/.test(code)) {
      return json({ error: 'Kodi i verifikimit duhet të ketë saktësisht 6 shifra.' }, 400);
    }
    if (newPassword.length < 8) {
      return json({ error: 'Fjalëkalimi i ri duhet të ketë të paktën 8 karaktere.' }, 400);
    }

    const { profiles, employees, authUsers, ownerPhone } = await loadDirectory(url, serviceKey);
    const target = matchResetUser(identifier, profiles, employees, authUsers, ownerPhone);
    if (!target) {
      return json({ error: 'Përdoruesi nuk u gjet.' }, 404);
    }

    const dbHeaders = {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
    };

    const nowIso = new Date().toISOString();
    const tokRes = await timed(
      `${url}/rest/v1/password_reset_tokens?select=id,user_id,token_hash,expires_at,used_at,attempts&user_id=eq.${encodeURIComponent(target.userId)}&used_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}&order=created_at.desc&limit=1`,
      { headers: dbHeaders },
    );

    if (!tokRes.ok) {
      return json({ error: 'Nuk u verifikua kodi në databazë.' }, 500);
    }

    const rows = await tokRes.json();
    const activeToken = Array.isArray(rows) ? rows[0] : null;
    if (!activeToken) {
      return json({ error: 'Kodi ka skaduar ose nuk ekziston. Kërko një kod të ri 6-shifror.' }, 400);
    }

    const currentAttempts = Number(activeToken.attempts || 0);
    if (currentAttempts >= MAX_ATTEMPTS) {
      await timed(`${url}/rest/v1/password_reset_tokens?id=eq.${encodeURIComponent(activeToken.id)}`, {
        method: 'PATCH',
        headers: { ...dbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ used_at: nowIso }),
      });
      return json({ error: 'U tejkalua numri i tentativave. Kërko një kod të ri 6-shifror.' }, 429);
    }

    const codeHash = await sha256(code);
    if (codeHash !== activeToken.token_hash) {
      const nextAttempts = currentAttempts + 1;
      const patchBody: Record<string, unknown> = { attempts: nextAttempts };
      if (nextAttempts >= MAX_ATTEMPTS) patchBody.used_at = nowIso;
      await timed(`${url}/rest/v1/password_reset_tokens?id=eq.${encodeURIComponent(activeToken.id)}`, {
        method: 'PATCH',
        headers: { ...dbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(patchBody),
      });
      const left = MAX_ATTEMPTS - nextAttempts;
      return json(
        {
          error:
            left > 0
              ? `Kodi 6-shifror është i gabuar (mbeten edhe ${left} tentativa).`
              : 'Kodi u bllokua pas 5 tentativave të gabuara. Kërko një kod të ri.',
        },
        400,
      );
    }

    // Update Supabase Auth password via Admin API
    const pwRes = await timed(`${url}/auth/v1/admin/users/${encodeURIComponent(target.userId)}`, {
      method: 'PUT',
      headers: dbHeaders,
      body: JSON.stringify({ password: newPassword }),
    });

    if (!pwRes.ok) {
      const errText = await pwRes.text();
      console.error('UPDATE_PASSWORD_AUTH_ERROR', pwRes.status, errText);
      return json({ error: 'Fjalëkalimi nuk u përditësua në Auth: ' + errText.slice(0, 140) }, 500);
    }

    await timed(`${url}/rest/v1/password_reset_tokens?id=eq.${encodeURIComponent(activeToken.id)}`, {
      method: 'PATCH',
      headers: { ...dbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ used_at: new Date().toISOString() }),
    });

    await timed(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(target.userId)}`, {
      method: 'PATCH',
      headers: { ...dbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ must_change_password: false }),
    });

    return json({
      ok: true,
      loginHint: target.loginHint,
      message: 'Fjalëkalimi u ndryshua me sukses! Tani mund të hysh me fjalëkalimin e ri.',
    });
  } catch (error) {
    console.error('CONFIRM_PASSWORD_RESET_FATAL', String(error));
    return json({ error: 'Gabim gjatë rikthimit të fjalëkalimit: ' + String((error as any)?.message || error) }, 500);
  }
}

Deno.serve(handleRequest);
