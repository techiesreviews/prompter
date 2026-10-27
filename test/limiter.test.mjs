import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clientKey, durableLimiter, hashClient, LIMITS, McpLimiter, slidingWindow } from "../src/limiter.mjs";
import { BURST_LIMIT, RATE_LIMIT } from "../src/mcp.mjs";

test("limits: 60 per minute and a burst cap of 10 per 10 seconds", () => {
  assert.deepEqual(LIMITS, [{ max: RATE_LIMIT, ms: 60_000 }, { max: BURST_LIMIT, ms: 10_000 }]);
  assert.deepEqual([RATE_LIMIT, BURST_LIMIT], [60, 10]);
});

test("sliding window: burst cap, per-minute cap and exact Retry-After", () => {
  let t = 0;
  const w = slidingWindow(LIMITS, () => t);
  for (let i = 0; i < 10; i++) assert.equal(w.hit().success, true);
  assert.deepEqual(w.hit(), { success: false, retryAfter: 10 });
  t = 4_000;
  assert.deepEqual(w.hit(), { success: false, retryAfter: 6 }, "refusals are not counted");
  t = 10_000;
  assert.equal(w.hit().success, true, "the burst window has passed");
  // Spread 60 requests over the minute: the burst cap never trips, the minute cap does.
  let m = 0;
  const minute = slidingWindow(LIMITS, () => m);
  for (let i = 0; i < 60; i++) { m = i * 1_000; assert.equal(minute.hit().success, true, `request ${i}`); }
  m = 59_500;
  assert.deepEqual(minute.hit(), { success: false, retryAfter: 1 }, "the first request leaves the window at 60 s");
  m = 60_000;
  assert.equal(minute.hit().success, true);
});

test("the Durable Object answers 204 or 429 with Retry-After and never touches storage", async () => {
  const storage = new Proxy({}, { get() { throw Error("storage must not be used"); } });
  const object = new McpLimiter({ storage }, {});
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await object.fetch(new Request("https://limiter.internal/", { method: "POST" }))).status);
  assert.deepEqual(codes, [...Array(10).fill(204), 429, 429]);
  const res = await object.fetch(new Request("https://limiter.internal/", { method: "POST" }));
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
  const source = readFileSync(new URL("../src/limiter.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.storage|console\.|setInterval/);
});

test("client keys: IPv4 as is, IPv6 grouped by /64; the hash is salted SHA-256", async () => {
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("2001:db8:0:1::5"), "2001:db8:0:1::/64");
  assert.equal(clientKey("2001:0DB8:0000:0001:aaaa:bbbb:cccc:dddd"), "2001:db8:0:1::/64");
  assert.equal(clientKey("::1"), "0:0:0:0::/64");
  const a = await hashClient("2001:db8:0:1::5");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await hashClient("2001:db8:0:1:ffff::1"));
  assert.notEqual(a, await hashClient("2001:db8:0:2::5"));
  const plain = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("203.0.113.9"))).toString("hex");
  assert.notEqual(await hashClient("203.0.113.9"), plain, "salted, not a bare hash of the IP");
});

function namespace(fetch) {
  const names = [];
  return { names, idFromName(n) { names.push(n); return n; }, get() { return { fetch }; } };
}

test("durable limiter: one object per hashed client, Retry-After passed through", async () => {
  const ns = namespace(async () => new Response(null, { status: 429, headers: { "Retry-After": "4" } }));
  assert.deepEqual(await durableLimiter(ns).limit({ key: "203.0.113.9" }), { success: false, retryAfter: 4 });
  assert.equal(ns.names[0], await hashClient("203.0.113.9"));
  const ok = namespace(async () => new Response(null, { status: 204 }));
  assert.deepEqual(await durableLimiter(ok).limit({ key: "203.0.113.9" }), { success: true });
});

test("durable limiter fails open when the object throws or hangs", async () => {
  const broken = namespace(async () => { throw Error("exceeded daily limit"); });
  assert.deepEqual(await durableLimiter(broken).limit({ key: "x" }), { success: true });
  const throwsOnGet = { idFromName() { throw Error("no namespace"); }, get() {} };
  assert.deepEqual(await durableLimiter(throwsOnGet).limit({ key: "x" }), { success: true });
  const hang = namespace(() => new Promise(() => {}));
  const started = Date.now();
  assert.deepEqual(await durableLimiter(hang, 50).limit({ key: "x" }), { success: true });
  assert.ok(Date.now() - started < 1_000);
});
