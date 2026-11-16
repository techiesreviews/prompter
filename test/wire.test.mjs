// The live relay's wire list (src/wire.mjs): the one place the tab, the Worker and the relay take the
// subprotocol, the close codes, the paths and the message shapes from, so the three cannot drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RELAY_CLOSE, RELAY_MESSAGES, RELAY_PATH, RELAY_PROTOCOL, RELAY_TOKEN_PREFIX, TOKEN_MAX_AGE_MS, TOKEN_PATH,
  readRelayMessage, relayMessage, relayProtocols,
} from "../src/wire.mjs";
import { MAX_AGE_MS } from "../src/token.mjs";

const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

test("the wire's names and numbers", () => {
  assert.equal(RELAY_PROTOCOL, "prompter");
  assert.equal(RELAY_TOKEN_PREFIX, "t.");
  assert.deepEqual(RELAY_CLOSE, { elsewhere: 4001, forget: 4003 });
  assert.equal(RELAY_PATH, "/api/relay");
  assert.equal(TOKEN_PATH, "/api/agent-token");
  assert.equal(TOKEN_MAX_AGE_MS, 8 * 60 * 60 * 1000);
  assert.equal(MAX_AGE_MS, TOKEN_MAX_AGE_MS, "the Worker's token age is the wire's");
  assert.deepEqual(relayProtocols("tp1-abc"), ["prompter", "t.tp1-abc"], "the token travels as a subprotocol, never in the URL");
  assert.deepEqual(Object.keys(RELAY_MESSAGES).toSorted(), ["agent", "call", "ping", "pong", "ready", "result", "revoke"]);
});

test("a message keeps its type and only the fields the list names for it", () => {
  assert.deepEqual(relayMessage("call", { id: "1", tool: "show_script", args: { markdown: "x" }, extra: true }), { type: "call", id: "1", tool: "show_script", args: { markdown: "x" } });
  assert.deepEqual(relayMessage("result", { id: "1", result: { open: false } }), { type: "result", id: "1", result: { open: false } }, "an unset field is left out");
  assert.deepEqual(relayMessage("agent", { name: "claude-code", version: "2", createdAt: 1 }), { type: "agent", name: "claude-code", version: "2" });
  assert.deepEqual(relayMessage("revoke"), { type: "revoke" });
  // The relay answers this exact text without waking up, so the tab's ping must be byte for byte the same.
  assert.equal(JSON.stringify(relayMessage("ping")), '{"type":"ping"}');
  assert.equal(JSON.stringify(relayMessage("pong")), '{"type":"pong"}');
  for (const type of ["hello", "toString", "__proto__", ""]) assert.throws(() => relayMessage(type), /Not a relay message/, type);
});

test("reading a message: known types only, anything else is dropped", () => {
  assert.deepEqual(readRelayMessage('{"type":"agent","name":"Claude"}'), { type: "agent", name: "Claude" });
  for (const text of ["not json", "null", "1", '"call"', "[]", '{"type":"hello"}', '{"type":"toString"}', '{"id":"1"}', '{"type":["agent"]}']) {
    assert.equal(readRelayMessage(text), null, text);
  }
});

test("no file types the wire's codes, protocol or messages by hand", () => {
  for (const file of ["relay.mjs", "worker.mjs", "relay-link.mjs", "app.js"]) {
    const code = source(file);
    assert.doesNotMatch(code, /\b400[13]\b/, `${file}: close codes come from RELAY_CLOSE`);
    assert.doesNotMatch(code, /["'`]prompter["'`]/, `${file}: the subprotocol comes from RELAY_PROTOCOL`);
    assert.doesNotMatch(code, /["'`]t\.["'`]|`t\.\$\{/, `${file}: the token prefix comes from the wire`);
    assert.doesNotMatch(code, /\{\s*\\?"type\\?"\s*:/, `${file}: messages are made with relayMessage`);
    assert.doesNotMatch(code, /["'`]\/api\/(relay|agent-token)["'`]/, `${file}: the paths come from the wire`);
  }
  // A type compared by name must be one the list knows, so a typo cannot quietly drop a message.
  for (const file of ["relay.mjs", "relay-link.mjs"]) {
    const compared = [...source(file).matchAll(/\btype\s*===\s*"([^"]*)"|case\s*"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    assert.ok(compared.length, `${file} reads messages`);
    for (const type of compared) assert.ok(Object.hasOwn(RELAY_MESSAGES, type), `${file}: "${type}" is not in RELAY_MESSAGES`);
  }
  for (const file of ["relay.mjs", "worker.mjs", "token.mjs"]) assert.match(source(file), /from "\.\/wire\.mjs"/, `${file} reads the wire`);
  assert.match(source("relay-link.mjs"), /from "\.\/wire\.mjs"/, "the tab link reads the wire");
});
