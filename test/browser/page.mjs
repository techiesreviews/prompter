// Browser checks and screenshots for `kit specs` (the whole page). Runs against a local server
// (wrangler dev or a static server) and against dist/index.html via file://.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEMO_SCRIPT, EXAMPLE_SCRIPT, makeLink, parse } from "../../src/core.mjs";

const DESKTOP = { viewport: { width: 1366, height: 900 } };
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
// Inside the real Settings popover (page CSS around it), a press on the text size's name lands on its
// slider and the value, to the box's edge, takes presses for typing (as range-field.mjs checks alone).
const settingsSliderHits = (p) => Promise.all(["label:first-child", ".range-value"].map((sel) => p.locator(`#settings .size-field ${sel}`).evaluate((el) => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const edge = document.elementFromPoint(r.right - 2, r.top + r.height / 2);
  return [hit.closest(".range-value") ? "value" : hit.id, edge.closest(".range-value") !== null];
})));
// Set the line height or paragraph spacing slider ("line-height", "para-space") or the layout as the
// reader would, with Settings open or closed.
const spaceTo = (p, what, value) => p.evaluate(([what, value]) => {
  if (what === "layout") return document.querySelector(`#settings input[name="layout"][value="${value}"]`).click();
  const el = document.querySelector(`#settings .${what}`);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, [what, value]);
const DEMO_SECTIONS = parse(DEMO_SCRIPT).length;

// Replaces the browser's speech recognition with one the test drives:
// window.__speech.say("words") delivers a final result to the running
// instance; say("wor", true) an interim one, replaced by the next result.
// fail("network") fires error and then end, as browsers do. Like a real one,
// start() while running (or a second time) throws InvalidStateError (counted
// in doubleStarts), and each start is a new session whose results number
// from 0. On-device recognition answers window.__speechOnDevice (unset:
// "unavailable"); install() resolves true. window.__speechBroken makes start() throw.
export const SPEECH_STUB = () => {
  const state = { started: 0, made: 0, aborted: 0, doubleStarts: 0, reused: 0, installs: 0, startedAt: [], instance: null, results: [] };
  class FakeRecognition {
    constructor() { state.made++; }
    static async available() { return window.__speechOnDevice || "unavailable"; }
    static async install() { state.installs++; return true; }
    start() {
      if (window.__speechBroken) throw new Error("this browser cannot start speech recognition");
      if (this.running || this.used) { state.doubleStarts++; if (this.used && !this.running) state.reused++; throw new DOMException("already started", "InvalidStateError"); }
      this.running = true;
      this.used = true;
      state.started++;
      state.startedAt.push(performance.now());
      state.results = [];
      state.instance = this;
    }
    stop() { this.running = false; this.onend?.(); }
    abort() { this.running = false; state.aborted++; }
  }
  state.say = (text, interim = false) => {
    if (state.results.at(-1)?.isFinal === false) state.results.pop();
    const result = [{ transcript: text }];
    result.isFinal = !interim;
    state.results.push(result);
    state.instance?.onresult?.({ results: state.results, resultIndex: state.results.length - 1 });
  };
  state.fail = (error) => {
    const r = state.instance;
    if (!r) return;
    r.onerror?.({ error });
    r.running = false;
    r.onend?.();
  };
  FakeRecognition.prototype.processLocally = false;
  window.__speech = state;
  window.SpeechRecognition = FakeRecognition;
  delete window.webkitSpeechRecognition;
};
// Replaces window.open with a fake main-screen window that records every
// address it is sent to: window.__screen.visits.
const SCREEN_STUB = () => {
  const visits = [];
  let href = "about:blank";
  const fake = {
    closed: false,
    document: { title: "", body: { style: {}, textContent: "" } },
    location: { get href() { return href; }, set href(url) { href = url; visits.push(url); } },
  };
  window.__screen = { visits };
  window.open = (url) => { if (url) fake.location.href = url; return fake; };
};

// A script with a top link and an inline link mid-section, then a section
// whose only link is inline.
const INLINE_SCRIPT = `### **PREP**

- Water within reach

### **INTRO · 00:00**

- Intro: https://example.com/intro

QL: Who keeps plugins safe?

First a short story.
A plugin had a hole.
Someone found it fast.
Patchstack finds the holes.
- Patchstack: https://patchstack.com
They pay researchers.
Researchers report bugs.
Owners fix them quickly.
Everyone stays safer.

### **1 · THE FIREWALL · 03:00**

QL: What blocks attacks?

Firewalls block bad traffic.
Here is one example.
- Wordfence: https://www.wordfence.com
It watches every request.

### **2 · THE DOCS · 05:00**

QL: Where to read more?

The docs explain it all.
- Handbook: https://docs.example.com
`;

// Links written inside a line as [words](https://full-url), next to the same
// words without a link, so the two lines can be compared.
const TEXT_LINK_SCRIPT = `### **INTRO · 00:00**

- Intro: https://example.com/intro
- Guide: https://example.com/guide

QL: Where do links go?

First a short story.
A plugin had a hole.
Someone found it fast.
Read the docs first.
Read [the docs](https://developer.mozilla.org/en-US/) first.
Then we move on.
- See [the firewall](https://www.wordfence.com) too.
More words after.
Owners fix them quickly.
Everyone stays safer.

### **1 · MORE · 03:00**

QL: Anything else?

Nothing else here.
`;

// Camera cues for the CamFrame link (a fake CamFrame answers on 127.0.0.1:47833).
const CUE_FILL = Array.from({ length: 8 }, (_, i) => `Filler line ${i + 1} here.`).join("\n");
const CUE_SCRIPT = `### **PREP**

- Water within reach

### **INTRO · 00:00**

QL: Why cues?

Welcome to the show.
[Share screen. Face small.]
${CUE_FILL}
[Face small, bottom right]
${CUE_FILL}
[Stop share. Face full.]
${CUE_FILL}

### **1 · SCENES · 01:00**

QL: Which Scene?

${CUE_FILL}
[Face: Demo]
${CUE_FILL}
`;
// Text only (TOOLS-491): a top link, a cue with other words, a link on its own line, a reminder and a
// cue on its own, each followed by a spoken line with words of its own (for the stubbed voice).
const TEXT_ONLY_SCRIPT = `### **PREP**

- Water within reach

### **INTRO · 00:00**

- Intro: https://example.com/intro

QL: Why text only?

Welcome to the quiet show.
[Share screen. Face small.]
Here comes the first screen.
${CUE_FILL}
- Patchstack: https://patchstack.com
Patchstack finds the holes.
${CUE_FILL}
[Smile at the camera]
Purple elephants dance quietly tonight.
${CUE_FILL.split("\n").slice(0, 4).join("\n")}
[Face full]
Back to the full camera.
${CUE_FILL}
[Face small]

### **1 · DOCS · 01:00**

The docs explain it all.
${CUE_FILL}
`;
// Distinct words around one cue, so the stubbed voice follows line by line.
const VOICE_CUE_SCRIPT = `### **PREP**

- Water within reach

### **INTRO · 00:00**

Welcome to the camera cue test.
Purple elephants dance quietly tonight.
Seven orange kites drift over hills.
[Face small, bottom right]
Copper trains whistle beyond rivers.
Silver foxes nap beside lanterns.
${CUE_FILL}
`;
// A stand-in for CamFrame on 127.0.0.1:47833 with the Scenes `scenes`. `answer(path, body)`
// may return { status, body, delay } to answer differently (a refused cue, a slow check), or
// { broken: true } to answer with something that is not CamFrame's (a call that did not get
// through: cutting the connection instead would be retried by the browser itself; with
// `saved: true` a layout is saved first, an answer lost on its way back).
// `layouts` null is an older CamFrame; { smallSize, sceneLimit, details } is one with API 2,
// whose Scenes are `details` and which saves layouts as CamFrame does (prompter-link-api.md).
function fakeCamFrame() {
  const seen = [];
  const api = { answer: null, scenes: ["Demo", "Talking head"], layouts: null };
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const status = () => {
    const l = api.layouts;
    if (!l) return { app: "camframe", version: "test", scenes: api.scenes };
    return { app: "camframe", version: "test", scenes: l.details.map((d) => d.name), api: 2, sceneLimit: l.sceneLimit, smallSize: l.smallSize, margin: 32, sceneDetails: l.details };
  };
  const saveScene = (b) => {
    const l = api.layouts;
    if (!l) return { status: 404, body: { ok: false, error: "Not found." } };
    const at = l.details.findIndex((d) => same(d.name, b.name));
    if (at >= 0 && b.replace !== true) return { status: 409, body: { ok: false, error: "exists", code: "scene-exists" } };
    if (at < 0 && l.details.length >= l.sceneLimit) return { status: 409, body: { ok: false, error: "full", code: "scene-limit" } };
    const scene = { id: `s${seen.length}`, name: b.name, kind: "layout", size: b.size === "small" ? l.smallSize : b.size, followsSmallSize: b.size === "small", position: b.position, ...(b.withinRight ? { withinRight: b.withinRight } : {}), keepsLiveLook: true };
    if (at >= 0) l.details[at] = scene; else l.details.push(scene);
    return { status: 200, body: { ok: true, scene, replaced: at >= 0 } };
  };
  const server = createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": req.headers.origin || "*", Vary: "Origin" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true" }).end();
      return;
    }
    // A browser's call from the page always carries Origin; other programs on this computer
    // that probe the port (seen: a Node tool asking for / every 15 s) are answered but not counted.
    if (!req.headers.origin) { res.writeHead(404).end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url, origin: req.headers.origin, body: body ? JSON.parse(body) : undefined });
      const parsed = seen.at(-1).body;
      const custom = api.answer?.(req.url, parsed);
      if (custom?.broken) {
        if (custom.saved && req.url === "/camframe/scenes") saveScene(parsed);
        res.writeHead(200, cors).end("<html>no answer</html>");
        return;
      }
      const saved = !custom?.body && req.url === "/camframe/scenes" ? saveScene(parsed) : null;
      const reply = custom?.body ?? saved?.body ?? (req.url === "/camframe/status" ? status() : { ok: true, cue: parsed });
      const write = () => res.writeHead(custom?.status ?? saved?.status ?? 200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(reply));
      if (custom?.delay) setTimeout(write, custom.delay); else write();
    });
  });
  return Object.assign(api, {
    seen,
    cues: () => seen.filter((r) => r.path === "/camframe/cue").map((r) => r.body),
    saves: () => seen.filter((r) => r.path === "/camframe/scenes").map((r) => r.body),
    // unref: a failed check must not leave this server holding the run open.
    start: () => new Promise((ok, fail) => { server.once("error", fail); server.listen(47833, "127.0.0.1", ok); server.unref(); }),
    stop: () => new Promise((ok) => { server.close(ok); server.closeAllConnections(); }),
  });
}
// Scrolls `page` so cue line `n` sits just above the reading line (plus `dy`).
const passCueOn = (page, n, dy = 0) => page.evaluate(([k, d]) => {
  const el = document.querySelector(`[data-cue="${k}"]`);
  window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - document.querySelector(".reading-line").getBoundingClientRect().top - 2 + d);
}, [n, dy]);
const NO_SPEECH = () => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; };
const NIGHT = "oklch(0.16 0.06 282)"; // --bg, #0b0826

export async function run({ browser, base, mode, dist, out }) {
  const checks = [];
  const screenshots = [];
  const ok = (name, detail = "") => checks.push(detail ? `${name}: ${detail}` : name);
  const shot = async (page, name, fullPage = false) => {
    await page.waitForTimeout(300); // let the 200 ms colour change finish
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file, fullPage });
    screenshots.push(file);
  };
  // Just one element, for a change that only touches it: far smaller to look at than a whole page.
  const closeUp = async (page, sel, name) => {
    const file = join(out, `${name}.png`);
    await page.locator(sel).screenshot({ path: file });
    screenshots.push(file);
  };

  // ---- Server and MCP basics ----
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const csp = home.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src 'sha256-/);
  assert.match(csp, /font-src 'self'/);
  assert.match(home.headers.get("permissions-policy") || "", /microphone=\(self\)/);
  for (const font of ["inter-latin.woff2", "roboto-mono-latin.woff2"]) {
    const res = await fetch(`${base}/fonts/${font}`);
    assert.equal(res.status, 200, font);
    assert.equal(res.headers.get("content-type"), "font/woff2");
  }
  ok("page served with hash-pinned CSP (fonts from this site only); microphone allowed for this page only; both fonts served", mode);

  let link;
  if (mode === "wrangler") {
    const mcp = (body, init = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body), ...init });
    const init = await (await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kit", version: "1" } } })).json();
    assert.equal(init.result.serverInfo.name, "techies-prompter");
    const tools = await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    assert.equal(tools.result.tools.length, 3);
    const made = await (await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "make_prompter_link", arguments: { markdown: EXAMPLE_SCRIPT, preset: "lex" } } })).json();
    link = made.result.structuredContent.link;
    assert.ok(link.startsWith(`${base}/#s=`));
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    const big = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(210 * 1024) });
    assert.equal(big.status, 413);
    ok("local /mcp: initialize, tools/list, make_prompter_link, GET 405, 413 above 200 KB");
    // Four requests above counted; the burst cap (10 per 10 s) refuses within the next 10.
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await mcp({ jsonrpc: "2.0", id: 10 + i, method: "ping" })).status);
    const refused = await mcp({ jsonrpc: "2.0", id: 99, method: "ping" });
    assert.equal(refused.status, 429, `burst statuses: ${codes.join(",")}`);
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    const error = (await refused.json()).error;
    assert.equal(error.code, -32000);
    assert.match(error.message, /Limit: 10 per 10 seconds\./);
    ok("local Durable Object limiter: 429 with Retry-After after the burst cap, naming that limit", codes.join(","));
  } else {
    link = await makeLink(EXAMPLE_SCRIPT, "lex", base);
    ok("static mode: link made with core.makeLink");
  }

  const errors = [];
  // The control bar tucks away after scrolling down; a mouse near the bottom edge brings it back.
  const dock = async (page, sel) => {
    const { width, height } = page.viewportSize();
    await page.mouse.move(width / 2, height - 30);
    await page.locator(`.dock[data-tucked="false"], .dock:not([data-tucked])`).waitFor();
    await page.waitForTimeout(300);
    return page.locator(`.dock ${sel}`);
  };
  const watch = (page, label) => {
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
    page.on("console", (m) => {
      // A static server has no Worker: Wait for MCP's token request gets a 404 there (No connection, try again).
      if (mode === "static" && m.location()?.url?.includes("/api/")) return;
      if (m.type() === "error") errors.push(`${label} console: ${m.text()}`);
    });
  };
  const noOverflow = async (page, label) => {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${label}: page is ${sw}px wide in a ${iw}px viewport`);
  };
  // Follow my voice and the main screen live in the Settings popover: press one there, then
  // close it as a click outside would (focus back on Settings without a keyboard ring).
  const viaSettings = async (page, sel) => {
    await (await dock(page, ".settings-btn")).click();
    await page.locator("#settings:popover-open").waitFor();
    await page.locator(`#settings ${sel}`).click();
    await page.evaluate(() => { const pop = document.querySelector("#settings"); if (pop.matches(":popover-open")) pop.hidePopover(); });
  };
  // Both follow the reading line wherever it is (dragged or the default 34%).
  const scrollToSection = (page, i) => page.evaluate((n) => {
    const el = document.querySelectorAll(".section")[n];
    window.scrollTo(0, el.offsetTop - document.querySelector(".reading-line").getBoundingClientRect().top + 2);
  }, i);

  // A popover opens above its bar button, inside the window.
  const popAbove = async (page, pop, button, label) => {
    await page.locator(`${pop}:popover-open`).waitFor();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
    const [p, b, vw] = [await page.locator(pop).boundingBox(), await page.locator(button).boundingBox(), page.viewportSize().width];
    assert.ok(p.y + p.height <= b.y - 4, `${label}: popover bottom ${Math.round(p.y + p.height)} is above the button top ${Math.round(b.y)}`);
    assert.ok(p.x >= 4 && p.x + p.width <= vw - 4, `${label}: popover ${Math.round(p.x)}–${Math.round(p.x + p.width)} inside ${vw}px`);
    assert.ok(p.x <= b.x + b.width && p.x + p.width >= b.x, `${label}: popover overlaps its button's column`);
    assert.equal(await page.locator(button).getAttribute("aria-expanded"), "true");
    return p;
  };
  const showsStart = (page) => page.locator(".empty:not([hidden])").waitFor();

  // ---- Desktop: the start screen ----
  const desktop = await browser.newContext(DESKTOP);
  await desktop.addInitScript(NO_SPEECH);
  const page = await desktop.newPage();
  watch(page, "desktop");
  await page.goto(`${base}/`);
  await showsStart(page);
  assert.equal(await page.evaluate(() => location.hash), "", "the start screen keeps a clean address");
  assert.equal(await page.locator(".section").count(), 0, "nothing opens by itself");
  assert.equal(await page.locator('.sidebar, .scrim, .side-toggle, [data-action="home"], .problems-btn, .bar').count(), 0, "no sidebar, no top toolbar");
  assert.equal(await page.locator(".dock").isVisible(), false, "no control bar on the start screen");
  assert.equal(await page.locator(".reading-line").isVisible(), false);
  assert.equal(await page.locator(".line-handle").isVisible(), false, "no reading line handle on the start screen");
  assert.equal(await page.locator(".read-veil").isVisible(), false, "no fading veil on the start screen");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), NIGHT);
  const card = page.locator(".empty .card");
  assert.equal(await card.locator("h1").textContent(), "Your teleprompter");
  assert.deepEqual(await card.locator(".choices .btn:not([hidden])").allTextContents(), ["Open a script file", "Paste a script", "Wait for MCP", "Try the demo"]);
  assert.equal(await card.locator(".btn.primary").textContent(), "Open a script file", "one orange primary action");
  assert.match(await card.textContent(), /drop a \.md or \.txt file anywhere[\s\S]*Your script stays on this device/);
  const cardBox = await card.boundingBox();
  assert.ok(Math.abs(cardBox.x + cardBox.width / 2 - 683) < 2 && Math.abs(cardBox.y + cardBox.height / 2 - 450) < 2, `card centred: ${JSON.stringify(cardBox)}`);
  assert.equal(await card.evaluate((el) => getComputedStyle(el).textAlign), "start", "card text starts on the left");
  await shot(page, "start-desktop");
  ok("the plain address shows the start screen: a centred card with one orange Open a script file, Paste, Wait for MCP, Try the demo, the drop hint and the privacy line; no sidebar, no bar, no script; indigo page; Inter and Roboto Mono");

  // Open a script file is a real button: Enter on it opens the file picker.
  await card.locator('[data-action="open-file"]').focus();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
  // A real file on disk, last saved on a known day: the page shows that day, not today.
  const talkFile = join(out, "talk.md");
  writeFileSync(talkFile, "### **PREP**\n\n- Water\n\n### **MY TALK · 00:00**\n\nQL: Is this my file?\n\nYes, my file.");
  utimesSync(talkFile, new Date(2026, 10, 2, 12, 0), new Date(2026, 10, 2, 12, 0));
  await chooser.setFiles(talkFile);
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), 2);
  assert.match(await page.locator(".status").textContent(), /Loaded talk\.md/);
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  await page.goBack();
  await showsStart(page);
  assert.equal(await card.locator(".continue-title").textContent(), "Continue: MY TALK", "the last script is offered by its first section after PREP");
  // A file brings its own save date (the file's last-saved time): the button says it, on the button itself.
  assert.equal(await card.locator(".continue-saved").textContent(), "Saved 2 Nov 2026", "an opened file shows the day it was last saved on Continue");
  assert.equal(await card.locator(".continue-saved").getAttribute("datetime"), "2026-11-02");
  await card.getByRole("button", { name: /^Continue: MY TALK\s+Saved 2 Nov 2026$/ }).waitFor(); // the title and the date are read as two words
  assert.deepEqual(await card.locator(".choices .btn:not([hidden])").evaluateAll((els) => els.map((el) => (el.querySelector(".continue-title") || el).textContent)), ["Continue: MY TALK", "Open a script file", "Paste a script", "Wait for MCP", "Try the demo"]);
  await shot(page, "start-continue-desktop");
  await page.reload();
  await showsStart(page);
  assert.equal(await page.locator(".section").count(), 0, "a remembered script is offered, never opened by itself");
  await card.locator(".continue").click();
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), 2);
  ok("Open a script file works from the keyboard (file picker); Back returns to the start screen, which offers “Continue: MY TALK” first and opens nothing by itself, also after a reload");

  // The old camera-demo address opens the one demo.
  await page.goto(`${base}/`);
  await showsStart(page);
  await page.goto(`${base}/#camera-demo`);
  await page.waitForFunction((n) => document.querySelectorAll(".section").length === n, DEMO_SECTIONS);
  assert.equal(await page.evaluate(() => location.hash), "#demo", "#camera-demo opens the main demo");
  ok("the old #camera-demo address opens the main demo (there is one demo)");

  // Try the demo: the format by example, no buttons in PREP.
  await page.goto(`${base}/`);
  await showsStart(page);
  await card.locator('[data-action="demo"]').click();
  await page.waitForFunction((n) => document.querySelectorAll(".section").length === n, DEMO_SECTIONS);
  assert.equal(await page.evaluate(() => location.hash), "#demo");
  const prep = page.locator(".section").first();
  assert.equal(await prep.locator(".actions, button, label, input").count(), 0, "the demo's PREP has no buttons");
  assert.deepEqual(await prep.locator(".bullet").allTextContents(), ["Water within reach", "Phone on silent", "Camera at eye level", "Text right under the lens", "Read it once aloud"]);
  assert.equal(await page.locator(".dock").isVisible(), true);
  assert.equal(await page.locator(".voice").isHidden(), true, "Follow my voice is hidden without the speech API");
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(await page.evaluate(() => [document.fonts.check("600 52px Inter"), document.fonts.check("500 12px 'Roboto Mono'"), [...document.fonts].map((f) => f.status)]),
    [true, true, ["loaded", "loaded"]], "Inter and Roboto Mono load under the CSP");
  // Text starts on the left inside a centred column; section title left, time right.
  const layout = await page.evaluate(() => {
    const sec = document.querySelectorAll(".section")[1];
    const say = sec.querySelector(".para");
    const title = sec.querySelector(".title > span:first-child").getBoundingClientRect();
    const time = sec.querySelector(".time").getBoundingClientRect();
    const col = document.querySelector(".script");
    const cs = getComputedStyle(col);
    const r = col.getBoundingClientRect();
    return {
      align: [getComputedStyle(say).textAlign, getComputedStyle(sec.querySelector(".ql")).textAlign],
      sayLeft: Math.abs(Math.round(say.getBoundingClientRect().left - (r.left + parseFloat(cs.paddingLeft)))),
      titleLeft: Math.round(title.left - (r.left + parseFloat(cs.paddingLeft))),
      timeRight: Math.abs(Math.round(r.right - parseFloat(cs.paddingRight) - time.right)),
      colWidth: Math.round(r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      colCentre: Math.round(r.left + r.width / 2),
    };
  });
  assert.deepEqual(layout.align, ["start", "start"], "spoken lines and the QL box start on the left");
  assert.equal(layout.sayLeft, 0, "lines start at the column's left edge");
  assert.ok(layout.titleLeft > 0 && layout.titleLeft < 30, `title on the left (after its dot): ${layout.titleLeft}`);
  assert.equal(layout.timeRight, 0, "section time on the right");
  assert.equal(layout.colWidth, 960, "a new visitor gets the medium column");
  assert.equal(layout.colCentre, 683, "the column is centred");
  const dockBox = await page.locator(".dock").boundingBox();
  assert.ok(Math.abs(dockBox.x + dockBox.width / 2 - 683) < 2, "the control bar is centred");
  assert.ok(dockBox.y + dockBox.height <= 900 && dockBox.y > 900 - 100, `control bar at ${Math.round(dockBox.y)}px`);
  assert.deepEqual(await page.locator(".dock > button:not([hidden])").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") || el.textContent.trim())),
    ["Open", "Previous section", "Auto-scroll", "Next section", "Start the show clock, 00:00", "Settings"]);
  await shot(page, "demo-desktop");
  ok("Try the demo: #demo, PREP is a plain checklist (no buttons); text starts on the left in a centred 960px column; section title left, time right; the bar: Open, previous, play, next, clock, Settings (no mic or monitor: those are in Settings), centred at the bottom");

  // Lines still to be read are white in every section (TOOLS-486), never faded with opacity.
  const looks = await page.evaluate(() => {
    const other = document.querySelector(".section:not(.active) [data-k]");
    const cs = getComputedStyle(other);
    return { color: cs.color, opacity: getComputedStyle(other.closest(".section")).opacity };
  });
  assert.deepEqual(looks, { color: "oklch(0.975 0.012 282)", opacity: "1" });
  ok("other sections are white too (--text, oklch 97.5% 0.012 282) at full opacity");

  // The Open popover: above its button; Escape closes it and focus returns.
  await (await dock(page, ".open-btn")).click();
  await popAbove(page, "#open-menu", ".open-btn", "desktop Open");
  assert.deepEqual(await page.locator("#open-menu .item:not([hidden])").allTextContents(), ["Open a script file", "Paste a script", "Copy link", "Wait for MCP", "Back to the start"], "Camera layouts stays hidden without a CamFrame that can save layouts");
  await page.locator('#open-menu [data-action="open-file"]').focus();
  await shot(page, "open-popover-desktop");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#open-menu:popover-open").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("open-btn")), true, "focus returns to the Open button");
  assert.equal(await page.locator(".open-btn").getAttribute("aria-expanded"), "false");
  await (await dock(page, ".open-btn")).click();
  await page.locator("#open-menu:popover-open").waitFor();
  await page.mouse.click(1200, 200);
  assert.equal(await page.locator("#open-menu:popover-open").count(), 0, "a click outside closes it");
  // Your agent over MCP, as in the script editor, lives in the Open menu: Wait for MCP copies a
  // message with a token (Copied and a check for 2 seconds, then Waiting for MCP); the agent's
  // calls reach this tab through the local relay. Its own context, so this page keeps its demo.
  const clip = (page, fail = false) => page.evaluate((fail) => {
    window.__copied = [];
    navigator.clipboard.writeText = async (t) => { if (fail) throw new Error("denied"); window.__copied.push(t); };
  }, fail);
  await (await dock(page, ".open-btn")).click();
  await page.locator("#open-menu:popover-open").waitFor();
  const mcpItem = page.locator("#open-menu .mcp-action");
  assert.deepEqual([await mcpItem.getAttribute("data-state"), await mcpItem.locator(".i-copy").isVisible(), await mcpItem.locator(".mcp-label").getAttribute("aria-live")], ["off", true, "polite"], "Wait for MCP with a copy icon, announced politely");
  assert.equal(await page.locator(".copy-dialog, .ai-dialog, .copy-mcp").count(), 0, "one copy flow: no Copy MCP item or dialog any more");
  // Copy link confirms on its item (Copied and a check, the menu stays open); no status pops up.
  await clip(page);
  const linkItem = page.locator('#open-menu [data-action="copy-link"]');
  await linkItem.click();
  await page.waitForFunction(() => window.__copied.length === 1);
  assert.match(await page.evaluate(() => window.__copied[0]), /#s=/, "the link carries the script");
  assert.deepEqual([await page.locator(".status").textContent(), await linkItem.locator(".share-label").getAttribute("aria-live")], ["Link copied.", null], "screen readers hear Link copied once; the label is only visual");
  assert.deepEqual([await linkItem.textContent(), await linkItem.locator(".i-check").isVisible(), await page.locator("#open-menu:popover-open").count()], ["Copied", true, 1], "Copied with a check, in the open menu");
  assert.deepEqual(await page.locator(".status").evaluate((el) => { const r = el.getBoundingClientRect(); return [r.width <= 1 && r.height <= 1, getComputedStyle(el).clipPath]; }), [true, "inset(50%)"], "status messages are for screen readers only: nothing shows on screen");
  await page.waitForFunction(() => !document.querySelector('#open-menu [data-action="copy-link"][data-copied]'), null, { timeout: 3000 });
  assert.equal(await linkItem.textContent(), "Copy link", "back to Copy link");
  await page.evaluate(() => { window.__status = []; new MutationObserver(() => window.__status.push(document.querySelector(".status").textContent)).observe(document.querySelector(".status"), { childList: true, characterData: true, subtree: true }); });
  await linkItem.click();
  await page.waitForFunction(() => window.__copied.length === 2);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.deepEqual(await page.evaluate(() => window.__status), ["", "Link copied."], "a second copy is read out again (cleared, then set)");
  await page.keyboard.press("Escape");
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  // A scripted agent: one JSON-RPC POST per message with the copied token, as the message says (curl).
  let agentId = 100;
  const agentRpc = async (token, method, params) => {
    for (let tries = 0; ; tries++) {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: agentId++, method, ...(params ? { params } : {}) }) });
      if (res.status === 429 && tries < 3) { await sleep((Number(res.headers.get("retry-after")) || 5) * 1000 + 200); continue; }
      return { status: res.status, body: await res.json() };
    }
  };
  const agentCall = async (token, name, args = {}) => (await agentRpc(token, "tools/call", { name, arguments: args })).body.result;
  const state = (p, sel) => p.locator(sel).getAttribute("data-state");
  const live = await browser.newContext(DESKTOP);
  await live.addInitScript(NO_SPEECH);
  const A = await live.newPage();
  watch(A, "agent tab");
  await A.goto(`${base}/#demo`);
  await A.locator(".section").first().waitFor();
  await clip(A);
  await (await dock(A, ".open-btn")).click();
  await popAbove(A, "#open-menu", ".open-btn", "Open with the agent block");
  const act = A.locator("#open-menu .mcp-action");
  await act.click();
  if (mode === "wrangler") {
    await A.waitForFunction(() => window.__copied.length === 1);
    const [prompt] = await A.evaluate(() => window.__copied);
    const token = prompt.match(/Bearer (tp1-[\w-]+)/)?.[1];
    assert.ok(token, `the message carries a token: ${prompt.slice(0, 300)}`);
    assert.ok(prompt.includes(`Server: \`${base}/mcp\``), "the message names this server's /mcp");
    assert.match(prompt, /temporary, direct MCP connection[\s\S]*Do not modify MCP configuration[\s\S]*Keep the token in memory[\s\S]*`Authorization`[\s\S]*protocolVersion "2025-11-25"[\s\S]*at least 40 seconds[\s\S]*style preset `default`[\s\S]*`get_format`[\s\S]*`check_script`[\s\S]*`show_script`[\s\S]*`get_open_script`[\s\S]*`make_prompter_link` only if I ask[\s\S]*Disconnect MCP: calls then fail with 401/);
    assert.equal(await A.locator("#open-menu:popover-open").count(), 1, "the menu stays open to confirm");
    assert.deepEqual([await act.textContent(), await act.getAttribute("data-copied"), await act.locator(".i-check").isVisible(), await act.locator(".i-copy").isVisible()], ["Copied", "", true, false], "Copied, with a check");
    assert.equal(await A.locator(".status").textContent(), "", "no status line: the menu item alone confirms");
    assert.deepEqual([await A.locator(".open-btn").getAttribute("data-dot"), await A.locator(".open-btn").getAttribute("aria-label")], ["waiting", "Open · waiting for MCP"], "an orange dot on Open");
    await shot(A, "mcp-copied-desktop");
    await A.waitForFunction(() => !document.querySelector("#open-menu .mcp-action[data-copied]"), null, { timeout: 3000 });
    assert.deepEqual([await act.textContent(), await state(A, "#open-menu .mcp-action"), await act.locator(".i-copy").isVisible()], ["Waiting for MCP", "waiting", true], "Waiting for MCP after 2 seconds; pressing again copies again");
    assert.equal(await A.locator(".status").textContent(), "", "no status line while waiting");
    await shot(A, "mcp-waiting-desktop");
    ok("Wait for MCP (Open menu): copies a message with a fresh token (this server's /mcp, a temporary curl connection, Authorization, protocol 2025-11-25, 40 s timeout, the preset, get_format, check_script, show_script, get_open_script, a link only if asked, 401 after Disconnect); Copied with a check for 2 seconds, then Waiting for MCP with an orange dot on the item and on Open; no status line");

    // The agent connects: its name shows; show_script opens the script like a #s= link.
    const init = await agentRpc(token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } });
    assert.equal(init.status, 200);
    assert.match(init.body.result.instructions, /show_script/);
    await A.waitForFunction(() => document.querySelector("#open-menu .mcp-action").dataset.state === "on");
    assert.equal(await A.locator(".agent-row, .agent-rows").count(), 0, "no agent row: the menu shows only Disconnect MCP");
    assert.deepEqual([await act.textContent(), await act.locator(".i-copy").isVisible()], ["Disconnect MCP", false]);
    assert.deepEqual([await A.locator(".open-btn").getAttribute("data-dot"), await A.locator(".open-btn").getAttribute("aria-label"), await A.locator(".open-btn").getAttribute("data-tip")], ["on", "Open · MCP connected to Claude", "Open a script · MCP connected to Claude"]);
    const listed = (await agentRpc(token, "tools/list")).body.result.tools.map((t) => t.name);
    assert.deepEqual(listed, ["get_format", "check_script", "make_prompter_link", "show_script", "get_open_script", "push_suggestions", "clear_suggestions"]);
    const shown = await agentCall(token, "show_script", { markdown: EXAMPLE_SCRIPT, preset: "lex" });
    assert.equal(shown.isError, undefined, JSON.stringify(shown).slice(0, 300));
    assert.match(shown.content[0].text, /^Opened in the prompter \(preset "lex"\)/);
    await A.waitForFunction(() => document.querySelectorAll(".section").length === 5);
    assert.deepEqual(await A.evaluate(() => [location.hash.startsWith("#s=") && location.hash.endsWith("&p=lex"), localStorage.getItem("prompter-last-script"), localStorage.getItem("prompter-preset")]), [true, EXAMPLE_SCRIPT, "lex"], "opened like a #s= link with its preset, and kept as the last script");
    assert.deepEqual(await A.locator("#open-menu .mcp-action").evaluateAll((els) => els.map((el) => el.textContent)), ["Disconnect MCP"], "no status updates in the menu while the agent works");
    await shot(A, "mcp-connected-desktop");
    const read = await agentCall(token, "get_open_script");
    assert.deepEqual(read.structuredContent, { open: true, preset: "lex", markdown: EXAMPLE_SCRIPT });
    // show_script can say when the script was saved: it goes in the address and is remembered with the script.
    const dated = await agentCall(token, "show_script", { markdown: EXAMPLE_SCRIPT, preset: "lex", saved: "2026-11-05" });
    assert.equal(dated.isError, undefined, JSON.stringify(dated).slice(0, 300));
    await A.waitForFunction(() => location.hash.endsWith("&p=lex&d=2026-11-05"));
    assert.equal(await A.evaluate(() => localStorage.getItem("prompter-last-saved")), "2026-11-05");
    assert.equal((await agentCall(token, "show_script", { markdown: EXAMPLE_SCRIPT, preset: "lex", saved: "last Tuesday" })).isError, true, "a made-up date is refused");
    await agentCall(token, "show_script", { markdown: EXAMPLE_SCRIPT, preset: "lex" });
    await A.waitForFunction(() => location.hash.endsWith("&p=lex"));
    assert.equal(await A.evaluate(() => localStorage.getItem("prompter-last-saved")), "", "a script shown without a date forgets the old one");
    ok("an agent with the copied token: initialize turns the item into Disconnect MCP (no agent row, no status updates) with a green dot on Open, its name (claude-code → Claude) in Open's label and tooltip; show_script opens the example script with the lex preset in this tab (a #s= address, remembered as the last script); get_open_script reads it back");

    // The Producer's cues (TOOLS-464): hidden until the agent pushes (no dead control); a small pill in the kind's
    // colour, with no border, at the end of the reading line, the newest on top with a count; a tap or Enter opens
    // it in a box over the dimmed script, with dots; ← → and Page Up/Down move, Enter uses, Esc skips; auto-scroll
    // waits while the box shows and goes on after; the script never moves for it.
    const pill = A.locator(".ask-pill");
    const askBox = A.locator(".ask-box");
    const scriptBox = () => A.evaluate(() => { const r = document.querySelector(".script").getBoundingClientRect(); return [scrollY, r.top, r.left, r.width, r.height]; });
    const pillRow = () => pill.evaluate((p) => [p.dataset.kind, p.textContent, p.getAttribute("aria-label")]);
    const boxRow = () => askBox.evaluate((b) => [b.dataset.kind, b.querySelector(".ask-text").textContent, [...b.querySelectorAll(".ask-dots span")].map((d) => (d.hasAttribute("data-on") ? "●" : "○")).join("")]);
    const autoState = () => A.locator(".dock-btn.auto").getAttribute("aria-pressed");
    const lineTop = () => A.evaluate(() => document.querySelector(".reading-line").getBoundingClientRect().top);
    assert.deepEqual([await pill.isHidden(), await askBox.isHidden()], [true, true], "no pill and no box before the agent pushes anything");
    const listedWithCues = (await agentRpc(token, "tools/list")).body.result.tools.map((t) => t.name);
    assert.deepEqual(listedWithCues.slice(-2), ["push_suggestions", "clear_suggestions"]);
    const before = await scriptBox();
    const Q6 = { kind: "question", text: "What is a session, and what is a cookie?", number: 6 };
    const POINT = { kind: "point", text: "The cookie is the proof of login." };
    const AUD = { kind: "audience", text: "Does this work on WordPress too?" };
    const STEER = { kind: "steer", text: "Back to the plan: cookies first." };
    const pushed = await agentCall(token, "push_suggestions", { items: [Q6] });
    assert.deepEqual(pushed.structuredContent, { shown: true, used: [], skipped: [], asked: [] }, JSON.stringify(pushed).slice(0, 300));
    await pill.waitFor();
    assert.deepEqual(await pillRow(), ["question", "?Question", "Question from the Producer. Open it"]);
    await pill.evaluate((p) => Promise.all(p.getAnimations().map((a) => a.finished))); // the nudge has played
    const pillLook = await pill.evaluate((p) => { const s = getComputedStyle(p); const r = p.getBoundingClientRect(); return [s.borderTopWidth, Math.round(r.top + r.height / 2), Math.round(document.documentElement.clientWidth - r.right), s.boxShadow.includes("inset")]; });
    assert.equal(pillLook[0], "0px", "no border");
    assert.equal(pillLook[3], false, "no edge line in its shadow either");
    assert.ok(Math.abs(pillLook[1] - await lineTop()) <= 2, `on the reading line: ${pillLook}`);
    assert.equal(pillLook[2], 16, "at the end of the line, 16px from the edge");
    assert.deepEqual(await askBox.isHidden(), true, "a push alone does not open the box over a script");
    assert.deepEqual(await scriptBox(), before, "the script did not move for the pill");
    // A narrower window (snapped to half the screen) leaves no room beside the text: the pill moves just
    // above the line, clear of it, and back when the window widens again.
    const colWidth = await A.evaluate(() => document.querySelector("main").getBoundingClientRect().width);
    await A.setViewportSize({ width: Math.round(colWidth + 120), height: DESKTOP.viewport.height });
    await A.waitForFunction(() => document.querySelector(".ask-pill").dataset.place === "above");
    assert.ok((await pill.evaluate((p) => p.getBoundingClientRect().bottom)) <= (await lineTop()) + 0.5, "above the line when the window narrows");
    await A.setViewportSize(DESKTOP.viewport);
    await A.waitForFunction(() => document.querySelector(".ask-pill").dataset.place === "line");
    // Two more come in, the most important first: the newest on top, with a count of the rest.
    await agentCall(token, "push_suggestions", { items: [AUD, POINT] });
    await A.waitForFunction(() => document.querySelector(".ask-pill").dataset.kind === "audience");
    assert.deepEqual(await pillRow(), ["audience", "@Audience+2", "Audience from the Producer, 2 more waiting. Open it"]);
    // (The Open menu and the demo's "would open on your main screen" notice are out of the way for the picture.)
    if (await A.locator("#open-menu:popover-open").count()) await A.keyboard.press("Escape");
    if (await A.locator(".screen-hint").isVisible()) await A.locator('.screen-hint [data-action="hint-ok"]').click();
    await shot(A, "cue-pill-desktop");
    // Auto-scroll on, then the pill opens the box: scrolling waits, the box sits in the middle over the dimmed script.
    await A.evaluate(() => document.activeElement?.blur());
    await A.keyboard.press(" ");
    assert.equal(await autoState(), "true", "auto-scroll on");
    await pill.click();
    await askBox.waitFor();
    assert.deepEqual([await pill.isHidden(), await A.locator(".ask-veil").isVisible(), await autoState()], [true, true, "true"], "the box replaces the pill, over a veil; auto-scroll is still on, it only waits (checked below)");
    assert.deepEqual(await boxRow(), ["audience", AUD.text, "●○○"]);
    const centred = await askBox.evaluate((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.left + r.width / 2 - innerWidth / 2), Math.round(r.top + r.height / 2 - innerHeight / 2), b === document.activeElement, b.getAttribute("aria-label")]; });
    assert.ok(Math.abs(centred[0]) <= 1 && Math.abs(centred[1]) <= 1, `centred: ${centred}`);
    assert.deepEqual(centred.slice(2), [true, "Audience from the Producer"], "the box takes the focus and names the kind");
    // Lex (2026-11-25): never a border, a coloured edge band or a ring on the box, focused or not.
    const boxEdge = await askBox.evaluate((b) => { const s = getComputedStyle(b); return [s.borderTopWidth, s.outlineStyle, s.boxShadow.includes("inset")]; });
    assert.deepEqual(boxEdge, ["0px", "none", false], "no border, edge band or ring on the box");
    const atPause = await A.evaluate(() => scrollY);
    await A.waitForTimeout(400);
    assert.equal(await A.evaluate(() => scrollY), atPause, "the script stands still while the box shows");
    await shot(A, "cue-box-desktop");
    // Play while the box shows turns auto-scroll off and on as always, and the button shows which (pressed
    // state, icon and tip); the script waits for the box either way.
    const playLook = () => A.locator(".dock-btn.auto").evaluate((b) => [b.getAttribute("aria-pressed"), b.dataset.tip, getComputedStyle(b.querySelector(".pause")).display !== "none"]);
    const PLAY_ON_WAITING = ["true", "Auto-scroll waits for the cue · click to turn it off", true];
    const PLAY_OFF_WAITING = ["false", "Auto-scroll is off · click to turn it on after the cue", false];
    assert.deepEqual(await playLook(), PLAY_ON_WAITING, "Play shows auto-scroll on, waiting for the cue");
    await (await dock(A, ".auto")).click();
    assert.deepEqual(await playLook(), PLAY_OFF_WAITING, "a click turns it off, and Play shows it");
    await (await dock(A, ".auto")).click();
    assert.deepEqual(await playLook(), PLAY_ON_WAITING, "a second click turns it on again, and Play shows it");
    await A.waitForTimeout(300);
    assert.equal(await A.evaluate(() => scrollY), atPause, "on or off, the script waits for the box");
    // Space on a focused button of the control bar means auto-scroll while the box shows too, as it does without
    // the box: Play shows the change, the script still waits, and Settings does not open.
    await (await dock(A, ".auto")).focus();
    await A.keyboard.press(" ");
    assert.deepEqual(await playLook(), PLAY_OFF_WAITING, "Space on the focused Play turns auto-scroll off, and Play shows it");
    await (await dock(A, ".settings-btn")).focus();
    await A.keyboard.press(" ");
    assert.deepEqual(await playLook(), PLAY_ON_WAITING, "Space on the focused Settings turns it on again, and Play shows it");
    await A.waitForTimeout(300);
    assert.deepEqual(
      [await A.evaluate(() => scrollY), await A.locator("#settings").evaluate((p) => p.matches(":popover-open")), await askBox.isVisible()],
      [atPause, false, true],
      "the script still waits for the box, Settings stays closed and the cue still shows",
    );
    await askBox.focus(); // back from the control bar, so Enter is Use again
    await A.keyboard.press(" ");
    assert.deepEqual(await playLook(), PLAY_ON_WAITING, "Space on the box itself still waits");
    // The clicker's keys move between the waiting cues, not the sections.
    await A.keyboard.press("ArrowRight");
    assert.deepEqual(await boxRow(), ["point", POINT.text, "○●○"]);
    await A.keyboard.press("PageDown");
    assert.deepEqual(await boxRow(), ["question", Q6.text, "○○●"]);
    await A.keyboard.press("PageDown");
    assert.deepEqual((await boxRow())[2], "○○●", "the last one stays");
    await A.keyboard.press("PageUp");
    await A.keyboard.press("ArrowLeft");
    assert.deepEqual(await boxRow(), ["audience", AUD.text, "●○○"]);
    assert.equal(await A.evaluate(() => scrollY), atPause, "no section jump");
    // A new cue while one is being read: the box stays on it, and the oldest drops off (at most three wait).
    await agentCall(token, "push_suggestions", { items: [STEER] });
    assert.deepEqual(await boxRow(), ["audience", AUD.text, "○●○"], "still on the audience question, now second");
    // Esc skips: the next one at once. Enter uses: the box closes and scrolling goes on.
    await A.keyboard.press("Escape");
    assert.deepEqual(await boxRow(), ["point", POINT.text, "○●"]);
    await A.keyboard.press("Enter");
    await askBox.waitFor({ state: "hidden" });
    assert.deepEqual([await autoState(), await pillRow()], ["true", ["steer", "↩Steer back", "Steer back from the Producer. Open it"]], "auto-scroll goes on; the pill shows what is left");
    // The focus leaves the box without landing on the pill, so no ring is drawn round it (Lex: never a border).
    assert.deepEqual(await pill.evaluate((p) => [p === document.activeElement, getComputedStyle(p).outlineStyle]), [false, "none"], "no ring on the pill after a keyboard Use");
    await A.keyboard.press(" ");
    assert.equal(await autoState(), "false", "Space is auto-scroll again after the box");
    // (Auto-scroll ran a moment between Use and Space: the page scrolled, the script's own box did not change.)
    const [y0, top0, ...rest0] = before;
    const [y1, top1, ...rest1] = await scriptBox();
    assert.deepEqual([y1 + top1, ...rest1], [y0 + top0, ...rest0], "the script's layout never changed for the pill or the box");
    const heard = await agentCall(token, "push_suggestions", { items: [Q6] });
    assert.deepEqual(heard.structuredContent, { shown: true, used: [POINT], skipped: [AUD], asked: [] }, "the next push hears what was used and skipped");
    // Enter opens the pill from the keyboard; a used prepared question goes to the Producer as Asked, once.
    await A.evaluate(() => document.activeElement?.blur());
    await A.keyboard.press("Enter");
    await askBox.waitFor();
    assert.deepEqual(await boxRow(), ["question", Q6.text, "●○"]);
    await askBox.locator('[data-action="ask-use"]').click();
    await askBox.waitFor({ state: "hidden" });
    assert.deepEqual((await agentCall(token, "push_suggestions", { items: [Q6] })).structuredContent, { shown: true, used: [{ kind: "question", text: Q6.text, number: 6 }], skipped: [], asked: [6] });
    assert.deepEqual((await agentCall(token, "push_suggestions", { items: [Q6] })).structuredContent.used, [], "reported once, and a used one does not come back");
    assert.deepEqual(await pillRow(), ["steer", "↩Steer back", "Steer back from the Producer. Open it"]);
    // Space on the focused pill opens it too, and does not start auto-scroll; a tap beside sets it back.
    await pill.focus();
    await A.keyboard.press(" ");
    await askBox.waitFor();
    assert.equal(await A.locator(".dock-btn.auto").getAttribute("aria-pressed"), "false", "Space opened the cue, it did not start auto-scroll");
    // Play turned on while the box shows: it shows on, the script waits, and scrolling starts when the box closes.
    assert.deepEqual(await playLook(), PLAY_OFF_WAITING);
    await (await dock(A, ".auto")).click();
    assert.deepEqual(await playLook(), PLAY_ON_WAITING);
    const waiting = await A.evaluate(() => scrollY);
    await A.waitForTimeout(300);
    assert.equal(await A.evaluate(() => scrollY), waiting, "turned on while the box shows: the script still waits");
    await A.mouse.click(12, 12);
    await askBox.waitFor({ state: "hidden" });
    await A.waitForFunction((y) => scrollY > y, waiting);
    assert.deepEqual(await playLook(), ["true", "Pause · Space", true], "the box closed: auto-scroll runs, as Play showed");
    // Turned off while the box shows: it shows off, and auto-scroll stays off after the box.
    await pill.click();
    await askBox.waitFor();
    await (await dock(A, ".auto")).click();
    assert.deepEqual(await playLook(), PLAY_OFF_WAITING);
    await A.mouse.click(12, 12);
    await askBox.waitFor({ state: "hidden" });
    const stopped = await A.evaluate(() => scrollY);
    await A.waitForTimeout(300);
    assert.deepEqual([await A.evaluate(() => scrollY), await playLook()], [stopped, ["false", "Auto-scroll · Space", false]], "the box closed: auto-scroll stays off, as Play showed");
    // On touch screens the pill, Skip and Use are 44px targets.
    const touchRule = await A.evaluate(() => [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).some((r) => r.media?.mediaText === "(pointer: coarse)" && [...r.cssRules].some((x) => /\.ask-pill/.test(x.selectorText) && /\.ask-foot \.btn/.test(x.selectorText) && x.style.minBlockSize === "44px")));
    assert.equal(touchRule, true, "44px touch targets for the pill, Skip and Use");
    // The longest cue (300 characters) on a phone: the box stays inside the window, its words all there.
    await A.setViewportSize({ width: 390, height: 844 });
    await agentCall(token, "push_suggestions", { items: [{ kind: "point", text: `${"Word ".repeat(59)}end.` }] });
    await pill.click();
    await askBox.waitFor();
    const phoneBox = await askBox.evaluate((b) => {
      const r = b.getBoundingClientRect();
      const use = b.querySelector('[data-action="ask-use"]').getBoundingClientRect();
      const text = b.querySelector(".ask-text");
      const onTop = Boolean(document.elementFromPoint(use.x + use.width / 2, use.y + use.height / 2)?.closest('[data-action="ask-use"]'));
      return [r.left >= 16 - 1, r.right <= innerWidth - 16 + 1, r.top >= 0, r.bottom <= innerHeight, b.scrollWidth <= b.clientWidth, use.bottom <= r.bottom, text.scrollHeight > text.clientHeight, onTop];
    });
    assert.deepEqual(phoneBox, [true, true, true, true, true, true, true, true], "inside the window on a phone; the long words scroll and Use stays in view, nothing over it");
    assert.equal(await A.locator(".screen-hint").isHidden(), true, "the main-screen notice never covers the box");
    await A.keyboard.press("ArrowDown");
    await A.waitForFunction(() => document.querySelector(".ask-text").scrollTop > 0);
    assert.equal((await boxRow())[0], "point", "↓ scrolls a long cue and stays on it");
    await shot(A, "cue-box-mobile");
    // A long unbroken word (a link) wraps inside the box instead of widening it.
    const longLink = { kind: "point", text: `https://example.com/${"a".repeat(270)}` };
    await agentCall(token, "push_suggestions", { items: [longLink] });
    await A.keyboard.press("ArrowLeft");
    assert.ok((await boxRow())[1].startsWith("https://"), "on the link cue");
    assert.equal(await askBox.locator(".ask-text").evaluate((t) => t.scrollTop), 0, "another cue starts at its top, not where the long one was scrolled to");
    assert.deepEqual(await askBox.evaluate((b) => [b.scrollWidth <= b.clientWidth, b.querySelector(".ask-text").scrollWidth <= b.querySelector(".ask-text").clientWidth]), [true, true], "a long link wraps");
    await A.keyboard.press("Escape"); // skips the link cue
    // A tap beside the box closes it; the cue waits behind the pill again.
    await A.mouse.click(195, 12);
    await askBox.waitFor({ state: "hidden" });
    assert.equal((await pillRow())[1], "★Talking point+1");
    // No room right of the text on a phone: the pill sits just above the reading line, never over it.
    await A.waitForFunction(() => document.querySelector(".ask-pill").getAnimations().every((a) => a.playState !== "running"));
    const [phonePlace, phoneBottom] = await pill.evaluate((p) => [p.dataset.place, p.getBoundingClientRect().bottom]);
    assert.deepEqual([phonePlace, phoneBottom <= (await lineTop()) + 0.5], ["above", true], "above the reading line on a phone");
    // A phone on its side (the usual prompter rig): the words get at least two lines, Skip and Use stay in view.
    for (const size of [{ width: 740, height: 360 }, { width: 667, height: 375 }]) {
      await A.setViewportSize(size);
      await pill.click();
      await askBox.waitFor();
      const side = await askBox.evaluate((b) => {
        const r = b.getBoundingClientRect();
        const text = b.querySelector(".ask-text");
        const fits = [...b.querySelectorAll(".ask-foot button")].every((btn) => { const q = btn.getBoundingClientRect(); return q.top >= r.top && q.bottom <= r.bottom && document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2)?.closest("button") === btn; });
        return [fits, text.clientHeight >= 2 * parseFloat(getComputedStyle(text).lineHeight) - 1, r.top >= 0, r.bottom <= innerHeight];
      });
      assert.deepEqual(side, [true, true, true, true], `on its side ${size.width}×${size.height}: two lines of words, Skip and Use in view`);
      await A.mouse.click(8, 8);
      await askBox.waitFor({ state: "hidden" });
    }
    // The reading line dragged to the top of a phone on its side: the pill goes low on the right, whole, clear of the line.
    const handlePct = await A.locator(".line-handle").getAttribute("aria-valuenow");
    await A.locator(".line-handle").focus();
    await A.keyboard.press("Home");
    const low = await pill.evaluate((p) => { const r = p.getBoundingClientRect(); const line = document.querySelector(".reading-line").getBoundingClientRect().top; return [p.dataset.place, r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, r.top > line + 40]; });
    assert.deepEqual(low, ["low", true, true], "the line at the top: the pill low on the right, all of it in view");
    for (let i = 0; i < Math.round((Number(handlePct) - 8) / 10); i++) await A.keyboard.press("PageDown");
    await A.evaluate(() => document.activeElement?.blur());
    await A.setViewportSize(DESKTOP.viewport);
    const cleared = await agentCall(token, "clear_suggestions");
    assert.deepEqual(cleared.structuredContent, { cleared: true, used: [], skipped: [longLink], asked: [] });
    await pill.waitFor({ state: "hidden" });
    assert.equal((await agentCall(token, "push_suggestions", { items: [{ kind: "question", text: "x", number: 0 }] })).isError, true, "a bad push is refused");
    await agentCall(token, "push_suggestions", { items: [Q6] });
    await pill.waitFor();
    ok("the Producer's cues: hidden until the agent pushes; a borderless pill at the end of the reading line, newest on top with +2; a click or Enter opens a centred box with dots over a veil while auto-scroll waits; Play keeps showing whether auto-scroll is on while the box shows, a click, or Space on a focused control bar button, turns it off or on with a tip that says what happens after the cue, and the script does what Play showed once the box closes; ← → and Page Up/Down move between cues, a new cue keeps the box on the one being read, Esc skips, Enter and Use use; auto-scroll goes on after; the next push reports used, skipped and asked [6] once; inside a phone window; a tap beside closes it; clear_suggestions hides it; the script never moves");

    // A second tab takes over; Use this tab takes it back.
    const B = await live.newPage();
    watch(B, "agent second tab");
    await B.goto(`${base}/`);
    await showsStart(B);
    await B.waitForFunction(() => document.querySelector(".empty .mcp-action").dataset.state === "on");
    assert.deepEqual([await B.locator(".empty .mcp-action").textContent(), await B.locator(".open-btn").getAttribute("aria-label")], ["Disconnect MCP", "Open · MCP connected to Claude"], "the new tab is connected, its start screen says so");
    await A.waitForFunction(() => document.querySelector("#open-menu .mcp-action").dataset.state === "elsewhere");
    assert.deepEqual([await act.textContent(), await act.locator(".i-copy").isVisible(), await A.locator(".open-btn").getAttribute("data-dot"), await A.locator(".open-btn").getAttribute("aria-label")],
      ["Use this tab", false, null, "Open · MCP open in another tab"]);
    await shot(A, "mcp-elsewhere-desktop");
    assert.equal(await A.locator(".ask-pill").isHidden(), true, "the Producer's pill goes with the link to the other tab");
    assert.deepEqual((await agentCall(token, "get_open_script")).structuredContent, { open: false }, "calls now reach the new tab (its start screen)");
    // A live show with no script open: no pill, the box shows by itself and takes the focus, so Enter uses a cue
    // even when the host's last click was on Disconnect MCP; the next one shows.
    await B.locator(".empty .mcp-action").focus();
    assert.equal((await agentCall(token, "push_suggestions", { items: [POINT, AUD] })).structuredContent.shown, true);
    const liveBox = B.locator(".ask-box");
    const livePill = B.locator(".ask-pill");
    await liveBox.waitFor();
    assert.deepEqual([await livePill.isVisible(), await liveBox.locator(".ask-text").textContent(), await liveBox.evaluate((b) => b === document.activeElement)], [false, POINT.text, true], "no pill: the box by itself, the newest first, with the focus");
    await shot(B, "cue-box-live-desktop");
    for (const key of ["Shift+Tab", "Tab", "Tab"]) {
      await B.keyboard.press(key);
      assert.equal(await B.evaluate(() => Boolean(document.activeElement?.closest(".empty, .script"))), false, `${key} never reaches what the veil covers`);
    }
    await liveBox.focus();
    await B.keyboard.press("Enter");
    await B.waitForFunction((t) => document.querySelector(".ask-box .ask-text").textContent === t, AUD.text);
    assert.equal(await state(B, ".empty .mcp-action"), "on", "Enter used the cue, it did not press Disconnect MCP");
    // A tap beside sets it aside: the start screen can be used again, and a pill brings the box back.
    await B.mouse.click(20, 20);
    await liveBox.waitFor({ state: "hidden" });
    await livePill.waitFor();
    const cardClear = () => B.evaluate(() => [...document.querySelectorAll(".empty .card button")].filter((btn) => btn.offsetParent).every((btn) => { const r = btn.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("button") === btn; }));
    assert.deepEqual([await cardClear(), await livePill.getAttribute("data-place")], [true, "corner"], "the start screen's buttons can be reached; the pill waits in the corner");
    await B.setViewportSize(MOBILE.viewport);
    await B.waitForTimeout(100);
    const cardBox = await B.locator(".empty .card").boundingBox();
    const pillBox = await livePill.boundingBox();
    assert.deepEqual([await cardClear(), pillBox.y + pillBox.height <= cardBox.y], [true, true], "on a phone too, the pill is clear of the start card");
    await B.setViewportSize(DESKTOP.viewport);
    await livePill.click();
    await liveBox.waitFor();
    assert.equal(await liveBox.locator(".ask-text").textContent(), AUD.text);
    assert.deepEqual((await agentCall(token, "clear_suggestions")).structuredContent.used, [POINT]);
    await liveBox.waitFor({ state: "hidden" });
    ok("a live show (no script open): no pill, the box shows by itself and takes the focus; Enter uses one and shows the next; a tap beside sets it aside behind a pill");
    if (!(await A.locator("#open-menu:popover-open").count())) await (await dock(A, ".open-btn")).click();
    await act.click();
    await A.waitForFunction(() => document.querySelector("#open-menu .mcp-action").dataset.state === "on");
    await B.waitForFunction(() => document.querySelector(".empty .mcp-action").dataset.state === "elsewhere");
    assert.equal(await B.locator(".empty .mcp-action").textContent(), "Use this tab");
    assert.equal((await agentCall(token, "get_open_script")).structuredContent.open, true, "back in the first tab");
    await A.locator(".ask-pill").waitFor();
    await B.close();
    ok("a second tab with the same token takes over (the first shows Use this tab and loses its dot; calls go to the new tab); Use this tab takes it back");

    // Disconnect MCP: off at once, the token forgotten, the agent refused with 401.
    const statusBefore = await A.locator(".status").textContent();
    await act.click();
    assert.deepEqual([await act.textContent(), await state(A, "#open-menu .mcp-action"), await A.locator(".open-btn").getAttribute("data-dot"), await A.locator(".open-btn").getAttribute("aria-label")],
      ["Wait for MCP", "off", null, "Open"]);
    assert.equal(await A.evaluate(() => localStorage.getItem("prompter-agent")), null);
    assert.equal(await A.locator(".status").textContent(), statusBefore, "no status line for Disconnect");
    assert.deepEqual([await A.locator(".ask-pill").isHidden(), await A.locator(".ask-box").isHidden()], [true, true], "Disconnect MCP also ends the Producer's cues");
    let refused;
    for (let i = 0; i < 25 && refused !== 401; i++) { refused = (await agentRpc(token, "tools/list")).status; if (refused !== 401) await sleep(200); }
    assert.equal(refused, 401, "after Disconnect MCP the token gets 401");
    const after = await agentRpc(token, "tools/call", { name: "show_script", arguments: { markdown: EXAMPLE_SCRIPT } });
    assert.deepEqual([after.status, after.body.error.code], [401, -32001]);
    ok("Disconnect MCP: back to Wait for MCP at once, no dot, the token dropped from this browser; the agent's next calls get 401");

    // Without a clipboard the message is shown, selected, to copy by hand.
    await clip(A, true);
    await act.click();
    const box = A.locator("#open-menu .mcp-prompt");
    await box.waitFor();
    assert.deepEqual(await box.evaluate((el) => [el.selectionStart, el.selectionEnd === el.value.length, document.activeElement === el, /Bearer tp1-/.test(el.value)]), [0, true, true, true], "the message, selected, in the menu");
    assert.equal(await act.textContent(), "Waiting for MCP");
    await shot(A, "mcp-manual-desktop");
    await A.keyboard.press("Escape");
    assert.equal(await box.isHidden(), true, "closing the menu hides it");
    ok("without a clipboard the message shows selected in the Open menu, to copy by hand");
  } else {
    await A.waitForFunction(() => document.querySelector("#open-menu .mcp-label").textContent === "No connection, try again");
    assert.deepEqual([await act.locator(".i-copy").isVisible(), await A.evaluate(() => window.__copied.length)], [false, 0]);
    ok("static mode: Wait for MCP without the Worker says No connection, try again, and copies nothing");
  }
  await live.close();

  // One click from the Producer (TOOLS-464): its page asks this site for a token (CORS for its address only)
  // and opens the prompter with #producer; the tab drops the mark at once, says ready to its opener at the
  // Producer's addresses only, takes the token from that page's answer (never from the address), connects,
  // says it is linked to the Producer, tells only its opener its state (never the token), and the Producer's
  // Disconnect ends this tab's link too. The Producer's page is played here by a stand-in at its real address.
  if (mode === "wrangler") {
    const PRODUCER = "https://producer.techies.tools";
    const pre = await fetch(`${base}/api/agent-token`, { method: "OPTIONS", headers: { origin: PRODUCER, "access-control-request-method": "POST" } });
    assert.deepEqual([pre.status, pre.headers.get("access-control-allow-origin")], [204, PRODUCER]);
    const elsewhere = await fetch(`${base}/api/agent-token`, { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "POST" } });
    assert.deepEqual([elsewhere.status, elsewhere.headers.get("access-control-allow-origin")], [403, null], "any other site is refused");
    const minted = await fetch(`${base}/api/agent-token`, { method: "POST", headers: { origin: PRODUCER } });
    assert.equal(minted.headers.get("access-control-allow-origin"), PRODUCER);
    const { token: handed } = await minted.json();
    const setup = await browser.newContext(DESKTOP);
    await setup.addInitScript(NO_SPEECH);
    // The stand-in answers the tab's ready with the token, as the Producer does: a second later, as when its
    // token request is still on its way when the tab opens (unless `holdToken` is set: the test then posts it by hand).
    const STAND_IN = "<!doctype html><title>Producer stand-in</title><script>window.heard = []; addEventListener('message', (e) => { heard.push([e.origin, e.data]); if (e.data?.type === 'prompter:ready' && e.source === window.prompterTab && !window.holdToken) setTimeout(() => e.source.postMessage({ type: 'prompter:token', token: window.handOut }, e.origin), 1000); });</script>";
    await setup.route(`${PRODUCER}/**`, (route) => route.fulfill({ contentType: "text/html", body: STAND_IN }));
    await setup.route("https://evil.example/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Another site</title>" }));
    const producer = await setup.newPage();
    watch(producer, "producer stand-in");
    await producer.goto(`${PRODUCER}/`);
    const [P] = await Promise.all([
      setup.waitForEvent("page"),
      producer.evaluate(([url, token]) => { window.handOut = token; window.prompterTab = window.open(url, "_blank"); }, [`${base}/#producer`, handed]),
    ]);
    watch(P, "prompter from the Producer");
    await showsStart(P);
    assert.equal(await P.evaluate(() => location.hash), "", "the mark is gone from the address at once");
    await P.waitForFunction(() => document.querySelector(".empty .mcp-action").dataset.state === "waiting");
    assert.equal(await P.locator(".open-btn").getAttribute("aria-label"), "Open · waiting for MCP, linked to your Producer");
    assert.equal(await P.evaluate(() => localStorage.getItem("prompter-agent")?.includes('"producer":true')), true, "kept as the Producer's link, for a reload");
    assert.equal((await agentRpc(handed, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } })).status, 200);
    await P.waitForFunction(() => document.querySelector(".open-btn").getAttribute("aria-label") === "Open · MCP connected to Claude, linked to your Producer");
    await shot(P, "producer-linked-desktop");
    await producer.waitForFunction(() => window.heard.some(([, d]) => d?.state === "on"));
    const heard = await producer.evaluate(() => window.heard);
    assert.deepEqual(heard.map(([o, d]) => [o, d.type, d.state]), [[base, "prompter:ready", undefined], [base, "prompter:link", "waiting"], [base, "prompter:link", "on"]], "the opener hears ready, then the state, from the prompter's address");
    assert.equal(JSON.stringify(heard).includes(handed), false, "never the token");
    // The token is taken once: a second one from the same Producer page changes nothing.
    const kept = await P.evaluate(() => localStorage.getItem("prompter-agent"));
    const { token: second } = await (await fetch(`${base}/api/agent-token`, { method: "POST" })).json();
    await producer.evaluate(([url, token]) => window.prompterTab.postMessage({ type: "prompter:token", token }, url), [base, second]);
    await sleep(300);
    assert.deepEqual([await P.evaluate(() => localStorage.getItem("prompter-agent")) === kept, (await agentRpc(handed, "tools/list")).status, await state(P, ".empty .mcp-action")], [true, 200, "on"], "a second token is ignored; the first still works");
    // A live show from the Producer: no script, so its first question shows by itself.
    await agentCall(handed, "push_suggestions", { items: [{ kind: "question", text: "Who are you, and what do you build?", number: 1 }] });
    await P.locator(".ask-box").waitFor();
    await shot(P, "producer-live-question-desktop");
    // A message from any other page is ignored; the Producer's Disconnect ends the link.
    await P.evaluate(() => window.postMessage({ type: "prompter:disconnect" }, "*"));
    await sleep(300);
    assert.equal(await state(P, ".empty .mcp-action"), "on", "a message from the tab itself (not the opener) changes nothing");
    await producer.evaluate(([url]) => window.prompterTab.postMessage({ type: "prompter:disconnect" }, url), [base]);
    await P.waitForFunction(() => document.querySelector(".empty .mcp-action").dataset.state === "off");
    assert.equal(await P.locator(".ask-box").isHidden(), true, "the box goes with the link");
    await producer.waitForFunction(() => window.heard.at(-1)?.[1]?.state === "off");
    let gone;
    for (let i = 0; i < 25 && gone !== 401; i++) { gone = (await agentRpc(handed, "tools/list")).status; if (gone !== 401) await sleep(200); }
    assert.equal(gone, 401, "the Producer's token is revoked");
    // The Producer's Disconnect before its token came: the tab takes no token after.
    const { token: late } = await (await fetch(`${base}/api/agent-token`, { method: "POST" })).json();
    await producer.evaluate(() => { window.heard = []; });
    const [P2] = await Promise.all([
      setup.waitForEvent("page"),
      producer.evaluate(([url, token]) => { window.handOut = token; window.prompterTab = window.open(url, "_blank"); }, [`${base}/#producer`, late]),
    ]);
    watch(P2, "prompter, Disconnect before the token");
    await producer.waitForFunction(() => window.heard.some(([, d]) => d?.type === "prompter:ready"));
    await producer.evaluate(([url]) => window.prompterTab.postMessage({ type: "prompter:disconnect" }, url), [base]);
    await sleep(1500); // the stand-in's token comes after a second
    assert.deepEqual([await state(P2, ".empty .mcp-action"), await P2.evaluate(() => localStorage.getItem("prompter-agent"))], ["off", null], "the late token is not taken");
    await P2.close();
    // A link anyone could send, with a real token in the address, connects nothing: the token never comes from there.
    const { token: sent } = await (await fetch(`${base}/api/agent-token`, { method: "POST" })).json();
    const lone = await setup.newPage();
    watch(lone, "prompter from a sent link");
    await lone.goto(`${base}/#producer=${sent}`);
    await showsStart(lone);
    await sleep(300);
    assert.deepEqual([await state(lone, ".empty .mcp-action"), await lone.evaluate(() => location.hash), await lone.evaluate(() => localStorage.getItem("prompter-agent"))], ["off", "", null], "a token in a sent link is ignored and dropped from the address");
    await lone.close();
    // Another site that opens the prompter to link it hears no ready, and the token it posts is ignored.
    const evil = await setup.newPage();
    watch(evil, "another site");
    await evil.goto("https://evil.example/");
    const [E] = await Promise.all([
      setup.waitForEvent("page"),
      evil.evaluate(([url]) => { window.heard = []; addEventListener("message", (e) => heard.push(e.data)); window.tab = window.open(url, "_blank"); }, [`${base}/#producer`]),
    ]);
    watch(E, "prompter opened by another site");
    await showsStart(E);
    await evil.evaluate(([token]) => window.tab.postMessage({ type: "prompter:token", token }, "*"), [sent]);
    await sleep(300);
    assert.deepEqual([await state(E, ".empty .mcp-action"), await evil.evaluate(() => window.heard.length)], ["off", 0], "another site hears nothing and cannot hand a token");
    // An old Producer link still kept on this device (its Producer page was closed without Disconnect, its
    // agent still connected, a cue showing; TOOLS-476): a new one-click setup ends it quietly, so the Producer
    // never hears "off" (nor the old link's states) in between, and the old agent's cue goes with it.
    const { token: old } = await (await fetch(`${base}/api/agent-token`, { method: "POST" })).json();
    const { token: fresh } = await (await fetch(`${base}/api/agent-token`, { method: "POST" })).json();
    await E.evaluate(([token]) => localStorage.setItem("prompter-agent", JSON.stringify({ token, createdAt: Date.now(), producer: true })), [old]);
    await E.close();
    await producer.evaluate(() => { window.heard = []; window.holdToken = true; });
    const [P3] = await Promise.all([
      setup.waitForEvent("page"),
      producer.evaluate(([url]) => { window.prompterTab = window.open(url, "_blank"); }, [`${base}/#producer`]),
    ]);
    watch(P3, "prompter from the Producer over an old link");
    await producer.waitForFunction(() => window.heard.some(([, d]) => d?.type === "prompter:ready"));
    assert.equal((await agentRpc(old, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } })).status, 200);
    await P3.waitForFunction(() => document.querySelector(".empty .mcp-action").dataset.state === "on");
    await agentCall(old, "push_suggestions", { items: [{ kind: "question", text: "Old cue" }] });
    await P3.locator(".ask-box").waitFor();
    await producer.evaluate(([url, token]) => window.prompterTab.postMessage({ type: "prompter:token", token }, url), [base, fresh]);
    await P3.waitForFunction((token) => localStorage.getItem("prompter-agent")?.includes(token), fresh);
    assert.equal((await agentRpc(fresh, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } })).status, 200);
    await producer.waitForFunction(() => window.heard.some(([, d]) => d?.state === "on"));
    await sleep(300);
    assert.deepEqual([await P3.locator(".ask-box").isHidden(), await P3.locator(".ask-pill").isHidden()], [true, true], "the old agent's cue went with its link: it does not come back with the new agent");
    assert.deepEqual((await producer.evaluate(() => window.heard)).map(([, d]) => [d.type, d.state]), [["prompter:ready", undefined], ["prompter:link", "waiting"], ["prompter:link", "on"]], "the opener hears ready, waiting, on: never off while the old link ends");
    let oldGone;
    for (let i = 0; i < 25 && oldGone !== 401; i++) { oldGone = (await agentRpc(old, "tools/list")).status; if (oldGone !== 401) await sleep(200); }
    assert.deepEqual([oldGone, (await agentRpc(fresh, "tools/list")).status], [401, 200], "the old token is revoked; the new one works");
    await setup.close();
    ok("one click from the Producer: /api/agent-token answers its address (CORS) and refuses others; #producer leaves the address at once, the tab says ready to the Producer only and takes the token from its answer, connects (waiting, then on), Open says linked to your Producer; the opener hears ready/waiting/on/off, never the token; a live show shows the first question by itself; the Producer's Disconnect ends the link and revokes the token, and before the token comes, none is taken; a token in a sent link and another site's messages are ignored; over an old Producer link kept on this device, the opener hears ready/waiting/on (never off), the old token is revoked, and the old agent's cue does not come back");
  }

  // Paste from the Open popover.
  await (await dock(page, ".open-btn")).click();
  await page.locator('#open-menu [data-action="paste"]').click();
  await page.locator(".paste-dialog[open]").waitFor();
  await page.locator('[data-action="open-paste"]').click();
  await page.locator(".paste-error:not([hidden])").waitFor();
  await page.locator("#paste-text").fill("### **HELLO · 00:00**\n\nQL: Is this pasted?\n\nYes, pasted.");
  await page.locator('[data-action="open-paste"]').click();
  await page.locator(".paste-dialog:not([open])").waitFor({ state: "attached" });
  assert.equal(await page.locator(".section").count(), 1);
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  ok("Paste a script: empty text shows an error; a script opens and gets a #s= address");

  // Back to the start, then Continue.
  await (await dock(page, ".open-btn")).click();
  await page.locator('#open-menu [data-action="start"]').click();
  await showsStart(page);
  assert.equal(await page.evaluate(() => location.hash), "");
  assert.equal(await card.locator(".continue").textContent(), "Continue: HELLO");
  assert.equal(await card.locator(".continue-saved").isVisible(), false, "a pasted script has no known save date, so the old one does not stay");
  await page.goBack();
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), 1, "browser Back returns to the script");
  ok("Open › Back to the start shows the start screen with Continue: HELLO; browser Back returns to the script");

  // ---- Desktop: a #s= link from /mcp ----
  await page.goto(link);
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), 5);
  assert.equal(await page.locator(".ql").count(), 4);
  assert.equal(await page.locator(".link").count(), 4);
  const introFirst = await page.locator(".section").nth(1).locator("p").first().getAttribute("class");
  assert.equal(introFirst, "ql");
  assert.match(await page.evaluate(() => location.hash), /&p=lex$/);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".section.active").getAttribute("data-i"), "2");
  await (await dock(page, ".next")).click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".section.active").getAttribute("data-i"), "3");
  await (await dock(page, ".prev")).click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".section.active").getAttribute("data-i"), "2");
  await shot(page, "ql-section-desktop");
  ok("link opens the example: 5 sections, QL first, 4 links in the top rows, &p=lex kept; arrow keys and the bar's previous/next move sections");

  // Play is the orange primary button; it toggles auto-scroll like Space.
  await (await dock(page, ".auto")).click();
  assert.equal(await page.locator(".dock .auto").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".dock .auto").getAttribute("data-tip"), "Pause · Space");
  await page.keyboard.press(" ");
  assert.equal(await page.locator(".dock .auto").getAttribute("aria-pressed"), "false", "Space on the focused play button toggles once");
  // The clock: the first press starts it, the next press starts it over from 00:00.
  const clock = await dock(page, ".clock");
  assert.equal(await clock.getAttribute("data-tip"), "Start the show clock");
  await clock.click();
  assert.equal(await clock.getAttribute("data-running"), "true");
  assert.equal(await clock.getAttribute("data-tip"), "Show clock · click to restart from 00:00");
  await page.waitForFunction(() => document.querySelector(".clock-time").textContent === "00:02", null, { timeout: 4000 });
  await clock.click();
  assert.equal(await page.locator(".clock-time").textContent(), "00:00", "pressing the clock again restarts it");
  assert.equal(await clock.getAttribute("data-running"), "true");
  await scrollToSection(page, 2);
  await page.waitForFunction(() => document.querySelector(".clock").dataset.late === "false");
  await page.evaluate(() => { const t = Date.now; Date.now = () => t() + 10 * 60 * 1000; });
  await page.waitForFunction(() => document.querySelector(".clock").dataset.late === "true", null, { timeout: 3000 });
  await scrollToSection(page, 2);
  await (await dock(page, ".next")).hover();
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".dock .next").evaluate((el) => getComputedStyle(el, "::after").opacity), "1", "tooltip on hover");
  const dockClip = await page.locator(".dock").boundingBox();
  await page.screenshot({ path: join(out, "dock-desktop.png"), clip: { x: dockClip.x - 40, y: dockClip.y - 60, width: dockClip.width + 80, height: dockClip.height + 70 } });
  screenshots.push(join(out, "dock-desktop.png"));
  await page.mouse.move(700, 300);
  ok("play (orange) toggles auto-scroll, Space on it toggles once; the clock starts on the first press and restarts from 00:00 on the next (tooltip says so), and still turns late; tooltips on hover");

  // Settings: text size, scroll speed and width (remembered after a reload), then Follow my
  // voice (only with the speech API), the main screen and the CamFrame link (off).
  await (await dock(page, ".settings-btn")).click();
  await popAbove(page, "#settings", ".settings-btn", "desktop Settings");
  assert.deepEqual(await page.locator("#settings").evaluate((el) => [...el.querySelectorAll(".setting:not([hidden])")].map((row) => row.querySelector("legend, label").textContent.trim())),
    ["Text size", "Scroll speed", "Line height", "Paragraph spacing", "Width", "Layout", "Show"], "the OBS password row shows only while the OBS link is on (record-light.mjs)");
  assert.equal(await page.locator("#settings .camframe").getAttribute("aria-pressed"), "false", "the CamFrame link is off by default");
  // Follow my voice, the main screen and the CamFrame link: big buttons side by side (icons only).
  const bigButtons = (p) => p.locator("#settings .big-toggle:not([hidden])").evaluateAll((els) => els.map((el) => [el.getAttribute("aria-label"), el.innerText.trim()]));
  assert.deepEqual(await bigButtons(page), [["Connect main screen", ""], ["CamFrame link: off", ""], ["OBS link: off", ""]], "icons only; no Follow my voice without the speech API; the main screen's, CamFrame's and OBS's buttons");
  assert.equal(await page.locator("#settings").locator("input, select, button, textarea").count(), 20, "four sliders with their value boxes, three width, two layout and two show choices, the voice, main screen, CamFrame and OBS buttons, the (hidden) OBS password, nothing else");
  assert.equal(await page.locator("#settings .camframe-status, #settings .check-row").count(), 0, "no CamFrame status text in Settings");
  const screenBox = await page.locator("#settings .screen").boundingBox();
  const rowBox = await page.locator("#settings .big-toggles").boundingBox();
  assert.ok(Math.abs(screenBox.width * 3 + 16 - rowBox.width) < 1.5, "without voice the main screen's, CamFrame's and OBS's buttons share the row");
  const dockHeight = (await page.locator(".dock").boundingBox()).height;
  assert.ok(screenBox.height >= dockHeight && screenBox.height <= dockHeight + 24, `about as tall as the control bar: ${screenBox.height} vs ${dockHeight}`);
  assert.deepEqual(await page.locator("#settings .screen").evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]), ["oklch(0.33 0.096 282)", "oklch(0.763 0.027 282)"], "not connected: quiet indigo");
  assert.equal(await page.locator("#settings .screen rect").evaluate((r) => getComputedStyle(r).fill), "none", "not connected: an outline icon");
  // Sliders: range fields (src/ui/). Their own behaviour and close-ups: range-field.mjs here;
  // this checks the page's sliders keep that shape inside Settings. Slider parts cannot be read
  // with getComputedStyle.
  const sliderLook = (p) => p.locator("#settings .size-field").evaluate((el) => [
    getComputedStyle(el.querySelector('input[type="range"]')).appearance, el.getBoundingClientRect().height,
    el.querySelector('input[type="range"]').getBoundingClientRect().width === el.getBoundingClientRect().width,
    el.querySelector("label").getBoundingClientRect().left - el.getBoundingClientRect().left < 20,
    Math.abs(el.querySelector(".range-value").getBoundingClientRect().right - el.getBoundingClientRect().right) < 8,
  ]);
  assert.deepEqual(await page.locator("#settings .width .seg label").allTextContents(), ["Narrow", "Medium", "Full"]);
  assert.deepEqual(await page.locator("#settings .layout .seg label").allTextContents(), ["Lines", "Paragraphs"]);
  assert.equal(await page.locator('input[name="layout"]:checked').getAttribute("value"), "lines", "a new visitor gets the Lines layout");
  // Line height and paragraph spacing (TOOLS-486): taller rows, more room between paragraphs.
  // The details are in paragraphs.mjs; here they are changed once and remembered after the reload below.
  const wrapGap = () => page.locator(".script").evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) / parseFloat(getComputedStyle(el).fontSize));
  assert.ok(Math.abs(await wrapGap() - 1.65) < 0.01, "line height 165% by default");
  assert.deepEqual(await page.evaluate(() => ["prompter-line-height", "prompter-paragraph-spacing", "prompter-layout", "prompter-spacing"].map((k) => localStorage.getItem(k))),
    [null, null, null, null], "a first visit stores nothing for them");
  await page.locator(".line-height").fill("180");
  assert.ok(Math.abs(await wrapGap() - 1.8) < 0.01, "180%: a line that wraps has taller rows");
  await page.locator(".para-space").fill("120");
  await page.locator('#settings .layout .seg label:has-text("Paragraphs")').click();
  await page.locator(".size").fill("70");
  await page.locator(".speed").fill("120");
  await page.locator('#settings .seg label:has-text("Narrow")').click();
  assert.deepEqual([await page.locator(".size-val").inputValue(), await page.locator(".speed-val").inputValue()], ["70", "120"], "the boxes show the sliders' values");
  assert.deepEqual(await sliderLook(page), ["none", 44, true, true, true], "the page's own slider across the whole box: the name on the left, the value on the right");
  assert.deepEqual(await settingsSliderHits(page), [["size", false], ["value", true]], "in Settings: the name presses the slider, the value takes typing");
  const sizeName = await page.locator("#settings .size-field label:first-child").boundingBox();
  await page.mouse.click(sizeName.x + sizeName.width / 2, sizeName.y + sizeName.height / 2);
  assert.ok(Number(await page.locator(".size").inputValue()) < 70, "a press on the name inside Settings moves the slider there");
  await page.locator(".size").fill("70");
  await page.locator(".size").hover();
  await shot(page, "settings-popover-desktop");
  await closeUp(page, "#settings", "settings-close-up-desktop");
  await page.locator(".size").focus();
  await page.keyboard.press("ArrowRight");
  assert.deepEqual([await page.locator(".size").inputValue(), await page.locator(".size").evaluate((el) => getComputedStyle(el).outlineStyle)], ["72", "none"], "arrow keys move it");
  assert.equal(await page.locator(".size-field").evaluate((el) => getComputedStyle(el).outlineStyle), "solid", "the ring goes round the whole field");
  await page.keyboard.press("ArrowLeft");
  const narrowCol = await page.locator(".script").evaluate((el) => el.getBoundingClientRect().width - parseFloat(getComputedStyle(el).paddingLeft) * 2);
  assert.ok(Math.abs(narrowCol - 600) < 2, `narrow column is ${narrowCol}px`);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("settings-btn")), true, "focus returns to Settings");
  await page.reload();
  await page.locator(".section").first().waitFor();
  assert.deepEqual(await page.evaluate(() => [
    getComputedStyle(document.documentElement).getPropertyValue("--size").trim(),
    document.querySelector(".size").value, document.querySelector(".speed").value, document.querySelector('input[name="width"]:checked').value,
    document.querySelector(".line-height").value, document.querySelector(".para-space").value,
    document.querySelector('input[name="layout"]:checked').value, document.documentElement.dataset.layout,
  ]), ["70px", "70", "120", "narrow", "180", "120", "paragraphs", "paragraphs"]);
  await page.keyboard.press("+");
  await page.keyboard.press("]");
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".size").value, document.querySelector(".speed").value]), ["74", "130"]);
  await page.keyboard.press("-");
  await scrollToSection(page, 2);
  await page.waitForTimeout(250);
  await shot(page, "narrow-column-desktop");
  await (await dock(page, ".settings-btn")).click();
  await page.locator('#settings .seg label:has-text("Full")').click();
  const fullCol = await page.locator(".script").evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(fullCol > 1300, `full column is ${fullCol}px`);
  await page.locator('#settings .seg label:has-text("Medium")').click();
  // Changing the line height, the paragraph spacing or the layout keeps the line at the reading line where it was.
  const CHANGES = [["line-height", 200], ["para-space", 0], ["layout", "lines"], ["line-height", 110], ["para-space", 200], ["layout", "paragraphs"], ["line-height", 165], ["layout", "lines"]];
  // What sits at the reading line: the script line (or reminder) and the word under it, its place
  // in the page, and how far below the reading line its row starts (negative: the line is in it).
  const atLine = () => page.evaluate(() => {
    const line = document.querySelector(".reading-line");
    const y = line.getBoundingClientRect().top;
    const els = [...document.querySelectorAll(".script [data-k], .script p:not(.para)")];
    const i = els.findIndex((el) => el.getBoundingClientRect().bottom > y);
    const r = [...els[i].getClientRects()].find((f) => f.bottom > y);
    // The line's drag band sits over the text there: look past it.
    line.style.visibility = "hidden";
    const hit = document.caretRangeFromPoint(r.left + 8, Math.min(Math.max(y, r.top + 1), r.bottom - 1));
    line.style.visibility = "";
    const t = hit?.startContainer?.textContent ?? "";
    return [els[i].textContent, t.slice(Math.max(0, t.lastIndexOf(" ", hit.startOffset) + 1)).split(" ")[0], i, Math.round(r.top - y)];
  });
  // After a layout change the rows are new: the same script line is still under the reading line
  // (or, when the reading line was above it or in the room between two of its rows, one of its rows
  // starts as far below it as before).
  const stillUnder = ([, , i, below]) => page.evaluate(([i, below]) => {
    const y = document.querySelector(".reading-line").getBoundingClientRect().top;
    const rows = [...[...document.querySelectorAll(".script [data-k], .script p:not(.para)")][i].getClientRects()];
    return rows.some((f) => (f.top <= y + 1 && f.bottom >= y - 1) || (below > 0 && Math.abs(f.top - y - below) <= 4));
  }, [i, below]);
  const keepsPlace = async (label, { textOnly = false } = {}) => {
    for (const [what, value] of CHANGES) {
      const before = await atLine();
      await spaceTo(page, what, value);
      if (what === "layout") assert.equal(await stillUnder(before), true, `${label}: the same line stays at the reading line (layout ${value})`);
      else if (textOnly) assert.equal((await atLine())[0], before[0], `${label}: the same line stays at the reading line (${what} ${value})`);
      else assert.deepEqual((await atLine()).slice(0, 2), before.slice(0, 2), `${label}: the same word stays at the reading line (${what} ${value})`);
    }
  };
  await keepsPlace("mid-script");
  // A paragraph that wraps onto several rows, with the reading line on one of its last rows.
  await page.locator('input[name="width"][value="narrow"]').evaluate((el) => el.click());
  await page.locator(".size-val").fill("70");
  await page.evaluate(() => {
    const p = [...document.querySelectorAll(".script .para")].reduce((a, b) => (b.getBoundingClientRect().height > a.getBoundingClientRect().height ? b : a));
    const r = p.getBoundingClientRect();
    window.scrollBy(0, r.top + r.height * 0.8 - document.querySelector(".reading-line").getBoundingClientRect().top);
  });
  await keepsPlace("wrapped paragraph");
  // At the very top too: the page cannot scroll above 0.
  await scrollToSection(page, 0);
  await keepsPlace("at the top", { textOnly: true });
  // The reading line on a section's row of links: that row stays under it.
  await page.evaluate(() => {
    const l = document.querySelector(".links");
    window.scrollBy(0, l.getBoundingClientRect().top + l.getBoundingClientRect().height / 2 - document.querySelector(".reading-line").getBoundingClientRect().top);
  });
  const underLine = () => page.evaluate(() => {
    const y = document.querySelector(".reading-line").getBoundingClientRect().top;
    const r = document.querySelector(".links").getBoundingClientRect();
    return r.top <= y && r.bottom > y;
  });
  assert.equal(await underLine(), true, "the links row starts under the reading line");
  for (const [what, value] of CHANGES) {
    await spaceTo(page, what, value);
    assert.equal(await underLine(), true, `links row: still under the reading line (${what} ${value})`);
  }
  // Just after Next (the section's top at the reading line) and with the line in a gap between lines:
  // the section stays the active one and nothing moves under the line.
  await (await dock(page, ".next")).click();
  await page.waitForTimeout(400);
  await (await dock(page, ".settings-btn")).click();
  await page.locator("#settings:popover-open").waitFor();
  const secState = () => page.evaluate(() => {
    const a = document.querySelector(".section.active");
    return [a.dataset.i, Math.round(a.getBoundingClientRect().top - document.querySelector(".reading-line").getBoundingClientRect().top)];
  });
  const secBefore = await secState();
  for (const [what, value] of CHANGES) {
    await spaceTo(page, what, value);
    await page.waitForTimeout(150);
    const now = await secState();
    assert.equal(now[0], secBefore[0], `after Next, ${what} ${value}: the same section stays active`);
    assert.ok(Math.abs(now[1]) <= 4, `after Next, ${what} ${value}: the section's top is not pushed below the reading line (${now[1]})`);
  }
  // The reading line in the room between two paragraphs: the next line keeps its distance below it.
  await page.evaluate(() => {
    const brk = [...document.querySelectorAll(".script .brk")].find((el) => el.previousElementSibling && !el.previousElementSibling.matches(".title"));
    const top = brk.previousElementSibling.getBoundingClientRect().bottom;
    window.scrollBy(0, (top + brk.getBoundingClientRect().top) / 2 - document.querySelector(".reading-line").getBoundingClientRect().top);
  });
  const belowGap = () => page.evaluate(() => {
    const y = document.querySelector(".reading-line").getBoundingClientRect().top;
    const p = [...document.querySelectorAll(".script [data-k], .script p:not(.para)")].find((el) => el.getBoundingClientRect().top > y);
    return [p.textContent, Math.round(p.getBoundingClientRect().top - y)];
  });
  // (Paragraph spacing only so far that the reading line stays in the room between them.)
  for (const [what, value] of [["line-height", 200], ["para-space", 160], ["layout", "paragraphs"], ["line-height", 110], ["para-space", 200], ["layout", "lines"], ["line-height", 165]]) {
    const gapBefore = await belowGap();
    await spaceTo(page, what, value);
    const gapAfter = await belowGap();
    assert.equal(gapAfter[0], gapBefore[0], `between paragraphs: the same line is next below the reading line (${what} ${value})`);
    assert.ok(Math.abs(gapAfter[1] - gapBefore[1]) < 4, `between paragraphs: it is no further away (${what} ${value}: ${gapBefore[1]} → ${gapAfter[1]})`);
  }
  // The reading line on a section's title (a heading does not grow): the title stays under it.
  await page.evaluate(() => {
    const h = document.querySelectorAll(".script .title")[1];
    window.scrollBy(0, h.getBoundingClientRect().top + h.getBoundingClientRect().height / 2 - document.querySelector(".reading-line").getBoundingClientRect().top);
  });
  const titleUnder = () => page.evaluate(() => {
    const y = document.querySelector(".reading-line").getBoundingClientRect().top;
    return [...document.querySelectorAll(".script .title")].map((h) => h.getBoundingClientRect()).some((r) => r.top <= y && r.bottom > y);
  });
  assert.equal(await titleUnder(), true, "the reading line starts on a section title");
  for (const [what, value] of CHANGES) {
    await spaceTo(page, what, value);
    assert.equal(await titleUnder(), true, `title: still under the reading line (${what} ${value})`);
  }
  // Scrolled below the last line (into the bottom padding): the last line keeps its distance from the reading line.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const lastDist = () => page.evaluate(() => {
    const lines = [...document.querySelectorAll(".script [data-k], .script p:not(.para)")];
    return Math.round(lines.at(-1).getBoundingClientRect().top - document.querySelector(".reading-line").getBoundingClientRect().top);
  });
  for (const [what, value] of CHANGES) {
    const lastBefore = await lastDist();
    await spaceTo(page, what, value);
    // (When the script gets shorter, the page may end before that distance: then it is scrolled to its end.)
    const atEnd = await page.evaluate(() => scrollY >= document.documentElement.scrollHeight - innerHeight - 1);
    const dist = await lastDist();
    assert.ok(Math.abs(dist - lastBefore) <= 4 || (atEnd && dist < 0 && dist > lastBefore), `below the last line: it keeps its distance from the reading line (${what} ${value}: ${lastBefore} → ${dist})`);
  }
  // Arrow keys in the layout choices (a radio group) change it like a click, and it is remembered.
  await page.locator('input[name="layout"]:checked').focus();
  const layoutNow = () => page.evaluate(() => [document.querySelector('input[name="layout"]:checked').value, document.documentElement.dataset.layout, localStorage.getItem("prompter-layout")]);
  await page.keyboard.press("ArrowRight");
  assert.deepEqual(await layoutNow(), ["paragraphs", "paragraphs", "paragraphs"], "→ goes to Paragraphs");
  await page.keyboard.press("ArrowLeft");
  assert.deepEqual(await layoutNow(), ["lines", "lines", "lines"], "← goes back to Lines");
  // Unknown remembered values fall back to the defaults.
  await page.evaluate(() => { localStorage.setItem("prompter-layout", "columns"); localStorage.setItem("prompter-line-height", "tall"); });
  await page.reload();
  await page.locator(".section").first().waitFor();
  assert.deepEqual(await page.evaluate(() => [document.querySelector('input[name="layout"]:checked').value, document.documentElement.dataset.layout, document.querySelector(".line-height").value]), ["lines", "lines", "165"]);
  await (await dock(page, ".settings-btn")).click();
  await page.locator("#settings:popover-open").waitFor();
  // Type an exact value: off the slider's step, past its end, half typed, empty, too small.
  const typed = () => page.evaluate(() => [getComputedStyle(document.documentElement).getPropertyValue("--size").trim(), document.querySelector(".size").value, document.querySelector(".size-val").value]);
  await page.locator(".size-field .range-value span").click();
  assert.equal(await page.evaluate(() => document.activeElement.className), "size-val", "clicking next to the value focuses it");
  await page.keyboard.type("47");
  assert.deepEqual(await typed(), ["47px", "48", "47"], "the value was selected, so typing replaces it; it applies at once and keeps the exact number; the slider sits nearest");
  await page.keyboard.press("Enter");
  assert.deepEqual(await typed(), ["47px", "48", "47"]);
  await page.locator(".size-val").fill("60");
  assert.equal(await page.locator(".size").getAttribute("aria-valuetext"), "60 px", "screen readers hear the value with its unit");
  await page.locator(".size").focus();
  await page.keyboard.press("ArrowRight");
  assert.deepEqual([...(await typed()), await page.locator(".size").getAttribute("aria-valuetext")], ["62px", "62", "62", "62 px"], "also after a key move");
  await page.locator(".size-val").fill("999");
  await page.locator(".size-val").press("Tab");
  assert.deepEqual([...(await typed()), await page.evaluate(() => localStorage.getItem("prompter-size"))], ["300px", "110", "300", "300"], "Tab with a value above the maximum: the largest allowed, like Enter");
  await page.locator(".size-val").fill("150");
  assert.deepEqual(await typed(), ["150px", "110", "150"], "past the slider's end: the slider stops there");
  assert.equal(await page.locator(".size").getAttribute("aria-valuetext"), "150 px", "and names the exact value for screen readers");
  await page.locator(".size-val").fill("");
  await page.locator(".size-val").press("Tab");
  assert.deepEqual(await typed(), ["150px", "110", "150"], "an empty box goes back to the last value");
  await page.locator(".size-val").fill("5");
  assert.equal((await typed())[0], "150px", "half typed (below the box's minimum): nothing changes yet");
  await page.locator(".size-val").press("Escape");
  assert.deepEqual([...(await typed()), await page.evaluate(() => localStorage.getItem("prompter-size"))], ["150px", "110", "150", "150"], "Escape while half typed: back to the last value, not the smallest");
  await (await dock(page, ".settings-btn")).click();
  await page.locator(".size-val").fill("5");
  await page.locator(".size-val").press("Enter");
  assert.deepEqual(await typed(), ["10px", "20", "10"], "too small: the smallest allowed on Enter");
  // Values past the slider's ends survive a reload.
  await page.evaluate(() => { localStorage.setItem("prompter-size", "150"); localStorage.setItem("prompter-speed", "5"); });
  await page.reload();
  await page.locator(".section").first().waitFor();
  assert.deepEqual([...(await typed()), await page.evaluate(() => [document.querySelector(".speed").value, document.querySelector(".speed-val").value].join())], ["150px", "110", "150", "10,5"], "remembered past the slider's ends");
  await (await dock(page, ".settings-btn")).click();
  await page.locator(".speed-val").fill("75");
  await page.locator(".speed-val").press("Enter");
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".speed").value, document.querySelector(".speed-val").value, localStorage.getItem("prompter-speed")]), ["80", "75", "75"], "speed takes any whole number too");
  await page.locator(".size-val").fill("70");
  await page.locator(".size-val").press("Enter");
  await page.locator(".speed-val").fill("120");
  await page.locator(".speed-val").press("Enter");
  assert.equal(await page.locator("#settings:popover-open").count(), 1, "Enter in a value box keeps Settings open");
  await page.keyboard.press("Escape");
  ok("Settings popover above its button: Text size, Scroll speed, Line height, Paragraph spacing, a Narrow/Medium/Full width and a Lines/Paragraphs layout choice only; remembered after a reload; a change of line height, paragraph spacing or layout keeps the line at the reading line (mid-script, a wrapped paragraph, the top, the links row, after Next, between paragraphs, a title, below the last line); damaged values fall back; keys move the sliders; exact values typed into their boxes (also past the slider's ends); focus returns");

  // Without CSS anchor positioning the page places the popovers itself.
  const noAnchor = await browser.newContext(DESKTOP);
  await noAnchor.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...a) => (/position-anchor/.test(a.join(" ")) ? false : supports(...a));
  });
  const na = await noAnchor.newPage();
  watch(na, "no anchor positioning");
  await na.goto(`${base}/#demo`);
  await na.locator(".section").first().waitFor();
  await na.addStyleTag({ content: ".pop { position-area: none !important; position-try-fallbacks: none !important; }" });
  for (const [pop, button] of [["#open-menu", ".open-btn"], ["#settings", ".settings-btn"]]) {
    await na.locator(button).click();
    await popAbove(na, pop, button, `fallback ${pop}`);
    await na.keyboard.press("Escape");
  }
  await noAnchor.close();
  ok("without anchor positioning, both popovers are still placed above their buttons");

  // A link made for the default preset keeps it, even after Lex was chosen.
  await page.goto(await makeLink(EXAMPLE_SCRIPT.replace("Thanks for watching.", "Thanks a lot for watching."), "default", base));
  await page.locator(".section").first().waitFor();
  assert.doesNotMatch(await page.evaluate(() => location.hash), /&p=/);
  assert.equal(await page.evaluate(() => localStorage.getItem("prompter-preset")), "default");
  ok("default links keep the default preset");

  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/`);
  await showsStart(page);
  await page.goto(`${base}/${new URL(link).hash}`);
  await page.waitForFunction(() => document.querySelectorAll(".section").length === 5);
  await page.goBack();
  await showsStart(page);
  assert.equal(await page.locator(".section").count(), 0);
  assert.equal(await page.evaluate(() => location.hash), "");
  assert.equal(await card.locator(".continue").textContent(), "Continue: 1 · ONE QUESTION", "the link's script is offered by its first section after PREP and INTRO");
  ok("Back from a link to the plain address returns to the start screen");

  // A link made with the script's save date (&d=) shows it on Continue; one without shows none.
  await page.goto(`${base}/`);
  await showsStart(page);
  // A file the browser only dates "just now" (it does not know) shows no date: the day is never guessed.
  const [freshChooser] = await Promise.all([page.waitForEvent("filechooser"), card.locator('[data-action="open-file"]').click()]);
  await freshChooser.setFiles({ name: "fresh.md", mimeType: "text/markdown", buffer: Buffer.from("### **FRESH TALK · 00:00**\n\nQL: Is this new?\n\nYes, new.") });
  await page.locator(".section").first().waitFor();
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  assert.doesNotMatch(await page.evaluate(() => location.hash), /&d=/);
  await page.goBack();
  await showsStart(page);
  assert.equal(await card.locator(".continue").textContent(), "Continue: FRESH TALK", "a file dated just now shows no save date");
  await page.goto(await makeLink(EXAMPLE_SCRIPT, "lex", base, "2026-11-03"));
  await page.waitForFunction(() => document.querySelectorAll(".section").length === 5);
  assert.match(await page.evaluate(() => location.hash), /&p=lex&d=2026-11-03$/, "the address keeps the link as made");
  await page.goBack();
  await showsStart(page);
  assert.equal(await card.locator(".continue-title").textContent(), "Continue: 1 · ONE QUESTION");
  assert.equal(await card.locator(".continue-saved").textContent(), "Saved 3 Nov 2026");
  assert.equal(await card.locator(".continue-saved").getAttribute("datetime"), "2026-11-03");
  const [titleBox, savedBox, buttonBox] = await Promise.all([".continue-title", ".continue-saved", ".continue"].map((sel) => card.locator(sel).boundingBox()));
  assert.ok(savedBox.y >= titleBox.y + titleBox.height - 1 && savedBox.x === titleBox.x && savedBox.y + savedBox.height <= buttonBox.y + buttonBox.height, "the date sits under the title, inside the button");
  assert.equal(await card.locator(".continue-saved").evaluate((el) => getComputedStyle(el).fontSize), "13px");
  await shot(page, "start-continue-saved-desktop");
  await page.reload();
  await showsStart(page);
  assert.equal(await card.locator(".continue-saved").textContent(), "Saved 3 Nov 2026", "the date is remembered with the script");
  await card.locator(".continue").click();
  await page.waitForFunction(() => document.querySelectorAll(".section").length === 5);
  assert.match(await page.evaluate(() => location.hash), /&p=lex&d=2026-11-03$/, "Continue opens the script with its date in the address");
  await page.goto(`${base}/`);
  await showsStart(page);
  await page.goto(await makeLink(EXAMPLE_SCRIPT, "lex", base));
  await page.waitForFunction(() => document.querySelectorAll(".section").length === 5);
  await page.goBack();
  await showsStart(page);
  assert.equal(await card.locator(".continue-saved").isVisible(), false, "a link without a date shows no date");
  assert.equal(await card.locator(".continue").textContent(), "Continue: 1 · ONE QUESTION");
  ok("a link's save date (&d=) shows on Continue as “Saved 3 Nov 2026”, stays with the remembered script and its address, and a script without a date shows none");

  await page.goto(`${base}/#s=@@@`);
  await page.locator(".note-row.alert:not([hidden])").waitFor();
  assert.match(await page.locator(".alert-text").textContent(), /could not be opened: Link data is damaged/);
  await showsStart(page);
  assert.equal(await page.locator(".section").count(), 0);
  ok("a damaged link shows a plain error over the start screen");

  // A link that opens nothing leaves the saved style preset alone: damaged, or without sections.
  await page.evaluate(() => localStorage.setItem("prompter-preset", "lex"));
  await page.goto(`${base}/#s=@@@`);
  await page.locator(".note-row.alert:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("prompter-preset")), "lex", "a damaged link (made for the default preset) does not change the saved preset");
  await page.goto(await makeLink("No sections in here.", "default", base));
  await page.waitForFunction(() => /no sections/.test(document.querySelector(".alert-text").textContent));
  assert.equal(await page.evaluate(() => localStorage.getItem("prompter-preset")), "lex", "a link without sections does not change the saved preset");
  ok("a damaged link, or one without sections, keeps the saved style preset");

  // Opened from the paste window on the start screen.
  const pasteOpen = async (text) => {
    await page.goto(`${base}/`);
    await showsStart(page);
    await card.locator('[data-action="paste"]').click();
    await page.locator("#paste-text").fill(text);
    await page.locator('[data-action="open-paste"]').click();
    await page.locator(".paste-dialog:not([open])").waitFor({ state: "attached" });
  };
  // When the script cannot be packed into a link, the address shows no script at all, never the one before:
  // opened over another script, and opened from the start screen (Back still returns to the start).
  await pasteOpen("### **FIRST · 00:00**\n\nThe first script.");
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  await page.evaluate(() => {
    window.CompressionStream = class { constructor() { throw new Error("no compression here"); } };
    document.querySelector('[data-action="paste"]').click();
  });
  await page.locator("#paste-text").fill("### **SECOND · 00:00**\n\nThe second script.");
  await page.locator('[data-action="open-paste"]').click();
  await page.locator(".paste-dialog:not([open])").waitFor({ state: "attached" });
  assert.equal(await page.locator(".section .title span").first().textContent(), "SECOND");
  assert.equal(await page.evaluate(() => location.hash), "", "the first script's link does not stay in the address");
  const backToStart = async () => {
    await (await dock(page, ".open-btn")).click();
    await page.locator('#open-menu [data-action="start"]').click();
    await showsStart(page);
  };
  const pasteFromStart = async (title) => {
    await card.locator('[data-action="paste"]').click();
    await page.locator("#paste-text").fill(`### **${title} · 00:00**\n\nThe ${title.toLowerCase()} script.`);
    await page.locator('[data-action="open-paste"]').click();
    await page.locator(".paste-dialog:not([open])").waitFor({ state: "attached" });
    assert.equal(await page.locator(".section .title span").first().textContent(), title);
  };
  await backToStart();
  const entries = await page.evaluate(() => history.length);
  await pasteFromStart("FROM START");
  assert.equal(await page.evaluate(() => location.hash), "", "opened from the start screen: no link either");
  assert.equal(await page.evaluate(() => history.length), entries + 1, "a new history entry, so Back returns to the start");
  await page.goBack();
  await showsStart(page);
  ok("a script that cannot be packed into a link leaves no older script's link in the address (over a script, or from the start screen, where Back returns to the start)");

  // Packing a script into its link takes a moment. A script, or the start screen, that comes first in the
  // meantime keeps the address: the older script's link never lands late over it.
  const slowPack = () => page.evaluate(() => {
    const Real = window.CompressionStream;
    const gate = new Promise((done) => { window.__releasePack = done; });
    window.CompressionStream = class {
      constructor(format) {
        window.CompressionStream = Real; // only this one is slow
        const real = new Real(format);
        this.writable = real.writable;
        this.readable = real.readable.pipeThrough(new TransformStream({ start: () => gate }));
      }
    };
  });
  const releasePack = () => page.evaluate(async () => {
    window.__releasePack();
    for (let i = 0; i < 20; i++) await new Promise((done) => { setTimeout(done, 10); });
  });
  const pasteOver = async (title) => {
    await page.evaluate(() => document.querySelector('[data-action="paste"]').click());
    await page.locator("#paste-text").fill(`### **${title} · 00:00**\n\nThe ${title.toLowerCase()} script.`);
    await page.locator('[data-action="open-paste"]').click();
    await page.locator(".paste-dialog:not([open])").waitFor({ state: "attached" });
    assert.equal(await page.locator(".section .title span").first().textContent(), title);
  };
  await page.goto(`${base}/`); // a fresh page: the one above cannot pack at all
  await showsStart(page);
  // Opened from a file: nothing waits for the link, so the page can move on before it is packed.
  const fileOpen = async (title) => {
    await page.locator(".file-input").setInputFiles({ name: "slow.md", mimeType: "text/markdown", buffer: Buffer.from(`### **${title} · 00:00**\n\nThe ${title.toLowerCase()} script.`) });
    await page.waitForFunction((t) => document.querySelector(".section .title span")?.textContent === t, title);
  };
  await pasteFromStart("SLOW ONE");
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  const first = await page.evaluate(() => location.hash);
  await slowPack();
  await fileOpen("SLOW TWO"); // its link waits
  await pasteOver("QUICK THREE");
  await page.waitForFunction((before) => location.hash.startsWith("#s=") && location.hash !== before, first);
  const third = await page.evaluate(() => location.hash);
  await releasePack();
  assert.equal(await page.evaluate(() => location.hash), third, "the newer script's link stays in the address");
  await slowPack();
  await fileOpen("SLOW FOUR"); // its link waits
  await backToStart();
  const startEntries = await page.evaluate(() => history.length);
  await releasePack();
  await showsStart(page);
  assert.equal(await page.evaluate(() => location.hash), "", "the start screen keeps its clean address");
  assert.equal(await page.evaluate(() => history.length), startEntries, "and gets no extra history entry");
  // From the start screen, a script opened while the first one's link is packed still leaves the start
  // screen one Back away.
  await slowPack();
  await fileOpen("SLOW FIVE"); // its link (and its new history entry) waits
  await pasteOver("QUICK SIX");
  await releasePack();
  assert.equal(await page.locator(".section .title span").first().textContent(), "QUICK SIX");
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  await page.goBack();
  await showsStart(page);
  assert.equal(await page.evaluate(() => location.hash), "", "Back from it returns to the start screen");
  ok("a script's link that is still being packed never lands late: a newer script, or the start screen, keeps the address (no older script comes back on reload)");

  // Unpacking a link's script takes a moment too. Two links opened fast in a row (Back, then Forward): only
  // the newest may open, even when the older one finishes unpacking last; the same for the start screen.
  const slowUnpack = () => page.evaluate(() => {
    const Real = window.DecompressionStream;
    window.__unpacking = false;
    const gate = new Promise((done) => { window.__releaseUnpack = done; });
    window.DecompressionStream = class {
      constructor(format) {
        window.DecompressionStream = Real; // only this one is slow
        window.__unpacking = true;
        const real = new Real(format);
        this.writable = real.writable;
        this.readable = real.readable.pipeThrough(new TransformStream({ start: () => gate }));
      }
    };
  });
  const releaseUnpack = () => page.evaluate(async () => {
    window.__releaseUnpack();
    for (let i = 0; i < 20; i++) await new Promise((done) => { setTimeout(done, 10); });
  });
  const shownTitle = () => page.locator(".section .title span").first().textContent();
  const linkHash = async (title) => new URL(await makeLink(`### **${title} · 00:00**\n\nThe ${title.toLowerCase()} script.`, "default", base)).hash;
  const [linkOne, linkTwo, linkThree] = await Promise.all(["LINK ONE", "LINK TWO", "LINK THREE"].map(linkHash));
  await page.goto(`${base}/${linkOne}`);
  await page.waitForFunction(() => document.querySelector(".section .title span")?.textContent === "LINK ONE");
  await page.evaluate(([two, three]) => { history.pushState(null, "", two); history.pushState(null, "", three); }, [linkTwo, linkThree]);
  await slowUnpack();
  await page.evaluate(() => history.back()); // LINK TWO: its unpacking waits
  await page.waitForFunction(() => window.__unpacking);
  await page.evaluate(() => history.forward()); // LINK THREE, unpacked at once
  await page.waitForFunction(() => document.querySelector(".section .title span")?.textContent === "LINK THREE");
  await releaseUnpack();
  assert.equal(await shownTitle(), "LINK THREE", "the older link never opens over the newer one");
  assert.equal(await page.evaluate(() => location.hash), linkThree);
  // A damaged link that fails to unpack after a newer link opened says nothing and changes nothing.
  await page.evaluate((one) => { history.pushState(null, "", "#s=AAAA"); history.pushState(null, "", one); }, linkOne);
  await slowUnpack();
  await page.evaluate(() => history.back()); // the damaged link: its unpacking waits
  await page.waitForFunction(() => window.__unpacking);
  await page.evaluate(() => history.forward()); // LINK ONE, unpacked at once
  await page.waitForFunction(() => document.querySelector(".section .title span")?.textContent === "LINK ONE");
  await releaseUnpack();
  assert.equal(await shownTitle(), "LINK ONE", "the damaged link never brings the start screen back");
  assert.equal(await page.locator(".note-row.alert").isVisible(), false, "and shows no alert over the newer script");
  await slowUnpack();
  await page.evaluate(() => history.back()); // LINK TWO again: its unpacking waits
  await page.waitForFunction(() => window.__unpacking);
  await page.evaluate(() => { history.replaceState(null, "", location.pathname); window.dispatchEvent(new PopStateEvent("popstate")); });
  await showsStart(page);
  await releaseUnpack();
  assert.equal(await page.locator(".empty").isVisible(), true, "the older link never opens over the start screen");
  assert.equal(await page.evaluate(() => location.hash), "", "the start screen keeps its clean address");
  // A file still being read: a script pasted meanwhile stays, and the file never opens over it.
  await page.evaluate(() => {
    const real = Blob.prototype.text;
    const gate = new Promise((done) => { window.__releaseRead = done; });
    Blob.prototype.text = async function () { Blob.prototype.text = real; await gate; return real.call(this); };
  });
  await page.locator(".file-input").setInputFiles({ name: "slow.md", mimeType: "text/markdown", buffer: Buffer.from("### **SLOW FILE · 00:00**\n\nThe slow file.") });
  await pasteFromStart("PASTED MEANWHILE");
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  const pastedLink = await page.evaluate(() => location.hash);
  await page.evaluate(async () => {
    window.__releaseRead();
    for (let i = 0; i < 20; i++) await new Promise((done) => { setTimeout(done, 10); });
  });
  assert.equal(await shownTitle(), "PASTED MEANWHILE", "the file read before it never opens over it");
  assert.equal(await page.evaluate(() => location.hash), pastedLink, "and the address keeps its link");
  ok("two links opened fast in a row: only the newest opens, even when the older one finishes unpacking last (the start screen stays when it came after, a damaged older link says nothing, and a file still being read never opens over a newer script)");

  // Browser storage that cannot keep the last script: a short note naming it, just under Continue.
  const failSave = (failing) => page.evaluate((k) => {
    window.__setItem ||= Storage.prototype.setItem;
    const set = window.__setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === k) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return set.call(this, key, value);
    };
  }, failing);
  const saveWorks = () => page.evaluate(() => { if (window.__setItem) Storage.prototype.setItem = window.__setItem; });
  const note = card.locator(".save-note");
  await page.reload();
  await page.goto(await makeLink("### **DATED · 00:00**\n\nA dated script.", "default", base, "2026-11-03"));
  await page.locator(".section").first().waitFor();
  await page.goto(`${base}/`);
  await showsStart(page);
  assert.equal(await note.isVisible(), false, "no note while saving works");
  assert.deepEqual([await card.locator(".continue-title").textContent(), await card.locator(".continue-saved").textContent()], ["Continue: DATED", "Saved 3 Nov 2026"]);
  await failSave("prompter-last-script");
  await pasteFromStart("THIRD");
  assert.equal(await page.locator(".save-note").isVisible(), false, "nothing shows over the script");
  await backToStart();
  assert.equal(await note.textContent(), "Couldn’t save “THIRD” on this device", "the note names the script that was not kept");
  assert.equal(await note.isVisible(), true);
  assert.deepEqual([await card.locator(".continue-title").textContent(), await card.locator(".continue-saved").textContent()], ["Continue: DATED", "Saved 3 Nov 2026"], "Continue keeps the script it had, with its own date");
  assert.equal(await card.locator(".continue").getAttribute("aria-describedby"), "save-note", "Continue is described by the note while it shows");
  const [noteBox, continueBox] = await Promise.all([note.boundingBox(), card.locator(".continue").boundingBox()]);
  assert.ok(noteBox.y >= continueBox.y + continueBox.height && noteBox.y - (continueBox.y + continueBox.height) < 24, `the note sits just under Continue: ${JSON.stringify([continueBox, noteBox])}`);
  await closeUp(page, ".empty .card", "save-note-close-up-desktop");
  // A newer copy with the name Continue shows is "your latest".
  await pasteFromStart("DATED");
  await backToStart();
  assert.equal(await note.textContent(), "Couldn’t save your latest “DATED” on this device");
  assert.equal(await card.locator(".continue-saved").textContent(), "Saved 3 Nov 2026");
  // The script kept but not its date: Continue shows no date rather than the one before.
  await failSave("prompter-last-saved");
  await pasteFromStart("FOURTH");
  await backToStart();
  assert.equal(await note.isVisible(), false, "the note goes once a script is kept again");
  assert.equal(await card.locator(".continue-title").textContent(), "Continue: FOURTH");
  assert.equal(await card.locator(".continue-saved").isVisible(), false, "no older script's date on Continue");
  // Nothing kept at all (storage blocked from the start): the note stands alone at the top of the list.
  await saveWorks();
  await page.evaluate(() => localStorage.clear());
  await failSave("prompter-last-script");
  const LONG = "ALEKSANDRA WIŚNIEWSKA-KOWALCZYK’S QUARTERLY REVIEW 四半期レビュー 🎬";
  await pasteFromStart(LONG);
  await backToStart();
  assert.equal(await card.locator(".continue").isVisible(), false);
  assert.equal(await note.textContent(), `Couldn’t save “${LONG}” on this device`);
  assert.equal(await card.locator(".choices > :not([hidden])").first().evaluate((el) => el.classList.contains("save-note")), true, "first in the list");
  await page.setViewportSize({ width: 320, height: 700 });
  assert.deepEqual(await page.evaluate(() => {
    const n = document.querySelector(".save-note").getBoundingClientRect();
    const c = document.querySelector(".empty .card").getBoundingClientRect();
    return [document.documentElement.scrollWidth <= innerWidth, n.left >= c.left && n.right <= c.right];
  }), [true, true], "a long name wraps inside the card at 320px, no sideways scroll");
  await page.setViewportSize(MOBILE.viewport);
  await closeUp(page, ".empty .card", "save-note-close-up-mobile");
  await page.setViewportSize(DESKTOP.viewport);
  await saveWorks();
  await pasteFromStart("SIXTH");
  await backToStart();
  assert.equal(await note.isVisible(), false);
  assert.equal(await card.locator(".continue").getAttribute("aria-describedby"), null);
  assert.equal(await card.locator(".continue-title").textContent(), "Continue: SIXTH");
  ok("when the browser cannot keep the last script, the start screen names it (“Couldn’t save “THIRD” on this device”) just under Continue, or alone when there is no Continue, only then; Continue keeps the script and date it had, and never shows another script's date");
  await desktop.close();

  // Reduced motion: no colour fade between sections.
  const calm = await browser.newContext({ ...DESKTOP, reducedMotion: "reduce" });
  const calmPage = await calm.newPage();
  await calmPage.goto(link);
  await calmPage.locator(".section").first().waitFor();
  const duration = await calmPage.locator(".section p").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  assert.equal(duration, "0s");
  assert.equal(await calmPage.locator(".link").first().evaluate((el) => getComputedStyle(el).transitionDuration), "0s", "links change state without a fade");
  await calm.close();
  ok("prefers-reduced-motion removes the section fade and the link fades");

  // ---- Follow my voice (stubbed speech recognition) ----
  const voiced = await browser.newContext(DESKTOP);
  await voiced.addInitScript(SPEECH_STUB);
  const v = await voiced.newPage();
  watch(v, "voice");
  await v.goto(link);
  await v.locator(".section").first().waitFor();
  await v.locator(".voice:not([hidden])").waitFor({ state: "attached" });
  await (await dock(v, ".auto")).click();
  assert.equal(await v.locator(".auto").getAttribute("aria-pressed"), "true");
  await viaSettings(v, ".voice");
  await v.locator(".voice-notice:not([hidden])").waitFor();
  assert.match(await v.locator(".voice-notice").textContent(), /speech service[\s\S]*Google[\s\S]*Your script stays on this device/);
  assert.equal(await v.evaluate(() => window.__speech.started), 0, "nothing listens before consent");
  await shot(v, "voice-notice-desktop");
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "false", "the button stays off until Turn on");
  await v.locator('[data-action="voice-ok"]').click();
  assert.equal(await v.evaluate(() => window.__speech.started), 1);
  assert.deepEqual([await v.locator(".voice").getAttribute("aria-pressed"), await v.locator(".voice rect").evaluate((r) => getComputedStyle(r).fill)], ["true", "oklch(0.7 0.19 32.3)"]);
  assert.deepEqual([await v.locator(".settings-btn").getAttribute("data-dot"), await v.locator(".settings-btn").getAttribute("aria-label")], ["on", "Settings · Follow my voice on"], "a dot on Settings while it listens");
  await (await dock(v, ".settings-btn")).click();
  await popAbove(v, "#settings", ".settings-btn", "Settings with voice on");
  assert.deepEqual(await v.locator("#settings .big-toggle").evaluateAll((els) => els.map((el) => [el.innerText.trim(), getComputedStyle(el).backgroundColor, getComputedStyle(el).color])),
    [["", "oklch(0.33 0.096 282)", "oklch(0.7 0.19 32.3)"], ["", "oklch(0.33 0.096 282)", "oklch(0.763 0.027 282)"], ["", "oklch(0.33 0.096 282)", "oklch(0.763 0.027 282)"], ["", "oklch(0.33 0.096 282)", "oklch(0.763 0.027 282)"]], "icons only; on: an orange icon, off: a quiet one, on the same indigo button; side by side");
  const [vb, sb, cb, ob] = await Promise.all([v.locator("#settings .voice").boundingBox(), v.locator("#settings .screen").boundingBox(), v.locator("#settings .camframe").boundingBox(), v.locator("#settings .obs").boundingBox()]);
  assert.ok(Math.abs(vb.y - sb.y) < 1 && Math.abs(sb.y - cb.y) < 1 && Math.abs(cb.y - ob.y) < 1 && Math.abs(vb.width - sb.width) < 1 && Math.abs(sb.width - cb.width) < 1 && Math.abs(cb.width - ob.width) < 1 && vb.x < sb.x && sb.x < cb.x && cb.x < ob.x, "four equal buttons side by side");
  await shot(v, "settings-voice-on-desktop");
  await v.evaluate(() => document.querySelector("#settings").hidePopover());
  assert.equal(await v.locator(".auto").getAttribute("aria-pressed"), "false", "auto-scroll pauses");
  assert.deepEqual([await v.locator(".auto").getAttribute("aria-disabled"), await v.locator(".auto").getAttribute("data-tip"), await v.locator(".auto svg").first().evaluate((el) => getComputedStyle(el).opacity)], ["true", "Auto-scroll is off while Follow my voice is on", "0.5"], "play is greyed out and says why (no status pops up)");
  await v.evaluate(() => document.querySelector(".auto").click()); // aria-disabled: Playwright would wait for it to be enabled
  assert.deepEqual([await v.locator(".auto").getAttribute("aria-pressed"), await v.locator(".auto").evaluate((el) => [getComputedStyle(el, "::after").opacity, getComputedStyle(el).opacity].join(" ")), await v.locator(".status").textContent()], ["false", "1 1", "Auto-scroll is off while Follow my voice is on."], "a press shows the reason on the button, at full strength");
  assert.notEqual(await v.locator(".auto").evaluate((el) => getComputedStyle(el).backgroundColor), "oklch(0.65 0.227 32.3)", "greyed out: not the orange play colour");
  await v.waitForFunction(() => !document.querySelector(".auto").hasAttribute("data-show-tip"), null, { timeout: 3000 });
  // Word by word, line by line: a finished line moves on to the next one.
  const curText = () => v.evaluate(() => document.querySelector(".cur")?.textContent ?? null);
  await v.evaluate(() => window.__speech.say("writing scripts takes"));
  await v.waitForFunction(() => document.querySelector(".cur")?.textContent === "Writing scripts takes too long.");
  await v.evaluate(() => window.__speech.say("too long reading"));
  await v.waitForFunction(() => document.querySelector(".cur")?.textContent === "Reading them looks stiff.");
  // Interim words: a cut-off word or one word of a later line never jumps.
  await v.evaluate(() => window.__speech.say("them looks stiff to", true));
  await v.evaluate(() => window.__speech.say("them looks stiff to", true));
  await v.waitForFunction(() => document.querySelector(".cur")?.textContent === "Today: a calmer way.");
  await v.evaluate(() => window.__speech.say("them looks", true));
  await v.waitForFunction(() => document.querySelector(".cur")?.textContent === "Reading them looks stiff.");
  await v.evaluate(() => window.__speech.say("them looks question", true));
  await v.waitForTimeout(100);
  assert.equal(await curText(), "Reading them looks stiff.", "a word of a later line does not jump");
  await v.evaluate(() => window.__speech.say("them looks stiff today a calmer way hi i'm"));
  await v.waitForFunction(() => document.querySelector(".cur")?.textContent === "Hi, I'm Sam. Welcome.");
  await v.waitForFunction(() => {
    const top = document.querySelector(".cur").getBoundingClientRect().top;
    return Math.abs(top - window.innerHeight * 0.34) < 12;
  });
  await v.waitForTimeout(400); // let the colours settle
  // The line being read is pure white, the lines after it white too (TOOLS-486), no box or underline.
  assert.deepEqual(await v.evaluate(() => {
    const cur = document.querySelector(".cur");
    const cs = getComputedStyle(cur);
    const lines = [...cur.closest(".section").querySelectorAll("[data-k]")];
    const [before, after] = [lines[lines.indexOf(cur) - 1], lines[lines.indexOf(cur) + 1]];
    return [cs.color, cs.backgroundColor, cs.boxShadow, getComputedStyle(after).color, getComputedStyle(before).color];
  }), ["oklch(1 0 none)", "rgba(0, 0, 0, 0)", "none", "oklch(0.975 0.012 282)", "oklch(0.975 0.012 282)"], "the current line is pure white; the lines after it white; read lines keep their colour under the veil");
  await shot(v, "voice-follow-desktop");
  // QL lines are never followed, and a pair of words from a later line does not jump.
  await v.evaluate(() => window.__speech.say("why one question per section"));
  await v.waitForTimeout(100);
  assert.equal(await curText(), "Hi, I'm Sam. Welcome.");
  // Scrolling by hand: the line at the reading line becomes the current one, without a jump.
  await v.evaluate(() => {
    const el = [...document.querySelectorAll("[data-k]")].find((p) => p.textContent === "One question keeps you focused.");
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - document.querySelector(".reading-line").getBoundingClientRect().top + 2);
  });
  await v.mouse.wheel(0, 1);
  await v.waitForFunction(() => document.querySelector(".cur")?.textContent === "One question keeps you focused.");
  await v.evaluate(() => window.__speech.say("one question keeps you focused you"));
  await v.waitForFunction(() => document.querySelector(".cur")?.textContent === "You answer, not recite.");
  // Changing the line height while the voice moves the page on: the line being read goes to the reading line.
  const curAtLine = () => v.evaluate(() => [document.querySelector(".cur")?.textContent,
    Math.abs(document.querySelector(".cur").getBoundingClientRect().top - document.querySelector(".reading-line").getBoundingClientRect().top) < 12]);
  // The move to the next line starts (smooth scroll) in the same moment the line height changes.
  await v.evaluate(() => {
    window.__speech.say("you answer not recite short lines guide");
    const el = document.querySelector("#settings .line-height");
    el.value = 200;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await v.waitForFunction(() => document.querySelector(".cur")?.textContent === "Short lines guide your eyes." && Math.abs(document.querySelector(".cur").getBoundingClientRect().top - document.querySelector(".reading-line").getBoundingClientRect().top) < 12);
  await v.waitForTimeout(500);
  assert.deepEqual(await curAtLine(), ["Short lines guide your eyes.", true], "line height 200%, mid-move: the line being read is at the reading line");
  await spaceTo(v, "layout", "paragraphs");
  assert.deepEqual(await curAtLine(), ["Short lines guide your eyes.", true], "and in the Paragraphs layout");
  await spaceTo(v, "line-height", 165);
  await spaceTo(v, "layout", "lines");
  assert.deepEqual(await curAtLine(), ["Short lines guide your eyes.", true], "and back to the defaults");
  // Voice on, then Next, then a spacing change: the section just reached stays active and in place.
  await (await dock(v, ".next")).click();
  await v.waitForTimeout(500);
  const voiceSec = () => v.evaluate(() => { const a = document.querySelector(".section.active"); return [a.dataset.i, Math.round(a.getBoundingClientRect().top - document.querySelector(".reading-line").getBoundingClientRect().top)]; });
  const voiceSecBefore = await voiceSec();
  await spaceTo(v, "para-space", 100);
  await v.waitForTimeout(300);
  const voiceSecAfter = await voiceSec();
  assert.equal(voiceSecAfter[0], voiceSecBefore[0], "voice on, after Next: the same section stays active");
  assert.ok(Math.abs(voiceSecAfter[1] - voiceSecBefore[1]) <= 4, `voice on, after Next: it stays in place (${voiceSecBefore[1]} → ${voiceSecAfter[1]})`);
  await spaceTo(v, "para-space", 200);
  // Voice on, the reading line on a section's row of links: that row stays under it.
  await v.mouse.wheel(0, 1); // the reader's hand: no voice move is under way
  await v.evaluate(() => {
    const l = document.querySelector(".links");
    window.scrollBy(0, l.getBoundingClientRect().top + l.getBoundingClientRect().height / 2 - document.querySelector(".reading-line").getBoundingClientRect().top);
  });
  const voiceLinksUnder = () => v.evaluate(() => {
    const y = document.querySelector(".reading-line").getBoundingClientRect().top;
    const r = document.querySelector(".links").getBoundingClientRect();
    return r.top <= y && r.bottom > y;
  });
  assert.equal(await voiceLinksUnder(), true, "voice on: the links row starts under the reading line");
  for (const [what, value] of [["line-height", 200], ["layout", "paragraphs"], ["para-space", 50], ["line-height", 165], ["layout", "lines"], ["para-space", 200]]) {
    await spaceTo(v, what, value);
    await v.waitForTimeout(150);
    assert.equal(await voiceLinksUnder(), true, `voice on, links row: still under the reading line (${what} ${value})`);
  }
  // Hand-scrolling just after a voice move, in a browser that sends no scrollend: a spacing change keeps
  // what the reader moved to (the wheel ends the voice move), it does not snap back to the voiced line.
  await v.evaluate(() => { window.__blockScrollend = (e) => e.stopImmediatePropagation(); window.addEventListener("scrollend", window.__blockScrollend, true); });
  await v.evaluate(() => {
    const el = [...document.querySelectorAll("[data-k]")].find((p) => p.textContent === "One question keeps you focused.");
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - document.querySelector(".reading-line").getBoundingClientRect().top + 2);
  });
  await v.mouse.wheel(0, 1);
  await v.waitForFunction(() => document.querySelector(".cur")?.textContent === "One question keeps you focused.");
  const [spokenNow, spokenNext] = await v.evaluate(() => {
    const cur = document.querySelector(".cur");
    const all = [...document.querySelectorAll("[data-k]")];
    return [cur.textContent, all[all.indexOf(cur) + 1].textContent];
  });
  const voiceMoveAt = Date.now();
  await v.evaluate((t) => window.__speech.say(t.toLowerCase().replace(/[^a-z' ]/g, "")), spokenNow);
  await v.waitForFunction((t) => document.querySelector(".cur")?.textContent === t, spokenNext);
  const voicedLine = await v.evaluate(() => document.querySelector(".cur").textContent);
  await v.waitForTimeout(700); // the voice's smooth scroll has arrived; the 2 s guard is still running
  assert.ok(Date.now() - voiceMoveAt < 1500, "the wheel comes well inside the 2 s guard, so only the wheel can end the voice move");
  await v.mouse.wheel(0, 700);
  await v.waitForTimeout(500);
  const handLine = () => v.evaluate(() => {
    const y = document.querySelector(".reading-line").getBoundingClientRect().top;
    return [...document.querySelectorAll(".script [data-k], .script p:not(.para)")].find((el) => el.getBoundingClientRect().bottom > y).textContent;
  });
  const handBefore = await handLine();
  assert.notEqual(handBefore, voicedLine, "the wheel moved the page away from the voiced line");
  await spaceTo(v, "line-height", 200);
  await v.waitForTimeout(300);
  assert.equal(await handLine(), handBefore, "a line height change after hand-scrolling keeps the line the reader moved to");
  assert.notEqual(await v.evaluate(() => document.querySelector(".cur")?.textContent), voicedLine, "after the wheel the line being read follows the reader, not the old voiced line");
  await v.evaluate(() => window.removeEventListener("scrollend", window.__blockScrollend, true));
  await spaceTo(v, "line-height", 165);
  await v.evaluate(() => window.__speech.fail("not-allowed"));
  await v.locator(".note-row.alert:not([hidden])").waitFor();
  assert.match(await v.locator(".alert-text").textContent(), /microphone is blocked/);
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "false");
  assert.equal(await v.locator(".cur").count(), 0, "voice off: no line marked");
  assert.equal(await v.locator(".settings-btn").getAttribute("data-dot"), null);
  assert.equal(await v.locator(".auto").getAttribute("aria-pressed"), "true", "auto-scroll resumes");
  await (await dock(v, ".auto")).click();
  // Consent is remembered: the second time it starts at once.
  await v.reload();
  await viaSettings(v, ".voice");
  assert.equal(await v.locator(".voice-notice").isHidden(), true);
  assert.equal(await v.evaluate(() => window.__speech.started), 1);
  // Speech drops now and then (Edge's service, Chrome after a minute): a fresh recognizer starts
  // at once, and one blip shows nothing.
  const voiceNote = () => v.locator(".toast").evaluate((el) => el.dataset.show === "true" && el.querySelector(".toast-text").textContent);
  const started = () => v.evaluate(() => window.__speech.started);
  const failAndRestart = async (error = "network") => {
    const n = await v.evaluate((e) => { window.__failedAt = performance.now(); window.__speech.fail(e); return window.__speech.started; }, error);
    await v.waitForFunction((k) => window.__speech.started === k + 1, n, { timeout: 5000 });
    return v.evaluate(() => window.__speech.startedAt.at(-1) - window.__failedAt); // the wait after the failure
  };
  await v.evaluate(() => window.__speech.say("hi"));
  const blip = await failAndRestart();
  assert.ok(blip < 300, `started again at once (${Math.round(blip)} ms)`);
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "true", "a network error keeps Follow my voice on");
  assert.equal(await voiceNote(), false, "one blip: no note");
  // Chrome's session ending after a minute (an end with no error): the same, at once.
  await v.evaluate(() => window.__speech.say("hi"));
  const ended = await v.evaluate(() => { const r = window.__speech.instance; r.running = false; r.onend?.(); return window.__speech.started; });
  await v.waitForFunction((k) => window.__speech.started === k + 1, ended, { timeout: 1000 });
  // It keeps failing: Reconnecting to speech by the reading line (read out once), and it tries
  // again a little apart (never more than 2 s), never two at once, each time a fresh recognizer.
  await v.evaluate(() => {
    window.__reconnectSaid = 0;
    let last = document.querySelector(".status").textContent;
    new MutationObserver(() => {
      const now = document.querySelector(".status").textContent;
      if (now !== last && now === "Reconnecting to speech…") window.__reconnectSaid++;
      last = now;
    }).observe(document.querySelector(".status"), { childList: true, characterData: true, subtree: true });
  });
  const waits = [];
  for (let i = 0; i < 5; i++) waits.push(await failAndRestart(i % 2 ? "no-speech" : "network"));
  assert.ok(waits.every((w) => w < 2600) && waits.at(-1) >= 900, `short, growing waits: ${waits.map(Math.round).join(", ")} ms`);
  assert.equal(await voiceNote(), "Reconnecting to speech…");
  assert.equal(await v.evaluate(() => window.__reconnectSaid), 1, "read out once, not on every try");
  assert.equal(await v.locator(".note-row.alert").isHidden(), true, "no error message");
  assert.equal(await v.locator(".toast svg").isVisible(), true, "with a microphone mark");
  await shot(v, "voice-reconnecting-desktop");
  await v.evaluate(() => window.__speech.say("hi"));
  assert.equal(await voiceNote(), false, "words heard again: the note goes");
  const afterWords = await failAndRestart();
  assert.ok(afterWords < 300, `after words it starts again at once (${Math.round(afterWords)} ms)`);
  // A session that goes quiet with no error and no end (a silent stall) is replaced by a fresh one.
  const beforeStall = await started();
  await v.waitForFunction((k) => window.__speech.started > k, beforeStall, { timeout: 13_000 });
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "true");
  assert.deepEqual(await v.evaluate(() => [window.__speech.doubleStarts, window.__speech.reused, window.__speech.made === window.__speech.started]), [0, 0, true], "never two starts at once, never an ended recognizer started again: one new object per start");
  await viaSettings(v, ".voice");
  // A browser that never reaches its speech service (Vivaldi, Brave) still gives up, with the
  // message, after about 15 s of trying with no word heard.
  await viaSettings(v, ".voice");
  const firstTry = await v.evaluate(() => performance.now());
  for (let i = 0; i < 40 && (await v.locator(".voice").getAttribute("aria-pressed")) === "true"; i++) {
    await v.evaluate(() => { if (window.__speech.instance?.running) window.__speech.fail("network"); });
    await v.waitForTimeout(500);
  }
  await v.locator(".note-row.alert:not([hidden])").waitFor();
  const gaveUpAfter = (await v.evaluate(() => performance.now())) - firstTry;
  assert.ok(gaveUpAfter >= 14_000, `kept trying for about 15 s first (${Math.round(gaveUpAfter)} ms)`);
  assert.match(await v.locator(".alert-text").textContent(), /could not reach its speech service\. Some browsers \(like Vivaldi or Brave\) cannot use it; try Chrome or Edge\./);
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "false");
  assert.equal(await voiceNote(), false, "the reconnecting note goes with it");
  const afterGiveUp = await started();
  await v.waitForTimeout(1500);
  assert.deepEqual(await v.evaluate(() => [window.__speech.started, window.__speech.doubleStarts]), [afterGiveUp, 0], "no start after giving up, and never two at once");
  await v.locator('.note-row.alert [data-action="dismiss"]').click();
  // Where the browser can recognise speech on this device, it does (installing the language pack
  // from the click); a running session switches to it at once.
  await v.evaluate(() => { window.__speechOnDevice = "downloadable"; });
  await viaSettings(v, ".voice");
  await v.waitForFunction(() => window.__speech.instance?.processLocally === true && window.__speech.instance.running);
  assert.equal(await v.evaluate(() => window.__speech.installs), 1, "the language pack is installed once");
  // A browser whose recognizer cannot start at all: off at once, with its own message.
  await viaSettings(v, ".voice");
  await v.evaluate(() => { window.__speechBroken = true; });
  const madeBefore = await v.evaluate(() => window.__speech.made);
  await viaSettings(v, ".voice");
  await v.locator(".note-row.alert:not([hidden])").waitFor();
  assert.equal(await v.locator(".alert-text").textContent(), "Follow my voice could not start in this browser; try Chrome or Edge. Follow my voice is off.");
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "false");
  assert.equal(await v.locator(".settings-btn").getAttribute("data-dot"), null);
  await v.waitForTimeout(1500);
  assert.equal(await v.evaluate(() => window.__speech.made), madeBefore + 1, "one try, no retry loop");
  await voiced.close();
  ok("Follow my voice: a big mic button in Settings (orange when on) with the API, notice before first use, follows line by line to the reading line (pure white current line, white lines after it), interim and later-line words never jump, skips QL, picks up after scrolling by hand, pauses auto-scroll, handles a blocked mic, keeps going when speech drops (a fresh recognizer at once after a blip or a session end, no note for one blip; Reconnecting to speech by the reading line, read out once, only while it keeps failing, tries a little apart and never two at once; heard words hide it; a silent stall replaced by a fresh recognizer) and gives up with the message only after about 15 s of failing with no word heard (a browser without the speech service), uses on-device recognition where the browser has it, says it could not start (off at once, one try) when the recognizer cannot start, remembers consent");

  // ---- The Producer's cues with Follow my voice, and going quiet while the box shows ----
  if (mode === "wrangler") {
    const { token: cueToken } = await (await fetch(`${base}/api/agent-token`, { method: "POST" })).json();
    const cued = await browser.newContext(DESKTOP);
    await cued.addInitScript(SPEECH_STUB);
    // Connected from the start, as after a reload (the token kept on the device).
    await cued.addInitScript(([t]) => { if (!localStorage.getItem("prompter-agent")) localStorage.setItem("prompter-agent", JSON.stringify({ token: t, createdAt: Date.now() })); }, [cueToken]);
    await cued.clock.install();
    const c = await cued.newPage();
    watch(c, "cues with voice");
    await c.goto(link);
    await c.locator(".section").first().waitFor();
    assert.equal((await agentRpc(cueToken, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } })).status, 200);
    await c.waitForFunction(() => document.querySelector(".open-btn").dataset.dot === "on");
    await c.locator(".voice:not([hidden])").waitFor({ state: "attached" });
    await viaSettings(c, ".voice");
    await c.locator('[data-action="voice-ok"]').click();
    await c.keyboard.press("Escape");
    await c.evaluate(() => window.__speech.say("writing scripts takes"));
    await c.waitForFunction(() => /Writing scripts/.test(document.querySelector(".cur")?.textContent || ""));
    // The host reads the cue aloud while the box shows; the browser is still hearing the phrase (one
    // unfinished result) when the box closes.
    const cueText = "One question keeps you focused.";
    await agentCall(cueToken, "push_suggestions", { items: [{ kind: "point", text: cueText }] });
    await c.locator(".ask-pill").click();
    await c.locator(".ask-box").waitFor();
    await c.evaluate(() => window.__speech.say("one question keeps", true));
    await c.mouse.click(12, 12); // a tap beside closes the box
    await c.locator(".ask-box").waitFor({ state: "hidden" });
    // The phrase begun while the box showed ends after it closed: none of it is followed. The speech
    // service is slow (no result for over a second, though the host speaks on: that is no pause) and
    // then ends the phrase as two results, its opening alone and the rest as a new one.
    await c.clock.fastForward(1200);
    await c.evaluate(() => { const s = window.__speech; s.say("one question"); s.say("keeps you focused"); });
    await c.waitForTimeout(300);
    assert.match(await c.locator(".cur").textContent(), /Writing scripts/, "the rest of the cue's phrase, come late and split, never moves the script");
    // Less than a pause after the phrase ended, more words (a later line's) are still held.
    await c.clock.fastForward(900);
    await c.evaluate(() => window.__speech.say("short lines guide your eyes"));
    await c.waitForTimeout(300);
    assert.match(await c.locator(".cur").textContent(), /Writing scripts/, "no pause yet: still not followed");
    // After a pause the host goes on with the script: followed from where they were.
    await c.clock.fastForward(1100);
    await c.evaluate(() => window.__speech.say("too long reading"));
    await c.waitForFunction(() => /Reading them/.test(document.querySelector(".cur")?.textContent || ""));
    await viaSettings(c, ".voice"); // off
    await c.keyboard.press("Escape");
    // Auto-scroll on, a cue opens (scrolling waits), Follow my voice turned on meanwhile: auto-scroll stays off
    // when the box closes, and comes back when voice goes off.
    await (await dock(c, ".auto")).click();
    await agentCall(cueToken, "push_suggestions", { items: [{ kind: "steer", text: "Back to the demo." }] });
    await c.locator(".ask-pill").click();
    await c.locator(".ask-box").waitFor();
    await viaSettings(c, ".voice");
    if (await c.locator('[data-action="voice-ok"]').isVisible()) await c.locator('[data-action="voice-ok"]').click();
    await c.locator('.ask-box [data-action="ask-skip"]').click();
    await c.locator('.ask-box[data-kind="point"]').waitFor(); // the cue read aloud before still waited
    await c.locator('.ask-box [data-action="ask-skip"]').click();
    await c.locator(".ask-box").waitFor({ state: "hidden" });
    const autoState = () => c.locator(".dock-btn.auto").getAttribute("aria-pressed");
    assert.deepEqual([await c.locator("#settings .voice").getAttribute("aria-pressed"), await autoState()], ["true", "false"], "voice on: auto-scroll does not come back with the box closing");
    await viaSettings(c, ".voice"); // off
    assert.equal(await autoState(), "true", "voice off: auto-scroll comes back");
    // Voice on over auto-scroll, a cue opens, then voice goes off (as when the microphone fails) while it shows:
    // scrolling waits for the box. Then the pushes stop: after two minutes the box and the pill hide by
    // themselves and auto-scroll goes on.
    await viaSettings(c, ".voice");
    if (await c.locator('[data-action="voice-ok"]').isVisible()) await c.locator('[data-action="voice-ok"]').click();
    assert.equal(await autoState(), "false");
    await agentCall(cueToken, "push_suggestions", { items: [{ kind: "question", text: "What do you build?", number: 1 }] });
    await c.locator(".ask-pill").click();
    await c.locator(".ask-box").waitFor();
    await viaSettings(c, ".voice"); // off
    assert.equal(await autoState(), "true", "auto-scroll is on again, and Play shows it");
    const held = await c.evaluate(() => scrollY);
    await c.clock.runFor(500);
    assert.deepEqual([await c.locator(".ask-box").isVisible(), await c.evaluate(() => scrollY)], [true, held], "scrolling waits while the box shows");
    await c.clock.fastForward("02:05");
    await c.locator(".ask-box").waitFor({ state: "hidden" });
    assert.deepEqual([await c.locator(".ask-pill").isHidden(), await autoState()], [true, "true"], "gone quiet: no box, no pill, scrolling goes on");
    await cued.close();
    ok("the Producer's cues with Follow my voice: words heard while the box shows (split or not), and the rest of a phrase begun then, also when it comes late and split, are never followed, and following goes on after the first pause once the phrase has ended; voice turned on while a cue shows keeps auto-scroll off until voice goes off, and voice going off while it shows lets scrolling wait for the box; the box and pill hide by themselves two minutes after the last push, and auto-scroll goes on");
  }

  // ---- Links open at the point where they are talked about ----
  const inlineLink = await makeLink(INLINE_SCRIPT, "lex", base);
  const linked = await browser.newContext(DESKTOP);
  await linked.addInitScript(SCREEN_STUB);
  await linked.addInitScript(SPEECH_STUB);
  const L = await linked.newPage();
  watch(L, "inline links");
  await L.goto(inlineLink);
  await L.locator(".section").first().waitFor();
  const intro = L.locator(".section").nth(1);
  assert.deepEqual(await intro.locator(".links .link").allTextContents(), ["↗Intro1", "↗Patchstack2"], "every link is still listed and numbered at the top");
  assert.deepEqual(await intro.locator(".links .link").evaluateAll((els) => els.map((el) => el.title)), ["example.com · key 1", "patchstack.com · key 2"], "the address only in the tooltip");
  const markEl = intro.locator(".mark");
  assert.equal(await markEl.textContent(), "↗Patchstack", "a quiet marker: no \"opens here\" text");
  assert.equal(await markEl.getAttribute("title"), "patchstack.com · opens on the main screen when it reaches the reading line");
  assert.equal(await markEl.getAttribute("data-k"), null, "the marker is not a spoken line");
  assert.equal(await L.evaluate(() => [...document.querySelector(".section:nth-child(2) .mark").previousElementSibling.querySelectorAll("[data-k]")].at(-1).textContent), "Patchstack finds the holes.", "the marker comes right after the paragraph that ends with its line");
  await viaSettings(L, ".screen");
  assert.equal(await L.locator("#settings .screen").getAttribute("data-on"), "true");
  assert.deepEqual([await L.locator("#settings .screen").getAttribute("aria-label"), await L.locator("#settings .screen").getAttribute("title"), await L.locator(".settings-btn").getAttribute("data-dot"), await L.locator(".settings-btn").getAttribute("aria-label")],
    ["Main screen connected, reconnect", "Main screen connected, reconnect", "on", "Settings · main screen connected"], "Settings shows the main screen connected, with a dot on its button");
  assert.deepEqual(await L.locator("#settings .screen").evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]), ["oklch(0.33 0.096 282)", "oklch(0.7 0.19 32.3)"], "connected: an orange icon on the indigo button");
  const visits = () => L.evaluate(() => window.__screen.visits.slice());
  const lastVisit = async () => (await visits()).at(-1);
  await L.waitForTimeout(900);
  assert.deepEqual(await visits(), [], "PREP has no link: nothing opens");
  await scrollToSection(L, 1);
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://example.com/intro");
  ok("section start opens its top link on the main screen, as before");
  // Scroll so the reading line passes the inline link's marker.
  const passMark = (page, sel, dy = 0) => page.evaluate(([q, d]) => {
    const el = document.querySelector(q);
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - document.querySelector(".reading-line").getBoundingClientRect().top - 2 + d);
  }, [sel, dy]);
  await passMark(L, ".section:nth-child(2) .mark");
  await L.waitForTimeout(300);
  assert.equal(await lastVisit(), "https://example.com/intro", "waits for the settle delay");
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://patchstack.com", null, { timeout: 2000 });
  assert.equal(await markEl.getAttribute("data-shown"), "true");
  await L.waitForTimeout(300); // let the border fade in
  assert.deepEqual(await markEl.evaluate((el) => { const cs = getComputedStyle(el, "::after"); return [getComputedStyle(el).borderTopColor, cs.content]; }), ["oklch(0.65 0.227 32.3)", "none"], "thin orange border, no extra text");
  assert.match(await L.locator(".status").textContent(), /On main screen: Patchstack/);
  await shot(L, "inline-link-desktop");
  // Back above the marker: the link above the reading line (Intro) returns.
  await passMark(L, ".section:nth-child(2) .mark", -120);
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://example.com/intro", null, { timeout: 2000 });
  assert.equal(await markEl.getAttribute("data-shown"), "false");
  // Fast scrolling past the marker and back within the settle delay opens nothing.
  const before = (await visits()).length;
  await passMark(L, ".section:nth-child(2) .mark", 40);
  await L.waitForTimeout(150);
  await passMark(L, ".section:nth-child(2) .mark", -120);
  await L.waitForTimeout(1000);
  assert.equal((await visits()).length, before, "no flash while scrolling quickly");
  ok("an inline link opens when the reading line passes it (after the settle delay); scrolling back re-shows the link above; quick scrolling flashes nothing");
  // Follow my voice: saying the next section's link label opens it at once.
  await L.evaluate(() => localStorage.setItem("prompter-voice-ok", "yes"));
  await viaSettings(L, ".voice");
  assert.equal(await L.locator(".voice").getAttribute("aria-pressed"), "true");
  await L.evaluate(() => window.__speech.say("and then wordfence"));
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://www.wordfence.com", null, { timeout: 2000 });
  await L.evaluate(() => window.__speech.say("and then wordfence blocks it"));
  await L.waitForTimeout(100);
  assert.equal((await visits()).filter((u) => u === "https://www.wordfence.com").length, 1, "the same label heard again does not reopen it");
  // The main screen moves on (a link chip); saying the label again reopens it.
  await L.keyboard.press("1");
  assert.equal(await lastVisit(), "https://example.com/intro");
  // The label still sits in the recent words: that echo must not take the screen back.
  await L.evaluate(() => window.__speech.say("then the next line"));
  await L.waitForTimeout(300);
  assert.equal(await lastVisit(), "https://example.com/intro", "an echo of an earlier label does not reopen it");
  await L.evaluate(() => window.__speech.say("back to wordfence"));
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://www.wordfence.com", null, { timeout: 2000 });
  assert.equal((await visits()).filter((u) => u === "https://www.wordfence.com").length, 2, "reopened after the screen moved");
  await viaSettings(L, ".voice");
  ok("Follow my voice: saying a link's label (next section) opens it at once; heard again it reopens only after the main screen moved");
  // A link on the last line of a section: its marker is the last thing there and opens once passed.
  const lastMark = ".section:nth-child(4) .mark";
  assert.equal(await L.evaluate((q) => document.querySelector(q) === document.querySelector(q).parentElement.lastElementChild, lastMark), true);
  await passMark(L, lastMark, 2);
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://docs.example.com", null, { timeout: 2000 });
  ok("a link on a section's last line opens once the reading line passes it");
  await linked.close();

  // The demo's inline link opens on the main screen when the reading line passes it.
  const demoLinked = await browser.newContext(DESKTOP);
  await demoLinked.addInitScript(SCREEN_STUB);
  const D = await demoLinked.newPage();
  watch(D, "demo inline link");
  await D.goto(`${base}/#demo`);
  await D.locator(".section").first().waitFor();
  await viaSettings(D, ".screen");
  const demoMark = D.locator(".section .mark");
  assert.equal(await demoMark.count(), 1, "the demo shows one inline link");
  assert.equal(await demoMark.textContent(), "↗Teleprompter");
  assert.deepEqual(await D.locator(".section .inlink").allTextContents(), ["mid-sentence, like this"], "and one link inside a sentence");
  await passMark(D, ".section .mark", 2);
  await D.waitForFunction(() => window.__screen.visits.at(-1) === "https://en.wikipedia.org/wiki/Teleprompter", null, { timeout: 2000 });
  await shot(D, "inline-link-demo-desktop");
  ok("the demo (better speaking with a prompter) opens its inline Teleprompter link when the reading line passes it");
  await demoLinked.close();

  // A link inside a sentence reads like the words around it: same font and
  // colour, a faint dotted orange underline; hover tints it orange; on the
  // main screen it gets a thin orange border. Nothing moves between states.
  const textLink = await makeLink(TEXT_LINK_SCRIPT, "lex", base);
  const textCtx = await browser.newContext(DESKTOP);
  await textCtx.addInitScript(SCREEN_STUB);
  const X = await textCtx.newPage();
  watch(X, "link inside a sentence");
  await X.goto(textLink);
  await X.locator(".section").first().waitFor();
  await viaSettings(X, ".screen");
  await X.mouse.move(40, 40);
  await X.waitForFunction(() => window.__screen.visits.at(-1) === "https://example.com/intro", null, { timeout: 2000 });
  const inlink = X.locator(".inlink").first();
  assert.equal(await X.locator(".inlink").count(), 2);
  assert.equal(await inlink.textContent(), "the docs");
  assert.equal(await inlink.getAttribute("title"), "developer.mozilla.org · opens on the main screen when it reaches the reading line");
  assert.equal(await inlink.evaluate((el) => el.parentElement.textContent), "Read the docs first.", "no address, brackets, arrow or number in the line");
  assert.notEqual(await inlink.evaluate((el) => el.parentElement.dataset.k), undefined, "the line is still a spoken line");
  assert.equal(await X.locator(".section .mark").count(), 0, "no marker for a link inside a line");
  const linkLooks = () => inlink.evaluate((el) => {
    const cs = getComputedStyle(el);
    const p = getComputedStyle(el.parentElement);
    const r = el.getBoundingClientRect();
    return {
      same: ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "color"].filter((k) => cs[k] !== p[k]),
      color: cs.color, background: cs.backgroundColor, border: cs.borderTopColor,
      line: cs.textDecorationLine, style: cs.textDecorationStyle, underline: cs.textDecorationColor,
      box: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10),
    };
  });
  // The words after the link sit exactly where they sit in the same line without a link.
  const after = (sel) => X.evaluate((q) => {
    const p = [...document.querySelectorAll(".section [data-k]")].find((el) => el.textContent === "Read the docs first." && el.matches(q));
    const range = document.createRange();
    range.selectNodeContents(p.lastChild);
    return range.getBoundingClientRect().right - p.getBoundingClientRect().left;
  }, sel);
  const plainRight = await after(":not(:has(.inlink))");
  const linkedRight = await after(":has(.inlink)");
  assert.ok(Math.abs(plainRight - linkedRight) <= 1, `the line keeps its width: ${plainRight} vs ${linkedRight}`);
  // In view, a little below the reading line, so hovering scrolls nothing.
  await X.evaluate(() => {
    const el = document.querySelector(".inlink");
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.34 - 150);
  });
  await X.waitForTimeout(300);
  const normal = await linkLooks();
  assert.deepEqual(normal.same, [], "same font, size, weight and colour as the line");
  assert.equal(normal.color, "oklch(0.975 0.012 282)", "active line colour");
  assert.deepEqual([normal.line, normal.style, normal.underline], ["underline", "dotted", "oklch(0.65 0.227 32.3 / 0.55)"], "faint dotted orange underline");
  assert.deepEqual([normal.background, normal.border], ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
  await shot(X, "text-link-desktop");
  await inlink.hover();
  await X.waitForTimeout(300);
  const hovered = await linkLooks();
  assert.deepEqual([hovered.color, hovered.background], ["oklch(0.65 0.227 32.3)", "oklch(0.23 0.06 32)"], "hover: orange text on a soft orange tint");
  assert.deepEqual(hovered.box, normal.box, "hover moves nothing");
  await shot(X, "text-link-hover-desktop");
  await X.mouse.move(40, 40);
  // The reading line reaches the line with the link: it opens on the main screen.
  await X.evaluate(() => {
    const el = document.querySelector(".inlink");
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.34 - 2);
  });
  await X.waitForFunction(() => window.__screen.visits.at(-1) === "https://developer.mozilla.org/en-US/", null, { timeout: 2000 });
  assert.equal(await inlink.getAttribute("data-shown"), "true");
  await X.waitForTimeout(300);
  const shown = await linkLooks();
  assert.deepEqual([shown.border, shown.background, shown.line], ["oklch(0.65 0.227 32.3)", "rgba(0, 0, 0, 0)", "none"], "on the main screen: thin orange border, no fill, no underline");
  assert.deepEqual(shown.box.slice(2), normal.box.slice(2), "the shown state is the same size");
  assert.deepEqual(await inlink.evaluate((el) => getComputedStyle(el, "::after").content), "none", "no extra text");
  await shot(X, "text-link-shown-desktop");
  // Clicking a link inside a line shows it at once; the top row stays quiet.
  await X.locator(".inlink").nth(1).click();
  assert.equal(await X.evaluate(() => window.__screen.visits.at(-1)), "https://www.wordfence.com");
  assert.match(await X.locator(".status").textContent(), /On main screen: the firewall/);
  assert.equal(await X.evaluate(() => location.hash.startsWith("#s=")), true, "clicking does not follow the link in the prompter");
  // Its section no longer active: the link keeps the line's colour, white like every line still to be read (TOOLS-486).
  await X.keyboard.press("ArrowRight");
  await X.waitForTimeout(350);
  const dimmed = await linkLooks();
  assert.deepEqual(dimmed.same, [], "inactive section: still the line's own colour");
  assert.equal(dimmed.color, "oklch(0.975 0.012 282)");
  await X.evaluate(() => window.scrollTo(0, 0));
  await X.waitForTimeout(350);
  const row = X.locator(".section").first().locator(".links .link").first();
  assert.deepEqual(await row.evaluate((el) => { const cs = getComputedStyle(el); return [cs.backgroundColor, cs.color, el.querySelector("small"), parseFloat(cs.fontSize) < 20]; }),
    ["rgba(0, 0, 0, 0)", "oklch(0.763 0.027 282)", null, true], "the top row is small and muted, with no pill and no address");
  assert.deepEqual(await X.locator(".section").first().locator(".links .link").allTextContents(), ["↗Intro1", "↗Guide2", "↗the docs3", "↗the firewall4"], "number keys follow reading order");
  await shot(X, "link-row-desktop");
  await X.keyboard.press("4");
  assert.equal(await X.evaluate(() => window.__screen.visits.at(-1)), "https://www.wordfence.com");
  await textCtx.close();
  ok("a link inside a sentence: the line shows only its words in the line's own font and colour (also in another section), a faint dotted orange underline; hover turns it orange on a soft tint; at the reading line it opens and gets a thin orange border without underline; no layout shift; click and number keys open it; the top row is small and muted");

  // The control bar tucks away when scrolling down and returns on scrolling up or near the bottom edge.
  const tuckCtx = await browser.newContext(DESKTOP);
  const T = await tuckCtx.newPage();
  watch(T, "tucking bar");
  await T.goto(`${base}/#demo`);
  await T.locator(".section").first().waitFor();
  await T.mouse.move(683, 120);
  const tucked = () => T.locator(".dock").getAttribute("data-tucked");
  await T.evaluate(() => window.scrollBy(0, 500));
  await T.waitForFunction(() => document.querySelector(".dock").dataset.tucked === "true");
  await T.waitForTimeout(400);
  const hidden = await T.locator(".dock").evaluate((el) => { const cs = getComputedStyle(el); return { opacity: cs.opacity, filter: cs.filter, translate: cs.translate }; });
  assert.equal(hidden.opacity, "0");
  assert.match(hidden.filter, /blur/);
  assert.notEqual(hidden.translate, "none");
  await T.evaluate(() => window.scrollBy(0, -200));
  await T.waitForFunction(() => document.querySelector(".dock").dataset.tucked === "false");
  await T.evaluate(() => window.scrollBy(0, 400));
  await T.waitForFunction(() => document.querySelector(".dock").dataset.tucked === "true");
  await T.mouse.move(683, 880);
  assert.equal(await tucked(), "false", "the bottom edge brings it back");
  await T.evaluate(() => window.scrollBy(0, 400));
  await T.waitForTimeout(100);
  assert.equal(await tucked(), "false", "it stays while the mouse rests near the bottom");
  // After really using the bar (a click on Play, a popover closed by a click outside) it still tucks away.
  await T.evaluate(() => window.scrollTo(0, 0));
  await (await dock(T, ".auto")).click();
  await T.mouse.move(683, 120);
  await T.evaluate(() => window.scrollBy(0, 300));
  await T.waitForFunction(() => document.querySelector(".dock").dataset.tucked === "true", null, { timeout: 3000 });
  await (await dock(T, ".auto")).click();
  await (await dock(T, ".settings-btn")).click();
  await T.mouse.click(683, 200);
  await T.mouse.move(683, 120);
  await T.evaluate(() => window.scrollBy(0, 300));
  await T.waitForFunction(() => document.querySelector(".dock").dataset.tucked === "true", null, { timeout: 3000 });
  ok("the control bar slides down, fades and blurs away when scrolling down, also after clicking Play or closing a popover; scrolling up or the bottom edge brings it back and it stays there");
  await tuckCtx.close();

  // On a phone a tap on the bar does not count as the mouse resting near the bottom.
  const tuckTouch = await browser.newContext(MOBILE);
  await tuckTouch.addInitScript(NO_SPEECH);
  const TT = await tuckTouch.newPage();
  watch(TT, "tucking bar touch");
  await TT.goto(`${base}/#demo`);
  await TT.locator(".section").first().waitFor();
  await TT.locator(".dock .auto").tap();
  await TT.locator(".dock .auto").tap();
  await TT.evaluate(() => window.scrollBy(0, 400));
  await TT.waitForFunction(() => document.querySelector(".dock").dataset.tucked === "true", null, { timeout: 3000 });
  ok("on a phone the control bar still tucks away after tapping its buttons");
  await tuckTouch.close();

  // A YouTube inline link opens in the page's own #player view.
  const ytCtx = await browser.newContext(DESKTOP);
  await ytCtx.addInitScript(SCREEN_STUB);
  const Y = await ytCtx.newPage();
  watch(Y, "youtube inline link");
  await Y.goto(await makeLink("### **INTRO · 00:00**\n\nQL: Watch this?\n\nFirst a few lines.\nThen the video.\n- Video: https://www.youtube.com/watch?v=aqz-KE-bpKQ\nIt plays full size.\n", "lex", base));
  await Y.locator(".section").first().waitFor();
  await viaSettings(Y, ".screen");
  await Y.mouse.move(683, 120);
  await passMark(Y, ".section .mark", 2);
  await Y.waitForFunction(() => /#player=aqz-KE-bpKQ&start=0$/.test(window.__screen.visits.at(-1) || ""), null, { timeout: 2000 });
  ok("a YouTube inline link opens the full-window #player view");
  await ytCtx.close();

  // No main screen: one gentle hint, once, above the control bar.
  const hinted = await browser.newContext(DESKTOP);
  const H = await hinted.newPage();
  watch(H, "screen hint");
  await H.goto(inlineLink);
  await H.locator(".section").first().waitFor();
  await scrollToSection(H, 1);
  await H.locator(".screen-hint:not([hidden])").waitFor({ timeout: 2000 });
  assert.match(await H.locator(".hint-text").textContent(), /“Intro” would open on your main screen now/);
  assert.equal(await H.locator(".settings-btn").getAttribute("data-hint"), "true");
  const deskHint = await H.locator(".screen-hint").boundingBox();
  assert.ok(deskHint.y > 900 * 0.34 + 40 && deskHint.y + deskHint.height < (await H.locator(".dock").boundingBox()).y, "the hint floats above the control bar, clear of the reading line");
  assert.equal(await H.locator(".note-row.alert").isHidden(), true, "no alert, just the hint");
  await shot(H, "screen-hint-desktop");
  await H.locator('.screen-hint [data-action="hint-ok"]').click();
  assert.equal(await H.locator(".screen-hint").isHidden(), true);
  await passMark(H, ".section:nth-child(2) .mark");
  await H.waitForTimeout(1000);
  assert.equal(await H.locator(".screen-hint").isHidden(), true, "shown once per page");
  await hinted.close();
  // The hint's own Connect button connects and shows the link at the reading line.
  const hintConnect = await browser.newContext(DESKTOP);
  await hintConnect.addInitScript(SCREEN_STUB);
  const HC = await hintConnect.newPage();
  watch(HC, "hint connect");
  await HC.goto(inlineLink);
  await HC.locator(".section").first().waitFor();
  await scrollToSection(HC, 1);
  await HC.locator(".screen-hint:not([hidden])").waitFor({ timeout: 2000 });
  assert.deepEqual(await HC.evaluate(() => window.__screen.visits), [], "nothing opens before Connect");
  await HC.locator('.screen-hint [data-action="connect"]').click();
  assert.equal(await HC.locator(".screen-hint").isHidden(), true);
  assert.equal(await HC.locator(".settings-btn").getAttribute("data-hint"), null);
  // Once the browser has answered the window placement ask (here it says no at once).
  await HC.waitForFunction(() => window.__screen.visits.at(-1) === "https://example.com/intro", null, { timeout: 3000 });
  assert.equal(await HC.locator("#settings .screen").getAttribute("data-on"), "true");
  assert.equal(await HC.locator("#settings .screen").getAttribute("aria-label"), "Main screen connected, reconnect");
  await hintConnect.close();
  ok("without a main screen nothing opens; a one-time hint above the control bar; its Connect button hides it, clears the highlight and shows the current link");

  // ---- A page that cuts the main screen's link (TOOLS-492) ----
  // The Dutch Data Protection Authority's page sends Cross-Origin-Opener-Policy: same-origin and
  // X-Frame-Options: SAMEORIGIN. Shown in the main screen window, the browser cuts that window off
  // from the Prompter for good (it still shows the page; the Prompter sees it as closed). A local
  // stand-in on another address sends the same headers; no real network. /slowcuts answers only once
  // the check lets it (a slow site). The pages that cut come from their own names (cut1.localhost and
  // so on, which the browser keeps on this computer), as each site that cuts is remembered.
  let letSlowAnswer;
  const slowAnswer = new Promise((done) => { letSlowAnswer = done; });
  const standIn = createServer(async (req, res) => {
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (req.url.startsWith("/slow")) await slowAnswer;
    if (/^\/(slow)?cuts/.test(req.url)) Object.assign(headers, { "cross-origin-opener-policy": "same-origin", "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'" });
    res.writeHead(200, headers);
    res.end(`<!doctype html><title>Stand-in ${req.url}</title><p>Stand-in page ${req.url}</p>`);
  });
  await new Promise((done) => standIn.listen(0, done));
  standIn.unref(); // a failing check never keeps the run alive
  const site = `http://localhost:${standIn.address().port}`; // the page is on 127.0.0.1: another site
  const [cut1, cut2, cut3] = [1, 2, 3].map((n) => `http://cut${n}.localhost:${standIn.address().port}`);
  const CUT_SCRIPT = `### **INTRO · 00:00**\n\n- Plain: ${site}/plain\n\nHello there.\nA plain page first.\n\n### **1 · DATA LEAKS · 02:00**\n\n- Leak rules: ${cut1}/cuts\n\nThe regulator says what to do.\nRead the page with me.\n\n### **2 · NEXT · 04:00**\n\n- After: ${site}/after\n\nAnd then the next page.\nIt opens here too.\n\n### **3 · MORE RULES · 05:00**\n\n- More rules: ${cut2}/cuts\n\nAnother site that cuts.\nIt cuts the window off too.\n\n### **4 · SLOW SITE · 06:00**\n\n- Slow rules: ${cut3}/slowcuts\n\nThis site takes its time.\nIt cuts the window off too.\n`;
  const cutCtx = await browser.newContext(DESKTOP);
  await cutCtx.addInitScript(NO_SPEECH);
  // window.__noPopups stands in for the browser's pop-up blocker: no window opens.
  await cutCtx.addInitScript(() => {
    const real = window.open;
    window.open = function (...args) { return window.__noPopups ? null : real.apply(this, args); };
  });
  // window.__holdWatch keeps the Prompter's own look at the main screen window (every 500 ms) from
  // running, so a check can act before it.
  await cutCtx.addInitScript(() => {
    const real = window.setInterval;
    window.setInterval = (fn, ms, ...rest) => real((...a) => { if (!(ms === 500 && window.__holdWatch)) fn(...a); }, ms, ...rest);
  });
  // window.__focus counts the Prompter asking for the keys back; window.__said lists what the status
  // line read out.
  await cutCtx.addInitScript(() => {
    const real = window.focus;
    window.__focus = 0;
    window.focus = function () { window.__focus++; return real.apply(this); };
    window.__said = [];
    addEventListener("DOMContentLoaded", () => {
      const el = document.querySelector(".status");
      if (el) new MutationObserver(() => { if (el.textContent) window.__said.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true });
    });
  });
  const CW = await cutCtx.newPage();
  watch(CW, "page cuts the link");
  await CW.goto(await makeLink(CUT_SCRIPT, "lex", base));
  await CW.locator(".section").first().waitFor();
  const screenOf = (page) => page.evaluate(() => {
    const b = document.querySelector("#settings .screen");
    return [b.dataset.on, b.getAttribute("aria-label"), document.querySelector(".settings-btn").getAttribute("aria-label")];
  });
  const cutOff = () => CW.waitForFunction(() => document.querySelector("#settings .screen").dataset.on === "cut", null, { timeout: 3000 });
  const reconnect = async () => (await Promise.all([cutCtx.waitForEvent("page"), viaSettings(CW, ".screen")]))[0];
  const later = (ms) => CW.evaluate((n) => { const real = Date.now.bind(Date); Date.now = () => real() + n; }, ms); // shifts add up
  const noAlert = () => CW.locator(".note-row.alert").isHidden();
  const hold = (on) => CW.evaluate((v) => { window.__holdWatch = v; }, on);
  const popups = (on) => CW.evaluate((v) => { window.__noPopups = !v; }, on);
  const noteOf = () => CW.locator(".cut-note").evaluate((el) => (el.hidden ? "" : el.querySelector(".cut-text").textContent));
  const stored = () => CW.evaluate(() => JSON.parse(localStorage.getItem("prompter-cut-sites")));
  const linkOf = (i) => CW.locator(`.section[data-i="${i}"] .links .link`).first();
  const firstWin = await reconnect();
  await scrollToSection(CW, 0);
  await firstWin.waitForURL(`${site}/plain`);
  await hold(true);
  await scrollToSection(CW, 1);
  await firstWin.waitForURL(`${cut1}/cuts`);
  await CW.waitForTimeout(700);
  assert.equal((await screenOf(CW))[0], "true", "the Prompter has not looked yet");
  await hold(false);
  await cutOff();
  assert.deepEqual(await screenOf(CW), ["cut", "Main screen cut off, reconnect", "Settings · main screen cut off"], "the button says the main screen is cut off, on itself, with a dot on Settings");
  assert.match(await CW.locator("#settings .screen").getAttribute("title"), /^Main screen cut off, reconnect\. Its window was closed, or the page in it cut it off .*still shows its page.*The next page tries to open a new main screen by itself \(the browser may block that/, "its title says either may have happened, that a cut-off window still shows its page, and what comes next");
  assert.equal(await CW.locator(".status").textContent(), "cut1.localhost may have cut the main screen off.", "read out once through the status line");
  assert.equal(await noteOf(), "cut1.localhost may have cut the main screen off.", "one plain note names the site, as one that may have done it (a window closed by hand looks the same)");
  assert.equal(await CW.locator(".cut-note button").textContent(), "Open a new main screen", "with one button");
  assert.equal(await noAlert(), true, "no alert");
  assert.deepEqual(await stored(), ["cut1.localhost"], "the site is remembered on this device, its name only");
  const [cutBox, cutDock] = [await CW.locator(".cut-note").boundingBox(), await CW.locator(".dock").boundingBox()];
  assert.ok(cutBox.y + cutBox.height <= cutDock.y, "the note sits above the control bar");
  assert.deepEqual(await CW.locator(".cut-note").evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.borderStyle, s.outlineStyle, /inset/.test(s.boxShadow), s.boxShadow !== "none"];
  }), ["none", "none", false, true], "lifted by its shadow only: no border, ring or 1px highlight");
  await closeUp(CW, ".cut-note", "screen-cut-note-close-up");
  await (await dock(CW, ".settings-btn")).click();
  await CW.locator("#settings:popover-open").waitFor();
  await closeUp(CW, "#settings .big-toggles", "screen-cut-close-up");
  const cutLook = () => CW.locator("#settings .screen").evaluate((el) => {
    const [s, r] = [getComputedStyle(el), getComputedStyle(el.querySelector("rect"))];
    return [s.color, r.fill, r.strokeDasharray, r.strokeLinecap, s.boxShadow, s.borderStyle];
  });
  const dashed = ["oklch(0.7 0.19 32.3)", "none", "3px, 2.5px", "butt", "none", "none"];
  assert.deepEqual(await cutLook(), dashed, "an orange dashed screen outline (square dash ends, so the gaps show): no fill, no ring or border");
  const restBg = await CW.locator("#settings .screen").evaluate((el) => getComputedStyle(el).backgroundColor);
  await CW.locator("#settings .screen").hover();
  await CW.waitForTimeout(250);
  const hoverBg = await CW.locator("#settings .screen").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(hoverBg, restBg, "the hover look applies");
  assert.deepEqual((await cutLook())[0], dashed[0], "still orange under the pointer");
  await CW.evaluate(() => document.querySelector("#settings").hidePopover());
  await CW.waitForTimeout(1200);
  assert.deepEqual([cutCtx.pages().length, firstWin.url(), await noAlert(), (await screenOf(CW))[0]], [2, `${cut1}/cuts`, true, "cut"], "the cut-off page stays in its window; nothing opens before the next page, no alert");
  // The next page opens a new main screen by itself, and the note goes.
  const [secondWin] = await Promise.all([cutCtx.waitForEvent("page"), scrollToSection(CW, 2)]);
  await secondWin.waitForURL(`${site}/after`);
  assert.deepEqual([(await screenOf(CW))[0], await noteOf(), firstWin.url()], ["true", "", `${cut1}/cuts`], "connected again, the note gone; the old window still shows the page that cut it off");
  // From then on that site opens in a window of its own, and the main screen stays connected; the
  // Prompter asks for the keys back (the clicker and Space keep working on the script).
  const focusBefore = await CW.evaluate(() => window.__focus);
  const [ownWin] = await Promise.all([cutCtx.waitForEvent("page"), scrollToSection(CW, 1)]);
  await ownWin.waitForURL(`${cut1}/cuts`);
  await CW.waitForTimeout(1200);
  assert.deepEqual([(await screenOf(CW))[0], secondWin.url(), await noteOf()], ["true", `${site}/after`, ""], "the remembered site opens in its own window: the main screen stays connected and keeps its page");
  assert.equal(await CW.locator(".status").textContent(), "In its own window: Leak rules", "read out");
  assert.equal(await linkOf(1).getAttribute("data-shown"), "true", "its link is marked as showing");
  assert.ok(await CW.evaluate((n) => window.__focus > n, focusBefore), "the Prompter asks for the keys back");
  assert.equal(await linkOf(2).getAttribute("data-shown"), "true", "the main screen's page stays marked too");
  // Back at the section before: the main screen already shows its page, so it is not loaded again
  // (a playing video would start over).
  await secondWin.evaluate(() => { window.__kept = true; });
  await scrollToSection(CW, 2);
  await CW.waitForTimeout(1200);
  assert.equal(await secondWin.evaluate(() => window.__kept === true), true, "the main screen's page is not loaded again");
  assert.equal(await CW.locator(".status").textContent(), "On main screen: After. cut1.localhost's own window may still cover it: close that window.", "the next page says the own window may still cover it");
  assert.deepEqual([await linkOf(1).getAttribute("data-shown"), await linkOf(2).getAttribute("data-shown")], ["false", "true"]);
  await scrollToSection(CW, 0);
  await secondWin.waitForURL(`${site}/plain`);
  assert.equal(await CW.locator(".status").textContent(), "On main screen: Plain", "said once");
  // Back at that section, no second own window opens by itself (the first cannot be closed from here,
  // and they would pile up), and the main screen keeps its page.
  const pagesNow = cutCtx.pages().length;
  await scrollToSection(CW, 1);
  await CW.waitForTimeout(1200);
  assert.deepEqual([cutCtx.pages().length, secondWin.url()], [pagesNow, `${site}/plain`], "once per page by itself: no second own window, the main screen keeps its page");
  await scrollToSection(CW, 0);
  await CW.waitForTimeout(600);
  // Before the Prompter's own look, the next page finds the main screen cut off and opens a new one at
  // once. Blocked (no click, pop-ups not allowed), the note says so, once, and its button opens one.
  await hold(true);
  await scrollToSection(CW, 3);
  await secondWin.waitForURL(`${cut2}/cuts`);
  await CW.waitForTimeout(700);
  assert.equal((await screenOf(CW))[0], "true", "the Prompter has not looked yet");
  await popups(false);
  await scrollToSection(CW, 2);
  await cutOff();
  await hold(false);
  const blockedSays = "cut2.localhost may have cut the main screen off. The browser blocked a new main screen: allow pop-ups for this page so the next one opens by itself.";
  assert.deepEqual([await noteOf(), await CW.locator(".status").textContent(), await noAlert(), cutCtx.pages().length], [blockedSays, blockedSays, true, 4], "blocked: the note says so, no alert, no window");
  await CW.evaluate(() => { window.__said = []; });
  await scrollToSection(CW, 0);
  await CW.waitForTimeout(300);
  assert.equal(await noteOf(), blockedSays, "the same note after another blocked page");
  assert.deepEqual(await CW.evaluate(() => window.__said), [], "said once: not read out again on the next blocked page");
  // The longest note (the blocked sentence and a long site name) fits a phone and 200% zoom, above
  // the control bar.
  for (const width of [390, 195]) {
    await CW.setViewportSize({ width, height: 800 });
    await CW.waitForTimeout(200);
    assert.deepEqual(await CW.evaluate(() => {
      const text = document.querySelector(".cut-text");
      const before = text.textContent;
      text.textContent = before.replace("cut2.localhost", "a-very-long-site-name-that-goes-on-and-on.autoriteitpersoonsgegevens.nl");
      const [note, bar] = [document.querySelector(".cut-note").getBoundingClientRect(), document.querySelector(".dock").getBoundingClientRect()];
      const fits = [document.documentElement.scrollWidth <= innerWidth && note.left >= 0 && note.right <= innerWidth && text.scrollWidth <= text.clientWidth, note.bottom <= bar.top, note.top >= 0];
      text.textContent = before;
      return fits;
    }), [true, true, true], `the longest note fits ${width}px, above the control bar`);
  }
  await CW.setViewportSize(DESKTOP.viewport);
  await CW.waitForTimeout(300);
  await popups(true);
  const [thirdWin] = await Promise.all([cutCtx.waitForEvent("page"), CW.locator('.cut-note [data-action="connect"]').click()]);
  await thirdWin.waitForURL(`${site}/plain`);
  assert.deepEqual([(await screenOf(CW))[0], await noteOf(), await stored()], ["true", "", ["cut1.localhost", "cut2.localhost"]], "the note's button opens a new main screen with the page at the reading line; the second site is remembered too");
  // A slow site that cuts the window off well after it was sent (15 s): the same note, no alert.
  await scrollToSection(CW, 4);
  await CW.waitForTimeout(300);
  await later(15000);
  letSlowAnswer();
  await thirdWin.waitForURL(`${cut3}/slowcuts`);
  await cutOff();
  assert.deepEqual([await noteOf(), await noAlert()], ["cut3.localhost may have cut the main screen off.", true], "a slow site: the same note, no alert");
  // Reconnecting while the page that cut it off is still the one at the reading line does not send it
  // again (it would cut the new window off too), also when pressed twice: the new window waits for the
  // next page, and no link is marked as showing.
  const fourthWin = await reconnect();
  await viaSettings(CW, ".screen");
  await CW.waitForTimeout(1200);
  assert.deepEqual([fourthWin.url(), (await screenOf(CW))[0], cutCtx.pages().length, await noteOf()], ["about:blank", "true", 6, ""], "the new window waits with its message, after a second Reconnect too");
  assert.deepEqual(await fourthWin.evaluate(() => [...document.querySelectorAll("[data-full]")].map((l) => l.textContent)), ["Press F11 for full screen"], "a page held back: the line is there too, once after a second Reconnect");
  assert.match(await fourthWin.locator("[data-note]").textContent(), /Drag this window to your main screen.*The last page \(cut3\.localhost\) was not sent again.*its link button opens it anyway/);
  assert.equal(await CW.locator('[data-shown="true"]').count(), 0, "no link marked as showing");
  assert.match(await CW.locator(".status").textContent(), /^Main screen connected\. The last page \(cut3\.localhost\) was not sent again: its link button opens it\.$/, "read out once");
  // A long site name in a narrow window (a phone, or 200% zoom) wraps: no sideways scrolling.
  for (const width of [390, 195]) {
    await fourthWin.setViewportSize({ width, height: 800 });
    assert.equal(await fourthWin.evaluate(() => {
      const note = document.querySelector("[data-note]");
      const before = note.textContent;
      note.textContent = before.replace("cut3.localhost", "autoriteitpersoonsgegevens.nl");
      document.querySelector("[data-full]").hidden = false;
      const fits = document.documentElement.scrollWidth <= innerWidth;
      note.textContent = before;
      return fits;
    }), true, `the waiting window's note fits ${width}px`);
  }
  await scrollToSection(CW, 2);
  await fourthWin.waitForURL(`${site}/after`);
  // A window someone closes: the same state (from here it looks the same). Long after its page was
  // sent, Reconnect sends that page again, and a link button opens a new main screen with its page.
  await scrollToSection(CW, 0);
  await fourthWin.waitForURL(`${site}/plain`);
  await later(60000);
  await fourthWin.close();
  await cutOff();
  assert.deepEqual([await noteOf(), await noAlert()], ["The main screen was closed or cut off.", true], "a closed window: the note names no site, no alert");
  const fifthWin = await reconnect();
  await fifthWin.waitForURL(`${site}/plain`);
  await later(60000);
  await fifthWin.close();
  await cutOff();
  const [sixthWin] = await Promise.all([cutCtx.waitForEvent("page"), linkOf(2).click()]);
  await sixthWin.waitForURL(`${site}/after`);
  assert.deepEqual([(await screenOf(CW))[0], await noteOf()], ["true", ""], "a link button connects a new main screen");
  // Closed straight after its page was sent: from here that looks like a cut (the Prompter cannot
  // tell them apart), so that page waits for its link button and its site is remembered.
  await scrollToSection(CW, 0);
  await sixthWin.waitForURL(`${site}/plain`);
  await sixthWin.close();
  await cutOff();
  assert.equal(await noteOf(), "localhost may have cut the main screen off.", "a window closed by hand: the note says the site may have done it, not that it did");
  const seventhWin = await reconnect();
  await CW.waitForTimeout(1200);
  assert.deepEqual([seventhWin.url(), await stored()], ["about:blank", ["cut1.localhost", "cut2.localhost", "cut3.localhost", "localhost"]], "closed straight after its page was sent: not sent again, its site remembered");
  // Another script with that page at the reading line: still held back; its link button opens it, in a
  // window of its own now, and the main screen stays as it is.
  await (await dock(CW, ".open-btn")).click();
  await CW.locator('#open-menu [data-action="paste"]').click();
  await CW.locator(".paste-dialog[open]").waitFor();
  await CW.locator("#paste-text").fill(`### **OTHER · 00:00**\n\n- Plain again: ${site}/plain\n\nA second script.\nWith the same page.\n`);
  const pagesBefore = cutCtx.pages().length;
  await CW.locator('[data-action="open-paste"]').click();
  await CW.locator(".paste-dialog:not([open])").waitFor({ state: "attached" });
  await CW.waitForTimeout(1500);
  assert.deepEqual([seventhWin.url(), await CW.locator('[data-shown="true"]').count(), cutCtx.pages().length], ["about:blank", 0, pagesBefore], "another script does not send the held-back page by itself");
  const [ownPlain] = await Promise.all([cutCtx.waitForEvent("page"), CW.locator(".links .link").first().click()]);
  await ownPlain.waitForURL(`${site}/plain`);
  assert.deepEqual([seventhWin.url(), (await screenOf(CW))[0]], ["about:blank", "true"], "its own window; the main screen stays connected");
  // Closed by hand within 30 s: that says nothing, the site stays on the list.
  await CW.waitForTimeout(1000);
  await ownPlain.close();
  await later(31000);
  await CW.waitForTimeout(1200);
  assert.deepEqual(await stored(), ["cut1.localhost", "cut2.localhost", "cut3.localhost", "localhost"], "an own window closed by hand changes nothing");
  // An own window still connected 30 s on shows the site did not cut it off (the main screen had only
  // been closed): it comes off the list, and the device is not stuck with it.
  const [ownAgain] = await Promise.all([cutCtx.waitForEvent("page"), CW.locator(".links .link").first().click()]);
  await ownAgain.waitForURL(`${site}/plain`);
  await CW.waitForTimeout(700);
  assert.deepEqual(await stored(), ["cut1.localhost", "cut2.localhost", "cut3.localhost", "localhost"], "not before 30 s");
  await later(31000);
  await CW.waitForFunction(() => !JSON.parse(localStorage.getItem("prompter-cut-sites")).includes("localhost"), null, { timeout: 3000 });
  assert.deepEqual(await stored(), ["cut1.localhost", "cut2.localhost", "cut3.localhost"], "a site whose own window stayed connected comes off the list; the sites that cut stay");
  // A remembered site whose own window the browser blocks (no click, pop-ups not allowed) never goes
  // to the connected main screen, which it would cut off: the main screen keeps its page, and the
  // page waits for its link button.
  await ownAgain.close();
  await (await dock(CW, ".open-btn")).click();
  await CW.locator('#open-menu [data-action="paste"]').click();
  await CW.locator(".paste-dialog[open]").waitFor();
  await CW.locator("#paste-text").fill(`### **FIRST · 00:00**\n\n- After: ${site}/after\n\nA plain page.\nOn the main screen.\n\n### **RULES · 01:00**\n\n- Leak rules: ${cut1}/cuts\n\nA site that cuts.\nIts own window is blocked.\n`);
  await CW.locator('[data-action="open-paste"]').click();
  await CW.locator(".paste-dialog:not([open])").waitFor({ state: "attached" });
  await scrollToSection(CW, 0);
  await seventhWin.waitForURL(`${site}/after`);
  await popups(false);
  const pagesThen = cutCtx.pages().length;
  await scrollToSection(CW, 1);
  await CW.waitForTimeout(1200);
  assert.deepEqual([seventhWin.url(), (await screenOf(CW))[0], cutCtx.pages().length, await CW.locator(".status").textContent()],
    [`${site}/after`, "true", pagesThen, "Not opened: Leak rules needs a window of its own, which the browser blocked. Its link button opens it."],
    "a blocked own window: the main screen keeps its page and stays connected; said through the status line");
  await popups(true);
  await cutCtx.close();
  await new Promise((done) => standIn.close(done));
  ok("a page that cuts the main screen off (Cross-Origin-Opener-Policy, as the Dutch Data Protection Authority's page), or a closed main screen window: the button says cut off (an orange dashed screen, its name and title, a dot on Settings), one plain note above the control bar names the site (no border, ring or highlight; read out once) with one button, Open a new main screen, and no alert; the next page opens a new main screen by itself (blocked: the note says so, once); the site is remembered on this device and opens in a window of its own from then on (once per page by itself, the keys back to the Prompter), so the main screen stays connected, and comes off the list when that window stays connected; the longest note fits 195px; also when the next page comes before the Prompter looked and for a slow site; Reconnect does not send again a page that may have cut it off");

  // With the window placement permission, a new main screen opens full size on the screen the Prompter
  // is not on; until it is allowed (asked from the Connect click), a plain window that moves there once
  // it is. Every main screen's own page says "Press F11 for full screen" while it is not full screen
  // (TOOLS-492: a page cannot make it full screen across sites, the browser's own F11 can).
  const placeCtx = await browser.newContext(DESKTOP);
  await placeCtx.addInitScript(NO_SPEECH);
  // A 1920 × 1080 screen (headless pop-ups otherwise report a screen as big as their page).
  await placeCtx.addInitScript(() => {
    Object.defineProperty(Screen.prototype, "width", { get: () => 1920, configurable: true });
    Object.defineProperty(Screen.prototype, "height", { get: () => 1080, configurable: true });
  });
  await placeCtx.addInitScript(() => {
    const screens = [{ isPrimary: false, availLeft: 0, availTop: 0, availWidth: 1366, availHeight: 860 }, { isPrimary: true, availLeft: 1366, availTop: 0, availWidth: 1920, availHeight: 1040 }];
    window.getScreenDetails = () => Promise.resolve({ screens, currentScreen: screens[0] });
    const real = window.open;
    window.__features = [];
    window.open = function (...args) { window.__features.push(args[2]); return real.apply(this, args); };
  });
  const PL = await placeCtx.newPage();
  watch(PL, "main screen placement");
  await PL.goto(await makeLink("### **WORDS · 00:00**\n\nJust words here.\nNothing to show.\n", "lex", base));
  await PL.locator(".section").first().waitFor();
  const [placedWin] = await Promise.all([placeCtx.waitForEvent("page"), viaSettings(PL, ".screen")]);
  await placedWin.waitForFunction(() => document.querySelector("[data-note]")?.textContent === "Main screen. Pages will open here.");
  assert.deepEqual(await PL.evaluate(() => window.__features), ["popup=yes,width=1400,height=900"], "the first one opens plain and asks for the permission");
  const fullLine = (win) => win.evaluate(() => {
    const line = document.querySelector("[data-full]");
    return line && { text: line.textContent, shown: !line.hidden && line.offsetHeight > 0, size: parseFloat(getComputedStyle(line).fontSize) };
  });
  const line = await fullLine(placedWin);
  assert.deepEqual([line.text, line.shown], ["Press F11 for full screen", true], "not full screen: one plain line says how");
  assert.ok(line.size >= 48, `the line is large (${line.size}px)`);
  await shot(placedWin, "main-screen-f11-desktop");
  await placedWin.setViewportSize({ width: 1920, height: 1080 });
  await placedWin.waitForFunction(() => document.querySelector("[data-full]").hidden, null, { timeout: 3000 });
  assert.equal((await fullLine(placedWin)).shown, false, "full screen (the page fills the screen): the line goes");
  await placedWin.setViewportSize({ width: 1366, height: 900 });
  await placedWin.waitForFunction(() => !document.querySelector("[data-full]").hidden, null, { timeout: 3000 });
  assert.equal((await fullLine(placedWin)).shown, true, "out of full screen again: the line comes back");
  // The browser's own word for it (a page's full screen, or F11 where it reports it), at any size.
  await placedWin.evaluate(() => {
    Object.defineProperty(Document.prototype, "fullscreenElement", { get: () => document.body, configurable: true });
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  assert.equal((await fullLine(placedWin)).shown, false, "the browser says full screen: the line goes");
  await placedWin.evaluate(() => {
    delete Document.prototype.fullscreenElement;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  assert.equal((await fullLine(placedWin)).shown, true, "and comes back when it leaves");
  await placedWin.close();
  await PL.waitForFunction(() => document.querySelector("#settings .screen").dataset.on === "cut");
  const [nextWin] = await Promise.all([placeCtx.waitForEvent("page"), PL.locator('.cut-note [data-action="connect"]').click()]);
  assert.equal(await PL.evaluate(() => window.__features.at(-1)), "popup=yes,left=1366,top=0,width=1920,height=1040", "the next one opens full size on the other screen");
  assert.equal(await nextWin.evaluate(() => document.querySelector("[data-note]").textContent), "Main screen. Pages will open here.", "no drag-me message");
  assert.deepEqual(await fullLine(nextWin).then((l) => [l.text, l.shown]), ["Press F11 for full screen", true], "a later main screen says it too");
  await placeCtx.close();
  // The first Connect with a page at the reading line: the window waits on its own page until the
  // permission is answered, moves to the other screen, and only then gets the page (a window showing
  // another site can no longer be moved).
  const slowCtx = await browser.newContext(DESKTOP);
  await slowCtx.addInitScript(NO_SPEECH);
  await slowCtx.addInitScript(() => {
    const screens = [{ isPrimary: false, availLeft: 0, availTop: 0, availWidth: 1366, availHeight: 860 }, { isPrimary: true, availLeft: 1366, availTop: 0, availWidth: 1920, availHeight: 1040 }];
    window.getScreenDetails = () => {
      window.__asked = [navigator.userActivation.isActive, Boolean(window.__opened)]; // the browser shows the ask only from a click
      return new Promise((done) => { window.__allow = () => done({ screens, currentScreen: screens[0] }); });
    };
    const real = window.open;
    window.__moved = [];
    window.open = function (...args) {
      window.__opened = true;
      const win = real.apply(this, args);
      if (win) win.moveTo = (...at) => window.__moved.push([...at, win.location.href]);
      return win;
    };
  });
  const SL = await slowCtx.newPage();
  watch(SL, "main screen placement, slow answer");
  await SL.goto(await makeLink(`### **INTRO · 00:00**\n\n- Licence: ${base}/fonts/OFL.txt\n\nA page at the reading line.\nWaiting for the answer.\n`, "lex", base));
  await SL.locator(".section").first().waitFor();
  await scrollToSection(SL, 0);
  const [slowWin] = await Promise.all([slowCtx.waitForEvent("page"), viaSettings(SL, ".screen")]);
  await SL.waitForTimeout(1200);
  assert.equal(slowWin.url(), "about:blank", "the page waits for the permission's answer");
  assert.deepEqual(await SL.evaluate(() => window.__asked), [true, false], "asked from the click, before the window opens and uses it up");
  assert.equal(await slowWin.evaluate(() => document.querySelector("[data-full]")?.textContent), "Press F11 for full screen", "the window waiting for the answer has the line too");
  assert.match(await slowWin.evaluate(() => document.querySelector("[data-note]").textContent), /Pages will open here\. Allow window placement in the Prompter to move this window to your main screen\.$/, "the waiting window says where the ask is");
  assert.equal(await SL.evaluate(() => document.hasFocus()), true, "the Prompter comes back to the front, so the ask is not hidden behind the new window");
  await SL.evaluate(() => window.__allow());
  await slowWin.waitForURL(`${base}/fonts/OFL.txt`);
  assert.deepEqual(await SL.evaluate(() => window.__moved), [[1366, 0, "about:blank"]], "moved to the other screen before the page went to it");
  await slowCtx.close();
  // No answer at all: after 10 s the page goes anyway (the window stays where it is), and a page that
  // came during the wait (here a scroll to the next section that settled) goes instead, once.
  const muteCtx = await browser.newContext(DESKTOP);
  await muteCtx.addInitScript(NO_SPEECH);
  await muteCtx.addInitScript(() => {
    window.getScreenDetails = () => new Promise(() => {});
    const real = window.open;
    window.__moved = [];
    window.open = function (...args) {
      const win = real.apply(this, args);
      if (win) win.moveTo = (...at) => window.__moved.push(at);
      return win;
    };
  });
  const ML = await muteCtx.newPage();
  watch(ML, "main screen placement, no answer");
  await ML.goto(await makeLink(`### **INTRO · 00:00**\n\n- Licence: ${base}/fonts/OFL.txt\n\nA page at the reading line.\nWaiting for the answer.\n\n### **NEXT · 00:30**\n\n- Licence again: ${base}/fonts/OFL.txt?next=1\n\nThe next section.\nReached during the wait.\n`, "lex", base));
  await ML.locator(".section").first().waitFor();
  await scrollToSection(ML, 0);
  const [muteWin] = await Promise.all([muteCtx.waitForEvent("page"), viaSettings(ML, ".screen")]);
  const muteVisits = [];
  muteWin.on("framenavigated", (frame) => { if (frame === muteWin.mainFrame() && frame.url() !== "about:blank") muteVisits.push(frame.url()); });
  await scrollToSection(ML, 1);
  await ML.waitForTimeout(1500);
  assert.equal(muteWin.url(), "about:blank", "still waiting: the settled scroll's page is held back");
  await muteWin.waitForURL(`${base}/fonts/OFL.txt?next=1`, { timeout: 12000 });
  await ML.waitForTimeout(800);
  assert.deepEqual(muteVisits, [`${base}/fonts/OFL.txt?next=1`], "only the page that came during the wait, once");
  assert.deepEqual(await ML.evaluate(() => window.__moved), [], "with no answer the window stays where it is");
  await muteCtx.close();
  // A link chosen by hand during the wait is the newest choice: the page held before it is not sent
  // over it when the answer comes.
  const pickCtx = await browser.newContext(DESKTOP);
  await pickCtx.addInitScript(NO_SPEECH);
  await pickCtx.addInitScript(() => { window.getScreenDetails = () => new Promise((done) => { window.__deny = () => done(null); }); });
  const PK = await pickCtx.newPage();
  watch(PK, "main screen placement, a pick during the wait");
  await PK.goto(await makeLink(`### **INTRO · 00:00**\n\n- Licence: ${base}/fonts/OFL.txt\n- Other: ${base}/fonts/OFL.txt?other=1\n\nA page at the reading line.\nWaiting for the answer.\n\n### **NEXT · 00:30**\n\n- Licence again: ${base}/fonts/OFL.txt?next=1\n\nThe next section.\nReached during the wait.\n`, "lex", base));
  await PK.locator(".section").first().waitFor();
  await scrollToSection(PK, 0);
  const [pickWin] = await Promise.all([pickCtx.waitForEvent("page"), viaSettings(PK, ".screen")]);
  const pickVisits = [];
  pickWin.on("framenavigated", (frame) => { if (frame === pickWin.mainFrame() && frame.url() !== "about:blank") pickVisits.push(frame.url()); });
  await scrollToSection(PK, 1);
  await PK.waitForTimeout(1500); // the next section's page is held now
  await PK.locator('.section[data-i="0"] .links .link').nth(1).dispatchEvent("click");
  await pickWin.waitForURL(`${base}/fonts/OFL.txt?other=1`);
  await PK.evaluate(() => window.__deny());
  await PK.waitForTimeout(800);
  assert.deepEqual(pickVisits, [`${base}/fonts/OFL.txt?other=1`], "the held page does not go over the link chosen during the wait");
  await pickCtx.close();
  // Connect pressed twice during the wait: still one wait, so a link chosen after the second press is
  // not overwritten by the reading line's page when the answer comes.
  const twiceCtx = await browser.newContext(DESKTOP);
  await twiceCtx.addInitScript(NO_SPEECH);
  await twiceCtx.addInitScript(() => { window.getScreenDetails = () => new Promise((done) => { window.__deny = () => done(null); }); });
  const TW2 = await twiceCtx.newPage();
  watch(TW2, "main screen placement, Connect twice during the wait");
  await TW2.goto(await makeLink(`### **INTRO · 00:00**\n\n- Licence: ${base}/fonts/OFL.txt\n- Other: ${base}/fonts/OFL.txt?other=1\n\nA page at the reading line.\nWaiting for the answer.\n`, "lex", base));
  await TW2.locator(".section").first().waitFor();
  await scrollToSection(TW2, 0);
  const [twiceWin] = await Promise.all([twiceCtx.waitForEvent("page"), viaSettings(TW2, ".screen")]);
  const twiceVisits = [];
  twiceWin.on("framenavigated", (frame) => { if (frame === twiceWin.mainFrame() && frame.url() !== "about:blank") twiceVisits.push(frame.url()); });
  await viaSettings(TW2, ".screen");
  await TW2.waitForTimeout(300);
  assert.equal(twiceCtx.pages().length, 2, "the second press opens no other window");
  await TW2.locator('.section[data-i="0"] .links .link').nth(1).dispatchEvent("click");
  await twiceWin.waitForURL(`${base}/fonts/OFL.txt?other=1`);
  await TW2.evaluate(() => window.__deny());
  await TW2.waitForTimeout(800);
  assert.deepEqual(twiceVisits, [`${base}/fonts/OFL.txt?other=1`], "the reading line's page does not go over the link chosen after a second Connect");
  await twiceCtx.close();
  // A link chosen during the wait, then Connect pressed again while that link still loads: the window
  // still gets that link, so it stays marked as showing after the wait.
  const markCtx = await browser.newContext(DESKTOP);
  await markCtx.addInitScript(NO_SPEECH);
  await markCtx.addInitScript(() => { window.getScreenDetails = () => new Promise((done) => { window.__deny = () => done(null); }); });
  let markLoading;
  const markHeld = new Promise((done) => { markLoading = done; });
  let markRelease;
  const markGo = new Promise((done) => { markRelease = done; });
  await markCtx.route(/OFL\.txt\?other=1$/, async (route) => { markLoading(); await markGo; await route.continue(); });
  const MK = await markCtx.newPage();
  watch(MK, "main screen placement, a pick then Connect again during the wait");
  await MK.goto(await makeLink(`### **INTRO · 00:00**\n\n- Licence: ${base}/fonts/OFL.txt\n- Other: ${base}/fonts/OFL.txt?other=1\n\nA page at the reading line.\nWaiting for the answer.\n`, "lex", base));
  await MK.locator(".section").first().waitFor();
  await scrollToSection(MK, 0);
  const [pickedWin] = await Promise.all([markCtx.waitForEvent("page"), viaSettings(MK, ".screen")]);
  const otherLink = MK.locator('.section[data-i="0"] .links .link').nth(1);
  await MK.waitForTimeout(1000); // the scroll to the reading line's page has settled
  await otherLink.dispatchEvent("click");
  await markHeld; // the link is still loading: its answer waits
  await viaSettings(MK, ".screen");
  markRelease();
  await MK.evaluate(() => window.__deny());
  await pickedWin.waitForURL(`${base}/fonts/OFL.txt?other=1`);
  await MK.waitForTimeout(800);
  const firstLink = MK.locator('.section[data-i="0"] .links .link').first();
  assert.deepEqual([pickedWin.url(), await otherLink.getAttribute("data-shown"), await firstLink.getAttribute("data-shown")], [`${base}/fonts/OFL.txt?other=1`, "true", "false"], "the link the window shows stays marked after a second Connect, and only that one");
  await markCtx.close();
  // The waiting window is closed, the next page opens a new main screen by itself, which waits too, and
  // a later page comes while the wait still runs: that later page goes to the new main screen when the
  // wait ends, and the one before it never does.
  const goneCtx = await browser.newContext(DESKTOP);
  await goneCtx.addInitScript(NO_SPEECH);
  await goneCtx.addInitScript(() => { window.getScreenDetails = () => new Promise((done) => { window.__deny = () => done(null); }); });
  const GW = await goneCtx.newPage();
  watch(GW, "main screen placement, the waiting window closed");
  await GW.goto(await makeLink(`### **INTRO · 00:00**\n\nNo page here.\nWaiting for the answer.\n\n### **B · 00:30**\n\n- Page B: ${base}/fonts/OFL.txt?b=1\n\nThe waiting window is gone.\nA new main screen opens.\n\n### **C · 01:00**\n\n- Page C: ${base}/fonts/OFL.txt?c=1\n\nStill during the wait.\nIt goes there when the wait ends.\n`, "lex", base));
  await GW.locator(".section").first().waitFor();
  await scrollToSection(GW, 0);
  const [goneWin] = await Promise.all([goneCtx.waitForEvent("page"), viaSettings(GW, ".screen")]);
  await goneWin.close();
  await GW.waitForFunction(() => document.querySelector("#settings .screen").dataset.on === "cut");
  const [newWin] = await Promise.all([goneCtx.waitForEvent("page"), scrollToSection(GW, 1)]);
  const newVisits = [];
  newWin.on("framenavigated", (frame) => { if (frame === newWin.mainFrame() && frame.url() !== "about:blank") newVisits.push(frame.url()); });
  await GW.waitForTimeout(300);
  assert.equal(newWin.url(), "about:blank", "the new main screen waits too");
  assert.match(await newWin.evaluate(() => document.body.textContent), /Allow window placement in the Prompter/, "and says where the ask is");
  await viaSettings(GW, ".screen"); // Connect pressed again finds that window: still the one wait
  await GW.waitForTimeout(300);
  assert.deepEqual([goneCtx.pages().length, newWin.url()], [2, "about:blank"], "no other window, and it still waits");
  await scrollToSection(GW, 2);
  await GW.waitForTimeout(1500); // page C is held now
  await GW.evaluate(() => window.__deny());
  await newWin.waitForURL(`${base}/fonts/OFL.txt?c=1`, { timeout: 3000 });
  await GW.waitForTimeout(500);
  assert.deepEqual(newVisits, [`${base}/fonts/OFL.txt?c=1`], "the page held during the wait goes to the new main screen, once");
  await goneCtx.close();
  // A page held before the waiting window closed does not go over the new main screen's page.
  const heldCtx = await browser.newContext(DESKTOP);
  await heldCtx.addInitScript(NO_SPEECH);
  await heldCtx.addInitScript(() => { window.getScreenDetails = () => new Promise((done) => { window.__deny = () => done(null); }); });
  const HW = await heldCtx.newPage();
  watch(HW, "main screen placement, a page held before the waiting window closed");
  await HW.goto(await makeLink(`### **INTRO · 00:00**\n\nNo page here.\nWaiting for the answer.\n\n### **A · 00:30**\n\n- Page A: ${base}/fonts/OFL.txt?a=1\n\nHeld during the wait.\nIts window is closed next.\n\n### **B · 01:00**\n\n- Page B: ${base}/fonts/OFL.txt?b=1\n\nA new main screen opens.\nIt keeps this page.\n`, "lex", base));
  await HW.locator(".section").first().waitFor();
  await scrollToSection(HW, 0);
  const [heldWin] = await Promise.all([heldCtx.waitForEvent("page"), viaSettings(HW, ".screen")]);
  await scrollToSection(HW, 1);
  await HW.waitForTimeout(1500); // page A is held now
  assert.equal(heldWin.url(), "about:blank", "page A waits");
  await heldWin.close();
  await HW.waitForFunction(() => document.querySelector("#settings .screen").dataset.on === "cut");
  const freshVisits = [];
  heldCtx.on("page", (win) => win.on("framenavigated", (frame) => { if (frame === win.mainFrame() && frame.url() !== "about:blank") freshVisits.push(frame.url()); }));
  const [freshWin] = await Promise.all([heldCtx.waitForEvent("page"), scrollToSection(HW, 2)]);
  await HW.waitForTimeout(300);
  assert.deepEqual([freshWin.url(), await HW.locator(".status").textContent()], ["about:blank", ""], "page B waits too, and the status line no longer says cut off");
  await HW.evaluate(() => window.__deny());
  await freshWin.waitForURL(`${base}/fonts/OFL.txt?b=1`);
  await HW.waitForTimeout(800);
  assert.deepEqual(freshVisits, [`${base}/fonts/OFL.txt?b=1`], "page A never goes over page B");
  await heldCtx.close();
  // Allowed during the wait, after the waiting window was closed and a page opened a new main screen:
  // that window moves to the other screen before its page goes to it.
  const allowCtx = await browser.newContext(DESKTOP);
  await allowCtx.addInitScript(NO_SPEECH);
  await allowCtx.addInitScript(() => {
    const screens = [{ isPrimary: false, availLeft: 0, availTop: 0, availWidth: 1366, availHeight: 860 }, { isPrimary: true, availLeft: 1366, availTop: 0, availWidth: 1920, availHeight: 1040 }];
    window.getScreenDetails = () => new Promise((done) => { window.__allow = () => done({ screens, currentScreen: screens[0] }); });
    const real = window.open;
    window.__moved = [];
    window.open = function (...args) {
      const win = real.apply(this, args);
      if (win) win.moveTo = (...at) => window.__moved.push([...at, win.location.href]);
      return win;
    };
  });
  const AW = await allowCtx.newPage();
  watch(AW, "main screen placement, allowed after the waiting window closed");
  await AW.goto(await makeLink(`### **INTRO · 00:00**\n\nNo page here.\nWaiting for the answer.\n\n### **B · 00:30**\n\n- Page B: ${base}/fonts/OFL.txt?b=1\n\nA new main screen opens.\nIt moves first.\n`, "lex", base));
  await AW.locator(".section").first().waitFor();
  await scrollToSection(AW, 0);
  const [allowWin] = await Promise.all([allowCtx.waitForEvent("page"), viaSettings(AW, ".screen")]);
  await allowWin.close();
  await AW.waitForFunction(() => document.querySelector("#settings .screen").dataset.on === "cut");
  const [movedWin] = await Promise.all([allowCtx.waitForEvent("page"), scrollToSection(AW, 1)]);
  await AW.waitForTimeout(300);
  await AW.evaluate(() => window.__allow());
  await movedWin.waitForURL(`${base}/fonts/OFL.txt?b=1`);
  assert.deepEqual(await AW.evaluate(() => window.__moved), [[1366, 0, "about:blank"]], "moved to the other screen before page B went to it");
  await allowCtx.close();
  // Connect pressed after the waiting window was closed: the wait serves that new window, which gets
  // the page that came meanwhile.
  const againCtx = await browser.newContext(DESKTOP);
  await againCtx.addInitScript(NO_SPEECH);
  await againCtx.addInitScript(() => { window.getScreenDetails = () => new Promise((done) => { window.__deny = () => done(null); }); });
  const RW = await againCtx.newPage();
  watch(RW, "main screen placement, Connect again after the waiting window closed");
  await RW.goto(await makeLink(`### **INTRO · 00:00**\n\nNo page here.\nWaiting for the answer.\n\n### **B · 00:30**\n\n- Page B: ${base}/fonts/OFL.txt?b=1\n\nReached during the wait.\nIt goes to the new window.\n`, "lex", base));
  await RW.locator(".section").first().waitFor();
  await scrollToSection(RW, 0);
  const [closedWin] = await Promise.all([againCtx.waitForEvent("page"), viaSettings(RW, ".screen")]);
  await closedWin.close();
  await RW.waitForFunction(() => document.querySelector("#settings .screen").dataset.on === "cut");
  const [againWin] = await Promise.all([againCtx.waitForEvent("page"), RW.locator('.cut-note [data-action="connect"]').click()]);
  await scrollToSection(RW, 1);
  await RW.waitForTimeout(1500); // page B is held now
  assert.equal(againWin.url(), "about:blank", "page B waits");
  await RW.evaluate(() => window.__deny());
  await againWin.waitForURL(`${base}/fonts/OFL.txt?b=1`, { timeout: 3000 });
  await againCtx.close();
  // Answered once with no second screen: later Connects do not ask again, so the Prompter does not
  // jump to the front and the new window shows no waiting line.
  const oneCtx = await browser.newContext(DESKTOP);
  await oneCtx.addInitScript(NO_SPEECH);
  await oneCtx.addInitScript(() => {
    const screens = [{ isPrimary: true, availLeft: 0, availTop: 0, availWidth: 1366, availHeight: 860 }];
    window.getScreenDetails = () => Promise.resolve({ screens, currentScreen: screens[0] });
    const realFocus = window.focus;
    window.__focus = 0;
    window.focus = function (...a) { window.__focus += 1; return realFocus.apply(this, a); };
    const real = window.open;
    window.__texts = [];
    window.open = function (...args) {
      const win = real.apply(this, args);
      // Every text the waiting window is given, also one replaced straight after.
      try { new win.MutationObserver(() => window.__texts.push(win.document.body.textContent)).observe(win.document.body, { childList: true, characterData: true, subtree: true }); } catch { /* another site */ }
      return win;
    };
  });
  const OS = await oneCtx.newPage();
  watch(OS, "main screen placement, one screen");
  await OS.goto(await makeLink("### **WORDS · 00:00**\n\nJust words here.\nNothing to show.\n", "lex", base));
  await OS.locator(".section").first().waitFor();
  const [oneWin] = await Promise.all([oneCtx.waitForEvent("page"), viaSettings(OS, ".screen")]);
  await OS.waitForTimeout(300);
  assert.equal(await OS.evaluate(() => window.__focus), 1, "the first Connect asks, and brings the Prompter to the front for it");
  await oneWin.close();
  await OS.waitForFunction(() => document.querySelector("#settings .screen").dataset.on === "cut");
  await OS.evaluate(() => { window.__texts = []; });
  const [oneAgain] = await Promise.all([oneCtx.waitForEvent("page"), OS.locator('.cut-note [data-action="connect"]').click()]);
  await OS.waitForTimeout(300);
  assert.equal(await OS.evaluate(() => window.__focus), 1, "answered already: the next Connect does not pull the Prompter to the front");
  assert.ok((await OS.evaluate(() => window.__texts)).every((t) => !t.includes("Allow window placement")), "and its window never shows the waiting line");
  assert.equal(await oneAgain.evaluate(() => document.querySelector("[data-note]").textContent), "Drag this window to your main screen and make it full size. Pages will open here.", "a plain window to drag");
  await oneCtx.close();
  ok("with the window placement permission (asked from the Connect click), a new main screen opens full size on the other screen; without it, a plain window to drag; every main screen's own page says Press F11 for full screen (large, one line) until the window is full screen, and again when it leaves full screen; the first Connect sends the page only once the permission is answered and the window has moved (the Prompter comes to the front for the ask; with no answer, after 10 s), and a page that came meanwhile goes instead, once; Connect pressed twice keeps one wait (a link chosen before the second press stays marked); a waiting window closed and replaced by the next page's new main screen (which waits and moves too) or by Connect gets the newest page, and a page held before the close never goes over it; once answered, later Connects do not ask again");

  // A page in a window of its own, with no main screen connected yet, stays marked as showing after
  // Text only is turned on and off.
  const ownBase = base.replace("://127.0.0.1", "://localhost"); // the same server under another site's name
  assert.notEqual(ownBase, base, "the own window's site differs from the Prompter's");
  const ownCtx = await browser.newContext(DESKTOP);
  await ownCtx.addInitScript(NO_SPEECH);
  await ownCtx.addInitScript(() => { localStorage.setItem("prompter-cut-sites", JSON.stringify(["localhost"])); });
  const OW = await ownCtx.newPage();
  watch(OW, "own window mark and Text only");
  await OW.goto(await makeLink(`### **RULES · 00:00**\n\n- Leak rules: ${ownBase}/fonts/OFL.txt\n\nA site that cuts.\nIt opens in its own window.\n`, "lex", base));
  await OW.locator(".section").first().waitFor();
  const [markWin] = await Promise.all([ownCtx.waitForEvent("page"), OW.locator(".links .link").first().click()]);
  await markWin.waitForURL(`${ownBase}/fonts/OFL.txt`);
  assert.equal(await OW.locator(".links .link").first().getAttribute("data-shown"), "true", "the own window's link is marked as showing");
  await viaSettings(OW, 'input[name="show"][value="text"]');
  await viaSettings(OW, 'input[name="show"][value="all"]');
  assert.equal(await OW.locator(".links .link").first().getAttribute("data-shown"), "true", "still marked after Text only on and off");
  await ownCtx.close();
  ok("a page in a window of its own stays marked as showing after Text only is turned on and off, also with no main screen connected");

  // ---- The reading line: dragged to camera height; read text fades above it ----
  const lineOf = (page) => page.evaluate(() => {
    const h = document.querySelector(".line-handle");
    return {
      top: document.querySelector(".reading-line").getBoundingClientRect().top,
      css: getComputedStyle(document.documentElement).getPropertyValue("--line").trim(),
      now: h.getAttribute("aria-valuenow"), text: h.getAttribute("aria-valuetext"),
      stored: localStorage.getItem("prompter-line"),
    };
  });
  const activeIs = (page) => page.locator(".section.active").getAttribute("data-i");
  const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const lineCtx = await browser.newContext(DESKTOP);
  await lineCtx.addInitScript(NO_SPEECH);
  const R = await lineCtx.newPage();
  watch(R, "reading line");
  await R.goto(`${base}/#demo`);
  await R.locator(".section").first().waitFor();
  assert.deepEqual(await lineOf(R), { top: 306, css: "306px", now: "34", text: "34% from the top", stored: null }, "a new visitor gets the line at 34%");
  const handle = R.locator(".line-handle");
  assert.deepEqual(await handle.evaluate((el) => [el.getAttribute("role"), el.getAttribute("aria-orientation"), el.getAttribute("aria-label"), el.getAttribute("aria-valuemin"), el.getAttribute("aria-valuemax"), el.tabIndex, getComputedStyle(el).touchAction, getComputedStyle(el).pointerEvents, getComputedStyle(el.parentElement).pointerEvents]),
    ["slider", "vertical", "Reading line", "8", "75", 0, "none", "auto", "none"], "a focusable vertical slider; only its band takes the pointer");
  let hb = await handle.boundingBox();
  const clientW = await R.evaluate(() => document.documentElement.clientWidth);
  assert.ok(hb.x <= 0 && hb.width >= clientW && hb.height === 20, `a 20px band along the whole line: ${JSON.stringify(hb)}`);
  assert.ok(Math.abs(hb.y + hb.height / 2 - 307) <= 1, `centred on the 2px line: ${JSON.stringify(hb)}`);
  assert.equal(await handle.getAttribute("data-tip"), null, "no tooltip on the line");
  assert.equal(await R.locator(".grip").count(), 0, "no separate tab");
  // Mid-script, drag it up with the mouse: only the line moves, the script stays put.
  await R.evaluate(() => window.scrollTo(0, 1500));
  await settle(R);
  const refTop = () => R.evaluate(() => document.querySelectorAll(".section p")[12].getBoundingClientRect().top);
  const textBefore = await refTop();
  // Grab it anywhere along the line, here at the left edge of the text column.
  await R.mouse.move(300, hb.y + hb.height / 2);
  await R.mouse.down();
  await R.mouse.move(300, hb.y + hb.height / 2 - 171, { steps: 8 });
  assert.equal(await handle.getAttribute("data-dragging"), "true");
  await R.waitForTimeout(250);
  assert.equal(await R.locator(".reading-line").evaluate((el) => getComputedStyle(el).borderTopColor), "oklch(0.65 0.227 32.3)", "full orange while dragging");
  await R.mouse.up();
  await settle(R);
  assert.deepEqual(await lineOf(R), { top: 135, css: "135px", now: "15", text: "15% from the top", stored: "0.1500" }, "dragged to 15%, remembered");
  assert.equal(await refTop(), textBefore, "the script did not move, only the line");
  assert.equal(await handle.getAttribute("data-dragging"), null);
  await R.mouse.move(683, 500);
  await R.waitForTimeout(300);
  await shot(R, "line-moved-desktop");
  hb = await handle.boundingBox();
  const lineColour = () => R.locator(".reading-line").evaluate((el) => [getComputedStyle(el).borderTopColor, getComputedStyle(el).borderTopStyle, getComputedStyle(el).cursor]);
  assert.equal((await lineColour())[0], "oklch(0.65 0.227 32.3 / 0.5)", "a quiet dashed line at rest");
  await handle.hover();
  await R.waitForTimeout(300);
  assert.deepEqual([...(await lineColour()).slice(0, 2), await handle.evaluate((el) => getComputedStyle(el).cursor)], ["oklch(0.65 0.227 32.3)", "dashed", "ns-resize"], "on hover the whole line turns full orange, with an up-down cursor");
  await R.screenshot({ path: join(out, "line-hover-desktop.png"), clip: { x: 0, y: hb.y - 50, width: clientW, height: hb.height + 100 } });
  screenshots.push(join(out, "line-hover-desktop.png"));
  await R.mouse.move(683, 500);
  // The veil: from the top of the window to the line, ending exactly there; text below is untouched.
  const veilBox = await R.locator(".read-veil").evaluate((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return [r.top, r.bottom, cs.pointerEvents, cs.zIndex, cs.backgroundImage]; });
  assert.deepEqual(veilBox.slice(0, 4), [0, 135, "none", "4"], "the veil covers the window down to the line, under the line (z 5) and the bar");
  assert.match(veilBox[4], /^linear-gradient\(oklch\(0\.16 0\.06 282 \/ 0\.86\) calc\(100% - 12px\), rgba\(0, 0, 0, 0\)\)$/, "page colour at 86%, a 12px soft edge that ends at the line");
  const veilOff = (on) => R.evaluate((v) => { document.querySelector(".read-veil").style.visibility = v ? "" : "hidden"; }, on);
  const region = (y, height) => R.screenshot({ clip: { x: 0, y, width: clientW - 50, height } });
  await R.waitForTimeout(300);
  const [aboveOn, belowOn] = [await region(0, 120), await region(138, 60)];
  await veilOff(false);
  const [aboveOff, belowOff] = [await region(0, 120), await region(138, 60)];
  await veilOff(true);
  assert.equal(aboveOn.equals(aboveOff), false, "text above the line is faded");
  assert.equal(belowOn.equals(belowOff), true, "the line being read and everything below it are untouched");
  await R.reload();
  await R.locator(".section").first().waitFor();
  assert.deepEqual(await lineOf(R), { top: 135, css: "135px", now: "15", text: "15% from the top", stored: "0.1500" }, "restored after a reload");
  await scrollToSection(R, 3);
  await R.evaluate(() => window.scrollBy(0, 300));
  await shot(R, "fade-read-text-desktop");
  ok("reading line: the whole line is the handle (a 20px slider band, no tab or tooltip, full orange on hover); a mouse drag from anywhere along it moves only the line (the script stays put), updates --line and aria-valuenow, is remembered and restored after a reload; the veil fades the text above the line and ends at it, the text below is unchanged (pixel compare)");

  // A small, deliberate mouse drag (4px) is kept, not taken for a click.
  const fb = await handle.boundingBox();
  const fine = (await lineOf(R)).top;
  await R.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await R.mouse.down();
  await R.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2 - 4);
  await R.mouse.up();
  await settle(R);
  assert.equal((await lineOf(R)).top, fine - 4, "a 4px mouse drag moves the line 4px");

  // Keyboard on the handle; the page's own keys still work elsewhere.
  await handle.dblclick();
  assert.deepEqual(await lineOf(R), { top: 306, css: "306px", now: "34", text: "34% from the top", stored: "0.3400" }, "double-click resets to 34%");
  await R.evaluate(() => window.scrollTo(0, 0));
  await settle(R);
  await handle.focus();
  const nowAfter = async (key) => { await R.keyboard.press(key); return handle.getAttribute("aria-valuenow"); };
  assert.equal(await nowAfter("ArrowDown"), "35");
  assert.equal(await nowAfter("ArrowUp"), "34");
  assert.equal(await nowAfter("ArrowUp"), "33");
  assert.deepEqual(await R.locator(".reading-line").evaluate((el) => [getComputedStyle(el).borderTopStyle, getComputedStyle(el).borderTopWidth]), ["solid", "3px"], "focused from the keyboard the line turns solid orange");
  const scrolledBefore = await R.evaluate(() => window.scrollY);
  assert.equal(await nowAfter("PageDown"), "43");
  await settle(R);
  assert.equal(await activeIs(R), "0", "Page Down on the handle moves the line, not to the next section");
  assert.equal(await R.evaluate(() => window.scrollY), scrolledBefore + 90, "the page only scrolled to keep the text in place");
  assert.equal(await nowAfter("PageUp"), "33");
  assert.equal(await nowAfter("End"), "75");
  assert.equal(await nowAfter("PageDown"), "75", "stops at 75%");
  assert.equal(await nowAfter("Home"), "8");
  assert.equal(await nowAfter("ArrowUp"), "8", "stops at 8%");
  assert.equal((await lineOf(R)).stored, "0.0800");
  // The highest line: the last line of the script can still reach it.
  await R.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await settle(R);
  const lastLine = await R.evaluate(() => [[...document.querySelectorAll("[data-k]")].at(-1).getBoundingClientRect().top, document.querySelector(".reading-line").getBoundingClientRect().top]);
  assert.ok(lastLine[0] <= lastLine[1], `the last line reaches the line at 8%: ${lastLine}`);
  await R.evaluate(() => window.scrollTo(0, 0));
  await settle(R);
  await R.evaluate(() => document.activeElement.blur());
  await R.keyboard.press("ArrowRight");
  assert.equal(await activeIs(R), "1", "away from the handle the arrow keys still jump sections");
  await R.keyboard.press("PageDown");
  assert.equal(await activeIs(R), "2", "and so does Page Down");
  // A link lying under the line still opens with a click; the line stays where it is.
  await R.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return { closed: false, location: {}, focus() {} }; }; });
  const lineNow = await lineOf(R);
  await R.evaluate((y) => { const r = document.querySelector(".links .link").getBoundingClientRect(); window.scrollBy(0, r.top + r.height / 2 - y); }, lineNow.top + 1);
  await settle(R);
  const lb = await R.locator(".links .link").first().boundingBox();
  const under = [lb.x + lb.width / 2, lb.y + lb.height / 2];
  assert.equal(await R.evaluate(([x, y]) => document.elementFromPoint(x, y).className, under), "line-handle", "the link sits under the line's band");
  await R.mouse.move(...under);
  assert.equal(await handle.evaluate((el) => getComputedStyle(el).cursor), "pointer", "over a link the line shows a pointer");
  await R.mouse.click(...under);
  await settle(R);
  assert.equal((await R.evaluate(() => window.__opened)).length, 1, "the click opened the link under the line");
  assert.deepEqual(await lineOf(R), lineNow, "and did not move or reset the line");
  await lineCtx.close();
  ok("keyboard: the focused handle moves the line 1% with ↑ ↓, 10% with Page Up/Down, to 8% and 75% with Home/End (bounds kept), without jumping sections; elsewhere ← → and Page Down still jump; double-click resets to 34%; a link under the line opens with a click and leaves the line; at 8% the last line still reaches the line");

  // With the line moved (high at 15%, low at 60%) everything that uses it follows.
  for (const frac of [0.15, 0.6]) {
    const Y = Math.round(900 * frac);
    const ctx = await browser.newContext(DESKTOP);
    await ctx.addInitScript((f) => { localStorage.setItem("prompter-line", String(f)); localStorage.setItem("prompter-voice-ok", "yes"); }, frac);
    await ctx.addInitScript(SCREEN_STUB);
    await ctx.addInitScript(SPEECH_STUB);
    const open = async (url) => {
      const pg = await ctx.newPage();
      watch(pg, `line at ${frac}`);
      await pg.goto(url);
      await pg.locator(".section").first().waitFor();
      return pg;
    };
    const sectionTop = (pg, i) => pg.evaluate((n) => document.querySelectorAll(".section")[n].getBoundingClientRect().top, i);
    const P = await open(`${base}/#demo`);
    assert.equal((await lineOf(P)).top, Y);
    await P.keyboard.press("ArrowRight");
    await P.keyboard.press("ArrowRight");
    assert.equal(await activeIs(P), "2");
    assert.ok(Math.abs((await sectionTop(P, 2)) - (Y - 2)) <= 1, `${frac}: next section lands at the line`);
    await P.keyboard.press("ArrowLeft");
    assert.equal(await activeIs(P), "1");
    assert.ok(Math.abs((await sectionTop(P, 1)) - (Y - 2)) <= 1, `${frac}: previous section lands at the line`);
    // A title 30px below the line is not yet active; just above it, it is.
    await P.evaluate(([y]) => { const el = document.querySelectorAll(".section")[3]; window.scrollTo(0, el.offsetTop - y - 30); }, [Y]);
    await settle(P);
    assert.equal(await activeIs(P), "2", `${frac}: section 3 below the line is not active yet`);
    await P.evaluate(([y]) => { const el = document.querySelectorAll(".section")[3]; window.scrollTo(0, el.offsetTop - y + 1); }, [Y]);
    await settle(P);
    assert.equal(await activeIs(P), "3", `${frac}: section 3 becomes active as its title crosses the line`);
    const y0 = await P.evaluate(() => window.scrollY);
    await P.keyboard.press(" ");
    await P.waitForTimeout(600);
    await P.keyboard.press(" ");
    assert.ok((await P.evaluate(() => window.scrollY)) > y0 + 5, `${frac}: auto-scroll runs`);
    await P.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settle(P);
    const last = await P.evaluate(() => [...document.querySelectorAll("[data-k]")].at(-1).getBoundingClientRect().top);
    assert.ok(last <= Y, `${frac}: the last line reaches the line (${last} vs ${Y})`);
    await P.close();
    // Links open at the moved line: the top link at the section start, an own-line link once passed.
    const Q = await open(inlineLink);
    await viaSettings(Q, ".screen");
    await Q.mouse.move(683, 120);
    await scrollToSection(Q, 1);
    await Q.waitForFunction(() => window.__screen.visits.at(-1) === "https://example.com/intro", null, { timeout: 2000 });
    await passMark(Q, ".section:nth-child(2) .mark", -40);
    await Q.waitForTimeout(1000);
    assert.equal(await Q.evaluate(() => window.__screen.visits.at(-1)), "https://example.com/intro", `${frac}: the marker 40px below the line has not opened yet`);
    await passMark(Q, ".section:nth-child(2) .mark");
    await Q.waitForFunction(() => window.__screen.visits.at(-1) === "https://patchstack.com", null, { timeout: 2000 });
    await Q.close();
    const X2 = await open(textLink);
    await viaSettings(X2, ".screen");
    await X2.mouse.move(683, 120);
    await X2.evaluate(([y]) => { const el = document.querySelector(".inlink"); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - y - 40); }, [Y]);
    await X2.waitForTimeout(1000);
    assert.notEqual(await X2.evaluate(() => window.__screen.visits.at(-1)), "https://developer.mozilla.org/en-US/", `${frac}: the link inside a sentence 40px below the line has not opened yet`);
    await X2.evaluate(([y]) => { const el = document.querySelector(".inlink"); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - y - 2); }, [Y]);
    await X2.waitForFunction(() => window.__screen.visits.at(-1) === "https://developer.mozilla.org/en-US/", null, { timeout: 2000 });
    await X2.close();
    // Follow my voice brings the heard line to the moved line.
    const V = await open(link);
    await viaSettings(V, ".voice");
    await V.evaluate(() => window.__speech.say("writing scripts takes"));
    await V.waitForFunction(() => document.querySelector(".cur")?.textContent === "Writing scripts takes too long.");
    await V.waitForFunction((y) => Math.abs(document.querySelector(".cur").getBoundingClientRect().top - y) < 12, Y);
    await V.close();
    await ctx.close();
  }
  ok("with the line moved to 15% and to 60%: next/previous section land their title at it, the active section changes as a title crosses it, auto-scroll runs, the last line reaches it, a top link, an own-line link and a link inside a sentence open there (not before), and Follow my voice brings the heard line to it");

  // ---- Mobile ----
  const mobile = await browser.newContext(MOBILE);
  await mobile.addInitScript(SPEECH_STUB);
  const m = await mobile.newPage();
  watch(m, "mobile");
  await m.goto(`${base}/`);
  await showsStart(m);
  await noOverflow(m, "mobile start screen");
  const mCard = await m.locator(".empty .card").boundingBox();
  assert.ok(mCard.x >= 8 && mCard.x + mCard.width <= 382, `card fits: ${JSON.stringify(mCard)}`);
  await shot(m, "start-mobile");
  // The start screen's Wait for MCP: the same action; the agent's show_script then opens the script.
  await clip(m);
  const mStart = m.locator(".empty .mcp-action");
  assert.equal(await mStart.textContent(), "Wait for MCP");
  await mStart.click();
  if (mode === "wrangler") {
    await m.waitForFunction(() => window.__copied.length === 1);
    assert.deepEqual([await mStart.textContent(), await mStart.locator(".i-check").isVisible(), await mStart.locator(".i-copy").isVisible()], ["Copied", true, false], "the start screen's Wait for MCP confirms in place, with a check");
    assert.equal(await m.locator(".status").textContent(), "", "no status line: the button alone confirms");
    await m.waitForFunction(() => !document.querySelector(".empty .mcp-action[data-copied]"), null, { timeout: 3000 });
    assert.deepEqual([await mStart.textContent(), await state(m, ".empty .mcp-action")], ["Waiting for MCP", "waiting"]);
    await noOverflow(m, "mobile start screen waiting");
    await shot(m, "mcp-start-waiting-mobile");
    const mToken = (await m.evaluate(() => window.__copied[0])).match(/Bearer (tp1-[\w-]+)/)[1];
    assert.equal((await agentRpc(mToken, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "my-helper-mcp-client", version: "1" } })).status, 200);
    await m.waitForFunction(() => document.querySelector(".open-btn").getAttribute("aria-label") === "Open · MCP connected to My Helper");
    assert.equal(await m.locator(".empty .mcp-action").textContent(), "Disconnect MCP", "the start screen shows only Disconnect MCP, no agent row");
    assert.equal((await agentCall(mToken, "show_script", { markdown: EXAMPLE_SCRIPT })).isError, undefined);
    await m.locator(".section").first().waitFor();
    assert.equal(await m.locator(".section").count(), 5, "the agent's script opens from the start screen");
    await (await dock(m, ".open-btn")).click();
    const mPop = await popAbove(m, "#open-menu", ".open-btn", "mobile Open with an agent");
    assert.ok(mPop.x >= 4 && mPop.x + mPop.width <= 386, "the Open menu with an agent fits a phone");
    assert.equal(await m.locator(".agent-row").count(), 0, "no agent row");
    assert.ok(Math.round((await m.locator("#open-menu .mcp-action").boundingBox()).height) >= 44, "Disconnect MCP is a 44px target");
    await noOverflow(m, "mobile Open menu with an agent");
    await shot(m, "mcp-popover-mobile");
    await m.locator("#open-menu .mcp-action").click();
    assert.deepEqual([await m.locator("#open-menu .mcp-action").textContent(), await m.locator(".open-btn").getAttribute("data-dot")], ["Wait for MCP", null], "Disconnect MCP disconnects");
    await m.keyboard.press("Escape");
    await m.goto(`${base}/`);
    await showsStart(m);
    ok("phone: the start screen's Wait for MCP copies with Copied and a check, then Waiting for MCP; an agent (my-helper-mcp-client → My Helper) opens its script from the start screen; the Open menu with an agent shows only Disconnect MCP (a 44px target), fits 390px and disconnects");
  }
  // Without a clipboard the message shows, selected, under the button.
  await clip(m, true);
  await mStart.click();
  if (mode === "wrangler") {
    const mBox = m.locator(".empty .mcp-prompt");
    await mBox.waitFor();
    await noOverflow(m, "mobile manual copy");
    const copyBox = await mBox.boundingBox();
    assert.ok(copyBox.x >= 0 && copyBox.x + copyBox.width <= 390, "the message box fits");
    assert.equal(await mBox.evaluate((el) => document.activeElement === el && el.selectionEnd === el.value.length), true);
    await shot(m, "mcp-manual-mobile");
    await m.evaluate(() => localStorage.removeItem("prompter-agent"));
    await m.reload();
    await showsStart(m);
  }
  await m.locator('.empty [data-action="demo"]').click();
  await m.locator(".section").first().waitFor();
  await noOverflow(m, "mobile demo");
  const mobileDock = await m.locator(".dock").boundingBox();
  assert.ok(mobileDock.x >= 0 && mobileDock.x + mobileDock.width <= 390, `control bar ${Math.round(mobileDock.width)}px fits`);
  assert.ok(Math.abs(mobileDock.x + mobileDock.width / 2 - 195) < 2, "control bar centred");
  const tops = await m.locator(".dock > button:not([hidden])").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  assert.equal(tops.length, 6, "six buttons: Open, previous, play, next, clock, Settings (voice and main screen are in Settings)");
  assert.equal(new Set(tops).size, 1, `control bar is one row: ${tops}`);
  assert.ok(await m.locator(".dock > button:not([hidden])").evaluateAll((els) => els.every((el) => el.getBoundingClientRect().height >= 44 && el.getBoundingClientRect().width >= 44)), "44px touch targets");
  await shot(m, "demo-mobile");
  await (await dock(m, ".open-btn")).click();
  await popAbove(m, "#open-menu", ".open-btn", "mobile Open");
  await noOverflow(m, "mobile Open popover");
  await shot(m, "open-popover-mobile");
  await m.keyboard.press("Escape");
  await m.goto(link);
  await m.locator(".section").first().waitFor();
  await noOverflow(m, "mobile prompter");
  await scrollToSection(m, 2);
  await m.waitForTimeout(250);
  await shot(m, "ql-section-mobile");
  await (await dock(m, ".settings-btn")).click();
  await popAbove(m, "#settings", ".settings-btn", "mobile Settings");
  await noOverflow(m, "mobile Settings popover");
  await m.locator('#settings .seg label:has-text("Narrow")').click();
  assert.deepEqual(await bigButtons(m), [["Follow my voice", ""], ["Connect main screen", ""], ["CamFrame link: off", ""], ["OBS link: off", ""]]);
  for (const sel of ["#settings .voice", "#settings .screen", "#settings .camframe", "#settings .obs", "#settings .size", "#settings .speed", "#settings .line-height", "#settings .para-space", "#settings .width label", "#settings .layout label"]) {
    for (const loc of await m.locator(sel).all()) {
      const box = await loc.boundingBox();
      assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, `${sel} fits a phone as a 44px target: ${JSON.stringify(box)}`);
    }
  }
  assert.ok(await m.evaluate(() => {
    const note = document.querySelector(".cut-note");
    note.hidden = false;
    const height = note.querySelector(".btn").getBoundingClientRect().height;
    note.hidden = true;
    return height >= 44;
  }), "the cut-off note's Open a new main screen is a 44px target on a phone");
  assert.deepEqual(await settingsSliderHits(m), [["size", false], ["value", true]], "mobile Settings: the name presses the slider, the value takes typing");
  await m.locator("#settings .size-field .range-value").tap();
  assert.equal(await m.evaluate(() => document.activeElement.classList.contains("size-val")), true, "a tap on the value opens it for typing");
  await m.locator('#settings .seg label:has-text("Narrow")').click();
  await shot(m, "settings-popover-mobile");
  await closeUp(m, "#settings", "settings-close-up-mobile");
  await m.mouse.click(195, 120);
  assert.equal(await m.locator("#settings:popover-open").count(), 0, "tapping the page closes Settings");
  // A phone on its side: Settings stays inside the window and scrolls to its last row.
  await m.setViewportSize({ width: 844, height: 390 });
  await (await dock(m, ".settings-btn")).click();
  await m.locator("#settings:popover-open").waitFor();
  const sideBox = await m.locator("#settings").boundingBox();
  assert.ok(sideBox.y >= 0, `landscape phone: Settings top ${Math.round(sideBox.y)} is inside the window`);
  const dockTop = (await m.locator(".dock").boundingBox()).y;
  assert.ok(sideBox.y + sideBox.height <= dockTop, `landscape phone: Settings bottom ${Math.round(sideBox.y + sideBox.height)} is above the bar ${Math.round(dockTop)}`);
  assert.ok(await m.locator("#settings").evaluate((el) => el.scrollHeight > el.clientHeight), "landscape phone: Settings scrolls");
  assert.equal(await m.locator("#settings").evaluate((el) => getComputedStyle(el).overscrollBehaviorY), "contain", "landscape phone: scrolling past the end of Settings does not move the page behind it");
  await m.locator("#settings").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const [tg, st] = [await m.locator("#settings .big-toggles").boundingBox(), await m.locator("#settings").boundingBox()];
  assert.ok(tg.y >= st.y && tg.y + tg.height <= st.y + st.height, "landscape phone: the last row can be scrolled into view");
  await m.locator('#settings .layout label:has-text("Paragraphs")').click();
  assert.equal(await m.evaluate(() => document.documentElement.dataset.layout), "paragraphs", "landscape phone: the layout choices can be reached");
  await m.locator('#settings .layout label:has-text("Lines")').click();
  await m.keyboard.press("Escape");
  await m.setViewportSize({ width: 390, height: 844 });
  await viaSettings(m, ".voice");
  await m.locator(".voice-notice:not([hidden])").waitFor();
  await noOverflow(m, "mobile voice notice");
  await shot(m, "voice-notice-mobile");
  await m.locator('[data-action="voice-cancel"]').click();
  await m.goto(inlineLink);
  await m.reload(); // only the #s= part changed: load the page again so the hint is fresh
  await m.locator(".section").first().waitFor();
  await m.evaluate(() => {
    const el = document.querySelector(".section:nth-child(2) .mark");
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.34 + 60);
  });
  await m.locator(".screen-hint:not([hidden])").waitFor({ timeout: 2000 });
  await noOverflow(m, "mobile inline link and hint");
  const hintBox = await m.locator(".screen-hint").boundingBox();
  assert.ok(hintBox.y > 844 * 0.34 + 40, `mobile hint at ${Math.round(hintBox.y)}px stays clear of the reading line`);
  assert.ok(hintBox.y + hintBox.height <= (await m.locator(".dock").boundingBox()).y, "mobile hint fits above the control bar");
  await shot(m, "inline-link-mobile");
  await m.locator('.screen-hint [data-action="hint-ok"]').click();
  await m.addInitScript(SCREEN_STUB);
  await m.goto(textLink);
  await m.reload();
  await m.locator(".section").first().waitFor();
  // The section start has settled (no main screen yet: the hint), so nothing replaces the tapped link.
  await m.locator(".screen-hint:not([hidden])").waitFor({ timeout: 2000 });
  await m.locator('.screen-hint [data-action="hint-ok"]').click();
  await noOverflow(m, "mobile link row");
  const mRow = await m.locator(".section").first().locator(".links .link").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  assert.ok(mRow.every((h) => h >= 24), `top row links are at least 24px tall: ${mRow}`);
  await shot(m, "link-row-mobile");
  await m.locator(".inlink").first().tap();
  assert.equal(await m.locator(".inlink").first().getAttribute("data-shown"), "true", "a tap shows it on the main screen");
  assert.equal(await m.evaluate(() => window.__screen.visits.at(-1)), "https://developer.mozilla.org/en-US/");
  await m.evaluate(() => {
    const el = document.querySelector(".inlink");
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.34 - 40);
  });
  await m.waitForTimeout(1000);
  assert.equal(await m.locator(".inlink").first().getAttribute("data-shown"), "true", "still on the main screen after settling");
  await noOverflow(m, "mobile link inside a sentence");
  await shot(m, "text-link-shown-mobile");
  ok("mobile 390px: start screen card and its manual-copy box fit; the demo; a one-row centred control bar of six buttons with 44px targets; Open and Settings popovers above their buttons and on screen (tap outside closes); no sideways scroll; voice notice and hint fit", `bar ${Math.round(mobileDock.width)}px`);
  await mobile.close();

  // A finger drags the reading line on a phone (real touch events); the page does not scroll under it.
  const touchCtx = await browser.newContext(MOBILE);
  await touchCtx.addInitScript(NO_SPEECH);
  const TL = await touchCtx.newPage();
  watch(TL, "reading line touch");
  await TL.goto(`${base}/#demo`);
  await TL.locator(".section").first().waitFor();
  await TL.evaluate(() => window.scrollTo(0, 1600));
  await settle(TL);
  assert.equal((await lineOf(TL)).top, 287, "34% of 844px");
  const th = await TL.locator(".line-handle").boundingBox();
  assert.ok(th.x <= 0 && th.width >= 390 && th.height === 32, `a 32px band along the whole line for fingers: ${JSON.stringify(th)}`);
  await TL.evaluate(() => { window.__pointers = []; document.querySelector(".line-handle").addEventListener("pointerdown", (e) => window.__pointers.push(e.pointerType)); });
  const mText = () => TL.evaluate(() => [window.scrollY, document.querySelectorAll(".section p")[12].getBoundingClientRect().top]);
  const [, textAt] = await mText();
  const cdp = await touchCtx.newCDPSession(TL);
  const tx = th.x + th.width / 2;
  const ty = th.y + th.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tx, y: ty }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: tx, y: ty - i * 20 }] });
    await settle(TL);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settle(TL);
  assert.deepEqual(await TL.evaluate(() => window.__pointers), ["touch"], "a touch pointer");
  const moved = await lineOf(TL);
  assert.equal(moved.top, 127, "the line followed the finger 160px up");
  assert.equal(moved.now, "15");
  assert.equal((await mText())[1], textAt, "the script stayed where it was: the finger did not scroll the page");
  await noOverflow(TL, "mobile reading line");
  await TL.waitForTimeout(300);
  await shot(TL, "line-moved-mobile");
  await TL.evaluate(() => window.scrollBy(0, 500));
  await shot(TL, "fade-read-text-mobile");
  // A new window height keeps the line at the same share of it (and remembered).
  await TL.setViewportSize({ width: 390, height: 700 });
  await settle(TL);
  const resized = await lineOf(TL);
  assert.deepEqual([resized.top, resized.css, resized.now, resized.stored], [Math.round(700 * moved.stored), `${Math.round(700 * moved.stored)}px`, "15", moved.stored], "after a resize the line keeps its share of the window");
  await TL.setViewportSize({ width: 390, height: 844 });
  await settle(TL);
  // Two quick taps on the tab put the line back at 34%.
  const th2 = await TL.locator(".line-handle").boundingBox();
  for (let i = 0; i < 2; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: th2.x + th2.width / 2, y: th2.y + th2.height / 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  await settle(TL);
  const tapped = await lineOf(TL);
  assert.deepEqual([tapped.top, tapped.stored], [Math.round(844 * 0.34), "0.3400"], "a double tap resets the line to 34%");
  // A single tap, and a drag then a quick tap, keep the line; two taps that drift a few px still reset it.
  const touch = async (points) => {
    for (const [i, [x, y]] of points.entries()) await cdp.send("Input.dispatchTouchEvent", { type: i ? "touchMove" : "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const th3 = await TL.locator(".line-handle").boundingBox();
  const hx = th3.x + th3.width / 2;
  const hy = th3.y + th3.height / 2;
  await touch([[hx, hy], [hx, hy - 60]]);
  await settle(TL);
  const dragged = (await lineOf(TL)).stored;
  assert.notEqual(dragged, "0.3400", "dragged up");
  const hy2 = (await TL.locator(".line-handle").boundingBox()).y + th3.height / 2;
  await touch([[hx, hy2]]);
  await settle(TL);
  assert.equal((await lineOf(TL)).stored, dragged, "a drag then a quick tap does not reset");
  await TL.waitForTimeout(450);
  const beforeTap = await lineOf(TL);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: hx, y: hy2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: hx, y: hy2 + 7 }] });
  await TL.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(await lineOf(TL), beforeTap, "a finger drifting 7px does not nudge the line while it is down");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settle(TL);
  assert.deepEqual(await lineOf(TL), beforeTap, "a single tap (7px drift) keeps the line, on screen too");
  await TL.waitForTimeout(450);
  await touch([[hx, hy2], [hx, hy2 + 2]]);
  await touch([[hx, hy2 - 2], [hx, hy2]]);
  await settle(TL);
  assert.equal((await lineOf(TL)).stored, "0.3400", "two taps that drift 2px still reset");
  // The address bar hiding changes innerHeight but not the page's own height: nothing moves.
  const barBefore = await TL.evaluate(() => [window.scrollY, getComputedStyle(document.documentElement).getPropertyValue("--line")]);
  await TL.evaluate(() => { Object.defineProperty(window, "innerHeight", { value: window.innerHeight + 56, configurable: true }); window.dispatchEvent(new Event("resize")); });
  await settle(TL);
  assert.deepEqual(await TL.evaluate(() => [window.scrollY, getComputedStyle(document.documentElement).getPropertyValue("--line")]), barBefore, "an address-bar height change moves neither the line nor the script");
  await touchCtx.close();
  ok("phone: a finger drags the reading line (touch pointer, a 32px band along it) to 15%; the script does not move under it and nothing scrolls sideways; a resize keeps its share of the window; a single tap keeps it, a double tap (also with drift) resets it to 34%; an address-bar height change moves nothing");

  // ---- CamFrame link: camera cues reach CamFrame on this computer, once per pass ----
  const cam = fakeCamFrame();
  await cam.start();
  const camCtx = await browser.newContext(DESKTOP);
  const C = await camCtx.newPage();
  C.on("pageerror", (e) => errors.push(`camframe pageerror: ${e.message}`));
  C.on("console", (m) => {
    // Turned off or closed, CamFrame refuses the connection: expected while it is "not found".
    // A refused cue is a 404 answer, logged by the browser as a failed resource.
    const refusedCue = /status of 404/.test(m.text()) && m.location()?.url?.startsWith("http://127.0.0.1:47833/camframe/cue");
    if (m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text()) && !refusedCue) errors.push(`camframe console: ${m.text()}`);
  });
  await C.goto(await makeLink(CUE_SCRIPT, "lex", base));
  await C.locator(".section").first().waitFor();
  assert.equal(await C.locator("[data-cue]").count(), 4, "each cue line is marked");
  assert.deepEqual(await C.locator("[data-cue]").allTextContents(), ["Camera: face small · Share screen.", "Camera: face small, bottom right", "Camera: face full · Stop share.", "Camera: Scene “Demo”"], "cue lines say what the camera does, then their other words");
  assert.equal(await C.locator("[data-cue] svg.cue-icon").count(), 4, "each with a camera mark");
  const passCue = (n, dy = 0) => passCueOn(C, n, dy);
  const toastShown = () => C.locator(".toast").evaluate((el) => el.dataset.show === "true");
  await passCue(0, -200);
  await C.mouse.wheel(0, 1);
  await C.waitForTimeout(200);
  await shot(C, "camframe-cue-lines-desktop");
  const cueLook = await C.locator('[data-cue="0"]').evaluate((el) => {
    const what = getComputedStyle(el.querySelector(".cue-what"));
    const rest = getComputedStyle(el.querySelector(".cue-rest"));
    return { what: what.color, weight: what.fontWeight, rest: rest.color, size: parseFloat(getComputedStyle(el).fontSize) / parseFloat(getComputedStyle(el.closest(".script")).fontSize) };
  });
  assert.equal(cueLook.what, "oklch(0.763 0.027 282)", "the camera words are small and dimmed like a reminder (TOOLS-486)");
  assert.equal(cueLook.weight, "700", "and bold, so they still read as an instruction");
  assert.equal(cueLook.rest, "oklch(0.763 0.027 282)", "the line's other words stay muted");
  assert.ok(cueLook.size > 0.5, "a little larger than an ordinary reminder (half the text size)");
  await passCue(0);
  await C.waitForTimeout(700);
  assert.deepEqual(cam.seen, [], "off by default: nothing is sent, not even a status check");
  assert.equal(await C.evaluate(() => localStorage.getItem("prompter-camframe")), null);
  await C.evaluate(() => window.scrollTo(0, 0));
  await (await dock(C, ".settings-btn")).click();
  await C.locator("#settings:popover-open").waitFor();
  // CamFrame's button sits with Follow my voice and the main screen, built like them; its name and
  // hover title say how the link is doing (no status text on screen).
  const camBtn = C.locator("#settings .big-toggle.camframe");
  const camLook = () => camBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    const icon = [...el.querySelectorAll("svg")].find((svg) => getComputedStyle(svg).display !== "none");
    return { state: el.dataset.state, pressed: el.getAttribute("aria-pressed"), label: el.getAttribute("aria-label"), title: el.title, color: cs.color,
      icon: icon.getAttribute("class"), fill: [...new Set([...icon.querySelectorAll("rect, path")].map((part) => getComputedStyle(part).fill))].join(" "), animation: getComputedStyle(icon).animationName,
      glow: cs.boxShadow !== "none" && !cs.boxShadow.includes("inset 0px 0px 0px 1.5px") , ring: cs.boxShadow.includes("1.5px"), outline: cs.outlineStyle };
  });
  const camOff = await camLook();
  assert.deepEqual([camOff.state, camOff.pressed, camOff.label, camOff.title, camOff.color, camOff.icon, camOff.fill, camOff.animation],
    ["off", "false", "CamFrame link: off", "CamFrame link: off", "oklch(0.763 0.027 282)", "i-cam", "none", "none"], "off: a quiet outline camera, like the other off buttons");
  const [camBox, screenBtnBox] = await Promise.all([camBtn.boundingBox(), C.locator("#settings .screen").boundingBox()]);
  assert.ok(Math.abs(camBox.height - screenBtnBox.height) < 1 && Math.abs(camBox.width - screenBtnBox.width) < 1 && Math.abs(camBox.y - screenBtnBox.y) < 1, "the same size and row as the main screen's button");
  // Turned on from the keyboard (Enter), as a button: blinking orange while it looks for CamFrame.
  let holdFirst = true;
  cam.answer = (path) => (path === "/camframe/status" && holdFirst ? { delay: 1500 } : null);
  await camBtn.focus();
  await C.keyboard.press("Enter");
  await C.waitForTimeout(250); // the colour fade
  const camLooking = await camLook();
  assert.deepEqual([camLooking.state, camLooking.pressed, camLooking.label, camLooking.color, camLooking.icon, camLooking.fill, camLooking.animation],
    ["looking", "true", "CamFrame link: looking for CamFrame", "oklch(0.7 0.19 32.3)", "i-cam", "none", "blink"], "looking: an orange outline camera that blinks");
  await C.emulateMedia({ reducedMotion: "reduce" });
  const camLookingStill = await camLook();
  assert.deepEqual([camLookingStill.animation, camLookingStill.outline], ["none", "solid"], "reduced motion: no blinking (focused, so the focus ring shows)");
  await C.evaluate(() => document.activeElement.blur());
  assert.equal((await camLook()).outline, "dashed", "reduced motion: a dashed orange ring instead of blinking");
  await shot(C, "camframe-looking-reduced-motion-desktop");
  await C.emulateMedia({ reducedMotion: "no-preference" });
  holdFirst = false;
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  await C.waitForTimeout(250);
  const camOn = await camLook();
  assert.deepEqual([camOn.pressed, camOn.label, camOn.title, camOn.color, camOn.icon, camOn.fill, camOn.animation, camOn.glow],
    ["true", "CamFrame link: connected", "CamFrame link: connected", "oklch(0.7 0.19 32.3)", "i-cam", "oklch(0.7 0.19 32.3)", "none", true], "connected: a filled orange camera with a steady glow, no blinking");
  assert.equal(await C.locator(".status").textContent(), "CamFrame link: connected.", "connected is read out once");
  assert.equal(await C.locator(".settings-btn").getAttribute("aria-label"), "Settings · CamFrame connected");
  await shot(C, "camframe-on-desktop");
  // A check with the same answer does not say it again.
  await C.evaluate(() => {
    window.__camframeSaid = 0;
    new MutationObserver(() => { if (/CamFrame/.test(document.querySelector(".status").textContent)) window.__camframeSaid++; })
      .observe(document.querySelector(".status"), { childList: true, characterData: true, subtree: true });
  });
  const statusChecks = () => cam.seen.filter((r) => r.path === "/camframe/status").length;
  for (let i = 0; i < 2; i++) {
    const checksBefore = statusChecks();
    await C.keyboard.press("Escape");
    await (await dock(C, ".settings-btn")).click();
    await C.locator("#settings:popover-open").waitFor();
    for (let t = 0; t < 40 && statusChecks() === checksBefore; t++) await C.waitForTimeout(50);
    assert.ok(statusChecks() > checksBefore, "reopening Settings checks CamFrame again");
  }
  await C.waitForTimeout(200);
  assert.equal(await C.evaluate(() => window.__camframeSaid), 0, "the same state is not read out again on every check");
  assert.equal(await C.evaluate(() => localStorage.getItem("prompter-camframe")), "on", "remembered on this device");
  // Space turns it off again (the same setting), and a click on again.
  await camBtn.focus();
  await C.keyboard.press(" ");
  assert.deepEqual([(await camLook()).state, (await camLook()).pressed], ["off", "false"]);
  assert.equal(await C.evaluate(() => localStorage.getItem("prompter-camframe")), null, "off is remembered too");
  // An older check answering late is dropped: on, off and on again while CamFrame stops answering.
  let slowFirst = true;
  cam.answer = (path) => {
    if (path !== "/camframe/status") return null;
    if (slowFirst) { slowFirst = false; return { delay: 1200 }; }
    return { broken: true };
  };
  await camBtn.click();
  await camBtn.click();
  await camBtn.click();
  await C.waitForTimeout(1500);
  assert.equal(await camBtn.getAttribute("data-state"), "looking", "the older, slower answer is dropped; a first look that misses keeps looking");
  cam.answer = null;
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on", null, { timeout: 4000 });
  // One missed check (Edge's calls to this computer fail now and then) is not "not found": it says
  // reconnecting (blinking orange), checks again a second later and is connected again.
  let dropChecks = 1;
  await C.evaluate(() => { window.__camframeSaid = 0; });
  cam.answer = (path) => (path === "/camframe/status" && dropChecks-- > 0 ? { broken: true } : null);
  await C.keyboard.press("Escape");
  await (await dock(C, ".settings-btn")).click();
  await C.locator("#settings:popover-open").waitFor();
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state !== "on", null, { timeout: 5000 });
  const camReconnecting = await camLook();
  assert.deepEqual([camReconnecting.state, camReconnecting.label, camReconnecting.animation, camReconnecting.fill], ["reconnecting", "CamFrame link: reconnecting", "blink", "none"], "one miss: reconnecting, blinking orange, not lost");
  await shot(C, "camframe-reconnecting-desktop");
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on", null, { timeout: 4000 });
  await C.waitForTimeout(100);
  assert.equal(await C.evaluate(() => window.__camframeSaid), 0, "back from reconnecting: connected is not read out again");
  cam.answer = null;
  await C.keyboard.press("Escape");
  // Down past the first cue: sent once, after a short settle.
  await C.evaluate(() => { document.querySelector(".status").textContent = ""; });
  await passCue(0);
  await C.waitForTimeout(700);
  assert.deepEqual(cam.cues(), [{ size: "small" }]);
  // No note pops up when the camera switches: CamFrame moving is the sign it worked.
  assert.equal(await toastShown(), false, "no note when the camera switches");
  assert.doesNotMatch(await C.locator(".status").textContent(), /CamFrame/, "and nothing read out");
  await passCue(0, 40);
  await C.waitForTimeout(500);
  assert.deepEqual(cam.cues(), [{ size: "small" }], "reading on past it sends nothing again");
  // Back above it, then down again: the next pass sends it once more.
  await passCue(0, -120);
  await C.waitForTimeout(500);
  assert.deepEqual(cam.cues(), [{ size: "small" }], "scrolling back up sends nothing");
  await passCue(0);
  await C.waitForTimeout(700);
  assert.deepEqual(cam.cues(), [{ size: "small" }, { size: "small" }]);
  // Next section (→): past two cues at once, only the last one goes.
  await C.keyboard.press("ArrowRight");
  await C.waitForTimeout(700);
  assert.deepEqual(cam.cues().slice(2), [{ size: "full" }], "a section jump past several cues sends only the last");
  await passCue(3);
  await C.waitForTimeout(700);
  assert.deepEqual(cam.cues().slice(3), [{ size: "small", scene: "Demo" }]);
  // CamFrame refuses a cue: the link stays on (CamFrame answered), scrolling goes on.
  cam.answer = (path, body) => (body?.scene === "Demo" ? { status: 404, body: { ok: false, error: 'CamFrame has no Scene named "Demo".' } } : null);
  await passCue(3, -120);
  await C.waitForTimeout(500);
  await passCue(3);
  for (let t = 0; t < 40 && cam.cues().length < 5; t++) await C.waitForTimeout(50);
  await C.waitForTimeout(200);
  assert.deepEqual(cam.cues().slice(4), [{ size: "small", scene: "Demo" }]);
  assert.equal(await toastShown(), false, "no note for a refused cue either");
  assert.equal(await C.locator(".camframe").getAttribute("data-state"), "on", "a refused cue keeps the link on");
  // A cue that does not get through is sent once more, and then CamFrame switches.
  let dropCues = 1;
  cam.answer = (path) => (path === "/camframe/cue" && dropCues-- > 0 ? { broken: true } : null);
  await passCue(3, -120);
  await C.waitForTimeout(500);
  const sentBeforeRetry = cam.cues().length;
  await passCue(3);
  for (let t = 0; t < 80 && cam.cues().length < sentBeforeRetry + 2; t++) await C.waitForTimeout(50);
  assert.deepEqual(cam.cues().slice(sentBeforeRetry), [{ size: "small", scene: "Demo" }, { size: "small", scene: "Demo" }], "the cue went twice: not through once, then through");
  assert.equal(await C.locator(".camframe").getAttribute("data-state"), "on", "a cue that got through on its second try keeps the link on");
  // A cue that does not get through twice while connected: the link says reconnecting, and the
  // next check a second later finds CamFrame again.
  cam.answer = (path) => (path === "/camframe/cue" ? { broken: true } : null);
  await passCue(3, -120);
  await C.waitForTimeout(500);
  await passCue(3);
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state === "reconnecting", null, { timeout: 4000 });
  cam.answer = null;
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on", null, { timeout: 4000 });
  // A cue still on its way when the link is turned off and on again changes nothing for the new one.
  cam.answer = (path) => (path === "/camframe/cue" ? { delay: 2000 } : null);
  await passCue(3, -120);
  await C.waitForTimeout(500);
  const sentBeforeToggle = cam.cues().length;
  await passCue(3);
  for (let t = 0; t < 40 && cam.cues().length === sentBeforeToggle; t++) await C.waitForTimeout(50);
  assert.ok(cam.cues().length > sentBeforeToggle, "the cue is on its way before the switch");
  await (await dock(C, ".settings-btn")).click();
  await C.locator("#settings:popover-open").waitFor();
  await C.locator("#settings .camframe").click();
  await C.locator("#settings .camframe").click();
  await C.keyboard.press("Escape");
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  await C.waitForTimeout(2500);
  assert.equal(await C.locator(".camframe").getAttribute("data-state"), "on", "the old cue's answer changes nothing");
  cam.answer = null;
  assert.ok(cam.seen.every((r) => r.origin === new URL(base).origin), "the page's own origin, nothing else");
  assert.ok(cam.seen.every((r) => !r.body || Object.keys(r.body).every((k) => ["size", "position", "scene"].includes(k))), "only the cue is sent, never script text");
  // Auto-scroll reaches a cue too.
  await passCue(1, -60);
  await C.waitForTimeout(400);
  const sentBefore = cam.cues().length;
  await C.evaluate(() => { window.scrollBy(0, 30); });
  await C.locator(".dock .auto").evaluate((b) => b.click());
  await C.waitForTimeout(3500);
  await C.locator(".dock .auto").evaluate((b) => b.click());
  assert.deepEqual(cam.cues().slice(sentBefore), [{ size: "small", position: "bottom-right" }], "auto-scroll sends the cue it passes, and nothing else");
  // A reload with the link remembered on connects by itself and sends nothing for cues already above.
  await passCue(1, 40);
  await C.waitForTimeout(700);
  const sentBeforeReload = cam.cues().length;
  const yBeforeReload = await C.evaluate(() => window.scrollY);
  const statusBeforeReload = cam.seen.filter((r) => r.path === "/camframe/status").length;
  await C.reload();
  await C.locator(".section").first().waitFor();
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  assert.ok(cam.seen.filter((r) => r.path === "/camframe/status").length > statusBeforeReload, "the reloaded page checks CamFrame without the box being touched");
  assert.equal(await C.locator("#settings .camframe").getAttribute("aria-pressed"), "true");
  // The browser may put the page back where it was (not every server's page gets that), a little
  // after it is drawn. Either way opening the page sends nothing; when it is back past cues 0 and 1,
  // they stay unsent.
  const cueAboveLine = () => document.querySelector('[data-cue="0"]').getBoundingClientRect().top < document.querySelector(".reading-line").getBoundingClientRect().top;
  const restored = await C.waitForFunction(cueAboveLine, null, { timeout: 3000 }).then(() => true, () => false);
  await C.waitForTimeout(900);
  assert.equal(cam.cues().length, sentBeforeReload, restored ? "no cue for cues already above the line after a reload" : "opening the page again sends no cue");
  const reloadNote = restored ? "the reload came back past two cues and sent neither" : "this server's reload opened at the top (no scroll restore) and sent nothing";
  // A restore after the page's first look, with no input from the person, sends nothing either.
  await C.evaluate(() => window.scrollTo(0, 0));
  await C.waitForTimeout(300);
  await C.evaluate((y) => window.scrollTo(0, y), yBeforeReload);
  await C.waitForTimeout(700);
  assert.equal(cam.cues().length, sentBeforeReload, "a late scroll restore (no input) sends nothing");
  // Follow my voice moving past a cue line sends it once.
  const voiceCtx = await browser.newContext(DESKTOP);
  await voiceCtx.addInitScript(() => { localStorage.setItem("prompter-camframe", "on"); localStorage.setItem("prompter-voice-ok", "yes"); });
  await voiceCtx.addInitScript(SPEECH_STUB);
  const V = await voiceCtx.newPage();
  watch(V, "camframe voice");
  await V.goto(await makeLink(VOICE_CUE_SCRIPT, "lex", base));
  await V.locator(".section").first().waitFor();
  await V.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  const sentBeforeVoice = cam.cues().length;
  await viaSettings(V, ".voice");
  await V.waitForFunction(() => window.__speech.started === 1);
  const voiceTo = async (words, line) => {
    await V.evaluate((w) => window.__speech.say(w), words);
    await V.waitForFunction((l) => document.querySelector(".cur")?.textContent === l, line);
  };
  await voiceTo("welcome to the camera cue test", "Purple elephants dance quietly tonight.");
  await voiceTo("purple elephants dance quietly tonight", "Seven orange kites drift over hills.");
  await V.waitForTimeout(700);
  assert.deepEqual(cam.cues().slice(sentBeforeVoice), [], "the cue below the line is not sent yet");
  await voiceTo("seven orange kites drift over hills", "Copper trains whistle beyond rivers.");
  await V.waitForTimeout(900);
  await voiceTo("copper trains whistle beyond rivers", "Silver foxes nap beside lanterns.");
  await V.waitForTimeout(900);
  assert.deepEqual(cam.cues().slice(sentBeforeVoice), [{ size: "small", position: "bottom-right" }], "Follow my voice sends the cue it passes, once");
  // Changing the line height, paragraph spacing or layout with the reading line on a cue line sends no cue (nothing crossed the line).
  await V.evaluate(() => {
    const el = document.querySelector("[data-cue]");
    window.scrollBy(0, el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 - document.querySelector(".reading-line").getBoundingClientRect().top);
  });
  await V.mouse.wheel(0, 1);
  await V.waitForTimeout(500);
  const sentBeforeSpacing = cam.cues().length;
  const cueUnder = () => V.evaluate(() => {
    const y = document.querySelector(".reading-line").getBoundingClientRect().top;
    const r = document.querySelector("[data-cue]").getBoundingClientRect();
    return r.top <= y + 4 && r.bottom > y - 4;
  });
  for (const [what, value] of [["line-height", 200], ["para-space", 50], ["layout", "paragraphs"], ["line-height", 165], ["para-space", 200], ["layout", "lines"]]) {
    await spaceTo(V, what, value);
    await V.waitForTimeout(900);
    assert.equal(cam.cues().length, sentBeforeSpacing, `a change (${what} ${value}) sends no CamFrame cue`);
    assert.equal(await cueUnder(), true, `voice on, cue line: still at the reading line (${what} ${value})`);
  }
  await voiceCtx.close();
  // CamFrame gone: the button says so (a quiet crossed-out camera), with the permission help in its title.
  await C.evaluate(() => {
    const row = document.querySelector(".camframe");
    window.__camStates = [];
    new MutationObserver(() => { if (window.__camStates.at(-1) !== row.dataset.state) window.__camStates.push(row.dataset.state); })
      .observe(row, { attributes: true, attributeFilter: ["data-state"] });
  });
  await cam.stop();
  await (await dock(C, ".settings-btn")).click();
  await C.locator("#settings:popover-open").waitFor();
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state === "lost", null, { timeout: 15_000 });
  assert.deepEqual(await C.evaluate(() => window.__camStates), ["reconnecting", "lost"], "reconnecting first; not found only after several missed checks in a row");
  await C.waitForTimeout(250);
  const camLost = await camLook();
  assert.deepEqual([camLost.pressed, camLost.label, camLost.color, camLost.icon, camLost.fill, camLost.animation, camLost.ring], ["true", "CamFrame link: not found", "oklch(0.763 0.027 282)", "i-cam-off", "none", "none", true], "not found: a quiet crossed-out camera with a thin orange ring, no blinking");
  assert.equal(camLost.title, "CamFrame link: not found. Open CamFrame and turn on Prompter link in its Scenes settings. Chrome may ask once to let this page reach apps on this device: allow it.");
  assert.equal(await C.locator(".status").textContent(), "CamFrame link: not found.", "not found is read out once");
  await shot(C, "camframe-lost-desktop");
  // A cue while CamFrame is gone: tried twice, no note, scrolling carries on.
  await C.keyboard.press("Escape");
  await passCue(0, -120);
  await C.waitForTimeout(400);
  await passCue(0);
  await C.waitForTimeout(1200);
  assert.equal(await toastShown(), false, "no note when CamFrame cannot be reached");
  // CamFrame back: the next cue that gets through checks again and connects.
  cam.scenes = ["Intro", "Outro"];
  await cam.start();
  const statusBeforeBack = cam.seen.filter((r) => r.path === "/camframe/status").length;
  await passCue(0, -120);
  await C.waitForTimeout(400);
  await passCue(0);
  await C.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  assert.ok(cam.seen.filter((r) => r.path === "/camframe/status").length > statusBeforeBack, "a status check follows the cue");
  await cam.stop();
  await (await dock(C, ".settings-btn")).click();
  await C.locator("#settings:popover-open").waitFor();
  await C.locator("#settings .camframe").click();
  assert.equal((await camLook()).state, "off");
  assert.equal(await C.evaluate(() => localStorage.getItem("prompter-camframe")), null);
  await camCtx.close();
  ok("CamFrame link: cue lines read as a camera instruction (a camera mark, \"Camera: face small\" bold but small and dimmed like a reminder, the line's other words muted) whether or not the link is on; off by default (no calls at all); CamFrame's big button in Settings, beside Follow my voice and the main screen and built like them (Enter, Space or a click turn the same remembered setting on and off), says its state in its name and title: off a quiet outline camera, looking or reconnecting a blinking orange camera (reduced motion: a dashed ring, no blinking), connected a filled orange camera with a steady glow (and a dot on Settings), not found a quiet crossed-out camera with a thin orange ring and the permission help in its title; connected and not found are read out once, not on every check; a cue line sends its cue to 127.0.0.1:47833 once per pass down (by hand, a section jump sending only the last cue it passed, auto-scroll, and Follow my voice), again after scrolling back above it, never the script; a refused cue keeps the link on; a reload with the link remembered connects by itself and sends nothing for cues already above; one missed check says reconnecting and connects again by itself, several in a row say not found; a cue that does not get through is sent once more, and twice not through reconnects; a cue still on its way when the link is turned off and on changes nothing; no note pops up for a cue (switched, refused or not reached)", reloadNote);

  // ---- Camera layouts: the Prompter saves the two layout Scenes in a CamFrame with API 2 ----
  await cam.start();
  cam.seen.length = 0;
  cam.answer = null;
  const layCtx = await browser.newContext(DESKTOP);
  await layCtx.addInitScript(() => { if (location.protocol.startsWith("http")) localStorage.setItem("prompter-camframe", "on"); });
  const LY = await layCtx.newPage();
  LY.on("pageerror", (e) => errors.push(`layouts pageerror: ${e.message}`));
  LY.on("console", (m) => {
    // A refused save is a 4xx/5xx answer, logged by the browser as a failed resource.
    const refusedSave = /status of (409|503)/.test(m.text()) && m.location()?.url?.startsWith("http://127.0.0.1:47833/camframe/scenes");
    // This block reloads the page many times, which can reach the site's limit on its own /api calls.
    const siteLimit = /status of 429/.test(m.text()) && new URL(m.location()?.url || "http://x").pathname.startsWith("/api/");
    // A static server has no Worker, so Wait for MCP's token request gets a 404 (as in watch above).
    const noWorker = mode === "static" && m.location()?.url?.includes("/api/");
    if (m.type() === "error" && !refusedSave && !siteLimit && !noWorker && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`layouts console: ${m.text()}`);
  });
  const layoutsLink = await makeLink(CUE_SCRIPT, "lex", base);
  // A fresh load each time (the link differs only after #, so going to it again would not reload).
  const openLayoutsLoad = async () => {
    await LY.goto("about:blank");
    await LY.goto(layoutsLink);
    await LY.locator(".section").first().waitFor();
    await LY.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  };
  // Where the layouts stand is said in the paste window's Camera cues list, in one line.
  const openPasteWindow = async () => {
    await (await dock(LY, ".open-btn")).click();
    await LY.locator("#open-menu:popover-open").waitFor();
    await LY.locator('#open-menu [data-action="paste"]').click();
    await LY.locator(".paste-dialog[open]").waitFor();
  };
  const layoutsLine = async () => (await LY.locator(".cue-layouts").isVisible() ? await LY.locator(".cue-layouts").textContent() : "");
  const lineIs = (re) => LY.waitForFunction((src) => { const el = document.querySelector(".cue-layouts"); return !el.hidden && new RegExp(src).test(el.textContent); }, re.source);
  const noMenuItem = async () => assert.equal(await LY.locator(".layouts-item, .layouts-dialog").count(), 0, "no Camera layouts button or window");
  // Saves made by themselves are quiet: wait for CamFrame to have had `n` saves and the status read after.
  const savesReach = async (n) => {
    for (let t = 0; cam.saves().length < n; t += 50) { assert.ok(t < 5000, `waiting for ${n} saves, got ${cam.saves().length}`); await LY.waitForTimeout(50); }
    await LY.waitForTimeout(300);
  };
  // A status check now, as opening Settings starts one (Settings cannot open behind the window).
  const checkNow = () => LY.evaluate(() => document.querySelector("#settings").dispatchEvent(new ToggleEvent("toggle", { newState: "open" })));
  const SMALL = { name: "Live small corner", size: "small", position: "bottom-right" };
  const LARGE = { name: "Live right large", size: 432, position: "right", withinRight: 0.3 };
  const snapshot = (name) => ({ id: name, name, kind: "snapshot", size: 400, position: { x: 28, y: 104 } });

  // An older CamFrame (no api field): nothing is saved and the list says nothing about layouts.
  await openLayoutsLoad();
  await LY.waitForTimeout(300);
  assert.deepEqual(cam.saves(), [], "older CamFrame: nothing saved");
  await openPasteWindow();
  assert.equal(await layoutsLine(), "", "older CamFrame: no layouts line");
  await LY.keyboard.press("Escape");
  await noMenuItem();

  // API 2 with one Scene of Lex's own: on connecting, the two layouts are saved by themselves,
  // small first, without replace or apply, and no cue is sent. The list says so in one line.
  cam.layouts = { smallSize: 288, sceneLimit: 6, details: [snapshot("Interview")] };
  await openLayoutsLoad();
  await savesReach(2);
  assert.deepEqual(cam.saves(), [SMALL, LARGE], "both saved, small corner first, never replace or apply");
  assert.equal(await LY.locator(".status").textContent(), "CamFrame link: connected.", "saving by itself is not read out over \"connected\"");
  assert.deepEqual(cam.cues(), [], "saving sends no cue: the camera does not move");
  assert.equal(cam.seen.some((r) => r.path === "/camframe/small-size"), false, "never changes CamFrame's small size");
  await noMenuItem();
  await openPasteWindow();
  await lineIs(/^Camera layouts are saved in CamFrame's Scenes: Live small corner and Live right large\.$/);
  await LY.waitForFunction(() => document.querySelector(".paste-status").textContent === "Camera layouts are saved in CamFrame's Scenes: Live small corner and Live right large.", null, { timeout: 3000 }); // read out once, when the window opens
  await shot(LY, "camframe-layouts-saved-desktop");
  await LY.keyboard.press("Escape");
  // Later status checks do not save again.
  await checkNow();
  await LY.waitForTimeout(400);
  assert.equal(cam.saves().length, 2, "a later status check saves nothing more");

  // A Scene of Lex's own with a layout's name: never replaced, and the line says it is left alone.
  cam.layouts.details = [snapshot("Interview"), { id: "s", name: "Live small corner", kind: "layout", size: 288, followsSmallSize: true, position: "bottom-right" }, snapshot("Live right large")];
  cam.seen.length = 0;
  await openLayoutsLoad();
  await LY.waitForTimeout(500);
  assert.deepEqual(cam.saves(), [], "the different one is not saved over");
  await openPasteWindow();
  await lineIs(/^CamFrame already has a different Scene named Live right large; the Prompter leaves it alone, so the cue uses what CamFrame holds\.$/);
  assert.equal(await LY.locator('[data-action="layout-replace"], .layout-replace').count(), 0, "no Replace anywhere");
  await LY.keyboard.press("Escape");

  // No room for both: nothing is saved, and the line says how many Scenes to delete.
  cam.layouts.details = ["A", "B", "C", "D", "E"].map(snapshot);
  cam.seen.length = 0;
  await openLayoutsLoad();
  await LY.waitForTimeout(500);
  assert.deepEqual(cam.saves(), [], "no room: nothing saved");
  await openPasteWindow();
  await lineIs(/^No room to save the layouts: CamFrame keeps at most 6 Scenes and has 5, and 2 more are needed, with one slot left free\. Delete 2 Scenes you do not use in CamFrame, then turn the camera button in Settings off and on\.$/);
  await shot(LY, "camframe-layouts-no-room-desktop");
  await LY.keyboard.press("Escape");

  // Saving would fill CamFrame (4 + 2 of 6): not by itself, and the line says why.
  cam.layouts.details = ["A", "B", "C", "D"].map(snapshot);
  cam.seen.length = 0;
  await openLayoutsLoad();
  await LY.waitForTimeout(500);
  assert.deepEqual(cam.saves(), [], "no spare slot would be left: no automatic save");
  await openPasteWindow();
  await lineIs(/^Not saved: Live small corner and Live right large\. Saving would fill CamFrame \(6 of 6 Scenes\) and leave no spare slot, so the Prompter waits\./);
  await shot(LY, "camframe-layouts-tight-desktop");
  await LY.keyboard.press("Escape");

  // Freeing a slot and turning the camera button off and on saves both (3 + 2 of 6).
  cam.layouts.details = ["A", "B", "C"].map(snapshot);
  await (await dock(LY, ".settings-btn")).click();
  await LY.locator("#settings:popover-open").waitFor();
  await LY.locator("#settings .camframe").click();
  await LY.locator("#settings .camframe").click();
  await LY.keyboard.press("Escape");
  await LY.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  await savesReach(2);
  assert.deepEqual(cam.saves().slice(-2), [SMALL, LARGE], "a new link session saves both once there is room");

  // CamFrame refuses (its window is not open yet): said in plain words, nothing tried again by itself.
  cam.layouts.details = [snapshot("Interview")];
  cam.seen.length = 0;
  cam.answer = (path) => (path === "/camframe/scenes" ? { status: 503, body: { ok: false, error: "not ready", code: "not-ready" } } : null);
  await openLayoutsLoad();
  await LY.waitForTimeout(500);
  const triedBefore = cam.saves().length;
  await checkNow();
  await LY.waitForTimeout(400);
  assert.equal(cam.saves().length, triedBefore, "a check does not try a refused save again");
  cam.answer = null;
  await openPasteWindow();
  await lineIs(/^CamFrame's window was not open when the layouts were saved\. Open it, then turn the camera button in Settings off and on\.$/);
  await LY.keyboard.press("Escape");

  // An answer lost on its way back after CamFrame saved: no blind repeat; the status shows it saved.
  cam.layouts.details = [snapshot("Interview")];
  cam.seen.length = 0;
  cam.answer = (path) => (path === "/camframe/scenes" ? { broken: true, saved: true } : null);
  await openLayoutsLoad();
  await savesReach(2);
  cam.answer = null;
  assert.equal(cam.saves().length, 2, "each sent once");
  await openPasteWindow();
  await lineIs(/^Camera layouts are saved in CamFrame/);
  await LY.keyboard.press("Escape");

  // Lost and not saved: each still sent once, and the line does not claim they are saved.
  cam.layouts.details = [snapshot("Interview")];
  cam.seen.length = 0;
  cam.answer = (path) => (path === "/camframe/scenes" ? { broken: true } : null);
  await openLayoutsLoad();
  await savesReach(2);
  cam.answer = null;
  await openPasteWindow();
  await lineIs(/^Not saved in CamFrame: Live small corner and Live right large\. Turn the camera button in Settings off and on to save them\.$|^CamFrame did not answer while saving the layouts\./);
  await LY.keyboard.press("Escape");

  // A layout deleted in CamFrame later: the next check shows it is not saved; nothing re-adds it until the next connect.
  cam.layouts.details = [snapshot("Interview")];
  cam.seen.length = 0;
  await openLayoutsLoad();
  await savesReach(2);
  cam.layouts.details = cam.layouts.details.filter((d) => d.name !== "Live right large");
  await checkNow();
  await LY.waitForTimeout(500);
  assert.equal(cam.saves().length, 2, "nothing is saved again by itself");
  await openPasteWindow();
  await lineIs(/^Not saved in CamFrame: Live right large\. Turn the camera button in Settings off and on to save it\.$/);
  await LY.keyboard.press("Escape");

  // The window opened during a save made by itself: the result is read out when the save ends.
  cam.layouts.details = [snapshot("Interview")];
  cam.answer = (path) => (path === "/camframe/scenes" ? { delay: 600 } : null);
  cam.seen.length = 0;
  await openLayoutsLoad();
  await savesReach(1);
  await openPasteWindow();
  await LY.waitForFunction(() => document.querySelector(".paste-status").textContent === "Camera layouts are saved in CamFrame's Scenes: Live small corner and Live right large.", null, { timeout: 8000 });
  await LY.keyboard.press("Escape");
  cam.answer = null;

  // The link turned off and on while a save waits for its answer: the new session saves by
  // itself and nothing is left saying "Saving…".
  cam.layouts.details = [snapshot("Interview")];
  let slowSave = true;
  cam.answer = (path) => (path === "/camframe/scenes" && slowSave ? ((slowSave = false), { delay: 1500 }) : null);
  cam.seen.length = 0;
  await openLayoutsLoad();
  await savesReach(1);
  await (await dock(LY, ".settings-btn")).click();
  await LY.locator("#settings:popover-open").waitFor();
  await LY.locator("#settings .camframe").click();
  await LY.locator("#settings .camframe").click();
  await LY.keyboard.press("Escape");
  await LY.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  await savesReach(2);
  await LY.waitForTimeout(1500);
  await openPasteWindow();
  await lineIs(/^Camera layouts are saved in CamFrame/);
  assert.doesNotMatch(await layoutsLine(), /Saving/, "nothing stuck on Saving…");
  await LY.keyboard.press("Escape");
  cam.answer = null;

  // The Camera cues list in the paste window: the layout Scenes and CamFrame's own, inserted at the cursor.
  await LY.goto("about:blank");
  await LY.goto(layoutsLink);
  await LY.locator(".section").first().waitFor();
  await LY.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  await (await dock(LY, ".open-btn")).click();
  await LY.locator("#open-menu:popover-open").waitFor();
  await LY.locator('#open-menu [data-action="paste"]').click();
  await LY.locator(".paste-dialog[open]").waitFor();
  const cueLabels = await LY.locator(".cue-select option").allTextContents();
  assert.deepEqual(cueLabels.slice(0, 2), ["Choose a cue…", "Face full (fill the screen)"]);
  assert.ok(cueLabels.includes("Scene: Live right large (layout)") && cueLabels.includes("Scene: Live small corner (layout)") && cueLabels.includes("Scene: Interview"), "the two layout Scenes and CamFrame's own");
  assert.equal(await LY.locator(".cue-off").isHidden(), true);
  await LY.locator("#paste-text").fill("### **A**\nHello\nWorld");
  await LY.locator("#paste-text").evaluate((el) => { el.focus(); el.setSelectionRange(12, 12); }); // after "He", mid-line
  await LY.locator(".cue-select").selectOption("[Face: Live right large]");
  await LY.locator('[data-action="insert-cue"]').click();
  assert.equal(await LY.locator("#paste-text").inputValue(), "### **A**\nHello\n[Face: Live right large]\nWorld", "on its own line, after the line the cursor is in (no line is split)");
  assert.equal(await LY.locator(".paste-status").textContent(), "Inserted camera cue [Face: Live right large]", "read out in the window's own status line");
  assert.equal(await LY.evaluate(() => document.activeElement.id), "paste-text", "focus back in the text");
  // A selection stays (the cue goes after it), and Undo takes the insert back.
  const selValue = await LY.locator("#paste-text").inputValue();
  const llo = selValue.indexOf("Hello");
  await LY.locator("#paste-text").evaluate((el, at) => { el.focus(); el.setSelectionRange(at, at + 3); }, llo);
  await LY.locator(".cue-select").selectOption("[Face full]");
  await LY.locator('[data-action="insert-cue"]').click();
  assert.equal(await LY.locator("#paste-text").inputValue(), "### **A**\nHello\n[Face full]\n[Face: Live right large]\nWorld", "the selected text stays, the cue follows its line");
  await LY.keyboard.press("Control+z");
  assert.equal(await LY.locator("#paste-text").inputValue(), selValue, "Undo takes the insert back");
  // A cursor inside a section title: the cue goes after that line, the title stays whole.
  await LY.locator("#paste-text").fill("### **INTRO · 00:00**\nHello");
  await LY.locator("#paste-text").evaluate((el) => { el.focus(); el.setSelectionRange(8, 8); });
  await LY.locator(".cue-select").selectOption("[Face full]");
  await LY.locator('[data-action="insert-cue"]').click();
  assert.equal(await LY.locator("#paste-text").inputValue(), "### **INTRO · 00:00**\n[Face full]\nHello", "the title is not split");
  await LY.locator("#paste-text").fill("### **INTRO · 00:00**\n- Site: https://x.test/a\nQL: Why?\nHello");
  await LY.locator("#paste-text").evaluate((el) => { el.focus(); el.setSelectionRange(8, 8); });
  await LY.locator('[data-action="insert-cue"]').click();
  assert.equal(await LY.locator("#paste-text").inputValue(), "### **INTRO · 00:00**\n- Site: https://x.test/a\nQL: Why?\n[Face full]\nHello", "after the title's link and question line");
  await LY.locator("#paste-text").fill("- Docs: https://x.test/y/z\n### **A**\nHello");
  await LY.locator("#paste-text").evaluate((el) => { el.focus(); el.setSelectionRange(20, 20); });
  await LY.locator('[data-action="insert-cue"]').click();
  assert.equal(await LY.locator("#paste-text").inputValue(), "- Docs: https://x.test/y/z\n### **A**\nHello", "a cursor inside notes above the first title: nothing is put there");
  await LY.locator("#paste-text").fill("### **NOTES**\nx\n<!--SCRIPT-START-->\n### **A**\nHello");
  await LY.locator("#paste-text").evaluate((el) => { el.focus(); el.setSelectionRange(14, 14); });
  await LY.locator('[data-action="insert-cue"]').click();
  assert.equal(await LY.locator("#paste-text").inputValue(), "### **NOTES**\nx\n<!--SCRIPT-START-->\n### **A**\nHello", "before the start marker the cue would be skipped: nothing is put there");
  assert.equal(await LY.locator(".paste-error").isVisible(), true);
  // A bare ### is no title (the format's own reading): nothing is put there.
  await LY.locator("#paste-text").fill("### \nHello");
  await LY.locator("#paste-text").evaluate((el) => { el.focus(); el.setSelectionRange(10, 10); });
  await LY.locator('[data-action="insert-cue"]').click();
  assert.equal(await LY.locator("#paste-text").inputValue(), "### \nHello");
  // No section title above the cursor: nothing is put there, and the window says why.
  await LY.locator("#paste-text").fill("");
  await LY.locator('[data-action="insert-cue"]').click();
  assert.equal(await LY.locator("#paste-text").inputValue(), "");
  assert.match(await LY.locator(".paste-error").textContent(), /^Put the cursor under a section title/);
  await LY.locator("#paste-text").fill(selValue);
  // Opening the pasted script is read out on the page after the window closes.
  await LY.locator('[data-action="open-paste"]').click();
  await LY.waitForFunction(() => !document.querySelector(".paste-dialog").open);
  await LY.waitForFunction(() => document.querySelector(".status").textContent === "Opened pasted script");
  await (await dock(LY, ".open-btn")).click();
  await LY.locator("#open-menu:popover-open").waitFor();
  await LY.locator('#open-menu [data-action="paste"]').click();
  await LY.locator(".paste-dialog[open]").waitFor();
  assert.doesNotMatch(await LY.locator(".paste-status").textContent(), /Inserted camera cue/, "the last insert's words are gone when the window opens again");
  // A chosen Scene that vanishes from CamFrame never turns into another cue by itself.
  await LY.locator(".cue-select").selectOption("[Face: Interview]");
  cam.layouts.details = cam.layouts.details.filter((d) => d.name !== "Interview");
  await checkNow();
  await LY.waitForFunction(() => !document.querySelector('.cue-select option[value="[Face: Interview]"]'));
  assert.equal(await LY.locator(".cue-select").inputValue(), "", "back on the blank choice");
  await LY.locator('[data-action="insert-cue"]').click();
  assert.equal(await LY.locator(".paste-error").textContent(), "Choose a camera cue in the list first.", "visible (and read out as an alert)");
  // Not connected: no list, one line instead; focus on the list goes to the text.
  await LY.locator(".cue-select").focus();
  await cam.stop();
  await LY.evaluate(() => document.querySelector("#settings").dispatchEvent(new ToggleEvent("toggle", { newState: "open" })));
  await LY.waitForFunction(() => ["reconnecting", "lost"].includes(document.querySelector(".camframe").dataset.state), null, { timeout: 15_000 });
  await LY.waitForFunction(() => document.querySelector(".camframe").dataset.state === "lost", null, { timeout: 30_000 });
  assert.equal(await LY.locator(".cue-pick").isHidden(), true);
  assert.match(await LY.locator(".cue-off").textContent(), /^Camera cues show here once CamFrame answers/, "the link is on, so no advice to turn it on");
  assert.equal(await LY.evaluate(() => document.activeElement.id), "paste-text", "the list went away under the keyboard: focus is in the text");
  assert.match(await LY.locator(".paste-status").textContent(), /^CamFrame link: not found/, "the window's own status line says it (the link's word is the reason the list went)");
  await LY.keyboard.press("Escape");
  await cam.start();
  // An older CamFrame lists only its own Scenes: no layout Scenes are offered, and the link off says how to turn it on.
  cam.layouts = null;
  await LY.goto("about:blank");
  await LY.goto(layoutsLink);
  await LY.locator(".section").first().waitFor();
  await LY.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  await (await dock(LY, ".open-btn")).click();
  await LY.locator("#open-menu:popover-open").waitFor();
  await LY.locator('#open-menu [data-action="paste"]').click();
  await LY.locator(".paste-dialog[open]").waitFor();
  const oldLabels = await LY.locator(".cue-select option").allTextContents();
  assert.ok(oldLabels.includes("Scene: Intro") && !oldLabels.some((l) => l.includes("(layout)")), `an older CamFrame: ${oldLabels.join(" | ")}`);
  await LY.keyboard.press("Escape");
  await layCtx.close();

  // Phone width: the paste window with the list and the layouts line fits.
  cam.layouts = { smallSize: 288, sceneLimit: 6, details: ["A", "B", "C", "D", "E"].map(snapshot) };
  const layPhone = await browser.newContext(MOBILE);
  await layPhone.addInitScript(() => { localStorage.setItem("prompter-camframe", "on"); });
  const LM = await layPhone.newPage();
  LM.on("pageerror", (e) => errors.push(`layouts phone pageerror: ${e.message}`));
  await LM.goto(layoutsLink);
  await LM.locator(".section").first().waitFor();
  await LM.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  await LM.waitForTimeout(500);
  await (await dock(LM, ".open-btn")).click();
  await LM.locator("#open-menu:popover-open").waitFor();
  await LM.locator('#open-menu [data-action="paste"]').click();
  await LM.locator(".paste-dialog[open]").waitFor();
  await LM.waitForFunction(() => !document.querySelector(".cue-layouts").hidden);
  const fits = await LM.evaluate(() => { const r = document.querySelector(".paste-dialog").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; });
  assert.equal(fits, true, "phone: the window fits, nothing scrolls sideways");
  await shot(LM, "camframe-layouts-different-mobile");
  await layPhone.close();
  await cam.stop();
  ok("Camera layouts: an older CamFrame gets no save and the Camera cues list says nothing about layouts; a CamFrame with API 2 gets the two layout Scenes saved by themselves when it connects (Live small corner, following the small size, then Live right large at 1.5 times it, inside the right 30%), never with replace or apply, no cue and no small-size call, and not read out over \"connected\"; later checks save nothing more; there is no Camera layouts button or window; the one line under the Camera cues list says where the layouts stand: saved, a different Scene of Lex's own left alone, no room (how many Scenes to delete), saving would fill CamFrame (the Prompter waits), a refusal or a lost answer in plain words, a layout deleted later not saved until the next connect; a slow save from before the link was turned off and on never holds up the new session; the list fits a phone")

  // ---- Text only: hidden cues and links still happen at the next spoken line (TOOLS-491) ----
  {
    const textOnlyLink = await makeLink(TEXT_ONLY_SCRIPT, "lex", base);
    // Scrolls `page` so the element `sel` (the n-th match) sits just above the reading line (plus `dy`).
    const passEl = (page, sel, dy = 0, n = 0) => page.evaluate(([q, d, i]) => {
      const el = document.querySelectorAll(q)[i];
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - document.querySelector(".reading-line").getBoundingClientRect().top - 2 + d);
    }, [sel, dy, n]);
    const lineOf = (page, words) => page.evaluate((w) => [...document.querySelectorAll("[data-k]")].find((el) => el.textContent === w).dataset.k, words);
    const stripRows = (page) => page.locator(".next-up li").evaluateAll((els) => els.filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => [el.dataset.state, el.querySelector(".sw-kind").textContent, el.querySelector(".sw-what").textContent, el.querySelector(".redo") ? el.querySelector(".redo").textContent : ""].join(" | ")));
    const hiddenLook = (page) => page.evaluate(() => ({
      notes: document.querySelectorAll(".script .note").length,
      marks: document.querySelectorAll(".script .mark").length,
      links: document.querySelectorAll(".script .links").length,
      cues: document.querySelectorAll(".script [data-cue]").length,
      spoken: [...document.querySelectorAll("[data-k]")].map((el) => el.textContent),
      cueBoxes: [...document.querySelectorAll(".script [data-cue]")].map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), el.textContent]; }),
    }));
    const toCtx = await browser.newContext(DESKTOP);
    await toCtx.addInitScript(SCREEN_STUB);
    await toCtx.addInitScript(SPEECH_STUB);
    const T = await toCtx.newPage();
    watch(T, "text only");
    await T.goto(textOnlyLink);
    await T.locator(".section").first().waitFor();
    // Off by default: the page draws exactly what it drew before, and Settings offers the choice.
    const offHtml = await T.locator(".script").innerHTML();
    const offLook = await hiddenLook(T);
    assert.deepEqual([offLook.notes, offLook.marks, offLook.links, offLook.cues], [4, 1, 1, 3], "off: reminders, cue lines, the link line and the top link row all show");
    assert.equal(await T.locator(".next-up").isVisible(), false, "off: no strip");
    assert.equal(await T.evaluate(() => localStorage.getItem("prompter-text-only")), null, "nothing stored");
    await (await dock(T, ".settings-btn")).click();
    await T.locator("#settings:popover-open").waitFor();
    assert.deepEqual(await T.locator("#settings fieldset.show").evaluate((el) => [el.querySelector("legend").textContent, [...el.querySelectorAll("label")].map((l) => l.textContent), el.querySelector("input:checked").value]),
      ["Show", ["Everything", "Text only"], "all"], "Settings: Show, Everything (chosen) or Text only");
    await T.locator('#settings input[name="show"][value="text"]').click();
    await T.evaluate(() => document.querySelector("#settings").hidePopover());
    assert.equal(await T.evaluate(() => localStorage.getItem("prompter-text-only")), "on", "remembered on this device");
    const onLook = await hiddenLook(T);
    assert.deepEqual([onLook.notes, onLook.marks, onLook.links], [0, 0, 0], "on: no reminder, cue line, link line or top link row");
    assert.deepEqual(onLook.spoken, offLook.spoken, "every spoken line is still there, numbered as before");
    assert.deepEqual(onLook.cueBoxes, [[0, ""], [0, ""], [0, ""]], "the cues are still marked in place, with nothing to see");
    assert.equal(await T.evaluate(() => document.querySelector(".script").textContent.includes("Share screen")), false);
    // The strip: small, muted, beside the text (never over it), no border or ring.
    await T.locator(".next-up").waitFor();
    assert.deepEqual(await stripRows(T), ["next | Page | Intro | ", "next | Camera | face small | ", "next | You | Share screen. | "], "the next three switches, each with its kind word");
    const stripLook = await T.evaluate(() => {
      const strip = document.querySelector(".next-up");
      const r = strip.getBoundingClientRect();
      const right = Math.max(...[...document.querySelectorAll("[data-k]")].map((el) => el.getBoundingClientRect().right));
      const cs = getComputedStyle(strip);
      const row = getComputedStyle(strip.querySelector("li"));
      return { clear: r.left >= right, inside: r.right <= innerWidth, border: cs.borderTopStyle, shadow: cs.boxShadow, color: row.color, size: parseFloat(row.fontSize) };
    });
    assert.deepEqual([stripLook.clear, stripLook.inside, stripLook.border, stripLook.shadow], [true, true, "none", "none"], "beside the text, inside the window, no border, ring or shadow");
    assert.equal(stripLook.color, "oklch(0.763 0.027 282)", "muted");
    assert.ok(stripLook.size <= 14, "small");
    // The column stays centred (a camera over the middle of the screen), only narrower.
    const colMid = (page) => page.evaluate(() => {
      const m = document.querySelector(".script");
      const r = m.getBoundingClientRect();
      const cs = getComputedStyle(m);
      return Math.round((r.left + parseFloat(cs.paddingLeft) + r.right - parseFloat(cs.paddingRight)) / 2 - innerWidth / 2);
    });
    assert.ok(Math.abs(await colMid(T)) <= 2, `the column stays centred beside the strip (${await colMid(T)}px off)`);
    // Top link: the main screen opens it at the section start, as before.
    await viaSettings(T, ".screen");
    const tVisits = () => T.evaluate(() => window.__screen.visits.slice());
    await scrollToSection(T, 1);
    await T.waitForFunction(() => window.__screen.visits.at(-1) === "https://example.com/intro", null, { timeout: 2000 });
    assert.deepEqual((await stripRows(T))[0], "done | Page | Intro | ", "the switch that just happened leads the strip");
    // The hidden link line opens at the next spoken line, once that line reaches the reading line.
    await passEl(T, ".link-at", -30);
    await T.waitForTimeout(900);
    assert.equal((await tVisits()).at(-1), "https://example.com/intro", "not before its spoken line");
    const markAt = await T.evaluate(() => { const at = document.querySelector(".link-at"); return Math.abs(at.getBoundingClientRect().top - at.nextElementSibling.getBoundingClientRect().top) <= 2 && at.nextElementSibling.textContent; });
    assert.equal(markAt, "Patchstack finds the holes.", "its place is the start of the next spoken line");
    await passEl(T, ".link-at");
    await T.waitForFunction(() => window.__screen.visits.at(-1) === "https://patchstack.com", null, { timeout: 2000 });
    assert.deepEqual((await stripRows(T)).slice(0, 2), ["done | Page | Patchstack | ", "next | You | Smile at the camera | "], "done, then a reminder for Lex's own hands");
    await shot(T, "text-only-desktop");
    // Follow my voice and the Paragraphs layout work with Text only on (from two lines before the reminder).
    const purple = await lineOf(T, "Purple elephants dance quietly tonight.");
    await passEl(T, "[data-k]", 0, Number(purple) - 2);
    await T.evaluate(() => localStorage.setItem("prompter-voice-ok", "yes"));
    await viaSettings(T, ".voice");
    await T.waitForFunction(() => window.__speech.started === 1);
    // A line said in full: the line after it is the one being read.
    const afterPurple = String(Number(purple) + 1);
    await T.evaluate(() => window.__speech.say("purple elephants dance quietly tonight"));
    await T.waitForFunction((k) => document.querySelector(".cur")?.dataset.k === k, afterPurple, { timeout: 2000 });
    await spaceTo(T, "layout", "paragraphs");
    assert.equal(await T.evaluate(() => document.querySelector(".cur")?.dataset.k), afterPurple, "Paragraphs: the line being read stays marked");
    assert.deepEqual((await hiddenLook(T)).notes, 0, "Paragraphs: still text only");
    await T.evaluate(() => window.__speech.say("back to the full camera"));
    const back = String(Number(await lineOf(T, "Back to the full camera.")) + 1);
    await T.waitForFunction((k) => document.querySelector(".cur")?.dataset.k === k, back, { timeout: 2000 });
    // Turned off while the voice's move is still under way: the line being read stays marked and is
    // at the reading line (as for any layout change during a voice move), and the strip goes.
    const visitsBefore = await tVisits();
    await viaSettings(T, 'input[name="show"][value="all"]');
    assert.equal(await T.evaluate(() => document.querySelector(".cur")?.dataset.k), back, "the line being read stays marked");
    await T.waitForTimeout(900);
    assert.deepEqual(await tVisits(), visitsBefore, "turning it off opens no page by itself");
    const curAtLine = await T.evaluate(() => {
      const y = document.querySelector(".reading-line").getBoundingClientRect().top;
      return [...document.querySelector(".cur").getClientRects()].some((r) => r.top <= y + 4 && r.bottom >= y - 4);
    });
    assert.equal(curAtLine, true, "and sits at the reading line");
    assert.equal(await T.locator(".next-up").isVisible(), false);
    assert.equal(await T.evaluate(() => localStorage.getItem("prompter-text-only")), null);
    await viaSettings(T, ".voice");
    await spaceTo(T, "layout", "lines");
    await toCtx.close();
    // Off again on a fresh page: exactly what the page drew before it was ever turned on.
    const offAgain = await browser.newContext(DESKTOP);
    await offAgain.addInitScript(() => { localStorage.setItem("prompter-text-only", "on"); });
    const T2 = await offAgain.newPage();
    watch(T2, "text only off again");
    await T2.goto(textOnlyLink);
    await T2.locator(".section").first().waitFor();
    assert.equal((await hiddenLook(T2)).notes, 0, "read at start-up");
    await viaSettings(T2, 'input[name="show"][value="all"]');
    assert.equal(await T2.locator(".script").innerHTML(), offHtml, "Text only off draws the script exactly as before");
    await offAgain.close();
    ok("Text only (off by default, nothing stored): Settings' Show offers Everything or Text only, remembered on this device; on hides reminders, camera cue lines, link lines and the top link row and keeps every spoken line; a quiet strip beside the text shows the switch that just happened and the next three with a kind word; the hidden link opens on the main screen at the next spoken line; Follow my voice and Paragraphs keep working; turned off, the page is drawn exactly as before");

    // Missed: no main screen, or one cut off: the strip says Missed, and its Open button opens the page by hand.
    const missCtx = await browser.newContext(DESKTOP);
    await missCtx.addInitScript(SCREEN_STUB);
    await missCtx.addInitScript(() => { localStorage.setItem("prompter-text-only", "on"); });
    const M = await missCtx.newPage();
    watch(M, "text only missed");
    await M.goto(textOnlyLink);
    await M.locator(".section").first().waitFor();
    await scrollToSection(M, 1);
    await M.waitForFunction(() => document.querySelector(".next-up li")?.dataset.state === "missed", null, { timeout: 2000 });
    assert.deepEqual((await stripRows(M))[0], "missed | Page | Intro | Open", "no main screen: Missed, with an Open button");
    assert.equal(await M.locator(".next-up .redo").getAttribute("aria-label"), "Open Intro on the main screen");
    assert.deepEqual(await M.evaluate(() => window.__screen.visits.slice()), [], "nothing opened by itself");
    await shot(M, "text-only-missed-desktop");
    await M.locator(".next-up .redo").click();
    await M.waitForFunction(() => window.__screen.visits.at(-1) === "https://example.com/intro", null, { timeout: 2000 });
    await M.waitForFunction(() => document.querySelector(".next-up li")?.dataset.state === "done");
    assert.equal(await M.locator("#settings .screen").getAttribute("data-on"), "true", "opened by hand, so the main screen is connected");
    // The main screen is cut off (TOOLS-492) and the browser blocks a new window without a click (pop-ups
    // not allowed): the next page is missed too, and nothing opens by itself.
    await M.evaluate(() => {
      window.open().closed = true;
      const open = window.open;
      window.open = (...args) => (["click", "keydown", "keyup"].includes(window.event?.type) ? open(...args) : null);
    });
    await M.waitForFunction(() => document.querySelector("#settings .screen").dataset.on === "cut", null, { timeout: 2000 });
    await passEl(M, ".link-at");
    await M.waitForFunction(() => document.querySelector(".next-up li")?.dataset.state === "missed" && document.querySelector(".next-up li .sw-what").textContent === "Patchstack", null, { timeout: 2000 });
    assert.equal((await M.evaluate(() => window.__screen.visits.slice())).at(-1), "https://example.com/intro", "cut off and blocked: nothing opens by itself");
    // A later camera cue happened: the missed page still comes first, and its Open button keeps focus.
    await M.locator(".next-up .redo").focus();
    await passEl(M, "[data-cue]", 0, 1);
    await M.waitForTimeout(100);
    assert.equal(await M.evaluate(() => document.activeElement?.matches(".next-up .redo")), true, "the Open button keeps focus while the rows change");
    assert.deepEqual((await stripRows(M)).slice(0, 2), ["missed | Page | Patchstack | Open", "done | Camera | face full | "]);
    await M.keyboard.press(" "); // Space on the focused Open button opens the page, as Enter or a click would
    await M.waitForFunction(() => window.__screen.visits.at(-1) === "https://patchstack.com", null, { timeout: 2000 });
    await M.waitForFunction(() => !document.querySelector('.next-up li[data-state="missed"]'));
    assert.equal(await M.evaluate(() => Boolean(document.activeElement?.closest(".next-up"))), true, "Open's row went, and the keyboard stays in the strip");
    assert.equal(await M.locator(".dock-btn.auto").getAttribute("aria-pressed"), "false", "Space on Open did not start auto-scroll");
    assert.equal(await M.locator(".next-up .sw-what").first().getAttribute("title"), await M.locator(".next-up .sw-what").first().textContent(), "a name cut at two lines shows in full on hover");
    await missCtx.close();
    ok("Text only, missed: with no main screen, or one cut off whose new window the browser blocked, the page's row says Missed (also after a later cue) and nothing opens by itself; its Open button opens it by hand (a click, or Space from the keyboard)");

    // Turned off just before a hidden link reaches the reading line: the link line moves above the line
    // without sending anything, and the page goes on the main screen once the reader moves on.
    const quietCtx = await browser.newContext(DESKTOP);
    await quietCtx.addInitScript(SCREEN_STUB);
    await quietCtx.addInitScript(() => { localStorage.setItem("prompter-text-only", "on"); });
    const TS = await quietCtx.newPage();
    watch(TS, "text only, switched before a link");
    await TS.goto(textOnlyLink);
    await TS.locator(".section").first().waitFor();
    await viaSettings(TS, ".screen");
    await scrollToSection(TS, 1);
    await TS.waitForFunction(() => window.__screen.visits.at(-1) === "https://example.com/intro", null, { timeout: 2000 });
    await passEl(TS, ".link-at", -6); // the reading line in the room just above the spoken line the link waits for
    await TS.waitForTimeout(900);
    await viaSettings(TS, 'input[name="show"][value="all"]');
    const linkAbove = await TS.evaluate(() => {
      const y = document.querySelector(".reading-line").getBoundingClientRect().top;
      const line = [...document.querySelectorAll(".script .mark")].find((el) => el.textContent.includes("Patchstack"));
      return line.getBoundingClientRect().top < y;
    });
    assert.equal(linkAbove, true, "Everything draws the link line above the reading line");
    await TS.waitForTimeout(900);
    assert.equal((await TS.evaluate(() => window.__screen.visits.slice())).at(-1), "https://example.com/intro", "switching sends no page by itself");
    await TS.mouse.wheel(0, 40);
    await TS.waitForFunction(() => window.__screen.visits.at(-1) === "https://patchstack.com", null, { timeout: 2000 });
    await quietCtx.close();
    ok("Text only switched off just before a hidden link: nothing is sent by the switch, and the page still goes on the main screen once the reader moves on");

    // A wide but short window with the reading line low: the strip goes above the line, every row in view.
    const longRows = `### **SHORT · 00:00**\n\nThe first words to say.\n[Pick up the remote control that lies on the desk next to the keyboard]\nSecond words to say.\n[Look at the second camera on the left side of the room for a while]\nThird words to say.\n[Hold the product box up to the camera so the label can be read clearly]\nFourth words to say.\n[Put the box down again and slide it out of the shot to the right]\nFifth words to say.\n`;
    const shortCtx = await browser.newContext({ ...DESKTOP, viewport: { width: 1240, height: 600 } });
    await shortCtx.addInitScript(() => { localStorage.setItem("prompter-text-only", "on"); localStorage.setItem("prompter-line", "0.75"); });
    const TL = await shortCtx.newPage();
    watch(TL, "text only, short window");
    await TL.goto(await makeLink(longRows, "lex", base));
    await TL.locator(".next-up").waitFor();
    await passEl(TL, "[data-k]", 0, 1); // past the first reminder: the one just done and the next three
    await TL.waitForFunction(() => document.querySelector(".next-up li")?.dataset.state === "done");
    await TL.waitForTimeout(200);
    const shortLook = await TL.evaluate(() => {
      const y = document.querySelector(".reading-line").getBoundingClientRect().top;
      const bar = document.querySelector(".dock-wrap").getBoundingClientRect().top;
      const rows = [...document.querySelectorAll(".next-up li")].filter((el) => getComputedStyle(el).display !== "none").map((el) => el.getBoundingClientRect());
      return { rows: rows.length, inView: rows.every((r) => r.top >= 0 && r.bottom <= bar), clear: rows.every((r) => r.bottom < y - 8 || r.top > y + 8), twoLines: rows.filter((r) => r.height > 30).length };
    });
    assert.deepEqual([shortLook.rows, shortLook.inView, shortLook.clear], [4, true, true], "four rows, all in view above the control bar and clear of the reading line");
    assert.ok(shortLook.twoLines >= 3, "long names take two lines");
    await shot(TL, "text-only-short-window");
    await TL.setViewportSize({ width: 1240, height: 260 });
    await TL.waitForTimeout(200);
    const tiny = await TL.evaluate(() => {
      const bar = document.querySelector(".dock-wrap").getBoundingClientRect().top;
      const rows = [...document.querySelectorAll(".next-up li")].filter((el) => getComputedStyle(el).display !== "none");
      return { first: rows[0] === document.querySelector(".next-up li"), inView: rows.every((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= bar; }) };
    });
    assert.deepEqual(tiny, { first: true, inView: true }, "too short for all of them: the rows furthest ahead wait, the first stays");
    await shortCtx.close();
    ok("Text only on a short wide window: the strip moves above a low reading line with every row in view, and on a window too short for it the rows furthest ahead wait");

    // A hidden camera cue reaches CamFrame at the next spoken line, once per pass, not before.
    const toCam = fakeCamFrame();
    await toCam.start();
    const camOnly = await browser.newContext(DESKTOP);
    await camOnly.addInitScript(() => { localStorage.setItem("prompter-text-only", "on"); localStorage.setItem("prompter-camframe", "on"); });
    const TC = await camOnly.newPage();
    TC.on("pageerror", (e) => errors.push(`text only camframe pageerror: ${e.message}`));
    await TC.goto(textOnlyLink);
    await TC.locator(".section").first().waitFor();
    await TC.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
    const cueAt = await TC.evaluate(() => { const at = document.querySelector('[data-cue="0"]'); const next = at.nextElementSibling; return Math.abs(at.getBoundingClientRect().top - next.getBoundingClientRect().top) <= 2 && next.textContent; });
    assert.equal(cueAt, "Here comes the first screen.", "the cue's place is the start of the next spoken line");
    await passCueOn(TC, 0, -40);
    await TC.mouse.wheel(0, 1);
    await TC.waitForTimeout(400);
    assert.deepEqual(toCam.cues(), [], "not before its spoken line");
    await passCueOn(TC, 0);
    await TC.waitForTimeout(400);
    assert.deepEqual(toCam.cues(), [{ size: "small" }], "reached: sent once");
    await passCueOn(TC, 0, 60);
    await TC.waitForTimeout(300);
    assert.deepEqual(toCam.cues(), [{ size: "small" }], "reading on sends nothing again");
    // Turning Text only off and on again sends no cue by itself.
    await viaSettings(TC, 'input[name="show"][value="all"]');
    await viaSettings(TC, 'input[name="show"][value="text"]');
    await TC.waitForTimeout(400);
    assert.deepEqual(toCam.cues(), [{ size: "small" }], "switching Text only sends nothing");
    // A cue at a section's very end happens at that section's end, as its line would, before the next heading.
    assert.equal(await TC.evaluate(() => document.querySelector('[data-cue="2"]').closest(".sw-end, .section")?.classList.contains("sw-end") && document.querySelector('[data-cue="2"]').closest(".section").dataset.i), "1", "its place is the end of its own section");
    await passCueOn(TC, 2, -40);
    await TC.waitForTimeout(400);
    const sentBefore = toCam.cues().length;
    await passCueOn(TC, 2);
    await TC.waitForTimeout(400);
    assert.deepEqual(toCam.cues().slice(sentBefore), [{ size: "small" }], "sent when the section's end reaches the line");
    assert.equal(await TC.evaluate(() => document.querySelectorAll(".section")[2].getBoundingClientRect().top > document.querySelector(".reading-line").getBoundingClientRect().top), true, "the next heading is still below the line");
    await camOnly.close();
    await toCam.stop();
    ok("Text only: a hidden camera cue still reaches CamFrame when the next spoken line reaches the reading line, once per pass, not before");

    // Phone: a compact card at the top, clear of the script's width, nothing scrolls sideways.
    const toPhone = await browser.newContext(MOBILE);
    await toPhone.addInitScript(() => { localStorage.setItem("prompter-text-only", "on"); });
    const TP = await toPhone.newPage();
    watch(TP, "text only phone");
    await TP.goto(textOnlyLink);
    await TP.locator(".section").first().waitFor();
    await scrollToSection(TP, 1);
    await TP.waitForTimeout(900);
    const card = await TP.evaluate(() => {
      const r = document.querySelector(".next-up").getBoundingClientRect();
      return { fits: r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth, top: r.top, aboveLine: r.bottom < document.querySelector(".reading-line").getBoundingClientRect().top };
    });
    assert.deepEqual([card.fits, card.top < 40, card.aboveLine], [true, true, true], "a card at the top, above the reading line, nothing scrolls sideways");
    assert.equal((await stripRows(TP)).length, 2, "the switch that just happened and the next one");
    assert.equal(await TP.evaluate(() => { const cs = getComputedStyle(document.querySelector(".script")); return cs.paddingLeft === cs.paddingRight; }), true, "the column's sides stay even");
    await shot(TP, "text-only-mobile");
    await toPhone.close();
    // A page with a long name that missed the main screen, with the reading line dragged high: Missed and
    // Open stay in view, and the card moves clear of the line being read.
    const longLink = await makeLink(TEXT_ONLY_SCRIPT.replace("- Intro: https", "- The introduction page with a very long name that keeps on going for a good while: https"), "lex", base);
    const highPhone = await browser.newContext(MOBILE);
    await highPhone.addInitScript(() => { localStorage.setItem("prompter-text-only", "on"); localStorage.setItem("prompter-line", "0.1"); });
    const TH = await highPhone.newPage();
    watch(TH, "text only phone, high line");
    await TH.goto(longLink);
    await TH.locator(".section").first().waitFor();
    await scrollToSection(TH, 1);
    await TH.waitForFunction(() => document.querySelector(".next-up li")?.dataset.state === "missed", null, { timeout: 2000 });
    const high = await TH.evaluate(() => {
      const card = document.querySelector(".next-up").getBoundingClientRect();
      const inCard = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= card.top && r.bottom <= card.bottom && r.left >= card.left && r.right <= card.right; };
      const y = document.querySelector(".reading-line").getBoundingClientRect().top;
      const note = document.querySelector(".dock-wrap").getBoundingClientRect();
      const hint = document.querySelector(".screen-hint");
      return { open: inCard(document.querySelector(".next-up .redo")), missed: inCard(document.querySelector(".next-up .sw-state")), clear: card.bottom < y || card.top > y + 60,
        hint: !hint.hidden, uncovered: card.bottom <= note.top };
    });
    assert.deepEqual(high, { open: true, missed: true, clear: true, hint: true, uncovered: true }, "Missed and Open in view; the card clear of the reading line and above the main screen note");
    await shot(TH, "text-only-mobile-high-line");
    await highPhone.close();
    // The Producer's cue pill on a phone with the line high: the card never covers the pill or the line,
    // with the pill just above the line, or low above the control bar on a short screen.
    if (mode === "wrangler") {
      const { token: stripToken } = await (await fetch(`${base}/api/agent-token`, { method: "POST" })).json();
      const pillPhone = await browser.newContext(MOBILE);
      await pillPhone.addInitScript(([t]) => {
        localStorage.setItem("prompter-text-only", "on");
        localStorage.setItem("prompter-line", "0.12");
        if (!localStorage.getItem("prompter-agent")) localStorage.setItem("prompter-agent", JSON.stringify({ token: t, createdAt: Date.now() }));
      }, [stripToken]);
      const TQ = await pillPhone.newPage();
      watch(TQ, "text only phone, cue pill");
      await TQ.goto(textOnlyLink);
      await TQ.locator(".section").first().waitFor();
      assert.equal((await agentRpc(stripToken, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } })).status, 200);
      await TQ.waitForFunction(() => document.querySelector(".open-btn").dataset.dot === "on");
      await agentCall(stripToken, "push_suggestions", { items: [{ kind: "point", text: "The cookie is the proof of login." }] });
      await TQ.locator(".ask-pill").waitFor();
      const apart = () => TQ.evaluate(() => {
        const box = (sel) => document.querySelector(sel).getBoundingClientRect();
        const card = box(".next-up");
        const pill = box(".ask-pill");
        const y = box(".reading-line").top;
        const overlap = !(card.bottom <= pill.top || card.top >= pill.bottom || card.right <= pill.left || card.left >= pill.right);
        return { place: document.querySelector(".ask-pill").dataset.place, overlap, clear: card.bottom < y || card.top > y + 60 };
      });
      assert.deepEqual(await apart(), { place: "above", overlap: false, clear: true }, "the pill just above the line, the card clear of both");
      // The cue box covers the card: the keyboard cannot reach it behind the box.
      await TQ.locator(".ask-pill").click();
      await TQ.locator(".ask-box").waitFor();
      assert.equal(await TQ.evaluate(() => document.querySelector(".next-up").inert), true, "the card is out of reach while the cue box shows");
      for (const key of ["Shift+Tab", "Shift+Tab", "Tab", "Tab", "Tab"]) {
        await TQ.keyboard.press(key);
        assert.equal(await TQ.evaluate(() => Boolean(document.activeElement?.closest(".next-up"))), false, `${key} never reaches the card behind the cue box`);
      }
      await TQ.keyboard.press("Escape");
      await TQ.waitForFunction(() => !document.querySelector(".next-up").inert);
      await agentCall(stripToken, "push_suggestions", { items: [{ kind: "point", text: "The session cookie proves the login." }] }); // Esc skipped the first
      await TQ.locator(".ask-pill").waitFor();
      await TQ.waitForFunction(() => document.querySelector(".ask-pill").dataset.place === "above");
      await TQ.setViewportSize({ width: 390, height: 440 });
      await TQ.waitForFunction(() => document.querySelector(".ask-pill").dataset.place === "low");
      assert.deepEqual(await apart(), { place: "low", overlap: false, clear: true }, "on a short screen the pill goes low, and the card above it");
      await pillPhone.close();
    }
    // A script with nothing hidden: Text only draws the column exactly where Everything does.
    const plainCtx = await browser.newContext(DESKTOP);
    await plainCtx.addInitScript(() => { localStorage.setItem("prompter-text-only", "on"); });
    const TPl = await plainCtx.newPage();
    watch(TPl, "text only, nothing hidden");
    await TPl.goto(await makeLink("### **ONLY WORDS · 00:00**\n\nJust words to say here.\nAnd a few more of them.\n", "lex", base));
    await TPl.locator(".section").first().waitFor();
    const colBox = () => TPl.evaluate(() => { const r = document.querySelector("[data-k]").getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; });
    const textOnlyBox = await colBox();
    assert.equal(await TPl.locator(".next-up").isVisible(), false, "no strip with nothing hidden");
    await viaSettings(TPl, 'input[name="show"][value="all"]');
    assert.deepEqual(await colBox(), textOnlyBox, "the column stays where Everything puts it");
    await plainCtx.close();
    // Beside the strip the column keeps the width the reader chose wherever the strip fits beside it, and
    // never loses much of it; under 1240px wide the card takes the strip's place and the column stays as is.
    const widthCtx = await browser.newContext(DESKTOP);
    const TW = await widthCtx.newPage();
    watch(TW, "text only widths");
    await TW.goto(textOnlyLink);
    await TW.locator(".section").first().waitFor();
    const colWidth = () => TW.evaluate(() => {
      const m = document.querySelector(".script");
      const cs = getComputedStyle(m);
      const strip = document.querySelector(".next-up").getBoundingClientRect();
      const right = Math.max(...[...document.querySelectorAll("[data-k]")].map((el) => el.getBoundingClientRect().right));
      return { w: Math.round(m.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), side: getComputedStyle(document.querySelector(".next-up")).backgroundColor === "rgba(0, 0, 0, 0)", clear: strip.width === 0 || strip.left >= right || strip.bottom <= document.querySelector(".reading-line").getBoundingClientRect().top };
    });
    for (const [width, height, choice] of [[1920, 1080, "medium"], [1440, 900, "medium"], [1280, 800, "medium"], [1280, 800, "narrow"], [1024, 768, "medium"], [1920, 1080, "full"]]) {
      await TW.setViewportSize({ width, height });
      await viaSettings(TW, `input[name="width"][value="${choice}"]`);
      await viaSettings(TW, 'input[name="show"][value="all"]');
      const all = await colWidth();
      await viaSettings(TW, 'input[name="show"][value="text"]');
      const text = await colWidth();
      const at = `${width}px, ${choice} width`;
      assert.equal(text.clear, true, `${at}: the strip covers no word`);
      if (width < 1240) assert.deepEqual([text.side, text.w], [false, all.w], `${at}: the card, and the column as in Everything`);
      else {
        assert.equal(text.side, true, `${at}: the strip beside the text`);
        assert.ok(text.w >= 0.8 * all.w, `${at}: the column keeps most of its width (${text.w} of ${all.w}px)`);
        const room = (width - all.w) / 2;
        if (room >= 232) assert.equal(text.w, all.w, `${at}: with room for the strip the column keeps its width`);
      }
    }
    await widthCtx.close();
    ok("Text only on a phone: the strip is a compact card at the top with two rows, above the reading line; nothing scrolls sideways");
  }

  // ---- Offline (file://) ----
  const offline = await browser.newContext(DESKTOP);
  const o = await offline.newPage();
  watch(o, "offline");
  const fileUrl = pathToFileURL(join(dist, "index.html")).href;
  await o.goto(fileUrl);
  await showsStart(o);
  assert.equal(await o.evaluate(() => document.fonts.size), 0, "offline copies use system fonts and request no font file");
  // No relay offline: Copy MCP copies the open server's message, with Copied and a check; no live states.
  await clip(o);
  const oCopy = o.locator(".empty .mcp-action");
  assert.deepEqual([await oCopy.textContent(), await oCopy.getAttribute("data-state"), await oCopy.locator(".status-dot").isVisible()], ["Copy MCP", "offline", false]);
  await oCopy.click();
  await o.waitForFunction(() => window.__copied.length === 1);
  const offlinePrompt = await o.evaluate(() => window.__copied[0]);
  assert.ok(offlinePrompt.includes("Server: `https://prompter.techies.tools/mcp` (open, no sign-in)"), "an offline copy names the public, open server");
  assert.doesNotMatch(offlinePrompt, /Bearer|show_script/);
  assert.deepEqual([await oCopy.textContent(), await oCopy.locator(".i-check").isVisible()], ["Copied", true]);
  assert.equal(await o.evaluate(() => localStorage.getItem("prompter-agent")), null, "no token offline");
  await o.locator('.empty [data-action="demo"]').click();
  await o.waitForFunction((n) => document.querySelectorAll(".section").length === n, DEMO_SECTIONS);
  await o.goto(fileUrl + new URL(link).hash);
  await o.locator(".section").first().waitFor();
  await o.waitForFunction(() => document.querySelectorAll(".section").length === 5);
  const embedded = join(out, "offline-embedded.html");
  const sample = join(out, "sample.md");
  writeFileSync(sample, EXAMPLE_SCRIPT);
  execFileSync(process.execPath, [resolve(import.meta.dirname, "../../scripts/embed.mjs"), sample, embedded], { env: { ...process.env, PROMPTER_DIST: dist } });
  await o.goto(pathToFileURL(embedded).href);
  await o.locator(".section").first().waitFor();
  assert.equal(await o.locator(".section").count(), 5);
  // The CamFrame link from a file:// copy: CamFrame sees the cue from Origin "null".
  const fileCam = fakeCamFrame();
  await fileCam.start();
  await o.goto(fileUrl + new URL(await makeLink(CUE_SCRIPT, "lex", base)).hash);
  await o.locator(".section").first().waitFor();
  await viaSettings(o, ".camframe");
  await o.waitForFunction(() => document.querySelector(".camframe").dataset.state === "on");
  await passCueOn(o, 0);
  await o.waitForTimeout(700);
  assert.deepEqual(fileCam.cues(), [{ size: "small" }]);
  assert.ok(fileCam.seen.length && fileCam.seen.every((r) => r.origin === "null"), "a file:// copy calls CamFrame from Origin null");
  await fileCam.stop();
  await offline.close();
  ok("offline: file:// start screen (Copy MCP copies the open server's message, no live states) and demo, file:// #s= link and an embedded offline copy all work; the CamFrame link from a file:// copy sends its cue with Origin null");

  assert.deepEqual(errors, [], errors.join("\n"));
  ok("no page or console errors");
  return { mode, base, link, checks, screenshots };
}
