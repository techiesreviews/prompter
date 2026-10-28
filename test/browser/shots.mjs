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
  assert.deepEqual(await prep.locator("p.bullet").allTextContents(), ["Water within reach", "Camera at eye level", "Phone on silent"]);
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
  await page.locator(".open-btn").click();
  await popAbove(page, "#open-menu", ".open-btn", "desktop Open");
  assert.deepEqual(await page.locator("#open-menu .item").allTextContents(), ["Open a script file", "Paste a script", "Copy link", "Use your AI", "Back to the start"]);
  await page.locator('#open-menu [data-action="open-file"]').focus();
  await shot(page, "open-popover-desktop");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#open-menu:popover-open").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("open-btn")), true, "focus returns to the Open button");
  assert.equal(await page.locator(".open-btn").getAttribute("aria-expanded"), "false");
  await page.locator(".open-btn").click();
  await page.locator("#open-menu:popover-open").waitFor();
  await page.mouse.click(1200, 200);
  assert.equal(await page.locator("#open-menu:popover-open").count(), 0, "a click outside closes it");
  // Use your AI opens a dialog with this server's address.
  await page.locator(".open-btn").click();
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
  await page.locator(".open-btn").click();
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
  await page.locator(".open-btn").click();
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
  // The clock: the first press starts it, the next press starts it over from 00:00.
  const clock = page.locator(".dock .clock");
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
  await page.locator(".dock .next").hover();
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".dock .next").evaluate((el) => getComputedStyle(el, "::after").opacity), "1", "tooltip on hover");
  const dockClip = await page.locator(".dock").boundingBox();
  await page.screenshot({ path: join(out, "dock-desktop.png"), clip: { x: dockClip.x - 40, y: dockClip.y - 60, width: dockClip.width + 80, height: dockClip.height + 70 } });
  screenshots.push(join(out, "dock-desktop.png"));
  await page.mouse.move(700, 300);
  ok("play (orange) toggles auto-scroll, Space on it toggles once; the clock starts on the first press and restarts from 00:00 on the next (tooltip says so), and still turns late; tooltips on hover");

  // Settings: three rows (text size, scroll speed, width), remembered after a reload.
  await page.locator(".settings-btn").click();
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
  await page.locator(".settings-btn").click();
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
  await L.locator(".dock .screen").click();
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
  // The label still sits in the recent words: that echo must not take the screen back.
  await L.evaluate(() => window.__speech.say("then the next line"));
  await L.waitForTimeout(300);
  assert.equal(await lastVisit(), "https://example.com/intro", "an echo of an earlier label does not reopen it");
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
  await D.goto(`${base}/#demo`);
  await D.locator(".section").first().waitFor();
  await D.locator(".dock .screen").click();
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
  await m.locator(".open-btn").click();
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
  await m.locator(".settings-btn").click();
  await popAbove(m, "#settings", ".settings-btn", "mobile Settings");
  await noOverflow(m, "mobile Settings popover");
  await m.locator('#settings .seg label:has-text("Narrow")').click();
  await shot(m, "settings-popover-mobile");
  await m.mouse.click(195, 120);
  assert.equal(await m.locator("#settings:popover-open").count(), 0, "tapping the page closes Settings");
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
  ok("mobile 390px: start screen card and AI dialog fit; the demo; a one-row centred control bar of eight icons with 44px-tall targets; Open and Settings popovers above their buttons and on screen (tap outside closes); no sideways scroll; voice notice and hint fit", `bar ${Math.round(mobileDock.width)}px`);
  await mobile.close();

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
