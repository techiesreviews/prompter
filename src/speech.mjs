// Follow my voice's listener: keeps the browser's speech recognition (Web
// Speech API) running for as long as Follow my voice is on. Inlined into the
// page by scripts/build.mjs, so keep it import-free and use only
// `export function` / `export const` forms.
//
// Browsers end a recognition session often: Chrome after about a minute or a
// pause, Edge when its speech service drops (a `network` error), and now and
// then a session just stops giving results without an error or an end. So:
// - every start is a fresh recognition object (an ended or broken one is
//   never started again), and the old one is cut loose (its events ignored)
//   and aborted, so two never run at once;
// - a session that ends starts again at once; only quick failures in a row
//   (ended soon after starting, nothing heard) wait a little, at most 2 s;
// - a watchdog starts a fresh one when a session has gone quiet: no result for
//   SPEECH_STALL_MS, or SPEECH_STALL_SOUND_MS while it hears sound;
// - a passing error never turns it off. Only a blocked microphone (and the
//   like) does, a browser that cannot make or start a recognizer before it
//   heard a word ("start-failed"), or one that never heard a word since it
//   was turned on and has failed for SPEECH_GIVE_UP_MS (no speech service).

/** No result for this long: the session has stalled (or the room is quiet); start a fresh one. */
export const SPEECH_STALL_MS = 10_000;
/** The same while the recognizer says it hears sound or speech: results should be coming. */
export const SPEECH_STALL_SOUND_MS = 5000;
/** A session that ends this soon after its start, with nothing heard, failed quickly. */
export const SPEECH_QUICK_MS = 1500;
/** Waits before the next start after 0, 1, 2 … quick failures in a row (the last one repeats). */
export const SPEECH_RESTART_MS = [0, 0, 250, 500, 1000, 2000];
/** Quick failures in a row before "Reconnecting to speech…" shows: one blip stays quiet. */
export const SPEECH_HINT_FAILS = 2;
/** Nothing heard since turning on and failing this long: this browser cannot do it. */
export const SPEECH_GIVE_UP_MS = 15_000;

/** Errors that turn Follow my voice off: they will not go away by starting again. */
export const SPEECH_FATAL = ["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"];

/** The wait (ms) before starting again after `fails` quick failures in a row. */
export function speechRestartWait(fails) {
  return SPEECH_RESTART_MS[Math.min(Math.max(0, fails), SPEECH_RESTART_MS.length - 1)];
}

/**
 * Keep speech recognition going. `make(local)` returns a new, configured
 * recognition object (on this device when `local`); `onSession()` runs as each
 * new one starts (its results number from 0 again); `onResult(event)` gets
 * every result event; `onReconnecting(bool)` says when quick failures in a row
 * start and stop; `onLocalFailed()` that on-device recognition did not work;
 * `onFatal(error)` says it gave up (an error name, or "start-failed" when a new
 * recognizer could not be made or started before any word was heard). Timers and the clock can be
 * replaced for tests. Returns { start, stop, useLocal, state }.
 */
export function speechKeeper({ make, onSession = () => {}, onResult = () => {}, onReconnecting = () => {}, onLocalFailed = () => {}, onFatal = () => {},
  now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), tickMs = 1000 }) {
  const s = { on: false, rec: null, gen: 0, local: false, localFailed: false, startedAt: 0, alive: 0, sound: false,
    heard: false, sessionHeard: false, fails: 0, failingSince: 0, lastError: "", reconnecting: false, restart: 0, tick: 0 };

  function setReconnecting(on) {
    if (s.reconnecting === on) return;
    s.reconnecting = on;
    onReconnecting(on);
  }

  // Cut the old recognizer loose: its late events are ignored, then it is aborted.
  function retire() {
    const r = s.rec;
    s.rec = null;
    if (!r) return;
    r.onresult = r.onerror = r.onend = r.onsoundstart = r.onspeechstart = r.onsoundend = r.onspeechend = null;
    try { r.abort(); } catch { /* already stopped */ }
  }

  function spawn() {
    if (!s.on) return;
    clearTimer(s.restart);
    s.restart = 0;
    retire();
    const gen = ++s.gen;
    const mine = () => s.on && gen === s.gen;
    s.startedAt = s.alive = now();
    s.sound = false;
    s.sessionHeard = false;
    s.lastError = "";
    // A start refused (the microphone blocked) turns it off. A browser that cannot make or
    // start one before it heard a word will not do better next time; after words it could,
    // so then it is a passing failure like any other.
    const cannot = (e) => {
      if (e?.name === "NotAllowedError" || e?.name === "SecurityError") give("not-allowed");
      else if (s.heard) ended();
      else give("start-failed");
    };
    let r;
    try { r = make(s.local && !s.localFailed); } catch (e) { cannot(e); return; }
    s.rec = r;
    r.onresult = (e) => {
      if (!mine()) return;
      s.alive = now();
      s.heard = s.sessionHeard = true;
      s.fails = 0;
      s.failingSince = 0;
      setReconnecting(false);
      onResult(e);
    };
    r.onsoundstart = r.onspeechstart = () => { if (mine()) s.sound = true; };
    r.onsoundend = r.onspeechend = () => { if (mine()) s.sound = false; };
    r.onerror = (e) => { if (mine()) failed(e?.error || ""); };
    r.onend = () => { if (mine()) ended(); };
    onSession();
    try { r.start(); } catch (e) { cannot(e); }
  }

  function failed(error) {
    s.lastError = error;
    // On-device recognition missing or removed for this language: carry on with the browser's service.
    if (s.local && !s.localFailed && (error === "service-not-allowed" || error === "language-not-supported")) { s.localFailed = true; onLocalFailed(); }
    else if (SPEECH_FATAL.includes(error)) { give(error); return; }
    // No end event after an error (some browsers): start again anyway.
    if (!s.restart) s.restart = setTimer(() => { s.restart = 0; if (s.on) ended(); }, tickMs);
  }

  // The session is over: start a fresh one, at once unless it keeps failing quickly.
  function ended() {
    if (!s.on) return;
    const quick = !s.sessionHeard && (s.lastError === "network" || now() - s.startedAt < SPEECH_QUICK_MS);
    s.fails = quick ? s.fails + 1 : 0;
    if (quick && !s.failingSince) s.failingSince = s.startedAt;
    if (!quick) s.failingSince = 0;
    if (!s.heard && s.failingSince && now() - s.failingSince >= SPEECH_GIVE_UP_MS) { give(s.lastError || "no-speech"); return; }
    if (s.fails >= SPEECH_HINT_FAILS) setReconnecting(true);
    retire();
    clearTimer(s.restart);
    s.restart = setTimer(() => { s.restart = 0; spawn(); }, speechRestartWait(s.fails));
  }

  // The watchdog: a session that has gone quiet is replaced by a fresh one.
  function watch() {
    s.tick = setTimer(watch, tickMs);
    if (!s.on || s.restart) return;
    if (!s.rec) { spawn(); return; }
    if (now() - s.alive >= (s.sound ? SPEECH_STALL_SOUND_MS : SPEECH_STALL_MS)) spawn();
  }

  function give(error) {
    stop();
    onFatal(error);
  }

  // `local`: on this device from the first session (known to work from an earlier turn-on).
  function start({ local = false } = {}) {
    stop();
    Object.assign(s, { on: true, local, heard: false, fails: 0, failingSince: 0, localFailed: false });
    spawn();
    s.tick = setTimer(watch, tickMs);
  }

  function stop() {
    s.on = false;
    clearTimer(s.restart);
    clearTimer(s.tick);
    s.restart = s.tick = 0;
    retire();
    setReconnecting(false);
  }

  // On-device recognition became available (or not): a running cloud session switches at once.
  function useLocal(on) {
    if (s.local === on) return;
    s.local = on;
    if (s.on && !s.restart && !s.localFailed) spawn();
  }

  return { start, stop, useLocal, state: s };
}

/**
 * Whether this browser can recognise `lang` on this device, installing its
 * language pack when needed (call from a click: a download needs one). Needs
 * SpeechRecognition.available and .install and `processLocally` (Chrome 139
 * and later; not in Edge or older browsers). Resolves true or false, never
 * rejects: anything missing or refused means the browser's own service.
 */
export async function speechOnDevice(Recognition, lang) {
  try {
    if (typeof Recognition?.available !== "function" || !("processLocally" in Recognition.prototype)) return false;
    const options = { langs: [lang], processLocally: true };
    const status = await Recognition.available(options);
    if (status === "available") return true;
    if ((status === "downloadable" || status === "downloading") && typeof Recognition.install === "function") return (await Recognition.install(options)) === true;
    return false;
  } catch {
    return false;
  }
}
