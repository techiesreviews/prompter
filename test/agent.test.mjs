import { test } from "node:test";
import assert from "node:assert/strict";
import { agentName } from "../src/agent.mjs";

test("agentName: known agents by their model's name, others made readable", () => {
  assert.equal(agentName("claude-code"), "Claude");
  assert.equal(agentName("my-helper-mcp-client"), "My Helper");
  assert.equal(agentName("MyTool client"), "MyTool");
  assert.equal(agentName(""), "Agent");
  assert.equal(agentName(undefined), "Agent");
  assert.equal(agentName("x".repeat(80)).length, 60);
});
