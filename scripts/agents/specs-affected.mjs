// Which browser suites (test/browser/<name>.mjs) a change can reach, for `kit specs --affected`
// (kit pr runs it). Import-only: prompter-kit.mjs and test/specs-affected.test.mjs use it.
import { execFileSync } from "node:child_process";

/** Per suite, the changed paths that reach it; "*" for a suite not named here. Docs (.md) reach none;
 * the specs runner itself (this file, prompter-kit.mjs) reaches every suite. */
const RUNNER = /^scripts\/agents\/(prompter-kit|specs-affected)\.mjs$/;
const either = (a, b) => new RegExp(`${a.source}|${b.source}`);
export const REACHES = {
  "range-field": either(/^(src\/ui\/(?!.*\.md$)|test\/browser\/range-field\.mjs$)/, RUNNER),
  page: either(/^(src\/(?!.*\.md$)|fonts\/|scripts\/build\.mjs$|wrangler\.jsonc$|test\/browser\/page\.mjs$)/, RUNNER),
  "*": either(/^(src\/(?!.*\.md$)|test\/browser\/)/, RUNNER),
};

/** Committed, staged and unstaged changes since the branch left base, and new files not yet added (not ignored ones). */
export function changedSince(base, cwd) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const since = git("merge-base", base, "HEAD").trim();
  return [...new Set([...git("diff", "--name-only", since).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean))];
}

/** The suites, of names, that any changed path reaches. */
export const suitesFor = (names, changed) => names.filter((n) => changed.some((f) => (REACHES[n] || REACHES["*"]).test(f)));
