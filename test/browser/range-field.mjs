// Browser checks and close-ups for the shared range field (src/ui/), on a page of its
// own: no server, a few seconds. `kit specs range-field` runs only these; the page's
// own Settings checks (its colours, what typing changes, what is remembered) stay in
// page.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const needsServer = false;

const UI = resolve(import.meta.dirname, "../../src/ui");
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>${readFileSync(join(UI, "range-field.css"), "utf8")}
body { margin: 0; padding: 16px; background: oklch(16% 0.06 282); color: oklch(97.5% 0.012 282); font: 14px system-ui, sans-serif; }
.fields { display: grid; gap: 8px; max-inline-size: 312px; }
</style></head><body><div class="fields">
<div class="range-field size-field"><label for="size">Text size</label><input id="size" type="range" min="20" max="110" step="2" value="52"><label class="range-value"><input class="size-val" type="number" min="10" max="300" inputmode="numeric" value="52" aria-label="Text size in pixels"><span aria-hidden="true">px</span></label></div>
<div class="range-field speed-field"><label for="speed">Scroll speed</label><input id="speed" type="range" min="10" max="300" step="10" value="40"><label class="range-value"><input class="speed-val" type="number" min="1" max="999" inputmode="numeric" value="40" aria-label="Scroll speed in pixels per second"></label></div>
</div><button class="away">Away</button><script>${readFileSync(join(UI, "range-field.mjs"), "utf8").replace(/^export /gm, "")}
document.querySelectorAll(".range-field").forEach((f) => rangeField(f));</script></body></html>`;

export async function run({ browser, out }) {
  const checks = [];
  const screenshots = [];
  const ok = (name) => checks.push(`range field: ${name}`);
  const closeUp = async (page, name) => {
    const file = join(out, `${name}.png`);
    await page.locator(".fields").screenshot({ path: file });
    screenshots.push(file);
  };
  const errors = [];

  for (const [label, options] of [["desktop", { viewport: { width: 420, height: 300 } }], ["mobile", { viewport: { width: 390, height: 300 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
    await page.setContent(PAGE);
    const size = page.locator("#size");
    const box = page.locator(".size-val");
    const values = async () => [await size.inputValue(), await box.inputValue()];

    // One 44px box that is all slider: the name on the left, the value on the right, on top of it.
    // Slider parts cannot be read with getComputedStyle.
    assert.deepEqual(await page.locator(".size-field").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [getComputedStyle(el.querySelector('input[type="range"]')).appearance, r.height,
        el.querySelector('input[type="range"]').getBoundingClientRect().width === r.width,
        el.querySelector("label").getBoundingClientRect().left - r.left < 20,
        Math.abs(el.querySelector(".range-value").getBoundingClientRect().right - r.right) < 8];
    }), ["none", 44, true, true, true], `${label}: the slider spans the whole box, the name on the left, the value on the right`);

    // A press on the name lands on the slider; the value takes presses to the box's edge.
    const hitAt = (sel) => page.locator(`.size-field ${sel}`).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const edge = document.elementFromPoint(r.right - 2, r.top + r.height / 2);
      return [hit.closest(".range-value") ? "value" : hit.id, edge.closest(".range-value") !== null];
    });
    assert.deepEqual(await hitAt("label:first-child"), ["size", false], `${label}: a press on the name lands on the slider`);
    assert.deepEqual(await hitAt(".range-value"), ["value", true], `${label}: the value (to the box's edge) takes presses for typing`);

    await size.fill("80");
    const name = await page.locator(".size-field label:first-child").boundingBox();
    const value = await page.locator(".size-field .range-value").boundingBox();
    if (label === "mobile") {
      await page.touchscreen.tap(name.x + name.width / 2, name.y + name.height / 2);
      const tapped = await values();
      assert.ok(tapped[0] === tapped[1] && Number(tapped[0]) < 80, `a tap on the name moves the fill there: ${tapped}`);
      await page.touchscreen.tap(value.x + value.width / 2, value.y + value.height / 2);
      assert.equal(await page.evaluate(() => document.activeElement.className), "size-val", "a tap on the value focuses it for typing");
      ok("on a phone a tap on the name moves the fill; a tap on the value is for typing");
    } else {
      await page.mouse.click(name.x + name.width / 2, name.y + name.height / 2);
      const pressed = await values();
      assert.ok(pressed[0] === pressed[1] && Number(pressed[0]) < 80, `a press on the name moves the fill there: ${pressed}`);
      for (const [x, y] of [[value.width - 3, value.height / 2], [value.width - 5, 3]]) {
        await page.locator(".away").focus();
        await page.mouse.click(value.x + x, value.y + y);
        assert.deepEqual([await page.evaluate(() => document.activeElement.className), await size.inputValue()], ["size-val", pressed[0]], `a press on the value's clear border (${x}, ${y}) focuses it for typing; the slider stays`);
      }

      // The grip: faint at rest, bright on hover and when focused.
      await size.fill("70");
      await page.locator(".away").focus();
      const grip = () => page.locator(".size-field").evaluate((el) => [getComputedStyle(el).getPropertyValue("--rf-grip-size").trim(), getComputedStyle(el).getPropertyValue("--rf-grip-now").includes("color-mix")]);
      await page.mouse.move(0, 0);
      assert.deepEqual(await grip(), ["3px 34%", true], "faint grip at rest");
      await size.hover();
      assert.deepEqual(await grip(), ["3px 50%", false], "bright on hover");
      await page.mouse.move(0, 0);
      await size.focus();
      assert.deepEqual(await grip(), ["3px 50%", false], "and when focused");
      await page.keyboard.press("ArrowRight");
      assert.deepEqual([await size.inputValue(), await box.inputValue()], ["72", "72"], "arrow keys move it and the value follows");
      assert.equal(await page.locator(".size-field").evaluate((el) => getComputedStyle(el).outlineStyle), "solid", "the ring goes round the whole field");
      ok("a press on the name moves the fill, the value's whole end is for typing; the grip is faint at rest, bright on hover and focus; keys move it inside one ring");

      // Typing: the exact value is kept, the slider stops at its ends; Enter or leaving tidies.
      await box.fill("47");
      assert.deepEqual([...(await values()), await size.getAttribute("aria-valuetext")], ["48", "47", "47 px"], "off the step: the slider sits nearest and names the exact value");
      await box.fill("999");
      await box.press("Tab");
      assert.deepEqual(await values(), ["110", "300"], "Tab above the box's maximum: the largest allowed");
      await box.fill("");
      await box.press("Tab");
      assert.deepEqual(await values(), ["110", "300"], "an empty box goes back to the last value");
      await box.fill("5");
      await box.press("Escape");
      await page.locator(".away").focus();
      assert.deepEqual(await values(), ["110", "300"], "leaving half typed (below the minimum) goes back");
      await box.fill("5");
      await box.press("Enter");
      assert.deepEqual(await values(), ["20", "10"], "Enter: the smallest allowed");
      ok("typing keeps the exact value past the slider's ends; Enter or leaving tidies it, half typed or empty goes back");
    }

    // Close-ups: at rest, then the fill at both ends (under the name and under the value).
    await page.locator(".away").focus();
    await size.fill("52");
    await page.locator("#speed").fill("120");
    await page.mouse.move(0, 0);
    await closeUp(page, `range-field-${label}`);
    await size.fill("20");
    await page.locator("#speed").fill("300");
    await page.locator(".away").focus();
    await closeUp(page, `range-field-ends-${label}`);
    ok(`${label} close-ups: at rest, and the fill at both ends`);
    await context.close();
  }
  assert.deepEqual(errors, [], errors.join("\n"));
  return { checks, screenshots };
}
