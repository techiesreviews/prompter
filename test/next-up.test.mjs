import { test } from "node:test";
import assert from "node:assert/strict";
import { INLINED } from "../scripts/build.mjs";
import { classify, parse } from "../src/core.mjs";
import { NEXT_UP, nextUpRows, SWITCH_KINDS, switchesOf } from "../src/next-up.mjs";

test("the page inlines the strip's logic after the camera words it uses", () => {
  assert.ok(INLINED.includes("src/next-up.mjs"));
  assert.ok(INLINED.indexOf("src/camframe.mjs") < INLINED.indexOf("src/next-up.mjs"));
});

test("each hidden line becomes its switches, with a kind word", () => {
  assert.deepEqual(SWITCH_KINDS, { camera: "Camera", page: "Page", you: "You" });
  assert.deepEqual(switchesOf(classify("[Face small, bottom right]"), 1), [{ kind: "camera", text: "face small, bottom right", cue: { size: "small", position: "bottom-right" } }]);
  assert.deepEqual(switchesOf(classify("[Share screen. Face small.]"), 1), [
    { kind: "camera", text: "face small", cue: { size: "small" } },
    { kind: "you", text: "Share screen." },
  ], "a cue's other words are for the reader's own hands");
  assert.deepEqual(switchesOf(classify("[Smile and wave]"), 0), [{ kind: "you", text: "Smile and wave" }], "a reminder");
  assert.deepEqual(switchesOf(classify("[Face huge]"), 0), [{ kind: "you", text: "Face huge" }], "a Face line that is no cue stays a reminder");
  const [section] = parse("### **INTRO**\n\nHello there.\n- Patchstack: https://patchstack.com\n");
  assert.deepEqual(switchesOf(section.links[0], 0, 0), [{ kind: "page", text: "Patchstack", s: 0, l: 0, key: "0:0" }], "a page, keyed as the main screen's link is");
  assert.deepEqual(switchesOf(classify("Just words."), 0), [], "spoken lines make none");
});

const SW = [
  { kind: "page", text: "Intro", key: "1:0" },
  { kind: "camera", text: "face small" },
  { kind: "you", text: "Share screen." },
  { kind: "page", text: "Patchstack", key: "1:1" },
  { kind: "camera", text: "face full" },
  { kind: "page", text: "Docs", key: "2:0" },
];
const rows = (passed, missed) => nextUpRows(SW, passed, missed).map((r) => `${r.state} ${r.text}`);

test("the strip shows the switch that just happened and the next three", () => {
  assert.equal(NEXT_UP, 3);
  assert.deepEqual(rows(0), ["next Intro", "next face small", "next Share screen."], "nothing happened yet: only what comes");
  assert.deepEqual(rows(1), ["done Intro", "next face small", "next Share screen.", "next Patchstack"]);
  assert.deepEqual(rows(4), ["done Patchstack", "next face full", "next Docs"], "fewer left near the end");
  assert.deepEqual(rows(6), ["done Docs"], "the last one stays as done");
  assert.deepEqual(nextUpRows([], 0), [], "a script with no hidden lines has no rows");
  assert.deepEqual(nextUpRows(SW, 2)[0], { ...SW[1], at: 1, state: "done" }, "each row carries its switch and number");
});

test("a page that could not open says missed, also once a later switch happened", () => {
  assert.deepEqual(rows(4, "1:1"), ["missed Patchstack", "next face full", "next Docs"]);
  assert.deepEqual(rows(5, "1:1"), ["missed Patchstack", "done face full", "next Docs"], "a later camera cue does not hide it: it comes first");
  assert.deepEqual(rows(4, "2:0"), ["done Patchstack", "next face full", "next Docs"], "a page still to come is never missed");
  assert.deepEqual(rows(1, ""), ["done Intro", "next face small", "next Share screen.", "next Patchstack"]);
});
