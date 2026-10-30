#!/usr/bin/env node
// Project adapter for kit doctor, specs, shots and size.
// Evidence: .scratch/prompter/<command>-<time>/. No installs, no deploys.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { kitResult } from "./kit-lib.mjs";

const [command, ...args] = process.argv.slice(2);
const root = process.env.KIT_ROOT || resolve(import.meta.dirname, "../..");
const modulePath = process.env.KIT_PLAYWRIGHT_MODULE || "/home/ubulex/Projects/native-site-editor-dev/node_modules/playwright/index.mjs";
const usage = {
  doctor: "Usage: kit doctor\nChecks Node >=24, git, the build, every kit command's help, Playwright + Chromium launch, cached Wrangler and conflict markers.",
  specs: "Usage: kit specs [name-pattern]\nBuilds dist/ into scratch, then runs node:test files in test/ (parser, links inside a line, presets/checker, #s= round trip, MCP JSON-RPC, size cap, rate limits (in-isolate guard and Durable Object limiter, stubbed), agent tokens, the live relay (stubbed Durable Object: forwards calls, stores only its note, alarm, revoke, 4001/4003), /api routes, token-authorised /mcp (show_script, get_open_script, 401) and the Wait for MCP / Copy MCP messages against the server, build, review-runner model check, demo script (lex), voice following word by word and line by line, camera cues and the CamFrame link client (send once per pass), colour contrast (with the voice-follow line colours) and the read-text veil kept below 2:1).\nOptional pattern is passed to --test-name-pattern.",
  shots: "Usage: kit shots [--static]\nServes the build through local `wrangler dev` (cached Wrangler only) or, with --static or without Wrangler, a local static server.\nCaptures desktop and mobile screenshots of the start screen (with and without Continue), the demo, a QL section of the example script opened from a #s= link (made by the local /mcp when Wrangler runs), the Open and Settings popovers above the floating control bar (Settings: the page's own sliders and two big buttons, Follow my voice and Main screen), Wait for MCP in the Open menu and on the start screen with a scripted agent on the local relay (Copied, Waiting for MCP, the agent's name, show_script opening the script, a second tab taking over and Use this tab, Disconnect MCP then 401, the manual-copy box), the offline Copy MCP, the narrow column, Follow my voice (stubbed speech API with interim results: line by line, white current line, dimmer lines after it), inline links and links inside a sentence (normal, hovered, on the main screen) with the quiet link row, and the reading line dragged high (mouse, touch, keys) with the read text faded above it, and the CamFrame link against a fake CamFrame (off by default, Settings status, cues sent once per pass); checks the moved line drives sections, links, voice and auto-scroll, the fonts load under the CSP, left-aligned text in a centred column, popover anchoring (also without CSS anchor positioning), clock restart, the control bar tucking away on scroll down and returning on scroll up or near the bottom edge, paste, Back to the start, offline file:// use and MCP basics, including a 429 from the local Durable Object limiter.\nBrowser tooling: KIT_PLAYWRIGHT_MODULE or " + modulePath + ".",
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
    for (const file of ["src/core.mjs", "src/agent.mjs", "src/mcp.mjs", "src/limiter.mjs", "src/relay.mjs", "src/token.mjs", "src/worker.mjs", "src/app.js", "src/page.html", "scripts/build.mjs", "wrangler.jsonc", "docs/agents/agent-scripts.md"]) {
      if (!existsSync(join(root, file))) throw Error(`Missing ${file}`);
    }
    for (const name of ["specs", "shots", "size", "review", "wait", "version"]) run(join(root, "scripts/agents/kit"), [name, "--help"]);
    const built = await buildInto(join(out, "dist"));
    if (!existsSync(modulePath)) throw Error(`Missing Playwright at ${modulePath}`);
    const { chromium } = await import(pathToFileURL(modulePath));
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    const wrangler = findWrangler();
    const wranglerVersion = wrangler ? run(wrangler, ["--version"]).trim() : "missing (shots will use a static server)";
    let markers = "";
    try { markers = run("git", ["grep", "-n", "-E", "^(<<<<<<< |=======$|>>>>>>> )", "--", ":!scripts/agents"]).trim(); }
    catch (error) { if (error.status !== 1) throw error; }
    if (markers) throw Error("Conflict markers found");
    const report = { node: process.version, root, head: run("git", ["rev-parse", "HEAD"]).trim(), build: `${built.html.length} bytes`, playwrightModule: modulePath, chromiumLaunch: "passed", wrangler: wrangler || null, wranglerVersion, conflictMarkers: "none" };
    writeFileSync(join(out, "doctor.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "specs") {
    await buildInto(join(out, "dist"));
    const pattern = args.find((a) => !a.startsWith("-"));
    const testArgs = ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", `--test-reporter-destination=${join(out, "specs.tap")}`, ...(pattern ? [`--test-name-pattern=${pattern}`] : []), "test/*.test.mjs"];
    const code = await new Promise((accept) => {
      const child = spawn(process.execPath, testArgs, { cwd: root, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PROMPTER_DIST: join(out, "dist") } });
      child.on("close", accept);
    });
    const tap = readFileSync(join(out, "specs.tap"), "utf8");
    const count = (k) => Number(tap.match(new RegExp(`^# ${k} (\\d+)`, "m"))?.[1] ?? 0);
    const summary = { tests: count("tests"), pass: count("pass"), fail: count("fail") };
    writeFileSync(join(out, "specs.json"), JSON.stringify(summary, null, 2));
    if (code !== 0 || summary.fail) throw Error(`${summary.fail} of ${summary.tests} tests failed`);
    if (!summary.tests) throw Error("no tests ran");
    console.log(`specs: ${summary.pass}/${summary.tests} passed`);
  } else if (command === "shots") {
    const suite = await import(pathToFileURL(join(root, "test/browser/shots.mjs")));
    const dist = join(out, "dist");
    await buildInto(dist);
    const { chromium } = await import(pathToFileURL(modulePath));
    const wrangler = args.includes("--static") ? null : findWrangler();
    const server = wrangler ? await startWrangler(wrangler, dist) : await startStatic(dist);
    cleanups.push(server.stop);
    const browser = await chromium.launch({ headless: true });
    cleanups.push(() => browser.close());
    const report = await suite.run({ browser, base: server.base, mode: server.mode, dist, out });
    writeFileSync(join(out, "shots.json"), JSON.stringify(report, null, 2));
    console.log(`shots (${server.mode}): ${report.checks.length} checks passed; ${report.screenshots.length} screenshots`);
    for (const shot of report.screenshots) console.log(`  ${shot}`);
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
  console.error(error.stack || error.message);
  kitResult("fail", `${command} ${String(error.message).split("\n")[0]}; evidence ${out}`);
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
