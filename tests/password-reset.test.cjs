const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');

const loadTs = (slug) =>
  stripTypeScriptTypes(
    fs.readFileSync(path.join(__dirname, '../supabase/functions/' + slug + '/index.ts'), 'utf8'),
  );

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const SAMPLE_PROFILES = [
  {
    id: 'owner-1',
    display_name: 'Besnik Koci',
    username: null,
    role: 'owner',
    phone: null,
    notification_email: 'biobes89@gmail.com',
  },
  {
    id: 'emp-kledis',
    display_name: 'Kledis Doga',
    username: 'kledis',
    role: 'employee',
    phone: '+355696326549',
    notification_email: 'agrobiobes@gmail.com',
  },
  {
    id: 'emp-dori',
    display_name: 'Dorjela Daja',
    username: 'dori',
    role: 'employee',
    phone: '+355696329620',
    notification_email: null,
  },
  {
    id: 'emp-empemail',
    display_name: 'ErjonBega',
    username: 'erjon',
    role: 'employee',
    phone: '+355682223334',
    notification_email: null,
  },
];

const SAMPLE_EMPLOYEES = [
  {
    id: 'emp-empemail',
    emri: 'Erjon',
    mbiemri: 'Bega',
    email: 'erjon.bega@gmail.com',
    telefon: '0682223334',
    perdorues_id: 'emp-empemail',
  },
];

const SAMPLE_AUTH_USERS = [
  { id: 'owner-1', email: 'genilufra@gmail.com', user_metadata: {} },
  { id: 'emp-kledis', email: 'kledis@axhenda.local', user_metadata: { username: 'kledis', display_name: 'Kledis' } },
  { id: 'emp-dori', email: 'dori@axhenda.local', user_metadata: { username: 'dori', display_name: 'Dorjela Daja' } },
  { id: 'emp-empemail', email: 'erjon@axhenda.local', user_metadata: { username: 'erjon', display_name: 'ErjonBega' } },
];

function createResetHarness({ env = {}, onExternalFetch = null, initialTokens = [] } = {}) {
  const tokens = initialTokens.map((t) => ({ ...t }));
  const updatedPasswords = [];
  const clearedFlags = [];
  const externalCalls = [];

  const vars = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srv-secret',
    TEXTBEE_API_KEY: 'tb-key-123',
    TEXTBEE_DEVICE_ID: 'dev-abc-999',
    BREVO_API_KEY: 'brevo-key-123',
    RESEND_API_KEY: 'resend-key-123',
    RESEND_FROM_EMAIL: 'Axhenda <noreply@biobes.al>',
    ...env,
  };

  const fetchMock = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const u = String(url);

    if (u.includes('/rest/v1/profiles') && method === 'GET') {
      return jsonRes(SAMPLE_PROFILES);
    }
    if (u.includes('/rest/v1/punonjesit') && method === 'GET') {
      return jsonRes(SAMPLE_EMPLOYEES);
    }
    if (u.includes('/auth/v1/admin/users') && method === 'GET') {
      return jsonRes({ users: SAMPLE_AUTH_USERS });
    }
    if (u.includes('/rest/v1/settings') && method === 'GET') {
      return jsonRes([{ key: 'owner_phone', value: '+355694045441' }]);
    }
    if (u.includes('/rest/v1/password_reset_tokens')) {
      if (method === 'GET') {
        const parsed = new URL(u);
        const uid = (parsed.searchParams.get('user_id') || '').replace(/^eq\./, '');
        const ch = (parsed.searchParams.get('channel') || '').replace(/^eq\./, '');
        const expGt = (parsed.searchParams.get('expires_at') || '').replace(/^gt\./, '');
        let list = tokens.filter((t) => t.user_id === uid && t.used_at == null);
        if (ch) list = list.filter((t) => t.channel === ch);
        if (expGt) list = list.filter((t) => Date.parse(t.expires_at) > Date.parse(expGt));
        list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        return jsonRes(list.slice(0, 1));
      }
      if (method === 'DELETE') {
        const parsed = new URL(u);
        const uid = (parsed.searchParams.get('user_id') || '').replace(/^eq\./, '');
        for (let i = tokens.length - 1; i >= 0; i--) {
          if (tokens[i].user_id === uid && tokens[i].used_at == null) tokens.splice(i, 1);
        }
        return jsonRes({});
      }
      if (method === 'POST') {
        const row = JSON.parse(options.body);
        tokens.push({
          id: 'tok-' + (tokens.length + 1),
          created_at: new Date().toISOString(),
          used_at: null,
          attempts: 0,
          ...row,
        });
        return jsonRes({}, 201);
      }
      if (method === 'PATCH') {
        const parsed = new URL(u);
        const id = (parsed.searchParams.get('id') || '').replace(/^eq\./, '');
        const patch = JSON.parse(options.body);
        const found = tokens.find((t) => t.id === id);
        if (found) Object.assign(found, patch);
        return jsonRes({});
      }
    }
    if (u.includes('/auth/v1/admin/users/') && method === 'PUT') {
      const userId = decodeURIComponent(u.split('/auth/v1/admin/users/')[1]);
      const body = JSON.parse(options.body);
      updatedPasswords.push({ userId, password: body.password });
      return jsonRes({ user: { id: userId } });
    }
    if (u.includes('/rest/v1/profiles') && method === 'PATCH') {
      const parsed = new URL(u);
      const id = (parsed.searchParams.get('id') || '').replace(/^eq\./, '');
      clearedFlags.push({ userId: id, body: JSON.parse(options.body) });
      return jsonRes({});
    }

    externalCalls.push({ url: u, method, options });
    if (onExternalFetch) return onExternalFetch(u, options);
    return jsonRes({ ok: true, success: true });
  };

  const sandboxBase = () => ({
    Deno: { env: { get: (k) => vars[k] }, serve: () => {} },
    fetch: fetchMock,
    Request,
    Response,
    URL,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    Array,
    Map,
    Set,
    JSON,
    String,
    Number,
    Boolean,
    Date,
    Math,
    Promise,
    AbortSignal,
    crypto: crypto.webcrypto,
    console: { error() {}, log() {}, warn() {} },
  });

  let reqHandler;
  const sb1 = sandboxBase();
  sb1.Deno.serve = (fn) => {
    reqHandler = fn;
  };
  vm.runInNewContext(loadTs('request-password-reset'), sb1);

  let confirmHandler;
  const sb2 = sandboxBase();
  sb2.Deno.serve = (fn) => {
    confirmHandler = fn;
  };
  vm.runInNewContext(loadTs('confirm-password-reset'), sb2);

  return { reqHandler, confirmHandler, tokens, updatedPasswords, clearedFlags, externalCalls };
}

const postJson = (body) =>
  new Request('https://x.supabase.co/functions/v1/fn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('SMS password reset calls official TextBee v1 /gateway/devices/:deviceId/send-sms endpoint and verifies 6-digit code end-to-end', async () => {
  let capturedSmsText = '';
  const h = createResetHarness({
    onExternalFetch: (url, opts) => {
      const b = JSON.parse(opts.body);
      capturedSmsText = b.message;
      return jsonRes({ data: { success: true } }, 200);
    },
  });

  // Employee enters local Albanian number 0696326549 (normalized to +355696326549 -> Kledis)
  const r1 = await h.reqHandler(postJson({ identifier: '069 632 6549', channel: 'SMS' }));
  const d1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.equal(d1.ok, true);
  assert.equal(h.externalCalls.length, 1);
  assert.equal(
    h.externalCalls[0].url,
    'https://api.textbee.dev/api/v1/gateway/devices/dev-abc-999/send-sms',
    'must include deviceId in TextBee v1 URL path',
  );
  const sentBody = JSON.parse(h.externalCalls[0].options.body);
  assert.deepEqual(sentBody.recipients, ['+355696326549']);

  const codeMatch = capturedSmsText.match(/\b(\d{6})\b/);
  assert.ok(codeMatch, 'SMS must contain 6-digit reset code');
  const code = codeMatch[1];

  // Confirm with wrong code first -> increments attempts and rejects
  const badRes = await h.confirmHandler(
    postJson({ identifier: '0696326549', code: code === '111111' ? '222222' : '111111', new_password: 'NewPassword123' }),
  );
  assert.equal(badRes.status, 400);
  assert.equal(h.tokens[0].attempts, 1);
  assert.equal(h.updatedPasswords.length, 0);

  // Confirm with real 6-digit code -> updates Auth password & clears must_change_password
  const okRes = await h.confirmHandler(
    postJson({ identifier: '0696326549', code, new_password: 'NewPassword123' }),
  );
  const okData = await okRes.json();
  assert.equal(okRes.status, 200);
  assert.equal(okData.ok, true);
  assert.equal(okData.loginHint, 'kledis');
  assert.equal(h.updatedPasswords.length, 1);
  assert.equal(h.updatedPasswords[0].userId, 'emp-kledis');
  assert.equal(h.updatedPasswords[0].password, 'NewPassword123');
  assert.ok(h.tokens[0].used_at, 'token marked used_at after reset');
  assert.deepEqual(h.clearedFlags[0], { userId: 'emp-kledis', body: { must_change_password: false } });
});

test('Email password reset resolves punonjesit.email fallback, never sends to @axhenda.local, and falls back from Brevo to Resend', async () => {
  let resendPayload = null;
  const h = createResetHarness({
    onExternalFetch: (url, opts) => {
      if (url.includes('brevo.com')) return jsonRes({ message: 'Unauthorized IP' }, 401);
      if (url.includes('resend.com')) {
        resendPayload = JSON.parse(opts.body);
        return jsonRes({ id: 'mail-1' }, 200);
      }
      return jsonRes({}, 500);
    },
  });

  // Erjon has notification_email = null in profiles, auth email = erjon@axhenda.local, real email in punonjesit.email!
  const r = await h.reqHandler(postJson({ identifier: 'erjon@axhenda.local', channel: 'email' }));
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.ok, true);
  assert.ok(resendPayload, 'Resend fallback must fire when Brevo fails');
  assert.deepEqual(resendPayload.to, ['erjon.bega@gmail.com'], 'must send to real email from punonjesit, never @axhenda.local');
});

test('Employee without any real email gets clear Albanian suggestion to switch to SMS', async () => {
  const h = createResetHarness();
  const r = await h.reqHandler(postJson({ identifier: 'dori', channel: 'email' }));
  const d = await r.json();
  assert.equal(r.status, 400);
  assert.equal(d.suggestChannel, 'sms');
  assert.match(d.error, /SMS/i);
});

test('Owner SMS reset uses settings.owner_phone when profiles.phone is null, and Owner login email resolves to exact typed email', async () => {
  const h = createResetHarness();
  const smsRes = await h.reqHandler(postJson({ identifier: 'genilufra@gmail.com', channel: 'sms' }));
  const smsData = await smsRes.json();
  assert.equal(smsRes.status, 200);
  assert.equal(smsData.ok, true);
  assert.deepEqual(JSON.parse(h.externalCalls[0].options.body).recipients, ['+355694045441']);

  // Also test email channel for genilufra@gmail.com -> delivers to genilufra@gmail.com (not only biobes89@gmail.com)
  const mailRes = await h.reqHandler(postJson({ identifier: 'genilufra@gmail.com', channel: 'email' }));
  const mailData = await mailRes.json();
  assert.equal(mailRes.status, 200);
  assert.equal(mailData.ok, true);
  const brevoBody = JSON.parse(h.externalCalls[1].options.body);
  assert.equal(brevoBody.to[0].email, 'genilufra@gmail.com');
});

test('Confirm reset locks out token after 5 wrong code attempts', async () => {
  const realHash = crypto.createHash('sha256').update('654321').digest('hex');
  const h = createResetHarness({
    initialTokens: [
      {
        id: 'tok-lock',
        user_id: 'emp-dori',
        channel: 'sms',
        destination: '+355696329620',
        token_hash: realHash,
        attempts: 4,
        used_at: null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    ],
  });

  // 5th wrong attempt -> locks token (marks used_at)
  const r5 = await h.confirmHandler(postJson({ identifier: 'dori', code: '000000', new_password: 'Password1234' }));
  const d5 = await r5.json();
  assert.equal(r5.status, 400);
  assert.match(d5.error, /bllokua|kod të ri/i);
  assert.ok(h.tokens[0].used_at, 'token is invalidated after 5th wrong attempt');

  // Even the right code no longer works after lockout
  const rAfter = await h.confirmHandler(postJson({ identifier: 'dori', code: '654321', new_password: 'Password1234' }));
  assert.equal(rAfter.status, 400);
  assert.equal(h.updatedPasswords.length, 0);
});

test('index.html exposes accessible 2-step reset modal on login screen without hidden #toast or window.prompt', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.doesNotMatch(
    html,
    /\.auth-lock>#toast\{display:none!important\}/,
    '#toast must not be hidden on the login screen',
  );
  assert.match(
    html,
    /\.auth-lock>\.overlay:not\(#resetPasswordOverlay\)\{display:none!important\}/,
    '#resetPasswordOverlay must remain visible while body has .auth-lock',
  );
  for (const id of [
    'resetPasswordOverlay',
    'resetIdentifier',
    'resetChanSms',
    'resetChanEmail',
    'resetSendCodeBtn',
    'resetStep1',
    'resetStep2',
    'resetCodeInput',
    'resetNewPassword',
    'resetConfirmPassword',
    'resetConfirmBtn',
    'resetStatusMsg',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing reset modal element #${id}`);
  }
  const fnSlice = html.slice(html.indexOf('function forgotPasswordFlow()'), html.indexOf('async function resetEmployeePassword'));
  assert.doesNotMatch(fnSlice, /\bprompt\(/, 'forgotPasswordFlow must use the modal, never blocking window.prompt()');
});
