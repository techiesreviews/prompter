// Per-client rate limit for /mcp, enforced by one Durable Object per client.
// Privacy: the Worker hashes the client address with a fixed salt before it
// picks the object, so no object ever sees an IP address. The object counts
// in memory only and never touches its storage. Each request first drops the
// times older than the longest window (one minute), and Cloudflare drops an
// idle object from memory, normally 70-140 seconds after its last request,
// with whatever times it still held. So counts are gone within a few minutes
// of a client's last request. (No timer clears them sooner: a pending timer
// would keep the object active and spend the free plan's duration allowance.)
// Scripts never reach the object: it gets an empty request.

export const RATE_LIMIT = 60; // requests per client per minute
export const BURST_LIMIT = 10; // requests per client per 10 seconds (Durable Object only)

export const LIMITS = [
  { max: RATE_LIMIT, ms: 60_000 },
  // Burst cap: stops a client from spending the whole minute in one rush.
  // Eviction normally comes after 70 seconds or more of quiet, longer than the
  // minute window, so it does not hand out a fresh minute early.
  { max: BURST_LIMIT, ms: 10_000 },
];
const SALT = "techies-prompter/mcp-limit/v1";
const TIMEOUT_MS = 1500;

/**
 * Sliding-window log: keeps the times of the last allowed requests (at most
 * the largest `max`). Every hit first prunes times older than the longest
 * window, refused hits included, so a quiet spell of that length empties it.
 * Refused requests are not counted, so a client that waits for Retry-After
 * always gets through. A refusal names the limit that set the wait.
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
      let by = null;
      for (const limit of limits) {
        const recent = times.filter((x) => t - x < limit.ms);
        const w = recent.length >= limit.max ? recent[recent.length - limit.max] + limit.ms - t : 0;
        if (w > wait) { wait = w; by = limit; }
      }
      if (wait > 0) return { success: false, retryAfter: Math.ceil(wait / 1000), max: by.max, ms: by.ms };
      times.push(t);
      if (times.length > keep) times = times.slice(-keep);
      return { success: true };
    },
    /** Number of request times held in memory (for tests). */
    size: () => times.length,
  };
}

/** The Durable Object class. One instance per hashed client, memory only. */
export class McpLimiter {
  constructor() {
    this.window = slidingWindow();
  }

  async fetch() {
    const v = this.window.hit();
    if (v.success) return new Response(null, { status: 204 });
    return new Response(null, { status: 429, headers: { "Retry-After": String(v.retryAfter), "X-Limit": `${v.max}/${v.ms}` } });
  }
}

/**
 * IPv6 clients usually own a whole /64, so they share one counter. An IPv6
 * address that carries an IPv4 one in dotted form (IPv4-mapped "::ffff:a.b.c.d"
 * or the old compatible "::a.b.c.d") counts as that IPv4 address.
 */
export function clientKey(ip) {
  if (!ip.includes(":")) return ip;
  const last = ip.slice(ip.lastIndexOf(":") + 1);
  if (last.includes(".")) return last;
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
        const [max, ms] = String(res.headers.get("x-limit") || "").split("/").map(Number);
        const verdict = { success: false, retryAfter: Number(res.headers.get("retry-after")) || 60 };
        return max > 0 && ms > 0 ? { ...verdict, max, ms } : verdict;
      } catch {
        return { success: true };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
