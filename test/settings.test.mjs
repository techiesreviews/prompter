import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INLINED } from "../scripts/build.mjs";
import { PRESETS } from "../src/core.mjs";
import { RETIRED, SETTINGS, STORED, settingValue, settingsStore } from "../src/settings.mjs";

// A stand-in for the page's store: strings in, strings out, like localStorage.
function fakeStore(start = {}) {
  const data = new Map(Object.entries(start));
  return {
    data,
    get: (k) => (data.has(k) ? data.get(k) : null),
    set: (k, v) => { data.set(k, String(v)); return true; },
    del: (k) => { data.delete(k); },
  };
}

// The keys the live site has always saved under. A renamed key would lose every saved setting.
const LIVE_KEYS = {
  speed: "prompter-speed",
  size: "prompter-size",
  width: "prompter-width",
  lineHeight: "prompter-line-height",
  paraSpace: "prompter-paragraph-spacing",
  layout: "prompter-layout",
  line: "prompter-line",
  preset: "prompter-preset",
  camframe: "prompter-camframe",
  voiceOk: "prompter-voice-ok",
  textOnly: "prompter-text-only",
  obs: "prompter-obs",
};

test("each setting keeps the key the live site saves under", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(SETTINGS).map(([name, s]) => [name, s.key])), LIVE_KEYS);
  assert.deepEqual(STORED, {
    lastScript: "prompter-last-script", lastSaved: "prompter-last-saved", agent: "prompter-agent", cutSites: "prompter-cut-sites",
    obsPassword: "prompter-obs-password", takes: "prompter-takes",
  });
  const all = [...Object.values(SETTINGS).map((s) => s.key), ...Object.values(STORED)];
  assert.equal(new Set(all).size, all.length, "no two share a key");
  // The old Line spacing (Normal, Roomy, Spacious) is no longer read: Lex's new defaults apply to everyone
  // (TOOLS-486). Its key stays retired, so a later setting never reads an old word as its own value.
  assert.deepEqual(RETIRED, ["prompter-spacing"]);
  for (const key of RETIRED) assert.ok(!all.includes(key), `${key} is retired`);
});

test("an empty store gives each setting its default", () => {
  const prefs = settingsStore(fakeStore());
  assert.deepEqual(Object.fromEntries(Object.keys(SETTINGS).map((name) => [name, prefs.read(name)])), {
    speed: 40, size: 52, width: "medium", lineHeight: 165, paraSpace: 200, layout: "lines", line: 0.34, preset: "default", camframe: false, voiceOk: false, textOnly: false, obs: false,
  });
  assert.equal(settingsStore(fakeStore({ "prompter-spacing": "spacious" })).read("lineHeight"), 165, "the old Line spacing is not read");
  assert.equal(settingsStore(fakeStore(), { phone: true }).read("size"), 32, "a phone starts with smaller text");
  assert.equal(settingsStore(fakeStore(), { phone: true }).read("speed"), 40, "only the text size has a phone default");
});

test("numbers are held to their limits", () => {
  assert.deepEqual([settingValue("speed", 0.4), settingValue("speed", -5), settingValue("speed", 5000), settingValue("speed", 74.6)], [40, 1, 999, 75]);
  assert.deepEqual([settingValue("size", 4), settingValue("size", 301), settingValue("size", 150.4), settingValue("size", Infinity)], [10, 300, 150, 300]);
  assert.deepEqual([settingValue("line", 0.01), settingValue("line", 0.9), settingValue("line", 0.5)], [0.08, 0.75, 0.5]);
  assert.deepEqual([settingValue("line", 0.12345)], [0.12345], "the line is not rounded, only when saved");
  // Line height and paragraph spacing, in percent of the text size.
  assert.deepEqual([settingValue("lineHeight", 90), settingValue("lineHeight", 250), settingValue("lineHeight", 142.4)], [110, 200, 142]);
  assert.deepEqual([settingValue("paraSpace", -5), settingValue("paraSpace", 400), settingValue("paraSpace", 37.6)], [0, 200, 38]);
  assert.equal(settingValue("paraSpace", 0), 0, "no room between paragraphs is a choice, not a damaged value");
  assert.equal(settingValue("paraSpace", "abc"), 200);
});

test("a damaged stored value falls back to the default", () => {
  const bad = { speed: "fast", size: "", width: "huge", lineHeight: "tall", paraSpace: "", layout: "columns", line: "abc", preset: "constructor", camframe: "yes", voiceOk: "on", textOnly: "yes", obs: "yes" };
  const prefs = settingsStore(fakeStore(Object.fromEntries(Object.entries(bad).map(([n, v]) => [SETTINGS[n].key, v]))));
  assert.deepEqual(Object.fromEntries(Object.keys(bad).map((name) => [name, prefs.read(name)])), {
    speed: 40, size: 52, width: "medium", lineHeight: 165, paraSpace: 200, layout: "lines", line: 0.34, preset: "default", camframe: false, voiceOk: false, textOnly: false, obs: false,
  });
  assert.equal(settingsStore(fakeStore({ "prompter-paragraph-spacing": "0" })).read("paraSpace"), 0, "a saved 0 loads as 0");
  // Names an object has of its own (toString, __proto__) are no preset.
  for (const name of ["toString", "__proto__", "hasOwnProperty"]) assert.equal(settingValue("preset", name), "default", name);
  assert.equal(settingsStore(fakeStore({ "prompter-size": "0" }), { phone: true }).read("size"), 32, "nothing usable: the phone's default");
});

test("settings saved by today's live site load back unchanged", () => {
  // Exactly what the live page wrote: numbers as plain strings, the line to four places.
  const live = {
    "prompter-speed": "75", "prompter-size": "150", "prompter-width": "full", "prompter-line-height": "130",
    "prompter-paragraph-spacing": "80", "prompter-layout": "paragraphs",
    "prompter-line": "0.4213", "prompter-preset": "lex", "prompter-camframe": "on", "prompter-voice-ok": "yes", "prompter-obs": "on",
  };
  const store = fakeStore(live);
  const prefs = settingsStore(store, { phone: true });
  const read = Object.fromEntries(Object.keys(SETTINGS).map((name) => [name, prefs.read(name)]));
  assert.deepEqual(read, { speed: 75, size: 150, width: "full", lineHeight: 130, paraSpace: 80, layout: "paragraphs", line: 0.4213, preset: "lex", camframe: true, voiceOk: true, textOnly: false, obs: true });
  // Saving them again writes the very same strings.
  for (const [name, value] of Object.entries(read)) prefs.save(name, value);
  assert.deepEqual(Object.fromEntries(store.data), live);
  // Each choice the page offers loads as itself.
  for (const name of ["width", "layout", "preset"]) {
    for (const choice of SETTINGS[name].choices) assert.equal(settingsStore(fakeStore({ [SETTINGS[name].key]: choice })).read(name), choice);
  }
  assert.deepEqual(SETTINGS.preset.choices, Object.keys(PRESETS));
});

test("saving stores what the page used to store", () => {
  const store = fakeStore();
  const prefs = settingsStore(store);
  assert.equal(prefs.save("speed", 74.6), 75, "returns the value it kept");
  assert.equal(prefs.save("line", 0.123456), 0.123456);
  assert.equal(store.get("prompter-speed"), "75");
  assert.equal(store.get("prompter-line"), "0.1235");
  assert.equal(prefs.save("width", "wide"), "medium");
  assert.equal(store.get("prompter-width"), "medium");
  assert.equal(prefs.save("preset", null), "default", "a link without a preset was made for the default one");
  assert.equal(store.get("prompter-preset"), "default");
  // Line height, paragraph spacing and layout store nothing until the default is left (so a later
  // default reaches everyone who never changed them); after that they keep whatever is chosen.
  for (const [name, other] of [["lineHeight", 130], ["paraSpace", 0], ["layout", "paragraphs"]]) {
    const { key, fallback } = SETTINGS[name];
    assert.equal(prefs.save(name, fallback), fallback);
    assert.equal(store.get(key), null, `${name} at its default stores nothing`);
    assert.equal(prefs.save(name, other), other);
    prefs.save(name, fallback);
    assert.equal(store.get(key), String(fallback), `${name} back at its default is kept`);
  }
  // On and off: on is a word, off removes the key.
  assert.equal(prefs.save("camframe", true), true);
  assert.equal(store.get("prompter-camframe"), "on");
  assert.equal(prefs.save("camframe", false), false);
  assert.equal(store.get("prompter-camframe"), null);
  prefs.save("voiceOk", true);
  assert.equal(store.get("prompter-voice-ok"), "yes");
  // Text only (TOOLS-491) is off by default, so nobody's prompter changes until they turn it on.
  assert.equal(SETTINGS.textOnly.fallback, false);
  assert.equal(prefs.save("textOnly", true), true);
  assert.equal(store.get("prompter-text-only"), "on");
  assert.equal(prefs.save("textOnly", false), false);
  assert.equal(store.get("prompter-text-only"), null, "off stores nothing");
  prefs.save("obs", true);
  assert.equal(store.get("prompter-obs"), "on");
});

// ---------- Guard: keys and defaults live only in the table ----------

const src = (p) => readFileSync(resolve(import.meta.dirname, "../src", p), "utf8");
// The page's own code: the modules the build inlines and app.js (server code keeps no settings).
const pageSources = () => [...INLINED.map((f) => f.replace(/^src\//, "")), "app.js"].filter((f) => f !== "settings.mjs");

test("no file but the table types a storage key by hand", () => {
  const keys = new Set([...Object.values(SETTINGS).map((s) => s.key), ...Object.values(STORED)]);
  for (const file of pageSources()) {
    const text = src(file);
    for (const [, key] of text.matchAll(/["'`](prompter-[\w-]+)["'`]/g)) {
      assert.ok(!keys.has(key), `${file} types the storage key "${key}"; use SETTINGS or STORED from src/settings.mjs`);
      assert.equal(key, "prompter-main-screen", `${file}: "${key}" looks like a storage key; add it to src/settings.mjs`);
    }
    assert.doesNotMatch(text, /\bstore\.(get|set|del)\(\s*["'`]/, `${file} reads or saves a storage key typed by hand`);
    if (file !== "app.js") assert.doesNotMatch(text, /localStorage/, `${file} uses localStorage itself`);
  }
  assert.equal((src("app.js").match(/localStorage\.(getItem|setItem|removeItem)/g) || []).length, 3, "only the page's store wrapper touches localStorage");
});

test("the page writes no setting's default or limits by hand", () => {
  const app = src("app.js");
  for (const [name, s] of Object.entries(SETTINGS)) {
    // Small whole numbers (a minimum of 1 or 10) are everywhere (radix 10, steps of 10), so only the telling ones.
    for (const n of [s.fallback, s.phone, s.min, s.max].filter((v) => typeof v === "number" && (v >= 20 || !Number.isInteger(v)))) {
      const lit = String(n).replace(".", "\\.");
      // A fallback (|| 40, ?? 40, ? 40, : 40), the last argument of a call (…, 40)) or a limit in Math.min/max.
      assert.doesNotMatch(app, new RegExp(`(\\|\\||\\?\\?|[?:])\\s*${lit}\\b|,\\s*${lit}\\s*\\)|Math\\.(min|max)\\(\\s*${lit}\\b`), `app.js writes ${name}'s ${n} by hand`);
      if (!Number.isInteger(n)) assert.doesNotMatch(app, new RegExp(`\\b${lit}\\b`), `app.js writes ${name}'s ${n} by hand`);
    }
    for (const choice of s.choices || []) {
      assert.doesNotMatch(app, new RegExp(`["'\`]${choice}["'\`]`), `app.js writes ${name}'s "${choice}" by hand`);
    }
    // On/off settings: the word they are stored as, saved or compared by hand ("on" is also a link state, so only these forms).
    if (s.on) assert.doesNotMatch(app, new RegExp(`\\.set\\([^)]*,\\s*["'\`]${s.on}["'\`]\\s*\\)|\\.get\\([^)]*\\)\\s*[=!]==?\\s*["'\`]${s.on}["'\`]`), `app.js writes ${name}'s stored "${s.on}" by hand`);
  }
});

test("the page's controls start at the table's defaults and limits", () => {
  const html = src("page.html");
  const attrs = (cls) => {
    const tag = html.match(new RegExp(`<input class="${cls}"[^>]*>`))?.[0] || "";
    return Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
  };
  for (const [name, cls, slider] of [["speed", "speed-val", "speed"], ["size", "size-val", "size"], ["lineHeight", "line-height-val", "line-height"], ["paraSpace", "para-space-val", "para-space"]]) {
    const box = attrs(cls);
    const s = SETTINGS[name];
    assert.deepEqual([Number(box.min), Number(box.max), Number(box.value)], [s.min, s.max, s.fallback], `${cls} box`);
    assert.equal(Number(attrs(slider).value), s.fallback, `${name} slider`);
  }
  // The new sliders reach the whole range (only the text size and speed let a typed value go past them).
  for (const [name, slider] of [["lineHeight", "line-height"], ["paraSpace", "para-space"]]) {
    assert.deepEqual([Number(attrs(slider).min), Number(attrs(slider).max)], [SETTINGS[name].min, SETTINGS[name].max], `${name} slider ends`);
  }
  const handle = html.match(/<div class="line-handle"[^>]*>/)?.[0] || "";
  const pct = (v) => String(Math.round(v * 100));
  assert.deepEqual(
    ["aria-valuemin", "aria-valuemax", "aria-valuenow"].map((a) => handle.match(new RegExp(`${a}="(\\d+)"`))?.[1]),
    [pct(SETTINGS.line.min), pct(SETTINGS.line.max), pct(SETTINGS.line.fallback)],
    "the reading line's handle",
  );
  // What the page shows before its script runs.
  const pctNow = pct(SETTINGS.line.fallback);
  assert.match(handle, new RegExp(`aria-valuetext="${pctNow}% from the top"`), "the handle's spoken value");
  const rootStyle = html.match(/:root\s*\{[^}]*\}/)?.[0] || "";
  assert.match(rootStyle, new RegExp(`--size:\\s*${SETTINGS.size.fallback}px;`), "the text size before the script runs");
  assert.match(rootStyle, new RegExp(`--line:\\s*${pctNow}vh;`), "the reading line before the script runs");
  assert.match(rootStyle, new RegExp(`--line-height:\\s*${SETTINGS.lineHeight.fallback / 100};`), "the line height before the script runs");
  assert.match(rootStyle, new RegExp(`--para:\\s*${SETTINGS.paraSpace.fallback / 100};`), "the paragraph spacing before the script runs");
  for (const name of ["width", "layout"]) {
    const values = [...html.matchAll(new RegExp(`<input type="radio" name="${name}" value="([^"]+)"`, "g"))].map((m) => m[1]);
    assert.deepEqual(values, SETTINGS[name].choices, `the ${name} choices`);
  }
});
