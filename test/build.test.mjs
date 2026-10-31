import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { build, FONTS, LIVE_HOST, pageScript } from "../scripts/build.mjs";

const dist = process.env.PROMPTER_DIST || build(resolve(import.meta.dirname, "../.scratch/test-dist")).dir;
const html = readFileSync(join(dist, "index.html"), "utf8");
const headers = readFileSync(join(dist, "_headers"), "utf8");

test("the page is one self-contained file: no external scripts, styles or fetches", () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/i);
  assert.doesNotMatch(html, /@import|XMLHttpRequest|import\(|sendBeacon|EventSource/);
  // Its only calls go to its own site, for the live connection to your agent: a token and the relay,
  // and, once the CamFrame link is on, to CamFrame on this computer (127.0.0.1 only).
  assert.deepEqual(html.match(/fetch\([^,)]*/g), ["fetch(`${CAMFRAME_ORIGIN}/camframe/${path}`", 'fetch("/api/agent-token"']);
  assert.ok(html.includes('const CAMFRAME_ORIGIN = "http://127.0.0.1:47833";'), "CamFrame is reached on this computer only");
  assert.deepEqual(html.match(/new WebSocket\([^,)]*/g), ["new WebSocket(relayUrl(", "new WebSocket(relayUrl("]);
  assert.ok(html.includes('`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/relay`'), "the relay is on this site");
  assert.doesNotMatch(html, /^export /m);
  assert.ok(html.includes("function parse(md)"));
  assert.ok(html.includes("function rangeField(field"), "the range field's script is inlined");
  assert.ok(html.includes('.range-field > input[type="range"]::-webkit-slider-thumb') && !html.includes("/*@UI-CSS@*/"), "and its styles, at the marker");
  assert.ok(html.includes("<!--SCRIPT-START-->") && html.includes("<!--SCRIPT-END-->"));
});

test("the CSP pins the hash of the inline script", () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.equal(script, pageScript());
  const hash = createHash("sha256").update(script).digest("base64");
  assert.ok(headers.includes(`script-src 'sha256-${hash}'`));
  assert.match(headers, /default-src 'none'/);
  assert.match(headers, /frame-src https:\/\/www\.youtube\.com;/);
  assert.doesNotMatch(headers, /nocookie/);
  assert.match(headers, /font-src 'self';/);
  assert.match(headers, /connect-src 'self' wss:\/\/prompter\.techies\.tools http:\/\/127\.0\.0\.1:47833;/, "calls only to this site and CamFrame on this computer");
});

test("the live build lets search engines in; a preview build allows its own relay and keeps them out", () => {
  assert.equal(readFileSync(join(dist, "robots.txt"), "utf8"), "User-agent: *\nAllow: /\nDisallow: /mcp\n");
  const preview = build(resolve(import.meta.dirname, "../.scratch/test-dist-preview"), { host: "preview.prompter.techies.tools" });
  assert.match(preview.headers, /connect-src 'self' wss:\/\/preview\.prompter\.techies\.tools http:\/\/127\.0\.0\.1:47833;/);
  assert.equal(preview.html, html, "the page itself is the same");
  assert.equal(readFileSync(join(preview.dir, "robots.txt"), "utf8"), "User-agent: *\nDisallow: /\n");
  assert.equal(build(resolve(import.meta.dirname, "../.scratch/test-dist-live"), { host: LIVE_HOST }).headers, headers);
  for (const host of ["", "evil.example; script-src *", "x\n  Y: z", "localhost"]) assert.throws(() => build(resolve(import.meta.dirname, "../.scratch/test-dist-bad"), { host }), /not a host name/);
});

test("the build's command line: --host and --host=, and a bad flag stops it instead of building for the live site", () => {
  const script = resolve(import.meta.dirname, "../scripts/build.mjs");
  const out = resolve(import.meta.dirname, "../.scratch/test-dist-cli");
  const runBuild = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  for (const args of [[out, "--host", "preview.prompter.techies.tools"], ["--host=preview.prompter.techies.tools", out]]) {
    rmSync(out, { recursive: true, force: true });
    assert.equal(runBuild(...args).status, 0, args.join(" "));
    assert.equal(readFileSync(join(out, "robots.txt"), "utf8"), "User-agent: *\nDisallow: /\n", args.join(" "));
  }
  for (const args of [[out, "--host"], [out, "--host", "--other"], [out, "--hots", "x.example"], [out, "extra"], [out, "--host="]]) {
    rmSync(out, { recursive: true, force: true });
    assert.notEqual(runBuild(...args).status, 0, args.join(" "));
    assert.ok(!existsSync(join(out, "robots.txt")), `${args.join(" ")} built nothing`);
  }
});

test("the preview Worker is its own, on its own address, with the live Worker's Durable Objects", () => {
  const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "../wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const preview = config.env.preview;
  assert.equal(config.name, "techies-prompter");
  assert.notEqual(preview.name, config.name, "a test build must never replace the live Worker");
  assert.deepEqual(preview.durable_objects, config.durable_objects, "Wrangler does not carry Durable Objects into an env");
  assert.deepEqual(preview.routes, [{ pattern: "preview.prompter.techies.tools", custom_domain: true }]);
  assert.deepEqual(config.routes, [{ pattern: LIVE_HOST, custom_domain: true }]);
  assert.equal(preview.build.command, `node scripts/build.mjs --host ${preview.routes[0].pattern}`, "the preview's build names its own address");
  assert.equal(config.build.command, "node scripts/build.mjs");
  for (const key of ["observability", "logpush", "tail_consumers"]) assert.ok(!(key in preview), `the preview must not set ${key}: it inherits request logs off`);
  assert.deepEqual(config.observability, { enabled: false });
});

test("the fonts and their licence ship in dist/fonts; the page loads them only when served", () => {
  for (const file of FONTS) assert.ok(existsSync(join(dist, "fonts", file)), file);
  const licence = readFileSync(join(dist, "fonts", "OFL.txt"), "utf8");
  assert.match(licence, /The Inter Project Authors[\s\S]*The Roboto Mono Project Authors[\s\S]*SIL OPEN FONT LICENSE[\s\S]*Version 1\.1/);
  assert.match(headers, /\/fonts\/\*\n {2}Cache-Control: public, max-age=2592000\n/);
  assert.doesNotMatch(html.replace(/<script>[\s\S]*?<\/script>/, ""), /@font-face/, "no @font-face in the stylesheet: offline copies use system fonts");
  assert.ok(pageScript().includes('src:url("/fonts/${file}")'));
});

test("the inlined script parses as JavaScript", () => {
  assert.doesNotThrow(() => new Function(pageScript()));
});

test("lex preset lives in one place and reaches the page", () => {
  assert.ok(html.includes("prep first, then intro"));
  assert.equal((readFileSync(resolve(import.meta.dirname, "../src/app.js"), "utf8").match(/five words/g) || []).length, 0);
});
