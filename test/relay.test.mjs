import { test } from "node:test";
import assert from "node:assert/strict";
import { pairs, FakeSocket } from "./runtime.mjs";
import { checkToken, FUTURE_SLACK_MS, MAX_AGE_MS, newToken, relayName, TOKEN_RE } from "../src/token.mjs";

const { default: worker } = await import("../src/worker.mjs");
const { Relay, ALARM_SLACK_MS, PROTOCOL } = await import("../src/relay.mjs");
const lastServer = () => pairs.at(-1)[1];
const T0 = Date.UTC(2026, 9, 28, 20);
const SCRIPT = "### **INTRO · 00:00**\n\nQL: Why?\n\nA secret line nobody may store.";

/* ---------- Tokens ---------- */
test("token: tp1-<birth time>-<32 random bytes>, made and checked by the Worker's clock", () => {
  const { token, born } = newToken(T0);
  assert.match(token, TOKEN_RE);
  assert.equal(parseInt(token.split("-")[1], 36), T0);
  assert.equal(born, T0);
  assert.notEqual(newToken(T0).token, token, "random part");
  assert.deepEqual(checkToken(token, T0 + 1000), { ok: true, born: T0 });
  assert.deepEqual(checkToken(token, T0 + MAX_AGE_MS - 1), { ok: true, born: T0 });
  assert.deepEqual(checkToken(token, T0 + MAX_AGE_MS), { ok: false, reason: "expired" }, "eight hours");
  assert.deepEqual(checkToken(token, T0 - FUTURE_SLACK_MS - 1), { ok: false, reason: "invalid" }, "from the future");
  assert.deepEqual(checkToken(token, T0 - FUTURE_SLACK_MS), { ok: true, born: T0 }, "a minute of slack");
  for (const bad of ["", "tp1-abc", `se2-${T0.toString(36)}-${"A".repeat(43)}`, `${token}x`, null]) assert.equal(checkToken(bad, T0).ok, false, String(bad));
});

test("token: the relay is named by a salted SHA-256 of the token, never the token", async () => {
  const { token } = newToken();
  const name = await relayName(token);
  assert.match(name, /^[0-9a-f]{64}$/);
  assert.ok(!name.includes(token.split("-")[2]));
  assert.equal(await relayName(token), name);
  assert.notEqual(await relayName(newToken().token), name);
});

/* ---------- The relay object ---------- */
function fakeCtx() {
  const data = new Map();
  const sockets = [];
  const ctx = {
    alarm: null,
    erased: false,
    storage: {
      get: async (k) => structuredClone(data.get(k)),
      put: async (k, v) => { data.set(k, structuredClone(v)); },
      setAlarm: async (t) => { ctx.alarm = t; },
      getAlarm: async () => ctx.alarm,
      deleteAlarm: async () => { ctx.alarm = null; },
      deleteAll: async () => { data.clear(); ctx.erased = true; },
      data,
    },
    acceptWebSocket(ws, tags) { ws.tags = tags; sockets.push(ws); },
    getWebSockets(tag) { return sockets.filter((s) => !s.closed && (!tag || s.tags.includes(tag))); },
    setWebSocketAutoResponse(pair) { ctx.autoResponse = pair; },
  };
  return ctx;
}
function relayWith(now) {
  const ctx = fakeCtx();
  const relay = new Relay(ctx, {});
  relay.now = () => now.t;
  // A tab connects; returns the relay's side of its socket (a refused one is not kept by ctx).
  const tab = async (born = T0) => {
    const res = await relay.fetch(new Request("https://relay/tab", { headers: { Upgrade: "websocket", "X-Token-Born": String(born) } }));
    assert.equal(res.status, 101);
    assert.equal(res.headers.get("Sec-WebSocket-Protocol"), PROTOCOL);
    return lastServer();
  };
  return { ctx, relay, tab };
}
const settle = () => new Promise((r) => setImmediate(r));

test("relay: a tab's note lasts until birth + 8 h, with an alarm just after; pings are answered without waking it", async () => {
  const now = { t: T0 + 1000 };
  const { ctx, relay, tab } = relayWith(now);
  assert.deepEqual([ctx.autoResponse.request, ctx.autoResponse.response], ['{"type":"ping"}', '{"type":"pong"}']);
  const ws = await tab();
  assert.deepEqual(ws.sent[0], { type: "ready", createdAt: T0 });
  assert.deepEqual(ctx.storage.data.get("meta"), { createdAt: T0, expiresAt: T0 + MAX_AGE_MS, revoked: false, agent: null });
  assert.equal(ctx.alarm, T0 + MAX_AGE_MS + ALARM_SLACK_MS);
  assert.deepEqual(await relay.op({ op: "auth", born: T0 }), { status: "ok" });
  now.t = T0 + MAX_AGE_MS;
  assert.deepEqual(await relay.op({ op: "auth", born: T0 }), { status: "unauthorized" }, "past expiresAt: refused before the alarm");
});

test("relay: forwards a call to the tab and its result back; the script is never stored, only the note", async () => {
  const now = { t: T0 };
  const { ctx, relay, tab } = relayWith(now);
  const ws = await tab();
  await relay.op({ op: "agent", name: "claude-code", version: "2.1", born: T0 });
  assert.deepEqual(ws.sent.at(-1), { type: "agent", name: "claude-code", version: "2.1" }, "the tab hears who connected");
  const answer = relay.op({ op: "call", tool: "show_script", args: { markdown: SCRIPT, preset: "lex" }, born: T0 });
  await settle();
  const call = ws.sent.at(-1);
  assert.equal(call.type, "call");
  assert.deepEqual([call.tool, call.args], ["show_script", { markdown: SCRIPT, preset: "lex" }]);
  await relay.webSocketMessage(ws, JSON.stringify({ type: "result", id: call.id, result: { opened: true, markdown: SCRIPT } }));
  assert.deepEqual(await answer, { status: "ok", result: { opened: true, markdown: SCRIPT }, error: undefined });
  assert.deepEqual([...ctx.storage.data.keys()], ["meta"], "storage holds the note only");
  assert.deepEqual(Object.keys(ctx.storage.data.get("meta")).sort(), ["agent", "createdAt", "expiresAt", "revoked"]);
  assert.ok(!JSON.stringify([...ctx.storage.data.values()]).includes("secret line"), "no script text in storage");
  assert.deepEqual(ctx.storage.data.get("meta").agent, { name: "claude-code", version: "2.1" });
  // A reconnecting tab hears the agent at once.
  const again = await tab();
  assert.deepEqual(again.sent.map((m) => m.type), ["ready", "agent"]);
});

test("relay: no tab, a tab that does not answer, and a tab error", async () => {
  const now = { t: T0 };
  const { relay, tab } = relayWith(now);
  const ws = await tab();
  const late = await relay.op({ op: "call", tool: "get_open_script", args: {}, born: T0, timeout: 1000 });
  assert.deepEqual(late, { status: "timeout" });
  const failing = relay.op({ op: "call", tool: "show_script", args: {}, born: T0 });
  await settle();
  await relay.webSocketMessage(ws, JSON.stringify({ type: "result", id: ws.sent.at(-1).id, error: "No sections found." }));
  assert.equal((await failing).error, "No sections found.");
  ws.close(1000);
  assert.deepEqual(await relay.op({ op: "call", tool: "get_open_script", args: {}, born: T0 }), { status: "no-tab" });
});

test("relay: only the newest tab receives calls; the older one is closed with 4001", async () => {
  const now = { t: T0 };
  const { relay, tab } = relayWith(now);
  const first = await tab();
  const second = await tab();
  assert.deepEqual([first.code, first.reason], [4001, "Open in another tab"]);
  assert.equal(second.closed, false);
  const pending = relay.op({ op: "call", tool: "get_open_script", args: {}, born: T0 });
  await settle();
  assert.equal(second.sent.at(-1).type, "call");
  await relay.webSocketMessage(second, JSON.stringify({ type: "result", id: second.sent.at(-1).id, result: { open: false } }));
  assert.equal((await pending).status, "ok");
});

test("relay: the alarm refuses what waits, closes the tab with 4003 and erases everything; an early alarm is set again", async () => {
  const now = { t: T0 };
  const { ctx, relay, tab } = relayWith(now);
  const ws = await tab();
  const due = T0 + MAX_AGE_MS + ALARM_SLACK_MS;
  now.t = due - 10;
  await relay.alarm();
  assert.equal(ctx.alarm, due, "early: set again");
  assert.ok(ctx.storage.data.has("meta") && !ws.closed);
  now.t = T0 + 1000;
  const waiting = relay.op({ op: "call", tool: "get_open_script", args: {}, born: T0, timeout: 30_000 });
  await settle();
  now.t = due;
  await relay.alarm();
  assert.deepEqual(await waiting, { status: "unauthorized" });
  assert.deepEqual([ws.code, ws.reason], [4003, "expired"]);
  assert.equal(ctx.erased, true);
  assert.equal(ctx.storage.data.size, 0);
  assert.equal(ctx.alarm, null);
});

test("relay: a tab with a token past its time is refused with 4003 and nothing is written", async () => {
  const now = { t: T0 + MAX_AGE_MS };
  const { ctx, tab } = relayWith(now);
  const ws = await tab(T0);
  assert.deepEqual([ws.accepted, ws.tags, ws.code, ws.reason], [true, undefined, 4003, "expired"]);
  assert.equal(ctx.storage.data.size, 0);
  assert.equal(ctx.alarm, null);
});

test("relay: Disconnect (revoke) refuses the token until its alarm, closes with 4003, then the note is gone", async () => {
  const now = { t: T0 };
  const { ctx, relay, tab } = relayWith(now);
  const ws = await tab();
  await relay.op({ op: "agent", name: "claude-code", version: "2", born: T0 });
  const waiting = relay.op({ op: "call", tool: "get_open_script", args: {}, born: T0, timeout: 30_000 });
  await settle();
  await relay.webSocketMessage(ws, JSON.stringify({ type: "revoke" }));
  assert.deepEqual(await waiting, { status: "unauthorized" });
  assert.deepEqual([ws.code, ws.reason], [4003, "revoked"]);
  assert.deepEqual(ctx.storage.data.get("meta"), { createdAt: T0, expiresAt: T0 + MAX_AGE_MS, revoked: true, agent: null });
  assert.equal(ctx.alarm, T0 + MAX_AGE_MS + ALARM_SLACK_MS);
  now.t = T0 + MAX_AGE_MS - 1;
  assert.deepEqual(await relay.op({ op: "auth", born: T0 }), { status: "unauthorized" });
  const again = await tab();
  assert.deepEqual([again.code, again.reason], [4003, "revoked"], "a new tab does not bring it back");
  now.t = T0 + MAX_AGE_MS + ALARM_SLACK_MS;
  await relay.alarm();
  assert.equal(ctx.storage.data.size, 0);
});

test("relay: a revoke with no note keeps one for a token's whole life, with an alarm", async () => {
  const now = { t: T0 };
  const { ctx, relay } = relayWith(now);
  const ws = new FakeSocket();
  ctx.acceptWebSocket(ws, ["tab"]);
  await relay.webSocketMessage(ws, JSON.stringify({ type: "revoke" }));
  assert.deepEqual(ctx.storage.data.get("meta"), { createdAt: T0, expiresAt: T0 + MAX_AGE_MS, revoked: true, agent: null });
  assert.equal(ctx.alarm, T0 + MAX_AGE_MS + ALARM_SLACK_MS);
});

/* ---------- The Worker's routes ---------- */
function relayEnv({ status = "ok" } = {}) {
  const calls = { idFromName: [], fetch: [], op: [] };
  const env = {
    ASSETS: { fetch: () => new Response("asset") },
    RELAY: {
      idFromName: (name) => { calls.idFromName.push(name); return { name }; },
      get: (id) => ({
        fetch: async (url, init) => { calls.fetch.push({ id, url, init }); return new Response("to the relay"); },
        op: async (m) => { calls.op.push({ id, ...m }); return m.op === "call" ? { status, result: { open: false } } : { status }; },
      }),
    },
  };
  return { env, calls };
}
const SITE = "https://prompter.techies.tools";
const relayRequest = (token, { origin, protocol = PROTOCOL, ip = "203.0.113.5" } = {}) => {
  const headers = new Headers({ Upgrade: "websocket", "Sec-WebSocket-Protocol": `${protocol}, t.${token}`, "cf-connecting-ip": ip });
  if (origin) headers.set("Origin", origin);
  return new Request(`${SITE}/api/relay`, { headers });
};

test("worker /api/agent-token: a fresh token with the Worker's time, POST from this site only, never stored", async () => {
  const before = Date.now();
  const { env, calls } = relayEnv();
  const res = await worker.fetch(new Request(`${SITE}/api/agent-token`, { method: "POST", headers: { Origin: SITE } }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["createdAt", "token"]);
  assert.match(body.token, TOKEN_RE);
  assert.equal(parseInt(body.token.split("-")[1], 36), body.createdAt);
  assert.ok(body.createdAt >= before && body.createdAt <= Date.now());
  assert.deepEqual([calls.idFromName.length, calls.fetch.length], [0, 0], "no relay object is touched");
  assert.equal((await worker.fetch(new Request(`${SITE}/api/agent-token`, { method: "POST", headers: { Origin: "https://evil.example" } }), env)).status, 403);
  const get = await worker.fetch(new Request(`${SITE}/api/agent-token`), env);
  assert.deepEqual([get.status, get.headers.get("Allow")], [405, "POST"]);
  assert.equal((await worker.fetch(new Request(`${SITE}/api/other`), env)).status, 404);
});

test("worker /api/agent-token and /api/relay: an in-memory guard per client", async () => {
  const { env } = relayEnv();
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await worker.fetch(new Request(`${SITE}/api/agent-token`, { method: "POST", headers: { "cf-connecting-ip": "198.51.100.77" } }), env)).status);
  assert.deepEqual([statuses.slice(0, 20).every((s) => s === 200), statuses[20]], [true, 429], "20 tokens a minute per client");
  const { token } = newToken();
  const relayed = [];
  for (let i = 0; i < 31; i++) relayed.push((await worker.fetch(relayRequest(token, { ip: "198.51.100.78" }), env)).status);
  assert.equal(relayed.at(-1), 429, "30 relay connects a minute per client");
  assert.equal((await worker.fetch(new Request(`${SITE}/api/agent-token`, { method: "POST", headers: { "cf-connecting-ip": "198.51.100.79" } }), env)).status, 200, "another client is not affected");
});

test("worker /api/relay: a good token reaches its relay (by hash) with its birth time; bad ones never do", async () => {
  const { token, born } = newToken();
  const good = relayEnv();
  const res = await worker.fetch(relayRequest(token, { origin: SITE }), good.env);
  assert.equal(await res.text(), "to the relay");
  assert.deepEqual(good.calls.idFromName, [await relayName(token)]);
  assert.equal(good.calls.fetch[0].init.headers["X-Token-Born"], String(born));
  const now = Date.now();
  for (const [bad, reason] of [[newToken(now - MAX_AGE_MS - 1000).token, "expired"], [newToken(now + 3600_000).token, "invalid"]]) {
    const { env, calls } = relayEnv();
    const closed = await worker.fetch(relayRequest(bad), env);
    assert.equal(closed.status, 101);
    assert.equal(closed.headers.get("Sec-WebSocket-Protocol"), PROTOCOL, "browsers need the subprotocol to hear the close");
    assert.deepEqual([lastServer().accepted, lastServer().code, lastServer().reason], [true, 4003, reason]);
    assert.deepEqual([calls.idFromName.length, calls.fetch.length], [0, 0]);
  }
  for (const req of [relayRequest("tp1-short"), relayRequest(token, { protocol: "other" })]) {
    const { env, calls } = relayEnv();
    assert.equal((await worker.fetch(req, env)).status, 401);
    assert.equal(calls.idFromName.length, 0);
  }
  const { env } = relayEnv();
  assert.equal((await worker.fetch(relayRequest(token, { origin: "https://evil.example" }), env)).status, 403);
  assert.equal((await worker.fetch(new Request(`${SITE}/api/relay`), env)).status, 426);
});

test("worker /mcp: a token passes its birth time to its relay; an expired or revoked one gets 401", async () => {
  const mcp = (token, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }) => new Request(`${SITE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const old = relayEnv();
  const res = await worker.fetch(mcp(newToken(Date.now() - MAX_AGE_MS - FUTURE_SLACK_MS).token), old.env);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("WWW-Authenticate"), "Bearer");
  assert.equal(old.calls.idFromName.length, 0, "no relay touched for an expired token");
  const { token, born } = newToken();
  const good = relayEnv();
  const list = await worker.fetch(mcp(token), good.env);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).result.tools.some((t) => t.name === "show_script"));
  assert.deepEqual(good.calls.op.map((o) => [o.op, o.born]), [["auth", born]]);
  assert.deepEqual(good.calls.idFromName, [await relayName(token)]);
  const revoked = relayEnv({ status: "unauthorized" });
  assert.equal((await worker.fetch(mcp(token), revoked.env)).status, 401);
});

test("relay: an agent that calls before the tab has connected waits for it, instead of a 401", async () => {
  const now = { t: T0 + 5000 };
  const { ctx, relay, tab } = relayWith(now);
  assert.deepEqual(await relay.op({ op: "auth", born: T0 }), { status: "ok" }, "a young token with no note yet is fine");
  assert.deepEqual(await relay.op({ op: "agent", name: "codex", version: "1", born: T0 }), { status: "ok" });
  assert.deepEqual(await relay.op({ op: "call", tool: "get_open_script", args: {}, born: T0 }), { status: "no-tab" }, "the prompter is not open yet");
  assert.equal(ctx.storage.data.size, 0, "nothing is written before a tab connects (tokens are not signed)");
  assert.ok(!ctx.alarm, "and no alarm is set");
  const ws = await tab();
  assert.deepEqual(ctx.storage.data.get("meta"), { createdAt: T0, expiresAt: T0 + MAX_AGE_MS, revoked: false, agent: { name: "codex", version: "1" } }, "the tab starts the note, with the early agent's name");
  assert.equal(ctx.alarm, T0 + MAX_AGE_MS + ALARM_SLACK_MS, "the note starts with its alarm");
  assert.deepEqual(ws.sent.map((m) => m.type), ["ready", "agent"], "the tab hears who is connected when it arrives");
  assert.deepEqual(await relay.op({ op: "auth", born: T0 - MAX_AGE_MS }), { status: "unauthorized" }, "an old token is still refused");
});
