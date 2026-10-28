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
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${label} console: ${m.text()}`); });
  };
  const noOverflow = async (page, label) => {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${label}: page is ${sw}px wide in a ${iw}px viewport`);
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
  assert.deepEqual(await card.locator(".choices .btn:not([hidden])").allTextContents(), ["Open a script file", "Paste a script", "Use your AI", "Try the demo"]);
  assert.equal(await card.locator(".btn.primary").textContent(), "Open a script file", "one orange primary action");
  assert.match(await card.textContent(), /drop a \.md or \.txt file anywhere[\s\S]*Your script stays on this device/);
  const cardBox = await card.boundingBox();
  assert.ok(Math.abs(cardBox.x + cardBox.width / 2 - 683) < 2 && Math.abs(cardBox.y + cardBox.height / 2 - 450) < 2, `card centred: ${JSON.stringify(cardBox)}`);
  assert.equal(await card.evaluate((el) => getComputedStyle(el).textAlign), "start", "card text starts on the left");
  await shot(page, "start-desktop");
  ok("the plain address shows the start screen: a centred card with one orange Open a script file, Paste, Use your AI, Try the demo, the drop hint and the privacy line; no sidebar, no bar, no script; indigo page; Inter and Roboto Mono");

  // Open a script file is a real button: Enter on it opens the file picker.
  await card.locator('[data-action="open-file"]').focus();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
  await chooser.setFiles({ name: "talk.md", mimeType: "text/markdown", buffer: Buffer.from("### **PREP**\n\n- Water\n\n### **MY TALK · 00:00**\n\nQL: Is this my file?\n\nYes, my file.") });
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), 2);
  assert.match(await page.locator(".status").textContent(), /Loaded talk\.md/);
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  await page.goBack();
  await showsStart(page);
  assert.equal(await card.locator(".continue").textContent(), "Continue: MY TALK", "the last script is offered by its first section after PREP");
  assert.deepEqual(await card.locator(".choices .btn:not([hidden])").allTextContents(), ["Continue: MY TALK", "Open a script file", "Paste a script", "Use your AI", "Try the demo"]);
  await shot(page, "start-continue-desktop");
  await page.reload();
  await showsStart(page);
  assert.equal(await page.locator(".section").count(), 0, "a remembered script is offered, never opened by itself");
  await card.locator(".continue").click();
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), 2);
  ok("Open a script file works from the keyboard (file picker); Back returns to the start screen, which offers “Continue: MY TALK” first and opens nothing by itself, also after a reload");

  // Try the demo: the format by example, no buttons in PREP.
  await page.goto(`${base}/`);
  await showsStart(page);
  await card.locator('[data-action="demo"]').click();
  await page.waitForFunction((n) => document.querySelectorAll(".section").length === n, DEMO_SECTIONS);
  assert.equal(await page.evaluate(() => location.hash), "#demo");
  const prep = page.locator(".section").first();
  assert.equal(await prep.locator(".actions, button, label, input").count(), 0, "the demo's PREP has no buttons");
  assert.deepEqual(await prep.locator("p.bullet").allTextContents(), ["Water within reach", "Phone on silent", "Camera at eye level", "Text right under the lens", "Read it once aloud"]);
  assert.equal(await page.locator(".dock").isVisible(), true);
  assert.equal(await page.locator(".voice").isHidden(), true, "Follow my voice is hidden without the speech API");
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(await page.evaluate(() => [document.fonts.check("600 52px Inter"), document.fonts.check("500 12px 'Roboto Mono'"), [...document.fonts].map((f) => f.status)]),
    [true, true, ["loaded", "loaded"]], "Inter and Roboto Mono load under the CSP");
  // Text starts on the left inside a centred column; section title left, time right.
  const layout = await page.evaluate(() => {
    const sec = document.querySelectorAll(".section")[1];
    const say = sec.querySelector("p.say");
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
    ["Open", "Previous section", "Auto-scroll", "Next section", "Connect main screen", "Start the show clock, 00:00", "Settings"]);
  await shot(page, "demo-desktop");
  ok("Try the demo: #demo, PREP is a plain checklist (no buttons); text starts on the left in a centred 960px column; section title left, time right; the bar: Open, previous, play, next, main screen, clock, Settings, centred at the bottom");

  // Inactive lines stay readable: their colour is the AA dim token, not faded with opacity.
  const looks = await page.evaluate(() => {
    const other = document.querySelector('.section:not(.active) p.say');
    const cs = getComputedStyle(other);
    return { color: cs.color, opacity: getComputedStyle(other.closest(".section")).opacity };
  });
  assert.deepEqual(looks, { color: "oklch(0.64 0.04 282)", opacity: "1" });
  ok("other sections use the dim AA colour (--dim, oklch 64% 0.04 282) at full opacity");

  // The Open popover: above its button; Escape closes it and focus returns.
  await (await dock(page, ".open-btn")).click();
  await popAbove(page, "#open-menu", ".open-btn", "desktop Open");
  assert.deepEqual(await page.locator("#open-menu .item").allTextContents(), ["Open a script file", "Paste a script", "Copy link", "Use your AI", "Back to the start"]);
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
  // Use your AI opens a dialog with this server's address.
  await (await dock(page, ".open-btn")).click();
  await page.locator('#open-menu [data-action="ai"]').click();
  await page.locator(".ai-dialog[open]").waitFor();
  assert.equal(await page.locator("#open-menu:popover-open").count(), 0);
  const mcpRe = new RegExp(`^${base.replace(/[.:/]/g, "\\$&")}/mcp$`);
  assert.match(await page.locator(".ai-dialog .mcp-url").textContent(), mcpRe);
  assert.match(await page.locator(".ai-dialog").textContent(), /Claude[\s\S]*ChatGPT[\s\S]*Codex and T3 Code[\s\S]*within a few minutes of your last request/);
  assert.equal(await page.locator('.ai-dialog [data-action="copy-mcp"]').isVisible(), true);
  await shot(page, "ai-dialog-desktop");
  await page.keyboard.press("Escape");
  await page.locator(".ai-dialog:not([open])").waitFor({ state: "attached" });
  ok("Open popover above its button: Open a script file, Paste, Copy link, Use your AI, Back to the start; Escape and a click outside close it and focus returns to the button; Use your AI is a dialog with this server's /mcp address, a copy button and Claude, ChatGPT and Codex/T3 steps");

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

  // Settings: three rows (text size, scroll speed, width), remembered after a reload.
  await (await dock(page, ".settings-btn")).click();
  await popAbove(page, "#settings", ".settings-btn", "desktop Settings");
  assert.deepEqual(await page.locator("#settings").evaluate((el) => [...el.querySelectorAll(".setting")].map((row) => (row.matches("fieldset") ? row.querySelector("legend") : row).firstChild.textContent.trim())),
    ["Text size", "Scroll speed", "Width"], "three rows only");
  assert.equal(await page.locator("#settings").locator("input, select, button, textarea").count(), 5, "two sliders and three width choices, nothing else");
  assert.deepEqual(await page.locator("#settings .seg label").allTextContents(), ["Narrow", "Medium", "Full"]);
  await page.locator(".size").fill("70");
  await page.locator(".speed").fill("120");
  await page.locator('#settings .seg label:has-text("Narrow")').click();
  assert.deepEqual(await page.locator("#settings .val").allTextContents(), ["70 px", "120"]);
  await shot(page, "settings-popover-desktop");
  const narrowCol = await page.locator(".script").evaluate((el) => el.getBoundingClientRect().width - parseFloat(getComputedStyle(el).paddingLeft) * 2);
  assert.ok(Math.abs(narrowCol - 600) < 2, `narrow column is ${narrowCol}px`);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("settings-btn")), true, "focus returns to Settings");
  await page.reload();
  await page.locator(".section").first().waitFor();
  assert.deepEqual(await page.evaluate(() => [
    getComputedStyle(document.documentElement).getPropertyValue("--size").trim(),
    document.querySelector(".size").value, document.querySelector(".speed").value, document.querySelector('input[name="width"]:checked').value,
  ]), ["70px", "70", "120", "narrow"]);
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
  await page.keyboard.press("Escape");
  ok("Settings popover above its button: Text size, Scroll speed and a Narrow/Medium/Full width choice only; remembered after a reload; keys move the sliders; focus returns");

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

  await page.goto(`${base}/#s=@@@`);
  await page.locator(".note-row.alert:not([hidden])").waitFor();
  assert.match(await page.locator(".alert-text").textContent(), /could not be opened: Link data is damaged/);
  await showsStart(page);
  assert.equal(await page.locator(".section").count(), 0);
  ok("a damaged link shows a plain error over the start screen");
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
  await v.locator(".voice").waitFor();
  await (await dock(v, ".auto")).click();
  assert.equal(await v.locator(".auto").getAttribute("aria-pressed"), "true");
  await (await dock(v, ".voice")).click();
  await v.locator(".voice-notice:not([hidden])").waitFor();
  assert.match(await v.locator(".voice-notice").textContent(), /speech service[\s\S]*Google[\s\S]*Your script stays on this device/);
  assert.equal(await v.evaluate(() => window.__speech.started), 0, "nothing listens before consent");
  await shot(v, "voice-notice-desktop");
  await v.locator('[data-action="voice-ok"]').click();
  assert.equal(await v.evaluate(() => window.__speech.started), 1);
  assert.equal(await v.locator(".voice").getAttribute("aria-pressed"), "true");
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
  await (await dock(v, ".auto")).click();
  // Consent is remembered: the second time it starts at once.
  await v.reload();
  await (await dock(v, ".voice")).click();
  assert.equal(await v.locator(".voice-notice").isHidden(), true);
  assert.equal(await v.evaluate(() => window.__speech.started), 1);
  await (await dock(v, ".voice")).click();
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
  assert.deepEqual(await intro.locator(".links .link").allTextContents(), ["↗Intro1", "↗Patchstack2"], "every link is still listed and numbered at the top");
  assert.deepEqual(await intro.locator(".links .link").evaluateAll((els) => els.map((el) => el.title)), ["example.com · key 1", "patchstack.com · key 2"], "the address only in the tooltip");
  const markEl = intro.locator(".mark");
  assert.equal(await markEl.textContent(), "↗Patchstack", "a quiet marker: no \"opens here\" text");
  assert.equal(await markEl.getAttribute("title"), "patchstack.com · opens on the main screen when it reaches the reading line");
  assert.equal(await markEl.getAttribute("data-k"), null, "the marker is not a spoken line");
  assert.equal(await L.evaluate(() => document.querySelector(".section:nth-child(2) .mark").previousElementSibling.textContent), "Patchstack finds the holes.");
  await (await dock(L, ".screen")).click();
  assert.equal(await L.locator(".dock .screen").getAttribute("data-on"), "true");
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
  await (await dock(L, ".voice")).click();
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
  await (await dock(L, ".voice")).click();
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
  await (await dock(D, ".screen")).click();
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
  await (await dock(X, ".screen")).click();
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
    const p = [...document.querySelectorAll(".section p")].find((el) => el.textContent === "Read the docs first." && el.matches(q));
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
  // Its section no longer active: the link takes the dim colour of the line.
  await X.keyboard.press("ArrowRight");
  await X.waitForTimeout(350);
  const dimmed = await linkLooks();
  assert.deepEqual(dimmed.same, [], "inactive section: still the line's own colour");
  assert.equal(dimmed.color, "oklch(0.64 0.04 282)");
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
  ok("a link inside a sentence: the line shows only its words in the line's own font and colour (also dimmed), a faint dotted orange underline; hover turns it orange on a soft tint; at the reading line it opens and gets a thin orange border without underline; no layout shift; click and number keys open it; the top row is small and muted");

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
  await (await dock(Y, ".screen")).click();
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
  assert.equal(await H.locator(".dock .screen").getAttribute("data-hint"), "true");
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
  assert.equal(await HC.locator(".dock .screen").getAttribute("data-hint"), null);
  assert.equal(await HC.evaluate(() => window.__screen.visits.at(-1)), "https://example.com/intro");
  assert.equal(await HC.locator(".dock .screen").getAttribute("data-on"), "true");
  assert.equal(await HC.locator(".dock .screen").getAttribute("aria-label"), "Main screen connected, reconnect");
  await hintConnect.close();
  ok("without a main screen nothing opens; a one-time hint above the control bar; its Connect button hides it, clears the highlight and shows the current link");

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
    await (await dock(Q, ".screen")).click();
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
    await (await dock(X2, ".screen")).click();
    await X2.mouse.move(683, 120);
    await X2.evaluate(([y]) => { const el = document.querySelector(".inlink"); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - y - 40); }, [Y]);
    await X2.waitForTimeout(1000);
    assert.notEqual(await X2.evaluate(() => window.__screen.visits.at(-1)), "https://developer.mozilla.org/en-US/", `${frac}: the link inside a sentence 40px below the line has not opened yet`);
    await X2.evaluate(([y]) => { const el = document.querySelector(".inlink"); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - y - 2); }, [Y]);
    await X2.waitForFunction(() => window.__screen.visits.at(-1) === "https://developer.mozilla.org/en-US/", null, { timeout: 2000 });
    await X2.close();
    // Follow my voice brings the heard line to the moved line.
    const V = await open(link);
    await (await dock(V, ".voice")).click();
    await V.evaluate(() => window.__speech.say("writing scripts takes too long"));
    await V.waitForFunction(() => document.querySelector("p.cur")?.textContent === "Writing scripts takes too long.");
    await V.waitForFunction((y) => Math.abs(document.querySelector("p.cur").getBoundingClientRect().top - y) < 12, Y);
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
  await m.locator('.empty [data-action="ai"]').click();
  await m.locator(".ai-dialog[open]").waitFor();
  await noOverflow(m, "mobile AI dialog");
  const aiBox = await m.locator(".ai-dialog").boundingBox();
  assert.ok(aiBox.x >= 0 && aiBox.x + aiBox.width <= 390, "AI dialog fits");
  await shot(m, "ai-dialog-mobile");
  await m.keyboard.press("Escape");
  await m.locator('.empty [data-action="demo"]').click();
  await m.locator(".section").first().waitFor();
  await noOverflow(m, "mobile demo");
  const mobileDock = await m.locator(".dock").boundingBox();
  assert.ok(mobileDock.x >= 0 && mobileDock.x + mobileDock.width <= 390, `control bar ${Math.round(mobileDock.width)}px fits`);
  assert.ok(Math.abs(mobileDock.x + mobileDock.width / 2 - 195) < 2, "control bar centred");
  const tops = await m.locator(".dock > button:not([hidden])").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  assert.equal(tops.length, 8, "all eight buttons, Follow my voice included");
  assert.equal(new Set(tops).size, 1, `control bar is one row: ${tops}`);
  assert.ok(await m.locator(".dock > button:not([hidden])").evaluateAll((els) => els.every((el) => el.getBoundingClientRect().height >= 44)), "44px tall touch targets");
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
  await shot(m, "settings-popover-mobile");
  await m.mouse.click(195, 120);
  assert.equal(await m.locator("#settings:popover-open").count(), 0, "tapping the page closes Settings");
  await (await dock(m, ".voice")).click();
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
  ok("mobile 390px: start screen card and AI dialog fit; the demo; a one-row centred control bar of eight icons with 44px-tall targets; Open and Settings popovers above their buttons and on screen (tap outside closes); no sideways scroll; voice notice and hint fit", `bar ${Math.round(mobileDock.width)}px`);
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

  // ---- Offline (file://) ----
  const offline = await browser.newContext(DESKTOP);
  const o = await offline.newPage();
  watch(o, "offline");
  const fileUrl = pathToFileURL(join(dist, "index.html")).href;
  await o.goto(fileUrl);
  await showsStart(o);
  assert.equal(await o.evaluate(() => document.fonts.size), 0, "offline copies use system fonts and request no font file");
  await o.locator('.empty [data-action="ai"]').click();
  assert.equal(await o.locator(".ai-dialog .mcp-url").textContent(), "https://prompter.techies.tools/mcp");
  await o.keyboard.press("Escape");
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
  await offline.close();
  ok("offline: file:// start screen and demo, file:// #s= link and an embedded offline copy all work");

  assert.deepEqual(errors, [], errors.join("\n"));
  ok("no page or console errors");
  return { mode, base, link, checks, screenshots };
}
