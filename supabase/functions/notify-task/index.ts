// Axhenda: notifies assigned employees across Chat, SMS (TextBee v1), and Email (Brevo / Resend).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

const normalize = (value: unknown) => String(value || '').trim().toLowerCase();
const getAssignees = (value: unknown) =>
  String(value || '')
    .split(/[,;\n]+/)
    .map((name) => name.trim())
    .filter(Boolean);

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
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.endsWith('@axhenda.local') || e.endsWith('.local')) return '';
  return e;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Vetëm POST lejohet' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Supabase secrets mungojnë' }, 500);

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const authorization = req.headers.get('Authorization') || '';
    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Token-i mungon' }, 401);

    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) return json({ error: 'Nuk je i autentikuar' }, 401);

    const { data: ownerProfile, error: ownerError } = await admin
      .from('profiles')
      .select('role,display_name,username')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (ownerError) return json({ error: ownerError.message }, 500);

    const ownerRole = normalize(ownerProfile?.role);
    if (!['owner', 'pronar'].includes(ownerRole)) {
      return json({ error: 'Vetëm Pronari mund të njoftojë kanalet' }, 403);
    }
    const coordinatorName =
      (ownerProfile?.display_name || userData.user.user_metadata?.display_name || ownerProfile?.username || 'Koordinatori').trim();

    const body = await req.json();
    const task = body?.task;
    if (!task?.title || !task?.assignee) {
      return json({ error: 'Detyra duhet të ketë titull dhe punonjës' }, 400);
    }

    const [{ data: profiles, error: profilesError }, { data: empRows }] = await Promise.all([
      admin
        .from('profiles')
        .select('id,display_name,username,phone,notification_email,role')
        .in('role', ['employee', 'punonjës', 'punonjes', 'manager', 'menaxher']),
      admin.from('punonjesit').select('id,emri,mbiemri,email,telefon,perdorues_id'),
    ]);
    if (profilesError) return json({ error: profilesError.message }, 500);

    const requestedAssignees = getAssignees(task.assignee).map(normalize);
    const selectedPeople = (profiles || []).filter((profile: any) => {
      const displayName = normalize(profile.display_name);
      const firstName = displayName.split(/\s+/)[0] || '';
      const username = normalize(profile.username);
      const email = normalize(profile.notification_email);
      return (
        requestedAssignees.includes(displayName) ||
        (firstName && requestedAssignees.includes(firstName)) ||
        requestedAssignees.includes(username) ||
        (email && requestedAssignees.includes(email))
      );
    });

    if (!selectedPeople.length) {
      return json({ error: 'Asnjë punonjës nuk u gjet: ' + task.assignee }, 404);
    }

    const message =
      `Detyrë e re: ${task.title}` +
      `${task.desc ? ' — ' + task.desc : ''}` +
      `${task.due ? ' Afati: ' + task.due + '.' : ''}` +
      ' Hyr në Axhenda Online dhe konfirmo marrjen.';

    const textbeeApiKey = (Deno.env.get('TEXTBEE_API_KEY') || '').trim();
    const textbeeDeviceId = (Deno.env.get('TEXTBEE_DEVICE_ID') || '').trim();
    const brevoApiKey = (Deno.env.get('BREVO_API_KEY') || '').trim();
    const resendApiKey = (Deno.env.get('RESEND_API_KEY') || '').trim();
    const senderEmail = (Deno.env.get('BREVO_SENDER_EMAIL') || Deno.env.get('RESEND_REPLY_TO') || 'biobes89@gmail.com').trim();

    const results = [];
    for (const person of selectedPeople) {
      const matchedEmp = (empRows || []).find(
        (emp: any) =>
          String(emp?.id || '') === String(person.id) ||
          String(emp?.perdorues_id || '') === String(person.id) ||
          (normalizePhone(emp?.telefon) && normalizePhone(emp?.telefon) === normalizePhone(person.phone)) ||
          normalize(`${emp?.emri || ''} ${emp?.mbiemri || ''}`) === normalize(person.display_name),
      );
      const phone = normalizePhone(person.phone || matchedEmp?.telefon);
      const email = cleanRealEmail(person.notification_email) || cleanRealEmail(matchedEmp?.email);

      const result: Record<string, unknown> = {
        employee: person.display_name || person.username || '',
        chat: 'skipped',
        sms: 'skipped',
        email: 'skipped',
      };

      const chatInsert = await admin.from('chat_messages').insert({
        sender_id: userData.user.id,
        recipient_id: person.id,
        message,
      });
      if (chatInsert.error) {
        result.chat = 'failed';
        result.chat_error = chatInsert.error.message;
      } else {
        result.chat = 'sent';
      }

      if (textbeeApiKey && textbeeDeviceId && phone) {
        const smsUrl = `https://api.textbee.dev/api/v1/gateway/devices/${encodeURIComponent(textbeeDeviceId)}/send-sms`;
        const smsResponse = await fetch(smsUrl, {
          method: 'POST',
          headers: { 'x-api-key': textbeeApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipients: [phone], message }),
          signal: AbortSignal.timeout(15000),
        });
        const smsBody = await smsResponse.text();
        if (smsResponse.ok) {
          result.sms = 'sent';
        } else {
          result.sms = 'failed';
          result.sms_error = smsBody;
        }
      } else {
        result.sms_reason = !phone ? 'Numri i telefonit mungon' : 'TextBee nuk është konfiguruar';
      }

      if (email && (brevoApiKey || resendApiKey)) {
        let emailSent = false;
        let lastErr = '';
        if (brevoApiKey) {
          const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              sender: { name: 'Axhenda Online', email: senderEmail },
              to: [{ email, name: person.display_name || person.username || '' }],
              replyTo: { email: senderEmail },
              subject: 'Detyrë e re nga Axhenda Online',
              textContent: `Përshëndetje ${person.display_name || ''},\n\n${message}\n\nKoordinator: ${coordinatorName}`,
            }),
            signal: AbortSignal.timeout(15000),
          });
          const emailBody = await emailResponse.text();
          if (emailResponse.ok) emailSent = true;
          else lastErr = emailBody;
        }
        if (!emailSent && resendApiKey) {
          const from = (Deno.env.get('RESEND_FROM_EMAIL') || '').trim() || 'Axhenda Online <onboarding@resend.dev>';
          const resendRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + resendApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from,
              to: [email],
              reply_to: senderEmail,
              subject: 'Detyrë e re nga Axhenda Online',
              text: `Përshëndetje ${person.display_name || ''},\n\n${message}\n\nKoordinator: ${coordinatorName}`,
            }),
            signal: AbortSignal.timeout(15000),
          });
          const resendBody = await resendRes.text();
          if (resendRes.ok) emailSent = true;
          else lastErr = resendBody;
        }
        if (emailSent) result.email = 'sent';
        else {
          result.email = 'failed';
          result.email_error = lastErr;
        }
      } else {
        result.email_reason = !email ? 'Email-i mungon' : 'Shërbimi i email-it nuk është konfiguruar';
      }

      results.push(result);
    }

    return json({
      ok: true,
      recipients: selectedPeople.map((person: any) => person.display_name || person.username || ''),
      result: results,
    });
  } catch (error) {
    console.error('NOTIFY_TASK_ERROR', String(error));
    return json({ error: String(error) }, 500);
  }
});
