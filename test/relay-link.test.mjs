// The tab's live link to the relay (relayLink in src/relay-link.mjs) driven without a browser or a Worker:
// a fake WebSocket stands in for the relay, a fake fetch for /api/agent-token, a fake clock runs the
// backoff, keepalive and expiry timers on demand, and a Map stands in for the browser's storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_KEY, RELAY_EXPIRY_CHECK_MS, RELAY_KEEPALIVE_MS, SPARE_TOKEN_MS, relayBackoff, relayLink,
} from "../src/relay-link.mjs";
import { RELAY_CLOSE, TOKEN_MAX_AGE_MS, TOKEN_PATH } from "../src/wire.mjs";

const URL_ = "wss://prompter.test/api/relay";
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((done) => { setImmediate(done); }); };

/** Timers and a clock that move only when the test calls `advance(ms)`. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let ids = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { timers.set(++ids, { fn, at: now + ms, every }); return ids; };
  return {
    now: () => now,
    clock: {
      setTimeout: (fn, ms) => add(fn, ms, 0),
      clearTimeout: (id) => { timers.delete(id); },
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearInterval: (id) => { timers.delete(id); },
    },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
      await flush();
    },
  };
}

/** A WebSocket class whose sockets the test opens, feeds and drops by hand, like the relay would. */
function fakeSockets() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols) {
      Object.assign(this, { url, protocols, readyState: 0, sent: [], closedWith: null, listeners: [] });
      sockets.push(this);
    }
    addEventListener(type, fn, opts) { this.listeners.push({ type, fn, once: Boolean(opts?.once) }); }
    emit(type, event = {}) {
      for (const l of [...this.listeners]) {
        if (l.type !== type) continue;
        if (l.once) this.listeners.splice(this.listeners.indexOf(l), 1);
        l.fn(event);
      }
    }
    send(text) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(JSON.parse(text)); }
    // The tab closing a socket itself: its close event is of no interest (the tab has let it go by then).
    close(code = 1000, reason = "") { if (this.readyState >= 2) return; this.readyState = 3; this.closedWith = { code, reason }; }
    // What the relay does.
    open() { this.readyState = 1; this.emit("open"); }
    receive(message) { this.emit("message", { data: typeof message === "string" ? message : JSON.stringify(message) }); }
    drop(code = 1006) { this.readyState = 3; this.emit("close", { code }); }
  }
  return { WebSocket: FakeWebSocket, sockets, last: () => sockets.at(-1) };
}

function fakeStore(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { map, get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => { map.set(k, String(v)); return true; }, del: (k) => { map.delete(k); } };
}

/** /api/agent-token as the Worker answers it; `next` changes the next answer (a status, or a thrown error). */
function fakeTokens() {
  const t = { calls: [], n: 0, next: null };
  t.fetch = async (url, init) => {
    t.calls.push({ url, init });
    const next = t.next;
    t.next = null;
    if (next === "offline") throw new TypeError("Failed to fetch");
    if (next?.hold) await next.hold;
    if (typeof next === "number") return new Response("{}", { status: next });
    return new Response(JSON.stringify({ token: `tp1-tok-${++t.n}`, createdAt: 1 }));
  };
  return t;
}

function setup({ store = fakeStore(), tools = {}, random = () => 0.5 } = {}) {
  const time = fakeClock();
  const ws = fakeSockets();
  const tokens = fakeTokens();
  let draws = 0;
  const link = relayLink({ WebSocket: ws.WebSocket, fetch: tokens.fetch, clock: time.clock, now: time.now, random, store, url: URL_, tools, changed: () => { draws++; } });
  return { link, time, ws, tokens, store, draws: () => draws };
}

test("backoff doubles from 1 s to at most 30 s, with a quarter either way of jitter", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map((n) => relayBackoff(n, 0.5)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(relayBackoff(0, 0), 750);
  assert.equal(relayBackoff(0, 1), 1250);
  assert.equal(relayBackoff(10, 0), 22500);
});

test("Wait for MCP: a token from the Worker, kept on this device, and a socket that carries it as a subprotocol", async () => {
  const { link, ws, tokens, store, time } = setup();
  assert.equal(link.state, "off");
  const busy = [];
  const token = await link.waitForAgent((b) => busy.push(b));
  assert.equal(token, "tp1-tok-1");
  assert.deepEqual(busy, [true, false], "the button says it is busy while the token is fetched");
  assert.deepEqual(tokens.calls.map((c) => [c.url, c.init.method, c.init.cache]), [[TOKEN_PATH, "POST", "no-store"]]);
  assert.equal(link.state, "waiting");
  assert.equal(link.token, "tp1-tok-1");
  assert.deepEqual(JSON.parse(store.get(AGENT_KEY)), { token: "tp1-tok-1", createdAt: time.now() });
  assert.equal(ws.sockets.length, 1);
  assert.equal(ws.last().url, URL_);
  assert.deepEqual(ws.last().protocols, ["prompter", "t.tp1-tok-1"]);
  // Pressing again with a live token copies the same token, with no new fetch or socket.
  assert.equal(await link.waitForAgent(), "tp1-tok-1");
  assert.equal(tokens.calls.length, 1);
  assert.equal(ws.sockets.length, 1);
});

test("no token from the Worker: it stays off and says it failed until the next try", async () => {
  const { link, ws, tokens } = setup();
  tokens.next = "offline";
  assert.equal(await link.waitForAgent(), null);
  assert.deepEqual([link.state, link.failed, ws.sockets.length], ["off", true, 0]);
  tokens.next = 500;
  assert.equal(await link.waitForAgent(), null);
  assert.equal(link.failed, true);
  assert.equal(await link.waitForAgent(), "tp1-tok-1");
  assert.deepEqual([link.state, link.failed], ["waiting", false]);
});

test("a second press while the token is on its way does nothing", async () => {
  const { link, tokens } = setup();
  let release;
  tokens.next = { hold: new Promise((done) => { release = done; }) };
  const first = link.waitForAgent();
  assert.equal(await link.waitForAgent(), null);
  release();
  assert.equal(await first, "tp1-tok-1");
  assert.equal(tokens.calls.length, 1);
});

test("a spare token fetched ahead is used while it is younger than ten minutes", async () => {
  const { link, tokens } = setup();
  link.prefetchToken();
  link.prefetchToken(); // one fetch at a time
  await flush();
  assert.equal(tokens.calls.length, 1);
  assert.equal(await link.waitForAgent(), "tp1-tok-1", "the spare is used, no wait");
  assert.equal(tokens.calls.length, 1);
  link.prefetchToken();
  assert.equal(tokens.calls.length, 1, "no spare while a live token is in use");

  const late = setup();
  late.link.prefetchToken();
  await flush();
  await late.time.advance(SPARE_TOKEN_MS);
  assert.equal(await late.link.waitForAgent(), "tp1-tok-2", "a spare ten minutes old is dropped for a new one");
  assert.equal(late.tokens.calls.length, 2);
});

test("a press during the spare's fetch waits for that same fetch", async () => {
  const { link, tokens } = setup();
  let release;
  tokens.next = { hold: new Promise((done) => { release = done; }) };
  link.prefetchToken();
  const pressed = link.waitForAgent();
  release();
  assert.equal(await pressed, "tp1-tok-1");
  assert.equal(tokens.calls.length, 1);
});

test("the agent says hello: on, with its name; a call alone also turns it on", async () => {
  const { link, ws } = setup();
  await link.waitForAgent();
  ws.last().open();
  ws.last().receive({ type: "ready", createdAt: 1 });
  assert.equal(link.state, "waiting", "ready alone changes nothing");
  ws.last().receive({ type: "agent", name: "claude-code", version: "2.1" });
  assert.deepEqual([link.state, link.info], ["on", { name: "claude-code", version: "2.1" }]);

  const quiet = setup({ tools: { get_open_script: () => ({ result: { open: false } }) } });
  await quiet.link.waitForAgent();
  quiet.ws.last().open();
  quiet.ws.last().receive({ type: "call", id: "c1", tool: "get_open_script", args: {} });
  assert.equal(quiet.link.state, "on");
  for (const junk of ["not json", '{"type":"hello"}', "[]"]) quiet.ws.last().receive(junk);
  assert.equal(quiet.link.state, "on", "anything else is ignored");
});

test("a tool call goes to the page's tool and its answer goes back on the same socket", async () => {
  const seen = [];
  const tools = {
    get_open_script: () => ({ result: { open: true, markdown: "# A", preset: "lex" } }),
    async show_script(args) { seen.push(args); await flush(); return { result: { opened: true, sections: 2 } }; },
    broken: () => { throw new Error("no room"); },
  };
  const { link, ws } = setup({ tools });
  await link.waitForAgent();
  const sock = ws.last();
  sock.open();
  sock.receive({ type: "call", id: "a", tool: "get_open_script", args: {} });
  sock.receive({ type: "call", id: "b", tool: "show_script", args: { markdown: "x", preset: "lex" } });
  sock.receive({ type: "call", id: "c", tool: "delete_everything", args: {} });
  sock.receive({ type: "call", id: "d", tool: "toString" });
  sock.receive({ type: "call", id: "e", tool: "broken" });
  sock.receive({ type: "call", id: 7, tool: "get_open_script" });
  await flush();
  assert.deepEqual(seen, [{ markdown: "x", preset: "lex" }]);
  assert.deepEqual(sock.sent.toSorted((x, y) => x.id.localeCompare(y.id)), [
    { type: "result", id: "a", result: { open: true, markdown: "# A", preset: "lex" } },
    { type: "result", id: "b", result: { opened: true, sections: 2 } },
    { type: "result", id: "c", error: "Unknown tool: delete_everything" },
    { type: "result", id: "d", error: "Unknown tool: toString" },
    { type: "result", id: "e", error: "The prompter could not do that: no room" },
  ], "a call without a string id is ignored");
  assert.ok(link.info === null, "a call carries no agent name");
});

test("an answer is dropped when its socket closed while the tool worked", async () => {
  let finish;
  const { link, ws } = setup({ tools: { show_script: () => new Promise((done) => { finish = done; }) } });
  await link.waitForAgent();
  const sock = ws.last();
  sock.open();
  sock.receive({ type: "call", id: "a", tool: "show_script", args: {} });
  sock.drop(1006);
  finish({ result: { opened: true } });
  await flush();
  assert.deepEqual(sock.sent, []);
});

test("a dropped socket reconnects with backoff; an opened one starts the backoff over", async () => {
  const { link, ws, time } = setup();
  await link.waitForAgent();
  ws.last().drop(1006);
  await time.advance(999);
  assert.equal(ws.sockets.length, 1);
  await time.advance(1);
  assert.equal(ws.sockets.length, 2, "again after 1 s");
  assert.deepEqual(ws.last().protocols, ["prompter", "t.tp1-tok-1"], "with the same token");
  ws.last().drop(1011);
  await time.advance(1999);
  assert.equal(ws.sockets.length, 2);
  await time.advance(1);
  assert.equal(ws.sockets.length, 3, "then after 2 s");
  ws.last().open();
  ws.last().drop(1006);
  await time.advance(1000);
  assert.equal(ws.sockets.length, 4, "an open socket set it back to 1 s");
  assert.equal(link.state, "waiting");
});

test("4001: open in another tab, no reconnect until Use this tab", async () => {
  const { link, ws, time, store } = setup();
  await link.waitForAgent();
  ws.last().open();
  ws.last().receive({ type: "agent", name: "Claude" });
  ws.last().drop(RELAY_CLOSE.elsewhere);
  assert.equal(link.state, "elsewhere");
  await time.advance(60_000);
  assert.equal(ws.sockets.length, 1, "no reconnect");
  assert.ok(store.get(AGENT_KEY), "the token is kept");
  link.useHere();
  assert.equal(link.state, "waiting");
  assert.equal(ws.sockets.length, 2);
  assert.deepEqual(ws.last().protocols, ["prompter", "t.tp1-tok-1"]);
});

test("4003: the relay refused the token (revoked or expired), so it is forgotten", async () => {
  const { link, ws, time, store } = setup();
  await link.waitForAgent();
  ws.last().drop(RELAY_CLOSE.forget);
  assert.deepEqual([link.state, link.token, link.info, store.get(AGENT_KEY)], ["off", null, null, null]);
  await time.advance(60_000);
  assert.equal(ws.sockets.length, 1, "no reconnect");
});

test("keepalive: a ping every 45 s while the socket is open, the exact text the relay answers by itself", async () => {
  const { link, ws, time } = setup();
  link.start();
  await link.waitForAgent();
  await time.advance(RELAY_KEEPALIVE_MS);
  assert.deepEqual(ws.last().sent, [], "not before it opened");
  ws.last().open();
  await time.advance(RELAY_KEEPALIVE_MS);
  assert.deepEqual(ws.last().sent, [{ type: "ping" }]);
  await time.advance(RELAY_KEEPALIVE_MS);
  assert.equal(ws.last().sent.length, 2);
});

test("a token lives eight hours, then it is dropped like Disconnect MCP", async () => {
  const { link, ws, time, store } = setup();
  link.start();
  await link.waitForAgent();
  ws.last().open();
  await time.advance(TOKEN_MAX_AGE_MS - RELAY_EXPIRY_CHECK_MS);
  assert.equal(link.state, "waiting");
  await time.advance(RELAY_EXPIRY_CHECK_MS);
  assert.deepEqual([link.state, link.token, store.get(AGENT_KEY)], ["off", null, null]);
  assert.deepEqual(ws.sockets[0].sent.at(-1), { type: "revoke" }, "the relay is told");
});

test("a reload picks up the kept token and reconnects; an old or damaged one is dropped", async () => {
  const time = fakeClock();
  const kept = setup({ store: fakeStore({ [AGENT_KEY]: JSON.stringify({ token: "tp1-kept", createdAt: time.now() }) }) });
  kept.link.start();
  assert.deepEqual([kept.link.state, kept.link.token, kept.ws.sockets.length], ["waiting", "tp1-kept", 1]);
  assert.deepEqual(kept.ws.last().protocols, ["prompter", "t.tp1-kept"]);

  for (const value of [JSON.stringify({ token: "tp1-old", createdAt: time.now() - TOKEN_MAX_AGE_MS }), "{damaged", JSON.stringify({ token: 5 })]) {
    const s = setup({ store: fakeStore({ [AGENT_KEY]: value }) });
    s.link.start();
    assert.deepEqual([s.link.state, s.link.token, s.ws.sockets.length, s.store.get(AGENT_KEY)], ["off", null, 0, null], value);
  }
});

test("Disconnect MCP: off at once, then the revoke goes over the open socket", async () => {
  const { link, ws, time, store } = setup();
  await link.waitForAgent();
  const sock = ws.last();
  sock.open();
  sock.receive({ type: "agent", name: "Claude" });
  link.disconnect();
  assert.deepEqual([link.state, link.token, link.info, store.get(AGENT_KEY)], ["off", null, null, null]);
  assert.deepEqual(sock.sent, [{ type: "revoke" }]);
  assert.equal(sock.closedWith, null, "it stays open a moment so the revoke gets out");
  sock.drop(RELAY_CLOSE.forget);
  await time.advance(60_000);
  assert.equal(ws.sockets.length, 1, "a detached socket's close reconnects nothing");
  assert.equal(link.state, "off");
});

test("Disconnect MCP with no open socket opens one just to send the revoke", async () => {
  const { link, ws, time } = setup();
  await link.waitForAgent();
  ws.last().drop(1006); // waiting for the backoff
  link.disconnect();
  assert.equal(ws.sockets.length, 2);
  assert.deepEqual(ws.last().protocols, ["prompter", "t.tp1-tok-1"]);
  ws.last().open();
  assert.deepEqual(ws.last().sent, [{ type: "revoke" }]);
  await time.advance(200);
  assert.deepEqual(ws.last().closedWith, { code: 1000, reason: "bye" });
  await time.advance(60_000);
  assert.equal(ws.sockets.length, 2, "and the backoff's reconnect was called off");
});

test("a revoke socket that never opens is closed after 5 s", async () => {
  const { link, ws, time } = setup();
  await link.waitForAgent();
  ws.last().drop(1006);
  link.disconnect();
  await time.advance(5000);
  assert.deepEqual(ws.last().closedWith, { code: 1000, reason: "bye" });
});

test("each change is drawn", async () => {
  const { link, ws, draws } = setup();
  let seen = draws();
  const drawn = (what) => { assert.ok(draws() > seen, what); seen = draws(); };
  await link.waitForAgent();
  drawn("waiting");
  ws.last().open();
  ws.last().receive({ type: "agent", name: "Claude" });
  drawn("on");
  ws.last().drop(RELAY_CLOSE.elsewhere);
  drawn("elsewhere");
  link.useHere();
  drawn("use this tab");
  ws.last().drop(RELAY_CLOSE.forget);
  drawn("forgotten");
});

test("Use this tab after the token's eight hours drops it like Disconnect MCP", async () => {
  const { link, ws, time, store } = setup();
  await link.waitForAgent();
  ws.last().drop(RELAY_CLOSE.elsewhere);
  await time.advance(TOKEN_MAX_AGE_MS);
  link.useHere();
  assert.deepEqual([link.state, link.token, store.get(AGENT_KEY)], ["off", null, null]);
  assert.equal(ws.sockets.length, 2, "the only new socket carries the revoke");
  ws.last().open();
  assert.deepEqual(ws.last().sent, [{ type: "revoke" }]);
});
