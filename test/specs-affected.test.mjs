import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  assert.deepEqual(reached("scripts/agents/prompter-kit.mjs"), ["page", "range-field"], "the runner reaches every suite");
  assert.deepEqual(reached("scripts/agents/specs-affected.mjs"), ["page", "range-field"]);
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

test("kit specs --affected compares with origin/<branches.land> by default, origin/main without one", (t) => {
  const root = new URL("..", import.meta.url);
  const kit = fileURLToPath(new URL("scripts/agents/prompter-kit.mjs", root));
  const help = execFileSync(process.execPath, [kit, "specs", "--help"], { encoding: "utf8" });
  const { branches } = JSON.parse(readFileSync(new URL("scripts/agents/kit.json", root), "utf8"));
  assert.ok(help.includes(`default origin/${branches.land},`), help);
  for (const [land, base] of [["dev", "origin/dev"], [undefined, "origin/main"]]) {
    const repo = mkdtempSync(join(tmpdir(), "prompter-specs-base-"));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "scripts/agents"), { recursive: true });
    mkdirSync(join(repo, "test/browser"), { recursive: true });
    copyFileSync(fileURLToPath(new URL("scripts/agents/specs-affected.mjs", root)), join(repo, "scripts/agents/specs-affected.mjs"));
    writeFileSync(join(repo, "scripts/agents/kit.json"), JSON.stringify(land ? { branches: { land } } : {}));
    writeFileSync(join(repo, "test/browser/page.mjs"), "\n");
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    git("init", "-q", "-b", "work");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("update-ref", `refs/remotes/${base}`, "HEAD");
    writeFileSync(join(repo, "notes.md"), "docs only\n");
    const out = execFileSync(process.execPath, [kit, "specs", "--affected"], { encoding: "utf8", env: { ...process.env, KIT_ROOT: repo } });
    assert.ok(out.includes(`affected since ${base}: no browser suite`), out);
  }
});
