import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSince, REACHES, suitesFor } from "../scripts/agents/specs-affected.mjs";

// `kit specs --affected` (run by kit pr) runs the browser suites a change can reach.
const suites = readdirSync(new URL("browser/", import.meta.url)).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4));
const reached = (file) => suitesFor(suites, [file]).toSorted();

test("each change runs the browser suites it can reach, and docs run none", () => {
  assert.deepEqual(reached("src/ui/range-field.css"), ["page", "range-field"], "the slider is on the page too");
  assert.deepEqual(reached("src/app.js"), ["page"]);
  assert.deepEqual(reached("fonts/inter-latin.woff2"), ["page"]);
  assert.deepEqual(reached("scripts/build.mjs"), ["page"]);
  assert.deepEqual(reached("wrangler.jsonc"), ["page"]);
  assert.deepEqual(reached("test/browser/page.mjs"), ["page"]);
  assert.deepEqual(reached("test/browser/range-field.mjs"), ["range-field"]);
  for (const doc of ["src/ui/README.md", "docs/agents/kitchen-extras.md", "README.md"]) assert.deepEqual(reached(doc), [], doc);
  assert.deepEqual(suitesFor(["new-suite"], ["src/app.js"]), ["new-suite"], "a suite not named is reached by src/");
});

test("every browser suite has its own line", () => {
  for (const name of suites) assert.ok(name in REACHES, `${name}.mjs: add it to REACHES in scripts/agents/specs-affected.mjs`);
});

test("changes not yet committed count: staged, unstaged and new files, but not ignored ones", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "prompter-affected-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  for (const file of [".gitignore", "base.txt", "staged.txt", "edited.txt"]) writeFileSync(join(repo, file), file === ".gitignore" ? "ignored.txt\n" : "1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "work");
  writeFileSync(join(repo, "committed.txt"), "1\n");
  git("add", "committed.txt");
  git("commit", "-q", "-m", "work");
  writeFileSync(join(repo, "staged.txt"), "2\n");
  git("add", "staged.txt");
  writeFileSync(join(repo, "edited.txt"), "2\n");
  writeFileSync(join(repo, "new.txt"), "1\n");
  writeFileSync(join(repo, "ignored.txt"), "1\n");
  assert.deepEqual(changedSince("main", repo).toSorted(), ["committed.txt", "edited.txt", "new.txt", "staged.txt"]);
});
