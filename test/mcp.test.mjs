import { test } from "node:test";
import assert from "node:assert/strict";
import "./runtime.mjs";
import { connectionPrompt, openPrompt } from "../src/agent.mjs";
import { decodeScript, EXAMPLE_SCRIPT, PRESETS, readHash } from "../src/core.mjs";
import { RATE_LIMIT } from "../src/limiter.mjs";
import { handleMcp, MAX_BODY_BYTES, memoryLimiter, NOT_OPEN } from "../src/mcp.mjs";
import { MAX_AGE_MS, newToken } from "../src/token.mjs";

const { default: worker } = await import("../src/worker.mjs");

const URL_ = "https://prompter.techies.tools/mcp";
const open = { async limit() { return { success: true }; } };
let nextId = 1;

function post(body, { limiter = open, guard = open, headers = {} } = {}) {
  return handleMcp(new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), { limiter, guard });
}

async function rpc(method, params, opts) {
  const id = nextId++;
  const res = await post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, opts);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, id);
  return body;
}

const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;

test("initialize negotiates the protocol and declares tools and prompts", async () => {
  const { result } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.deepEqual(Object.keys(result.capabilities).sort(), ["prompts", "tools"]);
  assert.equal(result.serverInfo.name, "techies-prompter");
  assert.match(result.instructions, /Nothing is stored/);
  const other = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(other.result.protocolVersion, "2025-11-25");
});

test("notifications get 202 with no body; ping answers", async () => {
  const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
  assert.deepEqual((await rpc("ping")).result, {});
});

test("tools/list returns the three tools with schemas", async () => {
  const { result } = await rpc("tools/list");
  assert.deepEqual(result.tools.map((t) => t.name), ["get_format", "check_script", "make_prompter_link"]);
  for (const t of result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.annotations.readOnlyHint, true);
  }
  assert.deepEqual(result.tools[1].inputSchema.required, ["markdown"]);
});

test("get_format returns the guide for each preset", async () => {
  assert.match((await call("get_format", { preset: "lex" })).content[0].text, /Preset: lex[\s\S]*five words or fewer/);
  assert.match((await call("get_format", {})).content[0].text, /Preset: default/);
  assert.equal((await call("get_format", { preset: "x" })).isError, true);
});

test("check_script lists problems with section and line", async () => {
  const ok = await call("check_script", { markdown: EXAMPLE_SCRIPT, preset: "lex" });
  assert.equal(ok.structuredContent.ok, true);
  assert.match(ok.content[0].text, /No problems/);
  const bad = await call("check_script", { markdown: "### **INTRO · 00:00**\n\nThis line is much too long for lex style.", preset: "lex" });
  assert.equal(bad.structuredContent.ok, false);
  const p = bad.structuredContent.problems.find((x) => x.code === "line-too-long");
  assert.deepEqual([p.section, p.line, p.severity], [1, 3, "error"]);
  assert.match(bad.content[0].text, /error line 3/);
});

test("make_prompter_link returns a #s= link that decodes to the script", async () => {
  const r = await call("make_prompter_link", { markdown: EXAMPLE_SCRIPT, preset: "lex" });
  const { link } = r.structuredContent;
  assert.ok(link.startsWith("https://prompter.techies.tools/#s="));
  const { data, preset } = readHash(new URL(link).hash);
  assert.equal(preset, "lex");
  assert.equal(await decodeScript(data), EXAMPLE_SCRIPT);
  assert.ok(r.content[0].text.includes(link));
  assert.match(r.content[0].text, /nothing is stored/);
  const warn = await call("make_prompter_link", { markdown: "### **A**\nThis line is fine for default but it is long, more than ten." });
  assert.equal(warn.structuredContent.preset, "default");
  assert.ok(warn.structuredContent.warnings >= 1);
});

test("tool argument errors are tool results with isError", async () => {
  assert.equal((await call("check_script", {})).isError, true);
  assert.equal((await call("check_script", { markdown: "   " })).isError, true);
  assert.equal((await call("make_prompter_link", { markdown: "x".repeat(100_001) })).isError, true);
  assert.equal((await call("make_prompter_link", { markdown: "### A", preset: "nope" })).isError, true);
});

test("prompts/list and prompts/get write_prompter_script", async () => {
  const list = (await rpc("prompts/list")).result.prompts;
  assert.deepEqual(list.map((p) => p.name), ["write_prompter_script"]);
  const got = (await rpc("prompts/get", { name: "write_prompter_script", arguments: { topic: "Baking bread", preset: "lex" } })).result;
  assert.equal(got.messages[0].role, "user");
  const text = got.messages[0].content.text;
  assert.match(text, /Baking bread/);
  assert.match(text, /get_format tool with preset "lex"/);
  assert.match(text, /one short question at a time/i);
  assert.match(text, /make_prompter_link/);
});

test("JSON-RPC errors: unknown method, unknown tool and prompt, bad JSON, invalid request", async () => {
  assert.equal((await rpc("nope/nope")).error.code, -32601);
  assert.equal((await rpc("tools/call", { name: "nope" })).error.code, -32602);
  assert.equal((await rpc("prompts/get", { name: "nope" })).error.code, -32602);
  const bad = await post("{not json");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  const invalid = await post({ id: 1, method: "ping" });
  assert.equal((await invalid.json()).error.code, -32600);
});

test("batches answer each request and skip notifications", async () => {
  const res = await post([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: "b", method: "tools/list" }]);
  const body = await res.json();
  assert.deepEqual(body.map((r) => r.id), ["a", "b"]);
  assert.equal((await post([])).status, 400);
});

test("GET is 405, OPTIONS is a CORS preflight", async () => {
  const get = await handleMcp(new Request(URL_, { headers: { accept: "text/event-stream" } }), { limiter: open, guard: open });
  assert.equal(get.status, 405);
  assert.match(get.headers.get("allow"), /POST/);
  const pre = await handleMcp(new Request(URL_, { method: "OPTIONS" }), { limiter: open, guard: open });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-headers"), /Mcp-Protocol-Version/);
});

test("size cap: bodies above 200 KB get 413, by header or by streamed length", async () => {
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_script", arguments: { markdown: "x".repeat(MAX_BODY_BYTES) } } });
  const res = await post(big);
  assert.equal(res.status, 413);
  assert.match((await res.json()).error.message, /200 KB/);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 30; i++) c.enqueue(new Uint8Array(10_000).fill(32)); c.close(); } });
  const chunked = await handleMcp(new Request(URL_, { method: "POST", body: stream, duplex: "half" }), { limiter: open, guard: open });
  assert.equal(chunked.status, 413);
  const justUnder = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }).padEnd(MAX_BODY_BYTES - 1, " "));
  assert.equal(justUnder.status, 200);
});

test("rate limit: 429 with Retry-After once the per-IP limit is spent", async () => {
  let t = 0;
  const guard = memoryLimiter(RATE_LIMIT, 60_000, () => t);
  const headers = { "cf-connecting-ip": "203.0.113.9" };
  for (let i = 0; i < RATE_LIMIT; i++) assert.equal((await post({ jsonrpc: "2.0", id: i, method: "ping" }, { guard, headers })).status, 200);
  const limited = await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { guard, headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const guardMessage = (await limited.json()).error.message;
  assert.match(guardMessage, /Limit: 60 per minute\. Try again in 60 seconds/);
  assert.doesNotMatch(guardMessage, /10 seconds/, "names only the limit that refused");
  assert.equal((await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { guard, headers: { "cf-connecting-ip": "203.0.113.10" } })).status, 200);
  t = 60_000;
  assert.equal((await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { guard, headers })).status, 200);
  // A full guard drops expired keys, then the oldest, never everyone at once.
  let s = 0;
  const small = memoryLimiter(1, 60_000, () => s, 2);
  await small.limit({ key: "a" });
  s = 30_000; await small.limit({ key: "b" });
  s = 60_000; await small.limit({ key: "c" }); // map full: "a" has expired and is dropped
  assert.equal((await small.limit({ key: "b" })).success, false, "b keeps its count");
  await small.limit({ key: "d" }); // map full, nothing expired: oldest ("b") is dropped
  assert.equal((await small.limit({ key: "c" })).success, false, "c keeps its count");
  assert.equal((await small.limit({ key: "b" })).success, true, "b was the one evicted");
  // The Durable Object limiter can refuse on its own, with its own Retry-After.
  const refuse = { async limit() { return { success: false, retryAfter: 7, max: 10, ms: 10_000 }; } };
  const byObject = await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { limiter: refuse });
  assert.equal(byObject.status, 429);
  assert.equal(byObject.headers.get("retry-after"), "7");
  const body = await byObject.json();
  assert.equal(body.error.code, -32000);
  assert.match(body.error.message, /Limit: 10 per 10 seconds\. Try again in 7 seconds/);
});

test("the in-isolate guard refuses before the Durable Object is asked", async () => {
  let asked = 0;
  const limiter = { async limit() { asked++; return { success: true }; } };
  const refuse = { async limit() { return { success: false }; } };
  const refused = await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { guard: refuse, limiter });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "60");
  assert.match((await refused.json()).error.message, /Try again in 60 seconds/);
  assert.equal(asked, 0);
  assert.equal((await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { limiter })).status, 200);
  assert.equal(asked, 1);
});

test("the Worker sends /mcp to the handler (with the Durable Object) and everything else to assets", async () => {
  const seen = [];
  const env = {
    ASSETS: { fetch: (req) => { seen.push(new URL(req.url).pathname); return new Response("asset"); } },
    MCP_LIMITER: {
      idFromName(name) { seen.push(`id:${name}`); return name; },
      get(id) { return { fetch: async (url, init) => { seen.push(`do:${init.method}:${init.body ?? ""}`); return new Response(null, { status: 429, headers: { "Retry-After": "9" } }); } }; },
    },
  };
  assert.equal(await (await worker.fetch(new Request("https://prompter.techies.tools/"), env)).text(), "asset");
  assert.deepEqual(seen, ["/"], "the static page never touches the Durable Object");
  const limited = await worker.fetch(new Request(URL_, { method: "POST", body: "{}", headers: { "cf-connecting-ip": "198.51.100.1" } }), env);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "9");
  assert.equal(seen.length, 3);
  assert.match(seen[1], /^id:[0-9a-f]{64}$/, "the object is named by a hash");
  assert.ok(!seen.join(" ").includes("198.51.100.1"), "the raw IP never reaches the Durable Object");
  assert.equal(seen[2], "do:POST:", "the object gets no body, so never a script");
});

// The messages the page copies (Wait for MCP, and Copy MCP in an offline
// copy) tell an assistant how to talk to this server with curl. Their facts
// (headers, protocol version, tools, preset argument) must stay true.
const toolsIn = (message) => [...message.matchAll(/`(\w+_\w+)`/g)].map((m) => m[1]);

test("the offline Copy MCP message matches the open server", async () => {
  const message = openPrompt("https://prompter.techies.tools/mcp", "lex");
  const version = message.match(/protocolVersion "([\d-]+)"/)?.[1];
  assert.match(message, /Content-Type: application\/json[\s\S]*Accept: application\/json, text\/event-stream/);
  assert.match(message, /Server: `https:\/\/prompter\.techies\.tools\/mcp` \(open, no sign-in\)[\s\S]*Do not modify MCP configuration[\s\S]*style preset `lex`/);
  const { result } = await rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "curl", version: "1" } });
  assert.equal(result.protocolVersion, version, "the server speaks the version the message asks for");
  const tools = (await rpc("tools/list")).result.tools.map((t) => t.name);
  assert.deepEqual(toolsIn(message), ["get_format", "check_script", "make_prompter_link"]);
  for (const name of toolsIn(message)) assert.ok(tools.includes(name), `the open server has ${name}`);
  for (const preset of Object.keys(PRESETS)) {
    assert.notEqual((await call("get_format", { preset })).isError, true, `get_format takes the preset ${preset}`);
    assert.notEqual((await call("make_prompter_link", { preset, markdown: EXAMPLE_SCRIPT })).isError, true, `make_prompter_link takes the preset ${preset}`);
  }
});

/* ---------- With an agent token: the person's open tab through the relay ---------- */
const { token: TOKEN, born: BORN } = newToken();
// A fake relay and tab: records ops and answers like the relay object would.
function fakeRelay({ tab = true, authorized = true, answers = {} } = {}) {
  const ops = [];
  return {
    ops,
    relayFor: (token) => ({
      async op(m) {
        ops.push({ token, ...m });
        if (typeof authorized === "function" ? !authorized(m) : !authorized) return { status: "unauthorized" };
        if (m.op !== "call") return { status: "ok" };
        if (!tab) return { status: "no-tab" };
        const a = answers[m.tool];
        if (a === "timeout") return { status: "timeout" };
        if (a?.error) return { status: "ok", error: a.error };
        return { status: "ok", result: a ?? { opened: true } };
      },
    }),
  };
}
async function live(method, params, { relay = fakeRelay(), token = TOKEN, origin, id = nextId++, now } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
  if (origin) headers.origin = origin;
  const res = await handleMcp(new Request(URL_, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }) }),
    { limiter: open, guard: open, relayFor: relay.relayFor, ...(now ? { now } : {}) });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null, headers: res.headers, relay };
}
const liveCall = (name, args, opts) => live("tools/call", { name, arguments: args }, opts);

test("token: initialize passes the agent's name and version to the tab, cut short; live instructions", async () => {
  const relay = fakeRelay();
  const r = await live("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "claude-code".repeat(10), version: "2.1" } }, { relay });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, "2025-11-25");
  assert.match(r.body.result.instructions, /show_script[\s\S]*not stored/);
  const agent = relay.ops.find((o) => o.op === "agent");
  assert.deepEqual([agent.name.length, agent.version, agent.token, agent.born], [60, "2.1", TOKEN, BORN]);
  assert.ok(relay.ops.every((o) => o.born === BORN), "every op carries the token's birth time");
});

test("token: tools/list adds show_script and get_open_script to the open tools", async () => {
  const r = await live("tools/list");
  assert.deepEqual(r.body.result.tools.map((t) => t.name), ["get_format", "check_script", "make_prompter_link", "show_script", "get_open_script"]);
  const show = r.body.result.tools[3];
  assert.deepEqual([show.inputSchema.required, show.annotations.readOnlyHint, show.annotations.destructiveHint], [["markdown"], false, false]);
  for (const name of ["get_format", "check_script", "make_prompter_link"]) assert.equal((await liveCall(name, { markdown: EXAMPLE_SCRIPT, preset: "lex", ...(name === "get_format" ? { markdown: undefined } : {}) })).body.result.isError, undefined, name);
});

test("token: show_script checks the script, then sends it with its preset to the tab", async () => {
  const relay = fakeRelay();
  const r = await liveCall("show_script", { markdown: EXAMPLE_SCRIPT, preset: "lex" }, { relay });
  assert.equal(r.body.result.isError, undefined);
  assert.match(r.body.result.content[0].text, /^Opened in the prompter \(preset "lex"\)/);
  assert.equal(r.body.result.structuredContent.shown, true);
  assert.deepEqual(Object.keys(r.body.result.structuredContent).sort(), ["errors", "ok", "preset", "problems", "sections", "shown", "warnings"], "the checker's report comes back");
  const call = relay.ops.find((o) => o.op === "call");
  assert.deepEqual([call.tool, call.args, call.timeout], ["show_script", { markdown: EXAMPLE_SCRIPT, preset: "lex" }, 10_000]);
  const plain = fakeRelay();
  await liveCall("show_script", { markdown: EXAMPLE_SCRIPT }, { relay: plain });
  assert.equal(plain.ops.find((o) => o.op === "call").args.preset, "default");
  for (const bad of [{}, { markdown: "  " }, { markdown: "x".repeat(100_001) }, { markdown: EXAMPLE_SCRIPT, preset: "loud" }]) {
    const refused = fakeRelay();
    const res = await liveCall("show_script", bad, { relay: refused });
    assert.equal(res.body.result.isError, true, JSON.stringify(bad).slice(0, 40));
    assert.equal(refused.ops.some((o) => o.op === "call"), false, "a bad script never reaches the tab");
  }
});

test("token: get_open_script returns the tab's script and preset, or that none is open", async () => {
  const withScript = fakeRelay({ answers: { get_open_script: { open: true, markdown: EXAMPLE_SCRIPT, preset: "lex" } } });
  const r = await liveCall("get_open_script", {}, { relay: withScript });
  assert.deepEqual(r.body.result.structuredContent, { open: true, preset: "lex", markdown: EXAMPLE_SCRIPT });
  assert.ok(r.body.result.content[0].text.endsWith(EXAMPLE_SCRIPT));
  const none = await liveCall("get_open_script", {}, { relay: fakeRelay({ answers: { get_open_script: { open: false } } }) });
  assert.deepEqual(none.body.result.structuredContent, { open: false });
  assert.match(none.body.result.content[0].text, /start screen/);
});

test("token: no tab, a slow tab and a tab error become tool errors", async () => {
  const closed = await liveCall("show_script", { markdown: EXAMPLE_SCRIPT }, { relay: fakeRelay({ tab: false }) });
  assert.deepEqual([closed.body.result.isError, closed.body.result.content[0].text], [true, NOT_OPEN]);
  const slow = await liveCall("get_open_script", {}, { relay: fakeRelay({ answers: { get_open_script: "timeout" } }) });
  assert.match(slow.body.result.content[0].text, /did not answer in time/);
  const failed = await liveCall("show_script", { markdown: EXAMPLE_SCRIPT }, { relay: fakeRelay({ answers: { show_script: { error: "No sections found." } } }) });
  assert.deepEqual([failed.body.result.isError, failed.body.result.content[0].text], [true, "No sections found."]);
});

test("token: Disconnect MCP (revoked) or expiry → 401 for every request, also mid-call", async () => {
  for (const method of ["initialize", "tools/list", "ping"]) {
    const r = await live(method, undefined, { relay: fakeRelay({ authorized: false }) });
    assert.equal(r.status, 401, method);
    assert.equal(r.headers.get("www-authenticate"), "Bearer");
    assert.equal(r.body.error.code, -32001);
    assert.match(r.body.error.message, /Disconnect MCP/);
  }
  const midCall = await liveCall("show_script", { markdown: EXAMPLE_SCRIPT }, { relay: fakeRelay({ authorized: (m) => m.op !== "call" }) });
  assert.equal(midCall.status, 401);
  const notification = await live("notifications/initialized", undefined, { relay: fakeRelay({ authorized: false }), id: null });
  assert.equal(notification.status, 401);
  const old = fakeRelay();
  const expired = await live("tools/list", undefined, { relay: old, now: () => BORN + MAX_AGE_MS });
  assert.equal(expired.status, 401);
  assert.equal(old.ops.length, 0, "an expired token never reaches a relay");
  const malformed = await live("tools/list", undefined, { token: "tp1-nope" });
  assert.equal(malformed.status, 401);
});

test("token: another website's page is refused; without a token (or with another kind) /mcp stays open", async () => {
  const foreign = await live("tools/list", undefined, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  const own = await live("tools/list", undefined, { origin: "https://prompter.techies.tools" });
  assert.equal(own.status, 200);
  const other = await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { headers: { authorization: "Bearer some-other-token" } });
  assert.deepEqual((await other.json()).result.tools.map((t) => t.name), ["get_format", "check_script", "make_prompter_link"]);
  const notOpen = await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "show_script", arguments: { markdown: EXAMPLE_SCRIPT } } });
  assert.match((await notOpen.json()).error.message, /Unknown tool: show_script/, "the tab tools need a token");
});

test("token: the write_prompter_script prompt ends with show_script", async () => {
  const r = await live("prompts/get", { name: "write_prompter_script", arguments: { topic: "MCP", preset: "lex" } });
  assert.match(r.body.result.messages[0].content.text, /6\. Call show_script with preset "lex"/);
  const plain = await rpc("prompts/get", { name: "write_prompter_script", arguments: { topic: "MCP" } });
  assert.match(plain.result.messages[0].content.text, /6\. Call make_prompter_link/);
});

test("the Wait for MCP message matches the server with a token", async () => {
  const url = "https://prompter.techies.tools/mcp";
  const message = connectionPrompt(url, TOKEN, "lex");
  assert.match(message, /temporary, direct MCP connection over streamable HTTP/);
  assert.ok(message.includes(`Server: \`${url}\``));
  assert.ok(message.includes(`Authorization: \`Bearer ${TOKEN}\``));
  assert.match(message, /Do not modify MCP configuration, install anything, create helper files/);
  assert.match(message, /Keep the token in memory; never save it or repeat it/);
  assert.match(message, /headers `Authorization`, `Content-Type: application\/json` and `Accept: application\/json, text\/event-stream`/);
  assert.match(message, /timeout of at least 40 seconds/);
  assert.match(message, /style preset `lex`/);
  assert.match(message, /Disconnect MCP: calls then fail with 401/);
  const version = message.match(/protocolVersion "([\d-]+)"/)?.[1];
  assert.equal(version, "2025-11-25");
  const init = await live("initialize", { protocolVersion: version, clientInfo: { name: "curl", version: "8" } });
  assert.equal(init.body.result.protocolVersion, version);
  const tools = (await live("tools/list")).body.result.tools.map((t) => t.name);
  assert.deepEqual(toolsIn(message), ["get_format", "check_script", "show_script", "get_open_script", "make_prompter_link"]);
  for (const name of toolsIn(message)) assert.ok(tools.includes(name), `the server has ${name} with a token`);
  for (const preset of Object.keys(PRESETS)) {
    assert.equal((await liveCall("show_script", { preset, markdown: EXAMPLE_SCRIPT })).body.result.isError, undefined, `show_script takes the preset ${preset}`);
  }
});
