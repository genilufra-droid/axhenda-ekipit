/* Voice assistant window ("avatar"): state machine, Albanian summary of a task draft
 * and a speaker with fallbacks. Dependency-free; works in the browser and in
 * Node tests. Everything that touches the page or hardware is injected.
 *
 * The window is only a presentation layer around the dictation that already exists:
 * it never records, never saves a task and never sends a notification. The owner
 * confirms in the confirmation window, and notifying stays his own click.
 *
 * Voice, best first:
 *   1. server voice  (Supabase function "assistant-speak", Gemini; WAV <audio> + WebAudio)
 *   2. the browser's own Albanian voice, when the phone has one
 *   3. text only (the avatar still "talks" on screen, nothing is spoken)
 */
(function (root) {
  'use strict';

  const MONTHS = ['janar', 'shkurt', 'mars', 'prill', 'maj', 'qershor', 'korrik', 'gusht', 'shtator', 'tetor', 'nëntor', 'dhjetor'];
  const PRIORITY = { Ulet: 'e ulët', Mesme: 'e mesme', Lart: 'e lartë' };
  const MAX_SPOKEN = 600;          // longer texts are shown, never sent to the voice service
  const SERVER_WAIT_MS = 16000;    // after this the browser voice / text takes over
  const FAIL_BACKOFF_MS = 60000;   // do not retry a failing voice service on every sentence
  const AUTH_BACKOFF_MS = 600000;

  const isoParts = value => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const dayNumber = value => {
    const p = isoParts(value);
    return p ? Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000) : null;
  };

  /* "2026-10-29" -> "nesër" / "29 tetor". Only an exact calendar date is spoken. */
  function speakDate(iso, today) {
    const p = isoParts(iso);
    if (!p) return '';
    const here = dayNumber(iso), now = dayNumber(today);
    if (here != null && now != null) {
      if (here === now) return 'sot';
      if (here === now + 1) return 'nesër';
      if (here === now + 2) return 'pasnesër';
    }
    const t = isoParts(today);
    const sameYear = t && t[0] === p[0];
    return p[2] + ' ' + MONTHS[p[1] - 1] + (sameYear ? '' : ' ' + p[0]);
  }

  const clip = (text, max) => {
    const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max - 1).trim() + '…' : value;
  };

  /* Personalized Albanian greeting for the owner. */
  function greeting(name) {
    const who = clip(name, 60);
    return who
      ? 'Përshëndetje ' + who + '! Çfarë detyre do të shkruajmë?'
      : 'Përshëndetje! Çfarë detyre do të shkruajmë?';
  }

  /* What the assistant says (and writes) when a proposal is ready. */
  function summarize(draft, options) {
    const d = draft || {};
    const today = options && options.today;
    const parts = ['E përgatita detyrën: ' + (clip(d.title, 140) || 'pa titull') + '.'];
    parts.push(d.assignee ? 'Për ' + clip(d.assignee, 100) + '.' : 'Nuk ka punonjës të zgjedhur.');
    const when = speakDate(d.due, today);
    parts.push(when ? 'Afati: ' + when + '.' : 'Nuk ka afat.');
    parts.push('Prioriteti ' + (PRIORITY[d.priority] || PRIORITY.Mesme) + '.');
    parts.push('Kontrollo fushat dhe shtyp “Konfirmo dhe dërgo”. Njoftimin e zgjedh vetë.');
    return parts.join(' ');
  }

  /* ---------- speaker ---------- */
  const decodeBase64 = base64 => (typeof atob === 'function' ? atob : s => Buffer.from(s, 'base64').toString('binary'))(base64);

  function pcmToFloat32(base64) {
    const binary = decodeBase64(base64);
    const length = binary.length >> 1;
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let v = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
      if (v & 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }
    return out;
  }

  /* Wraps raw 16-bit mono little-endian PCM into a standard RIFF WAVE byte array. */
  function pcmToWav(base64, sampleRate) {
    const rate = Number(sampleRate) || 24000;
    const binary = decodeBase64(base64);
    const dataLen = binary.length & ~1;
    const buf = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buf);
    const out = new Uint8Array(buf);
    const put = (offset, str) => { for (let i = 0; i < str.length; i++) out[offset + i] = str.charCodeAt(i); };
    put(0, 'RIFF');
    view.setUint32(4, 36 + dataLen, true);
    put(8, 'WAVE');
    put(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    put(36, 'data');
    view.setUint32(40, dataLen, true);
    for (let i = 0; i < dataLen; i++) out[44 + i] = binary.charCodeAt(i) & 0xff;
    return out;
  }

  async function explainVoiceError(result) {
    const direct = result && result.data && typeof result.data.error === 'string' ? result.data.error.trim() : '';
    if (direct) return direct.slice(0, 140);
    const err = result && result.error;
    const ctx = err && err.context;
    if (ctx && typeof ctx === 'object') {
      try {
        const res = typeof ctx.clone === 'function' ? ctx.clone() : ctx;
        if (typeof res.json === 'function') {
          const body = await res.json();
          if (body && typeof body.error === 'string' && body.error.trim()) return body.error.trim().slice(0, 140);
        }
      } catch (e) { /* ignore non-JSON body */ }
      const status = Number(ctx.status) || 0;
      if (status === 0) return 'pa lidhje me serverin';
      if (status === 404) return 'funksioni assistant-speak nuk është publikuar (404)';
      if (status === 401) return 'sesioni ka skaduar — hyr përsëri';
      if (status === 403) return 'vetëm Pronari mund ta përdorë zërin';
      if (status === 429) return 'kufiri falas i zërit u arrit';
      if (status === 500) return 'zëri nuk është konfiguruar (GEMINI_API_KEY)';
      if (status === 504) return 'zëri i serverit u vonua';
      return 'zëri në server ktheu HTTP ' + status;
    }
    const msg = String((err && err.message) || '').trim();
    return msg ? msg.slice(0, 140) : 'zëri në server dështoi';
  }

  function createSpeaker(o) {
    o = o || {};
    const timers = o.timers || { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) };
    const now = o.now || (() => Date.now());
    const waitMs = Number(o.serverWaitMs) > 0 ? Number(o.serverWaitMs) : SERVER_WAIT_MS;
    const cache = new Map();
    let token = 0, pending = null, downUntil = 0;

    const reportError = reason => { try { o.onError && o.onError(reason); } catch (e) { /* ignore */ } };
    const reportReady = () => { try { o.onReady && o.onReady(); } catch (e) { /* ignore */ } };

    function finish(result) {
      const p = pending;
      if (!p) return;
      pending = null;
      try { p.cleanup && p.cleanup(); } catch (e) { /* nothing to clean */ }
      p.resolve(result);
    }
    function stop() {
      token++;
      finish('stopped');
      try { o.speechSynthesis && o.speechSynthesis.cancel(); } catch (e) { /* no synthesis */ }
    }

    function withTimeout(promise, ms) {
      let id;
      return Promise.race([
        promise,
        new Promise((_, reject) => { id = timers.set(() => reject(new Error('timeout')), ms); }),
      ]).finally(() => timers.clear(id));
    }

    async function serverAudio(text) {
      if (cache.has(text)) return cache.get(text);
      const ctx = o.getAudioContext && o.getAudioContext();
      const canBuffer = !!(ctx && typeof ctx.createBuffer === 'function');
      const hasWav = typeof o.playWav === 'function';
      if (!o.invoke || (!canBuffer && !hasWav)) return null;
      const result = await withTimeout(o.invoke('assistant-speak', { body: { text } }), waitMs);
      if (result && (result.error || (result.data && result.data.error))) {
        const status = result.error && result.error.context && result.error.context.status;
        if (status !== 0) {
          downUntil = now() + (status === 401 || status === 403 ? AUTH_BACKOFF_MS : FAIL_BACKOFF_MS);
        }
        reportError(await explainVoiceError(result));
        return null;
      }
      const base64 = result && result.data && result.data.audioBase64;
      if (!base64) { downUntil = now() + FAIL_BACKOFF_MS; reportError('përgjigje pa audio nga serveri'); return null; }
      const match = /rate=(\d+)/.exec(String(result.data.mimeType || ''));
      const rate = match ? Number(match[1]) || 24000 : 24000;
      const samples = pcmToFloat32(base64);
      if (!samples.length) { downUntil = now() + FAIL_BACKOFF_MS; reportError('audio bosh nga serveri'); return null; }
      let buffer = null;
      if (canBuffer && !hasWav) {
        buffer = ctx.createBuffer(1, samples.length, rate);
        buffer.getChannelData(0).set(samples);
      }
      const entry = { buffer, base64, rate, length: samples.length };
      if (cache.size >= 20) cache.delete(cache.keys().next().value);
      cache.set(text, entry);
      return entry;
    }

    /* Phones suspend/interrupt WebAudio while the microphone is open; resume it before playing. */
    async function ensureRunning(ctx) {
      if (!ctx) return false;
      if (!ctx.state || ctx.state === 'running') return true;
      if (typeof ctx.resume === 'function') {
        try { await withTimeout(Promise.resolve(ctx.resume()), 800); } catch (e) { /* stayed locked */ }
      }
      return !ctx.state || ctx.state === 'running';
    }

    function playBuffer(ctx, entry, mine) {
      return new Promise(resolve => {
        let buffer = entry.buffer;
        if (!buffer && ctx.createBuffer) {
          const samples = pcmToFloat32(entry.base64);
          buffer = ctx.createBuffer(1, samples.length, entry.rate);
          buffer.getChannelData(0).set(samples);
          entry.buffer = buffer;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        const maxMs = Math.max(2500, Math.ceil((entry.length / (entry.rate || 24000)) * 1000) + 1500);
        let guardId = timers.set(() => { guardId = null; if (mine === token) finish('server'); }, maxMs);
        pending = {
          resolve,
          cleanup() {
            if (guardId != null) { timers.clear(guardId); guardId = null; }
            source.onended = null;
            try { source.stop(); } catch (e) { /* already ended */ }
          },
        };
        source.onended = () => { if (mine === token) finish('server'); };
        try { source.start(); reportReady(); } catch (e) { finish('failed'); }
      });
    }

    function playWavElement(entry, mine) {
      return new Promise(resolve => {
        let stopWav = null;
        const maxMs = Math.max(2500, Math.ceil((entry.length / (entry.rate || 24000)) * 1000) + 1500);
        let guardId = timers.set(() => { guardId = null; if (mine === token) finish('server'); }, maxMs);
        pending = {
          resolve,
          cleanup() {
            if (guardId != null) { timers.clear(guardId); guardId = null; }
            try { stopWav && stopWav(); } catch (e) { /* already stopped */ }
          },
        };
        try {
          const wav = entry.wav || (entry.wav = pcmToWav(entry.base64, entry.rate));
          const ctl = o.playWav(wav, () => { if (mine === token) finish('server'); }, () => { if (mine === token) finish('failed'); });
          if (ctl && typeof ctl.stop === 'function') stopWav = () => ctl.stop();
          if (ctl && typeof ctl.started?.then === 'function') {
            ctl.started.then(ok => {
              if (mine !== token) return;
              if (ok === false) finish('failed');
              else reportReady();
            }, () => { if (mine === token) finish('failed'); });
          } else reportReady();
        } catch (e) { finish('failed'); }
      });
    }

    function albanianVoice() {
      try {
        const voices = (o.speechSynthesis && o.speechSynthesis.getVoices && o.speechSynthesis.getVoices()) || [];
        return voices.find(v => /^sq(\b|[-_])/i.test(String(v.lang || '')) || /albanian|shqip/i.test(String(v.name || ''))) || null;
      } catch (e) { return null; }
    }

    function browserSpeak(text, voice, mine) {
      return new Promise(resolve => {
        const u = new o.Utterance(text);
        u.voice = voice; u.lang = voice.lang || 'sq-AL'; u.rate = 0.95; u.pitch = 1;
        pending = { resolve, cleanup() { u.onend = null; u.onerror = null; } };
        u.onend = () => { if (mine === token) finish('browser'); };
        u.onerror = () => { if (mine === token) finish('failed'); };
        try { o.speechSynthesis.speak(u); } catch (e) { finish('failed'); }
      });
    }

    /* No voice at all: the avatar still "talks" on screen for as long as reading takes. */
    function silentSpeak(text, mine) {
      return new Promise(resolve => {
        const wait = Math.min(6000, 1200 + String(text).length * 45);
        let id = timers.set(() => { id = null; if (mine === token) finish('text'); }, wait);
        pending = { resolve, cleanup() { if (id != null) timers.clear(id); } };
      });
    }

    async function speak(text) {
      const value = String(text == null ? '' : text).trim();
      stop();
      const mine = token;
      if (!value) return 'text';
      if (value.length <= MAX_SPOKEN && now() >= downUntil) {
        try {
          const entry = await serverAudio(value);
          if (mine !== token) return 'stopped';
          if (entry) {
            // Prefer HTMLAudioElement (<audio playsinline>) on browsers: plays through the
            // media speaker channel even when iPhone's silent switch is on or after mic capture.
            if (typeof o.playWav === 'function') {
              const playedWav = await playWavElement(entry, mine);
              if (playedWav === 'server' || playedWav === 'stopped') return playedWav;
            }
            if (mine !== token) return 'stopped';
            const ctx = o.getAudioContext && o.getAudioContext();
            if (ctx && await ensureRunning(ctx)) {
              if (mine !== token) return 'stopped';
              const played = await playBuffer(ctx, entry, mine);
              if (played === 'server' || played === 'stopped') return played;
            }
            reportError('audioja u bllokua nga pajisja — prek ekranin ose rrit volumin');
          }
        } catch (e) {
          downUntil = now() + FAIL_BACKOFF_MS;
          reportError(e && e.message === 'timeout' ? 'zëri i serverit u vonua' : 'zëri në server dështoi');
          if (mine !== token) return 'stopped';
        }
      }
      const voice = o.Utterance && albanianVoice();
      if (voice) {
        const res = await browserSpeak(value, voice, mine);
        if (res === 'browser' || res === 'stopped') return res;
      }
      return await silentSpeak(value, mine);
    }

    /* Must run inside a tap: phones keep audio locked until then. */
    function unlock() {
      try {
        const ctx = o.getAudioContext && o.getAudioContext();
        if (ctx) {
          if (ctx.state && ctx.state !== 'running' && ctx.resume) ctx.resume().catch(() => {});
          if (ctx.state === 'running' && ctx.createBuffer && ctx.createBufferSource && !ctx._silentPrimed) {
            ctx._silentPrimed = true;
            const b = ctx.createBuffer(1, 1, 22050);
            const s = ctx.createBufferSource();
            s.buffer = b;
            s.connect(ctx.destination);
            s.start(0);
          }
        }
      } catch (e) { /* audio stays locked */ }
      try { o.unlockAudio && o.unlockAudio(); } catch (e) { /* ignore */ }
      try { o.speechSynthesis && o.speechSynthesis.getVoices && o.speechSynthesis.getVoices(); } catch (e) { /* ignore */ }
    }

    return { speak, stop, unlock, get cache() { return cache; } };
  }

  /* ---------- window controller ---------- */
  const TEXT = {
    greeting: 'Përshëndetje! Çfarë detyre do të shkruajmë?',
    greetingPill: 'Po ju përshëndes…',
    ready: 'Kliko mikrofonin për të folur',
    opening: 'Po hap mikrofonin… prit një çast',
    openingHint: 'Lejo mikrofonin nëse të kërkohet.',
    listening: 'Po të dëgjoj…',
    listeningHint: 'Fol lirshëm. Ndalon vetë pas 3 sekondash heshtjeje.',
    thinking: 'Po e përgatis detyrën…',
    thinkingHint: 'Po nxjerr detyrën nga fjalët e tua…',
    review: 'Kontrollo fushat te dritarja',
    reminder: 'Punonjësi NUK do të njoftohet. Kliko katrorin “Njofto punonjësit” nëse do ta njoftosh, ose shtyp “Konfirmo dhe dërgo” sërish për ta ruajtur pa njoftim.',
    savedNotified: 'Detyra u ruajt dhe punonjësit e zgjedhur u njoftuan.',
    saved: 'Detyra u ruajt. Asnjë njoftim nuk u dërgua.',
    discarded: 'Asgjë nuk u ruajt. Kliko mikrofonin për një detyrë tjetër.',
  };

  function create(o) {
    o = o || {};
    const els = o.els || {};
    const speaker = o.speaker || { speak: () => Promise.resolve('text'), stop() {}, unlock() {} };
    const today = o.today || (() => '');
    const ownerName = o.ownerName || (() => '');
    let state = 'closed', muted = false, speechToken = 0;

    const setText = (el, text) => { if (el) el.textContent = text; };
    const toggle = (el, name, on) => { if (el && el.classList) el.classList[on ? 'add' : 'remove'](name); };

    function paint(next, pill, chat) {
      state = next;
      if (pill != null) setText(els.pill, pill);
      if (chat != null) setText(els.chat, chat);
      toggle(els.body, 'listening', next === 'listening');
      toggle(els.body, 'talking', next === 'speaking');
      toggle(els.avatar, 'listening', next === 'listening');
      toggle(els.mic, 'listening', next === 'listening');
      if (els.stage && els.stage.setAttribute) els.stage.setAttribute('data-state', next);
    }

    function stopSpeaking() {
      speechToken++;
      try { speaker.stop(); } catch (e) { /* nothing was playing */ }
      if (state === 'speaking') paint('idle', TEXT.ready, null);
    }

    function say(text, options) {
      const opts = options || {};
      const mine = ++speechToken;
      try { speaker.stop(); } catch (e) { /* nothing was playing */ }
      const pill = opts.pill != null ? opts.pill : TEXT.review;
      if (muted) {
        paint('idle', opts.after != null ? opts.after : pill, text);
        return Promise.resolve('muted');
      }
      paint('speaking', pill, text);
      return Promise.resolve(speaker.speak(text)).then(result => {
        if (mine === speechToken && state === 'speaking') paint('idle', opts.after != null ? opts.after : pill, null);
        return result;
      }, () => {
        if (mine === speechToken && state === 'speaking') paint('idle', opts.after != null ? opts.after : pill, null);
        return 'failed';
      });
    }

    const api = {
      get state() { return state; },
      get muted() { return muted; },
      isOpen() { return state !== 'closed'; },

      unlock() {
        try { speaker.unlock(); } catch (e) { /* audio stays locked */ }
      },
      open() {
        const wasClosed = state === 'closed';
        toggle(els.stage, 'show', true);
        try { speaker.unlock(); } catch (e) { /* audio stays locked */ }
        if (wasClosed) {
          paint('idle', TEXT.ready, greeting(ownerName()));
          if (els.liveField) els.liveField.value = '';
        }
      },
      /* Opens the window AND greets the owner aloud in Albanian. */
      greet(customName) {
        toggle(els.stage, 'show', true);
        try { speaker.unlock(); } catch (e) { /* audio stays locked */ }
        if (els.liveField) els.liveField.value = '';
        const hi = greeting(customName != null ? customName : ownerName());
        return say(hi, { pill: TEXT.greetingPill, after: TEXT.ready });
      },
      close() {
        speechToken++;
        try { speaker.stop(); } catch (e) { /* nothing was playing */ }
        toggle(els.stage, 'show', false);
        paint('closed', null, null);
        toggle(els.body, 'talking', false);
      },
      /* Escape: true when the window itself handled it (closing it). While the
       * microphone or the AI is busy the caller cancels that work instead. */
      escape() {
        if (state === 'closed') return false;
        if (state === 'speaking') { stopSpeaking(); return true; }
        if (state === 'idle') { api.close(); return true; }
        return false;
      },

      beforeListen() {                                      // the microphone must never hear the avatar
        api.open(); stopSpeaking();
        const who = clip(ownerName(), 60);
        paint('idle', TEXT.opening, who ? 'Përshëndetje ' + who + '! ' + TEXT.openingHint : TEXT.openingHint);
      },
      listening() {
        if (state === 'closed') return;
        stopSpeaking();
        if (els.liveField) els.liveField.value = '';
        paint('listening', TEXT.listening, TEXT.listeningHint);
      },
      listeningCountdown(msLeft) {
        if (state !== 'listening') return;
        if (msLeft != null && msLeft > 0 && msLeft < 2800) {
          setText(els.pill, 'Po të dëgjoj… ndalon pas ' + (msLeft / 1000).toFixed(1) + 's');
        } else {
          setText(els.pill, TEXT.listening);
        }
      },
      heard(text) {
        if (els.liveField && state !== 'closed') {
          els.liveField.value = String(text || '');
          try { els.liveField.scrollLeft = els.liveField.scrollWidth; } catch (e) { /* ignore */ }
        }
      },
      thinking() { if (state !== 'closed') paint('thinking', TEXT.thinking, TEXT.thinkingHint); },

      draft(draft) {
        if (state === 'closed') return Promise.resolve('closed');
        return say(summarize(draft, { today: today() }));
      },
      reminder() { return state === 'closed' ? Promise.resolve('closed') : say(TEXT.reminder, { pill: 'Njoftimi është zgjedhja jote' }); },
      saved(info) {
        if (state === 'closed') return Promise.resolve('closed');
        if (els.liveField) els.liveField.value = '';
        const notified = !!(info && info.notified);
        return say(notified ? TEXT.savedNotified : TEXT.saved, { pill: 'U ruajt', after: TEXT.ready });
      },
      discarded() { if (state !== 'closed') { stopSpeaking(); paint('idle', TEXT.ready, TEXT.discarded); } },
      /* Dictation ended without a proposal (cancelled, no voice, failure). */
      idle(message) {
        if (state === 'closed') return;
        stopSpeaking();
        paint('idle', TEXT.ready, message || greeting(ownerName()));
      },

      toggleMute() {
        muted = !muted;
        if (muted) stopSpeaking();
        if (els.mute) {
          els.mute.textContent = muted ? '🔇' : '🔊';
          if (els.mute.setAttribute) { els.mute.setAttribute('aria-pressed', muted ? 'true' : 'false'); els.mute.title = muted ? 'Ndiz zërin' : 'Hesht zërin'; }
        }
        return muted;
      },
      stopSpeaking,
    };
    return api;
  }

  const api = { create, createSpeaker, summarize, greeting, speakDate, pcmToFloat32, pcmToWav, TEXT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AvatarAssistant = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
