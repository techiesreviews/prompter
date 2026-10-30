// CamFrame link: tells CamFrame (the camera window app on this computer) to
// switch its view when a camera cue line ([Face full], [Face small, bottom
// right], [Face: Demo]; parsed by faceCue in core.mjs) reaches the reading
// line. Off until the user turns it on in Settings; then the page calls only
// CamFrame's own address on this computer, never a server, and sends only the
// cue, never the script. Inlined into the page by scripts/build.mjs, so keep
// it import-free and use only `export function`/`export const` forms.

export const CAMFRAME_ORIGIN = "http://127.0.0.1:47833";
export const CAMFRAME_WAIT_MS = 3000; // Edge's calls to this computer are sometimes slow
/** Status checks missed in a row before CamFrame counts as not found. */
export const CAMFRAME_MISSES = 3;
/** The wait before checking again after the first and the second miss in a row. */
export const CAMFRAME_RETRY_MS = [1000, 2000];
/** The wait before a cue that did not get through is sent once more. */
export const CUE_RETRY_MS = 400;

/**
 * Ask CamFrame: `camframeCall("status")` for { app, version, scenes }, or
 * `camframeCall("cue", { size, position?, scene? })`. Resolves to
 * { ok, body } (ok false when CamFrame refused the cue, with body.error);
 * rejects when CamFrame is not there, is turned off or the browser blocked it.
 */
export async function camframeCall(path, cue) {
  const init = cue
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cue) }
    : { method: "GET" };
  const res = await fetch(`${CAMFRAME_ORIGIN}/camframe/${path}`, { ...init, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(CAMFRAME_WAIT_MS) });
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object") throw new Error("Not CamFrame.");
  if (!cue && body.app !== "camframe") throw new Error("Not CamFrame.");
  return { ok: res.ok, body };
}

/**
 * Cue lines against the reading line. `before` holds the cue numbers that
 * were above the reading line, `now` the ones above it now (cue numbers rise
 * down the script). Returns the new set and the cue to send: of the cues that
 * just crossed the line, the lowest one in the script (a jump past several
 * cues sends only the last), or -1. A cue scrolled back below the line
 * re-arms, so each pass down sends it once.
 */
export function cueCrossing(before, now) {
  let send = -1;
  for (const k of now) if (!before.has(k) && k > send) send = k;
  return { above: new Set(now), send };
}

/** A cue in plain words: "face full", "face small, bottom right" or "Scene “Demo”". */
export function cueWords(cue) {
  if (cue.scene) return `Scene “${cue.scene}”`;
  return cue.position ? `face small, ${cue.position.replace(/-/g, " ")}` : `face ${cue.size}`;
}

/** A cue line's other words, without its Face sentence: "Share screen. Face small." → "Share screen." */
export function cueRest(note) {
  return (String(note ?? "").match(/[^.;!?]+[.;!?]*/g) || [])
    .filter((s) => !/^\s*face\b/i.test(s)).join("").trim();
}

/**
 * After a status check (or a cue that did not get through twice): the link's
 * next state, the misses in a row and how soon to check again (ms; -1 for the
 * usual interval). One miss is not "not found": calls to this computer fail
 * now and then (in Edge especially), so a link that was on says
 * `reconnecting` and one still `looking` keeps looking, while it checks again
 * soon; only CAMFRAME_MISSES in a row make it `lost`. An answer is `on`.
 */
export function camframeAfterCheck(state, misses, answered) {
  if (answered) return { state: "on", misses: 0, retry: -1 };
  const n = misses + 1;
  if (n >= CAMFRAME_MISSES) return { state: "lost", misses: n, retry: -1 };
  return { state: state === "looking" ? "looking" : "reconnecting", misses: n, retry: CAMFRAME_RETRY_MS[n - 1] };
}
