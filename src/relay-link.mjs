// The tab's live link to the person's own AI agent, as in the script editor: Wait for MCP copies a message
// with a fresh token from the Worker, and the tab keeps a WebSocket to this site's relay (src/relay.mjs).
// The agent then reaches the tab through its relay to open a script (show_script) or read the open one
// (get_open_script); the relay keeps no script. Disconnect MCP revokes the token, so the agent's calls get
// 401. Everything it says on the wire comes from src/wire.mjs. scripts/build.mjs inlines this file into
// the page after src/wire.mjs and drops the import line below, so keep it free of any other import and use
// only `export function`/`export const` forms.
import { RELAY_CLOSE, TOKEN_MAX_AGE_MS, TOKEN_PATH, readRelayMessage, relayMessage, relayProtocols } from "./wire.mjs";

/** Where this device keeps the token and its age, so a reload reconnects. */
export const AGENT_KEY = "prompter-agent";
/** A spare token fetched ahead (a clipboard write needs the click itself) is used while younger than this. */
export const SPARE_TOKEN_MS = 10 * 60 * 1000;
/** A keepalive ping the relay answers without waking up. */
export const RELAY_KEEPALIVE_MS = 45_000;
/** How often the token's age is checked: past eight hours it is dropped like Disconnect MCP. */
export const RELAY_EXPIRY_CHECK_MS = 60_000;

/** The wait before reconnect number `retry` (from 0): 1 s doubling to at most 30 s, a quarter either way. */
export function relayBackoff(retry, random) {
  return Math.min(30000, 1000 * 2 ** retry) * (0.75 + random * 0.5);
}

/**
 * The tab's link: the token (fetched, kept on this device, aged), the socket with its reconnect backoff,
 * keepalive and close codes, and the agent's tool calls, in one place the page only draws.
 * `WebSocket`, `fetch`, `clock` ({ setTimeout, clearTimeout, setInterval, clearInterval }), `now` and
 * `random` are the browser's, or stand-ins in tests; `store` is { get, set, del } on this device's storage;
 * `url` the relay's address; `tools` maps a tool name to `(args) => ({ result } | { error })` (or a promise
 * of one); `changed()` is called after each change, for the page to draw it.
 *
 * Read: `state` (off, waiting for the agent, on once it said hello or called, elsewhere when a newer tab
 * took the link), `info` (the agent's { name, version }, or null), `token`, `failed` (the last token fetch
 * got nothing). Do: `start()` (picks up a kept token, starts the keepalive and the age check),
 * `prefetchToken()`, `waitForAgent(busy)` (resolves to the token to copy, or null), `useHere()`, `disconnect()`.
 */
export function relayLink({
  WebSocket = globalThis.WebSocket, fetch = globalThis.fetch, clock = globalThis, now = Date.now, random = Math.random,
  store, url, tools = {}, changed = () => {},
} = {}) {
  // Plain calls: a browser's timers refuse to run on any other object.
  const { setTimeout: later, clearTimeout: cancel, setInterval: every } = clock;
  const link = { token: null, createdAt: 0, ws: null, state: "off", info: null, retry: 0, timer: 0, failed: false };
  // Ages here use this tab's clock, counted from when the token arrived.
  let spare = null;
  let spareFetch = null;
  let tokenWait = false;
  const send = (ws, type, fields) => ws.send(JSON.stringify(relayMessage(type, fields)));
  const hasToken = () => Boolean(link.token) && now() - link.createdAt < TOKEN_MAX_AGE_MS;
  const freshSpare = () => (spare && now() - spare.at < SPARE_TOKEN_MS ? spare : null);

  // Tokens come from the Worker, which writes its own time into them.
  function fetchToken() {
    return fetch(TOKEN_PATH, { method: "POST", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => (typeof b?.token === "string" && b.token ? { token: b.token, at: now() } : null))
      .catch(() => null);
  }

  function prefetchToken() {
    if (hasToken() || spareFetch || freshSpare()) return;
    spareFetch = fetchToken().then((t) => { spareFetch = null; if (t) spare = t; return t; });
  }

  function connect() {
    cancel(link.timer);
    if (!link.token) return;
    if (now() - link.createdAt >= TOKEN_MAX_AGE_MS) { disconnect(); return; }
    try { link.ws?.close(); } catch { /* closed */ }
    const ws = new WebSocket(url, relayProtocols(link.token));
    link.ws = ws;
    ws.addEventListener("open", () => { link.retry = 0; });
    ws.addEventListener("message", (e) => {
      if (link.ws !== ws) return; // a detached socket (Disconnect) only carries the revoke
      const m = readRelayMessage(e.data);
      if (m) onMessage(m);
    });
    ws.addEventListener("close", (e) => {
      if (link.ws !== ws) return;
      link.ws = null;
      if (e.code === RELAY_CLOSE.elsewhere) { link.state = "elsewhere"; changed(); return; }
      if (e.code === RELAY_CLOSE.forget) { forget(); return; }
      if (!link.token) return;
      link.timer = later(connect, relayBackoff(link.retry++, random()));
    });
  }

  function onMessage(m) {
    if (m.type === "agent") {
      link.info = { name: String(m.name || ""), version: String(m.version || "") };
      link.state = "on";
      changed();
    } else if (m.type === "call" && typeof m.id === "string") {
      if (link.state !== "on") { link.state = "on"; changed(); }
      answer(m);
    }
  }

  // The answer goes back on the socket the call came on, if it is still open.
  async function answer({ id, tool, args }) {
    const ws = link.ws;
    const reply = (payload) => { try { if (ws?.readyState === WebSocket.OPEN) send(ws, "result", { id, ...payload }); } catch { /* closed */ } };
    try {
      if (!Object.hasOwn(tools, tool)) return reply({ error: `Unknown tool: ${tool}` });
      reply(await tools[tool](args ?? {}));
    } catch (error) {
      reply({ error: `The prompter could not do that: ${error?.message || error}` });
    }
  }

  function forget() {
    cancel(link.timer);
    const ws = link.ws;
    link.ws = null;
    try { ws?.close(1000, "bye"); } catch { /* closed */ }
    link.token = null;
    link.createdAt = 0;
    link.info = null;
    link.state = "off";
    store.del(AGENT_KEY);
    changed();
  }

  // Disconnect MCP: the relay forgets the token, so the agent is refused from now on.
  function disconnect() {
    // Detach the socket and token first, then show "off" at once; the revoke finishes quietly behind it.
    const token = link.token;
    let ws = link.ws;
    link.ws = null; // the close handler now ignores this socket and won't reconnect
    forget();
    if (!token) return;
    const close = () => { try { ws?.close(1000, "bye"); } catch { /* closed */ } };
    const revoke = () => { try { send(ws, "revoke"); } catch { /* closed */ } later(close, 200); };
    try {
      if (!ws || ws.readyState >= WebSocket.CLOSING) ws = new WebSocket(url, relayProtocols(token));
      if (ws.readyState === WebSocket.OPEN) revoke();
      else ws.addEventListener("open", revoke, { once: true });
    } catch { /* offline: the token still ends after 8 hours */ }
    later(close, 5000);
  }

  // Wait for MCP: a live token (the spare, or a new one), kept on this device, and a socket that waits for
  // the agent. Resolves to the token to copy, or null when there is none (offline, say: `failed` says so
  // until the next try) or another press is already fetching one. `busy(true|false)` brackets the wait.
  async function waitForAgent(busy = () => {}) {
    if (!hasToken()) {
      if (tokenWait) return null;
      let t = freshSpare();
      spare = null;
      if (!t) {
        tokenWait = true;
        link.failed = false; // a retry clears the last "No connection"
        changed();
        busy(true);
        t = await (spareFetch ?? fetchToken());
        tokenWait = false;
        busy(false);
        if (spare === t) spare = null;
      }
      if (hasToken()) return null;
      if (!t) { link.failed = true; changed(); return null; }
      link.failed = false;
      link.token = t.token;
      link.createdAt = t.at;
      store.set(AGENT_KEY, JSON.stringify({ token: link.token, createdAt: link.createdAt }));
      connect();
    } else if (!link.ws) connect();
    if (link.state !== "on") link.state = "waiting";
    changed();
    return link.token;
  }

  // Use this tab: take the link back from the newer tab.
  function useHere() {
    link.state = "waiting";
    connect();
    changed();
  }

  function start() {
    every(() => { try { if (link.ws?.readyState === WebSocket.OPEN) send(link.ws, "ping"); } catch { /* closed */ } }, RELAY_KEEPALIVE_MS);
    every(() => { if (link.token && !hasToken()) disconnect(); }, RELAY_EXPIRY_CHECK_MS);
    let saved = null;
    try { saved = JSON.parse(store.get(AGENT_KEY) || "null"); } catch { /* damaged: dropped below */ }
    if (typeof saved?.token === "string" && now() - saved.createdAt < TOKEN_MAX_AGE_MS) {
      link.token = saved.token;
      link.createdAt = saved.createdAt;
      link.state = "waiting";
      connect();
    } else if (store.get(AGENT_KEY)) store.del(AGENT_KEY);
  }

  return {
    get state() { return link.state; },
    get info() { return link.info; },
    get token() { return link.token; },
    get failed() { return link.failed; },
    start,
    prefetchToken,
    waitForAgent,
    useHere,
    disconnect,
  };
}
