// OBS link: starts and stops a take in OBS from the record light. It talks only to OBS's own
// WebSocket server on this computer (obs-websocket protocol v5, built into OBS 28 and later), never a
// server, and sends OBS only the take's file name and the start and stop: never the script. The OBS
// password stays on this device; only OBS's answer to its challenge goes over the wire. Off until the
// user turns it on in Settings. Inlined into the page by scripts/build.mjs, so keep it import-free and
// use only `export function`/`export const` forms.

export const OBS_URL = "ws://127.0.0.1:4455";
export const OBS_PROTOCOL = "obswebsocket.json";
/** OBS's own default file name, put back when the name OBS had was one of ours. */
export const OBS_FORMAT = "%CCYY-%MM-%DD %hh-%mm-%ss";
/** OBS closes the connection with this code when the password is wrong. */
export const OBS_AUTH_FAILED = 4009;
/** Tries missed in a row before OBS counts as not found. */
export const OBS_MISSES = 3;
/**
 * The waits: before trying again after the first and second miss, between tries once not found, and for
 * an answer. `newer`: a recording OBS began more than this long after a stop was asked is another one.
 */
export const OBS_DELAYS = { retry: [1000, 2000], again: 10_000, wait: 5000, newer: 2000, peers: 300 };
/** The take memory keeps this many scripts. */
export const TAKES_KEPT = 20;
/** The take numbers kept per scene and script (the newest). */
export const TAKES_PER_SCENE = 99;
const OUTPUT_EVENTS = 1 << 6; // obs-websocket's EventSubscription.Outputs: RecordStateChanged
const OP = { hello: 0, identify: 1, identified: 2, event: 5, request: 6, response: 7 };
const FILENAME = { parameterCategory: "Output", parameterName: "FilenameFormatting" };

/** OBS's answer to its challenge: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export async function obsAuth(password, { salt, challenge }, subtle = globalThis.crypto.subtle) {
  const sha = async (text) => {
    const bytes = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  return sha((await sha(password + salt)) + challenge);
}

/** A short mark of some text (FNV-1a, base 36). */
function markOf(text) {
  let h = 0x811c9dc5;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}

/**
 * Words fit for a file name: lower case, no accents or marks, dashes between, at most 40 characters.
 * A title that loses something on the way (longer than 40 characters, or a letter or digit that is not
 * Latin, also beside Latin words) gets a mark of the whole title, so two different titles never share
 * a folder or a count of takes.
 */
function slugOf(words) {
  const plain = words.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’]/g, "");
  const full = plain.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const lost = words.length > 40 || /[^a-z0-9\P{L}]|[^0-9\P{N}]/u.test(plain);
  if (full && !lost) return full;
  const mark = markOf(words).padStart(6, "0").slice(-6);
  return `${full.slice(0, 33).replace(/-+$/, "") || "scene"}-${mark}`;
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * A script section as a scene: "2 · What it really costs" is scene 2, shown as "S2", its takes in the
 * folder `02-what-it-really-costs`. A section without a number ("INTRO") is scene 0, shown by its name.
 */
export function sceneOf(title) {
  const m = /^\s*(\d{1,3})\s*[·.:)–—-]\s*(.*)$/.exec(String(title));
  const number = m ? Number(m[1]) : 0;
  const words = (m ? m[2] : String(title)).trim();
  const tag = number ? `S${number}` : (words.length > 14 ? `${words.slice(0, 13).trimEnd()}…` : words) || "S0";
  return { number, words, tag, base: `${pad2(number)}-${slugOf(words)}` };
}

/** The name OBS records a take under: `scenes/02-title/scene-02-title-take-03` (OBS makes the folders). */
export function takeName(scene, take) {
  return `scenes/${scene.base}/scene-${scene.base}-take-${pad2(take)}`;
}

/** Whether OBS's file name is one of ours, left by a take whose name was never put back. */
export function isTakeName(format) {
  return /^scenes\/\d{2,3}-[a-z0-9-]+\/scene-\d{2,3}-[a-z0-9-]+-take-\d{2,}$/.test(String(format ?? ""));
}

/** A take's length as the timer shows it: "01:05", or "1:01:05" past an hour. */
export function clockText(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const mmss = `${pad2(Math.floor((t % 3600) / 60))}:${pad2(t % 60)}`;
  return h ? `${h}:${mmss}` : mmss;
}

/** One script's mark in the take memory: its scene titles, in order. */
export function videoKey(titles) {
  return markOf(titles.join("\n"));
}

/**
 * The take memory from its stored text: { videos: { [script]: { at, scenes: { [scene]: { takes, best } } } },
 * highest: { [scene]: n } }, `takes` the numbers recorded for that scene under that script, in order (a
 * scene folder is shared by every script with that scene, so another script's numbers are not this
 * one's), `highest` each scene folder's highest take number ever counted, kept when its scripts are let go.
 */
export function readTakes(text) {
  let book;
  try { book = JSON.parse(text); } catch { book = null; }
  const videos = {};
  if (book && typeof book.videos === "object" && book.videos && !Array.isArray(book.videos)) {
    for (const [key, v] of Object.entries(book.videos)) {
      if (!v || typeof v.scenes !== "object" || !v.scenes) continue;
      const scenes = {};
      for (const [base, s] of Object.entries(v.scenes)) {
        const takes = Array.isArray(s?.takes) ? [...new Set(s.takes.filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b).slice(-TAKES_PER_SCENE) : [];
        if (takes.length) scenes[base] = { takes, best: takes.includes(s.best) ? s.best : takes.at(-1) };
      }
      videos[key] = { at: Number(v.at) || 0, scenes };
    }
  }
  const highest = {};
  if (book && typeof book.highest === "object" && book.highest && !Array.isArray(book.highest)) {
    for (const [base, n] of Object.entries(book.highest)) if (Number.isInteger(n) && n >= 1) highest[base] = n;
  }
  for (const v of Object.values(videos)) for (const [base, s] of Object.entries(v.scenes)) highest[base] = Math.max(highest[base] || 0, ...s.takes);
  return { videos, highest };
}

/** A scene's take numbers so far under this script and the best one ([] and 0 before the first take). */
export function takesFor(book, video, base) {
  const s = Object.hasOwn(book.videos, video) && Object.hasOwn(book.videos[video].scenes, base) ? book.videos[video].scenes[base] : null;
  return s ? { takes: [...s.takes], best: s.best } : { takes: [], best: 0 };
}

/**
 * The next take number for a scene folder: above every take counted for that folder under any video,
 * as a fixed title or a revised script gives a new video key but the same folder on disk, and a name
 * must never come back.
 */
export function nextTake(book, base) {
  let most = Object.hasOwn(book.highest || {}, base) ? book.highest[base] : 0;
  for (const v of Object.values(book.videos)) if (Object.hasOwn(v.scenes, base)) most = Math.max(most, ...v.scenes[base].takes);
  return most + 1;
}

function withScene(book, video, base, scene, at) {
  const v = Object.hasOwn(book.videos, video) ? book.videos[video] : { at, scenes: {} };
  const videos = { ...book.videos, [video]: { at, scenes: { ...v.scenes, [base]: scene } } };
  const keep = Object.entries(videos).sort((a, b) => b[1].at - a[1].at).slice(0, TAKES_KEPT);
  const highest = { ...book.highest, [base]: Math.max(book.highest?.[base] || 0, ...scene.takes) };
  return { videos: Object.fromEntries(keep), highest };
}

/**
 * Take number `take` of a scene (by default one above this script's newest), once: a take already
 * counted changes nothing. The new take carries the star. `at` orders the scripts (newest kept).
 */
export function addTake(book, video, base, at, take = (takesFor(book, video, base).takes.at(-1) || 0) + 1) {
  const { takes } = takesFor(book, video, base);
  if (takes.includes(take)) return book;
  return withScene(book, video, base, { takes: [...takes, take].sort((a, b) => a - b).slice(-TAKES_PER_SCENE), best: take }, at);
}

/** Star a scene's take as its best. */
export function starTake(book, video, base, take) {
  const s = takesFor(book, video, base);
  if (!s.takes.includes(take)) return book;
  return withScene(book, video, base, { takes: s.takes, best: take }, book.videos[video].at);
}

/**
 * What the light shows for a scene (as the chosen mockup does): while recording the take being
 * recorded (`next`, from nextTake); otherwise the take picked on the rail, or the newest, or before
 * any the take R records next. The star shows once there is a take and nothing records: "on" when
 * the shown take is the best.
 */
export function takeView({ takes, best }, picked, recording, next = (takes.at(-1) || 0) + 1) {
  if (recording) return { take: next, star: "none" };
  const take = (takes.includes(picked) ? picked : 0) || takes.at(-1) || next;
  return { take, star: takes.length ? (best === take ? "on" : "off") : "none" };
}

/**
 * After a try that did not reach OBS: the link's next state, the misses in a row and which retry wait
 * to use (an index into OBS_DELAYS.retry; -1 for the slower tries once not found). One miss is not
 * "not found": a link that was on says `reconnecting`, one still `connecting` keeps connecting.
 */
export function obsAfterMiss(state, misses) {
  const n = misses + 1;
  if (n >= OBS_MISSES) return { state: "lost", misses: n, retry: -1 };
  return { state: state === "connecting" ? "connecting" : "reconnecting", misses: n, retry: n - 1 };
}

/**
 * The link to OBS. States: off, connecting, on, reconnecting, lost (not found; it keeps looking),
 * password (OBS asks for one and none is typed) and wrong (OBS refused the password; tried again
 * only when the password changes or `retry()` is asked). `recording` says whether OBS records: true
 * only once OBS itself said so (its started word, or its answer when asked), never from a start OBS only
 * took, as OBS answers a start before the recording begins and may then not begin at all (a folder it
 * cannot write to, a warning it shows instead). `pending` is the name of a take whose start OBS took and
 * that OBS has not said it began ("" otherwise; `problem` says "start" once OBS, asked after the usual
 * wait, still does not record it; a stop calls it off),
 * `stopping` that a stop was asked and OBS has not yet said it stopped (it is kept through a dropped
 * connection and sent again once OBS is back), `take` the take's name when the recording is a take started here (null for one started in OBS
 * itself), `maybe` the name of a take whose start got no answer, so OBS may be recording it though
 * `recording` cannot say so yet, or may still begin it ("" otherwise; a stop asked for it is held too;
 * its name stays in OBS, and OBS is asked again, until OBS records it, a stop calls it off, the next
 * take starts or the link is turned off or on),
 * `since` when it started (by `now`), `problem` "start" or "stop" when OBS refused the last
 * click, `starting` the take's name while its start is under way ("" otherwise), `calledOff` that a stop
 * was asked while it is (it stops, or is called off, once OBS answers). `began(name)` is told
 * once when OBS may have recorded under a take's name (it took the start, said it started, or never
 * answered), so the page counts it and never uses the name again; `ended(name, recorded)` once when a
 * take started here has stopped (`recorded` false: OBS never said it began that take). Nothing here ever throws into the page or waits on it: scrolling goes on
 * whatever OBS does.
 */
export function obsLink({ WebSocket = globalThis.WebSocket, subtle = globalThis.crypto?.subtle, clock = globalThis, now = () => Date.now(), changed = () => {}, began = () => {}, ended = () => {}, url = OBS_URL, delays = OBS_DELAYS, Channel = globalThis.BroadcastChannel, locks = globalThis.navigator?.locks } = {}) {
  const { setTimeout: later, clearTimeout: cancel } = clock;
  const link = { on: false, state: "off", misses: 0, recording: false, pending: "", stopping: false, take: null, maybe: "", since: 0, problem: "", starting: "", calledOff: false };
  let password = "";
  let sock = null;
  let timer = 0;
  let ids = 0;
  let busy = false;
  let naming = null; // the take whose StartRecord is under way (OBS reads its name as it starts)
  let unsure = null; // a take whose StartRecord got no answer: OBS may be recording it, or begin it yet (the page reads it as `maybe`)
  let unsureWait = 0; // the next look at whether OBS records that take
  let stopAsked = false; // a stop asked while the take was still starting
  let stopAskedAt = 0; // when it was asked
  let counted = null; // the last take told to began()
  let restoreTo = null; // OBS's own file name, to put back once the take has started
  let restoring = null; // that put-back while it is on its way to OBS
  let renaming = null; // a take's name OBS has not answered yet (held until it does, or the connection goes)
  let lastEnded = null; // the take that ended last (a late answer to its start never brings it back)
  let setting = false; // the next take's name is on its way to OBS: no put-back until that take has started
  let startedWait = 0;
  // A stop asked of a recording, held until OBS says it has stopped (also through a dropped connection):
  // { at, done, resolve, asking, taken, maybe, early }. `at` is when it was asked, `asking` says StopRecord is on
  // its way, `taken` that OBS answered it on this connection, `maybe` the take it was asked for when that
  // take's start got no answer (OBS may be recording it), `early` the take it was asked for when OBS had
  // taken that take's start and not yet said it began (the stop goes to OBS only once it has: a stop
  // before that would find nothing running, and the take would go on).
  let stopping = null;
  let stopTimer = 0; // the next look at whether OBS has stopped
  let wake = null; // a start waiting on that stop goes on at once when it is called off
  const waiting = new Map(); // the requests OBS has not answered yet
  let news = 0; // counts what OBS said or took about the recording since the page loaded (see recordStatus)
  let beginning = null; // the take OBS last said it was beginning (its "starting" word), by name
  let turns = 0; // counts turn(): a start begun before the link started over leaves nothing behind
  // Another Prompter tab in this browser (the same profile) may be starting a take, its name in OBS for now: before putting
  // OBS's own name back over a take name it did not set, a tab asks the others (BroadcastChannel; nothing
  // is stored) and leaves the name alone when one answers that a take of its own is under way.
  let peers = null;
  let peerBusy = false;
  function openPeers() {
    if (peers || !Channel) return;
    try { peers = new Channel(`prompter-obs-takes ${url}`); } catch { return; }
    peers.onmessage = ({ data }) => {
      if (data === "busy?" && ours()) peers.postMessage("busy");
      else if (data === "busy") peerBusy = true;
    };
  }
  // Setting a take's name and putting OBS's own name back take turns across the tabs of this browser
  // (Web Locks: nothing stored), so a put-back read just before another tab's take name never lands on
  // it. Each turn ends once OBS answers, or after the usual wait. Without Web Locks (a file:// copy), as before.
  function named(work) {
    if (!locks) return work();
    return new Promise((done, fail) => {
      locks.request(`prompter-obs-name ${url}`, () => {
        const run = Promise.resolve().then(work);
        run.then(done, fail);
        return new Promise((free) => {
          const timer = later(free, delays.wait);
          run.then(() => { cancel(timer); free(); }, () => { cancel(timer); free(); });
        });
      }).catch(fail);
    });
  }
  function closePeers() {
    try { peers?.close(); } catch { /* already closed */ }
    peers = null;
  }
  const set = (patch) => { Object.assign(link, patch); changed(); };

  function turn(on, pass = password) {
    password = String(pass ?? "");
    link.on = on;
    turns++;
    if (on) openPeers(); else closePeers();
    close();
    cancel(timer);
    cancel(startedWait);
    cancel(unsureWait);
    naming = null;
    if (stopping) stopping.early = null; // a stop held for a take not begun yet: the next connect says whether OBS records
    stopAsked = false;
    if (!on) {
      stopEnded(false); // a stop still held is let go: turned off, the link leaves OBS as it is
      unsure = null; // and a take whose start got no answer is given up
      set({ state: "off", misses: 0, recording: false, pending: "", take: null, maybe: "", problem: "" });
      return;
    }
    unsure = null;
    set({ state: "connecting", misses: 0, maybe: "", problem: "" });
    connect();
  }

  /** Try again now (a click on the light while OBS is not there or refused the password). */
  function retry() {
    if (!link.on || link.state === "on") return;
    close();
    cancel(timer);
    set({ state: link.state === "lost" || link.state === "reconnecting" ? link.state : "connecting", misses: Math.min(link.misses, OBS_MISSES - 1) });
    connect();
  }

  function close() {
    if (!sock) return;
    const s = sock;
    sock = null;
    try { s.close(1000); } catch { /* already closing */ }
    dropped();
  }

  // The connection is gone. What was asked stays unanswered (`sent` says OBS may have done it). A stop
  // held is kept: the next connect asks OBS how things are and sends it again if OBS still records.
  // A take waiting on that stop is called off.
  function dropped() {
    for (const p of waiting.values()) { cancel(p.timer); p.fail(Object.assign(new Error("OBS is not connected."), { code: 0, sent: true })); }
    waiting.clear();
    cancel(stopTimer);
    if (stopping) stopping.taken = false;
    wake?.();
  }

  function connect() {
    let s;
    try { s = new WebSocket(url, OBS_PROTOCOL); } catch { miss(); return; }
    sock = s;
    const mine = () => sock === s;
    let identified = false;
    // OBS says hello at once; one that never finishes the handshake counts as a miss.
    const wait = later(() => { if (mine() && !identified) { close(); miss(); } }, delays.wait);
    s.onmessage = async (e) => {
      if (!mine()) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const d = msg?.d || {};
      if (msg.op === OP.hello) {
        const identify = { rpcVersion: 1, eventSubscriptions: OUTPUT_EVENTS };
        if (d.authentication) {
          if (!password) { cancel(wait); close(); set({ state: "password", misses: 0 }); return; }
          try { identify.authentication = await obsAuth(password, d.authentication, subtle); } catch { cancel(wait); close(); miss(); return; }
          if (!mine()) return;
        }
        s.send(JSON.stringify({ op: OP.identify, d: identify }));
      } else if (msg.op === OP.identified) {
        identified = true;
        cancel(wait);
        set({ state: "on", misses: 0 });
        afterConnect().then(tidyName);
      } else if (msg.op === OP.response) {
        const p = waiting.get(d.requestId);
        if (!p) return;
        waiting.delete(d.requestId);
        cancel(p.timer);
        if (d.requestStatus?.result) p.done(d.responseData || {});
        else p.fail(Object.assign(new Error(d.requestStatus?.comment || "OBS refused."), { code: d.requestStatus?.code ?? 0, refused: true }));
      } else if (msg.op === OP.event && d.eventType === "RecordStateChanged") {
        recordChanged(d.eventData || {});
      }
    };
    s.onclose = (e) => {
      if (!mine()) return;
      cancel(wait);
      sock = null;
      dropped();
      if (e.code === OBS_AUTH_FAILED) { set({ state: "wrong", misses: 0 }); return; }
      miss();
    };
    s.onerror = () => { /* a close follows */ };
  }

  function miss() {
    if (!link.on) return;
    const next = obsAfterMiss(link.state === "on" ? "on" : link.state, link.misses);
    set({ state: next.state, misses: next.misses });
    cancel(timer);
    timer = later(() => { if (link.on && !sock) connect(); }, next.retry >= 0 ? delays.retry[next.retry] : delays.again);
  }

  // `hold`: no time limit; the request waits for OBS's answer, or for the connection to go.
  function request(requestType, requestData, hold = false) {
    return new Promise((done, fail) => {
      if (!sock || link.state !== "on") { fail(Object.assign(new Error("OBS is not connected."), { code: 0 })); return; }
      const requestId = String(++ids);
      const timer = hold ? null : later(() => { waiting.delete(requestId); fail(Object.assign(new Error("OBS did not answer."), { code: 0, sent: true })); }, delays.wait);
      waiting.set(requestId, { done, fail, timer });
      try { sock.send(JSON.stringify({ op: OP.request, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } })); } catch (error) { waiting.delete(requestId); cancel(timer); fail(error); }
    });
  }

  // Whether OBS records now. OBS handles requests side by side, so an answer may have been made before
  // something OBS said or took since (a recording that began, a stop it took) and arrive after it: such
  // an old answer is thrown away and OBS is asked again, so it never undoes the newer word.
  async function recordStatus() {
    for (;;) {
      const at = news;
      const status = await request("GetRecordStatus");
      if (at === news) return status;
    }
  }

  // Back on: whether OBS records now. A take that stopped while the connection was down counts now,
  // and a stop held goes to OBS again if OBS still records that take. A take OBS has not begun yet
  // (it took the start, or never answered it) keeps waiting, its name still in OBS: OBS reads the name
  // only as the recording begins, so putting OBS's own back now would lose the take's file name.
  // `still`: the take whose start got no answer, when this is the later look at whether OBS records it.
  async function afterConnect(still = null) {
    let status;
    try { status = await recordStatus(); } catch {
      // No answer on a connection still up: asked again after the usual wait (a dropped one asks once it is back).
      if (sock && link.state === "on") {
        if (stopping && !stopping.early) watchStop();
        else if (naming) watchStart(naming);
        else if (unsure) watchUnsure(unsure);
      }
      return;
    }
    if (still && unsure !== still) return; // settled meanwhile
    const from = now() - (Number(status.outputDuration) || 0); // when OBS's recording began
    if (stopping) {
      // A recording begun after the stop was asked is another one (OBS was started again and the person
      // records in OBS itself): the take has ended, and that recording is left alone. The same for a
      // take OBS had not begun when its stop was asked (`early`); one OBS never began is called off.
      if (!status.outputActive || from > stopping.at + delays.newer) stopEnded(true);
      else if (stopping.early) { naming = null; cancel(startedWait); stopBegun(false); }
      else sendStop();
    }
    if (link.starting) return; // a take begun since: its own answers tell
    // OBS does not record yet, and no stop was asked: the take may still begin (a start is answered
    // before the recording begins, and one not answered may only be late). It keeps its name in OBS and
    // OBS is asked again; a stop asked meanwhile calls it off below, as before.
    if (!status.outputActive && !stopAsked) {
      if (naming) { watchStart(naming); return; }
      if (unsure) { watchUnsure(unsure); return; }
    }
    naming = null;
    cancel(startedWait);
    cancel(unsureWait);
    const maybe = unsure;
    unsure = null;
    link.maybe = "";
    if (status.outputActive) {
      // A take whose start got no answer, and OBS records now: that is the take. Not when a stop was
      // asked for it and OBS's recording began after that: it is another one, and is left alone.
      // A take OBS took and had not begun when the connection went (`pending`) is the one it records now.
      const took = link.pending || null;
      const other = !link.take && !took && maybe && stopAsked && from > stopAskedAt + delays.newer;
      if (other) stopAsked = false;
      const take = link.take ?? took ?? (other ? null : maybe);
      set({ recording: true, pending: "", take, since: link.recording ? link.since : from, ...(take && (take === maybe || take === took) ? { problem: "" } : {}) });
    } else {
      stopAsked = false;
      finish();
      set({ recording: false, pending: "" });
    }
    putBack();
    stopIfAsked();
  }

  function recordChanged({ outputActive, outputState }) {
    news++;
    if (outputState === "OBS_WEBSOCKET_OUTPUT_STARTED" || (outputActive && outputState !== "OBS_WEBSOCKET_OUTPUT_STOPPING")) {
      if (!link.recording) {
        // OBS says it records: only now is the take recording. A take OBS took and had not begun
        // (`pending`), or one whose start got no answer, and OBS says it started now: that is the take.
        const took = link.pending || null;
        const take = naming ?? link.take ?? took ?? unsure;
        const found = take && take === unsure;
        if (found) unsure = null;
        set({ recording: true, pending: "", take, since: now(), ...(found ? { maybe: "" } : {}), ...(found || (take && take === took) ? { problem: "" } : {}) });
      }
      count(naming);
      naming = null;
      cancel(startedWait);
      putBack();
      stopIfAsked();
      stopBegun(true);
    } else if (outputState === "OBS_WEBSOCKET_OUTPUT_STARTING") {
      beginning = naming ?? (link.pending || null); // OBS is beginning this take (it may still give it up)
    } else if (outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") {
      // A take OBS took, said it was beginning, and gave up before it ever recorded (it could not write
      // the file, say), with no stop asked here: OBS did not start recording, and the light says so. A
      // stopped word with no beginning before it is a late one about an older recording: the take waits on.
      const waits = !link.starting && !link.recording && link.pending && !stopping && !stopAsked;
      // The same for the take starting now, before OBS's answer to its start came: that late answer finds it over.
      const gaveUp = link.starting && naming && beginning === naming && !link.recording && !stopping;
      const never = (waits && beginning === link.pending) || gaveUp;
      if (waits && !never) return;
      if (gaveUp) { link.pending = naming; naming = null; }
      // A late word about the take before must not undo a stop asked for the one starting now.
      if (!link.starting) { naming = null; stopAsked = false; }
      cancel(startedWait);
      stopEnded(true);
      if (never && link.on) set({ problem: "start" });
      if (!link.starting) putBack(); // a take starting now puts OBS's own format back once it has started
    }
  }

  // OBS has stopped recording (the take ends, a stop held is over), or a stop held is let go
  // (`stopped` false: OBS refused it, or the link was turned off).
  function stopEnded(stopped) {
    cancel(stopTimer);
    const held = stopping;
    stopping = null;
    // A stop held for a take OBS took and never began: that take no longer waits for OBS to begin.
    if (held?.early && naming === held.early) { naming = null; cancel(startedWait); }
    // A stop held for a take whose start got no answer: that take is the one over now. It was recorded only
    // when OBS took the stop (it recorded then); when OBS said it does not record, it is called off.
    if (stopped && held?.maybe && !link.take && unsure === held.maybe) {
      if (held.taken) link.take = unsure;
      else link.pending = unsure;
      unsure = null;
      link.maybe = "";
    }
    if (stopped) finish();
    set(stopped ? { recording: false, pending: "", stopping: false } : { stopping: false });
    // OBS's own file name goes back now: a take called off before OBS began it still had its name there.
    // Not while the next take is starting: that one puts it back once it has started.
    if (stopped && !link.starting) putBack();
    held?.resolve();
  }

  // The stop held goes to OBS: when it is asked, again once OBS is back after a drop, and again when
  // OBS still records without having answered it. True unless OBS refused it.
  async function sendStop() {
    const held = stopping;
    if (!held || held.asking || held.early || !sock || link.state !== "on") return true; // kept until OBS is back, or has begun the take
    held.asking = true;
    let refused = null;
    try {
      await request("StopRecord");
      news++;
      held.taken = true;
    } catch (error) {
      if (error.refused) refused = error; // no answer (a drop, or OBS busy) keeps the stop
    }
    held.asking = false;
    if (stopping !== held) return true; // OBS said it stopped meanwhile
    if (refused) {
      // 501 is obs-websocket's "output not running": it had stopped already.
      const gone = refused.code === 501;
      stopEnded(gone);
      if (!gone && link.on) set({ problem: "stop" });
      return gone;
    }
    if (sock && link.state === "on") watchStop();
    return true;
  }

  // OBS answers StopRecord before the recording has finished. No word that it stopped within the usual
  // wait: OBS is asked, and asked again, and the take ends only once OBS no longer records.
  function watchStop() {
    cancel(stopTimer);
    stopTimer = later(async () => {
      const held = stopping;
      if (!held || held.asking) return;
      let status = null;
      try { status = await recordStatus(); } catch { /* slow to answer: asked again below */ }
      if (stopping !== held) return;
      if (status && !status.outputActive) { stopEnded(true); return; }
      if (!sock || link.state !== "on") return; // dropped: the next connect asks
      if (status && !held.taken) sendStop(); // OBS records and never took the stop
      else watchStop();
    }, delays.wait);
  }

  // OBS may have recorded under this take's name: the page counts it, once.
  function count(name) {
    if (!name || counted === name) return;
    counted = name;
    try { began(name); } catch { /* the page's trouble, not the link's */ }
  }

  // A stop asked while the take was starting is held as soon as OBS has taken the start (from when it
  // was asked, if OBS has not begun the take yet), and goes to OBS once OBS has said it started.
  function stopIfAsked() {
    if (!stopAsked || link.starting || !(link.recording || link.pending)) return;
    stop(); // holds it, from when it was asked
    stopAsked = false;
  }

  // OBS records the take a stop was held for before it began: the stop goes to OBS now. `seen`: OBS
  // said so on this connection, so it is that take, and a later look (after a drop) must not take it
  // for another recording because it began long after the stop was asked.
  function stopBegun(seen) {
    const held = stopping;
    if (!held?.early) return;
    held.early = null;
    if (seen) held.at = now();
    sendStop();
  }

  // A take started here has stopped, or one OBS took and never began is over: told once. `recorded`
  // says whether OBS ever said it recorded that take.
  function finish() {
    const name = link.take || link.pending;
    if (!name) return;
    const recorded = Boolean(link.take);
    link.take = null;
    link.pending = "";
    lastEnded = name;
    try { ended(name, recorded); } catch { /* the page's trouble, not the link's */ }
  }

  // OBS answers StartRecord before the recording has begun, and reads the take's name only as it begins.
  // No word that it started within the usual wait: OBS is asked, and asked again. Only when OBS says it
  // records is the take recording (from when OBS began it); while it says it does not, the take is still
  // pending and `problem` says OBS did not start. Its own name goes back once OBS records, or once a
  // stop was asked for a take that never began (that take is called off).
  function watchStart(name) {
    cancel(startedWait);
    startedWait = later(async () => {
      if (naming !== name) return;
      let status = null;
      try { status = await recordStatus(); } catch { /* slow to answer: asked again below */ }
      if (naming !== name) return;
      if (status?.outputActive) {
        naming = null;
        if (!link.recording) set({ recording: true, pending: "", take: name, since: now() - (Number(status.outputDuration) || 0), problem: "" });
        putBack();
        stopIfAsked();
        stopBegun(true);
        return;
      }
      if (status && (stopAsked || stopping?.early === name)) {
        naming = null;
        stopAsked = false;
        stopEnded(true);
        putBack();
        return;
      }
      if (status && link.pending === name && link.problem !== "start") set({ problem: "start" });
      if (sock && link.state === "on") watchStart(name); // dropped: the next connect asks
    }, delays.wait);
  }

  // A take whose start got no answer may still begin (OBS answered late, or was busy): its name stays in
  // OBS, and OBS is asked again after the usual wait until it records, a stop calls the take off, the
  // next take starts or the link is turned off.
  function watchUnsure(name) {
    cancel(unsureWait);
    unsureWait = later(() => {
      if (unsure !== name || !sock || link.state !== "on") return; // dropped: the next connect asks
      if (link.starting) watchUnsure(name); // the next take is on its way: it gives this one up, or fails
      else afterConnect(name);
    }, delays.wait);
  }

  // A tab closed while a take waited for OBS to begin it (or before OBS answered its start) left that
  // take's name in OBS, and OBS's own recordings would land in that scene's folder. Once connected with
  // nothing of ours waiting, OBS's default format goes back (its own one was only known to that tab).
  const ours = () => restoreTo !== null || renaming || naming || unsure || setting || stopping || link.starting || link.pending || link.take;
  async function tidyName() {
    if (ours() || !sock || link.state !== "on") return;
    let got;
    try { got = await request("GetProfileParameter", FILENAME); } catch { return; }
    if (ours() || !isTakeName(got.parameterValue)) return;
    const asked = sock;
    if (peers) {
      peerBusy = false;
      peers.postMessage("busy?");
      await new Promise((done) => { later(done, delays.peers); });
      if (peerBusy || ours() || sock !== asked || link.state !== "on") return; // another tab's take, ours, or another connection
    }
    // A tab idle when asked may have set its own take's name since: in one turn, read the name again and
    // put back only the very name read before.
    await named(async () => {
      let now;
      try { now = await request("GetProfileParameter", FILENAME); } catch { return; }
      if (now.parameterValue !== got.parameterValue || ours() || sock !== asked || link.state !== "on") return;
      restoreTo = got.defaultParameterValue && !isTakeName(got.defaultParameterValue) ? got.defaultParameterValue : OBS_FORMAT;
      await putBack();
    }).catch(() => {});
  }

  // A take's name goes to OBS. OBS handles requests side by side, so one it is slow with may still land
  // after a later one: it is held until OBS answers (or the connection goes), and the put-back and the
  // next take's name wait for it. The start itself gives up after the usual wait.
  function rename(value) {
    const sent = request("SetProfileParameter", { ...FILENAME, parameterValue: value }, true);
    const mark = sent.then(() => {}, () => {}).then(() => { if (renaming === mark) renaming = null; });
    renaming = mark;
    return new Promise((done, fail) => {
      const timer = later(() => fail(Object.assign(new Error("OBS did not answer."), { code: 0, sent: true })), delays.wait);
      sent.then((value) => { cancel(timer); done(value); }, (error) => { cancel(timer); fail(error); });
    });
  }

  // OBS's own file name goes back once the take has started (OBS has read the take's name by then).
  // One put-back at a time, none while a take OBS has not begun yet still needs its name there, and
  // none while the next take's name is on its way: OBS handles requests side by side, so a put-back
  // still under way could land after that name. So it is held until OBS answers it (or the connection
  // goes): one OBS is slow to answer may still do it, and a next take's name waits for it.
  function putBack() {
    if (restoreTo === null || naming || unsure || setting) return Promise.resolve();
    restoring ??= (async () => {
      if (renaming) await renaming; // a take's name OBS is slow with lands first
      const value = restoreTo;
      try {
        await request("SetProfileParameter", { ...FILENAME, parameterValue: value }, true);
        if (restoreTo === value) restoreTo = null;
      } catch { /* tried again at the next connect or take */ }
      restoring = null;
    })();
    return restoring;
  }

  /**
   * Start a take recorded under `name` (from takeName). Resolves true once OBS took it (or said it
   * started). A stop asked meanwhile calls it off, or stops it once OBS says it started.
   */
  async function start(name) {
    // While the take before is stopping, the next one may be asked for: it waits for that stop.
    if (link.state !== "on" || ((link.recording || link.pending) && !stopping) || busy) return false;
    busy = true;
    stopAsked = false;
    lastEnded = null;
    const turn0 = turns;
    set({ problem: "", starting: name, calledOff: false });
    let ok = false;
    let asked = false;
    try {
      // OBS refuses a start until the take before has really stopped, and that stop's put-back of OBS's
      // own format goes first: wait for it, then read the format.
      if (stopping) {
        const stopped = stopping.done;
        await new Promise((resolve) => { wake = resolve; stopped.then(resolve); });
        wake = null;
      }
      if (stopAsked) throw new Error("Called off.");
      // The stop did not get through (the connection dropped, or OBS refused it): no take on top of it.
      if (link.recording || link.pending) throw new Error("OBS still records.");
      // A take before whose start got no answer is given up for this one: its name in OBS is replaced now.
      if (unsure) { unsure = null; link.maybe = ""; cancel(unsureWait); }
      // No put-back from here until this take has started, and one still on its way to OBS lands first.
      // A stop (R again) calls the take off while it waits.
      setting = true;
      if (restoring || renaming) {
        const put = Promise.all([restoring, renaming]);
        await new Promise((resolve) => { wake = resolve; put.then(resolve); });
        wake = null;
      }
      if (stopAsked) throw new Error("Called off.");
      const got = await request("GetProfileParameter", FILENAME);
      if (restoreTo === null) {
        const own = got.parameterValue;
        restoreTo = own && !isTakeName(own) ? own : (got.defaultParameterValue && !isTakeName(got.defaultParameterValue) ? got.defaultParameterValue : OBS_FORMAT);
      }
      if (stopAsked) throw new Error("Called off.");
      await named(() => rename(name)); // in its turn: never between another tab's look at the name and its put-back
      if (stopAsked) throw new Error("Called off.");
      naming = name;
      setting = false;
      asked = true;
      await request("StartRecord");
      news++;
      count(name);
      // OBS began that take and stopped it again before its answer came (OBS handles requests side by
      // side): the take is over, and the late answer never brings it back.
      if (lastEnded === name) {
        stopAsked = false; // nothing left to stop
        putBack();
      } else {
        // OBS took the start. That is not yet a recording: OBS answers before the recording begins, and
        // may not begin it at all. The take is pending until OBS says it records (recordChanged, or its
        // answer when asked after the usual wait); only then does the link say recording.
        if (!link.recording) set({ pending: name });
        else if (!link.take) set({ take: name });
        // OBS reads the name as the recording begins, which may be after its answer: its own goes back
        // once OBS says it started (recordChanged), or says it records when asked after the usual wait.
        cancel(startedWait);
        if (naming === name) watchStart(name);
      }
      ok = true;
    } catch (error) {
      setting = false;
      if (naming === name) naming = null;
      // OBS said it started before its answer was lost, or began and stopped it already (it stays over).
      if (link.take === name || lastEnded === name) { ok = true; if (lastEnded === name) { stopAsked = false; putBack(); } }
      else {
        // Asked to record and never answered: OBS may be recording under this name, or begin yet, so it
        // is used, and it stays in OBS (no put-back) until OBS records or the take is called off.
        // Not when the link started over meanwhile (a new password, off and on): that gives the take up.
        if (asked && error.sent) { count(name); if (turns === turn0) { unsure = name; link.maybe = name; } }
        putBack(); // not waited for (no time limit); a put-back under way is waited for by the next take, and R calls that off
        if (link.on && !stopAsked && turns === turn0) set({ problem: "start" });
        // A stop asked for a take OBS may be recording holds until the next connect says how OBS is.
        if (unsure !== name) stopAsked = false;
      }
    } finally {
      busy = false;
      set({ starting: "", calledOff: false });
    }
    // Not answered on a connection still up: ask OBS now whether it records that take, and again while
    // it does not (a dropped connection asks once it is back).
    if (!ok && unsure === name && sock && link.state === "on") afterConnect();
    stopIfAsked();
    return ok;
  }

  /**
   * Stop the recording. The stop is held (`stopping`) from this moment until OBS says it has stopped:
   * OBS answers StopRecord before the recording has finished, and a connection that drops meanwhile,
   * or was down when the stop was asked, must not lose it. The take ends (and `ended` hears of it)
   * only once OBS no longer records. False when there is nothing to stop, or OBS refused.
   */
  async function stop() {
    if (link.starting) { // called off, or held once OBS has taken the start
      if (!stopAsked) stopAskedAt = now();
      stopAsked = true;
      if (!link.calledOff) set({ calledOff: true });
      wake?.();
      return true;
    }
    if (stopping) return true;
    // A take whose start got no answer: OBS may be recording it, so its stop is held like any other
    // (from when it was first asked) until OBS says how things are.
    const maybe = !link.recording && !link.pending && unsure ? unsure : null;
    if (!link.on || (!link.recording && !link.pending && !maybe)) return false;
    // With OBS out of reach only a take of ours is stopped (once OBS is back, if it still records it):
    // whether OBS still records its own recording is not known.
    if (link.state !== "on" && !link.take && !link.pending && !maybe) return false;
    // A take OBS took and has not said it began (`early`): its stop is held too, from when it was first
    // asked, so a recording OBS begins long after that (in OBS itself, after a drop) is never taken for it.
    const early = naming;
    const held = { at: (maybe || early) && stopAsked ? stopAskedAt : now(), asking: false, taken: false, maybe, early };
    stopAsked = false;
    held.done = new Promise((resolve) => { held.resolve = resolve; });
    stopping = held;
    set({ stopping: true, problem: "" });
    return sendStop();
  }

  /** Resolves once a stop held is over (at once when nothing is stopping). */
  const whenStopped = () => stopping?.done ?? Promise.resolve();

  return Object.assign(link, { turn, retry, start, stop, whenStopped });
}
