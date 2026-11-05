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
// spare slot (then only after Save in its window); it never replaces a Scene
// without a yes, never moves the camera while saving and never changes
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
 * still saved and still works; only Replace brings it to today's size.
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
 * before anything is saved. `save` is what a deliberate Save sends, `auto`
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

/** A save that CamFrame's status does not show, whatever it answered: a layout is really missing. */
export const LAYOUT_NOT_KEPT = "A layout is still not saved in CamFrame. Press Save if it shows; otherwise open Camera layouts again to try once more.";
/** The same for a Replace whose row still offers it: what CamFrame shows is the old Scene, and opening the window would not try again. */
export const LAYOUT_REPLACE_NOT_TAKEN = "CamFrame still shows the old Scene after the Replace. Press Replace to try once more.";
/** CamFrame answers as an older version (right after a save, or wherever that closes the window): nobody knows what it holds, so nothing says saved or not saved. */
export const LAYOUT_OLDER_CAMFRAME = "Camera layouts: CamFrame now answers as an older version, so what it holds is not known. Update CamFrame to use camera layouts.";

/** A refused save (`{ ok: false, body }`) or a missed one (null) in plain words. */
export function layoutProblem(answer) {
  if (!answer) return "CamFrame did not answer. Check it is open with Prompter link on, then open Camera layouts again.";
  const code = answer.body?.code;
  if (code === "scene-limit") return "CamFrame has no room for another Scene. Delete one you do not use in CamFrame, then open Camera layouts again.";
  if (code === "scene-exists") return "CamFrame already has a Scene with this name.";
  if (code === "not-ready") return "CamFrame's window is not open yet. Open it, then open Camera layouts again.";
  return `CamFrame refused: ${answer.body?.error || "no reason given"}`;
}

/** Not enough room for the missing layouts, in plain words ("" when there is room). */
export function layoutRoomWords(room) {
  if (room.ok) return "";
  const scenes = (n) => `${n} Scene${n === 1 ? "" : "s"}`;
  const over = room.has + room.need - room.limit;
  return `No room to save what is missing: CamFrame keeps at most ${scenes(room.limit)} and has ${room.has}, and ${room.need} more ${room.need === 1 ? "is" : "are"} needed. Delete ${scenes(over)} you do not use in CamFrame, then open Camera layouts again.`;
}

/** Why the missing layouts wait, in plain words ("" when they do not). */
export function layoutNote(plan) {
  if (!plan.tight) return layoutRoomWords(plan.room);
  return `Saving what is missing would fill CamFrame: ${plan.room.has + plan.room.need} of ${plan.room.limit} Scenes, with no spare slot, and the next Scene saved by hand there drops its oldest. Not saved yet: press Save to save anyway, or delete a Scene you do not use in CamFrame and open Camera layouts again.`;
}

/** A layout that went missing while the window is open (deleted in CamFrame): nothing saves it by itself now, so Save is offered. */
export function layoutGoneWords(plan) {
  const names = plan.rows.filter((r) => r.state === "missing").map((r) => r.name);
  return `CamFrame does not have ${names.join(" or ")}. Press Save to save ${names.length === 1 ? "it" : "them"}.`;
}

/** A layout saved at an older size, in plain words: the 1.5 times sum, or CamFrame's limit when that passes it. */
export function layoutResizedWords(row, smallSize) {
  const would = Math.round(smallSize * 1.5) > row.scene.size
    ? `1.5 × today's small camera is more than CamFrame allows, so the largest it can be is ${row.scene.size} px`
    : `1.5 × today's small camera would be ${row.scene.size} px`;
  return `Saved at ${row.saved} px; ${would}. Replace it?`;
}

/** What a save leaves, in plain words: "saved" only when both layouts are saved, naming one at an older size. */
export function layoutResultWords(plan) {
  if (plan.done) {
    const older = plan.rows.filter((r) => r.state === "resized").map((r) => ` ${r.name} is still at ${r.saved} px.`);
    return `Camera layouts saved in CamFrame.${older.join("")}`;
  }
  const left = plan.rows.filter((r) => r.state === "missing" || r.state === "different").map((r) => `${r.name} ${r.state === "different" ? "needs Replace" : "is not saved"}`);
  return `Camera layouts: ${left.join("; ")}.`;
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
