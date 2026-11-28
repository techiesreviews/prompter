// The record light (TOOLS-467): the Prompter starts and stops a take in OBS, named after the scene
// at the reading line, and shows it is recording. A stand-in OBS (test/obs-standin.mjs) answers on
// OBS's own port, 127.0.0.1:4455, with and without a password; never a real OBS. The password here
// is made up for the test.
import assert from "node:assert/strict";
import { join } from "node:path";
import { startObsStandin } from "../obs-standin.mjs";
import { SPEECH_STUB } from "./page.mjs";

const FILL = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of this part.`).join("\n");
const SCRIPT = `### **INTRO · 00:00**

${FILL}

### **1 · FIRST PART · 01:00**

${FILL}

### **2 · SECOND PART · 02:00**

${FILL}

### **3 · LAST PART · 03:00**

${FILL}
`;
const MADE_UP = "made-up-test-secret";
const DESKTOP = { viewport: { width: 1366, height: 900 } };
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SIDEWAYS = { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }; // a phone held sideways
const LAPTOP = { viewport: { width: 1280, height: 800 } };

export async function run({ browser, base, mode, out }) {
  const checks = [];
  const screenshots = [];
  const errors = [];
  const ok = (name) => checks.push(name);
  const shot = async (page, name, clip) => {
    await page.waitForTimeout(300);
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
    screenshots.push(file);
  };
  const watch = (page) => {
    page.on("pageerror", (e) => errors.push(`record-light pageerror: ${e.message}`));
    page.on("console", (m) => {
      // OBS closed or quit: the browser logs the refused connection, as expected while "not found".
      if (m.type() === "error" && !/ws:\/\/127\.0\.0\.1:4455|\/api\//.test(m.text() + (m.location()?.url || ""))) errors.push(`record-light console: ${m.text()}`);
    });
  };
  const open = async (page, script = SCRIPT) => {
    await page.goto(base);
    await page.locator('.empty [data-action="paste"]').click();
    await page.locator("#paste-text").fill(script);
    await page.locator('[data-action="open-paste"]').click();
    await page.locator(".section").first().waitFor();
  };
  const settings = async (page) => {
    const { width, height } = page.viewportSize();
    await page.mouse.move(width / 2, height - 30);
    await page.locator(".dock .settings-btn").click();
    await page.locator("#settings:popover-open").waitFor();
  };
  const closeSettings = (page) => page.evaluate(() => { const pop = document.querySelector("#settings"); if (pop.matches(":popover-open")) pop.hidePopover(); document.activeElement?.blur(); });
  const toSection = (page, i) => page.evaluate((n) => {
    const el = document.querySelectorAll(".section")[n];
    window.scrollTo(0, el.offsetTop - document.querySelector(".reading-line").getBoundingClientRect().top + 2);
  }, i);
  const light = (page) => page.evaluate(() => {
    const l = document.querySelector(".rec-light");
    const star = document.querySelector(".rec-star");
    const shown = (el) => !!el && getComputedStyle(el).display !== "none" && !el.closest("[hidden]");
    return {
      shown: shown(l),
      state: l.dataset.state,
      tag: shown(l.querySelector(".rec-tag")) ? l.querySelector(".rec-tag").textContent : null,
      time: shown(l.querySelector(".rec-time")) ? l.querySelector(".rec-time").textContent : null,
      label: l.getAttribute("aria-label"),
      star: shown(star) ? star.textContent.trim() : null,
    };
  });
  // OBS's side (the stand-in, in this process) catches up a moment after the page's.
  const obsUntil = async (fn, what, timeout = 3000) => {
    for (const end = Date.now() + timeout; !fn();) {
      assert.ok(Date.now() < end, what);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const until = (page, fn, arg, timeout = 6000) => page.waitForFunction(fn, arg, { timeout });
  const tagIs = (page, text, timeout) => until(page, (t) => document.querySelector(".rec-light .rec-tag").textContent === t, text, timeout);
  // The person's agent, linked to this tab as Wait for MCP does it (the copied message carries the
  // agent's token, as in the page suite). Returns how the agent calls the Prompter's /mcp.
  const linkAgent = async (page) => {
    await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; });
    const { width, height } = page.viewportSize();
    await page.mouse.move(width / 2, height - 30);
    await page.locator(".dock .open-btn").click();
    await page.locator("#open-menu .mcp-action").click();
    await until(page, () => window.__copied.length === 1);
    const token = (await page.evaluate(() => window.__copied[0])).match(/Bearer (tp1-[\w-]+)/)?.[1];
    assert.ok(token, "the copied message carries the agent's token");
    let id = 1;
    const agent = async (method, params) => {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
      assert.equal(res.status, 200, `${method} is answered`);
      return (await res.json()).result;
    };
    await agent("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } });
    await until(page, () => document.querySelector(".open-btn").dataset.dot === "on");
    await page.evaluate(() => { document.querySelector("#open-menu").hidePopover(); document.activeElement?.blur(); });
    return agent;
  };
  const scrolls = async (page) => {
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(300);
    return after > before;
  };

  let obs = await startObsStandin({ port: 4455 });
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  watch(page);
  try {
    await open(page);
    assert.equal((await light(page)).shown, false, "off by default: no light");
    await page.waitForTimeout(400);
    assert.equal(obs.connections, 0, "off by default: the page does not even look for OBS");

    // Turned on in Settings: the fourth big button, and a password box under the buttons.
    await settings(page);
    const obsBtn = page.locator("#settings .big-toggle.obs");
    assert.equal(await obsBtn.getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#settings .obs-pass").isVisible(), false, "no password box while the link is off");
    await obsBtn.click();
    await until(page, () => document.querySelector(".big-toggle.obs").dataset.state === "on");
    assert.equal(await obsBtn.getAttribute("aria-label"), "OBS link: connected");
    assert.equal(await page.locator("#settings .obs-pass").isVisible(), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".obs-password"), "::placeholder").color), await page.evaluate(() => { const s = document.createElement("span"); s.style.color = "var(--muted)"; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; }), "the password hint is the muted text colour (AA on its box)");
    await shot(page, "record-obs-settings-desktop", await page.locator("#settings").boundingBox());
    await closeSettings(page);
    assert.equal(await page.evaluate(() => localStorage.getItem("prompter-obs")), "on", "remembered on this device");

    // Idle: a dim dot with the scene and take at the reading line.
    await toSection(page, 2);
    await tagIs(page, "S2 · T1");
    let l = await light(page);
    assert.deepEqual([l.shown, l.state, l.time, l.star, l.label], [true, "idle", null, null, "Record scene 2, take 1"]);
    const look = await page.evaluate(() => [".rec-light", ".rec-star"].map((sel) => {
      const cs = getComputedStyle(document.querySelector(sel));
      return [cs.borderTopWidth, cs.borderLeftWidth, cs.boxShadow];
    }));
    for (const [top, left, shadow] of look) assert.ok(top === "0px" && left === "0px" && !/inset/.test(shadow), "no border, ring or edge band on the light");
    const box = await page.locator(".rec").boundingBox();
    assert.ok(box.y < 40, "at the top of the window");
    await shot(page, "record-light-idle-desktop");
    ok("off by default (no light, OBS not even looked for); turned on in Settings (the OBS button says connected, the password box shows); idle the light shows the scene and take at the reading line (S2 · T1), with no border");

    // R starts a take: OBS records it under the scene's folder and the take's name.
    await page.keyboard.press("r");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
    await obsUntil(() => obs.record.active, "OBS records");
    assert.match(obs.record.path, /scenes\\02-second-part\\scene-02-second-part-take-01\.mkv$/, "under the scene's folder and the take's name");
    l = await light(page);
    assert.deepEqual([l.tag, l.star, l.label], [null, null, "Recording scene 2, take 1. Stop"], "the scene and take make way for the timer");
    await page.waitForTimeout(1200);
    l = await light(page);
    assert.match(l.time, /^00:0[1-2]$/, "the timer runs");
    const dot = await page.locator(".rec-dot").evaluate((el) => [getComputedStyle(el).boxShadow, getComputedStyle(el).animationName]);
    assert.ok(dot[0] !== "none" && dot[1] === "pulse", "the dot is lit, with a glow, and pulses");
    assert.equal(await page.locator("#settings .big-toggle.obs").getAttribute("data-recording"), "true");
    await shot(page, "record-light-recording-desktop");
    // OBS's own file name goes back once the take has started.
    assert.equal(obs.record.format, "%CCYY-%MM-%DD %hh-%mm-%ss", "OBS's own file name is back");
    assert.equal(await scrolls(page), true, "scrolling works while recording");

    // R again stops it; the take is counted and carries the star.
    await page.keyboard.press("R");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "idle");
    await obsUntil(() => !obs.record.active, "OBS stopped");
    l = await light(page);
    assert.deepEqual([l.tag, l.star, l.label], ["S2 · T1", "★", "Record scene 2, take 2"]);
    await shot(page, "record-light-after-take-desktop");
    ok("R starts a take: OBS records it as scenes/02-second-part/scene-02-second-part-take-01, OBS's own file name goes back once it started; the light's dot is lit and the timer runs; scrolling still works; R again stops it, and the take shows with its star (S2 · T1 ★)");

    // A click records take 2; the next scene (→) stops it first.
    await page.locator(".rec-light").click();
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
    await obsUntil(() => obs.record.active, "OBS records take 2");
    assert.match(obs.record.path, /scene-02-second-part-take-02\.mkv$/);
    assert.notEqual(await page.evaluate(() => document.activeElement?.className), "rec-light", "a click lets go of focus, so Space still means auto-scroll");
    await page.keyboard.press("ArrowRight");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "idle");
    await obsUntil(() => !obs.record.active, "the next scene stops the take first");
    await tagIs(page, "S3 · T1");
    await page.keyboard.press("ArrowLeft");
    await tagIs(page, "S2 · T2");
    assert.equal((await light(page)).star, "★", "the newest take carries the star");

    // The rail: a thin grip at the left edge opens into the scenes and their takes.
    await page.mouse.move(4, 450);
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width > 60);
    const rail = await page.evaluate(() => [...document.querySelectorAll(".rail-scene")].map((s) => [s.querySelector(".rail-go").textContent, s.querySelectorAll(".rail-take").length, s.querySelector(".rail-go").getAttribute("aria-current")]));
    assert.deepEqual(rail, [["INTRO", 0, "false"], ["S1", 0, "false"], ["S2", 2, "true"], ["S3", 0, "false"]]);
    await shot(page, "record-rail-open-desktop", { x: 0, y: 300, width: 300, height: 300 });
    await page.locator('.rail-take[data-take="1"]').click();
    await tagIs(page, "S2 · T1");
    assert.equal((await light(page)).star, "☆", "take 1 is not the best now");
    await page.locator(".rec-star").click();
    assert.equal((await light(page)).star, "★", "the star makes take 1 the best");
    assert.equal(await page.locator('.rail-take[data-take="1"]').getAttribute("data-best"), "true");
    const book = JSON.parse(await page.evaluate(() => localStorage.getItem("prompter-takes")));
    const scenes = Object.values(book.videos)[0].scenes;
    assert.deepEqual(scenes["02-second-part"], { takes: [1, 2], best: 1 }, "the takes and the best one are kept on this device");
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width === 10); // closed once the pointer left it (a click lets go of focus)
    await page.mouse.move(4, 450);
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width > 60);
    await page.locator(".rail-go", { hasText: "S1" }).click();
    await tagIs(page, "S1 · T1");
    ok("a click records take 2; → stops it before moving on; the newest take carries the star; the rail opens at the left edge with each scene and a dot per take, the current scene marked; a dot picks a take, the star makes it the best (kept on this device), a scene button goes there");

    // OBS quits: the light says so in plain words, and the page keeps scrolling.
    await page.mouse.move(683, 450);
    await obs.stop();
    await tagIs(page, "OBS not found", 9000);
    l = await light(page);
    assert.deepEqual([l.state, l.star, l.label], ["trouble", null, "OBS not found. Try again"]);
    assert.match(await page.locator(".rec-light").getAttribute("title"), /Tools, WebSocket Server Settings/, "the hover title says how to turn on OBS's WebSocket server");
    assert.equal(await scrolls(page), true, "scrolling works with OBS gone");
    await page.keyboard.press(" ");
    const y0 = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(700);
    assert.ok(await page.evaluate((y) => window.scrollY > y, y0), "auto-scroll runs with OBS gone");
    await page.keyboard.press(" ");
    await shot(page, "record-light-not-found-desktop");
    // The best take can still be chosen while OBS is gone: the take book is on this device.
    await page.keyboard.press("ArrowRight");
    await tagIs(page, "OBS not found");
    await until(page, () => document.querySelector(".rec-star").textContent.trim() === "★" && !document.querySelector(".rec-star").hidden);
    await page.mouse.move(4, 450);
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width > 60);
    await page.locator('.rail-take[data-take="2"]').click();
    await tagIs(page, "OBS not found");
    assert.equal((await light(page)).star, "☆");
    await page.locator(".rec-star").click();
    assert.equal((await light(page)).star, "★");
    const kept = JSON.parse(await page.evaluate(() => localStorage.getItem("prompter-takes")));
    assert.deepEqual(Object.values(kept.videos)[0].scenes["02-second-part"], { takes: [1, 2], best: 2 }, "the star click is kept with OBS gone");
    await page.mouse.move(683, 450);
    await page.keyboard.press("ArrowLeft");
    ok("OBS gone: after a short Reconnecting the light says \"OBS not found\" (its title says how to turn on OBS's WebSocket server), and scrolling and auto-scroll go on; the star still shows and a click on it is kept, so the best take can be chosen");

    // OBS with a password: the light asks for it, a click opens Settings at the box.
    obs = await startObsStandin({ port: 4455, password: MADE_UP });
    await page.locator(".rec-light").click(); // try again now
    await tagIs(page, "OBS password needed", 8000);
    await shot(page, "record-light-password-desktop");
    await page.locator(".rec-light").click();
    await page.locator("#settings:popover-open").waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.className), "obs-password", "the click opens Settings at the password box");
    await page.locator(".obs-password").fill("made-up-wrong-value");
    await page.keyboard.press("Tab");
    await closeSettings(page);
    await tagIs(page, "OBS password wrong");
    assert.equal(await scrolls(page), true, "scrolling works with a wrong password");
    await shot(page, "record-light-wrong-password-desktop");
    await settings(page);
    await page.locator(".obs-password").fill(MADE_UP);
    await page.keyboard.press("Tab");
    await closeSettings(page);
    await until(page, () => document.querySelector(".big-toggle.obs").dataset.state === "on");
    await tagIs(page, "S1 · T1");
    assert.equal(await page.evaluate(() => localStorage.getItem("prompter-obs-password")), MADE_UP, "kept on this device only");
    // Typing an R in the password box is a letter of the password, never a take.
    await settings(page);
    const startsTyped = obs.requests("StartRecord").length;
    await page.locator(".obs-password").focus();
    await page.keyboard.type("r");
    await page.waitForTimeout(300);
    assert.equal(obs.requests("StartRecord").length, startsTyped, "an R typed in the password box starts no take");
    assert.equal(await page.evaluate(() => document.querySelector(".rec-light").dataset.state), "idle");
    await page.keyboard.press("Backspace");
    await closeSettings(page);
    ok("OBS with a password: the light says \"OBS password needed\", a click opens Settings at the password box; a wrong one says \"OBS password wrong\" and scrolling goes on; the right one connects");

    // Dropped mid-take: the light reconnects by itself and finds OBS still recording.
    await page.keyboard.press("r");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
    await obsUntil(() => obs.record.active, "OBS records before the drop");
    obs.drop();
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording" && document.querySelector(".big-toggle.obs").dataset.state === "on", null, 8000);
    await page.keyboard.press("r");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "idle");
    await obsUntil(() => !obs.record.active, "R stops it after the reconnect");
    ok("a dropped connection mid-take reconnects by itself, the light still shows the recording, and R stops it");

    // Space on the light reached by keyboard presses it (a take), never auto-scroll.
    await tagIs(page, "S1 · T1");
    await page.locator(".rec-light").focus();
    const ring = await page.evaluate(() => { const el = document.querySelector(".rec-light"); return [el.matches(":focus-visible"), getComputedStyle(el).outlineStyle]; });
    assert.deepEqual(ring, [true, "none"], "focus shows as a fill, never a ring");
    for (const sel of [".rec-star", ".rail-go", ".rail-take"]) {
      await page.locator(sel).first().focus();
      const r = await page.evaluate((q) => { const el = document.activeElement; return [el.matches(q), el.matches(":focus-visible"), getComputedStyle(el).outlineStyle]; }, sel);
      assert.deepEqual(r, [true, true, "none"], `${sel}: focus shows as a fill, never a ring`);
    }
    await page.locator(".rec-light").focus();
    const y1 = await page.evaluate(() => window.scrollY);
    await page.keyboard.press(" ");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
    await obsUntil(() => obs.record.active, "Space on the light records");
    assert.match(obs.record.path, /scene-01-first-part-take-02\.mkv$/);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.scrollY), y1, "auto-scroll did not start");
    await page.keyboard.press(" ");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "idle");
    await obsUntil(() => !obs.record.active, "Space on the light stops it");
    ok("a click on the light lets go of focus (Space still means auto-scroll); Space on the light reached by keyboard starts and stops a take, and auto-scroll stays off");

    // → while OBS is still starting the take: it stops as soon as it has started, never left running.
    obs.answer = (type) => (type === "StartRecord" ? { delay: 400 } : null);
    await page.keyboard.press("r");
    await obsUntil(() => obs.requests("StartRecord").length === 3, "the start is on its way");
    await page.keyboard.press("ArrowRight");
    await tagIs(page, "S2 · T2"); // the take picked on the rail
    await obsUntil(() => obs.requests("StopRecord").length === 3, "OBS is told to stop once the take has started", 4000);
    await obsUntil(() => !obs.record.active, "nothing left recording");
    obs.answer = null;
    await until(page, () => document.querySelector(".rec-light").dataset.state === "idle");
    await page.keyboard.press("ArrowLeft");
    await tagIs(page, "S1 · T3", 4000);
    ok("→ while OBS is still starting a take stops it as soon as it has started (nothing left recording), and that take is counted (S1 · T3)");

    // R twice in a row while OBS is slow to start: the take stops once started, and the last word read out is the stop.
    await page.evaluate(() => {
      window.said = [];
      const el = document.querySelector(".status");
      new MutationObserver(() => { if (el.textContent) window.said.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const starts = obs.requests("StartRecord").length;
    await page.keyboard.press("r");
    await page.keyboard.press("r");
    await until(page, () => window.said.at(-1) === "Take called off.");
    assert.equal(obs.requests("StartRecord").length, starts, "called off before OBS was asked to record");
    obs.answer = (type) => (type === "StartRecord" ? { delay: 300 } : null);
    await page.keyboard.press("r");
    await obsUntil(() => obs.requests("StartRecord").length === starts + 1, "the start is on its way");
    await page.keyboard.press("r");
    assert.deepEqual(await page.evaluate(() => [document.querySelector(".rec-light").dataset.state, document.querySelector(".rec-tag").textContent]), ["stopping-early", "Stopping…"], "R says Stopping at once, with no timer, before OBS answers");
    await obsUntil(() => obs.requests("StopRecord").length === 4, "stopped once it started", 4000);
    await obsUntil(() => !obs.record.active, "nothing left recording");
    obs.answer = null;
    await until(page, () => window.said.at(-1) === "Stopped scene 1, take 4.");
    assert.ok(!(await page.evaluate(() => window.said.includes("Recording scene 1, take 4."))), "never \"Recording\" for a take stopped while it started");
    ok("R twice at once calls the take off before OBS records (read out as called off); R twice while OBS is slow to start: the take stops once started, and the stop is what is read out");

    // OBS slow to finish the file: the light shows the take until OBS says it stopped; R meanwhile records the next.
    obs.stopLag = 2500;
    await page.keyboard.press("r");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
    await obsUntil(() => obs.record.active && obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss", "take 5 records");
    await page.keyboard.press("r");
    await obsUntil(() => obs.requests("StopRecord").length === 5, "OBS was told to stop");
    await page.waitForTimeout(300);
    const stopLook = () => page.evaluate(() => {
      const l = document.querySelector(".rec-light");
      return { state: l.dataset.state, label: l.getAttribute("aria-label"), time: l.querySelector(".rec-time").textContent, dot: getComputedStyle(l.querySelector(".rec-dot")).animationName, said: window.said.at(-1) };
    });
    const stopping = await stopLook();
    assert.equal(stopping.state, "stopping", "the light shows the stop under way");
    assert.equal(stopping.dot, "none", "the dot no longer pulses");
    assert.equal(stopping.label, "Stopping scene 1, take 5. Record scene 1, take 6");
    assert.notEqual(stopping.said, "Stopped scene 1, take 5.", "not read out as stopped before OBS stopped");
    assert.ok(obs.record.active, "OBS is still finishing");
    await page.waitForTimeout(1100);
    assert.equal((await stopLook()).time, stopping.time, "the time stands still while OBS finishes the file");
    // Take 5 still stopping (stand-in waits longer): R asks for take 6, which waits; R again calls it off.
    obs.stopLag = 1200;
    await until(page, () => window.said.includes("Stopped scene 1, take 5."), null, 4000);
    await page.keyboard.press("r");
    await obsUntil(() => obs.record.active && obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss", "take 6 records");
    await page.keyboard.press("r");
    await obsUntil(() => obs.requests("StopRecord").length === 6, "OBS was told to stop take 6");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "stopping");
    let startsBefore = obs.requests("StartRecord").length;
    await page.keyboard.press("r"); // take 7, while take 6 is stopping
    await until(page, () => window.said.at(-1) === "Take 7 of scene 1 starts once the take before has stopped.");
    assert.equal((await stopLook()).label, "Stopping scene 1, take 6. Take 7 of scene 1 starts once it has stopped. Call it off");
    await page.keyboard.press("r"); // called off while it waits
    await until(page, () => window.said.at(-1) === "Take called off.");
    assert.equal(obs.requests("StartRecord").length, startsBefore, "take 7 was never asked of OBS");
    await until(page, () => window.said.at(-1) === "Stopped scene 1, take 6.", null, 4000);
    // And asked again while take 7 stops: take 8 records once OBS has stopped (7 is free again: never recorded).
    await page.keyboard.press("r");
    await obsUntil(() => obs.record.active && obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss", "take 7 records");
    await page.keyboard.press("r");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "stopping");
    startsBefore = obs.requests("StartRecord").length;
    await page.keyboard.press("r");
    await page.waitForTimeout(200);
    assert.equal(obs.requests("StartRecord").length, startsBefore, "the next take waits for the stop");
    await until(page, () => window.said.includes("Stopped scene 1, take 7."), null, 4000);
    await obsUntil(() => obs.requests("StartRecord").length === startsBefore + 1 && obs.record.active, "take 8 records after the stop", 4000);
    assert.match(obs.record.path, /scene-01-[a-z0-9-]+-take-08\.mkv$/);
    obs.stopLag = 20;
    await page.keyboard.press("r");
    await until(page, () => window.said.at(-1) === "Stopped scene 1, take 8.", null, 4000);
    ok("a stop shows as Stopping (dim dot, time stands still) until OBS has really stopped, read out only then; R meanwhile asks for the next take, which waits (its name says so) and can be called off");

    // OBS out of reach mid-take: R and the light still stop the take. The stop waits on the light
    // ("Stopping…" before the trouble) and goes to OBS once it is back.
    const OWN = "%CCYY-%MM-%DD %hh-%mm-%ss";
    const takeRecords = async (n) => {
      await page.keyboard.press("r");
      await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
      await obsUntil(() => obs.record.active && obs.record.format === OWN, `scene 3, take ${n} records`);
      return obs.record.startedAt;
    };
    // OBS comes back, still recording the take it was recording when it went away.
    const obsBack = async (since) => {
      obs = await startObsStandin({ port: 4455, password: MADE_UP });
      obs.record.active = true;
      obs.record.startedAt = since;
    };
    const labelOf = () => page.locator(".rec-light").getAttribute("aria-label");
    await toSection(page, 3);
    await tagIs(page, "S3 · T1");
    let since = await takeRecords(1);
    await obs.stop();
    await tagIs(page, "Reconnecting to OBS…");
    await page.keyboard.press("r");
    await tagIs(page, "Stopping… Reconnecting to OBS…");
    assert.equal(await labelOf(), "Stopping scene 3, take 1 once OBS is back. Reconnecting to OBS…");
    await tagIs(page, "Stopping… OBS not found", 9000);
    assert.equal(await labelOf(), "Stopping scene 3, take 1 once OBS is back. OBS not found. Try again");
    assert.match(await page.locator(".rec-light").getAttribute("title"), /Tools, WebSocket Server Settings/, "the hover title still says how to turn on OBS's WebSocket server");
    assert.equal((await light(page)).state, "trouble");
    assert.equal(await scrolls(page), true, "scrolling works while the stop waits for OBS");
    await shot(page, "record-light-stopping-not-found-desktop");
    await obsBack(since);
    await page.locator(".rec-light").click(); // try again now
    await obsUntil(() => obs.requests("StopRecord").length === 1 && !obs.record.active, "the stop reaches OBS once it is back", 8000);
    await until(page, () => window.said.includes("Stopped scene 3, take 1."));
    await tagIs(page, "S3 · T1");
    assert.equal((await light(page)).state, "idle");
    ok("R while the light says Reconnecting stops the take: the light says \"Stopping… Reconnecting to OBS…\", then \"Stopping… OBS not found\" (scrolling goes on), and OBS is told to stop once it is back; the stop is read out then");

    since = await takeRecords(2);
    await obs.stop();
    await tagIs(page, "OBS not found", 9000);
    await page.locator(".rec-light").click();
    await tagIs(page, "Stopping… OBS not found");
    assert.equal(await labelOf(), "Stopping scene 3, take 2 once OBS is back. OBS not found. Try again");
    await obsBack(since);
    await page.locator(".rec-light").click(); // try again now
    await obsUntil(() => obs.requests("StopRecord").length === 1 && !obs.record.active, "the stop reaches OBS once it is found again", 8000);
    await until(page, () => window.said.includes("Stopped scene 3, take 2."));
    ok("a click on the light while it says \"OBS not found\" stops the take too: \"Stopping… OBS not found\", and OBS is told once it is found again");

    // The connection drops while OBS is being told to stop: the stop is not lost.
    await takeRecords(3);
    const stopsBefore = obs.requests("StopRecord").length;
    let cut = false;
    obs.answer = (type) => {
      if (type !== "StopRecord" || cut) return null;
      cut = true;
      setTimeout(() => obs.drop(), 10);
      return { silent: true };
    };
    await page.keyboard.press("r");
    await tagIs(page, "Stopping… Reconnecting to OBS…");
    assert.ok(obs.record.active, "OBS never took the first stop");
    await obsUntil(() => obs.requests("StopRecord").length === stopsBefore + 2 && !obs.record.active, "OBS is told to stop again after the reconnect", 8000);
    obs.answer = null;
    await until(page, () => window.said.includes("Stopped scene 3, take 3."));
    await tagIs(page, "S3 · T3");
    assert.equal((await light(page)).state, "idle");
    ok("a connection that drops while OBS is told to stop does not lose the stop: the light says Stopping, OBS is told again after the reconnect, and the take stops");

    // OBS goes away before it answers a start: it may be recording the take, so R still stops it.
    startsBefore = obs.requests("StartRecord").length;
    obs.answer = (type) => (type === "StartRecord" ? { silent: true } : null);
    await page.keyboard.press("r");
    await obsUntil(() => obs.requests("StartRecord").length === startsBefore + 1, "OBS is asked to record take 4");
    since = Date.now();
    await obs.stop();
    await tagIs(page, "Reconnecting to OBS…");
    await page.keyboard.press("r");
    await tagIs(page, "Stopping… Reconnecting to OBS…");
    assert.equal(await labelOf(), "Stopping scene 3, take 4 once OBS is back. Reconnecting to OBS…");
    await obsBack(since); // OBS did record it
    await obsUntil(() => obs.requests("StopRecord").length === 1 && !obs.record.active, "the stop reaches OBS once it is back", 14000);
    await until(page, () => window.said.includes("Stopped scene 3, take 4."));
    await tagIs(page, "S3 · T4");
    assert.equal((await light(page)).state, "idle");
    ok("OBS going away before it answers a start does not lose the stop: R says \"Stopping… Reconnecting to OBS…\", and the take OBS did record is stopped once OBS is back");

    // Esc closes the rail a keyboard opened, and focus goes to the record light.
    await page.mouse.move(683, 450);
    await page.locator(".rail-go").first().focus();
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width > 60);
    await page.keyboard.press("Escape");
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width === 10);
    assert.equal(await page.evaluate(() => document.activeElement?.className), "rec-light", "focus goes to the record light");
    await page.evaluate(() => document.activeElement.blur());
    // With the mouse resting over the open rail too: Esc closes it, until the mouse leaves and comes back.
    await page.mouse.move(4, 450);
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width > 60);
    await page.locator(".rail-go").first().focus();
    await page.keyboard.press("Escape");
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width === 10);
    assert.equal(await page.evaluate(() => document.activeElement?.className), "rec-light", "focus goes to the record light with the mouse over the rail");
    await page.evaluate(() => document.activeElement.blur());
    await page.mouse.move(683, 450);
    await page.mouse.move(4, 450);
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width > 60); // the mouse opens it again
    // Opened by the mouse alone, with focus nowhere in it: Esc closes it too.
    assert.equal(await page.evaluate(() => document.querySelector(".rec-rail").contains(document.activeElement)), false, "focus is not in the rail");
    await page.keyboard.press("Escape");
    await until(page, () => document.querySelector(".rec-rail").getBoundingClientRect().width === 10);
    await page.mouse.move(683, 450);
    ok("Esc closes the scene rail a keyboard or the mouse alone opened, also with the mouse resting over it; focus goes to the record light when it was in the rail");

    // The Producer's cue box open (pushed by the person's agent, as in the page suite): the box keeps the
    // page's other keys waiting, but R still starts and stops a take.
    if (mode === "wrangler") {
      const agent = await linkAgent(page);
      await takeRecords(5);
      await agent("tools/call", { name: "push_suggestions", arguments: { items: [{ kind: "point", text: "Say where the files end up." }] } });
      await page.locator(".ask-pill").click();
      await page.locator(".ask-box").waitFor();
      await page.keyboard.press("r");
      await until(page, () => window.said.includes("Stopped scene 3, take 5."));
      await obsUntil(() => !obs.record.active, "R stopped the take while the cue box showed");
      assert.equal(await page.locator(".ask-box").isVisible(), true, "the cue box stays");
      await page.keyboard.press("r");
      await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
      await obsUntil(() => obs.record.active && /take-06\.mkv$/.test(obs.record.path), "R records the next take while the cue box shows");
      // The light stays above the box's veil, as the control bar does: a click on it stops the take and
      // the cue stays.
      const at = await page.locator(".rec-light").boundingBox();
      await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
      await until(page, () => window.said.includes("Stopped scene 3, take 6."));
      assert.equal(await page.locator(".ask-box").isVisible(), true, "a click on the light does not close the cue box");
      // The light reached by keyboard: Space presses it, as it does without the box.
      await page.locator(".rec-light").focus();
      await page.keyboard.press(" ");
      await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
      await obsUntil(() => obs.record.active && /take-07\.mkv$/.test(obs.record.path) && obs.record.format === OWN, "Space on the light records while the cue box shows");
      await page.keyboard.press(" ");
      await until(page, () => window.said.includes("Stopped scene 3, take 7."));
      assert.equal(await page.locator(".ask-box").isVisible(), true, "Space on the light does not close the cue box");
      await page.evaluate(() => document.activeElement.blur());
      await page.keyboard.press("Escape"); // Skip: the box goes
      await page.locator(".ask-box").waitFor({ state: "hidden" });
      ok("while the Producer's cue box shows, R still stops a take and records the next, a click on the light (above the veil) stops a take too, and so does Space on the light reached by keyboard; the box stays until Use or Skip");
    }

    // OBS does not answer a start on a connection still up: the take's name stays in OBS and the light
    // says what R does now; when OBS begins after all, the file is the take's.
    startsBefore = obs.requests("StartRecord").length;
    obs.answer = (type) => (type === "StartRecord" ? { silent: true } : null);
    await page.keyboard.press("r");
    await obsUntil(() => obs.requests("StartRecord").length === startsBefore + 1, "OBS is asked to record the take");
    const waitingName = obs.record.format;
    assert.match(waitingName, /^scenes\/03-last-part\/scene-03-last-part-take-\d\d$/, "the take's name is in OBS");
    const waitingTake = Number(waitingName.slice(-2));
    await tagIs(page, "OBS didn’t start recording", 9000);
    assert.equal(await labelOf(), `OBS didn’t start recording yet. Call off take ${waitingTake} of scene 3`);
    const asksBefore = obs.requests("GetRecordStatus").length;
    await obsUntil(() => obs.requests("GetRecordStatus").length > asksBefore, "OBS is asked again whether it records", 9000);
    assert.equal(obs.record.format, waitingName, "the take's name stays in OBS while it may still begin");
    obs.answer = null;
    obs.press(true); // OBS begins after all
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
    assert.match(obs.record.path, new RegExp(`scene-03-last-part-take-0${waitingTake}\\.mkv$`), "the file has the take's name");
    assert.equal(await labelOf(), `Recording scene 3, take ${waitingTake}. Stop`);
    await obsUntil(() => obs.record.format === OWN, "OBS's own file name goes back once OBS records");
    await page.keyboard.press("r");
    await until(page, (n) => window.said.includes(`Stopped scene 3, take ${n}.`), waitingTake);
    await obsUntil(() => !obs.record.active, "the take stopped");
    ok("a start OBS does not answer keeps the take's name in OBS: the light says \"OBS didn’t start recording\" and that R calls the take off, OBS is asked again, and when OBS begins after all the file is scene-03-last-part-take-NN and R stops it");

    // OBS takes a start and is slow to begin: the light waits, dim, and says Starting; the red dot, the
    // timer and "Recording" come only once OBS says it records.
    const dotLook = () => page.locator(".rec-dot").evaluate((el) => [getComputedStyle(el).opacity, getComputedStyle(el).boxShadow, getComputedStyle(el).animationName]);
    const saidSince = (n, re) => page.evaluate(([from, src]) => window.said.slice(from).filter((t) => new RegExp(src).test(t)), [n, re.source]);
    obs.startLag = 900;
    let saidAt = await page.evaluate(() => window.said.length);
    startsBefore = obs.requests("StartRecord").length;
    await page.keyboard.press("r");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "starting" && document.querySelector(".rec-light").getAttribute("aria-label").startsWith("Starting scene 3"));
    await obsUntil(() => obs.requests("StartRecord").length === startsBefore + 1, "OBS is asked to record the take");
    const slowTake = Number(obs.record.format.slice(-2));
    l = await light(page);
    assert.deepEqual([l.tag, l.time, l.star, l.label], ["Starting…", null, null, `Starting scene 3, take ${slowTake}: waiting for OBS to say it records. Stop`], "Starting, with no timer, until OBS says it records");
    assert.deepEqual(await dotLook(), ["0.4", "none", "none"], "the dot stays dim: no glow, no pulse");
    assert.equal(await page.locator("#settings .big-toggle.obs").getAttribute("data-recording"), "false", "the OBS button is not red yet");
    assert.deepEqual(await saidSince(saidAt, /^Recording /), [], "\"Recording\" is not read out before OBS records");
    await shot(page, "record-light-starting-desktop");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
    assert.equal(obs.record.active, true, "red only once OBS records");
    assert.deepEqual(await saidSince(saidAt, /^Recording /), [`Recording scene 3, take ${slowTake}.`], "read out once OBS records");
    await page.keyboard.press("r");
    await until(page, (n) => window.said.includes(`Stopped scene 3, take ${n}.`), slowTake);
    await obsUntil(() => !obs.record.active, "the take stopped");
    ok("a take OBS is slow to begin shows Starting… with a dim dot and no timer; the red dot, the timer and \"Recording\" come only once OBS says it records");

    // OBS takes a start and never begins (it shows a warning instead, as for a folder it cannot write):
    // never red, no timer, no "Recording"; after the usual wait the light says OBS didn't start recording.
    obs.startLag = null;
    saidAt = await page.evaluate(() => window.said.length);
    startsBefore = obs.requests("StartRecord").length;
    await page.keyboard.press("r");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "starting");
    await obsUntil(() => obs.requests("StartRecord").length === startsBefore + 1, "OBS is asked to record the take");
    const neverTake = Number(obs.record.format.slice(-2));
    await page.waitForTimeout(1500);
    l = await light(page);
    assert.deepEqual([l.state, l.tag, l.time], ["starting", "Starting…", null], "still Starting a while later: no timer runs");
    assert.deepEqual(await dotLook(), ["0.4", "none", "none"], "the dot stays dim");
    await tagIs(page, "OBS didn’t start recording", 9000);
    assert.equal(await labelOf(), `OBS didn’t start recording yet. Call off take ${neverTake} of scene 3`);
    await until(page, (n) => window.said.includes(`OBS didn’t start recording scene 3, take ${n}, yet.`), neverTake);
    assert.equal(obs.record.active, false, "OBS records nothing");
    const stopsSoFar = obs.requests("StopRecord").length;
    await page.keyboard.press("r");
    await until(page, () => window.said.at(-1) === "Take called off.", null, 9000);
    await until(page, () => document.querySelector(".rec-light").dataset.state === "idle");
    assert.equal(obs.requests("StopRecord").length, stopsSoFar, "no stop is sent for a take OBS never began");
    assert.deepEqual(await saidSince(saidAt, /^(Recording|Stopped) /), [], "never \"Recording\" or \"Stopped\" for a take OBS did not record");
    await obsUntil(() => obs.record.format === OWN, "OBS's own file name is back once the take is called off", 9000);
    obs.startLag = 20;
    ok("a start OBS takes and never begins (a folder it cannot write): the light stays dim and says Starting…, then \"OBS didn’t start recording\" (read out), never red, no timer and no \"Recording\"; R calls the take off with no stop sent");

    // R while the light still says Starting, for a take OBS never begins: the light says Stopping with
    // no timer (no "00:00" for a take that never recorded), then the take is called off.
    obs.startLag = null;
    saidAt = await page.evaluate(() => window.said.length);
    startsBefore = obs.requests("StartRecord").length;
    await page.keyboard.press("r");
    await obsUntil(() => obs.requests("StartRecord").length === startsBefore + 1, "OBS is asked to record the take");
    await until(page, () => document.querySelector(".rec-light").getAttribute("aria-label").startsWith("Starting scene 3"));
    await page.keyboard.press("r");
    await tagIs(page, "Stopping…");
    l = await light(page);
    assert.deepEqual([l.state, l.time], ["stopping-early", null], "no timer for a take OBS has not begun, also while its stop waits");
    assert.deepEqual(await dotLook(), ["0.4", "none", "none"], "the dot stays dim");
    await until(page, (n) => window.said.slice(n).some((t) => /called off|OBS didn’t/.test(t)), saidAt, 9000);
    assert.deepEqual(await saidSince(saidAt, /^(Recording|Stopped|OBS didn’t|Take called off)/), ["Take called off."], "read out as called off only");
    ok("R while the light says Starting…, for a take OBS never begins: the light says Stopping… with no timer, then the take is called off");

    // Moving to another scene while a take is being started that OBS then never begins: called off, in those words.
    await obsUntil(() => obs.record.format === OWN, "OBS's own file name is back", 9000);
    obs.answer = (type) => (type === "StartRecord" ? { delay: 1000 } : null); // the start is still on its way when the scene changes
    saidAt = await page.evaluate(() => window.said.length);
    startsBefore = obs.requests("StartRecord").length;
    await page.keyboard.press("r");
    await obsUntil(() => obs.requests("StartRecord").length === startsBefore + 1, "OBS is asked to record the take");
    assert.equal((await light(page)).state, "starting");
    await page.keyboard.press("ArrowLeft");
    await until(page, (n) => window.said.slice(n).some((t) => /called off|OBS didn’t/.test(t)), saidAt, 9000);
    assert.deepEqual(await saidSince(saidAt, /^(Recording|Stopped|OBS didn’t|Take called off)/), ["Take called off."], "read out as called off, not as OBS's failure");
    obs.answer = null;
    await toSection(page, 3);
    await until(page, () => document.querySelector(".rec-light").dataset.state === "idle" && document.querySelector(".rec-light .rec-tag").textContent.startsWith("S3"));
    ok("going to another scene while a take is starting that OBS never begins calls the take off (read out as called off)");

    // OBS takes a start, says it is starting and gives the take up (it cannot write the file): the
    // light says so at once, the take is over, and R records the next take.
    await obsUntil(() => obs.record.format === OWN, "OBS's own file name is back", 9000);
    saidAt = await page.evaluate(() => window.said.length);
    startsBefore = obs.requests("StartRecord").length;
    await page.keyboard.press("r");
    await obsUntil(() => obs.requests("StartRecord").length === startsBefore + 1, "OBS is asked to record the take");
    const gaveUpTake = Number(obs.record.format.slice(-2));
    obs.giveUp();
    await tagIs(page, "OBS didn’t start recording");
    l = await light(page);
    assert.deepEqual([l.state, l.time, l.label], ["trouble", null, "OBS didn’t start recording. Try again"]);
    assert.deepEqual(await saidSince(saidAt, /^(Recording|Stopped|OBS didn’t) /), [`OBS didn’t start recording scene 3, take ${gaveUpTake}.`], "read out once, never as recording or stopped");
    await obsUntil(() => obs.record.format === OWN, "OBS's own file name is back");
    obs.startLag = 20;
    await page.keyboard.press("r");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
    assert.equal(await labelOf(), `Recording scene 3, take ${gaveUpTake + 1}. Stop`, "R records the next take");
    await page.keyboard.press("r");
    await until(page, (n) => window.said.includes(`Stopped scene 3, take ${n}.`), gaveUpTake + 1);
    await obsUntil(() => !obs.record.active, "the take stopped");
    ok("OBS takes a start and gives the take up: the light says \"OBS didn’t start recording\" at once (read out once), OBS's own file name goes back, and R records the next take");

    // A stop of OBS's own recording is still held (OBS has not answered it) when the link is turned off.
    obs.press(true);
    await until(page, () => document.querySelector(".rec-light").dataset.state === "recording");
    assert.equal(await labelOf(), "OBS is recording. Stop");
    obs.answer = (type) => (type === "StopRecord" ? { silent: true } : null);
    const saidBefore = await page.evaluate(() => window.said.length);
    await page.keyboard.press("r");
    await until(page, () => document.querySelector(".rec-light").dataset.state === "stopping");

    // Turned off: no light, no rail, and OBS is left as it is (the page does not say OBS stopped).
    await settings(page);
    await page.locator("#settings .big-toggle.obs").click();
    await closeSettings(page);
    await page.waitForTimeout(300);
    assert.equal(obs.record.active, true, "OBS still records");
    assert.deepEqual(await page.evaluate((n) => window.said.slice(n).filter((t) => /stopped/i.test(t)), saidBefore), [], "turning the link off does not say OBS stopped recording");
    ok("turning the OBS link off while a stop of OBS's own recording is still held leaves OBS recording and does not say it stopped");
    assert.equal((await light(page)).shown, false);
    assert.equal(await page.evaluate(() => localStorage.getItem("prompter-obs")), null);
  } finally {
    await ctx.close();
    await obs.stop();
  }

  // Phone: the light fits and nothing scrolls sideways.
  obs = await startObsStandin({ port: 4455 });
  const phone = await browser.newContext(MOBILE);
  await phone.addInitScript(() => {
    localStorage.setItem("prompter-obs", "on");
    // A browser that will not keep the take book: the takes still get their own numbers.
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === "prompter-takes") throw new Error("QuotaExceededError"); return set.call(this, k, v); };
  });
  const p = await phone.newPage();
  watch(p);
  try {
    await open(p);
    await toSection(p, 2);
    await tagIs(p, "S2 · T1");
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "nothing scrolls sideways");
    await shot(p, "record-light-idle-mobile");
    await p.evaluate(() => {
      window.said = [];
      const el = document.querySelector(".status");
      new MutationObserver(() => { if (el.textContent) window.said.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    for (const n of [1, 2]) {
      await p.locator(".rec-light").tap();
      await until(p, () => document.querySelector(".rec-light").dataset.state === "recording");
      await obsUntil(() => obs.record.active, `take ${n} records`);
      assert.match(obs.record.path, new RegExp(`scene-02-second-part-take-0${n}\\.mkv$`), `take ${n} has its own name`);
      await p.locator(".rec-light").tap();
      await until(p, () => document.querySelector(".rec-light").dataset.state === "idle");
      await obsUntil(() => !obs.record.active, `take ${n} stopped`);
    }
    assert.equal(await p.evaluate(() => localStorage.getItem("prompter-takes")), null, "the book was not kept");
    assert.equal(await p.evaluate(() => window.said.filter((t) => /can’t be saved on this device/.test(t)).length), 1, "said once, read out");
    assert.ok(await p.evaluate(() => window.said.includes("Stopped scene 2, take 2.")), "a stop is read out");
    await tagIs(p, "S2 · T2");
    // The closed rail is a 44px strip to tap (only its thin grip shows); a tap opens it.
    assert.ok(await p.evaluate(() => document.querySelector(".rec-rail").getBoundingClientRect().width >= 44), "the closed rail is a 44px target");
    const strip = await p.evaluate(() => {
      const r = document.querySelector(".rec-rail").getBoundingClientRect();
      const x = Math.round(r.left + 22), y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, rect: [r.left, r.top, r.width, r.height], hit: hit && (hit.className || hit.tagName), inRail: !!hit?.closest(".rec-rail") };
    });
    assert.ok(strip.inRail, `a tap on the strip reaches the rail: ${JSON.stringify(strip)}`);
    // Hover opens the rail only with a mouse: every hover rule of the rail sits inside that media query,
    // which a touch screen does not match, so the hover a tap leaves behind opens nothing.
    const railHover = await p.evaluate(() => {
      const found = [];
      const walk = (rules, media) => {
        for (const r of rules) {
          if (/\.rec-rail[^,{]*:hover/.test(r.selectorText || "")) found.push(media);
          if (r.cssRules) walk(r.cssRules, r.media ? r.media.mediaText : media);
        }
      };
      for (const sheet of document.styleSheets) walk(sheet.cssRules, "");
      return { found, mouse: matchMedia("(hover: hover) and (pointer: fine)").matches };
    });
    assert.ok(railHover.found.length > 0, "the rail has hover rules");
    assert.deepEqual([...new Set(railHover.found)], ["(hover: hover) and (pointer: fine)"], "the rail's hover rules apply only with a mouse");
    assert.equal(railHover.mouse, false, "a touch screen is not a mouse");
    assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector(".rail-scene")).pointerEvents), "none", "closed, the scenes take no taps");
    const sectionBefore = await p.evaluate(() => document.querySelector('.rail-go[aria-current="true"]').textContent);
    await p.touchscreen.tap(strip.x, strip.y);
    await until(p, () => document.querySelector(".rec-rail").getBoundingClientRect().width === 160);
    await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => document.querySelector(".rec-rail").getBoundingClientRect().width), 160, "stays open after the tap");
    assert.equal(await p.evaluate(() => document.querySelector('.rail-go[aria-current="true"]').textContent), sectionBefore, "the tap that opens it goes nowhere");
    const small = await p.evaluate(() => {
      document.querySelector(".rail-go").focus(); // keeps the rail open
      return [".rec-light", ".rec-star", ".rail-go", ".rail-take"].map((sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return [sel, Math.round(r.width), Math.round(r.height)];
      }).filter(([, w, h]) => w < 44 || h < 44);
    });
    assert.deepEqual(small, [], "44px targets on a phone");
    // The next tap picks a scene, and the rail closes back to its strip (the pointer still over it).
    await p.locator(".rail-go").nth(3).tap();
    await tagIs(p, "S3 · T1");
    await until(p, () => document.querySelector(".rec-rail").getBoundingClientRect().width === 44);
    await p.waitForTimeout(350);
    assert.equal(await p.evaluate(() => document.querySelector(".rec-rail").getBoundingClientRect().width), 44, "the rail stays closed after a scene is picked");
    // The closed 44px strip never lies over the script's words: they start to its right.
    const clear = await p.evaluate(() => {
      const rail = document.querySelector(".rec-rail").getBoundingClientRect();
      const script = document.querySelector(".script");
      const left = script.getBoundingClientRect().left + parseFloat(getComputedStyle(script).paddingLeft);
      const words = [...script.querySelectorAll(".line, p, li")].filter((el) => el.getBoundingClientRect().height > 0).slice(0, 20);
      const under = words.filter((el) => el.getBoundingClientRect().left < rail.right).length;
      return { rail: rail.right, left, under };
    });
    assert.ok(clear.left >= clear.rail && clear.under === 0, `the script's words start right of the rail's strip: ${JSON.stringify(clear)}`);
  } finally {
    await phone.close();
    await obs.stop();
  }
  ok("phone: the light fits at the top, nothing scrolls sideways; with a browser that will not keep the take book, two takes still get their own names (take-01, take-02); the light, star, rail scenes and dots are 44px targets; the rail opens by a tap, never by hover, and closes back to its strip once a scene is picked; the strip never lies over the script's words");

  // The reading line dragged to the very top (8%) on a phone held sideways: the record light never
  // covers it; the line sits just under the light while OBS is on, and goes back up once it is off.
  obs = await startObsStandin({ port: 4455 });
  const low = await browser.newContext(SIDEWAYS);
  await low.addInitScript(() => { localStorage.setItem("prompter-obs", "on"); localStorage.setItem("prompter-line", "0.08"); });
  const s = await low.newPage();
  watch(s);
  try {
    await open(s);
    await toSection(s, 1);
    await tagIs(s, "S1 · T1");
    const where = () => s.evaluate(() => ({ line: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--line")), light: document.querySelector(".rec-light").getBoundingClientRect().bottom, rec: !document.querySelector(".rec").hidden }));
    let at = await where();
    assert.ok(at.rec && at.line >= at.light + 8, `the reading line sits under the record light: ${JSON.stringify(at)}`);
    await s.locator(".settings-btn").click();
    await s.locator(".big-toggle.obs").click(); // OBS off
    await until(s, () => document.querySelector(".rec").hidden);
    at = await where();
    assert.equal(at.line, Math.round(390 * 0.08), `with OBS off the line goes back to where it was put: ${JSON.stringify(at)}`);
  } finally {
    await low.close();
    await obs.stop();
  }
  ok("a phone held sideways with the reading line dragged to the top: the record light never covers the line, which sits just under it while OBS is on and goes back up once OBS is off");

  // Text only's "what happens next" strip (TOOLS-491) and the record light never overlap: under 1240px wide
  // the strip is a card at the top, where the light is, so the card starts below the light while the light
  // shows (and goes back to the top when the OBS link is off); on a wide screen the strip stays beside the
  // text, clear of the light at the top centre. Checked idle, recording, and with OBS gone (the light's
  // longest words), and the link turned on with the card already showing.
  const STRIP_SCRIPT = SCRIPT
    .replace("### **1 · FIRST PART · 01:00**\n\n", "### **1 · FIRST PART · 01:00**\n\n- Docs: https://example.com/docs\n\nThe docs open now.\n[Face small]\nThe camera goes small.\n")
    .replace("### **2 · SECOND PART · 02:00**\n\n", "### **2 · SECOND PART · 02:00**\n\n[Face full]\nThe camera comes back.\n");
  {
    const apart = (page) => page.evaluate(() => {
      const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      const shown = (sel) => { const el = document.querySelector(sel); return !el.closest("[hidden]") && getComputedStyle(el).display !== "none"; };
      const l = box(".rec"), c = box(".next-up");
      const light = box(".rec-light");
      return {
        light: shown(".rec-light"), strip: shown(".next-up"), lightBox: light, stripBox: c,
        overlap: light.top < c.bottom && light.bottom > c.top && light.left < c.right && light.right > c.left,
        stripTop: Math.round(c.top), lightBottom: Math.round(l.bottom), fits: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    for (const [where, options, name] of [["a phone (390×844)", MOBILE, "mobile"], ["a narrow laptop window (1024×768)", { viewport: { width: 1024, height: 768 } }, "narrow"], ["a wide screen (1366×900)", DESKTOP, "wide"]]) {
      obs = await startObsStandin({ port: 4455 });
      const c = await browser.newContext(options);
      await c.addInitScript(() => { localStorage.setItem("prompter-text-only", "on"); });
      const q = await c.newPage();
      watch(q);
      try {
        await open(q, STRIP_SCRIPT);
        await toSection(q, 1);
        await q.locator(".next-up").waitFor();
        const before = await apart(q);
        assert.equal(before.light, false, `${where}: the OBS link is off, no light`);
        // The OBS link turned on while the strip already shows.
        await settings(q);
        await q.locator("#settings .big-toggle.obs").click();
        await until(q, () => document.querySelector(".big-toggle.obs").dataset.state === "on");
        await closeSettings(q);
        await tagIs(q, "S1 · T1");
        const narrow = options.viewport.width < 1240;
        const check = async (state) => {
          await q.waitForTimeout(150);
          const a = await apart(q);
          assert.ok(a.light && a.strip, `${where}, ${state}: the light and the strip both show: ${JSON.stringify(a)}`);
          assert.equal(a.overlap, false, `${where}, ${state}: the record light and the strip do not overlap: ${JSON.stringify(a)}`);
          assert.ok(a.fits, `${where}, ${state}: nothing scrolls sideways`);
          if (narrow) assert.ok(a.stripTop >= a.lightBottom, `${where}, ${state}: the card starts below the light: ${JSON.stringify(a)}`);
          return a;
        };
        await check("idle");
        await shot(q, `record-light-strip-${name}`);
        await q.locator(".rec-light").click();
        await until(q, () => document.querySelector(".rec-light").dataset.state === "recording");
        await obsUntil(() => obs.record.active, `${where}: the take records`);
        await check("recording");
        await q.locator(".rec-light").click();
        await until(q, () => document.querySelector(".rec-light").dataset.state === "idle");
        await obs.stop();
        await until(q, () => /OBS not found|Reconnecting/.test(document.querySelector(".rec-light").textContent), null, 20000);
        await check("OBS gone");
        // The link off: the light goes and the card is back at the top (no empty room above it).
        await settings(q);
        await q.locator("#settings .big-toggle.obs").click();
        await closeSettings(q);
        await q.waitForTimeout(150);
        const off = await apart(q);
        assert.equal(off.light, false, `${where}: off, no light`);
        if (narrow) assert.equal(off.stripTop, before.stripTop, `${where}: off, the card is back where it was: ${JSON.stringify(off)}`);
      } finally {
        await c.close();
        await obs.stop();
      }
    }
    ok("Text only's strip and the record light never overlap: on a phone (390×844) and a narrow laptop window (1024×768) the card starts below the light while it shows (idle, recording, OBS gone, and the link turned on with the card already showing) and goes back to the top when the link is off; on a wide screen (1366×900) the strip stays beside the text, clear of the light");
  }

  // A phone held upright with the reading line dragged to the very top (near the camera): the Producer's
  // cue pill and the Reconnecting to speech note never sit under the record light, so a tap on the pill
  // opens the cue and never starts or stops a take, and the two texts never run into each other.
  if (mode === "wrangler") {
    obs = await startObsStandin({ port: 4455 });
    const c = await browser.newContext(MOBILE);
    await c.addInitScript(() => { localStorage.setItem("prompter-obs", "on"); localStorage.setItem("prompter-line", "0.08"); localStorage.setItem("prompter-text-only", "on"); localStorage.setItem("prompter-voice-ok", "yes"); });
    await c.addInitScript(SPEECH_STUB);
    const q = await c.newPage();
    watch(q);
    try {
      await open(q, STRIP_SCRIPT);
      const agent = await linkAgent(q);
      await toSection(q, 1);
      await tagIs(q, "S1 · T1");
      await q.locator(".next-up").waitFor();
      // One take recorded, so the star shows beside the light and makes it wider.
      let at = await q.locator(".rec-light").boundingBox();
      await q.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
      await until(q, () => document.querySelector(".rec-light").dataset.state === "recording");
      at = await q.locator(".rec-light").boundingBox();
      await q.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
      await until(q, () => document.querySelector(".rec-light").dataset.state === "idle" && !document.querySelector(".rec-star").hidden);
      await agent("tools/call", { name: "push_suggestions", arguments: { items: [{ kind: "point", text: "Say where the files end up." }, { kind: "steer", text: "Back to the costs." }] } });
      await q.locator(".ask-pill").waitFor();
      // Follow my voice on, and speech keeps failing: the page itself puts up the Reconnecting to speech note.
      await q.evaluate(() => document.querySelector("#settings").showPopover()); // the control bar hides while a phone reads
      await q.locator("#settings .voice").click();
      await closeSettings(q);
      await q.waitForFunction(() => window.__speech.started >= 1);
      for (let i = 0; i < 10 && !(await q.evaluate(() => document.querySelector(".toast").dataset.show)); i++) {
        const n = await q.evaluate(() => { window.__speech.fail("network"); return window.__speech.started; });
        await q.waitForFunction((k) => window.__speech.started > k, n, { timeout: 5000 });
      }
      assert.equal(await q.evaluate(() => document.querySelector(".toast").dataset.show && document.querySelector(".toast-text").textContent), "Reconnecting to speech…");
      await q.waitForTimeout(500); // the note's fade in
      const clear = () => q.evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
        const hits = (a, b) => a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
        const next = document.querySelector(".next-up"), note = box(document.querySelector(".toast"));
        return { next: next.hidden ? null : box(next), low: next.hasAttribute("data-low"), note, noteLow: document.querySelector(".toast").hasAttribute("data-low"), over: !next.hidden && hits(note, box(next)) };
      });
      const meet = await q.evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
        const hits = (a, b) => a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
        const rec = box(document.querySelector(".rec")), pill = box(document.querySelector(".ask-pill")), note = box(document.querySelector(".toast"));
        const light = [...document.querySelectorAll(".rec > :not([hidden])")].map(box);
        const edge = document.elementFromPoint(pill.left + 8, (pill.top + pill.bottom) / 2);
        return {
          rec, pill, note, place: document.querySelector(".ask-pill").dataset.place,
          pillUnder: light.some((l) => hits(l, pill)), noteUnder: light.some((l) => hits(l, note)),
          edge: edge && (edge.className || edge.tagName), onPill: !!edge?.closest(".ask-pill"),
          inView: note.top >= 0 && note.bottom <= innerHeight && pill.top >= 0 && pill.bottom <= innerHeight,
        };
      });
      assert.equal(meet.pillUnder, false, `the cue pill is clear of the record light: ${JSON.stringify(meet)}`);
      assert.ok(meet.onPill, `a tap at the pill's left edge reaches the pill: ${JSON.stringify(meet)}`);
      assert.equal(meet.noteUnder, false, `the Reconnecting to speech note is clear of the record light: ${JSON.stringify(meet)}`);
      assert.ok(meet.inView, `both stay on the screen: ${JSON.stringify(meet)}`);
      // Text only's card goes low too: the note sits above it, never over what comes next.
      let card = await clear();
      assert.ok(card.next && card.low && card.noteLow, `Text only's card and the note both go low: ${JSON.stringify(card)}`);
      assert.equal(card.over, false, `the note is clear of Text only's card with the cue pill low: ${JSON.stringify(card)}`);
      await shot(q, "record-light-pill-high-line-mobile");
      await agent("tools/call", { name: "clear_suggestions", arguments: {} });
      await q.locator(".ask-pill").waitFor({ state: "hidden" });
      await q.waitForTimeout(300);
      card = await clear();
      assert.ok(card.next && card.low && card.noteLow, `with no cue waiting, both still sit low: ${JSON.stringify(card)}`);
      assert.equal(card.over, false, `the note is clear of Text only's card with no cue pill: ${JSON.stringify(card)}`);
      // Words heard: the note goes, and the card comes back down to just above the control bar.
      await q.evaluate(() => window.__speech.say("hi"));
      await until(q, () => !document.querySelector(".toast").dataset.show);
      const down = await q.evaluate(() => {
        const next = document.querySelector(".next-up");
        return { inline: next.style.insetBlockEnd, gap: Math.round(innerHeight - next.getBoundingClientRect().bottom), want: Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dock-h")) + 8) };
      });
      assert.deepEqual([down.inline, down.gap], ["", down.want], `the card is back above the control bar: ${JSON.stringify(down)}`);
      ok("a phone with the reading line at the very top: the Producer's cue pill and the Reconnecting to speech note go low, clear of the record light, so a tap on the pill opens the cue; the note sits above Text only's card there, with or without a cue waiting");
    } finally {
      await c.close();
      await obs.stop();
    }
  }

  // The longest cue the Producer may send (300 characters), on a phone held sideways and on a laptop:
  // its box never covers the record light, so the light still stops the take, and the cue stays open.
  if (mode === "wrangler") {
    const LONG = "Ask where the recorded files end up on the computer, and how a viewer finds the right take again a week later. ".repeat(3).slice(0, 300).trim();
    assert.ok(LONG.length > 290 && LONG.length <= 300, "the cue is as long as a cue may be");
    for (const [where, options, name] of [["a phone held sideways (844×390)", SIDEWAYS, "sideways"], ["a laptop (1280×800)", LAPTOP, "laptop"]]) {
      obs = await startObsStandin({ port: 4455 });
      const c = await browser.newContext(options);
      await c.addInitScript(() => { localStorage.setItem("prompter-obs", "on"); });
      const q = await c.newPage();
      watch(q);
      try {
        await open(q);
        const agent = await linkAgent(q);
        await toSection(q, 1);
        await tagIs(q, "S1 · T1");
        const press = async (x, y) => (options.hasTouch ? q.touchscreen.tap(x, y) : q.mouse.click(x, y));
        let at = await q.locator(".rec-light").boundingBox();
        await press(at.x + at.width / 2, at.y + at.height / 2);
        await until(q, () => document.querySelector(".rec-light").dataset.state === "recording");
        await obsUntil(() => obs.record.active && /scene-01-first-part-take-01\.mkv$/.test(obs.record.path), `${where}: the take records`);
        await agent("tools/call", { name: "push_suggestions", arguments: { items: [{ kind: "question", text: LONG }] } });
        at = await q.locator(".ask-pill").boundingBox();
        await press(at.x + at.width / 2, at.y + at.height / 2);
        await q.locator(".ask-box").waitFor();
        const meet = await q.evaluate(() => {
          const rect = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
          const l = rect(".rec-light"), b = rect(".ask-box"), use = rect(".ask-foot .btn:last-child"), dock = rect(".dock");
          const text = document.querySelector(".ask-text");
          const x = (l.left + l.right) / 2, y = (l.top + l.bottom) / 2;
          const hit = document.elementFromPoint(x, y);
          return {
            x, y, light: l, box: b,
            covered: b.top < l.bottom && b.bottom > l.top && b.left < l.right && b.right > l.left,
            hit: hit && (hit.className || hit.tagName), onLight: !!hit?.closest(".rec-light"),
            inView: b.top >= 0 && b.bottom <= innerHeight && use.bottom <= b.bottom,
            clearOfDock: b.bottom <= dock.top,
            lines: text.clientHeight / parseFloat(getComputedStyle(text).lineHeight),
          };
        });
        assert.equal(meet.covered, false, `${where}: the cue's box does not cover the record light: ${JSON.stringify(meet)}`);
        assert.ok(meet.onLight, `${where}: the light is what a tap at its place reaches: ${JSON.stringify(meet)}`);
        assert.ok(meet.inView && meet.clearOfDock, `${where}: the box, with Skip and Use, stays on the screen and clear of the control bar: ${JSON.stringify(meet)}`);
        assert.ok(meet.lines >= 2, `${where}: at least two lines of the cue show at once: ${JSON.stringify(meet)}`);
        await shot(q, `record-light-long-cue-${name}`);
        await press(meet.x, meet.y);
        await until(q, () => document.querySelector(".rec-light").dataset.state === "idle");
        await obsUntil(() => !obs.record.active && obs.requests("StopRecord").length === 1, `${where}: the light stopped the take while the long cue showed`);
        assert.equal(await q.locator(".ask-box").isVisible(), true, `${where}: the cue stays open`);
      } finally {
        await c.close();
        await obs.stop();
      }
    }
    ok("the longest cue (300 characters) never covers the record light, on a phone held sideways (844×390) and on a laptop (1280×800): a tap or click on the light stops the take, the cue stays open, and Skip and Use stay in view above the control bar");
  }

  assert.deepEqual(errors, [], errors.join("\n"));
  ok("no page or console errors");
  return { checks, screenshots };
}
