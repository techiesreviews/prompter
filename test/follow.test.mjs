import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_SCRIPT, parse } from "../src/core.mjs";
import { followLine, heardLink, sameWord, speechWords } from "../src/follow.mjs";

const script = [
  "Writing scripts takes too long.",
  "Reading them looks stiff.",
  "Today: a calmer way.",
  "Hi, I'm Sam. Welcome.",
  "Next: the big idea.",
  "Now: one question each.",
  "One question keeps you focused.",
  "You answer, not recite.",
  "Short lines guide your eyes.",
];
const lines = script.map(speechWords);

test("speech words: lowercase, no accents, punctuation, URLs or Next:/Now: label", () => {
  assert.deepEqual(speechWords("Hi, I'm Sam. Welcome."), ["hi", "im", "sam", "welcome"]);
  assert.deepEqual(speechWords("Now: Café — https://x.test/a ok"), ["cafe", "ok"]);
  assert.deepEqual(speechWords("Next: the big idea."), ["the", "big", "idea"]);
});

test("fuzzy words: exact, cut-off interim words and one typo in longer words", () => {
  assert.ok(sameWord("question", "question"));
  assert.ok(sameWord("quest", "question"), "interim results end mid-word");
  assert.ok(sameWord("focussed", "focused"));
  assert.ok(!sameWord("an", "and"), "short words must match exactly");
  assert.ok(!sameWord("cat", "car"));
});

test("follows the line being read, word by word, across a line break", () => {
  assert.equal(followLine(lines, -1, "writing scripts"), 0);
  assert.equal(followLine(lines, 0, "writing scripts takes too long"), 0);
  assert.equal(followLine(lines, 0, "takes too long reading"), 0, "one word of the next line is not enough");
  assert.equal(followLine(lines, 0, "takes too long reading them"), 1);
  assert.equal(followLine(lines, 1, "looks stiff today a calmer"), 2);
});

test("recognition noise: misheard words and interim cut-offs still match", () => {
  assert.equal(followLine(lines, 5, "one questin keeps you focus"), 6);
  assert.equal(followLine(lines, 6, "you answer not reci"), 7);
});

test("no match, or only common words, keeps the current line", () => {
  assert.equal(followLine(lines, 3, "completely unrelated chatter here"), 3);
  assert.equal(followLine(lines, 3, "the"), 3);
  assert.equal(followLine(lines, 3, ""), 3);
  assert.equal(followLine([], -1, "hello"), -1);
});

test("looks ahead only a few lines and never jumps far back", () => {
  assert.equal(followLine(lines, 0, "short lines guide your eyes"), 0, "line 8 is beyond the look-ahead of 6");
  assert.equal(followLine(lines, 0, "short lines guide your eyes", { ahead: 8 }), 8);
  assert.equal(followLine(lines, 8, "writing scripts takes too long"), 8, "line 0 is far behind");
  assert.equal(followLine(lines, 2, "takes too long reading them"), 1, "one line back is allowed");
});

test("a repeated phrase picks the nearest line ahead", () => {
  const twice = ["Next: show the tool.", "Now: links on screen.", "Press 1 now.", "Next: show the tool.", "Now: wrap up."].map(speechWords);
  assert.equal(followLine(twice, 1, "press one now next show the tool"), 3);
  assert.equal(followLine(twice, -1, "next show the tool"), 0);
});

test("the demo script's spoken lines are all reachable in order", () => {
  const spoken = parse(DEMO_SCRIPT).flatMap((s) => s.items)
    .filter((it) => ["say", "next", "now"].includes(it.type)).map((it) => speechWords(it.text));
  let at = -1;
  for (let k = 0; k < spoken.length; k++) {
    at = followLine(spoken, at, spoken[k].join(" "));
    assert.equal(at, k, `line ${k}: ${spoken[k].join(" ")}`);
  }
});

test("heardLink: a link label said as whole words, case-insensitive, opens that link", () => {
  const links = [{ label: "Patchstack", id: "p" }, { label: "Plugin Check", id: "pc" }, { label: "Café Docs", id: "c" }];
  assert.equal(heardLink(links, "and then PATCHSTACK finds it")?.id, "p");
  assert.equal(heardLink(links, "run plugin check now")?.id, "pc");
  assert.equal(heardLink(links, "see the cafe docs")?.id, "c", "accents ignored");
  assert.equal(heardLink(links, "patchstacks are great"), null, "whole words only");
  assert.equal(heardLink(links, "patch stack"), null);
  assert.equal(heardLink(links, "plugin and check"), null, "all words together");
  assert.equal(heardLink(links, "the plugin"), null, "part of a label is not enough");
  assert.equal(heardLink(links, ""), null);
  assert.equal(heardLink([], "patchstack"), null);
  assert.equal(heardLink([{ label: "" }], "anything"), null);
});

test("heardLink: the label said last wins; old words fall out of the tail", () => {
  const links = [{ label: "Patchstack", id: "p" }, { label: "Wordfence", id: "w" }];
  assert.equal(heardLink(links, "patchstack and wordfence")?.id, "w");
  assert.equal(heardLink(links, "wordfence then patchstack")?.id, "p");
  assert.equal(heardLink(links, "patchstack one two three four five six seven eight"), null, "said more than 8 words ago");
  assert.equal(heardLink(links, "patchstack one two three four five six seven")?.id, "p");
  const twice = [{ label: "Docs", id: "a" }, { label: "docs", id: "b" }];
  assert.equal(heardLink(twice, "open the docs")?.id, "a", "a tie goes to the earlier candidate (current section first)");
});

test("a link inside a line: voice follow hears only its words, never the address", () => {
  const [s] = parse("### **A**\nRead [the docs](https://developer.mozilla.org/en-US/) now.\nNext: [Plugin Check](https://wordpress.org/plugins/plugin-check/).");
  const spoken = s.items.map((it) => speechWords(it.text));
  assert.deepEqual(spoken, [["read", "the", "docs", "now"], ["plugin", "check"]]);
  assert.equal(followLine(spoken, 0, "read the docs now plugin check"), 1);
  const candidates = s.links.map((l, li) => ({ label: l.label, s: 0, l: li }));
  assert.deepEqual(candidates.map((c) => c.label), ["the docs", "Plugin Check"]);
  assert.equal(heardLink(candidates, "and now run plugin check")?.l, 1);
  assert.equal(heardLink(candidates, "developer mozilla org"), null, "the address is not a label");
});
