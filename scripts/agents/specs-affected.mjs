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
  "reading-wrap": either(/^(src\/(page\.html|app\.js|core\.mjs|settings\.mjs)$|fonts\/|scripts\/build\.mjs$|test\/browser\/reading-wrap\.mjs$)/, RUNNER),
  paragraphs: either(/^(src\/(page\.html|app\.js|core\.mjs|settings\.mjs|reading-line\.mjs)$|fonts\/|scripts\/build\.mjs$|test\/browser\/paragraphs\.mjs$)/, RUNNER),
  // The record light, plus what it checks beside the light: Text only's card, the Producer's cue through
  // /mcp and the relay, the scene at the reading line, R with Follow my voice on (its speech stand-in comes
  // from the page suite), and geometry the fonts decide.
  "record-light": either(/^(src\/(page\.html|app\.js|core\.mjs|obs\.mjs|settings\.mjs|reading-line\.mjs|next-up\.mjs|suggestions\.mjs|wire\.mjs|relay-link\.mjs|worker\.mjs|mcp\.mjs|relay\.mjs|token\.mjs|guard\.mjs|limiter\.mjs|speech\.mjs|follow\.mjs)$|fonts\/|scripts\/build\.mjs$|wrangler\.jsonc$|test\/obs-standin\.mjs$|test\/browser\/(record-light|page)\.mjs$)/, RUNNER),
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
