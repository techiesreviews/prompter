// The open script's own state (openScripts in src/open-script.mjs): one object made fresh each time a script
// opens, so nothing from the script before (its sections, the section and link at the reading line, the link
// waiting to go on the main screen, the voice's place, the cues) is still there when the next one opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { voiceStart } from "../src/follow.mjs";
import { openScripts, scriptState } from "../src/open-script.mjs";

/** Timers that run only when the test calls `run()`. */
function fakeClock() {
  let ids = 0;
  const timers = new Map();
  return {
    clock: {
      setTimeout: (fn) => { timers.set(++ids, fn); return ids; },
      clearTimeout: (id) => { timers.delete(id); },
    },
    pending: () => timers.size,
    run() { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); },
  };
}

const SECTIONS_A = [{ title: "A", time: "00:00", items: [], links: [{ label: "a", url: "https://a.test/" }] }];
const SECTIONS_B = [{ title: "B", time: "00:00", items: [], links: [] }];

// What a script picks up while it is read: every per-script field changed.
function dirty(s) {
  s.active = 3;
  s.anchor = { s: 0, l: 0 };
  s.anchorKey = "0:0";
  s.shownUrl = "https://a.test/";
  s.ownShown.add("https://a.test/");
  s.ownUrl = "https://a.test/";
  s.voiceLines.push(["hello", "world"]);
  s.voice = { follow: { ...s.voice.follow, line: 4, word: 2, moved: true }, final: 3, linkKey: "0:0", linkAt: 7 };
  s.cues.push({ size: "small" });
  s.cueAbove = new Set([0]);
  s.pushOwed = true;
  s.switches.push({ kind: "you", text: "Smile" });
  s.passed = 1;
  s.missedKey = "0:0";
  s.anchorDue = 120;
}

function assertClean(s) {
  assert.equal(s.active, -1, "no section at the reading line yet");
  assert.equal(s.anchor, null, "no link above the reading line");
  assert.equal(s.anchorKey, "");
  assert.equal(s.settleTimer, 0, "no link waiting to go on the main screen");
  assert.equal(s.shownUrl, "", "the main screen's page is not this script's yet");
  assert.equal(s.ownShown.size, 0, "no page opened in a window of its own yet");
  assert.equal(s.ownUrl, "", "no own window's page marked as showing");
  assert.deepEqual(s.voiceLines, []);
  assert.deepEqual(s.voice, voiceStart(-1), "the voice starts from the top, with no result followed and no link opened by voice");
  assert.deepEqual(s.cues, []);
  assert.equal(s.cueAbove, null, "the first look after opening sends no cue");
  assert.equal(s.pushOwed, false, "no history entry owed");
  assert.deepEqual(s.switches, [], "no Text only switches");
  assert.equal(s.passed, 0, "none of them reached the reading line");
  assert.equal(s.missedKey, "", "no page missed the main screen");
  assert.equal(s.anchorDue, null, "no page owed to the main screen by a Text only switch");
}

test("a fresh state holds the script and nothing else", () => {
  const s = scriptState({ text: "### **A · 00:00**", saved: "2026-11-05", sections: SECTIONS_A });
  assert.equal(s.text, "### **A · 00:00**");
  assert.equal(s.saved, "2026-11-05");
  assert.equal(s.sections, SECTIONS_A);
  assertClean(s);
  const empty = scriptState();
  assert.deepEqual([empty.text, empty.saved, empty.sections], ["", null, []]);
  assertClean(empty);
});

test("two states never share their lists", () => {
  const a = scriptState();
  const b = scriptState();
  dirty(a);
  assertClean(b);
  assert.notEqual(a.sections, b.sections);
});

test("opening script B after script A starts with clean state", () => {
  const { clock } = fakeClock();
  const scripts = openScripts({ clock });
  const a = scripts.open({ text: "A", saved: "2026-11-01", sections: SECTIONS_A });
  assert.equal(scripts.now, a);
  dirty(a);
  const b = scripts.open({ text: "B", sections: SECTIONS_B });
  assert.equal(scripts.now, b);
  assert.notEqual(b, a, "a new object, not the old one cleared");
  assert.deepEqual([b.text, b.saved, b.sections], ["B", null, SECTIONS_B], "B's date is its own: A's never carries over");
  assertClean(b);
});

test("the start screen holds no script and none of the last one's state", () => {
  const { clock } = fakeClock();
  const scripts = openScripts({ clock });
  assert.deepEqual([scripts.now.text, scripts.now.sections], ["", []], "before any script: empty");
  const a = scripts.open({ text: "A", saved: "2026-11-01", sections: SECTIONS_A });
  dirty(a);
  const empty = scripts.close();
  assert.equal(scripts.now, empty);
  assert.deepEqual([empty.text, empty.saved, empty.sections], ["", null, []]);
  assertClean(empty);
});

test("a script that has gone is no longer the open one, so its late answers change nothing", () => {
  const { clock } = fakeClock();
  const scripts = openScripts({ clock });
  const a = scripts.open({ text: "A", sections: SECTIONS_A });
  assert.equal(scripts.current(a), true);
  const b = scripts.open({ text: "B", sections: SECTIONS_B });
  assert.equal(scripts.current(a), false, "A, after B opened");
  assert.equal(scripts.current(b), true);
  scripts.close();
  assert.equal(scripts.current(b), false, "B, after the start screen");
});

test("only the newest request to open a script may open: a newer request, script or start screen makes an older one stale", () => {
  const { clock } = fakeClock();
  const scripts = openScripts({ clock });
  const first = scripts.ask(); // a link still being unpacked
  const second = scripts.ask(); // a second link, asked for just after
  assert.equal(first(), false, "the first link, once the second was asked for");
  assert.equal(second(), true);
  scripts.open({ text: "B", sections: SECTIONS_B }); // the second link opened, before the first finished unpacking
  assert.equal(first(), false, "the first link stays stale after the second opened");
  const third = scripts.ask();
  scripts.open({ text: "A", sections: SECTIONS_A }); // a script pasted while the third link unpacks
  assert.equal(third(), false, "a script opened after the request");
  const fourth = scripts.ask();
  scripts.close(); // the start screen
  assert.equal(fourth(), false, "the start screen shown after the request");
  assert.equal(scripts.ask()(), true, "a request with nothing after it may open");
});

test("a link waiting to go on the main screen dies with its script", () => {
  const time = fakeClock();
  const scripts = openScripts({ clock: time.clock });
  const shown = [];
  scripts.open({ text: "A", sections: SECTIONS_A });
  scripts.settle(() => shown.push("A"), 700);
  assert.equal(time.pending(), 1);
  scripts.open({ text: "B", sections: SECTIONS_B });
  assert.equal(time.pending(), 0, "opening B cancels A's wait");
  time.run();
  assert.deepEqual(shown, []);

  scripts.settle(() => shown.push("B1"), 700);
  scripts.settle(() => shown.push("B2"), 700);
  assert.equal(time.pending(), 1, "a newer link replaces the one waiting");
  time.run();
  assert.deepEqual(shown, ["B2"]);

  scripts.settle(() => shown.push("B3"), 700);
  scripts.unsettle();
  time.run();
  scripts.settle(() => shown.push("B4"), 700);
  scripts.close();
  time.run();
  assert.deepEqual(shown, ["B2"], "unsettle, or the start screen, drops it");
});

test("a wait whose timer slipped through still checks its script", () => {
  // A stand-in clock that cannot cancel: the wait must still see that its script has gone.
  const due = [];
  const scripts = openScripts({ clock: { setTimeout: (fn) => due.push(fn), clearTimeout: () => {} } });
  const shown = [];
  scripts.open({ text: "A", sections: SECTIONS_A });
  scripts.settle(() => shown.push("A"), 700);
  scripts.open({ text: "B", sections: SECTIONS_B });
  for (const fn of due) fn();
  assert.deepEqual(shown, []);
});

test("app.js keeps no per-script state loose", () => {
  // Each of these lives in the open script's state; a loose copy in app.js is one a reset can forget.
  const app = readFileSync(resolve(import.meta.dirname, "../src/app.js"), "utf8");
  const loose = ["scriptText", "scriptSaved", "sections", "active", "shownUrl", "ownShown", "ownUrl", "settleTimer", "anchor", "anchorKey",
    "voiceLinkKey", "voiceLinkAt", "voiceLines", "voiceState", "voice", "voiceFinal", "cues", "cueAbove"]
    .filter((name) => new RegExp(`^(let|var|const)\\s(.*[,\\s])?${name}\\s*(=|;|,|$)`, "m").test(app));
  assert.deepEqual(loose, []);
});
