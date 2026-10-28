/* Shared, dependency-free voice dictation engine. Works in the browser and in Node tests.
 *
 * The engine owns: the state machine, the live transcript merge and the
 * voice-activity silence timer. Everything that touches hardware or the DOM
 * (microphone, AudioContext, MediaRecorder, SpeechRecognition) is injected by
 * the caller through hooks, so the whole behaviour is deterministic in tests.
 *
 * Silence is detected from real microphone energy (noteLevel), never from the
 * absence of SpeechRecognition results.
 */
(function(root){
  'use strict';
  const DEFAULTS = {
    silenceMs: 3000,        // 3 full seconds without voice ends the dictation
    minSpeechMs: 300,       // shorter blips (cough, door) are not speech
    maxSpeechMs: 60000,     // hard stop for a single dictation
    graceMs: 900,           // wait for the last SpeechRecognition result after stop
    speechThreshold: 0.035, // RMS above which the microphone counts as voice
    noiseFactor: 2.2,       // dynamic floor multiplier (quiet rooms stay sensitive)
    maxThreshold: 0.12,     // never require more than this, even in a noisy room
    levelFloor: 0.004,      // levels under this never move the noise floor
  };
  const noop = () => {};
  const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  /* Merge a new piece of text into what was already said.
   * Browsers restate the whole utterance in every interim result, so the same
   * words arrive repeatedly. We only ever append new words, never duplicate. */
  function mergeTranscript(previous, incoming) {
    const prev = clean(previous), next = clean(incoming);
    if (!next) return prev;
    if (!prev) return next;
    if (next === prev) return prev;
    if (next.startsWith(prev + ' ')) return next;               // the same utterance, grown
    const prevWords = prev.split(' '), nextWords = next.split(' ');
    for (let n = Math.min(prevWords.length, nextWords.length); n > 0; n--) {
      const tail = prevWords.slice(-n).join(' ').toLowerCase();
      const head = nextWords.slice(0, n).join(' ').toLowerCase();
      if (tail === head) return (prev + ' ' + nextWords.slice(n).join(' ')).trim(); // already said
    }
    return (prev + ' ' + next).trim();
  }

  function create(options) {
    options = options || {};
    const config = Object.assign({}, DEFAULTS, options.config || {});
    const now = options.now || (() => Date.now());
    const timers = options.timers || {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: id => clearTimeout(id),
    };
    const onStatus = options.onStatus || noop;
    const onTranscript = options.onTranscript || noop;
    const onResult = options.onResult || noop;
    const onCancel = options.onCancel || noop;
    const onError = options.onError || noop;
    const onStop = options.onStop || noop;       // stop SpeechRecognition/recorder, flush final words
    const onRelease = options.onRelease || noop; // free the microphone and audio resources

    const labels = {
      idle: '', starting: 'Po hap mikrofonin…',
      listening: 'Po dëgjoj…', stopping: 'Po përfundoj regjistrimin…',
    };
    let state = 'idle';
    let startedAt = 0, lastVoiceAt = 0, lastTickAt = 0, speechMs = 0, heard = false;
    let finalText = '', interimText = '', reason = '', noiseFloor = 0;
    let silenceTimer = null, capTimer = null, graceTimer = null, released = true;

    function transcript() { return mergeTranscript(finalText, interimText); }
    function emit(extra) {
      onStatus(Object.assign({ state, label: labels[state] || '', transcript: transcript() }, extra || {}));
    }
    function clearTimer(id) { if (id != null) { timers.clear(id); } return null; }
    function clearTimers() {
      silenceTimer = clearTimer(silenceTimer);
      capTimer = clearTimer(capTimer);
      graceTimer = clearTimer(graceTimer);
    }
    function release() {
      if (released) return;
      released = true;
      try { onRelease({ reason, transcript: transcript() }); } catch (e) {}
    }
    function threshold() {
      return Math.min(config.maxThreshold, Math.max(config.speechThreshold, noiseFloor * config.noiseFactor));
    }
    function reset() {
      state = 'idle'; startedAt = lastVoiceAt = lastTickAt = 0;
      speechMs = 0; heard = false; finalText = ''; interimText = '';
      reason = ''; noiseFloor = 0; released = true;
    }

    function armSilence() {
      silenceTimer = clearTimer(silenceTimer);
      const wait = Math.max(0, config.silenceMs - (now() - lastVoiceAt));
      silenceTimer = timers.set(checkSilence, wait);
    }

    function checkSilence() {
      silenceTimer = null;
      if (state !== 'listening' || !heard) return;
      const idle = now() - lastVoiceAt;
      if (idle < config.silenceMs) { armSilence(); return; }       // speaking resumed meanwhile
      if (speechMs < config.minSpeechMs) {                          // a blip, not speech: keep listening
        heard = false; speechMs = 0; emit();
        return;
      }
      finish('silence');
    }

    /* Registers one moment of real voice activity and restarts the silence countdown. */
    function registerVoice(credit) {
      const t = now();
      if (!heard) { heard = true; speechMs = 0; }
      speechMs += Math.max(Number(credit) || 0, Math.min(t - lastTickAt, 250));
      lastTickAt = t; lastVoiceAt = t;
      armSilence();                                                  // counting restarts on every word
    }

    /* Called by the caller's audio monitor with the current RMS level (0..1). */
    function noteLevel(level) {
      const value = Number(level) || 0;
      if (state !== 'listening') return;
      if (value >= threshold()) registerVoice(0);
      else {
        if (value >= config.levelFloor) noiseFloor = noiseFloor * 0.95 + value * 0.05;
        if (heard && !silenceTimer) armSilence();                    // keep the deadline alive
      }
    }

    /* Degraded mode (no AudioContext): a recognition result is treated as speech. */
    function markSpeech() {
      if (state !== 'listening') return;
      registerVoice(config.minSpeechMs);
    }
    function finish(why) {
      if (state !== 'listening') return;                            // never stop twice
      reason = why || 'manual';
      state = 'stopping';
      clearTimers();
      emit();
      try { onStop({ reason, transcript: transcript() }); } catch (e) {}
      graceTimer = timers.set(() => complete(), Math.max(0, config.graceMs));
    }

    function complete() {
      if (state !== 'stopping') return;
      graceTimer = clearTimer(graceTimer);
      state = 'idle';
      const text = transcript();
      const spoke = heard && speechMs >= config.minSpeechMs;
      const result = { transcript: text, heardSpeech: spoke, reason, speechMs, durationMs: startedAt ? now() - startedAt : 0 };
      release();
      reset();
      state = 'idle';
      try { onResult(result); } catch (e) {}
      emit();
    }

    function start() {
      if (state !== 'idle') return false;
      state = 'starting'; released = false; reason = '';
      startedAt = now(); lastVoiceAt = lastTickAt = startedAt;
      speechMs = 0; heard = false; finalText = ''; interimText = ''; noiseFloor = 0;
      emit();
      return true;
    }

    function begin() {
      if (state !== 'starting') return false;
      state = 'listening'; startedAt = now(); lastVoiceAt = lastTickAt = startedAt;
      capTimer = timers.set(() => finish('limit'), Math.max(1000, config.maxSpeechMs));
      emit();
      return true;
    }

    function fail(message) {
      const wasActive = state !== 'idle';
      clearTimers(); state = 'idle'; release(); reset();
      if (wasActive) { try { onError(message || 'Mikrofoni nuk u hap.'); } catch (e) {} }
      emit();
    }

    function cancel() {
      const wasActive = state !== 'idle';
      clearTimers();
      const hadReason = reason;
      reason = 'cancel';
      state = 'idle'; release(); reset();
      if (wasActive) { try { onCancel({ reason: hadReason }); } catch (e) {} }
      emit();
    }

    function setInterim(text) {
      if (state === 'idle') return;
      const next = clean(text);
      if (next === interimText) return;
      interimText = next;
      onTranscript(transcript());
    }

    function addFinal(text) {
      if (state === 'idle') return;
      const next = clean(text);
      if (!next) return;
      finalText = mergeTranscript(finalText, next);
      interimText = '';
      onTranscript(transcript());
    }

    function remaining() {
      if (state !== 'listening' || !heard) return null;
      return Math.max(0, config.silenceMs - (now() - lastVoiceAt));
    }

    return {
      start, begin, fail, finish, stop: finish, complete, cancel,
      noteLevel, markSpeech, setInterim, addFinal, transcript, remaining,
      config, get state() { return state; }, get heardSpeech() { return heard; },
    };
  }

  const api = { create, mergeTranscript, clean, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceDictation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
