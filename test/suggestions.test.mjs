import { test } from "node:test";
import assert from "node:assert/strict";
import { readSuggestions, STRIP_STALE_MS, suggestionStrip, SUGGESTION_MAX_CHARS } from "../src/suggestions.mjs";

test("readSuggestions keeps a question with its number, a talking point and a hook, on one line each", () => {
  assert.deepEqual(readSuggestions({ question: "  What is a\n session? ", number: 6, point: "The cookie is the proof.", hook: "No password. No code." }), {
    slots: { question: { text: "What is a session?", number: 6 }, point: { text: "The cookie is the proof." }, hook: { text: "No password. No code." } },
  });
  assert.deepEqual(readSuggestions({ hook: "Only a hook" }), { slots: { hook: { text: "Only a hook" } } }, "any one of the three is enough");
  assert.deepEqual(readSuggestions({ question: "A new question" }), { slots: { question: { text: "A new question" } } }, "a new question has no number");
});

test("readSuggestions refuses an empty push, a number without its question, and text that is too long or not text", () => {
  for (const bad of [{}, { question: "  " }, { number: 3 }, { question: "Q?", number: 0 }, { question: "Q?", number: 2.5 }, { point: 7 }, { hook: "x".repeat(SUGGESTION_MAX_CHARS + 1) }, null, []]) {
    assert.equal(typeof readSuggestions(bad).error, "string", JSON.stringify(bad));
  }
});

test("the strip shows what was pushed, a tap uses a slot once, and the next push reports it once", () => {
  let t = 1000;
  const strip = suggestionStrip({ now: () => t });
  assert.equal(strip.shown(), false, "nothing pushed: no strip");
  assert.deepEqual(strip.push(readSuggestions({ question: "What is a session?", number: 6, point: "P1", hook: "H1" }).slots), []);
  assert.equal(strip.shown(), true);
  assert.deepEqual(strip.slots.question, { text: "What is a session?", number: 6, used: false });
  assert.equal(strip.use("question"), true);
  assert.equal(strip.use("question"), false, "a used slot stays used");
  assert.equal(strip.use("hook"), true);
  assert.deepEqual(strip.slots.question.used, true);
  // The same words again (an idle round) keep the state and report the taps once.
  assert.deepEqual(strip.push(readSuggestions({ question: "What is a session?", number: 6, point: "P1", hook: "H1" }).slots), [
    { kind: "question", text: "What is a session?", number: 6 },
    { kind: "hook", text: "H1" },
  ]);
  assert.deepEqual([strip.slots.question.used, strip.slots.point.used, strip.slots.hook.used], [true, false, true], "unchanged slots keep their state");
  assert.deepEqual(strip.push(readSuggestions({ question: "What is a session?", number: 6, point: "P1", hook: "H1" }).slots), [], "reported once only");
  // New words take the slot fresh; a slot left out is empty.
  strip.push(readSuggestions({ question: "Where is it kept?", number: 7, point: "P2" }).slots);
  assert.deepEqual([strip.slots.question.used, strip.slots.point.used, strip.slots.hook], [false, false, undefined]);
  assert.equal(strip.use("hook"), false, "an empty slot cannot be used");
});

test("the strip hides by itself when no push came for a while, and clear hides it and reports the last taps", () => {
  let t = 0;
  const strip = suggestionStrip({ now: () => t });
  strip.push({ question: { text: "Q?" } });
  t = STRIP_STALE_MS - 1;
  assert.equal(strip.shown(), true);
  assert.equal(strip.staleIn(), 1);
  t = STRIP_STALE_MS;
  assert.equal(strip.shown(), false, "the agent (and so the Producer) went quiet: no dead strip");
  strip.push({ question: { text: "Q?" } });
  assert.equal(strip.shown(), true, "a new push brings it back");
  strip.use("question");
  assert.deepEqual(strip.clear(), [{ kind: "question", text: "Q?" }]);
  assert.equal(strip.shown(), false);
  assert.deepEqual(strip.clear(), [], "nothing twice");
});
