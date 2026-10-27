// Per-client rate limit for /mcp, enforced by one Durable Object per client.
// Privacy: the Worker hashes the client address with a fixed salt before it
// picks the object, so no object ever sees an IP address. The object counts
// in memory only and never touches its storage; the counts disappear when it
// goes idle (about 10 seconds without requests) and is dropped from memory.
// Scripts never reach the object: it gets an empty request.
import { BURST_LIMIT, RATE_LIMIT } from "./mcp.mjs";

export const LIMITS = [
  { max: RATE_LIMIT, ms: 60_000 },
  // Burst cap. An idle object forgets its counts after about 10 seconds, so a
  // client that pauses to reset them still gets at most 10 per 10 seconds.
  { max: BURST_LIMIT, ms: 10_000 },
];
const SALT = "techies-prompter/mcp-limit/v1";
const TIMEOUT_MS = 1500;

/**
 * Sliding-window log: keeps the times of the last allowed requests (at most
 * the largest `max`). Refused requests are not counted, so a client that
 * waits for Retry-After always gets through.
 */
export function slidingWindow(limits = LIMITS, now = () => Date.now()) {
  const longest = Math.max(...limits.map((l) => l.ms));
  const keep = Math.max(...limits.map((l) => l.max));
  let times = [];
  return {
    hit() {
      const t = now();
      times = times.filter((x) => t - x < longest);
      let wait = 0;
      for (const { max, ms } of limits) {
        const recent = times.filter((x) => t - x < ms);
        if (recent.length >= max) wait = Math.max(wait, recent[recent.length - max] + ms - t);
      }
      if (wait > 0) return { success: false, retryAfter: Math.ceil(wait / 1000) };
      times.push(t);
      if (times.length > keep) times = times.slice(-keep);
      return { success: true };
    },
  };
}

/** The Durable Object class. One instance per hashed client, memory only. */
export class McpLimiter {
  constructor() {
    this.window = slidingWindow();
  }

  async fetch() {
    const { success, retryAfter } = this.window.hit();
    return success ? new Response(null, { status: 204 }) : new Response(null, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }
}

/** IPv6 clients usually own a whole /64, so they share one counter. */
export function clientKey(ip) {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export async function hashClient(ip) {
  const bytes = new TextEncoder().encode(`${SALT}|${clientKey(ip)}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Limiter backed by the Durable Object namespace, with the same `limit({ key })`
 * shape as the in-isolate guard. Fails open: if the object errors or is slow,
 * the request is allowed, and nothing is logged.
 */
export function durableLimiter(namespace, timeoutMs = TIMEOUT_MS) {
  return {
    async limit({ key }) {
      let timer;
      try {
        const stub = namespace.get(namespace.idFromName(await hashClient(key)));
        const late = new Promise((_, fail) => { timer = setTimeout(() => fail(Error("timeout")), timeoutMs); });
        const res = await Promise.race([stub.fetch("https://limiter.internal/", { method: "POST" }), late]);
        if (res.status !== 429) return { success: true };
        return { success: false, retryAfter: Number(res.headers.get("retry-after")) || 60 };
      } catch {
        return { success: true };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
