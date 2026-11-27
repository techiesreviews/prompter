// What happens next, for the Text only reading choice (TOOLS-491). Text only hides the lines that
// are not spoken: camera cues, link lines and reminders. Their switches still happen by themselves
// at the next spoken line, and a quiet strip beside the text lists them: the one that just happened
// and the next few, each with a kind word (Camera, Page, You) and its words. A page that could not
// go on the main screen says Missed there, with a button that opens it by hand.
// scripts/build.mjs inlines this file into the page after src/camframe.mjs and drops the import line
// below, so keep it free of any other import and use only `export function`/`export const` forms.
import { cueRest, cueWords } from "./camframe.mjs";

/** How many switches still to come the strip lists after the one that just happened. */
export const NEXT_UP = 3;

/** The kind word each switch shows in the strip. */
export const SWITCH_KINDS = { camera: "Camera", page: "Page", you: "You" };

/**
 * The switches a hidden line makes, in reading order: a link (`link`, number `l` in section `s`)
 * puts its page on the main screen; a camera cue moves the camera, and any other words on its line
 * ("Share screen.") are for the reader's own hands (You), as is a reminder. `key` ("s:l") names a
 * page the way the main screen's link does (see linkAt).
 */
export function switchesOf(item, s, l = -1) {
  if (item.type === "link") return [{ kind: "page", text: item.label, s, l, key: `${s}:${l}` }];
  if (item.type !== "note") return [];
  if (!item.cue) return [{ kind: "you", text: item.text }];
  const rest = cueRest(item.text);
  return [{ kind: "camera", text: cueWords(item.cue), cue: item.cue }, ...(rest ? [{ kind: "you", text: rest }] : [])];
}

/**
 * The strip's rows: the switch that last reached the reading line (`passed` of `switches` have) as
 * `done`, then the next NEXT_UP as `next`. A page that could not go on the main screen (its `key` is
 * `missedKey`, the page that belongs there now) shows `missed` instead, also when a later camera
 * cue or reminder is the one that just happened; then it comes first. Each row is its switch with
 * `at` (its number) and `state`.
 */
export function nextUpRows(switches, passed, missedKey = "") {
  const rows = [];
  const missedAt = missedKey ? switches.findLastIndex((sw, i) => i < passed && sw.key === missedKey) : -1;
  if (missedAt >= 0 && missedAt < passed - 1) rows.push({ ...switches[missedAt], at: missedAt, state: "missed" });
  if (passed > 0) rows.push({ ...switches[passed - 1], at: passed - 1, state: passed - 1 === missedAt ? "missed" : "done" });
  for (let i = passed; i < Math.min(switches.length, passed + NEXT_UP); i++) rows.push({ ...switches[i], at: i, state: "next" });
  return rows;
}
