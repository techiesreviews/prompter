// The open script's own state, in one object made fresh each time a script opens and dropped when another
// opens (or the start screen shows), so nothing from the script before is still there: its sections, the
// section and link at the reading line, the link waiting to go on the main screen, the voice's place and
// the links it opened, the camera cues, the Text only switches. The page reads and writes that object; it keeps no loose copy.
// scripts/build.mjs inlines this file into the page after src/follow.mjs and drops the import line below,
// so keep it free of any other import and use only `export function`/`export const` forms.
import { voiceStart } from "./follow.mjs";

/**
 * Everything that belongs to one open script, fresh. `text` is its Markdown, `saved` its save day
 * (YYYY-MM-DD, or null when not known), `sections` what parse() made of it. The rest starts empty and
 * fills while it is read:
 * - `active`: the section at the reading line (-1 before the first look);
 * - `anchor`, `anchorKey`: the link above the reading line ({ s, l } and "s:l", see linkAt), and
 *   `settleTimer`, its wait before it goes on the main screen, and `anchorDue`, the scroll place where
 *   turning Text only on or off carried a later link above the reading line without sending it (it goes
 *   on the main screen at the reader's next move away from there; null when none);
 * - `shownUrl`: the page this script last put on the main screen;
 * - `voiceLines` (speechWords of each spoken line, by data-k) and `voice` (Follow my voice's state, see
 *   voiceStart and voiceStep: where the voice is, the speech results already followed, the link the voice
 *   last opened by its label and the speech result it was heard in);
 * - `cues` (the camera cues by data-cue) and `cueAbove` (those above the reading line; null until the
 *   first look, which sends nothing);
 * - `switches` (Text only: what the hidden lines do, in reading order, see switchesOf), `passed` (how many of
 *   them reached the reading line) and `missedKey` (the page that belongs on the main screen now but could
 *   not go there: no main screen, cut off, or held back; "" when none);
 * - `pushOwed`: opened from the start screen, its link is still owed a new history entry (so Back returns
 *   there); a script opened before that link lands takes the entry over.
 */
export function scriptState({ text = "", saved = null, sections = [] } = {}) {
  return {
    text,
    saved,
    sections,
    active: -1,
    anchor: null,
    anchorKey: "",
    settleTimer: 0,
    anchorDue: null,
    shownUrl: "",
    voiceLines: [],
    voice: voiceStart(-1),
    cues: [],
    cueAbove: null,
    switches: [],
    passed: 0,
    missedKey: "",
    pushOwed: false,
  };
}

/**
 * The page's one open script. `clock` ({ setTimeout, clearTimeout }) is the browser's, or a stand-in in tests.
 * Read: `now`, the open script's state (an empty one on the start screen). Do: `open({ text, saved,
 * sections })` replaces it with a fresh state and returns that; `close()` replaces it with an empty one (the
 * start screen); `current(state)` says whether a state is still the open one, so a late answer for a script
 * that has gone (its link packed, say) changes nothing; `ask()`, called before a script is fetched (a link
 * unpacked, a file read), returns a check that says whether that request is still the newest: false once
 * another request, another script or the start screen came after it, so only the newest request ever opens;
 * `settle(fn, ms)` runs `fn` after `ms` unless a newer settle, `unsettle()` or another script comes first.
 */
export function openScripts({ clock = globalThis } = {}) {
  // Plain calls: a browser's timers refuse to run on any other object.
  const { setTimeout: later, clearTimeout: cancel } = clock;
  let now = scriptState();
  let asked = 0; // counts requests to open and every open or close, so an older request knows it was overtaken

  function ask() {
    const n = ++asked;
    return () => n === asked;
  }

  function replace(next) {
    asked++;
    cancel(now.settleTimer);
    now = next;
    return now;
  }

  function settle(fn, ms) {
    const script = now;
    cancel(script.settleTimer);
    script.settleTimer = later(() => { if (script === now) fn(); }, ms);
  }

  return {
    get now() { return now; },
    open: (fields) => replace(scriptState(fields)),
    close: () => replace(scriptState()),
    current: (script) => script === now,
    ask,
    settle,
    unsettle: () => { cancel(now.settleTimer); },
  };
}
