#!/usr/bin/env node
// This project's own kit commands: specs (browser checks) and size (scripts/agents/project.d/), and the extra
// doctor checks (checks.doctor in scripts/agents/kit.json). Unit tests run through the shared `kit unit`.
// Evidence: .scratch/prompter/<command>-<time>/. No installs, no deploys.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";

const [command, ...args] = process.argv.slice(2);
const root = process.env.KIT_ROOT || resolve(import.meta.dirname, "../..");
const settings = JSON.parse(readFileSync(join(root, "scripts/agents/kit.json"), "utf8"));
const modulePath = process.env.KIT_PLAYWRIGHT_MODULE || settings.playwright;
const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();
const kitResult = (status, text) => console.log(`RESULT: ${status} ${oneLine(text)}`);
const usage = {
  doctor: "Usage: node scripts/agents/prompter-kit.mjs doctor (run by kit doctor)\nChecks Node >=24, the required files, a scratch build, Playwright + Chromium launch, cached Wrangler (reported, not required) and conflict markers.",
  specs: "Usage: kit specs [suite] [--affected [--base REF]] [--static]\nRuns the browser suites in test/browser/ with screenshots (each file one suite; a name runs only the suites whose file name holds it: kit specs range-field).\n--affected (kit pr uses it) runs the suites the changes since --base (default origin/main; committed or not, new files too) can reach, as scripts/agents/specs-affected.mjs says: range-field for src/ui/, the page suite for anything under src/ (src/ui/ too), fonts/, the build and wrangler.jsonc; none for docs (.md) only.\nThe page suite (page.mjs) serves the build through local `wrangler dev` (cached Wrangler only) or, with --static or without Wrangler, a local static server; suites that need no server (range-field.mjs) skip it.\nWhat each suite checks: the comments and assertion messages in its file. A failure names error.txt (the full error with the values) in the evidence folder.\nPlaywright: KIT_PLAYWRIGHT_MODULE, else \"playwright\" in scripts/agents/kit.json.",
  size: "Usage: kit size\nReports raw and gzip bytes of the built page and the Worker sources. Report only; no budget.",
};
if (args.includes("--help") || args.includes("-h")) { console.log(usage[command] || "Unknown command"); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(root, ".scratch/prompter", `${command}-${stamp}`);
mkdirSync(out, { recursive: true });
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

function findWrangler() {
  try { return run("npx", ["--no-install", "--package", "wrangler", "-c", "command -v wrangler"]).trim() || null; }
  catch { return null; }
}

async function buildInto(dir) {
  const { build } = await import(pathToFileURL(join(root, "scripts/build.mjs")));
  return build(dir);
}

const cleanups = [];
try {
  if (command === "doctor") {
    if (Number(process.versions.node.split(".")[0]) < 24) throw Error("Node >=24 required");
    run("git", ["rev-parse", "--verify", "HEAD"]);
    for (const file of ["src/core.mjs", "src/agent.mjs", "src/mcp.mjs", "src/limiter.mjs", "src/relay.mjs", "src/token.mjs", "src/worker.mjs", "src/app.js", "src/page.html", "scripts/build.mjs", "wrangler.jsonc", "docs/agents/kitchen-extras.md"]) {
      if (!existsSync(join(root, file))) throw Error(`Missing ${file}`);
    }
    const built = await buildInto(join(out, "dist"));
    if (!modulePath || !existsSync(modulePath)) throw Error(`Missing Playwright at ${modulePath} (KIT_PLAYWRIGHT_MODULE or "playwright" in scripts/agents/kit.json)`);
    const { chromium } = await import(pathToFileURL(modulePath));
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    const wrangler = findWrangler();
    const wranglerVersion = wrangler ? run(wrangler, ["--version"]).trim() : "missing (specs will use a static server)";
    let markers = "";
    try { markers = run("git", ["grep", "-n", "-E", "^(<<<<<<< |=======$|>>>>>>> )", "--", ":!scripts/agents"]).trim(); }
    catch (error) { if (error.status !== 1) throw error; }
    if (markers) throw Error("Conflict markers found");
    const report = { node: process.version, root, head: run("git", ["rev-parse", "HEAD"]).trim(), build: `${built.html.length} bytes`, playwrightModule: modulePath, chromiumLaunch: "passed", wrangler: wrangler || null, wranglerVersion, conflictMarkers: "none" };
    writeFileSync(join(out, "doctor.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "specs") {
    // One suite per file in test/browser/; a name runs only the suites whose file name holds it.
    const at = args.indexOf("--base");
    const base = at < 0 ? "origin/main" : args[at + 1];
    if (at >= 0 && (!base || base.startsWith("-") || !args.includes("--affected"))) throw Error(`--base needs a branch or commit after it, and --affected beside it (${usage.specs.split("\n")[0]})`);
    const pick = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--base");
    let names = readdirSync(join(root, "test/browser")).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)).filter((n) => !pick || n.includes(pick));
    if (args.includes("--affected")) {
      const { changedSince, suitesFor } = await import(pathToFileURL(join(root, "scripts/agents/specs-affected.mjs")));
      names = suitesFor(names, changedSince(base, root));
      console.log(`affected since ${base}: ${names.join(", ") || "no browser suite"}`);
      if (!names.length) { kitResult("ok", "specs no browser suite affected"); process.exit(0); }
    }
    if (!names.length) throw Error(`no browser suite matches ${pick}`);
    const suites = await Promise.all(names.map(async (name) => [name, await import(pathToFileURL(join(root, "test/browser", `${name}.mjs`)))]));
    const dist = join(out, "dist");
    await buildInto(dist);
    const { chromium } = await import(pathToFileURL(modulePath));
    let server = { mode: "none" };
    if (suites.some(([, suite]) => suite.needsServer !== false)) {
      const wrangler = args.includes("--static") ? null : findWrangler();
      server = wrangler ? await startWrangler(wrangler, dist) : await startStatic(dist);
      cleanups.push(server.stop);
    }
    const browser = await chromium.launch({ headless: true });
    cleanups.push(() => browser.close());
    const report = { mode: server.mode, suites: {} };
    for (const [name, suite] of suites) {
      report.suites[name] = await suite.run({ browser, base: server.base, mode: server.mode, dist, out });
      writeFileSync(join(out, "specs.json"), JSON.stringify(report, null, 2));
    }
    const all = Object.values(report.suites);
    console.log(`specs (${server.mode}; ${names.join(", ")}): ${all.flatMap((r) => r.checks).length} checks passed; ${all.flatMap((r) => r.screenshots).length} screenshots`);
    for (const shot of all.flatMap((r) => r.screenshots)) console.log(`  ${shot}`);
  } else if (command === "size") {
    const dist = join(out, "dist");
    await buildInto(dist);
    const files = [["dist/index.html", join(dist, "index.html")], ...["src/core.mjs", "src/mcp.mjs", "src/limiter.mjs", "src/relay.mjs", "src/token.mjs", "src/worker.mjs"].map((f) => [f, join(root, f)])];
    const report = files.map(([file, path]) => { const data = readFileSync(path); return { file, bytes: data.length, gzipBytes: gzipSync(data).length }; });
    const worker = report.filter((r) => r.file.startsWith("src/")).reduce((sum, r) => ({ bytes: sum.bytes + r.bytes, gzipBytes: sum.gzipBytes + r.gzipBytes }), { bytes: 0, gzipBytes: 0 });
    const summary = { files: report, workerSourceTotal: worker, note: "Report only. Free plan Worker limit is 3 MB compressed; the page is one self-contained file." };
    writeFileSync(join(out, "size.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } else {
    throw Error(`unknown adapter command ${command}`);
  }
  kitResult("ok", `${command} evidence ${out}`);
} catch (error) {
  // An assertion with its own message leaves the values out of the message: keep them, and
  // the whole error, in the evidence folder so a failure can be read without a rerun.
  const values = "actual" in Object(error) ? `actual:   ${inspect(error.actual, { depth: 6 })}\nexpected: ${inspect(error.expected, { depth: 6 })}\n` : "";
  writeFileSync(join(out, "error.txt"), `${error.details || ""}${values}${error.stack || error.message}\n`);
  console.error(error.stack || error.message);
  if (values) console.log(values.trimEnd());
  kitResult("fail", `${command} ${String(error.message).split("\n")[0]}; details ${join(out, "error.txt")}`);
  process.exitCode = 1;
} finally {
  for (const stop of cleanups.reverse()) { try { await stop(); } catch { /* best effort */ } }
}

async function freePort() {
  const s = createServer();
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  const { port } = s.address();
  await new Promise((ok) => s.close(ok));
  return port;
}

async function startWrangler(wrangler, dist) {
  const temp = join(out, "wrangler-local");
  mkdirSync(temp, { recursive: true });
  const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  delete config.routes;
  delete config.build;
  Object.assign(config, { name: "techies-prompter-local", main: join(root, "src/worker.mjs"), assets: { ...config.assets, directory: dist } });
  writeFileSync(join(temp, "wrangler.json"), JSON.stringify(config, null, 2));
  const port = await freePort();
  let logs = "";
  const child = spawn(wrangler, ["dev", "--config", join(temp, "wrangler.json"), "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", join(temp, "state"), "--show-interactive-dev-session", "false"],
    { cwd: temp, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });
  const stop = async () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    await new Promise((ok) => { if (child.exitCode !== null) ok(); else { child.once("close", ok); setTimeout(ok, 5000); } });
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    writeFileSync(join(out, "wrangler-local.log"), logs);
  };
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) { await stop(); throw Error(`Wrangler exited ${child.exitCode}; see wrangler-local.log`); }
    try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not ready */ }
    if (Date.now() > deadline) { await stop(); throw Error("Wrangler did not start within 60 s; see wrangler-local.log"); }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  return { base, mode: "wrangler", stop };
}

async function startStatic(dist) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    // The page's own headers (the "/*" block of _headers), as Cloudflare sends them.
    const block = readFileSync(join(dist, "_headers"), "utf8").split(/^\/\S*\n/m)[1];
    for (const [, name, value] of block.matchAll(/^ {2}([\w-]+): (.*)$/gm)) res.setHeader(name, value);
    const font = path.match(/^\/fonts\/([\w-]+\.woff2)$/);
    if (font && existsSync(join(dist, "fonts", font[1]))) {
      res.setHeader("Content-Type", "font/woff2");
      res.end(readFileSync(join(dist, "fonts", font[1])));
      return;
    }
    if (path !== "/" && path !== "/index.html") { res.statusCode = path === "/mcp" ? 405 : 404; res.end("Not found"); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(readFileSync(join(dist, "index.html")));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${server.address().port}`, mode: "static", stop: () => new Promise((ok) => server.close(ok)) };
}
