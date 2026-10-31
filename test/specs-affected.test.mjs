import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// `kit specs --affected` (run by kit pr) picks browser suites from test/browser/affected.json.
const reaches = JSON.parse(readFileSync(new URL("browser/affected.json", import.meta.url), "utf8"));
const suites = readdirSync(new URL("browser/", import.meta.url)).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4));
const suitesFor = (file) => suites.filter((n) => new RegExp(reaches[n] || reaches["*"]).test(file)).toSorted();

test("each change runs the browser suites it can reach, and docs run none", () => {
  assert.deepEqual(suitesFor("src/ui/range-field.css"), ["page", "range-field"], "the slider is on the page too");
  assert.deepEqual(suitesFor("src/app.js"), ["page"]);
  assert.deepEqual(suitesFor("fonts/inter-latin.woff2"), ["page"]);
  assert.deepEqual(suitesFor("scripts/build.mjs"), ["page"]);
  assert.deepEqual(suitesFor("wrangler.jsonc"), ["page"]);
  assert.deepEqual(suitesFor("test/browser/page.mjs"), ["page"]);
  assert.deepEqual(suitesFor("test/browser/range-field.mjs"), ["range-field"]);
  assert.deepEqual(suitesFor("docs/agents/kitchen-extras.md"), []);
  assert.deepEqual(suitesFor("README.md"), []);
});

test("every browser suite has a line in affected.json", () => {
  for (const name of suites) assert.ok(name in reaches, `${name}.mjs: add it to test/browser/affected.json`);
});
