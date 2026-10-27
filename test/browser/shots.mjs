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
const NO_SPEECH = () => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; };

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
  assert.match(home.headers.get("permissions-policy") || "", /microphone=\(self\)/);
  ok("page served with hash-pinned CSP; microphone allowed for this page only", mode);

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
  assert.equal(await page.locator('.bar [data-action="home"], .problems-btn, #home').count(), 0, "no Home, no Check, no start page");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(0, 0, 0)");
  const prep = page.locator(".section").first();
  assert.equal(await prep.locator(".actions label.btn input[type=file]").count(), 1);
  assert.equal(await prep.locator('.actions [data-action="paste"]').count(), 1);
  assert.match(await prep.locator(".actions .drop-hint").textContent(), /drop a file anywhere/);
  assert.equal(await prep.locator('.actions [data-action="ai"]').count(), 1);
  assert.match(await prep.locator(".note").textContent(), /Scripts stay on your device/);
  assert.equal(await page.locator(".voice").isHidden(), true, "Follow my voice is hidden without the speech API");
  await shot(page, "demo-prep-desktop");
  ok("landing opens the demo: PREP buttons, drop hint, privacy note; no Home/Check; black background; no voice button without the API");

  await prep.locator('[data-action="ai"]').click();
  await page.locator("#ai-panel").waitFor();
  assert.match(await page.locator("#ai-panel .mcp-url").textContent(), new RegExp(`^${base.replace(/[.:/]/g, "\\$&")}/mcp$`));
  assert.match(await page.locator("#ai-panel").textContent(), /Claude[\s\S]*ChatGPT[\s\S]*Codex and T3 Code[\s\S]*within a few minutes of your last request/);
  assert.equal(await prep.locator('[data-action="ai"]').getAttribute("aria-expanded"), "true");
  await page.locator('[data-action="copy-mcp"]').waitFor();
  await shot(page, "demo-ai-desktop");
  ok("Use your AI shows this server's /mcp address, a copy button and Claude, ChatGPT and Codex/T3 steps");

  // Inactive lines stay readable: their colour is the AA dim token, not faded with opacity.
  const looks = await page.evaluate(() => {
    const other = document.querySelector('.section:not(.active) p.say');
    const cs = getComputedStyle(other);
    return { color: cs.color, opacity: getComputedStyle(other.closest(".section")).opacity };
  });
  assert.deepEqual(looks, { color: "rgb(154, 154, 154)", opacity: "1" });
  ok("other sections use the dim AA colour #9a9a9a at full opacity");

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
  await page.locator(".open-menu > summary").click();
  await page.locator('.menu [data-action="demo"]').click();
  await page.waitForFunction((n) => document.querySelectorAll(".section").length === n, DEMO_SECTIONS);
  assert.equal(await page.locator(".open-menu").getAttribute("open"), null);
  await page.locator(".open-menu > summary").click();
  await shot(page, "open-menu-desktop");
  await page.keyboard.press("Escape");
  ok("a remembered script opens without a link; Open › Back to the demo returns to the demo");

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
  await shot(page, "ql-section-desktop");
  ok("link opens the example: 5 sections, QL first, 4 link buttons, &p=lex kept; arrow keys move sections");

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
  await page.locator(".bar").screenshot({ path: join(out, "toolbar-desktop.png") });
  screenshots.push(join(out, "toolbar-desktop.png"));
  const barHeight = await page.locator(".bar").evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(barHeight < 60, `desktop toolbar is ${barHeight}px high (one row)`);
  ok("speed and size sliders and the column width are remembered; keys move the sliders", `toolbar ${Math.round(barHeight)}px`);
  await page.locator(".width").selectOption("full");

  // A link made for the default preset keeps it, even after Lex was chosen.
  await page.goto(await makeLink(EXAMPLE_SCRIPT.replace("Thanks for watching.", "Thanks a lot for watching."), "default", base));
  await page.locator(".section").first().waitFor();
  assert.doesNotMatch(await page.evaluate(() => location.hash), /&p=/);
  assert.equal(await page.evaluate(() => localStorage.getItem("prompter-preset")), "default");
  ok("default links keep the default preset");

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
  const voiceBar = await v.locator(".bar").evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(voiceBar < 60, `desktop toolbar with Follow my voice is ${voiceBar}px high (one row)`);
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

  // ---- Mobile ----
  const mobile = await browser.newContext(MOBILE);
  await mobile.addInitScript(SPEECH_STUB);
  const m = await mobile.newPage();
  watch(m, "mobile");
  await m.goto(`${base}/`);
  await m.locator(".section").first().waitFor();
  await noOverflow(m, "mobile demo");
  const mobileBar = await m.locator(".bar").evaluate((el) => el.getBoundingClientRect().height);
  const rowTops = await m.locator(".open-menu, .auto, .voice, .more-btn").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  assert.equal(new Set(rowTops).size, 1, `main controls wrap: ${rowTops}`);
  assert.ok(mobileBar < 60, `mobile toolbar is ${Math.round(mobileBar)}px high (one row)`);
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
  await m.locator(".more-btn").click();
  await m.locator(".more .size").waitFor();
  await noOverflow(m, "mobile toolbar open");
  const openBar = await m.locator(".bar").evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(openBar < 844 * 0.34, `open toolbar ${openBar}px covers the reading line`);
  await m.locator(".width").selectOption("narrow");
  await shot(m, "toolbar-mobile");
  await m.locator(".voice").click();
  await m.locator(".voice-notice:not([hidden])").waitFor();
  await noOverflow(m, "mobile voice notice");
  await shot(m, "voice-notice-mobile");
  ok("mobile 390px: one-row toolbar, More reveals sliders and column without sideways scroll, voice notice fits", `${Math.round(mobileBar)}px / ${Math.round(openBar)}px`);
  await mobile.close();

  // ---- Offline (file://) ----
  const offline = await browser.newContext(DESKTOP);
  const o = await offline.newPage();
  watch(o, "offline");
  const fileUrl = pathToFileURL(join(dist, "index.html")).href;
  await o.goto(fileUrl);
  await o.locator(".section").first().waitFor();
  assert.equal(await o.locator(".section").count(), DEMO_SECTIONS);
  await o.locator('.actions [data-action="ai"]').click();
  assert.equal(await o.locator("#ai-panel .mcp-url").textContent(), "https://prompter.techies.tools/mcp");
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
