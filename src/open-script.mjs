// The open script's own state, in one object made fresh each time a script opens and dropped when another
// opens (or the start screen shows), so nothing from the script before is still there: its sections, the
// section and link at the reading line, the link waiting to go on the main screen, the voice's place and
// the links it opened, the camera cues. The page reads and writes that object; it keeps no loose copy.
// scripts/build.mjs inlines this file into the page after src/follow.mjs and drops the import line below,
// so keep it free of any other import and use only `export function`/`export const` forms.
import { followStart } from "./follow.mjs";

/**
 * Everything that belongs to one open script, fresh. `text` is its Markdown, `saved` its save day
 * (YYYY-MM-DD, or null when not known), `sections` what parse() made of it. The rest starts empty and
 * fills while it is read:
 * - `active`: the section at the reading line (-1 before the first look);
 * - `anchor`, `anchorKey`: the link above the reading line ({ s, l } and "s:l", see linkAt), and
 *   `settleTimer`, its wait before it goes on the main screen;
 * - `shownUrl`: the page this script last put on the main screen;
 * - `voiceLines` (speechWords of each spoken line, by data-k), `voiceState` (where the voice is, see
 *   followWords), `voiceLinkKey` and `voiceLinkAt` (the link the voice last opened by its label, and the
 *   speech result it was heard in);
 * - `cues` (the camera cues by data-cue) and `cueAbove` (those above the reading line; null until the
 *   first look, which sends nothing);
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
    shownUrl: "",
    voiceLines: [],
    voiceState: followStart(-1),
    voiceLinkKey: "",
    voiceLinkAt: -1,
    cues: [],
    cueAbove: null,
    pushOwed: false,
  };
}

/**
 * The page's one open script. `clock` ({ setTimeout, clearTimeout }) is the browser's, or a stand-in in tests.
 * Read: `now`, the open script's state (an empty one on the start screen). Do: `open({ text, saved,
 * sections })` replaces it with a fresh state and returns that; `close()` replaces it with an empty one (the
 * start screen); `current(state)` says whether a state is still the open one, so a late answer for a script
 * that has gone (its link packed, say) changes nothing; `settle(fn, ms)` runs `fn` after `ms` unless a newer
 * settle, `unsettle()` or another script comes first.
 */
export function openScripts({ clock = globalThis } = {}) {
  // Plain calls: a browser's timers refuse to run on any other object.
  const { setTimeout: later, clearTimeout: cancel } = clock;
  let now = scriptState();

  function replace(next) {
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
    settle,
    unsettle: () => { cancel(now.settleTimer); },
  };
}
