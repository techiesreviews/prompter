// PROM-01: the sweep's 601-character token must be readable by vertical scrolling alone.
import assert from "node:assert/strict";
import { join } from "node:path";
import { SETTINGS } from "../../src/settings.mjs";

const TOKEN = `A${"verylongword".repeat(50)}`;
const SCRIPT = `### **ODD TEXT · 00:00**

Hello 👩🏽‍🚀 café é 中文 العربية.
<script>alert('garden')</script>
${TOKEN}
A real [plant guide](https://example.com/guide) here.

### **LAST · 01:00**

The end.
`;

export async function run({ browser, base, out }) {
  const checks = [];
  const screenshots = [];
  const failures = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    try {
      await context.addInitScript((settings) => {
        for (const [name, value] of [["size", "32"], ["width", "narrow"], ["spacing", "normal"]]) {
          localStorage.setItem(settings[name].key, value);
        }
      }, SETTINGS);
      const page = await context.newPage();
      await page.goto(base);
      await page.locator('.empty [data-action="paste"]').click();
      await page.locator("#paste-text").fill(SCRIPT);
      await page.locator('[data-action="open-paste"]').click();
      const paragraph = page.locator(".script p").filter({ hasText: TOKEN });
      await paragraph.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const layout = await paragraph.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = [...range.getClientRects()];
        return {
          text: el.textContent,
          column: box.width,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
          lines: rects.length,
          fits: rects.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1),
        };
      });
      const file = join(out, `reading-wrap-${viewport.width}.png`);
      await page.screenshot({ path: file });
      screenshots.push(file);
      assert.equal(layout.text, TOKEN, "the original token is preserved exactly");
      console.log(`PROM-01 ${viewport.width}px: ${JSON.stringify(layout)}`);
      if (layout.scrollWidth > layout.viewport + 1 || layout.lines <= 1 || !layout.fits) {
        failures.push(`${viewport.width}px: token has ${layout.lines} line(s); page ${layout.scrollWidth}px; column ${layout.column}px`);
      }
      // Bring the last character into view vertically, without horizontal scrolling.
      const lastVisible = await paragraph.evaluate((el) => {
        const range = document.createRange();
        const text = el.firstChild;
        range.setStart(text, text.length - 1);
        range.setEnd(text, text.length);
        const before = range.getBoundingClientRect();
        window.scrollTo(0, scrollY + before.top - innerHeight / 2);
        const after = range.getBoundingClientRect();
        return after.left >= 0 && after.right <= innerWidth && after.top >= 0 && after.bottom <= innerHeight;
      });
      if (!lastVisible) failures.push(`${viewport.width}px: the last character cannot be read by vertical scrolling alone`);
      checks.push(`${viewport.width}px: original 601-character token wraps within the column; no horizontal overflow; last character readable vertically`);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  return { checks, screenshots };
}
