// Cloudflare Worker: serves the static page from ./dist and answers /mcp.
// Only /mcp runs this code (see run_worker_first in wrangler.jsonc), and only
// /mcp uses the MCP_LIMITER Durable Object.
import { durableLimiter } from "./limiter.mjs";
import { handleMcp } from "./mcp.mjs";

export { McpLimiter } from "./limiter.mjs";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp" || pathname === "/mcp/") return handleMcp(request, { limiter: env.MCP_LIMITER && durableLimiter(env.MCP_LIMITER) });
    return env.ASSETS.fetch(request);
  },
};
