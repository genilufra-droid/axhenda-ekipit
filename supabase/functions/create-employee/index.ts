// Axhenda: creates a new employee Auth account (@axhenda.local) and upserts their profile (including notification_email).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const emailFor = (u: string) => u.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') + '@axhenda.local';
const phoneOk = (p: string) => /^\+3556\d{8}$/.test(p);
const cleanRealEmail = (raw: unknown) => {
  const e = String(raw ?? '').trim().toLowerCase();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.endsWith('@axhenda.local') || e.endsWith('.local')) return null;
  return e;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const auth = req.headers.get('Authorization') || '';
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const { data: me, error: meError } = await admin.auth.getUser(token);
    if (meError || !me.user) throw new Error('Nuk je i autentikuar');

    const { data: owner } = await admin.from('profiles').select('role').eq('id', me.user.id).maybeSingle();
    const ownerRole = String(owner?.role || '').trim().toLowerCase();
    if (ownerRole !== 'owner' && ownerRole !== 'pronar') {
      throw new Error('Vetëm pronari mund të krijojë përdorues');
    }

    const body = await req.json();
    const name = String(body?.name || '').trim();
    const clean = String(body?.username || '').trim().toLowerCase();
    const password = String(body?.password || '');
    const tel = String(body?.phone || '').trim();
    const notifEmail = cleanRealEmail(body?.email ?? body?.notification_email);

    if (!name || !clean || !password || password.length < 8 || !tel) {
      throw new Error('Emri, username, numri i telefonit dhe password-i me të paktën 8 karaktere janë të detyrueshëm');
    }
    if (!/^[a-z0-9._-]+$/.test(clean)) {
      throw new Error('Username përdor vetëm shkronja, numra, pikë, vijë ose underscore');
    }
    if (!phoneOk(tel)) {
      throw new Error('Numri duhet të jetë në formatin +3556XXXXXXXX');
    }

    const loginEmail = emailFor(clean);
    const { data, error } = await admin.auth.admin.createUser({
      email: loginEmail,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: name,
        username: clean,
        role: 'employee',
        phone: tel,
        notification_email: notifEmail,
      },
    });
    if (error) throw error;

    const { error: pe } = await admin.from('profiles').upsert({
      id: data.user.id,
      display_name: name,
      username: clean,
      phone: tel,
      notification_email: notifEmail,
      role: 'employee',
      must_change_password: true,
    });
    if (pe) throw pe;

    return new Response(
      JSON.stringify({
        ok: true,
        id: data.user.id,
        name,
        username: clean,
        phone: tel,
        notification_email: notifEmail,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
