import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_SCRIPT, parse } from "../src/core.mjs";
import { followLine, sameWord, speechWords } from "../src/follow.mjs";

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
