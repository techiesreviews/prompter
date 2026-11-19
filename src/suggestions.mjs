// The Producer's suggestions strip (TOOLS-347): while the person's own agent is connected to both their
// Producer and this prompter, it pushes one question, one talking point and one hook here (push_suggestions);
// a tap on Use marks one used, and the agent's next push or clear_suggestions hears which, so a used
// question counts as Asked on the Producer. The words live in this tab's memory only and are never stored.
// The strip hides by itself when no push came for STRIP_STALE_MS (the agent, and with it the Producer, went
// quiet), so it never stays up as a dead control. The Worker (src/mcp.mjs) checks a push with readSuggestions
// before the tab hears it. scripts/build.mjs inlines this file into the page, so keep it import-free and
// use only `export function`/`export const` forms.

/** The strip's three slots, in their order on screen. */
export const SUGGESTION_KINDS = ["question", "point", "hook"];
/** The most characters one slot takes (a prepared question on the Producer is at most 300). */
export const SUGGESTION_MAX_CHARS = 300;
/** The strip hides this long after the last push; the agent pushes on every Producer round (at most ~30 s apart). */
export const STRIP_STALE_MS = 2 * 60 * 1000;

const oneLine = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : null);

/**
 * An agent's push as `{ slots }` (`question: { text, number? }`, `point: { text }`, `hook: { text }`, each only
 * when given), or `{ error }` with a plain reason. `number` is the prepared question's number on the Producer.
 */
export function readSuggestions(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { error: "Send a question, a talking point or a hook." };
  const slots = {};
  for (const kind of SUGGESTION_KINDS) {
    if (args[kind] === undefined) continue;
    const text = oneLine(args[kind]);
    if (!text) return { error: `"${kind}" must be a line of text.` };
    if (text.length > SUGGESTION_MAX_CHARS) return { error: `"${kind}" is longer than ${SUGGESTION_MAX_CHARS} characters.` };
    slots[kind] = { text };
  }
  if (args.number !== undefined) {
    if (!slots.question) return { error: "\"number\" goes with a \"question\": the prepared question's number on the Producer." };
    if (!Number.isSafeInteger(args.number) || args.number < 1) return { error: "\"number\" must be a prepared question's number, 1 or more." };
    slots.question.number = args.number;
  }
  if (!Object.keys(slots).length) return { error: "Send a question, a talking point or a hook." };
  return { slots };
}

/**
 * The strip's state. `push(slots)` shows what readSuggestions gave (a slot with the same words as before keeps
 * its used state; a slot left out is empty) and returns the taps not reported yet; `use(kind)` marks a slot used
 * (false when empty or used already); `clear()` empties it and returns the taps not reported yet; `shown()` says
 * whether a push is fresh enough to show; `staleIn()` the time until it is not; `slots` a copy of the slots.
 */
export function suggestionStrip({ now = Date.now } = {}) {
  let slots = {};
  let pushedAt = null;
  let unreported = [];
  const take = () => { const used = unreported; unreported = []; return used; };
  return {
    push(next) {
      const kept = {};
      for (const kind of SUGGESTION_KINDS) {
        const s = next?.[kind];
        if (!s) continue;
        const old = slots[kind];
        kept[kind] = { ...s, used: Boolean(old?.used && old.text === s.text && old.number === s.number) };
      }
      slots = kept;
      pushedAt = now();
      return take();
    },
    use(kind) {
      const s = slots[kind];
      if (!s || s.used) return false;
      s.used = true;
      unreported.push({ kind, text: s.text, ...(s.number !== undefined ? { number: s.number } : {}) });
      return true;
    },
    clear() {
      slots = {};
      pushedAt = null;
      return take();
    },
    shown: (t = now()) => pushedAt !== null && t - pushedAt < STRIP_STALE_MS && SUGGESTION_KINDS.some((k) => slots[k]),
    staleIn: (t = now()) => (pushedAt === null ? 0 : Math.max(0, pushedAt + STRIP_STALE_MS - t)),
    get slots() { return Object.fromEntries(Object.entries(slots).map(([k, s]) => [k, { ...s }])); },
  };
}
