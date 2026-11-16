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
  spacing: { key: "prompter-spacing", fallback: "normal", choices: ["normal", "roomy", "spacious"], quiet: true },
  // The reading line, as a share of the window height from the top; the maximum keeps it clear of the control bar.
  line: { key: "prompter-line", fallback: 0.34, min: 0.08, max: 0.75, digits: 4 },
  preset: { key: "prompter-preset", fallback: "default", choices: PRESET_NAMES },
  camframe: { key: "prompter-camframe", fallback: false, on: "on" },
  voiceOk: { key: "prompter-voice-ok", fallback: false, on: "yes" }, // the speech notice was accepted
};

/** Other things kept on this device: the last script opened, the day it was saved, the agent's token. */
export const STORED = { lastScript: "prompter-last-script", lastSaved: "prompter-last-saved", agent: "prompter-agent" };

/** A setting's value from what was stored or asked for: within its limits or one of its choices, else its default. */
export function settingValue(name, raw) {
  const s = SETTINGS[name];
  if (s.on) return raw === true || raw === s.on;
  if (s.choices) return s.choices.includes(raw) ? raw : s.fallback;
  const n = s.whole ? Math.round(Number(raw)) : Number(raw);
  return Math.min(s.max, Math.max(s.min, n || s.fallback));
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
      return settingValue(name, Number(raw) || (phone && s.phone) || s.fallback);
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
