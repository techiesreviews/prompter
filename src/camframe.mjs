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
 * Ask CamFrame: `camframeCall("status")` for { app, version, scenes, … },
 * `camframeCall("cue", { size, position?, scene? })`, or (API 2)
 * `camframeCall("scenes", layout)` to save a camera layout. Resolves to
 * { ok, body } (ok false when CamFrame refused, with body.error and body.code);
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

// ---- Camera layouts ----
// Two layout Scenes the page saves in CamFrame (API 2) for Lex's livestream
// cue lines: `[Face: Live right large]` on branded pages with the content on
// the left, `[Face: Live small corner]` (the same as `[Face small, bottom
// right]`) on plugin and advisory screens. A layout Scene changes only the
// camera's size and place, never the camera, shape, style or crop. The page
// saves what is missing when CamFrame connects, unless that would leave no
// spare slot (then it waits); it never replaces a Scene
// (it leaves one of Lex's own with a layout's name alone), never moves the camera while saving and never changes
// CamFrame's small size.

export const LAYOUT_SMALL = "Live small corner";
export const LAYOUT_LARGE = "Live right large";
/** CamFrame's standard small size, used only when the status gives none. */
export const LAYOUT_SMALL_SIZE = 288;
/** The large layout stays inside this share of the display's right side. */
export const LAYOUT_WITHIN_RIGHT = 0.3;

/**
 * A CamFrame that can save layout Scenes: API 2 or later, with its Scene
 * list in full (a file:// copy gets only app, version, scenes and api, and
 * CamFrame refuses its saves).
 */
export function layoutsSupported(status) {
  return Boolean(status) && Number(status.api) >= 2 && Array.isArray(status.scenes) && Array.isArray(status.sceneDetails) && Number.isFinite(status.sceneLimit);
}

/**
 * The two layouts as `POST /camframe/scenes` bodies, for this small size: the
 * small corner follows CamFrame's small size; the large one is 1.5 times it
 * (180–640 px, CamFrame's camera sizes), on the right, vertically centred.
 */
export function layoutWants(smallSize) {
  const small = Number.isFinite(smallSize) && smallSize > 0 ? smallSize : LAYOUT_SMALL_SIZE;
  const large = Math.min(640, Math.max(180, Math.round(small * 1.5)));
  return [
    { name: LAYOUT_SMALL, size: "small", position: "bottom-right" },
    { name: LAYOUT_LARGE, size: large, position: "right", withinRight: LAYOUT_WITHIN_RIGHT },
  ];
}

/** Does `detail` (one of the status's sceneDetails) already hold the layout `want`? */
export function layoutMatches(detail, want) {
  if (!detail || detail.kind !== "layout" || detail.position !== want.position) return false;
  if ((detail.withinRight ?? null) !== (want.withinRight ?? null)) return false;
  return want.size === "small" ? detail.followsSmallSize === true : detail.followsSmallSize !== true && detail.size === want.size;
}

// Not toLocaleLowerCase: a Turkish locale would turn "LIVE" into "lıve" and miss the match.
/**
 * `detail` is this layout, saved at another size: the same place and kind, so
 * the small size changed since (resizing CamFrame by hand does that). It is
 * still saved and still works; the page leaves it at that size.
 */
export function layoutResized(detail, want) {
  return Number.isFinite(want.size) && Number.isFinite(detail?.size) && detail.size !== want.size && layoutMatches({ ...detail, size: want.size }, want);
}

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * From CamFrame's status: each layout's row (`ready`, `missing`, `resized`
 * with the size it was `saved` at, or `different` for a Scene with its name
 * that holds something else), the
 * missing ones to save (small first), and the room: CamFrame keeps at most
 * `sceneLimit` Scenes, shared with Lex's own, so both missing ones must fit
 * before anything is saved. `save` is every missing one that fits, `auto`
 * what goes by itself: nothing when it would fill CamFrame (`tight`), because
 * the next Scene saved by hand there drops its oldest, maybe one of Lex's.
 */
export function layoutPlan(status) {
  const smallSize = Number.isFinite(status.smallSize) && status.smallSize > 0 ? status.smallSize : LAYOUT_SMALL_SIZE;
  const wants = layoutWants(smallSize);
  const names = status.scenes || [];
  const details = status.sceneDetails || [];
  const rows = wants.map((scene) => {
    if (!names.some((n) => sameName(n, scene.name))) return { name: scene.name, state: "missing", scene };
    const detail = details.find((d) => sameName(d.name, scene.name));
    if (layoutMatches(detail, scene)) return { name: scene.name, state: "ready", scene };
    return layoutResized(detail, scene) ? { name: scene.name, state: "resized", saved: detail.size, scene } : { name: scene.name, state: "different", scene };
  });
  const missing = rows.filter((r) => r.state === "missing").map((r) => r.scene);
  const has = names.length;
  const limit = status.sceneLimit;
  const ok = !missing.length || has + missing.length <= limit;
  const tight = ok && missing.length > 0 && has + missing.length >= limit;
  return {
    smallSize,
    largeSize: wants[1].size,
    rows,
    save: ok ? missing : [],
    auto: ok && !tight ? missing : [],
    tight,
    room: { has, limit, need: missing.length, ok, free: Math.max(0, limit - has) },
    done: rows.every((r) => r.state === "ready" || r.state === "resized"),
  };
}

/** A refused save (`{ ok: false, body }`) or a missed one (null) in plain words. */
export function layoutProblem(answer) {
  if (!answer) return "CamFrame did not answer while saving the layouts. Turn the camera button in Settings off and on to try again.";
  const code = answer.body?.code;
  if (code === "scene-limit") return "CamFrame has no room for another Scene. Delete Scenes you do not use in CamFrame until one slot stays free, then turn the camera button in Settings off and on.";
  if (code === "scene-exists") return "CamFrame already has a Scene with this name.";
  if (code === "not-ready") return "CamFrame's window was not open when the layouts were saved. Open it, then turn the camera button in Settings off and on.";
  const said = typeof answer.body?.error === "string" ? answer.body.error.trim().slice(0, 200).replace(/[.!?\s]+$/, "") : "";
  const why = said || "no reason given";
  return `CamFrame refused: ${why}. Turn the camera button in Settings off and on to try again.`;
}

/** Not enough room for the missing layouts, in plain words ("" when there is room). */
export function layoutRoomWords(room) {
  if (room.ok) return "";
  const scenes = (n) => `${n} Scene${n === 1 ? "" : "s"}`;
  const over = room.has + room.need - room.limit + 1; // one slot stays free: saving never fills CamFrame
  return `No room to save the layouts: CamFrame keeps at most ${scenes(room.limit)} and has ${room.has}, and ${room.need} more ${room.need === 1 ? "is" : "are"} needed, with one slot left free. Delete ${scenes(over)} you do not use in CamFrame, then turn the camera button in Settings off and on.`;
}

/**
 * The one line under the Camera cues list: where the two layouts stand in CamFrame, true for the status
 * just read ("" for nothing to say). `saving` while the page saves them, `problem` a refused or lost save.
 * Nothing here asks for a window: the page saves the missing layouts by itself when CamFrame connects, never
 * replaces a Scene of Lex's own and never fills CamFrame's last spare slot.
 */
export function layoutsLine(plan, { saving = false, problem = "" } = {}) {
  if (!plan) return "";
  if (saving) return "Saving the camera layouts in CamFrame…";
  const missing = plan.rows.filter((r) => r.state === "missing").map((r) => r.name);
  const different = plan.rows.filter((r) => r.state === "different").map((r) => r.name);
  const parts = [];
  if (missing.length && !problem) { // a refusal or lost answer already says what is missing and how to retry
    if (!plan.room.ok) parts.push(layoutRoomWords(plan.room));
    else if (plan.tight) parts.push(`Not saved: ${missing.join(" and ")}. Saving would fill CamFrame (${plan.room.has + plan.room.need} of ${plan.room.limit} Scenes) and leave no spare slot, so the Prompter waits. Delete a Scene you do not use in CamFrame, then turn the camera button in Settings off and on.`);
    else parts.push(`Not saved in CamFrame: ${missing.join(" and ")}. Turn the camera button in Settings off and on to save ${missing.length === 1 ? "it" : "them"}.`);
  }
  if (problem) parts.unshift(problem);
  if (different.length) parts.push(`CamFrame already has ${different.length === 1 ? "a different Scene" : "different Scenes"} named ${different.join(" and ")}; the Prompter leaves ${different.length === 1 ? "it" : "them"} alone, so the cue uses what CamFrame holds.`);
  if (!problem && !missing.length && !different.length) {
    const older = plan.rows.filter((r) => r.state === "resized").map((r) => ` ${r.name} is saved at ${r.saved} px.`);
    parts.push(`Camera layouts are saved in CamFrame's Scenes: ${plan.rows.map((r) => r.name).join(" and ")}.${older.join("")}`);
  }
  return parts.join(" ");
}

/**
 * A copy of `status` with the Scenes CamFrame just said yes to (each answer's
 * `scene`), added or replaced in place: what the rows show when the status
 * read after a save missed.
 */
export function layoutsWithSaved(status, scenes) {
  const names = [...status.scenes];
  const details = [...status.sceneDetails];
  for (const scene of scenes) {
    const at = names.findIndex((n) => sameName(n, scene.name));
    if (at >= 0) names[at] = scene.name; else names.push(scene.name);
    const inDetails = details.findIndex((d) => sameName(d.name, scene.name));
    if (inDetails >= 0) details[inDetails] = scene; else details.push(scene);
  }
  return { ...status, scenes: names, sceneDetails: details };
}

// ---- Camera preview (the demo) ----
// The demo shows a small stand-in for CamFrame's output that follows the camera cues as the reading line
// passes them. It is a simulation drawn by the page (no call to CamFrame, no new protocol): the real CamFrame
// gets the cues through the usual link when that is on. The geometry is approximate: a small camera is
// 288 px of a 1920 px display, the large layout 1.5 times that, centred in the right 30%.

/** Where the camera is after `cue`, given where it was (`before`): { mode: full | small | large | scene, at, label }. */
export function previewStep(before, cue) {
  const at = (cue.position || (before.mode === "full" ? "bottom-right" : before.at) || "bottom-right");
  if (typeof cue.scene === "string") {
    if (sameName(cue.scene, LAYOUT_LARGE)) return { mode: "large", at: "right", label: LAYOUT_LARGE };
    if (sameName(cue.scene, LAYOUT_SMALL)) return { mode: "small", at: "bottom-right", label: LAYOUT_SMALL };
    return { mode: "scene", at: before.at || "bottom-right", label: cue.scene };
  }
  if (cue.size === "full") return { mode: "full", at: before.at || "bottom-right", label: "" };
  return { mode: "small", at, label: "" };
}

/** The camera after the cues up to and including index `last` (-1: none yet, the camera is full). */
export function previewState(cues, last) {
  let state = { mode: "full", at: "bottom-right", label: "" };
  for (let i = 0; i <= last && i < cues.length; i++) state = previewStep(state, cues[i]);
  return state;
}

/** The camera's box in the preview, as percent of the 16:9 frame: { left, top, width, height }. */
export function previewBox(state) {
  if (state.mode === "full") return { left: 0, top: 0, width: 100, height: 100 };
  const width = state.mode === "large" ? 22.5 : 15;
  const height = width * 16 / 9; // a square camera in a 16:9 frame
  const x = { left: 2, right: 100 - 2 - width, center: (100 - width) / 2 };
  const y = { top: 3.5, bottom: 100 - 3.5 - height, middle: (100 - height) / 2 };
  const [a, b] = state.at.split("-");
  let left = x.center, top = y.middle;
  if (state.mode === "large") left = 85 - width / 2; // centred in the right 30%
  else if (a === "left" || b === "left") left = x.left;
  else if (a === "right" || b === "right") left = x.right;
  if (a === "top") top = y.top;
  else if (a === "bottom") top = y.bottom;
  return { left, top, width, height };
}

/** The preview's caption in plain words. */
export function previewWords(state) {
  const place = state.at.replace("-", " ");
  if (state.mode === "full") return "Camera: full screen";
  if (state.mode === "large") return `Camera: large, ${place} (Live right large)`;
  if (state.mode === "scene") return `Camera: Scene ${state.label}`;
  return `Camera: small, ${place}${state.label ? ` (${state.label})` : ""}`;
}
