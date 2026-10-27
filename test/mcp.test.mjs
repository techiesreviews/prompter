import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeScript, EXAMPLE_SCRIPT, readHash } from "../src/core.mjs";
import { handleMcp, MAX_BODY_BYTES, memoryLimiter, RATE_LIMIT } from "../src/mcp.mjs";
import worker from "../src/worker.mjs";

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
  assert.equal((await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { guard, headers: { "cf-connecting-ip": "203.0.113.10" } })).status, 200);
  t = 60_000;
  assert.equal((await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { guard, headers })).status, 200);
  // The binding can refuse on its own, even when the in-isolate guard allows.
  const refuse = { async limit() { return { success: false }; } };
  assert.equal((await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { limiter: refuse })).status, 429);
});

test("the Worker sends /mcp to the handler (with its binding) and everything else to assets", async () => {
  const seen = [];
  const env = {
    ASSETS: { fetch: (req) => { seen.push(new URL(req.url).pathname); return new Response("asset"); } },
    MCP_RATE_LIMITER: { async limit({ key }) { seen.push(`limit:${key}`); return { success: false }; } },
  };
  assert.equal(await (await worker.fetch(new Request("https://prompter.techies.tools/"), env)).text(), "asset");
  const limited = await worker.fetch(new Request(URL_, { method: "POST", body: "{}", headers: { "cf-connecting-ip": "198.51.100.1" } }), env);
  assert.equal(limited.status, 429);
  assert.deepEqual(seen, ["/", "limit:198.51.100.1"]);
});
