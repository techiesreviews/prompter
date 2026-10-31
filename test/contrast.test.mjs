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
  ["accent", "chip", "the ring of the CamFrame button when CamFrame is not found (graphic)", 3],
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

// Shared components (src/ui/*.css) carry their own colours, which a page may replace with its
// tokens. UI_COLOURS names every colour each one sets: text, what text may sit on (a translucent
// patch is laid over each of the others) and the rest (not text). A colour that is not listed
// fails, so text on a new colour is checked before it ships. Text is the page's own --text (the
// components inherit it) and each listed text colour; all must be AA in the page's colours and
// in the component's own defaults (on the page's --text, as any dark page would set it).
const UI_COLOURS = {
  "range-field": {
    selector: ".range-field",
    text: ["--rf-muted"],
    under: ["--rf-bg", "--rf-fill", "--rf-value-patch"],
    other: ["--rf-grip", "--rf-tick", "--rf-focus", "--rf-grip-now"],
  },
};
const COLOUR = /oklch\(|color-mix\(|currentColor|#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i;
const declarations = (text, selector) => {
  const block = text.match(new RegExp(`${selector.replaceAll(".", "\\.")} \\{([^}]*)\\}`));
  return block ? Object.fromEntries([...block[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])) : {};
};
// A colour as [gamma sRGB, alpha]: oklch(), var() and color-mix(in oklch, var(--x) N%, transparent).
function resolve(value, scope, seen = []) {
  const ok = value.match(/^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)(?:\s*\/\s*([\d.]+))?\)$/);
  if (ok) return [gamma([Number(ok[1]) / 100, Number(ok[2]), ok[3] === "none" ? 0 : Number(ok[3])]), ok[4] === undefined ? 1 : Number(ok[4])];
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) {
    assert.ok(!seen.includes(ref[1]) && ref[1] in scope, `${ref[1]} is unknown or circular`);
    return resolve(scope[ref[1]], scope, [...seen, ref[1]]);
  }
  const mix = value.match(/^color-mix\(in oklch, (.+) ([\d.]+)%, transparent\)$/);
  if (mix) { const [rgb, alpha] = resolve(mix[1], scope, seen); return [rgb, alpha * Number(mix[2]) / 100]; }
  assert.fail(`cannot read the colour ${value}; teach resolve() its form`);
}
const over = ([top, alpha], [under]) => [top.map((v, i) => v * alpha + under[i] * (1 - alpha)), 1];
const ratioOf = ([a], [b]) => { const [hi, lo] = [fromGamma(a), fromGamma(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// A component's colours are set only as custom properties in its main block, each listed in UI_COLOURS;
// every other rule uses them through var() and names no colour of its own. Returns what breaks that.
function colourProblems(name, source, { selector, text, under, other }) {
  const own = declarations(source, selector);
  const colours = Object.keys(own).filter((k) => COLOUR.test(own[k]) && !/^(linear|repeating-linear|radial)-gradient/.test(own[k]));
  const listed = [...text, ...under, ...other];
  const problems = [
    ...colours.filter((k) => !listed.includes(k)).map((k) => `${name}.css: list ${k} in UI_COLOURS as text, under (text sits on it) or other`),
    ...listed.filter((k) => !colours.includes(k)).map((k) => `${name}.css: ${k} is in UI_COLOURS but not set as a colour in ${selector} { }`),
  ];
  const main = source.match(new RegExp(`${selector.replaceAll(".", "\\.")} \\{[^}]*\\}`))?.[0] ?? "";
  const rest = source.replace(main, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const literal of rest.match(new RegExp(COLOUR.source, "gi")) || []) problems.push(`${name}.css: the colour ${literal} outside ${selector} { }; set it there as a --rf-* property listed in UI_COLOURS`);
  return problems;
}

test("a shared component's colour that is not listed, or set outside its main block, fails the check", () => {
  const source = readFileSync(new URL("../src/ui/range-field.css", import.meta.url), "utf8");
  const spec = UI_COLOURS["range-field"];
  assert.deepEqual(colourProblems("range-field", source, spec), []);
  const newProperty = source.replace("--rf-bg:", "--rf-new: oklch(50% 0 0);\n  --rf-bg:");
  assert.match(colourProblems("range-field", newProperty, spec).join("\n"), /list --rf-new in UI_COLOURS/);
  const directColour = `${source}\n.range-value > input { color: oklch(50% 0 0); }\n`;
  assert.match(colourProblems("range-field", directColour, spec).join("\n"), /the colour oklch\( outside \.range-field/);
});

test("every colour a shared component sets is known, and its text is AA in the page's colours and its own", () => {
  const pageScope = Object.fromEntries(Object.entries(declarations(css, ":root")));
  for (const [name, { selector, text, under, other }] of Object.entries(UI_COLOURS)) {
    const source = readFileSync(new URL(`../src/ui/${name}.css`, import.meta.url), "utf8");
    assert.deepEqual(colourProblems(name, source, { selector, text, under, other }), []);
    const own = declarations(source, selector);
    for (const [label, scope] of [["the page's colours", { ...pageScope, ...own, ...declarations(css, selector) }], ["its own defaults", { ...pageScope, ...own }]]) {
      const solid = under.map((k) => [k, resolve(scope[k], scope)]).filter(([, c]) => c[1] === 1);
      const backs = under.flatMap((k) => {
        const c = resolve(scope[k], scope);
        return c[1] === 1 ? [[k, c]] : solid.map(([s, b]) => [`${k} over ${s}`, over(c, b)]);
      });
      for (const fg of ["--text", ...text]) {
        for (const [where, back] of backs) {
          const ratio = ratioOf(resolve(scope[fg], scope), back);
          assert.ok(ratio >= 4.5, `${name} in ${label}: ${fg} on ${where} is ${ratio.toFixed(2)}:1, needs 4.5:1`);
        }
      }
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
