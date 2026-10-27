import { test } from "node:test";
import assert from "node:assert/strict";
import { check, countWords, describeProblems, EXAMPLE_SCRIPT, formatGuide, parse, PRESETS, toSeconds, youtubeSeconds } from "../src/core.mjs";

// The parser from the original single-file prompter, kept to prove compatibility.
function legacyParse(md) {
  const timeRe = /^(.*?)\s*·\s*(\d{1,2}:\d{2})\s*$/;
  const linkRe = /^-\s*(?:(.+?):\s+)?(https?:\/\/\S+)\s*$/;
  const body = md.replace(/\r/g, "").split("<!--SCRIPT-START-->").pop().split("<!--SCRIPT-END-->")[0];
  const out = [];
  let cur = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^#{2,3}\s+(.*)$/);
    if (heading) {
      const title = heading[1].replace(/\*\*/g, "").trim();
      const t = title.match(timeRe);
      cur = { title: t ? t[1] : title, time: t ? t[2] : "", items: [], links: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!line) { if (cur.items.length && cur.items.at(-1).type !== "gap") cur.items.push({ type: "gap" }); continue; }
    if (line === "---" || /^(OPEN|Links to open):?$/i.test(line)) continue;
    const link = line.match(linkRe);
    if (link) { cur.links.push({ label: link[1] || new URL(link[2]).hostname, url: link[2] }); continue; }
    if (/^QL:/i.test(line)) cur.items.push({ type: "ql", text: line.replace(/^QL:\s*/i, "") });
    else if (/^\[.*\]$/.test(line)) cur.items.push({ type: "note", text: line.slice(1, -1) });
    else if (/^(Next week|Next):/i.test(line)) cur.items.push({ type: "next", text: line });
    else if (/^Now:/i.test(line)) cur.items.push({ type: "now", text: line });
    else if (/^[-*]\s+/.test(line)) cur.items.push({ type: "bullet", text: line.replace(/^[-*]\s+/, "") });
    else cur.items.push({ type: "say", text: line });
  }
  return out;
}

// Old-style script: notes before the first section, OPEN:, Next week:, bare links.
const OLD = `# Some show notes

These lines are notes, not script.

---

### **PREP**

- Tools open
- Say the date

---

### **INTRO · 00:00**

Editing takes longer than recording.
Hi, I'm Sam.

---

### **1 · THE RECIPE · 03:00**

OPEN:
- Steps: https://youtu.be/abc123?t=94
- https://example.com/page

Next: plan the plates.
Now: the editing steps.

* A-cut, B-roll, music
QL: What does my tool do?

[Explain the contact sheet]
Next week: security month.
`;

const strip = (sections) => sections.map((s) => ({
  title: s.title, time: s.time,
  items: s.items.map(({ type, text }) => (type === "gap" ? { type } : { type, text })),
  links: s.links.map(({ label, url }) => ({ label, url })),
}));

test("parser stays compatible with the original prompter parser", () => {
  assert.deepEqual(strip(parse(OLD)), legacyParse(OLD));
  assert.deepEqual(strip(parse(EXAMPLE_SCRIPT)), legacyParse(EXAMPLE_SCRIPT));
});

test("parser handles embedded markers, CRLF and line numbers", () => {
  const md = "<!--SCRIPT-START-->\r\n### **A · 01:00**\r\nHello there\r\n<!--SCRIPT-END-->";
  const [s] = parse(md);
  assert.equal(s.title, "A");
  assert.equal(s.time, "01:00");
  assert.equal(s.items[0].text, "Hello there");
  assert.equal(s.items[0].line, 3);
  const sections = parse(OLD);
  assert.equal(sections[2].links[0].line, OLD.split("\n").indexOf("- Steps: https://youtu.be/abc123?t=94") + 1);
  assert.equal(sections[2].links[1].label, "example.com");
});

test("parser accepts long-stream times and survives odd links", () => {
  const [s] = parse("### **LATE · 125:00**\n- Odd: https://[broken\nSay it");
  assert.equal(s.time, "125:00");
  assert.equal(s.links[0].url, "https://[broken");
  assert.equal(s.links[0].label, "Odd");
});

test("countWords ignores URLs, transition labels and punctuation", () => {
  assert.equal(countWords("Next: plan the plates."), 3);
  assert.equal(countWords("Now: go"), 1);
  assert.equal(countWords("Open https://example.com/a/very/long/path now"), 2);
  assert.equal(countWords("A-cut, B-roll · music — done"), 4);
  assert.equal(countWords("Hi, I'm Sam. Welcome."), 4);
});

test("time helpers: section times and YouTube start times", () => {
  assert.equal(toSeconds("125:30"), 7530);
  for (const [t, s] of [["90", 90], ["90s", 90], ["1m30s", 90], ["1h2m30s", 3750], ["abc", 0], ["", 0]]) assert.equal(youtubeSeconds(t), s, t);
});

test("the built-in example passes both presets with no problems", () => {
  for (const name of Object.keys(PRESETS)) {
    const r = check(EXAMPLE_SCRIPT, name);
    assert.deepEqual(r.problems, [], `${name}: ${JSON.stringify(r.problems, null, 1)}`);
    assert.equal(r.ok, true);
    assert.equal(r.sections, 5);
  }
});

const codes = (r) => r.problems.map((p) => p.code);

test("lex preset flags long lines, missing QL, late links, titles and transitions", () => {
  const md = `### **PREP**

- Water

### **INTRO · 00:00**

QL: Why stay?

This line has far too many words in it.

### **Show part · 02:00**

Hello.
- Late: https://example.com
Next: something.
Words here.
Now: alone.
`;
  const r = check(md, "lex");
  const c = codes(r);
  assert.ok(c.includes("line-too-long"));
  assert.ok(c.includes("missing-ql"));
  assert.ok(c.includes("link-not-first"));
  assert.ok(c.includes("title-caps"));
  assert.ok(c.includes("title-number"));
  assert.equal(c.filter((x) => x === "transition-pair").length, 2);
  assert.equal(r.ok, false);
  const long = r.problems.find((p) => p.code === "line-too-long");
  assert.equal(long.section, 2);
  assert.equal(long.line, 9);
  assert.equal(long.severity, "error");
  const late = r.problems.find((p) => p.code === "link-not-first");
  assert.equal(late.line, 14);
});

test("lex preset wants QL first, one QL, times in order and prep then intro", () => {
  const md = `### **1 · START · 05:00**

Say this first.
QL: First question?
QL: Second question?

### **2 · NEXT · 01:00**

QL: Fine?
Ok.
`;
  const c = codes(check(md, "lex"));
  for (const code of ["ql-not-first", "extra-ql", "time-order", "order-prep"]) assert.ok(c.includes(code), code);
});

test("lex preset needs a time except on PREP, and short titles", () => {
  const c = codes(check("### **PREP**\n- Ok\n\n### **INTRO**\nQL: Why?\nHi.\n\n### **1 · ONE TWO THREE FOUR FIVE SIX · 01:00**\nQL: Q?\nHi.", "lex"));
  assert.equal(c.filter((x) => x === "title-time").length, 1);
  assert.ok(c.includes("title-long"));
  assert.ok(!c.includes("missing-ql"));
});

test("default preset is softer: warnings only, ten words, QL optional", () => {
  const md = `### **Intro**

Hello there, this line has exactly ten words in it.
This line here has eleven words in it, which is too many.
- Late: https://example.com
`;
  const r = check(md, "default");
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r).sort(), ["line-too-long", "link-not-first"]);
  assert.ok(r.problems.every((p) => p.severity === "warning"));
});

test("checker reports missing sections, empty titles, bad links and too many links", () => {
  assert.deepEqual(codes(check("Just text", "default")), ["no-sections"]);
  assert.equal(check("", "lex").ok, false);
  const c = codes(check("### **  **\nHi", "default"));
  assert.ok(c.includes("missing-title"));
  const links = Array.from({ length: 10 }, (_, i) => `- L${i}: https://example.com/${i}`).join("\n");
  assert.ok(codes(check(`### **A**\n${links}\n- Bad: https://[x\nHi`, "default")).includes("too-many-links"));
  assert.ok(codes(check(`### **A**\n- Bad: https://[x\nHi`, "default")).includes("bad-link"));
  assert.ok(codes(check(`### **A**\n#### Sub\nHi`, "default")).includes("heading-level"));
  assert.ok(codes(check(`### **A**\n\n### **B**\nHi`, "default")).includes("empty-section"));
});

test("unknown preset falls back to default; script length is capped", () => {
  assert.equal(check(EXAMPLE_SCRIPT, "nope").preset, "default");
  assert.ok(codes(check("### **A**\n" + "x ".repeat(60_000), "default")).includes("too-long"));
});

test("format guide carries the format, the preset rules and the example", () => {
  const lex = formatGuide("lex");
  assert.match(lex, /### \*\*TITLE · mm:ss\*\*/);
  assert.match(lex, /QL: question/);
  assert.match(lex, /Preset: lex/);
  assert.match(lex, /prep first, then intro/);
  assert.match(lex, /five words or fewer/);
  assert.match(lex, /Livestreams/);
  assert.ok(lex.includes(EXAMPLE_SCRIPT.trim()));
  assert.match(formatGuide("default"), /Preset: default/);
});

test("the demo script follows the lex preset and names its PREP actions", async () => {
  const { DEMO_ACTIONS, DEMO_SCRIPT } = await import("../src/core.mjs");
  const r = check(DEMO_SCRIPT, "lex");
  assert.equal(r.errors, 0, describeProblems(r));
  assert.equal(r.warnings, 0, describeProblems(r));
  const [prep, intro] = parse(DEMO_SCRIPT);
  assert.equal(prep.title, "PREP");
  assert.equal(intro.title, "INTRO");
  const bullets = prep.items.filter((it) => it.type === "bullet").map((it) => it.text);
  assert.deepEqual(bullets, Object.keys(DEMO_ACTIONS));
  const types = new Set(parse(DEMO_SCRIPT).flatMap((s) => s.entries.map((e) => e.type)));
  for (const t of ["link", "ql", "say", "next", "now", "note", "bullet"]) assert.ok(types.has(t), `demo shows ${t}`);
});
