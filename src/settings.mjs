// The page's settings in one table: the key each is kept under on this device, its default and its
// limits or choices. Reading at start-up and saving both go through it, so a default or a limit
// changes in one place. The keys are the ones the live site has always used: renaming one would
// lose what people saved. Inlined into the page after core.mjs (scripts/build.mjs).
import { PRESET_NAMES } from "./core.mjs";

/**
 * Each setting: `key` in the store; `fallback`, its default; numbers have `min` and `max` (`whole`: rounded,
 * `digits`: saved to so many places); words have `choices`; on/off settings store `on` when on and nothing
 * when off. `phone`: the text size a small screen starts with. `quiet`: nothing is stored until the default is left.
 */
export const SETTINGS = {
  speed: { key: "prompter-speed", fallback: 40, min: 1, max: 999, whole: true }, // px per second
  size: { key: "prompter-size", fallback: 52, phone: 32, min: 10, max: 300, whole: true }, // px
  width: { key: "prompter-width", fallback: "medium", choices: ["narrow", "medium", "full"] },
  // Line height and the room between paragraphs, in percent of the text size; Lines ends each row after
  // a comma or a full stop, Paragraphs lets the lines of one thought flow together (TOOLS-486).
  lineHeight: { key: "prompter-line-height", fallback: 165, min: 110, max: 200, whole: true, quiet: true },
  paraSpace: { key: "prompter-paragraph-spacing", fallback: 200, min: 0, max: 200, whole: true, quiet: true },
  layout: { key: "prompter-layout", fallback: "lines", choices: ["lines", "paragraphs"], quiet: true },
  // The reading line, as a share of the window height from the top; the maximum keeps it clear of the control bar.
  line: { key: "prompter-line", fallback: 0.34, min: 0.08, max: 0.75, digits: 4 },
  preset: { key: "prompter-preset", fallback: "default", choices: PRESET_NAMES },
  camframe: { key: "prompter-camframe", fallback: false, on: "on" },
  voiceOk: { key: "prompter-voice-ok", fallback: false, on: "yes" }, // the speech notice was accepted
  // Text only: reminders, camera cues and link lines are hidden and happen by themselves (TOOLS-491).
  textOnly: { key: "prompter-text-only", fallback: false, on: "on" },
};

/**
 * Other things kept on this device: the last script opened, the day it was saved, the agent's token,
 * and the sites that cut the main screen off (host names only, src/main-screen.mjs).
 */
export const STORED = { lastScript: "prompter-last-script", lastSaved: "prompter-last-saved", agent: "prompter-agent", cutSites: "prompter-cut-sites" };

/**
 * Keys no setting may use again: the old Line spacing (Normal, Roomy, Spacious), which Line height,
 * Paragraph spacing and Layout replaced with Lex's new defaults for everyone (TOOLS-486).
 */
export const RETIRED = ["prompter-spacing"];

/** A number from what was stored or asked for; nothing (null, "") is no number, not 0. */
const toNumber = (raw) => (raw === null || raw === undefined || raw === "" ? NaN : Number(raw));

/** Whether `n` is a usable number for setting `s`: 0 only where 0 is allowed (no room between paragraphs). */
const usable = (s, n) => Boolean(n) || (n === 0 && s.min === 0);

/** A setting's value from what was stored or asked for: within its limits or one of its choices, else its default. */
export function settingValue(name, raw) {
  const s = SETTINGS[name];
  if (s.on) return raw === true || raw === s.on;
  if (s.choices) return s.choices.includes(raw) ? raw : s.fallback;
  const n = s.whole ? Math.round(toNumber(raw)) : toNumber(raw);
  return Math.min(s.max, Math.max(s.min, usable(s, n) ? n : s.fallback));
}

/**
 * Settings kept in `store` ({ get, set, del } of strings; the page's never throws). `phone`: a small screen,
 * which starts with smaller text when none was saved. `save` returns the value it kept.
 */
export function settingsStore(store, { phone = false } = {}) {
  return {
    read(name) {
      const s = SETTINGS[name];
      const raw = store.get(s.key);
      if (s.on || s.choices) return settingValue(name, raw);
      const n = toNumber(raw);
      return settingValue(name, usable(s, n) ? n : (phone && s.phone) || s.fallback);
    },
    save(name, value) {
      const s = SETTINGS[name];
      const v = settingValue(name, value);
      if (s.on) {
        if (v) store.set(s.key, s.on);
        else store.del(s.key);
      } else if (!s.quiet || v !== s.fallback || store.get(s.key)) {
        store.set(s.key, s.digits ? v.toFixed(s.digits) : String(v));
      }
      return v;
    },
  };
}
