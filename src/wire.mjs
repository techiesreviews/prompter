// The live relay's wire between the open prompter tab and the server: the two paths, the socket's
// subprotocol and close codes, and the messages on that socket, in one list all three ends read
// (src/relay-link.mjs in the tab, src/worker.mjs and src/relay.mjs on the server), so a renamed code or
// message breaks a test instead of the live link. (The MCP endpoint's calls into the relay, src/mcp.mjs
// to `op` in src/relay.mjs, are server-only and not part of it.) scripts/build.mjs inlines this file
// into the page, so keep it import-free and use only `export function`/`export const` forms.

/** The WebSocket subprotocol the tab asks for and the relay answers with. */
export const RELAY_PROTOCOL = "prompter";
/** The token rides as a second subprotocol, `t.<token>`, never in the URL. */
export const RELAY_TOKEN_PREFIX = "t.";
/** Where the tab opens its socket, and where it asks for a new agent token. */
export const RELAY_PATH = "/api/relay";
export const TOKEN_PATH = "/api/agent-token";
/** An agent token lives at most this long from its birth (the Worker's clock). */
export const TOKEN_MAX_AGE_MS = 8 * 60 * 60 * 1000;
/**
 * The Producer's pages (live and preview), the one other site that may ask TOKEN_PATH for a token (CORS)
 * and that opens this page linked (`#producer`); the tab talks only to them.
 */
export const PRODUCER_ORIGINS = ["https://producer.techies.tools", "https://preview-producer.techies.tools"];
/**
 * The messages between this tab and the Producer page that opened it (postMessage at exact addresses):
 * `ready` from a tab opened with `#producer`; `token` from the Producer with `token`, the one it got from
 * TOKEN_PATH (taken once, only by a tab that said ready); `link` from the tab with `state` (off, waiting,
 * on, elsewhere), never the token, so the Producer can say "Connected: Producer + Prompter"; `disconnect`
 * from the Producer, so its Disconnect ends this tab's link too.
 */
export const PRODUCER_MESSAGES = { ready: "prompter:ready", token: "prompter:token", link: "prompter:link", disconnect: "prompter:disconnect" };

/**
 * The relay's own close codes: `elsewhere` when a newer tab took the link (this one offers "Use this
 * tab"), `forget` when the token was revoked or expired (the tab forgets it).
 */
export const RELAY_CLOSE = { elsewhere: 4001, forget: 4003 };

/**
 * Each message type and its fields. From the relay to the tab: `ready` (the note's birth), `agent` (the
 * agent's name), `call` (a tool call). From the tab: `result` (a call's answer: `result` or `error`),
 * `ping` (keepalive, answered with `pong` without waking the relay) and `revoke` (Disconnect MCP).
 */
export const RELAY_MESSAGES = {
  ready: ["createdAt"],
  agent: ["name", "version"],
  call: ["id", "tool", "args"],
  result: ["id", "result", "error"],
  ping: [],
  pong: [],
  revoke: [],
};

/** The subprotocols a tab offers for this token. */
export function relayProtocols(token) {
  return [RELAY_PROTOCOL, `${RELAY_TOKEN_PREFIX}${token}`];
}

/** A message of a listed type with only its listed fields (unset ones left out); throws for any other type. */
export function relayMessage(type, fields = {}) {
  if (!Object.hasOwn(RELAY_MESSAGES, type)) throw new Error(`Not a relay message: ${type}`);
  const message = { type };
  for (const name of RELAY_MESSAGES[type]) if (fields[name] !== undefined) message[name] = fields[name];
  return message;
}

/** A received text as a message of a listed type, or null for anything else. */
export function readRelayMessage(text) {
  let message;
  try { message = JSON.parse(text); } catch { return null; }
  return message && typeof message === "object" && !Array.isArray(message) && typeof message.type === "string" && Object.hasOwn(RELAY_MESSAGES, message.type) ? message : null;
}
