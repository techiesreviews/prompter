import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_SCRIPT, parse } from "../src/core.mjs";
import { commonWord, followStart, followWords, heardLink, sameWord, SPEECH_RETRY_MS, speechRetryWait, speechWords } from "../src/follow.mjs";

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

test("fuzzy words: exact, cut-off interim words and one typo in longer words; common words exactly", () => {
  assert.ok(sameWord("question", "question"));
  assert.ok(sameWord("quest", "question"), "interim results end mid-word");
  assert.ok(sameWord("focussed", "focused"));
  assert.ok(!sameWord("an", "and"), "short words must match exactly");
  assert.ok(!sameWord("cat", "car"));
  assert.ok(!sameWord("the", "them") && !sameWord("then", "them"), "common words are not cut-offs or typos of each other");
  assert.ok(commonWord("the") && commonWord("you") && commonWord("ok") && !commonWord("question"));
});

// Feed words one result at a time; returns the followed line after each.
const follow = (state, ...results) => results.map((r) => (state = followWords(lines, state, speechWords(r)))).map((s) => s.line);
const at = (line, word = 0) => ({ ...followStart(line), word });

test("follows word by word: a line finished moves to the next one", () => {
  assert.deepEqual(follow(followStart(0), "writing scripts", "takes too", "long"), [0, 0, 1]);
  const s = followWords(lines, followStart(0), speechWords("writing scripts takes"));
  assert.deepEqual([s.line, s.word, s.moved], [0, 3, true], "the cursor sits on the next word to hear");
  assert.equal(followStart(-1).line, 0, "before the first line it starts at the first");
  assert.equal(followStart(4).moved, false);
});

test("the next line needs its start heard in order (two words, not only common ones)", () => {
  const s = at(0, 2); // heard "writing scripts", the speaker leaves out "takes too long"
  assert.deepEqual(follow(s, "reading"), [0], "one word of the next line is not enough");
  assert.deepEqual(follow(s, "reading them"), [1]);
  assert.deepEqual(follow(at(1, 2), "a"), [1], "a common word alone never moves on");
  assert.deepEqual(follow(at(1, 2), "today a"), [2]);
});

test("a word repeated in a later line never moves the line", () => {
  for (const word of ["question", "focused", "welcome", "lines", "answer"]) {
    assert.deepEqual(follow(at(0, 1), word), [0], word);
  }
  assert.deepEqual(follow(at(0, 1), "one question"), [0], "a pair from two lines on is not enough");
  assert.deepEqual(follow(at(3), "one question"), [3], "nor from the line after the next");
});

test("common words never move the line, alone or together", () => {
  assert.deepEqual(follow(at(3), "the you a to it", "you not"), [3, 3]);
  assert.deepEqual(follow(at(3), "the"), [3]);
  assert.deepEqual(follow(at(3), ""), [3]);
  assert.deepEqual(followWords([], followStart(-1), ["hello"]), followStart(-1));
});

test("skipping a line catches up after a few words in order", () => {
  const s = at(0, 4); // "writing scripts takes too" heard, then line 1 is left out
  assert.deepEqual(follow(s, "today", "a", "calmer", "way"), [0, 0, 2, 3]);
  assert.deepEqual(follow(at(0, 4), "one question keeps"), [6], "several lines on, three strong words in a row");
  assert.deepEqual(follow(at(0), "short lines guide your eyes"), [0], "beyond the look-ahead of 6 lines");
  assert.deepEqual(followWords(lines, at(0), speechWords("short lines guide"), { ahead: 8 }).line, 8);
});

test("goes back at most one line, and only after a strong run", () => {
  assert.deepEqual(follow(at(2), "reading them"), [2], "two words are not enough to go back");
  assert.deepEqual(follow(at(2), "reading them looks"), [1]);
  assert.deepEqual(follow(at(8), "writing scripts takes too long"), [8], "line 0 is far behind");
  assert.deepEqual(follow(at(1, 2), "writing"), [1], "words already heard do not count again");
});

test("recognition noise: misheard words, a missed or extra word and cut-offs still match", () => {
  assert.deepEqual(follow(at(5, 3), "one questin keeps", "you focus"), [6, 7]);
  assert.equal(followWords(lines, at(7), speechWords("you answer um not")).word, 3, "an extra word");
  assert.deepEqual(follow(at(7), "you answer um not reci"), [8], "a cut-off last word finishes the line");
  assert.deepEqual(follow(at(0), "writing scripts takes long"), [1], "a word left out inside the line");
});

test("interim words: tried from the last final state, never counted twice, cut-offs do not jump", () => {
  const final = followWords(lines, followStart(0), speechWords("writing scripts takes too"));
  assert.equal(followWords(lines, final, ["rea"]).line, 0, "a cut-off word of the next line does not jump");
  assert.equal(followWords(lines, final, ["questi"]).line, 0, "nor a cut-off word of a later line");
  const interim = followWords(lines, final, speechWords("long reading"));
  const again = followWords(lines, final, speechWords("long reading them looks"));
  assert.deepEqual([interim.line, interim.word], [1, 1]);
  assert.deepEqual([again.line, again.word], [1, 3], "the final result replays from the same state");
  assert.deepEqual(final.heard.map((h) => h.w), ["writing", "scripts", "takes", "too"], "the state given is not changed");
  assert.ok(final.heard.every((h) => h.used));
});

test("a repeated phrase picks the nearest line ahead", () => {
  const twice = ["Next: show the tool.", "Now: links on screen.", "Press 1 now.", "Next: show the tool.", "Now: wrap up."].map(speechWords);
  assert.equal(followWords(twice, { ...followStart(1), word: 3 }, speechWords("press one now show the")).line, 3);
  assert.equal(followWords(twice, followStart(-1), speechWords("show the")).line, 0);
});

test("reading the demo script in order follows it one line at a time", () => {
  const spoken = parse(DEMO_SCRIPT).flatMap((s) => s.items)
    .filter((it) => ["say", "bullet", "next", "now"].includes(it.type)).map((it) => speechWords(it.text));
  let s = followStart(0);
  spoken.forEach((words, k) => words.forEach((w, i) => {
    const before = s.line;
    s = followWords(spoken, s, [w]);
    const last = i === words.length - 1 && k < spoken.length - 1;
    assert.equal(s.line, last ? k + 1 : k, `line ${k} word ${i} "${w}": ${spoken[k].join(" ")}`);
    assert.ok(s.line - before <= 1, "never more than one line at a time");
  }));
  // Whole lines as recognition results: the same, one line per result.
  let r = followStart(0);
  spoken.forEach((words, k) => {
    r = followWords(spoken, r, words);
    assert.equal(r.line, Math.min(k + 1, spoken.length - 1), `result ${k}: ${words.join(" ")}`);
  });
  // Saying only the start of each line (two words, or up to the first one
  // that is not common) still keeps up.
  let p = followStart(0);
  spoken.forEach((words, k) => {
    const said = words.slice(0, Math.max(2, words.findIndex((w) => !commonWord(w)) + 1));
    p = followWords(spoken, p, said);
    const done = said.length === words.length && k < spoken.length - 1; // a short line said whole
    assert.equal(p.line, done ? k + 1 : k, `start of line ${k}: ${words.join(" ")}`);
  });
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
  assert.equal(followWords(spoken, followStart(0), speechWords("read the docs now plugin check")).line, 1);
  const candidates = s.links.map((l, li) => ({ label: l.label, s: 0, l: li }));
  assert.deepEqual(candidates.map((c) => c.label), ["the docs", "Plugin Check"]);
  assert.equal(heardLink(candidates, "and now run plugin check")?.l, 1);
  assert.equal(heardLink(candidates, "developer mozilla org"), null, "the address is not a label");
});

test("speechRetryWait: a network error waits a little longer each time in a row, then gives up", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => speechRetryWait("network", n)), SPEECH_RETRY_MS);
  assert.deepEqual(SPEECH_RETRY_MS, [500, 1000, 2000, 4000, 8000]);
  assert.equal(speechRetryWait("network", SPEECH_RETRY_MS.length), -1, "after five tries in a row it gives up");
  for (const error of ["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "bad-grammar"]) {
    assert.equal(speechRetryWait(error, 0), -1, `${error} is not retried`);
  }
});
