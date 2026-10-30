import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEECH_GIVE_UP_MS, SPEECH_HINT_FAILS, SPEECH_RESTART_MS, SPEECH_STALL_MS, SPEECH_STALL_SOUND_MS, speechKeeper, speechOnDevice, speechRestartWait } from "../src/speech.mjs";

// A fake clock: timers run when the test moves time on.
function fakeClock() {
  let t = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++id, { at: t + Math.max(0, ms), fn }); return id; },
    clearTimer: (n) => { timers.delete(n); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [n, timer] of timers) if (timer.at <= end && (!next || timer.at < next[1].at)) next = [n, timer];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

// A fake recognizer like the browser's: start() twice throws, events are driven by the test.
function fakeSpeech() {
  const made = [];
  let doubleStarts = 0;
  class FakeRecognition {
    constructor(local) { this.local = local; this.running = false; this.starts = 0; this.aborted = false; made.push(this); }
    start() {
      if (this.running || this.starts) { doubleStarts++; throw new DOMException("already started", "InvalidStateError"); }
      this.running = true;
      this.starts++;
    }
    abort() { this.running = false; this.aborted = true; }
    say(text) { this.onresult?.({ results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
    fail(error) { this.onerror?.({ error }); this.end(); }
    end() { this.running = false; this.onend?.(); }
  }
  return { made, running: () => made.filter((r) => r.running), doubleStarts: () => doubleStarts, make: (local) => new FakeRecognition(local) };
}

function setup() {
  const clock = fakeClock();
  const speech = fakeSpeech();
  const log = { results: [], sessions: 0, reconnecting: [], fatal: [] };
  const keeper = speechKeeper({
    make: speech.make, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onSession: () => { log.sessions++; },
    onResult: (e) => { log.results.push(e.results[0][0].transcript); },
    onReconnecting: (on) => { log.reconnecting.push(on); },
    onFatal: (error) => { log.fatal.push(error); },
  });
  const latest = () => speech.made.at(-1);
  return { clock, speech, log, keeper, latest };
}

test("speechRestartWait: at once, and only quick failures in a row wait a little, never more than 2 s", () => {
  assert.equal(speechRestartWait(0), 0);
  assert.equal(speechRestartWait(1), 0, "one quick failure: still at once");
  assert.deepEqual([2, 3, 4, 5, 6, 50].map(speechRestartWait), [250, 500, 1000, 2000, 2000, 2000]);
  assert.equal(Math.max(...SPEECH_RESTART_MS), 2000);
});

test("each start is a fresh recognition object; the old one is aborted and its late events ignored", () => {
  const { clock, speech, log, keeper, latest } = setup();
  keeper.start();
  const first = latest();
  for (let i = 0; i < 60; i++) { clock.advance(1000); first.say(i ? `word ${i}` : "hello there"); }
  first.end(); // Chrome ends a session after about a minute
  clock.advance(0);
  assert.equal(speech.made.length, 2, "a new object, not the ended one started again");
  assert.notEqual(latest(), first);
  assert.equal(first.starts, 1);
  assert.equal(latest().running, true, "started again at once");
  first.say("late words from the old session");
  first.onend?.();
  assert.equal(log.results.at(-1), "word 59", "the old object's events are ignored");
  assert.equal(speech.made.length, 2);
  assert.equal(log.sessions, 2, "each session is announced (its results number from 0)");
  keeper.stop();
  assert.equal(latest().aborted, true);
  assert.equal(speech.running().length, 0);
});

test("a silent stall (no result, no error, no end) gets a fresh recognizer", () => {
  const { clock, speech, keeper, latest } = setup();
  keeper.start();
  latest().say("reading along");
  const stalled = latest();
  clock.advance(SPEECH_STALL_MS - 1000);
  assert.equal(speech.made.length, 1, "not yet");
  clock.advance(1000);
  assert.equal(speech.made.length, 2, "replaced after SPEECH_STALL_MS without a result");
  assert.equal(stalled.aborted, true);
  assert.equal(speech.running().length, 1, "only the fresh one runs");
  // While it hears sound, results should be coming: a shorter wait.
  latest().onsoundstart();
  clock.advance(SPEECH_STALL_SOUND_MS);
  assert.equal(speech.made.length, 3, "replaced after SPEECH_STALL_SOUND_MS while sound is heard");
  // Results keep it alive.
  for (let i = 0; i < 30; i++) { clock.advance(1000); latest().say(`word ${i}`); }
  assert.equal(speech.made.length, 3, "a session giving results is never replaced");
  keeper.stop();
});

test("rapid end/start cycles never double-start, and only one recognizer runs at a time", () => {
  const { clock, speech, keeper, latest } = setup();
  keeper.start();
  for (let i = 0; i < 40; i++) {
    const r = latest();
    r.end();
    r.end(); // a second end for the same session
    r.onerror?.({ error: "aborted" });
    clock.advance(Math.random() * 300);
    assert.ok(speech.running().length <= 1, "never two running");
  }
  clock.advance(5000);
  assert.equal(speech.doubleStarts(), 0, "no start() on a running or used object");
  assert.equal(speech.running().length, 1);
  assert.ok(speech.made.every((r) => r.starts <= 1), "every object is started at most once");
  keeper.stop();
});

test("an end straight after an error, or an error with no end at all, restarts once", () => {
  const { clock, speech, keeper, latest } = setup();
  keeper.start();
  latest().say("words");
  latest().fail("network");
  clock.advance(0);
  assert.equal(speech.made.length, 2, "a network blip: started again at once");
  latest().say("more words");
  latest().onerror({ error: "network" }); // and no end event
  clock.advance(1000);
  assert.equal(speech.made.length, 3, "restarted after the error even without an end");
  latest().end(); // the fresh one ending now restarts normally
  clock.advance(0);
  assert.equal(speech.made.length, 4);
  assert.equal(speech.running().length, 1);
  assert.equal(speech.doubleStarts(), 0);
  keeper.stop();
});

test("transient errors never turn it off within the recovery window, and the hint stays quiet for one blip", () => {
  const { clock, log, keeper, latest, speech } = setup();
  keeper.start();
  latest().say("we heard you");
  latest().fail("network");
  clock.advance(0);
  assert.deepEqual(log.reconnecting, [], "one blip: no Reconnecting hint");
  // The speech service is gone for a minute: keeps trying, a little apart, and says so once.
  const before = speech.made.length;
  for (let t = 0; t < 60_000; t += 100) {
    if (latest().running) latest().fail(["network", "no-speech", "aborted"][Math.floor(t / 100) % 3]);
    clock.advance(100);
  }
  assert.deepEqual(log.fatal, [], "never turned off: words were heard since it was turned on");
  assert.deepEqual(log.reconnecting, [true], "Reconnecting shows once");
  const tries = speech.made.length - before;
  assert.ok(tries >= 25 && tries <= 80, `tries again about every 2 s at most, not in a tight loop (${tries} tries in a minute)`);
  // Back: words heard hide the hint.
  clock.advance(2000);
  assert.equal(latest().running, true);
  latest().say("back again");
  assert.deepEqual(log.reconnecting, [true, false]);
  assert.equal(speechRestartWait(SPEECH_HINT_FAILS - 1), 0);
  keeper.stop();
});

test("a browser that never reaches its speech service gives up only after SPEECH_GIVE_UP_MS", () => {
  const { clock, log, keeper, latest } = setup();
  keeper.start();
  let t = 0;
  for (; t < SPEECH_GIVE_UP_MS - 2500; t += 50) {
    if (latest().running) latest().fail("network");
    clock.advance(50);
  }
  assert.deepEqual(log.fatal, [], "still trying within the window");
  for (; t < SPEECH_GIVE_UP_MS + 5000 && !log.fatal.length; t += 50) {
    if (latest().running) latest().fail("network");
    clock.advance(50);
  }
  assert.deepEqual(log.fatal, ["network"], "then it gives up with the network message");
  assert.equal(keeper.state.on, false);
});

test("a blocked microphone turns it off at once", () => {
  const { log, keeper, latest, speech } = setup();
  keeper.start();
  latest().fail("not-allowed");
  assert.deepEqual(log.fatal, ["not-allowed"]);
  assert.equal(speech.running().length, 0);
});

test("on-device recognition is used once available; a missing language pack falls back to the cloud", () => {
  const { clock, speech, log, keeper, latest } = setup();
  keeper.start();
  assert.equal(latest().local, false, "the browser's service until on-device is known to work");
  keeper.useLocal(true);
  assert.equal(latest().local, true, "switches to on-device at once");
  assert.equal(speech.running().length, 1);
  latest().say("on this device");
  latest().fail("service-not-allowed"); // the pack was removed, say
  clock.advance(0);
  assert.deepEqual(log.fatal, [], "not turned off");
  assert.equal(latest().local, false, "back to the browser's service");
  latest().end();
  clock.advance(0);
  assert.equal(latest().local, false, "and it stays there while it is on");
  keeper.stop();
  // Without on-device recognition, a service-not-allowed is the browser refusing: off.
  const other = setup();
  other.keeper.start();
  other.latest().fail("service-not-allowed");
  assert.deepEqual(other.log.fatal, ["service-not-allowed"]);
});

test("on-device known to work starts there; failing without an end event still falls back within a second", () => {
  const { clock, speech, log, keeper, latest } = setup();
  let lost = 0;
  const k2 = speechKeeper({ make: speech.make, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onLocalFailed: () => { lost++; }, onFatal: (e) => log.fatal.push(e) });
  k2.start({ local: true });
  assert.equal(latest().local, true, "on this device from the first session");
  latest().onerror({ error: "language-not-supported" }); // and no end event
  clock.advance(1000);
  assert.equal(latest().local, false, "the browser's service within a second, not after the stall watchdog");
  assert.equal(latest().running, true);
  assert.equal(lost, 1, "the page hears that on-device did not work");
  assert.deepEqual(log.fatal, []);
  k2.stop();
  keeper.stop();
  assert.equal(speech.running().length, 0);
});

test("a recognizer that cannot be made or started turns it off at once, without a retry loop", () => {
  for (const broken of ["make", "start"]) {
    const clock = fakeClock();
    const fatal = [];
    let made = 0;
    const keeper = speechKeeper({
      make: () => {
        made++;
        if (broken === "make") throw new Error("no speech here");
        return { start() { throw new DOMException("refused", "InvalidStateError"); }, abort() {} };
      },
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onFatal: (e) => fatal.push(e),
    });
    keeper.start();
    clock.advance(20_000);
    assert.deepEqual(fatal, ["start-failed"], `${broken} throwing: off at once with its own message`);
    assert.equal(made, 1, "no retries");
    assert.equal(keeper.state.on, false);
  }
  // After words were heard, a start that throws is a passing failure: it tries again.
  const { clock, speech, log, keeper, latest } = setup();
  keeper.start();
  latest().say("words heard");
  const r = latest();
  const FakeClass = r.constructor;
  const origStart = FakeClass.prototype.start;
  let throwsLeft = 2;
  FakeClass.prototype.start = function () { if (throwsLeft-- > 0) { this.starts++; throw new DOMException("busy", "InvalidStateError"); } return origStart.call(this); };
  r.end();
  clock.advance(5000);
  FakeClass.prototype.start = origStart;
  assert.deepEqual(log.fatal, [], "not turned off");
  assert.equal(speech.running().length, 1, "running again after two failed starts");
  keeper.stop();
});

test("on-device failing with its end event straight after: one fallback, never two running", () => {
  const { clock, speech, log, keeper, latest } = setup();
  keeper.start({ local: true });
  latest().onerror({ error: "language-not-supported" });
  latest().onend();
  clock.advance(2000);
  assert.deepEqual(speech.made.map((r) => r.local), [true, false], "one on-device, then one from the browser's service");
  assert.equal(speech.running().length, 1);
  assert.deepEqual(log.fatal, []);
  keeper.stop();
});

test("speechOnDevice: on-device when the browser has it, installing a pack; the cloud otherwise", async () => {
  class Base { }
  const withLocal = (status, installs = true) => {
    const calls = [];
    class R extends Base {
      static async available(o) { calls.push(["available", o]); return status; }
      static async install(o) { calls.push(["install", o]); return installs; }
    }
    R.prototype.processLocally = false;
    return { R, calls };
  };
  let { R, calls } = withLocal("available");
  assert.equal(await speechOnDevice(R, "en-US"), true);
  assert.deepEqual(calls, [["available", { langs: ["en-US"], processLocally: true }]]);
  ({ R, calls } = withLocal("downloadable"));
  assert.equal(await speechOnDevice(R, "nl-NL"), true, "a downloadable pack is installed (from the click)");
  assert.deepEqual(calls.map((c) => c[0]), ["available", "install"]);
  ({ R } = withLocal("downloadable", false));
  assert.equal(await speechOnDevice(R, "nl-NL"), false, "install refused: the cloud");
  ({ R } = withLocal("unavailable"));
  assert.equal(await speechOnDevice(R, "en-US"), false);
  class Rejects extends Base { static async available() { throw new DOMException("blocked", "NotAllowedError"); } }
  Rejects.prototype.processLocally = false;
  assert.equal(await speechOnDevice(Rejects, "en-US"), false, "a permissions policy refusal: the cloud");
  class Edge extends Base { }
  assert.equal(await speechOnDevice(Edge, "en-US"), false, "no available(): the cloud (Edge, older Chrome)");
  class NoProp extends Base { static async available() { return "available"; } }
  assert.equal(await speechOnDevice(NoProp, "en-US"), false, "no processLocally: the cloud");
  assert.equal(await speechOnDevice(undefined, "en-US"), false);
});
