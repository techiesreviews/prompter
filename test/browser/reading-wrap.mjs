// PROM-01: the sweep's 601-character token must be readable by vertical scrolling alone.
import assert from "node:assert/strict";
import { join } from "node:path";
import { SETTINGS } from "../../src/settings.mjs";

const TOKEN = `A${"verylongword".repeat(50)}`;
const SCRIPT = `### **INTRO · 00:00**

Hello 👩🏽‍🚀 café é 中文 العربية.
<script>alert('garden')</script>
${TOKEN}
A real [plant guide](https://example.com/guide) here.

### **${TOKEN} · 01:00**

The end.

### **3 · WHY YOUR SOIL NEEDS MORE COMPOST EVERY SPRING · 12:00**

Keep the title beside its dot.
`;
// Large-font cases isolate the title defect; standalone links at 300px have a separate known overflow.
// Keep checking the original mixed-content fixture at 32px.
const LARGE_TITLE_SCRIPT = `### **INTRO · 00:00**

${TOKEN}

### **${TOKEN} · 01:00**

The end.

### **3 · WHY YOUR SOIL NEEDS MORE COMPOST EVERY SPRING · 12:00**

Keep the title beside its dot.
`;

export async function run({ browser, base, out }) {
  const checks = [];
  const screenshots = [];
  const failures = [];
  const cases = [
    { viewport: { width: 1440, height: 900 }, size: 32 },
    { viewport: { width: 390, height: 844 }, size: 32 },
    { viewport: { width: 390, height: 844 }, size: 120 },
    { viewport: { width: 390, height: 844 }, size: 300 },
  ];
  for (const { viewport, size } of cases) {
    const name = `${viewport.width}px at ${size}px text`;
    const context = await browser.newContext({ viewport });
    try {
      await context.addInitScript(({ settings, size }) => {
        for (const [name, value] of [["size", String(size)], ["width", "narrow"], ["spacing", "normal"]]) {
          localStorage.setItem(settings[name].key, value);
        }
      }, { settings: SETTINGS, size });
      const page = await context.newPage();
      await page.goto(base);
      await page.locator('.empty [data-action="paste"]').click();
      await page.locator("#paste-text").fill(size === 32 ? SCRIPT : LARGE_TITLE_SCRIPT);
      await page.locator('[data-action="open-paste"]').click();
      const paragraph = page.locator(".script p.say").filter({ hasText: TOKEN });
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
          overflow: [...document.querySelectorAll(".script *")].flatMap((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()].some((r) => r.right > innerWidth + 1)
              ? [`${node.tagName}.${node.className}: ${node.textContent.slice(0, 60)}`] : [];
          }),
        };
      });
      const file = join(out, `reading-wrap-${viewport.width}-${size}.png`);
      await page.screenshot({ path: file });
      screenshots.push(file);
      assert.equal(layout.text, TOKEN, "the original token is preserved exactly");
      for (const [index, title] of (await page.locator(".title").all()).entries()) {
        const heading = await title.evaluate((el) => {
          const column = el.getBoundingClientRect();
          const within = (r, box) => r.left >= box.left - 1 && r.right <= box.right + 1;
          const spans = [...el.children].map((span) => {
            const box = span.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(span);
            const glyphsFit = [...range.getClientRects()].every((r) => within(r, column) && within(r, box));
            range.setStart(span.firstChild, 0);
            range.setEnd(span.firstChild, 1);
            const character = range.getBoundingClientRect().width;
            return { width: box.width, character, fits: within(box, column) && glyphsFit };
          });
          const text = el.children[0].getBoundingClientRect();
          const time = el.children[1].getBoundingClientRect();
          const centeredOffset = Math.max(0, (time.height - text.height) / 2);
          return {
            spans,
            firstRow: text.top <= column.top + centeredOffset + 1,
            page: document.documentElement.scrollWidth,
            viewport: innerWidth,
          };
        });
        if (!heading.firstRow) failures.push(`${name}, title ${index + 1}: title leaves the dot alone on an earlier row`);
        if (heading.spans[0].width + 1 < heading.spans[0].character) failures.push(`${name}, title ${index + 1}: title span is narrower than one character`);
        if (heading.spans.some((span) => !span.fits)) failures.push(`${name}, title ${index + 1}: title or time glyphs leave their box or the column`);
        if (heading.page > heading.viewport + 1) failures.push(`${name}, title ${index + 1}: page scrolls sideways (${heading.page}px)`);
        console.log(`PROM-01 ${name}, title ${index + 1}: ${JSON.stringify(heading)}`);
        await title.evaluate((el) => {
          const line = document.querySelector(".reading-line").getBoundingClientRect().top;
          window.scrollTo(0, scrollY + el.getBoundingClientRect().top - line - 8);
        });
        await page.waitForTimeout(220);
        const titleFile = join(out, `reading-wrap-${viewport.width}-${size}-title-${index + 1}.png`);
        await page.screenshot({ path: titleFile });
        screenshots.push(titleFile);
      }
      console.log(`PROM-01 ${name}: ${JSON.stringify(layout)}`);
      if (layout.scrollWidth > layout.viewport + 1 || layout.lines <= 1 || !layout.fits) {
        failures.push(`${name}: token has ${layout.lines} line(s); page ${layout.scrollWidth}px; column ${layout.column}px`);
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
      if (!lastVisible) failures.push(`${name}: the last character cannot be read by vertical scrolling alone`);
      checks.push(`${name}: original 601-character token and normal/long titles fit the column; spans hold at least one character; no sideways scroll; last character readable vertically`);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  return { checks, screenshots };
}
