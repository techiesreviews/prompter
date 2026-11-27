// TOOLS-486 (Lex's round 3 pick, 2026-11-27): the script reads in paragraphs. In the Lines layout (the
// default) each row ends after a comma or a full stop, never in the middle of a sentence; Paragraphs lets
// the lines of one thought flow together. Line height (165%) and paragraph spacing (200%) are sliders in
// Settings. Text still to be read is white in every section. Bullet points hang under an orange dot with
// no box, the sentence that leads into them is bolder and sits close. Reminders, camera cues and link
// lines stay, small and dimmed.
import assert from "node:assert/strict";
import { join } from "node:path";

const SCRIPT = `### **INTRO · 00:00**

We are going through this route
in four waypoints. In the last video,
we set up the basics, and today
we finish it.
[Face small, bottom right]
A new paragraph after a camera cue.
[Show on screen: the plugin list]

One more thing before we move on.
WP 2FA has a paid version with some nice additions:

- Trusted devices
- Backup codes, printed once
- Login reports
Back to the words after the points.
- Plugin page: https://wordpress.org/plugins/wp-2fa/
Next: the next section.

### **1 · MORE · 01:00**

The other section is white too.
`;

const TEXT = "oklch(0.975 0.012 282)";
const MUTED = "oklch(0.763 0.027 282)";
const ACCENT = "oklch(0.65 0.227 32.3)";

export async function run({ browser, base, out }) {
  const checks = [];
  const screenshots = [];
  const ok = (line) => { checks.push(line); console.log(`ok ${line}`); };
  const shot = async (page, name) => {
    const file = join(out, `paragraphs-${name}.png`);
    await page.screenshot({ path: file });
    screenshots.push(file);
  };
  const open = async (page) => {
    await page.goto(base);
    await page.locator('.empty [data-action="paste"]').click();
    await page.locator("#paste-text").fill(SCRIPT);
    await page.locator('[data-action="open-paste"]').click();
    await page.locator(".section").nth(1).waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  // Room between blocks of the first section, in px: [from, to, space between them].
  const spaces = (page) => page.evaluate(() => {
    const sec = document.querySelector(".section");
    const name = (el) => `${el.className.split(" ")[0]}:${el.textContent.trim().slice(0, 14)}`;
    const blocks = [...sec.children].filter((el) => !el.matches(".title, .links, .ql"));
    return blocks.slice(1).map((el, i) => [name(blocks[i]), name(el), Math.round(el.getBoundingClientRect().top - blocks[i].getBoundingClientRect().bottom)]);
  });
  const settings = async (page) => {
    if (!(await page.locator("#settings:popover-open").count())) await page.locator(".dock .settings-btn").click();
    await page.locator("#settings:popover-open").waitFor();
  };

  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(base);
    await page.evaluate(() => localStorage.setItem("prompter-spacing", "roomy")); // the retired Line spacing
    await open(page);
    assert.equal(await page.evaluate(() => localStorage.getItem("prompter-spacing")), null, "the retired Line spacing choice is cleared from the device");
    const size = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--size")));
    assert.equal(size, 52);

    // Defaults: Lines, line height 165%, paragraph spacing 200%; nothing stored until changed.
    assert.deepEqual(await page.evaluate(() => {
      const script = getComputedStyle(document.querySelector(".script"));
      return [document.documentElement.dataset.layout, Math.round((parseFloat(script.lineHeight) / parseFloat(script.fontSize)) * 100),
        Object.keys(localStorage).filter((k) => /line-height|paragraph|layout/.test(k))];
    }), ["lines", 165, []]);
    ok("defaults: the Lines layout, line height 165%, paragraph spacing 200%; nothing stored until changed");

    // Lines: a row ends after a comma or a full stop; script lines that stop mid-sentence join the next.
    const rows = await page.locator(".section").first().locator(".para").first().locator(".row").allTextContents();
    assert.deepEqual(rows, ["We are going through this route in four waypoints. In the last video,", "we set up the basics, and today we finish it."]);
    assert.equal(await page.locator(".section").first().locator(".para").first().locator("[data-k]").count(), 4, "each script line keeps its own place for Follow my voice");
    const midSentence = await page.evaluate(() => [...document.querySelectorAll(".para .row")]
      .filter((row) => row.nextElementSibling?.matches(".row") && !/[,.;:!?…]["'”’)\]]*$/.test(row.textContent.trim()))
      .map((row) => row.textContent));
    assert.deepEqual(midSentence, [], "no row ends in the middle of a sentence");
    assert.deepEqual(await page.locator(".para .row").evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).display))]), ["block"]);
    ok("Lines: each row ends after a comma or a full stop (lines that stop mid-sentence join the next); each script line still has its own place for Follow my voice");

    // The room between blocks at the defaults (text 52px): rows a quarter of the text size apart,
    // paragraphs twice the text size; a reminder heads what follows it; points at half the spacing.
    const P = size * 2;
    const R = size * 0.25;
    const expect = [
      ["para", "note", P], // a camera cue after spoken words starts a new block
      ["note", "para", R], // and heads the paragraph it belongs to
      ["para", "note", P],
      ["note", "para", P], // a blank line
      ["para", "points", P / 2], // the lead-in sits close to its points
      ["points", "para", P],
      ["para", "mark", P], // a link line
      ["mark", "para", R],
    ];
    const at = await spaces(page);
    assert.deepEqual(at.map(([a, b]) => [a.split(":")[0], b.split(":")[0]]), expect.map(([a, b]) => [a, b]), JSON.stringify(at));
    at.forEach(([a, b, px], i) => assert.ok(Math.abs(px - expect[i][2]) <= 2, `${a} → ${b}: ${px}px, expected ${expect[i][2]}px`));
    const rowGap = await page.locator(".para").first().evaluate((el) => {
      const [a, b] = el.querySelectorAll(".row");
      return Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
    });
    assert.ok(Math.abs(rowGap - R) <= 2, `rows ${rowGap}px apart, expected ${R}`);
    const pointGap = await page.locator(".points .bullet").nth(1).evaluate((el) => Math.round(el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom));
    assert.ok(Math.abs(pointGap - P / 2) <= 2, `points ${pointGap}px apart, expected ${P / 2}`);
    ok("spacing: rows a quarter of the text size apart, paragraphs 200%, points and their lead-in half of that; a reminder, cue or link line heads what follows it");

    // Points: no box, an orange dot hanging left of each, the lead-in one step bolder.
    const points = await page.evaluate(() => {
      const box = (el) => { const cs = getComputedStyle(el); return [cs.backgroundColor, cs.borderStyle, cs.boxShadow, cs.outlineStyle]; };
      const b = document.querySelector(".bullet");
      const dot = getComputedStyle(b, "::before");
      const lines = [...document.querySelector(".points").previousElementSibling.querySelectorAll("[data-k]")];
      const weight = (el) => getComputedStyle(el).fontWeight;
      return {
        boxes: [box(document.querySelector(".points")), box(b)],
        dot: [dot.content, dot.position, dot.color],
        hangs: b.querySelector("[data-k]").getBoundingClientRect().left - document.querySelector(".para").getBoundingClientRect().left,
        lead: lines.map((el) => [el.textContent.trim().slice(0, 14), el.matches(".lead"), weight(el)]),
      };
    });
    assert.deepEqual(points.boxes, [["rgba(0, 0, 0, 0)", "none", "none", "none"], ["rgba(0, 0, 0, 0)", "none", "none", "none"]], "no box, border, ring or shadow behind the points");
    assert.deepEqual(points.dot, ['"•"', "absolute", ACCENT]);
    assert.ok(points.hangs > size * 0.5 && points.hangs < size * 1.2, `the point's words hang right of the dot: ${points.hangs}`);
    assert.deepEqual(points.lead, [["One more thing", false, "600"], ["WP 2FA has a p", true, "700"]], "only the last line of the paragraph above the points is bolder");
    ok("points: no box, border or ring; an orange dot hangs left of each; only the line leading into them is bolder (700), the lines before it stay 600");

    // Colours: words white in every section (Next: lines too, plain); reminders, cues and links dimmed.
    const colours = await page.evaluate(() => {
      const c = (sel) => getComputedStyle(document.querySelector(sel)).color;
      return {
        other: c(".section:not(.active) [data-k]"),
        next: c(".next"),
        nextBold: document.querySelectorAll(".next b, .now b").length,
        cue: [c(".cue-what"), c(".cue-icon"), c(".cue")],
        note: c(".note:not(.cue)"),
        mark: c(".mark"),
        small: ["note", "cue", "mark"].map((k) => parseFloat(getComputedStyle(document.querySelector(`.${k}`)).fontSize) < 32),
      };
    });
    assert.deepEqual(colours, { other: TEXT, next: TEXT, nextBold: 0, cue: [MUTED, MUTED, MUTED], note: MUTED, mark: MUTED, small: [true, true, true] });
    ok("colours: the words are white in every section (Next: lines plain); reminders, camera cues and link lines small and dimmed");
    await shot(page, "lines-desktop");

    // Settings: the two sliders and the layout change the page at once and are remembered.
    await settings(page);
    assert.deepEqual(await page.locator("#settings .setting").evaluateAll((rows) => rows.map((row) => row.querySelector("legend, label").textContent.trim())),
      ["Text size", "Scroll speed", "Line height", "Paragraph spacing", "Width", "Layout"]);
    assert.deepEqual(await page.locator("#settings .layout .seg label").allTextContents(), ["Lines", "Paragraphs"]);
    assert.deepEqual([await page.locator(".line-height-val").inputValue(), await page.locator(".para-space-val").inputValue(), await page.locator('input[name="layout"]:checked').getAttribute("value")], ["165", "200", "lines"]);
    await page.locator(".line-height").fill("130");
    await page.locator(".para-space").fill("0");
    assert.equal(await page.locator(".script").evaluate((el) => Math.round((parseFloat(getComputedStyle(el).lineHeight) / parseFloat(getComputedStyle(el).fontSize)) * 100)), 130);
    const flat = await spaces(page);
    assert.ok(flat.filter(([a]) => !a.startsWith("note") && !a.startsWith("mark")).every(([, , px]) => Math.abs(px) <= 2), `paragraph spacing 0: ${JSON.stringify(flat)}`);
    await page.locator(".para-space-val").fill("100");
    await page.locator(".para-space-val").press("Enter");
    assert.ok(Math.abs((await spaces(page))[0][2] - size) <= 2, "100%: one text size between paragraphs");
    await page.locator('#settings .layout .seg label:has-text("Paragraphs")').click();
    assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.layout, getComputedStyle(document.querySelector(".row")).display]), ["paragraphs", "inline"]);
    await shot(page, "paragraphs-desktop");
    assert.deepEqual(await page.evaluate(() => ["prompter-line-height", "prompter-paragraph-spacing", "prompter-layout"].map((k) => localStorage.getItem(k))), ["130", "100", "paragraphs"]);
    await page.reload();
    await page.locator(".section").first().waitFor();
    assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.layout, document.querySelector(".line-height-val").value, document.querySelector(".para-space-val").value,
      Math.round((parseFloat(getComputedStyle(document.querySelector(".script")).lineHeight) / parseFloat(getComputedStyle(document.querySelector(".script")).fontSize)) * 100)]), ["paragraphs", "130", "100", 130]);
    ok("Settings: Line height, Paragraph spacing (0 allowed) and Layout (Lines, Paragraphs) change the page at once and are remembered after a reload");
  } finally {
    await context.close();
  }

  // A phone: no sideways scroll, points still hang under their dots.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    const page = await phone.newPage();
    await open(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
    await page.locator(".points").evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - document.querySelector(".reading-line").getBoundingClientRect().top));
    await page.waitForTimeout(200);
    await shot(page, "points-mobile");
    ok("phone: no sideways scroll; the points read under their dots");
  } finally {
    await phone.close();
  }

  // Follow my voice where script lines share a row (Paragraphs): the first line still on the row at
  // the reading line is the one followed, also after a hand scroll and a line height change.
  const voiced = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  try {
    await voiced.addInitScript(() => {
      localStorage.setItem("prompter-layout", "paragraphs");
      localStorage.setItem("prompter-voice-ok", "yes");
      const state = { instance: null, results: [] };
      class FakeRecognition {
        static async available() { return "unavailable"; }
        start() { state.results = []; state.instance = this; }
        stop() { this.onend?.(); }
        abort() {}
      }
      FakeRecognition.prototype.processLocally = false;
      state.say = (text) => {
        const result = [{ transcript: text }];
        result.isFinal = true;
        state.results.push(result);
        state.instance?.onresult?.({ results: state.results, resultIndex: state.results.length - 1 });
      };
      window.__speech = state;
      window.SpeechRecognition = FakeRecognition;
      delete window.webkitSpeechRecognition;
    });
    const page = await voiced.newPage();
    await open(page);
    // The first pair of spoken lines where the later one starts on the row the earlier one ends on.
    const shared = await page.evaluate(() => {
      const els = [...document.querySelectorAll(".para [data-k]")];
      for (let i = 1; i < els.length; i++) {
        const a = [...els[i - 1].getClientRects()].at(-1);
        const b = els[i].getClientRects()[0];
        if (a && b && Math.abs(a.top - b.top) < 2) {
          const line = document.querySelector(".reading-line").getBoundingClientRect().top;
          window.scrollBy(0, b.top + b.height / 2 - line);
          return { first: els[i - 1].textContent, next: els[i].textContent };
        }
      }
      return null;
    });
    assert.ok(shared, "two spoken lines share a row in Paragraphs");
    await page.waitForTimeout(100);
    const cur = () => page.evaluate(() => document.querySelector(".cur")?.textContent ?? null);
    const openSettings = async () => { await page.mouse.move(683, 895); await settings(page); }; // the bar tucks away after scrolling down
    await openSettings();
    await page.locator("#settings .voice").click();
    assert.equal(await page.locator("#settings .voice").getAttribute("aria-pressed"), "true");
    await page.evaluate(() => document.querySelector("#settings").hidePopover());
    await page.mouse.move(683, 600);
    await page.mouse.wheel(0, 1);
    await page.waitForTimeout(150);
    assert.equal(await cur(), shared.first, "turned on, then a hand scroll within the row: the first line still on the row at the reading line");
    await openSettings();
    await page.locator(".line-height").fill("150");
    await page.waitForTimeout(150);
    assert.equal(await cur(), shared.first, "a line height change keeps the line being read");
    await page.evaluate(() => document.querySelector("#settings").hidePopover());
    await page.evaluate((words) => window.__speech.say(words), `${shared.first} ${shared.next.split(" ")[0]}`);
    await page.waitForFunction((text) => document.querySelector(".cur")?.textContent === text, shared.next, { timeout: 3000 });
    ok("Follow my voice, lines sharing a row: the first one on the row is followed (turned on, after a hand scroll and a line height change), then the next as it is read");
  } finally {
    await voiced.close();
  }
  return { checks, screenshots };
}
