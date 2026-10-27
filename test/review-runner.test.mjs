import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeResult } from "../scripts/agents/agent-run.mjs";

const run = (modelUsage, extra = {}) => JSON.stringify({ subtype: "success", result: "REVIEW_STATUS: complete", modelUsage, ...extra });
const usage = (outputTokens) => ({ outputTokens });

test("review runner: the requested model alone passes", () => {
  assert.equal(claudeResult(run({ "claude-opus-5-5": usage(100) }), "claude-opus-5-5"), "REVIEW_STATUS: complete");
});

test("review runner: a small Claude helper passes, a large one fails", () => {
  assert.ok(claudeResult(run({ "claude-opus-5-5": usage(100), "claude-haiku-5-5": usage(10) }), "claude-opus-5-5"));
  assert.throws(() => claudeResult(run({ "claude-opus-5-5": usage(100), "claude-haiku-5-5": usage(11) }), "claude-opus-5-5"), /requested model/);
});

test("review runner: a helper with no output from the requested model fails", () => {
  assert.throws(() => claudeResult(run({ "claude-opus-5-5": usage(0), "claude-haiku-5-5": usage(0) }), "claude-opus-5-5"), /requested model/);
});

test("review runner: non-Claude helpers and a missing requested model fail", () => {
  assert.throws(() => claudeResult(run({ "claude-opus-5-5": usage(1000), "gpt-6.1-sol": usage(1) }), "claude-opus-5-5"), /requested model/);
  assert.throws(() => claudeResult(run({ "claude-haiku-5-5": usage(100) }), "claude-opus-5-5"), /requested model/);
});

test("review runner: result.model duplicating a usage key is not counted twice", () => {
  assert.throws(() => claudeResult(run({ "claude-opus-5-5": usage(100), "claude-haiku-5-5": usage(15) }, { model: "claude-opus-5-5" }), "claude-opus-5-5"), /requested model/);
});
