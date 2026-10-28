import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Text colours on the indigo page must meet WCAG AA (4.5:1) wherever they are
// used; white on the orange only as large text (19px bold, 3:1). Tokens are
// written in oklch() in src/page.html; this converts them to sRGB.
const css = readFileSync(new URL("../src/page.html", import.meta.url), "utf8");
const root = css.match(/:root \{([\s\S]*?)\}/)[1];
const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\)/g)]
  .map((m) => [m[1], [Number(m[2]) / 100, Number(m[3]), m[4] === "none" ? 0 : Number(m[4])]]));

/** Linear sRGB of an OKLCH colour, clipped to the sRGB range. */
function linear([L, C, h]) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
}
const luminance = (t) => linear(t).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const hex = (t) => `#${linear(t).map((v) => Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255).toString(16).padStart(2, "0")).join("")}`;
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const inGamut = (t) => {
  const [L, C, h] = t;
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .every((v) => v > -0.002 && v < 1.002);
};

// [text, background, where, minimum]
const PAIRS = [
  ["text", "bg", "active spoken lines"],
  ["dim", "bg", "lines and titles of the other sections, their Now: label"],
  ["muted", "bg", "reminders"],
  ["next", "bg", "active Next: lines"],
  ["next-dim", "bg", "other sections' Next: lines"],
  ["accent", "bg", "active Now: label"],
  ["ok", "bg", "on main screen"],
  ["text", "panel", "start screen, control bar, popovers, notices, dialogs"],
  ["muted", "panel", "start screen notes, setting values, status, idle clock, QL label"],
  ["dim", "panel", "lines and labels on raised surfaces"],
  ["accent", "panel", "late clock, paste errors, links"],
  ["ok", "panel", "main screen connected"],
  ["ql", "panel", "active QL box"],
  ["ql-dim", "panel", "other sections' QL box"],
  ["text", "panel-2", "the line Follow my voice heard, hovered menu items"],
  ["muted", "panel-2", "code on raised surfaces"],
  ["text", "chip", "buttons, active link chips, chosen width, tooltips"],
  ["muted", "chip", "other sections' link chips, link addresses, section times"],
  ["ok", "chip", "link chip on main screen"],
  ["text", "chip-hover", "hovered buttons"],
  ["on-accent", "accent", "orange buttons: 19px bold labels only (large text)", 3],
  ["on-accent", "accent-hover", "hovered orange buttons: 19px bold (large text)", 3],
  // Not text: the orange arrow on a chip and the play icon are graphics (3:1).
  ["accent", "chip", "orange arrow on link chips (graphic)", 3],
];

test("page uses the indigo night colour and every text colour meets WCAG AA on its background", () => {
  assert.deepEqual(tokens.bg, [0.16, 0.06, 282], "--bg is the Techies Reviews night colour");
  assert.equal(hex(tokens.bg), "#0b0826");
  const report = PAIRS.map(([fg, bg, where, min = 4.5]) => {
    assert.ok(tokens[fg] && tokens[bg], `missing token --${fg} or --${bg}`);
    assert.ok(inGamut(tokens[fg]) && inGamut(tokens[bg]), `--${fg} or --${bg} is outside sRGB; the browser would change it`);
    const ratio = contrast(tokens[fg], tokens[bg]);
    assert.ok(ratio >= min, `--${fg} on --${bg} (${where}) is ${ratio.toFixed(2)}:1, needs ${min}:1`);
    return `| ${fg} ${hex(tokens[fg])} | ${bg} ${hex(tokens[bg])} | ${ratio.toFixed(2)}:1 | ${where} |`;
  });
  if (process.env.CONTRAST_REPORT) console.log(report.join("\n"));
});

// The active Now: label is orange; the other sections use --dim (a grey indigo),
// so they differ by hue as well as by the rest of the line.
test("the active section stays clearly brighter than the rest", () => {
  for (const [on, off] of [["text", "dim"], ["ql", "ql-dim"], ["next", "next-dim"]]) {
    assert.ok(luminance(tokens[on]) / luminance(tokens[off]) >= 1.4, `--${on} vs --${off}`);
  }
  assert.ok(luminance(tokens.text) / luminance(tokens.dim) >= 3, "spoken lines: active vs other sections");
});
