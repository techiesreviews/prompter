import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build, pageScript } from "../scripts/build.mjs";

const dist = process.env.PROMPTER_DIST || build(resolve(import.meta.dirname, "../.scratch/test-dist")).dir;
const html = readFileSync(join(dist, "index.html"), "utf8");
const headers = readFileSync(join(dist, "_headers"), "utf8");

test("the page is one self-contained file: no external scripts, styles or fetches", () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/i);
  assert.doesNotMatch(html, /@import|fetch\(|XMLHttpRequest|import\(/);
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
});

test("the inlined script parses as JavaScript", () => {
  assert.doesNotThrow(() => new Function(pageScript()));
});

test("lex preset lives in one place and reaches the page", () => {
  assert.ok(html.includes("prep first, then intro"));
  assert.equal((readFileSync(resolve(import.meta.dirname, "../src/app.js"), "utf8").match(/five words/g) || []).length, 0);
});
