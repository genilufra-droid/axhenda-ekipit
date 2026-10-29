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
  const wordCount = value => { const text = clean(value); return text ? text.split(' ').length : 0; };

  /* A word as the ear hears it: case, punctuation and the Albanian diacritics
   * (ë, ç) never make the same word look like two different words. The text that
   * is shown is never rewritten — this is only used to compare. */
  function wordKey(word) {
    return String(word == null ? '' : word)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  /* Two keys that only differ at the end are the same word spoken twice:
   * "përgatit"/"përgatisë", "faturat"/"faturën", "Arben"/"Arbenit". Short words
   * and clearly different lengths are never compared this way — "shumë" and
   * "shumicën" are two different words, and a wrong merge drops a spoken word. */
  function stemKey(a, b) {
    if (!a || !b) return false;
    const min = Math.min(a.length, b.length);
    if (min < 5 || Math.abs(a.length - b.length) > 2) return false;
    let shared = 0;
    while (shared < min && a[shared] === b[shared]) shared++;
    return shared >= min - 2;
  }

  const sameKey = (a, b) => a === b || stemKey(a, b);

  /* How many words at the junction were already said? Longest overlap first, so a
   * repeated restatement is removed as a whole instead of word by word. At most
   * one word of the junction may be a re-inflected form of the word that was
   * already written ("faturat"/"faturën"); everything else must match exactly. */
  function overlapLength(prevWords, nextWords) {
    const max = Math.min(prevWords.length, nextWords.length);
    for (let n = max; n > 0; n--) {
      const tail = prevWords.slice(-n).map(wordKey);
      const head = nextWords.slice(0, n).map(wordKey);
      let ok = true, mismatches = 0;
      for (let i = 0; i < n; i++) {
        if (tail[i] && tail[i] === head[i]) continue;
        mismatches++;
        if (mismatches > 1 || !sameKey(tail[i], head[i])) { ok = false; break; }
      }
      if (ok) return n;
    }
    return 0;
  }

  /* Merge a new piece of text into what was already said.
   * Browsers restate the whole utterance in every interim result, so the same
   * words arrive repeatedly. We only ever append new words, never duplicate, and
   * we never reword what was already captured. */
  function mergeTranscript(previous, incoming) {
    const prev = clean(previous), next = clean(incoming);
    if (!next) return prev;
    if (!prev) return next;
    if (next === prev) return prev;
    if (next.startsWith(prev + ' ')) return next;               // the same utterance, grown
    const prevWords = prev.split(' '), nextWords = next.split(' ');
    const overlap = overlapLength(prevWords, nextWords);
    if (overlap) return (prev + ' ' + nextWords.slice(overlap).join(' ')).trim(); // already said
    return (prev + ' ' + next).trim();
  }

  /* Read one SpeechRecognition event without losing words.
   *
   * Chrome starts a new result index for every phrase and only reports the
   * *changed* index in `resultIndex`, while the unfinished hypotheses before it
   * stay in the list. Reading from `resultIndex` only therefore threw away the
   * half sentence that was already on screen, and the preview silently restarted
   * mid-sentence. Every unfinished hypothesis is read here; final texts are read
   * once, from the first index this session has not consumed yet (`fromIndex`, the
   * highest final index already handed over), so a phrase can never be counted
   * twice nor silently skipped when the browser finalises an earlier index. */
  function readResults(event, fromIndex) {
    const out = { interim: '', finalText: '', finalIndex: -1 };
    const results = event && event.results;
    if (!results || typeof results.length !== 'number') return out;
    const consumed = Number.isInteger(fromIndex) ? fromIndex : -1;
    const interim = [], finals = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const alternative = result && result[0];
      const text = clean(alternative && alternative.transcript);
      if (!text) continue;
      if (!result.isFinal) { interim.push(text); continue; }
      if (i <= consumed) continue;
      finals.push(text);
      if (i > out.finalIndex) out.finalIndex = i;
    }
    out.interim = interim.join(' ');
    out.finalText = finals.join(' ');
    return out;
  }

  /* Word-level difference between the live preview and the final transcript.
   * Used only for the diagnostics line, so a failure report can say whether the
   * problem was in the live preview or in the final transcription. */
  function compareTranscripts(live, finalText) {
    const bag = text => {
      const map = new Map();
      for (const word of clean(text).split(' ')) {
        const key = wordKey(word);
        if (!key) continue;
        map.set(key, (map.get(key) || 0) + 1);
      }
      return map;
    };
    const liveBag = bag(live), finalBag = bag(finalText);
    const onlyLive = [], onlyFinal = [];
    for (const [key, count] of liveBag) {
      const extra = count - (finalBag.get(key) || 0);
      for (let i = 0; i < extra; i++) onlyLive.push(key);
    }
    for (const [key, count] of finalBag) {
      const extra = count - (liveBag.get(key) || 0);
      for (let i = 0; i < extra; i++) onlyFinal.push(key);
    }
    return {
      liveWords: wordCount(live), finalWords: wordCount(finalText),
      onlyLive, onlyFinal,
    };
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
      idle: '', starting: 'Po hap mikrofonin… prit një çast',
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

    /* A final result supersedes the pending preview of the same phrase: the
     * recogniser heard the whole audio, the preview only a hypothesis. Nothing is
     * invented here — words the final result does not contain are never re-added
     * by hand, and mergeTranscript() makes sure the restatement of the phrase is
     * not written twice. */
    function addFinal(text) {
      if (state === 'idle') return;
      const next = clean(text);
      if (!next) return;
      interimText = '';
      finalText = mergeTranscript(finalText, next);
      onTranscript(transcript());
    }

    /* Keep the words the recogniser never marked as final.
     * Android Chrome closes the session on every short pause without delivering
     * isFinal=true; without this flush the next session's interim result
     * overwrites the half-sentence that was already spoken. */
    function flushInterim() {
      if (state === 'idle') return false;
      const pending = clean(interimText);
      if (!pending) return false;
      interimText = '';
      finalText = mergeTranscript(finalText, pending);
      onTranscript(transcript());
      return true;
    }

    function remaining() {
      if (state !== 'listening' || !heard) return null;
      return Math.max(0, config.silenceMs - (now() - lastVoiceAt));
    }

    return {
      start, begin, fail, finish, stop: finish, complete, cancel,
      noteLevel, markSpeech, setInterim, addFinal, flushInterim, transcript, remaining,
      config, get state() { return state; }, get heardSpeech() { return heard; },
    };
  }

  const api = {
    create, mergeTranscript, clean, DEFAULTS,
    readResults, wordCount, compareTranscripts, wordKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceDictation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
