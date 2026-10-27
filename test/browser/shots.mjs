// Browser checks and screenshots for `kit shots`. Runs against a local server
// (wrangler dev or a static server) and against dist/index.html via file://.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEMO_SCRIPT, EXAMPLE_SCRIPT, makeLink, parse } from "../../src/core.mjs";

const DESKTOP = { viewport: { width: 1366, height: 900 } };
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DEMO_SECTIONS = parse(DEMO_SCRIPT).length;

// Replaces the browser's speech recognition with one the test drives:
// window.__speech.say("words") delivers a result to the running instance.
const SPEECH_STUB = () => {
  const state = { started: 0, aborted: 0, instance: null, results: [] };
  class FakeRecognition {
    start() { state.started++; state.instance = this; }
    stop() { this.onend?.(); }
    abort() { state.aborted++; }
  }
  state.say = (text) => {
    state.results.push([{ transcript: text }]);
    state.instance?.onresult?.({ results: state.results, resultIndex: state.results.length - 1 });
  };
  state.fail = (error) => state.instance?.onerror?.({ error });
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
  const watch = (page, label) => {
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${label} console: ${m.text()}`); });
  };
  const noOverflow = async (page, label) => {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${label}: page is ${sw}px wide in a ${iw}px viewport`);
  };
  const scrollToSection = (page, i) => page.evaluate((n) => {
    const el = document.querySelectorAll(".section")[n];
    window.scrollTo(0, el.offsetTop - window.innerHeight * 0.34 + 2);
  }, i);

  // ---- Desktop: landing shows the demo ----
  const desktop = await browser.newContext(DESKTOP);
  await desktop.addInitScript(NO_SPEECH);
  const page = await desktop.newPage();
  watch(page, "desktop");
  await page.goto(`${base}/`);
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), DEMO_SECTIONS);
  assert.equal(await page.evaluate(() => location.hash), "", "the demo keeps a clean address");
  assert.equal(await page.locator('[data-action="home"], .problems-btn, #home, .bar').count(), 0, "no Home, no Check, no start page, no top toolbar");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), NIGHT);
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(await page.evaluate(() => [document.fonts.check("600 52px Inter"), document.fonts.check("500 12px 'Roboto Mono'"), [...document.fonts].map((f) => f.status)]),
    [true, true, ["loaded", "loaded"]], "Inter and Roboto Mono load under the CSP");
  // The settings sidebar is open on a wide screen, the control bar floats at the bottom centre.
  assert.equal(await page.evaluate(() => document.documentElement.dataset.side), "open");
  assert.equal(await page.locator(".side-toggle").getAttribute("aria-expanded"), "true");
  assert.deepEqual(await page.locator(".group-label").allTextContents(), ["01Script", "02Reading", "03Voice", "04Main screen", "05Clock", "06Keys"]);
  assert.match(await page.locator(".side-head").textContent(), /Prompter\s*v0\.2[\s\S]*by Techies/);
  const dockBox = await page.locator(".dock").boundingBox();
  const scriptBox = await page.locator(".script").boundingBox();
  assert.ok(Math.abs(dockBox.x + dockBox.width / 2 - (scriptBox.x + scriptBox.width / 2)) < 2, "the control bar is centred under the script");
  assert.ok(dockBox.y + dockBox.height <= 900 && dockBox.y > 900 - 100, `control bar at ${Math.round(dockBox.y)}px`);
  assert.deepEqual(await page.evaluate(() => {
    const p = document.querySelector(".section p.say");
    const t = document.querySelector(".section .title");
    return [getComputedStyle(p).textAlign, getComputedStyle(t).justifyContent];
  }), ["center", "center"], "script text and section titles are centred");
  const prep = page.locator(".section").first();
  assert.equal(await prep.locator(".actions label.btn input[type=file]").count(), 1);
  assert.equal(await prep.locator('.actions [data-action="paste"]').count(), 1);
  assert.match(await prep.locator(".actions .drop-hint").textContent(), /drop a file anywhere/);
  assert.equal(await prep.locator('.actions [data-action="ai"]').count(), 1);
  assert.match(await prep.locator(".note").textContent(), /Scripts stay on your device/);
  assert.equal(await page.locator(".voice").isHidden(), true, "Follow my voice is hidden without the speech API");
  await shot(page, "demo-prep-desktop");
  assert.equal(await page.locator(".voice-row").isHidden(), true);
  assert.equal(await page.locator(".no-voice").isVisible(), true, "the sidebar says where Follow my voice works");
  assert.equal(await prep.locator(".actions .btn.primary").count(), 1, "one orange primary action");
  ok("landing opens the demo: centred PREP buttons, drop hint, privacy note; settings sidebar 01–06 and the floating control bar; indigo page; Inter and Roboto Mono; no top toolbar; no voice button without the API");

  await prep.locator('[data-action="ai"]').click();
  await page.locator("#demo-ai .ai-panel").waitFor();
  const mcpRe = new RegExp(`^${base.replace(/[.:/]/g, "\\$&")}/mcp$`);
  assert.match(await page.locator("#demo-ai .mcp-url").textContent(), mcpRe);
  assert.match(await page.locator("#demo-ai .ai-panel").textContent(), /Claude[\s\S]*ChatGPT[\s\S]*Codex and T3 Code[\s\S]*within a few minutes of your last request/);
  assert.equal(await prep.locator('[data-action="ai"]').getAttribute("aria-expanded"), "true");
  await page.locator('#demo-ai [data-action="copy-mcp"]').waitFor();
  await shot(page, "demo-ai-desktop");
  await page.locator(".side-ai > summary").click();
  await page.locator(".side-ai .ai-panel").waitFor();
  assert.match(await page.locator(".side-ai .mcp-url").textContent(), mcpRe);
  await page.locator(".side-ai > summary").click();
  ok("Use your AI (demo and sidebar) shows this server's /mcp address, a copy button and Claude, ChatGPT and Codex/T3 steps");

  // Inactive lines stay readable: their colour is the AA dim token, not faded with opacity.
  const looks = await page.evaluate(() => {
    const other = document.querySelector('.section:not(.active) p.say');
    const cs = getComputedStyle(other);
    return { color: cs.color, opacity: getComputedStyle(other.closest(".section")).opacity };
  });
  assert.deepEqual(looks, { color: "oklch(0.64 0.04 282)", opacity: "1" });
  ok("other sections use the dim AA colour (--dim, oklch 64% 0.04 282) at full opacity");

  // Paste from the demo.
  await prep.locator('[data-action="paste"]').click();
  await page.locator(".paste-dialog[open]").waitFor();
  await page.locator('[data-action="open-paste"]').click();
  await page.locator(".paste-error:not([hidden])").waitFor();
  await page.locator("#paste-text").fill("### **HELLO · 00:00**\n\nQL: Is this pasted?\n\nYes, pasted.");
  await page.locator('[data-action="open-paste"]').click();
  await page.locator(".paste-dialog:not([open])").waitFor({ state: "attached" });
  assert.equal(await page.locator(".section").count(), 1);
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  ok("Paste a script: empty text shows an error; a script opens and gets a #s= address");

  // Remembered last script opens on the next visit; the Open menu brings back the demo.
  await page.goto(`${base}/`);
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), 1);
  assert.match(await page.locator(".status").textContent(), /last script/i);
  await page.locator('.sidebar [data-action="demo"]').click();
  await page.waitForFunction((n) => document.querySelectorAll(".section").length === n, DEMO_SECTIONS);
  ok("a remembered script opens without a link; Settings › Back to demo returns to the demo");

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
  await page.locator(".dock .next").click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".section.active").getAttribute("data-i"), "3");
  await page.locator(".dock .prev").click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".section.active").getAttribute("data-i"), "2");
  await shot(page, "ql-section-desktop");
  ok("link opens the example: 5 sections, QL first, 4 link chips, &p=lex kept; arrow keys and the bar's previous/next move sections");

  // Play is the orange primary button; it toggles auto-scroll like Space.
  await page.locator(".dock .auto").click();
  assert.equal(await page.locator(".dock .auto").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".dock .auto").getAttribute("data-tip"), "Pause · Space");
  await page.keyboard.press(" ");
  assert.equal(await page.locator(".dock .auto").getAttribute("aria-pressed"), "false", "Space on the focused play button toggles once");
  await page.locator(".dock .clock").click();
  assert.equal(await page.locator(".dock .clock").getAttribute("data-running"), "true");
  assert.equal(await page.locator(".sidebar .start").textContent(), "Restart clock");
  await scrollToSection(page, 2);
  await page.locator(".dock .next").hover();
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".dock .next").evaluate((el) => getComputedStyle(el, "::after").opacity), "1", "tooltip on hover");
  const dockClip = await page.locator(".dock").boundingBox();
  await page.screenshot({ path: join(out, "dock-desktop.png"), clip: { x: dockClip.x - 40, y: dockClip.y - 60, width: dockClip.width + 80, height: dockClip.height + 70 } });
  screenshots.push(join(out, "dock-desktop.png"));
  await page.mouse.move(700, 300);
  ok("play (orange) toggles auto-scroll, Space on it toggles once; the clock starts from the bar; tooltips on hover");

  // Reading mode: hiding the sidebar leaves the script and the bar; remembered.
  await page.locator(".side-close").click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.side), "closed");
  await page.waitForTimeout(400); // the sidebar slides out
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  const fullBox = await page.locator(".script").boundingBox();
  assert.ok(Math.abs(fullBox.x + fullBox.width / 2 - 683) < 2, "the script is centred on the whole window");
  await shot(page, "reading-mode-desktop");
  await page.reload();
  await page.locator(".section").first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.side), "closed", "a closed sidebar stays closed");
  await page.locator(".dock .side-toggle").click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.side), "open");
  ok("hiding the sidebar leaves only the script and the floating bar (reading mode), centred; the choice is remembered");

  // Sliders and column width, remembered after a reload.
  await page.locator(".size").fill("70");
  await page.locator(".speed").fill("120");
  await page.locator(".width").selectOption("narrow");
  const narrow = await page.locator(".script").evaluate((el) => el.getBoundingClientRect().width - parseFloat(getComputedStyle(el).paddingLeft) * 2);
  assert.ok(Math.abs(narrow - 600) < 2, `narrow column is ${narrow}px`);
  await page.reload();
  await page.locator(".section").first().waitFor();
  assert.deepEqual(await page.evaluate(() => [
    getComputedStyle(document.documentElement).getPropertyValue("--size").trim(),
    document.querySelector(".size").value, document.querySelector(".speed").value, document.querySelector(".width").value,
  ]), ["70px", "70", "120", "narrow"]);
  await page.keyboard.press("+");
  await page.keyboard.press("]");
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".size").value, document.querySelector(".speed").value]), ["74", "130"]);
  await page.keyboard.press("-");
  await scrollToSection(page, 2);
  await page.waitForTimeout(250);
  await shot(page, "narrow-column-desktop");
  assert.deepEqual(await page.locator(".sidebar .val").allTextContents(), ["130", "70 px", "Not connected"]);
  await page.locator(".sidebar").screenshot({ path: join(out, "sidebar-desktop.png") });
  screenshots.push(join(out, "sidebar-desktop.png"));
  ok("speed and size sliders and the column width are remembered, with their values on the right; keys move the sliders");
  await page.locator(".width").selectOption("full");

  // A link made for the default preset keeps it, even after Lex was chosen.
  await page.goto(await makeLink(EXAMPLE_SCRIPT.replace("Thanks for watching.", "Thanks a lot for watching."), "default", base));
  await page.locator(".section").first().waitFor();
  assert.doesNotMatch(await page.evaluate(() => location.hash), /&p=/);
  assert.equal(await page.evaluate(() => localStorage.getItem("prompter-preset")), "default");
  ok("default links keep the default preset");

  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/`);
  await page.waitForFunction((n) => document.querySelectorAll(".section").length === n, DEMO_SECTIONS);
  await page.goto(`${base}/${new URL(link).hash}`);
  await page.waitForFunction(() => document.querySelectorAll(".section").length === 5);
  await page.goBack();
  await page.waitForFunction((n) => document.querySelectorAll(".section").length === n, DEMO_SECTIONS);
  assert.equal(await page.evaluate(() => location.hash), "");
  ok("Back from a link to the plain address returns to the demo");

  await page.goto(`${base}/#s=@@@`);
  await page.locator(".note-row.alert:not([hidden])").waitFor();
  assert.match(await page.locator(".alert-text").textContent(), /could not be opened: Link data is damaged/);
  assert.equal(await page.locator(".section").count(), DEMO_SECTIONS);
  ok("a damaged link shows a plain error over the demo");
  await desktop.close();

  // Reduced motion: no colour fade between sections.
  const calm = await browser.newContext({ ...DESKTOP, reducedMotion: "reduce" });
  const calmPage = await calm.newPage();
  await calmPage.goto(link);
  await calmPage.locator(".section").first().waitFor();
  const duration = await calmPage.locator(".section p").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  assert.equal(duration, "0s");
  await calm.close();
  ok("prefers-reduced-motion removes the section fade");

  // ---- Follow my voice (stubbed speech recognition) ----
  const voiced = await browser.newContext(DESKTOP);
  await voiced.addInitScript(SPEECH_STUB);
  const v = await voiced.newPage();
  watch(v, "voice");
  await v.goto(link);
  await v.locator(".section").first().waitFor();
  await v.locator(".voice").waitFor();
  await v.locator(".auto").click();
  assert.equal(await v.locator(".auto").getAttribute("aria-pressed"), "true");
  await v.locator(".voice").click();
  await v.locator(".voice-notice:not([hidden])").waitFor();
  assert.match(await v.locator(".voice-notice").textContent(), /speech service[\s\S]*Google[\s\S]*Your script stays on this device/);
  assert.equal(await v.evaluate(() => window.__speech.started), 0, "nothing listens before consent");
  await shot(v, "voice-notice-desktop");
  await v.locator('[data-action="voice-ok"]').click();
  assert.equal(await v.evaluate(() => window.__speech.started), 1);
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "true");
  assert.equal(await v.locator(".voice-switch").getAttribute("aria-checked"), "true", "the sidebar switch follows");
  assert.equal(await v.locator(".auto").getAttribute("aria-pressed"), "false", "auto-scroll pauses");
  await v.evaluate(() => window.__speech.say("writing scripts takes too long"));
  await v.waitForFunction(() => document.querySelector("p.cur")?.textContent === "Writing scripts takes too long.");
  await v.evaluate(() => window.__speech.say("reading them looks"));
  await v.waitForFunction(() => document.querySelector("p.cur")?.textContent === "Reading them looks stiff.");
  await v.evaluate(() => window.__speech.say("hi i'm sam welcome"));
  await v.waitForFunction(() => document.querySelector("p.cur")?.textContent === "Hi, I'm Sam. Welcome.");
  await v.waitForFunction(() => {
    const top = document.querySelector("p.cur").getBoundingClientRect().top;
    return Math.abs(top - window.innerHeight * 0.34) < 12;
  });
  await shot(v, "voice-follow-desktop");
  // QL lines are never followed: saying the QL keeps the current line.
  await v.evaluate(() => window.__speech.say("why one question per section"));
  await v.waitForTimeout(100);
  assert.equal(await v.locator("p.cur").textContent(), "Hi, I'm Sam. Welcome.");
  await v.evaluate(() => window.__speech.fail("not-allowed"));
  await v.locator(".note-row.alert:not([hidden])").waitFor();
  assert.match(await v.locator(".alert-text").textContent(), /microphone is blocked/);
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "false");
  assert.equal(await v.locator(".auto").getAttribute("aria-pressed"), "true", "auto-scroll resumes");
  await v.locator(".auto").click();
  // Consent is remembered: the second time it starts at once.
  await v.reload();
  await v.locator(".voice").click();
  assert.equal(await v.locator(".voice-notice").isHidden(), true);
  assert.equal(await v.evaluate(() => window.__speech.started), 1);
  await v.locator(".voice").click();
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "false");
  await voiced.close();
  ok("Follow my voice: shown with the API, notice before first use, follows spoken lines to the reading line, skips QL, pauses auto-scroll, handles a blocked mic, remembers consent");

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
  assert.deepEqual(await intro.locator(".links .link").allTextContents(), ["↗1 · Introexample.com", "↗2 · Patchstackpatchstack.com"], "every link still gets a numbered chip at the top");
  assert.equal(await intro.locator(".links .link .arrow").first().evaluate((el) => getComputedStyle(el).color), "oklch(0.65 0.227 32.3)", "orange arrow");
  const markEl = intro.locator(".mark");
  assert.equal(await markEl.textContent(), "↗ Patchstack · opens here");
  assert.equal(await markEl.getAttribute("data-k"), null, "the marker is not a spoken line");
  assert.equal(await L.evaluate(() => document.querySelector(".section:nth-child(2) .mark").previousElementSibling.textContent), "Patchstack finds the holes.");
  await L.locator(".connect").click();
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
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.34 - 2 + d);
  }, [sel, dy]);
  await passMark(L, ".section:nth-child(2) .mark");
  await L.waitForTimeout(300);
  assert.equal(await lastVisit(), "https://example.com/intro", "waits for the settle delay");
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://patchstack.com", null, { timeout: 2000 });
  assert.equal(await markEl.getAttribute("data-shown"), "true");
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
  await L.locator(".voice").click();
  assert.equal(await L.locator(".voice").getAttribute("aria-pressed"), "true");
  await L.evaluate(() => window.__speech.say("and then wordfence"));
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://www.wordfence.com", null, { timeout: 2000 });
  await L.evaluate(() => window.__speech.say("and then wordfence blocks it"));
  await L.waitForTimeout(100);
  assert.equal((await visits()).filter((u) => u === "https://www.wordfence.com").length, 1, "the same label heard again does not reopen it");
  // The main screen moves on (a link chip); saying the label again reopens it.
  await L.keyboard.press("1");
  assert.equal(await lastVisit(), "https://example.com/intro");
  await L.evaluate(() => window.__speech.say("back to wordfence"));
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://www.wordfence.com", null, { timeout: 2000 });
  assert.equal((await visits()).filter((u) => u === "https://www.wordfence.com").length, 2, "reopened after the screen moved");
  await L.locator(".voice").click();
  ok("Follow my voice: saying a link's label (next section) opens it at once; heard again it reopens only after the main screen moved");
  // A link on the last line of a section: its marker is the last thing there and opens once passed.
  const lastMark = ".section:nth-child(4) .mark";
  assert.equal(await L.evaluate((q) => document.querySelector(q) === document.querySelector(q).parentElement.lastElementChild, lastMark), true);
  await passMark(L, lastMark, 2);
  await L.waitForFunction(() => window.__screen.visits.at(-1) === "https://docs.example.com", null, { timeout: 2000 });
  ok("a link on a section's last line opens once the reading line passes it");
  await linked.close();

  // The demo's inline video link: YouTube plays in the page's own #player view.
  const demoLinked = await browser.newContext(DESKTOP);
  await demoLinked.addInitScript(SCREEN_STUB);
  const D = await demoLinked.newPage();
  watch(D, "demo inline link");
  await D.goto(`${base}/`);
  await D.locator(".section").first().waitFor();
  await D.locator(".connect").click();
  const demoMark = D.locator(".section .mark");
  assert.equal(await demoMark.count(), 1, "the demo shows one inline link");
  assert.equal(await demoMark.textContent(), "↗ Example video · opens here");
  await passMark(D, ".section .mark", 2);
  await D.waitForFunction(() => /#player=aqz-KE-bpKQ&start=0$/.test(window.__screen.visits.at(-1) || ""), null, { timeout: 2000 });
  await shot(D, "inline-link-demo-desktop");
  ok("the demo's inline YouTube link opens the full-window #player view");
  await demoLinked.close();

  // No main screen: one gentle hint, once, above the control bar.
  const hinted = await browser.newContext(DESKTOP);
  const H = await hinted.newPage();
  watch(H, "screen hint");
  await H.goto(inlineLink);
  await H.locator(".section").first().waitFor();
  await scrollToSection(H, 1);
  await H.locator(".screen-hint:not([hidden])").waitFor({ timeout: 2000 });
  assert.match(await H.locator(".hint-text").textContent(), /“Intro” would open on your main screen now/);
  assert.equal(await H.locator(".connect").getAttribute("data-hint"), "true");
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
  assert.equal(await HC.locator(".connect").getAttribute("data-hint"), null);
  assert.equal(await HC.evaluate(() => window.__screen.visits.at(-1)), "https://example.com/intro");
  assert.equal(await HC.locator(".screen-state").textContent(), "Connected");
  await hintConnect.close();
  ok("without a main screen nothing opens; a one-time hint above the control bar; its Connect button hides it, clears the highlight and shows the current link");

  // ---- Mobile ----
  const mobile = await browser.newContext(MOBILE);
  await mobile.addInitScript(SPEECH_STUB);
  await mobile.addInitScript(() => localStorage.setItem("prompter-sidebar", "open"));
  const m = await mobile.newPage();
  watch(m, "mobile");
  await m.goto(`${base}/`);
  await m.locator(".section").first().waitFor();
  await noOverflow(m, "mobile demo");
  assert.equal(await m.evaluate(() => document.documentElement.dataset.side), "closed", "phones start with the settings closed");
  assert.equal(await m.locator(".sidebar").isVisible(), false);
  const mobileDock = await m.locator(".dock").boundingBox();
  assert.ok(mobileDock.x >= 0 && mobileDock.x + mobileDock.width <= 390, `control bar ${Math.round(mobileDock.width)}px fits`);
  assert.ok(Math.abs(mobileDock.x + mobileDock.width / 2 - 195) < 2, "control bar centred");
  const tops = await m.locator(".dock > button:not([hidden])").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, `control bar is one row: ${tops}`);
  assert.ok(await m.locator(".dock .auto").evaluate((el) => el.getBoundingClientRect().height >= 44), "44px touch targets");
  await shot(m, "demo-prep-mobile");
  await m.locator('.actions [data-action="ai"]').click();
  await noOverflow(m, "mobile AI panel");
  await shot(m, "demo-ai-mobile");
  await m.goto(link);
  await m.locator(".section").first().waitFor();
  await noOverflow(m, "mobile prompter");
  await scrollToSection(m, 2);
  await m.waitForTimeout(250);
  await shot(m, "ql-section-mobile");
  // The settings open as a bottom sheet over a dimmed page.
  await m.locator(".dock .side-toggle").click();
  await m.locator(".sidebar .size").waitFor();
  await m.waitForTimeout(350);
  await noOverflow(m, "mobile settings open");
  const sheet = await m.locator(".sidebar").boundingBox();
  assert.ok(Math.round(sheet.x) === 0 && Math.round(sheet.width) === 390 && sheet.y + sheet.height <= 845 && sheet.y > 100, `sheet at ${JSON.stringify(sheet)}`);
  assert.equal(await m.locator(".scrim").isVisible(), true);
  await m.locator(".sidebar .width").selectOption("narrow");
  await shot(m, "sidebar-mobile");
  await m.locator(".side-close").click();
  assert.equal(await m.evaluate(() => document.documentElement.dataset.side), "closed");
  await m.locator(".dock .side-toggle").click();
  await m.waitForTimeout(350);
  await m.locator(".scrim").click({ position: { x: 195, y: 40 } });
  assert.equal(await m.evaluate(() => document.documentElement.dataset.side), "closed", "tapping the dimmed page closes the sheet");
  assert.equal(await m.evaluate(() => localStorage.getItem("prompter-sidebar")), "open", "phones do not change the remembered desktop choice");
  await m.locator(".dock .voice").click();
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
  ok("mobile 390px: settings closed by default, a bottom sheet with sliders and column (closes by ×, by tapping the page), a one-row centred control bar with 44px targets, no sideways scroll, voice notice and hint fit", `bar ${Math.round(mobileDock.width)}px`);
  await mobile.close();

  // ---- Offline (file://) ----
  const offline = await browser.newContext(DESKTOP);
  const o = await offline.newPage();
  watch(o, "offline");
  const fileUrl = pathToFileURL(join(dist, "index.html")).href;
  await o.goto(fileUrl);
  await o.locator(".section").first().waitFor();
  assert.equal(await o.locator(".section").count(), DEMO_SECTIONS);
  assert.equal(await o.evaluate(() => document.fonts.size), 0, "offline copies use system fonts and request no font file");
  await o.locator('.actions [data-action="ai"]').click();
  assert.equal(await o.locator("#demo-ai .mcp-url").textContent(), "https://prompter.techies.tools/mcp");
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
  await offline.close();
  ok("offline: file:// demo, file:// #s= link and an embedded offline copy all work");

  assert.deepEqual(errors, [], errors.join("\n"));
  ok("no page or console errors");
  return { mode, base, link, checks, screenshots };
}
