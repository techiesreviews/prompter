// The Producer's cues on the prompter (TOOLS-464): while the person's own agent is connected to both their
// Producer and this prompter, it pushes what to say next here (push_suggestions): a question (with its
// number on the Producer when it is a prepared one), the next prepared question, a way to steer back, a
// talking point or an audience question. At most SUGGESTIONS_WAITING wait, the newest on top; the page shows
// them as one small cue pill at the reading line that opens the newest in a box. Use marks one used (a used
// prepared question counts as Asked on the Producer), Skip passes it; the agent's next push or
// clear_suggestions hears which. The words live in this tab's memory only and are never stored. The cues
// hide by themselves when no push came for SUGGESTION_STALE_MS (the agent, and with it the Producer, went
// quiet), so nothing dead stays up. The Worker (src/mcp.mjs) checks a push with readSuggestions before the
// tab hears it. scripts/build.mjs inlines this file into the page, so keep it import-free and use only
// `export function`/`export const` forms.

/** The kinds of cue: a question, the next prepared question, steer back, a talking point, an audience question. */
export const SUGGESTION_KINDS = ["question", "next", "steer", "point", "audience"];
/** The kinds that may carry the prepared question's number on the Producer. */
const NUMBERED = ["question", "next"];
/** The most characters one cue takes (a prepared question on the Producer is at most 300). */
export const SUGGESTION_MAX_CHARS = 300;
/** The most cues waiting at once (and so the most in one push); a newer one pushes the oldest off. */
export const SUGGESTIONS_WAITING = 3;
/** The cues hide this long after the last push; the agent pushes on every Producer round (at most ~30 s apart). */
export const SUGGESTION_STALE_MS = 2 * 60 * 1000;
/** How many used or skipped cues the queue remembers, so an idle round's same push does not bring them back. */
const DONE_KEPT = 50;

const oneLine = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : null);
const plain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const copy = ({ kind, text, number }) => ({ kind, text, ...(number !== undefined ? { number } : {}) });

/**
 * An agent's push as `{ items }` (each `{ kind, text, number? }`, most important first, on one line), or
 * `{ error }` with a plain reason. `number` is a prepared question's number on the Producer.
 */
export function readSuggestions(args) {
  const shape = `Send "items": 1 to ${SUGGESTIONS_WAITING} of { kind, text, number? }, kind one of ${SUGGESTION_KINDS.join(", ")}.`;
  if (!plain(args) || !Array.isArray(args.items) || Object.keys(args).some((k) => k !== "items")) return { error: shape };
  if (!args.items.length || args.items.length > SUGGESTIONS_WAITING) return { error: shape };
  const items = [];
  for (const item of args.items) {
    if (!plain(item) || Object.keys(item).some((k) => !["kind", "text", "number"].includes(k))) return { error: shape };
    if (!SUGGESTION_KINDS.includes(item.kind)) return { error: `"kind" must be one of ${SUGGESTION_KINDS.join(", ")}.` };
    const text = oneLine(item.text);
    if (!text) return { error: "Each item's \"text\" must be a line of text." };
    if (text.length > SUGGESTION_MAX_CHARS) return { error: `An item's "text" is longer than ${SUGGESTION_MAX_CHARS} characters.` };
    const out = { kind: item.kind, text };
    if (item.number !== undefined) {
      if (!NUMBERED.includes(item.kind)) return { error: "\"number\" goes with a \"question\" or \"next\": the prepared question's number on the Producer." };
      if (!Number.isSafeInteger(item.number) || item.number < 1) return { error: "\"number\" must be a prepared question's number, 1 or more." };
      out.number = item.number;
    }
    items.push(out);
  }
  return { items };
}

/**
 * The cues waiting, newest first, and the box that shows one of them.
 * - `push(items, showing)` adds what readSuggestions gave, the first of them on top. A cue already waiting
 *   keeps its place (only its kind and number follow the push); a used or skipped one stays away. Past
 *   SUGGESTIONS_WAITING the oldest go, but never the one being read while the box shows (`showing`, by
 *   default whether it was opened), and the box stays on it. Returns `{ added, used, skipped }`: how many
 *   are new, and the taps not reported yet.
 * - `open()` shows the newest in the box; `move(step)` goes to a newer (-1) or older (+1) one; `close()`.
 * - `use()` takes the shown cue as used and closes the box; `skip()` passes it and shows the next (closing
 *   when none is left). Each returns the cue, or null when there is none.
 * - `clear()` empties it all (a new show: a used cue may come again) and returns the taps not reported yet.
 * - `boxOpen(liveShow)`: the box shows when it was opened, or by itself when no script is open (`liveShow`).
 * - `shown()` whether a push is fresh enough to show; `staleIn()` the time until it is not.
 * - `items`, `at` and `current` (the cue in the box): copies.
 */
export function suggestionQueue({ now = Date.now } = {}) {
  let items = [];
  let at = 0;
  let opened = false;
  let aside = false; // closed in a live show: shown again by open() or a new item
  let pushedAt = null;
  let done = [];
  let used = [];
  let skipped = [];
  const take = () => {
    const sent = { used, skipped };
    used = [];
    skipped = [];
    return sent;
  };
  const finish = (into) => {
    const item = items[at];
    if (!item) return null;
    items.splice(at, 1);
    done.push(item.text);
    if (done.length > DONE_KEPT) done.shift();
    into.push(copy(item));
    at = Math.min(at, Math.max(0, items.length - 1));
    if (!items.length) opened = false;
    return copy(item);
  };
  return {
    push(next, showing = opened) {
      const reading = showing ? items[at] : null;
      const fresh = [];
      for (const item of next) {
        if (done.includes(item.text) || fresh.some((f) => f.text === item.text)) continue;
        const waiting = items.find((i) => i.text === item.text);
        if (waiting) {
          waiting.kind = item.kind;
          waiting.number = item.number;
        } else fresh.push(copy(item));
      }
      items = [...fresh, ...items];
      if (fresh.length) aside = false;
      for (let i = items.length - 1; items.length > SUGGESTIONS_WAITING && i >= 0; i--) {
        if (items[i] !== reading) items.splice(i, 1);
      }
      at = reading ? items.indexOf(reading) : 0;
      pushedAt = now();
      return { added: fresh.length, ...take() };
    },
    open() {
      opened = items.length > 0;
      aside = false;
      at = 0;
    },
    move(step) {
      at = Math.min(Math.max(0, at + step), Math.max(0, items.length - 1));
    },
    close(setAside = true) {
      opened = false;
      aside = setAside;
      at = 0;
    },
    use() {
      const item = finish(used);
      opened = false;
      at = 0;
      return item;
    },
    skip: () => finish(skipped),
    clear() {
      items = [];
      at = 0;
      opened = false;
      aside = false;
      pushedAt = null;
      done = [];
      return take();
    },
    boxOpen: (liveShow) => items.length > 0 && (opened || (Boolean(liveShow) && !aside)),
    shown: (t = now()) => pushedAt !== null && t - pushedAt < SUGGESTION_STALE_MS && items.length > 0,
    staleIn: (t = now()) => (pushedAt === null ? 0 : Math.max(0, pushedAt + SUGGESTION_STALE_MS - t)),
    get items() { return items.map(copy); },
    get at() { return at; },
    get current() { return items[at] ? copy(items[at]) : null; },
  };
}
