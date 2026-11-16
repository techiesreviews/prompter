import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_SCRIPT, parse } from "../src/core.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commonWord, followStart, followWords, heardLink, sameWord, speechWords, voiceAt, voiceSession, voiceStart, voiceStep } from "../src/follow.mjs";

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

// ---------- One speech result, followed (voiceStep) ----------
// The page hands each recognition event's results ({ transcript, isFinal }) to voiceStep with the voice
// state of the open script, the link candidates and the page on the main screen; it gets back the new
// state, the line to mark and the link to open. Nothing else decides.
const said = (transcript, isFinal = true) => ({ transcript, isFinal });
const LINKS = [
  { label: "Big Idea", s: 0, l: 0, key: "0:0", url: "https://big.test/" },
  { label: "Patchstack", s: 0, l: 1, key: "0:1", url: "https://patch.test/" },
];

test("voice step: each final result is followed once; interim words are tried and dropped", () => {
  const v0 = voiceStart(0);
  assert.deepEqual(v0, { follow: followStart(0), final: 0, linkKey: "", linkAt: -1 });
  const first = voiceStep(lines, v0, [said("writing scripts takes too long"), said("reading them", false)]);
  assert.equal(first.voice.final, 1, "only the final result counts as followed");
  assert.deepEqual(first.voice.follow, followWords(lines, v0.follow, speechWords("writing scripts takes too long")), "the interim words are not kept");
  assert.equal(first.line, 1, "the line to mark includes the interim words");
  assert.equal(first.link, null);
  // The same final result again (the next event of the session): not followed twice.
  const again = voiceStep(lines, first.voice, [said("writing scripts takes too long"), said("reading them looks", false)]);
  assert.equal(again.voice.final, 1);
  assert.deepEqual(again.voice.follow, first.voice.follow);
  assert.deepEqual(v0, voiceStart(0), "the state passed in is not changed");
});

test("voice step: nothing heard that moves the line marks no line", () => {
  const r = voiceStep(lines, voiceStart(3), [said("the and you", false)]);
  assert.equal(r.line, -1);
  assert.equal(r.voice.follow.moved, false);
});

test("voice step: jumps ahead after a strong run, back one line only after one", () => {
  const ahead = voiceStep(lines, voiceStart(0), [said("one question keeps you focused")]);
  assert.equal(ahead.line, 7, "skipped ahead to the line read (and finished it)");
  const back = voiceStep(lines, voiceStart(4), [said("hi im sam welcome")]);
  assert.equal(back.line, 4, "one line back after a strong run, then on to the next line");
  const weak = voiceStep(lines, voiceStart(4), [said("welcome")]);
  assert.equal(weak.line, -1, "one word of the line before is not enough");
});

test("voice step: a repeated phrase goes to the copy ahead, not back", () => {
  const twice = ["Short lines guide your eyes.", "Pause here.", "Short lines guide your eyes.", "The end."].map(speechWords);
  const r = voiceStep(twice, voiceStart(1), [said("short lines guide your eyes")]);
  assert.equal(r.line, 3, "the copy on line 2 was read (and finished), not line 0");
});

test("voice step: a label is heard only in the last 3 results", () => {
  const four = voiceStep(lines, voiceStart(0), [said("the big idea"), said("one"), said("two"), said("three")], { links: LINKS });
  assert.equal(four.link, null, "said four results ago: gone");
  const three = voiceStep(lines, voiceStart(0), [said("the big idea"), said("one"), said("two")], { links: LINKS });
  assert.equal(three.link?.key, "0:0", "said three results ago: still heard, and opened");
  assert.deepEqual([three.voice.linkKey, three.voice.linkAt], ["0:0", 0], "remembers which link and the result it was heard in");
  const interim = voiceStep(lines, voiceStart(0), [said("one"), said("patchstack", false)], { links: LINKS });
  assert.equal(interim.link?.key, "0:1", "an interim result counts too");
});

test("voice step: the echo of a label never reopens its link", () => {
  const opened = voiceStep(lines, voiceStart(0), [said("the big idea")], { links: LINKS }).voice;
  // The label stays in the last 3 results for a while; the main screen has moved on to another page meanwhile.
  const echo = voiceStep(lines, opened, [said("the big idea"), said("one"), said("two")], { links: LINKS, shownUrl: "https://other.test/" });
  assert.equal(echo.link, null, "the same result again: an echo, quiet");
  assert.deepEqual([echo.voice.linkKey, echo.voice.linkAt], ["0:0", 0]);
});

test("voice step: the label said again reopens its link only when the main screen shows something else", () => {
  const opened = voiceStep(lines, voiceStart(0), [said("the big idea")], { links: LINKS }).voice;
  const history = [said("the big idea"), said("one"), said("two"), said("now the big idea")];
  const elsewhere = voiceStep(lines, opened, history, { links: LINKS, shownUrl: "https://other.test/" });
  assert.equal(elsewhere.link?.key, "0:0", "said again while another page shows: opens");
  assert.deepEqual([elsewhere.voice.linkKey, elsewhere.voice.linkAt], ["0:0", 3]);
  const still = voiceStep(lines, opened, history, { links: LINKS, shownUrl: "https://big.test/" });
  assert.equal(still.link, null, "already on the main screen: stays quiet");
  assert.equal(still.voice.linkAt, 3, "but remembers where, so its own echo stays quiet too");
  const later = voiceStep(lines, still.voice, [...history, said("five")], { links: LINKS, shownUrl: "https://other.test/" });
  assert.equal(later.link, null, "that echo does not reopen it once the main screen moves on");
});

test("voice step: another link's label opens at once", () => {
  const opened = voiceStep(lines, voiceStart(0), [said("the big idea")], { links: LINKS }).voice;
  const r = voiceStep(lines, opened, [said("the big idea"), said("patchstack")], { links: LINKS, shownUrl: "https://big.test/" });
  assert.equal(r.link?.key, "0:1");
  assert.deepEqual([r.voice.linkKey, r.voice.linkAt], ["0:1", 1]);
});

test("voice step: a label said again split over two results reopens its link", () => {
  // The speech service can end a result in the middle of a label. Said again later, while the main screen
  // shows another page, it opens again, like a label heard in one piece.
  const opened = voiceStep(lines, voiceStart(0), [said("the big idea")], { links: LINKS }).voice;
  const history = [said("the big idea"), said("one"), said("two"), said("three"), said("now the big"), said("idea")];
  const r = voiceStep(lines, opened, history, { links: LINKS, shownUrl: "https://other.test/" });
  assert.equal(r.link?.key, "0:0");
  assert.equal(r.voice.linkAt, 4, "heard from the result it starts in");
  const echo = voiceStep(lines, r.voice, [...history, said("seven")], { links: LINKS, shownUrl: "https://other.test/" });
  assert.equal(echo.link, null, "and its echo stays quiet");
});

test("voice step: a label heard in an interim result does not open again when that result turns final", () => {
  const a = voiceStep(lines, voiceStart(0), [said("the big idea", false)], { links: LINKS });
  assert.deepEqual([a.link?.key, a.voice.linkAt, a.voice.final], ["0:0", 0, 0]);
  const b = voiceStep(lines, a.voice, [said("the big idea")], { links: LINKS, shownUrl: "https://other.test/" });
  assert.equal(b.link, null, "the same result, now final: an echo");
  assert.equal(b.voice.final, 1);
});

test("voice step: a label that starts before the last 3 results is not heard", () => {
  const r = voiceStep(lines, voiceStart(0), [said("now the big"), said("idea"), said("one"), said("two")], { links: LINKS });
  assert.equal(r.link, null);
});

test("voice step: in a new session the remembered label reopens its link when another page shows", () => {
  const first = voiceStep(lines, voiceStart(0), [said("writing scripts"), said("the big idea")], { links: LINKS });
  assert.deepEqual([first.voice.final, first.voice.linkAt], [2, 1]);
  const fresh = voiceSession(first.voice);
  const r = voiceStep(lines, fresh, [said("takes too long the big idea")], { links: LINKS, shownUrl: "https://other.test/" });
  assert.equal(r.link?.key, "0:0", "result 0 of the new session is later than anything before");
  assert.equal(r.voice.final, 1, "the new session's result is followed from 0");
  assert.deepEqual(r.voice.follow, followWords(lines, first.voice.follow, speechWords("takes too long the big idea")));
  const quiet = voiceStep(lines, fresh, [said("takes too long the big idea")], { links: LINKS, shownUrl: "https://big.test/" });
  assert.equal(quiet.link, null, "already on the main screen: quiet");
});

test("voice session: a new session counts its results from 0 and keeps the place and the link", () => {
  const v = { follow: { line: 4, word: 1, heard: [], moved: true }, final: 6, linkKey: "0:1", linkAt: 5 };
  assert.deepEqual(voiceSession(v), { ...v, final: 0, linkAt: -1 });
  assert.equal(v.final, 6, "not changed in place");
});

test("voice at the reading line: a new line starts there, the same line keeps the place in it", () => {
  const v = { follow: { line: 4, word: 2, heard: [{ w: "sam", used: true }], moved: true }, final: 2, linkKey: "0:0", linkAt: 1 };
  assert.equal(voiceAt(v, 4), v, "still on the followed line: unchanged");
  assert.deepEqual(voiceAt(v, 6), { ...v, follow: followStart(6) });
  assert.deepEqual(voiceAt(v, -1).follow, followStart(0), "before the first line counts as the first");
  assert.equal(voiceAt({ ...v, follow: followStart(0) }, -1).follow.line, 0);
});

test("app.js only feeds results in and draws: the follow decisions live here", () => {
  const app = readFileSync(resolve(import.meta.dirname, "../src/app.js"), "utf8");
  for (const name of ["followWords", "heardLink", "followStart"]) {
    assert.ok(!new RegExp(`\\b${name}\\(`).test(app), `app.js calls ${name} itself`);
  }
  assert.match(app, /\bvoiceStep\(/);
});
