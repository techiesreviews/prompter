// The request guard (src/guard.mjs): every route of the Worker gets the same
// checks, in the same order (open /mcp without a token answers any website on
// purpose). A route that skips one fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./runtime.mjs";
import { hashClient } from "../src/limiter.mjs";
import { newToken } from "../src/token.mjs";

const { default: worker } = await import("../src/worker.mjs");
const { agentInfo, clientOf, fromOtherSite } = await import("../src/guard.mjs");
const { relayProtocols } = await import("../src/wire.mjs");

const SITE = "https://prompter.techies.tools";
const EVIL = "https://evil.example";

function env(extra = {}) {
  return {
    ...extra,
    ASSETS: { fetch: () => new Response("asset") },
    RELAY: {
      idFromName: (name) => ({ name }),
      get: () => ({
        fetch: async () => new Response("to the relay"),
        op: async (m) => (m.op === "call" ? { status: "no-tab" } : { status: "ok" }),
      }),
    },
  };
}

// Each route the guard covers, how to ask it, and how many requests a minute one client may make.
const ROUTES = [
  {
    name: "/api/agent-token",
    limit: 20,
    sameSiteOnly: true,
    request: (headers) => new Request(`${SITE}/api/agent-token`, { method: "POST", headers }),
  },
  {
    name: "/api/relay",
    limit: 30,
    sameSiteOnly: true,
    request: (headers) => new Request(`${SITE}/api/relay`, {
      headers: { ...headers, Upgrade: "websocket", "Sec-WebSocket-Protocol": relayProtocols(newToken().token).join(", ") },
    }),
  },
  {
    name: "/mcp with an agent token",
    limit: 60,
    sameSiteOnly: true,
    request: (headers) => new Request(`${SITE}/mcp`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", authorization: `Bearer ${newToken().token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  },
  {
    name: "/mcp without a token",
    limit: 60,
    sameSiteOnly: false, // the open MCP answers any website (CORS *)
    request: (headers) => new Request(`${SITE}/mcp`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  },
];

// The in-memory counters live as long as the module, so every test uses its own addresses.
let block = 0;
const v4 = () => { block += 1; return (n) => `198.51.${block}.${n}`; };
const v6 = () => { block += 1; return (n) => `2001:db8:${block.toString(16)}:7:${n.toString(16)}::1`; };

const call = (route, { ip, origin } = {}) => {
  const headers = {};
  if (ip) headers["cf-connecting-ip"] = ip;
  if (origin) headers.Origin = origin;
  return worker.fetch(route.request(headers), env());
};
const ok = (status) => status !== 403 && status !== 429;

for (const route of ROUTES) {
  test(`${route.name}: this site and agents without an Origin pass; ${route.sameSiteOnly ? "other websites get 403" : "other websites pass too"}`, async () => {
    const ip = v4();
    assert.ok(ok((await call(route, { ip: ip(1) })).status), "no Origin (an agent, curl)");
    assert.ok(ok((await call(route, { ip: ip(2), origin: SITE })).status), "this site");
    const other = await call(route, { ip: ip(3), origin: EVIL });
    const sandboxed = await call(route, { ip: ip(4), origin: "null" });
    if (route.sameSiteOnly) assert.deepEqual([other.status, sandboxed.status], [403, 403]);
    else assert.ok(ok(other.status) && ok(sandboxed.status));
  });

  if (route.sameSiteOnly) {
    test(`${route.name}: requests another website sends never use up the person's limit`, async () => {
      const ip = v4()(1);
      for (let i = 0; i <= route.limit; i++) assert.equal((await call(route, { ip, origin: EVIL })).status, 403);
      assert.ok(ok((await call(route, { ip, origin: SITE })).status), "the person's own request still passes");
    });
  }

  test(`${route.name}: ${route.limit} a minute per client, then 429 with Retry-After; another client is not affected`, async () => {
    const ip = v4();
    for (let i = 0; i < route.limit; i++) assert.ok(ok((await call(route, { ip: ip(1) })).status), `request ${i + 1}`);
    const refused = await call(route, { ip: ip(1) });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("Retry-After"), "60");
    assert.ok(ok((await call(route, { ip: ip(2) })).status));
  });

  test(`${route.name}: one IPv6 /64 is one client, as in the /mcp Durable Object limiter`, async () => {
    const ip = v6();
    for (let i = 0; i < route.limit; i++) assert.ok(ok((await call(route, { ip: ip(i + 1) })).status), `address ${i + 1}`);
    assert.equal((await call(route, { ip: ip(route.limit + 1) })).status, 429, "a new address in the same /64 is the same client");
  });

  test(`${route.name}: an IPv4-mapped IPv6 address is that IPv4 client`, async () => {
    const ip = v4()(9);
    for (let i = 0; i < route.limit; i++) assert.ok(ok((await call(route, { ip: i % 2 ? ip : `::ffff:${ip}` })).status));
    assert.equal((await call(route, { ip: `::ffff:${ip}` })).status, 429);
  });
}

test("/mcp: the Durable Object limiter still gets one object per client (the same hash as from the raw address)", async () => {
  const names = [];
  const MCP_LIMITER = {
    idFromName: (name) => { names.push(name); return { name }; },
    get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
  };
  const addresses = ["2001:db8:5:7::1", "::ffff:cb00:7109", "203.0.113.9", "::ffff:203.0.113.10"];
  for (const ip of addresses) {
    const res = await worker.fetch(ROUTES.find((r) => r.name === "/mcp without a token").request({ "cf-connecting-ip": ip }), env({ MCP_LIMITER }));
    assert.equal(res.status, 200);
  }
  assert.deepEqual(names, await Promise.all(addresses.map(hashClient)));
});

test("clientOf: the limiters' client key from cf-connecting-ip, grouped as limiter.mjs does", () => {
  const req = (ip) => new Request(SITE, ip ? { headers: { "cf-connecting-ip": ip } } : {});
  assert.equal(clientOf(req("203.0.113.5")), "203.0.113.5");
  assert.equal(clientOf(req("::ffff:203.0.113.5")), "203.0.113.5");
  assert.equal(clientOf(req("2001:db8:1:2:3:4:5:6")), "2001:db8:1:2::/64");
  assert.equal(clientOf(req()), "local", "wrangler dev and the tests have no client address");
});

test("fromOtherSite: only an Origin that is not this site's counts", () => {
  const req = (origin) => new Request(`${SITE}/api/relay`, origin ? { headers: { Origin: origin } } : {});
  assert.deepEqual([req(), req(SITE), req(EVIL), req("null"), req(`${SITE}:8443`)].map(fromOtherSite), [false, false, true, true, true]);
});

test("agentInfo: the agent's name and version, cut to 60 and 30 characters, always strings", () => {
  assert.deepEqual(agentInfo({ name: "claude-code".repeat(10), version: "1.2.3".repeat(10) }), { name: "claude-code".repeat(10).slice(0, 60), version: "1.2.3".repeat(10).slice(0, 30) });
  assert.deepEqual(agentInfo({ name: 7 }), { name: "7", version: "" });
  assert.deepEqual(agentInfo({}), { name: "", version: "" });
  assert.deepEqual(agentInfo(null), { name: "", version: "" });
});
