// Cloudflare Worker: serves the static page from ./dist and answers /mcp and
// /api/* (see run_worker_first in wrangler.jsonc). Only /mcp uses the
// MCP_LIMITER Durable Object; only /mcp and /api/relay reach a RELAY object.
// Nothing here logs, and no request body is kept.
import { durableLimiter } from "./limiter.mjs";
import { handleMcp, memoryLimiter } from "./mcp.mjs";
import { PROTOCOL } from "./relay.mjs";
import { checkToken, newToken, relayName, TOKEN_RE } from "./token.mjs";

export { McpLimiter } from "./limiter.mjs";
export { Relay } from "./relay.mjs";

// Per-instance guards for the tab's own calls (in memory, keyed by client address, never stored).
// A tab asks for a token when someone presses Wait for MCP, and reconnects its relay with backoff.
const tokenGuard = memoryLimiter(20);
const relayGuard = memoryLimiter(30);

const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...noStore, ...extra } });
const foreign = (request, url) => {
  const origin = request.headers.get("Origin");
  return origin && origin !== url.origin;
};
async function limited(guard, request) {
  const verdict = await guard.limit({ key: request.headers.get("cf-connecting-ip") || "local" });
  return verdict.success ? null : reply({ error: "Too many requests" }, 429, { "Retry-After": "60" });
}

// A socket that is closed at once, so the tab hears why (4003 makes it forget the token). No relay object is touched.
function closedSocket(code, reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": PROTOCOL } });
}

async function relayStub(env, token) {
  return env.RELAY.get(env.RELAY.idFromName(await relayName(token)));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
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
    if (pathname === "/api/agent-token") {
      // A new agent token with the Worker's own time inside (see token.mjs). It touches no relay object.
      if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405, { Allow: "POST" });
      if (foreign(request, url)) return reply({ error: "Forbidden" }, 403);
      const refused = await limited(tokenGuard, request);
      if (refused) return refused;
      const { token, born } = newToken();
      return reply({ token, createdAt: born });
    }
    if (pathname === "/api/relay") {
      if (request.headers.get("Upgrade") !== "websocket") return reply({ error: "Expected a WebSocket" }, 426);
      if (foreign(request, url)) return reply({ error: "Forbidden" }, 403);
      const refused = await limited(relayGuard, request);
      if (refused) return refused;
      // The token travels as a subprotocol, never in the URL: ["prompter", "t.<token>"].
      const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((p) => p.trim());
      const token = protocols.find((p) => p.startsWith("t."))?.slice(2) ?? "";
      if (!protocols.includes(PROTOCOL) || !TOKEN_RE.test(token)) return reply({ error: "Unauthorized" }, 401);
      // Past its time (or from the future): refused here, before any relay object is touched.
      const t = checkToken(token);
      if (!t.ok) return closedSocket(4003, t.reason);
      const stub = await relayStub(env, token);
      return stub.fetch("https://relay/tab", { headers: { Upgrade: "websocket", "X-Token-Born": String(t.born) } });
    }
    if (pathname.startsWith("/api/")) return reply({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
