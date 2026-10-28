import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build, FONTS, pageScript } from "../scripts/build.mjs";

const dist = process.env.PROMPTER_DIST || build(resolve(import.meta.dirname, "../.scratch/test-dist")).dir;
const html = readFileSync(join(dist, "index.html"), "utf8");
const headers = readFileSync(join(dist, "_headers"), "utf8");

test("the page is one self-contained file: no external scripts, styles or fetches", () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/i);
  assert.doesNotMatch(html, /@import|XMLHttpRequest|import\(|sendBeacon|EventSource/);
  // Its only calls go to its own site, for the live connection to your agent: a token and the relay.
  assert.deepEqual(html.match(/fetch\([^,)]*/g), ['fetch("/api/agent-token"']);
  assert.deepEqual(html.match(/new WebSocket\([^,)]*/g), ["new WebSocket(relayUrl(", "new WebSocket(relayUrl("]);
  assert.ok(html.includes('`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/relay`'), "the relay is on this site");
  assert.doesNotMatch(html, /^export /m);
  assert.ok(html.includes("function parse(md)"));
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
  assert.match(headers, /connect-src 'self' wss:\/\/prompter\.techies\.tools;/, "calls only to this site");
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
