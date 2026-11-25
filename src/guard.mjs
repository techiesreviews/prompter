// The request checks every server route shares (worker.mjs for /api/*, mcp.mjs for /mcp),
// so each route asks them the same way: who the client is, whether another website sent
// the request, and whether the client is over its limits. Also the one place that cleans
// the agent name and version an MCP client sends. Nothing here logs or stores anything.
import { clientKey, RATE_LIMIT } from "./limiter.mjs";

/** The client a limit counts against: its address grouped as limiter.mjs does (one IPv6 /64 is one client). */
export const clientOf = (request) => clientKey(request.headers.get("cf-connecting-ip") || "local");

/**
 * True when a browser sent the request from another website (an Origin that is not this site's, "null"
 * included), unless it is one of the exact origins the route names in `allowed`.
 */
export function fromOtherSite(request, allowed = []) {
  const origin = request.headers.get("Origin");
  return Boolean(origin) && origin !== new URL(request.url).origin && !allowed.includes(origin);
}

/** Asks each limiter in turn (a missing one is skipped): the first refusal, or null when all allow it. */
export async function refusedBy(request, ...limiters) {
  const key = clientOf(request);
  for (const limiter of limiters) {
    if (!limiter) continue;
    const verdict = await limiter.limit({ key });
    if (!verdict.success) return verdict;
  }
  return null;
}

/**
 * Per-isolate fixed-window counter, in memory only. Runs before any Durable Object limiter.
 * When full it drops expired entries, then the oldest window starts,
 * so rotating IPs cannot reset every count at once.
 */
export function memoryLimiter(limit = RATE_LIMIT, windowMs = 60_000, now = () => Date.now(), maxKeys = 10_000) {
  const hits = new Map();
  return {
    async limit({ key }) {
      const t = now();
      const entry = hits.get(key);
      if (!entry || t - entry.start >= windowMs) {
        if (hits.size >= maxKeys) {
          // Map order is insertion order (oldest first): only scan when the oldest has expired.
          if (t - hits.values().next().value.start >= windowMs) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
          for (const k of hits.keys()) { if (hits.size < maxKeys) break; hits.delete(k); }
        }
        hits.delete(key);
        hits.set(key, { start: t, count: 1 });
        return { success: true };
      }
      entry.count += 1;
      return entry.count <= limit ? { success: true } : { success: false, max: limit, ms: windowMs };
    },
  };
}

/** The agent's name and version as the tab shows them: strings, at most 60 and 30 characters. */
export function agentInfo(info) {
  return { name: String(info?.name ?? "").slice(0, 60), version: String(info?.version ?? "").slice(0, 30) };
}
