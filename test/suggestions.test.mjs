import { test } from "node:test";
import assert from "node:assert/strict";
import { readSuggestions, SUGGESTION_KINDS, SUGGESTION_MAX_CHARS, SUGGESTION_STALE_MS, SUGGESTIONS_WAITING, suggestionQueue } from "../src/suggestions.mjs";

const q = (text, number) => ({ kind: "question", text, ...(number ? { number } : {}) });

test("readSuggestions keeps up to three items of the five kinds, on one line each, a number only on a prepared question", () => {
  assert.deepEqual(SUGGESTION_KINDS, ["question", "next", "steer", "point", "audience"]);
  assert.equal(SUGGESTIONS_WAITING, 3);
  assert.deepEqual(readSuggestions({ items: [{ kind: "question", text: "  What is a\n session? ", number: 6 }, { kind: "point", text: "The cookie is the proof." }] }), {
    items: [{ kind: "question", text: "What is a session?", number: 6 }, { kind: "point", text: "The cookie is the proof." }],
  });
  assert.deepEqual(readSuggestions({ items: [{ kind: "next", text: "Where is it kept?", number: 7 }, { kind: "steer", text: "Back to logins?" }, { kind: "audience", text: "Do you use 2FA?" }] }).items.map((i) => i.kind), ["next", "steer", "audience"]);
  assert.deepEqual(readSuggestions({ items: [{ kind: "question", text: "A new question" }] }), { items: [{ kind: "question", text: "A new question" }] }, "a new question has no number");
});

test("readSuggestions refuses an empty push, more than three, an unknown kind, a stray number, the old fields and text that is too long", () => {
  const bad = [
    null, [], {}, { items: [] }, { items: "Q?" },
    { items: [q("1"), q("2"), q("3"), q("4")] },
    { items: [{ kind: "hook", text: "Old kind" }] },
    { items: [{ kind: "question", text: "  " }] },
    { items: [{ kind: "question", text: 7 }] },
    { items: [{ kind: "point", text: "P", number: 2 }] },
    { items: [{ kind: "question", text: "Q?", number: 0 }] },
    { items: [{ kind: "next", text: "Q?", number: 2.5 }] },
    { items: [{ kind: "question", text: "x".repeat(SUGGESTION_MAX_CHARS + 1) }] },
    { items: [q("Q?")], extra: 1 },
    { question: "The old shape", number: 3 },
  ];
  for (const args of bad) assert.equal(typeof readSuggestions(args).error, "string", JSON.stringify(args));
});

test("the queue puts the newest on top, keeps at most three, and leaves an item already waiting where it is", () => {
  const box = suggestionQueue({ now: () => 0 });
  assert.equal(box.shown(), false, "nothing pushed: nothing shows");
  assert.equal(box.push([q("Q1", 1)]).added, 1);
  // Listed most important first, so the first of a push ends on top.
  assert.equal(box.push([q("Q2", 2), { kind: "point", text: "P1" }]).added, 2);
  assert.deepEqual(box.items.map((i) => i.text), ["Q2", "P1", "Q1"]);
  // An idle round sends the same again: nothing moves, nothing is new; a changed number is kept.
  assert.equal(box.push([q("Q2", 9), { kind: "point", text: "P1" }]).added, 0);
  assert.deepEqual(box.items.map((i) => [i.text, i.number]), [["Q2", 9], ["P1", undefined], ["Q1", 1]]);
  // A fourth pushes the oldest off.
  box.push([{ kind: "audience", text: "A1" }]);
  assert.deepEqual(box.items.map((i) => i.text), ["A1", "Q2", "P1"]);
  assert.equal(box.items.length, SUGGESTIONS_WAITING);
});

test("the box opens on the newest, moves between the waiting items, and a new item never moves it off the one being read", () => {
  const box = suggestionQueue({ now: () => 0 });
  box.push([q("Q1"), q("Q2"), q("Q3")]);
  assert.equal(box.boxOpen(false), false, "with a script open, the box waits for a tap");
  assert.equal(box.boxOpen(true), true, "with no script (a live show), it shows by itself");
  box.open();
  assert.deepEqual([box.boxOpen(false), box.at, box.current.text], [true, 0, "Q1"]);
  box.move(1);
  box.move(1);
  box.move(1);
  assert.deepEqual([box.at, box.current.text], [2, "Q3"], "stops at the last");
  box.move(-5);
  assert.equal(box.current.text, "Q1", "and at the first");
  box.move(1);
  box.push([{ kind: "point", text: "New" }]);
  assert.deepEqual([box.current.text, box.items.map((i) => i.text)], ["Q2", ["New", "Q1", "Q2"]], "still on Q2; Q3 (the oldest) dropped off");
  // Being read, the oldest stays: the one before it goes instead.
  box.move(1);
  assert.equal(box.current.text, "Q2");
  box.push([{ kind: "steer", text: "S1" }, { kind: "audience", text: "A1" }]);
  assert.deepEqual([box.current.text, box.items.map((i) => i.text)], ["Q2", ["S1", "A1", "Q2"]]);
});

test("Use closes the box and reports the item; Skip shows the next; neither comes back on a later push; reports go out once", () => {
  const box = suggestionQueue({ now: () => 0 });
  box.push([q("Q1", 1), { kind: "point", text: "P1" }, { kind: "next", text: "Q2", number: 2 }]);
  box.open();
  box.move(2);
  assert.deepEqual(box.use(), { kind: "next", text: "Q2", number: 2 });
  assert.deepEqual([box.boxOpen(false), box.items.map((i) => i.text)], [false, ["Q1", "P1"]], "Use closes the box; the rest wait");
  box.open();
  assert.deepEqual(box.skip(), { kind: "question", text: "Q1", number: 1 });
  assert.deepEqual([box.boxOpen(false), box.current.text], [true, "P1"], "Skip shows the next straight away");
  assert.deepEqual(box.skip(), { kind: "point", text: "P1" });
  assert.equal(box.boxOpen(false), false, "skipping the last closes it");
  assert.equal(box.use(), null, "nothing left to use");
  const sent = box.push([q("Q1", 1), { kind: "point", text: "P1" }, { kind: "next", text: "Q2", number: 2 }]);
  assert.deepEqual(sent, {
    added: 0,
    used: [{ kind: "next", text: "Q2", number: 2 }],
    skipped: [{ kind: "question", text: "Q1", number: 1 }, { kind: "point", text: "P1" }],
  }, "the same items again: done ones stay away, and the taps are reported");
  assert.equal(box.shown(), false, "nothing waiting");
  assert.deepEqual(box.push([q("Q3", 3)]), { added: 1, used: [], skipped: [] }, "reported once only");
});

test("the queue hides by itself when no push came for a while; clear empties it and reports the last taps", () => {
  let t = 0;
  const box = suggestionQueue({ now: () => t });
  box.push([q("Q1"), q("Q2")]);
  t = SUGGESTION_STALE_MS - 1;
  assert.deepEqual([box.shown(), box.staleIn()], [true, 1]);
  t = SUGGESTION_STALE_MS;
  assert.equal(box.shown(), false, "the agent (and so the Producer) went quiet: nothing dead stays up");
  box.push([q("Q2")]);
  assert.equal(box.shown(), true, "a new push brings it back");
  box.open();
  box.use();
  box.close();
  assert.equal(box.boxOpen(false), false);
  assert.deepEqual(box.clear(), { used: [{ kind: "question", text: "Q1" }], skipped: [] });
  assert.deepEqual([box.shown(), box.items, box.boxOpen(true)], [false, [], false]);
  assert.deepEqual(box.clear(), { used: [], skipped: [] }, "nothing twice");
  box.push([q("Q1")]);
  assert.equal(box.items.length, 1, "after clear (a new show), an item used before may come again");
});
