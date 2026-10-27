import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Text colours on the black page must meet WCAG AA (4.5:1) wherever they are used.
const css = readFileSync(new URL("../src/page.html", import.meta.url), "utf8");
const root = css.match(/:root \{([\s\S]*?)\}/)[1];
const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background, where]
const PAIRS = [
  ["text", "bg", "active spoken lines"],
  ["dim", "bg", "lines of the other sections"],
  ["text", "panel", "buttons, active section title, AI panel"],
  ["dim", "panel", "other sections' titles"],
  ["muted", "bg", "reminders, toolbar labels, status, help"],
  ["muted", "panel", "section times, AI panel notes"],
  ["muted", "panel-2", "link button addresses"],
  ["text", "panel-2", "active link buttons, the line Follow my voice heard"],
  ["dim", "panel-2", "other sections' link buttons"],
  ["ql", "ql-bg", "active QL box"],
  ["ql-dim", "ql-bg", "other sections' QL box"],
  ["muted", "ql-bg", "QL box label"],
  ["next", "bg", "active Next: lines"],
  ["next-dim", "bg", "other sections' Next: lines"],
  ["accent", "bg", "active Now: label, alerts, late clock"],
  ["accent-dim", "bg", "other sections' Now: label"],
  ["accent", "panel", "paste errors"],
  ["ok", "panel-2", "on main screen"],
  ["ok", "bg", "inline link marker on main screen"],
  ["on-accent", "accent", "primary buttons"],
];

test("page background is black and every text colour meets WCAG AA on its background", () => {
  assert.equal(tokens.bg, "#000000");
  const report = PAIRS.map(([fg, bg, where]) => {
    assert.ok(tokens[fg] && tokens[bg], `missing token --${fg} or --${bg}`);
    const ratio = contrast(tokens[fg], tokens[bg]);
    assert.ok(ratio >= 4.5, `--${fg} on --${bg} (${where}) is ${ratio.toFixed(2)}:1`);
    return `${fg} ${tokens[fg]} on ${bg} ${tokens[bg]}: ${ratio.toFixed(2)}:1 (${where})`;
  });
  if (process.env.CONTRAST_REPORT) console.log(report.join("\n"));
});

test("the active section stays clearly brighter than the rest", () => {
  for (const [on, off] of [["text", "dim"], ["ql", "ql-dim"], ["next", "next-dim"], ["accent", "accent-dim"]]) {
    assert.ok(luminance(tokens[on]) / luminance(tokens[off]) >= 1.4, `--${on} vs --${off}`);
  }
});
