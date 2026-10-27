// Browser checks and screenshots for `kit shots`. Runs against a local server
// (wrangler dev or a static server) and against dist/index.html via file://.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EXAMPLE_SCRIPT, FORMAT, makeLink } from "../../src/core.mjs";

const DESKTOP = { viewport: { width: 1366, height: 900 } };
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

export async function run({ browser, base, mode, dist, out }) {
  const checks = [];
  const screenshots = [];
  const ok = (name, detail = "") => checks.push(detail ? `${name}: ${detail}` : name);
  const shot = async (page, name, fullPage = false) => {
    await page.waitForTimeout(300); // let the 200 ms section fade finish
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file, fullPage });
    screenshots.push(file);
  };

  // ---- Server and MCP basics ----
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const csp = home.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src 'sha256-/);
  ok("home served with hash-pinned CSP", mode);

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

  // ---- Desktop ----
  const desktop = await browser.newContext(DESKTOP);
  const page = await desktop.newPage();
  watch(page, "desktop");
  await page.goto(`${base}/`);
  await page.locator("#home").waitFor();
  assert.equal(await page.locator(".format-rows tr").count(), FORMAT.length);
  assert.equal(await page.locator(".tabs[role=tablist] [data-preset]").count(), 2);
  assert.match(await page.locator(".mcp-url").textContent(), /\/mcp$/);
  await shot(page, "home-desktop", true);
  ok("home: format table, preset tabs, MCP address");

  await page.goto(link);
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), 5);
  assert.equal(await page.locator(".ql").count(), 4);
  assert.equal(await page.locator(".link").count(), 4);
  const introFirst = await page.locator(".section").nth(1).locator("p").first().getAttribute("class");
  assert.equal(introFirst, "ql");
  assert.equal(await page.locator(".problems-btn").getAttribute("data-count"), "0");
  await shot(page, "loaded-desktop");
  ok("link opens example: 5 sections, QL first, 4 link buttons, 0 problems (lex)");

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".section.active").getAttribute("data-i"), "2");
  await shot(page, "loaded-desktop-section-1");
  ok("arrow keys move to the next section");

  await page.locator(".problems-btn").click();
  await page.locator("dialog.problems[open]").waitFor();
  assert.match(await page.locator(".problem-list").textContent(), /No problems with the Lex style/);
  await shot(page, "check-dialog-desktop");
  await page.locator('.problem-tabs [data-preset="default"]').click();
  assert.match(await page.locator(".problem-list").textContent(), /No problems with the Default style/);
  await page.locator('[data-action="close-problems"]').click();
  ok("check dialog shows both presets");

  await page.locator('.bar [data-action="home"]').click();
  await page.locator("#home").waitFor();
  assert.match(await page.locator('[data-action="last"]').textContent(), /Continue: PREP/);
  ok("Home button returns home; last script remembered");

  await page.locator('[data-action="paste"]').click();
  await page.locator("#paste-text").fill("### **HELLO · 00:00**\n\nQL: Is this pasted?\n\nYes, pasted.");
  await page.locator('[data-action="open-paste"]').click();
  await page.locator(".section").first().waitFor();
  assert.equal(await page.locator(".section").count(), 1);
  await page.waitForFunction(() => location.hash.startsWith("#s="));
  ok("pasted script opens and gets a #s= address");

  // A link made for the default preset is checked with Default, even after Lex was chosen.
  await page.evaluate(() => localStorage.setItem("prompter-preset", "lex"));
  await page.goto(await makeLink(EXAMPLE_SCRIPT.replace("Thanks for watching.", "Thanks a lot for watching this video today."), "default", base));
  await page.locator(".section").first().waitFor();
  await page.locator(".problems-btn").click();
  assert.match(await page.locator(".problem-list").textContent(), /Default style/);
  await page.locator('[data-action="close-problems"]').click();
  ok("default links keep the default preset");

  await page.goto(`${base}/#s=@@@`);
  await page.locator(".home-error:not([hidden])").waitFor();
  ok("damaged link shows a plain error on home");

  // Reduced motion: no fade between sections.
  const calm = await browser.newContext({ ...DESKTOP, reducedMotion: "reduce" });
  const calmPage = await calm.newPage();
  await calmPage.goto(link);
  await calmPage.locator(".section").first().waitFor();
  const duration = await calmPage.locator(".section").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  assert.equal(duration, "0s");
  await calm.close();
  ok("prefers-reduced-motion removes the section fade");
  await desktop.close();

  // ---- Mobile ----
  const mobile = await browser.newContext(MOBILE);
  const m = await mobile.newPage();
  watch(m, "mobile");
  await m.goto(`${base}/`);
  await m.locator("#home").waitFor();
  await noOverflow(m, "mobile home");
  await shot(m, "home-mobile", true);
  await m.goto(link);
  await m.locator(".section").first().waitFor();
  await noOverflow(m, "mobile prompter");
  const barHeight = await m.locator(".bar").evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(barHeight < 844 * 0.34, `toolbar ${barHeight}px covers the reading line`);
  await shot(m, "loaded-mobile");
  ok("mobile: no sideways scroll; toolbar stays above the reading line", `${Math.round(barHeight)}px`);
  await mobile.close();

  // ---- Offline (file://) ----
  const offline = await browser.newContext(DESKTOP);
  const o = await offline.newPage();
  watch(o, "offline");
  const fileUrl = pathToFileURL(join(dist, "index.html")).href;
  await o.goto(fileUrl);
  await o.locator("#home").waitFor();
  await o.goto(fileUrl + new URL(link).hash);
  await o.locator(".section").first().waitFor();
  assert.equal(await o.locator(".section").count(), 5);
  const embedded = join(out, "offline-embedded.html");
  const sample = join(out, "sample.md");
  await import("node:fs").then(({ writeFileSync }) => writeFileSync(sample, EXAMPLE_SCRIPT));
  execFileSync(process.execPath, [resolve(import.meta.dirname, "../../scripts/embed.mjs"), sample, embedded], { env: { ...process.env, PROMPTER_DIST: dist } });
  await o.goto(pathToFileURL(embedded).href);
  await o.locator(".section").first().waitFor();
  assert.equal(await o.locator(".section").count(), 5);
  await offline.close();
  ok("offline: file:// home, file:// #s= link and an embedded offline copy all work");

  assert.deepEqual(errors, [], errors.join("\n"));
  ok("no page or console errors");
  return { mode, base, link, checks, screenshots };
}
