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
  ["text-now", "bg", "the line Follow my voice is on"],
  ["upcoming", "bg", "the lines after it while Follow my voice is on"],
  ["dim", "bg", "lines and titles of the other sections, their Now: label and links"],
  ["muted", "bg", "reminders, the active section's link row and link markers"],
  ["next", "bg", "active Next: lines"],
  ["next-dim", "bg", "other sections' Next: lines"],
  ["accent", "bg", "active Now: label"],
  ["accent", "link-tint", "hovered links"],
  ["text", "panel", "start screen, control bar, popovers, notices, dialogs"],
  ["muted", "panel", "start screen notes, setting values, status, idle clock, QL label"],
  ["dim", "panel", "lines and labels on raised surfaces"],
  ["accent", "panel", "late clock, paste errors, links"],
  ["ok", "panel", "main screen connected"],
  ["ql", "panel", "active QL box"],
  ["ql-dim", "panel", "other sections' QL box"],
  ["text", "panel-2", "hovered menu items"],
  ["muted", "panel-2", "code on raised surfaces"],
  ["text", "chip", "buttons, chosen width, tooltips"],
  ["muted", "chip", "section times"],
  ["text", "chip-hover", "hovered buttons"],
  ["on-accent", "accent", "orange buttons: 19px bold labels only (large text)", 3],
  ["on-accent", "accent-hover", "hovered orange buttons: 19px bold (large text)", 3],
  // Not text (3:1): the orange border of the link on the main screen, the Settings toggles' icons.
  ["accent-bright", "chip", "the icon of an on Settings toggle (graphic)", 3],
  ["accent-bright", "chip-hover", "the same, hovered (graphic)", 3],
  ["muted", "chip", "the icon of an off Settings toggle (graphic)", 3],
  ["accent", "bg", "border of the link on the main screen (graphic)", 3],
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

// Follow my voice: the line being read stands out from the lines after it,
// which stay brighter than the other sections.
test("the line Follow my voice is on is the brightest; the lines after it dimmer, above the other sections", () => {
  assert.equal(luminance(tokens["text-now"]), 1, "pure white");
  assert.ok(luminance(tokens["text-now"]) / luminance(tokens.upcoming) >= 1.6, "the lines after it are clearly dimmer");
  assert.ok(luminance(tokens.upcoming) / luminance(tokens.dim) >= 1.6, "and still brighter than other sections");
});

// The one deliberate exception to AA (AGENTS.md): text above the reading line
// has been read, so a veil in the page colour (--read-veil) fades it almost
// into the page. It must stay LOW; do not raise it to AA. Browsers blend in
// gamma-encoded sRGB, so the faded colour is mixed there.
const veil = root.match(/--read-veil:\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\)/);
const gamma = (t) => linear(t).map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
const fromGamma = (rgb) => rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);

// Range fields (src/ui/range-field.css): the value sits on top of the slider, so
// its patch (--rf-value-patch, the page colour at some alpha) may lie over the
// fill (--chip) or the empty track (--bg). Text and the muted unit stay AA there.
test("a range field's value stays AA on its patch, over the fill or the track", () => {
  const ui = readFileSync(new URL("../src/ui/range-field.css", import.meta.url), "utf8");
  const mix = ui.match(/--rf-value-patch:\s*color-mix\(in oklch, var\(--rf-bg\) ([\d.]+)%, transparent\)/);
  assert.ok(mix, "--rf-value-patch is the page colour (--rf-bg) at some alpha");
  const alpha = Number(mix[1]) / 100;
  const patch = gamma(tokens.bg);
  for (const under of ["chip", "bg"]) {
    const back = fromGamma(gamma(tokens[under]).map((v, i) => v * (1 - alpha) + patch[i] * alpha));
    for (const fg of ["text", "muted"]) {
      const ratio = (luminance(tokens[fg]) + 0.05) / (back + 0.05);
      assert.ok(ratio >= 4.5, `--${fg} on the value patch over --${under} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("read text above the reading line is deliberately faded below AA (the one exception)", () => {
  assert.ok(veil, "--read-veil (oklch with an alpha) is missing from :root: read text would no longer fade");
  const [L, C, h, alpha] = veil.slice(1).map(Number);
  assert.deepEqual([L / 100, C, h], tokens.bg, "the veil is the page colour");
  const bg = gamma(tokens.bg);
  for (const fg of ["text", "text-now", "dim", "ql", "next"]) {
    const faded = gamma(tokens[fg]).map((v, i) => v * (1 - alpha) + bg[i] * alpha);
    const ratio = (fromGamma(faded) + 0.05) / (luminance(tokens.bg) + 0.05);
    assert.ok(ratio < 2, `--${fg} under the veil is ${ratio.toFixed(2)}:1 on --bg; read text stays faded below 2:1`);
    assert.ok(ratio > 1.05, `--${fg} under the veil is ${ratio.toFixed(2)}:1; still faintly there`);
  }
});
