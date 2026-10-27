// Cloudflare Worker: serves the static page from ./dist and answers /mcp.
// Only /mcp runs this code (see run_worker_first in wrangler.jsonc).
import { handleMcp } from "./mcp.mjs";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp" || pathname === "/mcp/") return handleMcp(request, { limiter: env.MCP_RATE_LIMITER });
    return env.ASSETS.fetch(request);
  },
};
