// Cloudflare Worker: serves the static page from ./dist and answers /mcp and
// /api/* (see run_worker_first in wrangler.jsonc). Only /mcp uses the
// MCP_LIMITER Durable Object; only /mcp and /api/relay reach a RELAY object.
// Nothing here logs, and no request body is kept.
import { fromOtherSite, memoryLimiter, refusedBy } from "./guard.mjs";
import { durableLimiter } from "./limiter.mjs";
import { handleMcp } from "./mcp.mjs";
import { checkToken, newToken, relayName, TOKEN_RE } from "./token.mjs";
import { RELAY_CLOSE, RELAY_PATH, RELAY_PROTOCOL, RELAY_TOKEN_PREFIX, TOKEN_PATH } from "./wire.mjs";

export { McpLimiter } from "./limiter.mjs";
export { Relay } from "./relay.mjs";

// Per-instance guards for the tab's own calls (in memory, keyed by client address, never stored).
// A tab asks for a token when someone presses Wait for MCP, and reconnects its relay with backoff.
const tokenGuard = memoryLimiter(20);
const relayGuard = memoryLimiter(30);

const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...noStore, ...extra } });
// The tab's routes take this site's requests only, and each one counts against the client's limit (guard.mjs).
async function refused(request, limiter) {
  if (fromOtherSite(request)) return reply({ error: "Forbidden" }, 403);
  return (await refusedBy(request, limiter)) ? reply({ error: "Too many requests" }, 429, { "Retry-After": "60" }) : null;
}

// A socket that is closed at once, so the tab hears why (`forget` makes it forget the token). No relay object is touched.
function closedSocket(code, reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL } });
}

async function relayStub(env, token) {
  return env.RELAY.get(env.RELAY.idFromName(await relayName(token)));
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp" || pathname === "/mcp/") {
      const stubs = new Map();
      const relayFor = (token) => ({
        async op(message) {
          if (!stubs.has(token)) stubs.set(token, await relayStub(env, token));
          return stubs.get(token).op(message);
        },
      });
      return handleMcp(request, { limiter: env.MCP_LIMITER && durableLimiter(env.MCP_LIMITER), relayFor });
    }
    if (pathname === TOKEN_PATH) {
      // A new agent token with the Worker's own time inside (see token.mjs). It touches no relay object.
      if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405, { Allow: "POST" });
      const refusal = await refused(request, tokenGuard);
      if (refusal) return refusal;
      const { token, born } = newToken();
      return reply({ token, createdAt: born });
    }
    if (pathname === RELAY_PATH) {
      if (request.headers.get("Upgrade") !== "websocket") return reply({ error: "Expected a WebSocket" }, 426);
      const refusal = await refused(request, relayGuard);
      if (refusal) return refusal;
      // The token travels as a subprotocol, never in the URL: relayProtocols(token) in wire.mjs.
      const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((p) => p.trim());
      const token = protocols.find((p) => p.startsWith(RELAY_TOKEN_PREFIX))?.slice(RELAY_TOKEN_PREFIX.length) ?? "";
      if (!protocols.includes(RELAY_PROTOCOL) || !TOKEN_RE.test(token)) return reply({ error: "Unauthorized" }, 401);
      // Past its time (or from the future): refused here, before any relay object is touched.
      const t = checkToken(token);
      if (!t.ok) return closedSocket(RELAY_CLOSE.forget, t.reason);
      const stub = await relayStub(env, token);
      return stub.fetch("https://relay/tab", { headers: { Upgrade: "websocket", "X-Token-Born": String(t.born) } });
    }
    if (pathname.startsWith("/api/")) return reply({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
