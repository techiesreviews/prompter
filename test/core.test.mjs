import { test } from "node:test";
import assert from "node:assert/strict";
import { check, classify, countWords, describeProblems, EXAMPLE_SCRIPT, formatGuide, linkAt, parse, PRESETS, textLinks, toSeconds, youtubeSeconds } from "../src/core.mjs";

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

// A section with a top link and two inline links between spoken lines.
const INLINE = `### **PREP**

- Water

### **INTRO · 00:00**

- Intro: https://example.com/intro

QL: Who protects plugins?

First a quick story.
Patchstack finds the holes.
- Patchstack: https://patchstack.com

They pay researchers.
- Wordfence: https://www.wordfence.com
Last line here.

### **1 · NO TOP LINK · 05:00**

QL: What next?

Words before.
- Later: https://example.org
Words after.

### **2 · NOTHING · 09:00**

QL: Done?

No links here.
`;

test("parser marks top and inline links with their place among the items", () => {
  const [, s1, s2] = parse(INLINE);
  assert.deepEqual(s1.links.map(({ label, inline, at }) => ({ label, inline, at })), [
    { label: "Intro", inline: false, at: 0 },
    { label: "Patchstack", inline: true, at: 4 },
    { label: "Wordfence", inline: true, at: 6 },
  ]);
  // Each inline link sits just before items[at]: after the line that talks about it.
  assert.equal(s1.items[3].text, "Patchstack finds the holes.");
  assert.equal(s1.items[4].type, "gap");
  assert.equal(s1.items[5].text, "They pay researchers.");
  assert.equal(s1.items[6].text, "Last line here.");
  assert.equal(s1.links[1].line, INLINE.split("\n").indexOf("- Patchstack: https://patchstack.com") + 1);
  assert.deepEqual(s2.links.map(({ inline, at }) => [inline, at]), [[true, 3]]);
  assert.ok(s1.items.every((it) => it.type !== "link"), "links stay out of items");
});

test("a link right after the QL is still a top link: it opens when the section starts", () => {
  const sections = parse("### **INTRO · 00:00**\n\nQL: Why?\n\n- Site: https://example.com\n\nHello.");
  assert.equal(sections[0].links[0].inline, false);
  assert.deepEqual(linkAt(sections, 0, -1), { s: 0, l: 0 });
  const afterLine = parse("### **INTRO · 00:00**\n\nQL: Why?\n\nHello.\n- Site: https://example.com");
  assert.equal(parse("### **A**\n\n[remember]\n- Site: https://x.test\nHi")[0].links[0].inline, true, "a reminder is a visible line: a link after it is inline");
  assert.equal(afterLine[0].links[0].inline, true, "after a spoken line it is inline");
});

test("linkAt picks the most recent link above the reading line", () => {
  const sections = parse(INLINE);
  assert.equal(linkAt(sections, 0, -1), null, "PREP has no link and nothing is above it");
  assert.deepEqual(linkAt(sections, 1, -1), { s: 1, l: 0 }, "section start: its top link");
  assert.deepEqual(linkAt(sections, 1, 1), { s: 1, l: 1 }, "passed Patchstack");
  assert.deepEqual(linkAt(sections, 1, 2), { s: 1, l: 2 }, "passed Wordfence");
  assert.deepEqual(linkAt(sections, 2, -1), { s: 1, l: 2 }, "no top link: the last inline link above stays");
  assert.deepEqual(linkAt(sections, 2, 0), { s: 2, l: 0 });
  assert.deepEqual(linkAt(sections, 3, -1), { s: 2, l: 0 }, "a section without links keeps the link above");
  assert.equal(linkAt([], 0, -1), null);
  const onlyTop = parse("### **A**\n- One: https://a.test\n- Two: https://b.test\nHi\n### **B**\nHo");
  assert.deepEqual(linkAt(onlyTop, 1, -1), { s: 0, l: 0 }, "top links: the first one counts, as before");
});

test("inline links are fine in both presets; a link without https:// is flagged", () => {
  for (const name of Object.keys(PRESETS)) {
    const r = check(INLINE, name);
    assert.deepEqual(r.problems, [], `${name}: ${describeProblems(r)}`);
  }
  const bare = check("### **INTRO · 00:00**\n\nQL: Why?\n\nLook here.\n- Patchstack: patchstack.com/db\n- Site: www.example.com\n- Tool: Node.js", "lex");
  const flagged = bare.problems.filter((p) => p.code === "link-no-url");
  assert.deepEqual(flagged.map((p) => p.line), [6, 7]);
  assert.ok(flagged.every((p) => p.severity === "warning"));
  assert.ok(codes(check("### **A**\nHi\n- Bad: https://[x", "lex")).includes("bad-link"), "an inline link still needs a valid address");
});

// Links written inside spoken lines as [words](https://full-url).
const IN_TEXT = `### **INTRO · 00:00**

- Top: https://example.com/top

QL: Where do links go?

Read [the docs](https://developer.mozilla.org/) first.
- Both [one](https://a.test) and [two](https://en.wikipedia.org/wiki/Foo_(bar))
- Own: https://own.test
Next: [the wiki](https://w.test).
Now: we go.
[stage note]
`;

test("a link inside a line keeps only its words in the text and joins the links in reading order", () => {
  const [s] = parse(IN_TEXT);
  const lineOf = (needle) => IN_TEXT.split("\n").findIndex((l) => l.includes(needle)) + 1;
  assert.deepEqual(s.links.map(({ label, url, inline, inText, at, line }) => ({ label, url, inline, inText, at, line })), [
    { label: "Top", url: "https://example.com/top", inline: false, inText: undefined, at: 0, line: lineOf("- Top:") },
    { label: "the docs", url: "https://developer.mozilla.org/", inline: true, inText: true, at: 2, line: lineOf("Read [") },
    { label: "one", url: "https://a.test", inline: true, inText: true, at: 3, line: lineOf("- Both") },
    { label: "two", url: "https://en.wikipedia.org/wiki/Foo_(bar)", inline: true, inText: true, at: 3, line: lineOf("- Both") },
    { label: "Own", url: "https://own.test", inline: true, inText: undefined, at: 4, line: lineOf("- Own:") },
    { label: "the wiki", url: "https://w.test", inline: true, inText: true, at: 4, line: lineOf("Next: [") },
  ]);
  // `at` of a link inside a line is the item that holds it.
  assert.equal(s.items[2].text, "Read the docs first.");
  assert.deepEqual(s.items[2].spans.map(({ from, to, l }) => [s.items[2].text.slice(from, to), l]), [["the docs", 1]]);
  assert.equal(s.items[3].type, "bullet");
  assert.equal(s.items[3].text, "Both one and two");
  assert.deepEqual(s.items[3].spans.map((sp) => sp.l), [2, 3]);
  assert.equal(s.items[4].type, "next");
  assert.equal(s.items[4].text, "Next: the wiki.");
  assert.equal(s.items[5].text, "Now: we go.");
  assert.equal(s.items[5].spans, undefined, "lines without links stay as they were");
  assert.deepEqual(s.items[6], { type: "note", text: "stage note", line: lineOf("[stage note]") }, "a bare [note] stays a note");
});

test("links inside a line work only in spoken lines, bullets and Next:/Now:", () => {
  assert.deepEqual(classify("QL: Why [this](https://x.test)?"), { type: "ql", text: "Why [this](https://x.test)?" });
  assert.deepEqual(classify("[see [this](https://x.test)]"), { type: "note", text: "see [this](https://x.test)" });
  const [s] = parse("### **A [b](https://x.test) · 01:00**\nHi");
  assert.equal(s.title, "A [b](https://x.test)");
  assert.equal(s.links.length, 0, "not in titles");
  const start = classify("[Docs](https://d.test) and [smile]");
  assert.equal(start.type, "say", "a line that starts with a link is spoken, not a reminder");
  assert.equal(start.text, "Docs and [smile]");
  const upper = classify("[Docs](HTTPS://d.test) and [smile]");
  assert.equal(upper.text, "Docs and [smile]", "an upper-case address is still a link");
  assert.equal(classify("Just [brackets] here").spans, undefined);
  assert.equal(classify("Not a [link](ftp://x.test)").spans, undefined);
  assert.equal(classify("Empty [ ](https://x.test)").spans, undefined, "a link needs words");
  assert.deepEqual(textLinks("a [ b c ](https://x.test/p?q=1) d"), { text: "a b c d", spans: [{ from: 2, to: 5, label: "b c", url: "https://x.test/p?q=1" }] });
});

test("linkAt treats a link inside a line like any inline link", () => {
  const sections = parse(`### **A**\n- Top: https://top.test\nQL: Q?\nRead [the docs](https://d.test) now.\nMore.\n### **B**\nNo links.`);
  assert.deepEqual(linkAt(sections, 0, -1), { s: 0, l: 0 }, "section start: the top link");
  assert.deepEqual(linkAt(sections, 0, 1), { s: 0, l: 1 }, "passed the line with the link");
  assert.deepEqual(linkAt(sections, 1, -1), { s: 0, l: 1 }, "the next section keeps it");
  const first = parse("### **A**\nSee [this](https://x.test).");
  assert.equal(first[0].links[0].inline, true, "a link in the first line is inline, not a top link");
  assert.equal(linkAt(first, 0, -1), null);
});

test("checker counts a link's words, not its address, and checks the address", () => {
  const long = "Read [the docs](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a) now.";
  assert.deepEqual(check(`### **PREP**\n- Water\n### **INTRO · 00:00**\nQL: Why?\n${long}`, "lex").problems, []);
  const tooLong = check("### **INTRO · 00:00**\nQL: Why?\nOne [two three four five](https://x.test) six.", "lex");
  const p = tooLong.problems.find((x) => x.code === "line-too-long");
  assert.match(p.message, /"One two three four five six\." has 6 words/);
  const bad = check("### **A**\nHi [bad](https://[x) there", "default").problems.filter((x) => x.code === "bad-link");
  assert.deepEqual(bad.map((x) => x.line), [2]);
  assert.ok(codes(check(`### **A**\n${Array.from({ length: 10 }, (_, i) => `Say [l${i}](https://x.test/${i})`).join("\n")}`, "default")).includes("too-many-links"));
  for (const name of Object.keys(PRESETS)) {
    const r = check(`### **PREP**\n- Water\n### **INTRO · 00:00**\n${IN_TEXT.split("\n").slice(1).join("\n")}`, name);
    assert.deepEqual(r.problems, [], `${name}: ${describeProblems(r)}`);
  }
});

test("lex preset flags long lines, missing QL, titles and transitions", () => {
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
  assert.ok(!c.includes("link-not-first"), "a link mid-section is an inline link");
  assert.ok(c.includes("title-caps"));
  assert.ok(c.includes("title-number"));
  assert.equal(c.filter((x) => x === "transition-pair").length, 2);
  assert.equal(r.ok, false);
  const long = r.problems.find((p) => p.code === "line-too-long");
  assert.equal(long.section, 2);
  assert.equal(long.line, 9);
  assert.equal(long.severity, "error");
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
  assert.deepEqual(codes(r).sort(), ["line-too-long"]);
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
  assert.match(lex, /opens automatically when you reach that line/);
  assert.match(lex, /`\[words\]\(https:\/\/full-url\)`: A link inside a spoken line/);
  assert.match(lex, /for a link inside a line only its words count/);
  assert.match(formatGuide("default"), /inside the spoken line as \[words\]\(https:\/\/full-url\)/);
  assert.match(lex, /links either first \(the first link under the title opens when the section starts; the others are on number keys\) or on the line where you talk about them/);
  assert.ok(lex.includes(EXAMPLE_SCRIPT.trim()));
  assert.match(formatGuide("default"), /Preset: default/);
});

test("the demo script follows the lex preset and starts with a PREP checklist", async () => {
  const { DEMO_SCRIPT } = await import("../src/core.mjs");
  const r = check(DEMO_SCRIPT, "lex");
  assert.equal(r.errors, 0, describeProblems(r));
  assert.equal(r.warnings, 0, describeProblems(r));
  const [prep, intro] = parse(DEMO_SCRIPT);
  assert.equal(prep.title, "PREP");
  assert.equal(intro.title, "INTRO");
  const bullets = prep.items.filter((it) => it.type === "bullet").map((it) => it.text);
  assert.deepEqual(bullets, ["Water within reach", "Phone on silent", "Camera at eye level", "Text right under the lens", "Read it once aloud"]);
  const types = new Set(parse(DEMO_SCRIPT).flatMap((s) => s.entries.map((e) => e.type)));
  for (const t of ["link", "ql", "say", "next", "now", "note", "bullet"]) assert.ok(types.has(t), `demo shows ${t}`);
  const links = parse(DEMO_SCRIPT).flatMap((s) => s.links);
  assert.equal(links.filter((l) => l.inline && !l.inText).length, 1, "the demo shows one inline link on its own line");
  assert.equal(links.filter((l) => l.inText).length, 1, "and one inside a sentence");
  assert.ok(links.some((l) => !l.inline), "and a top link");
  const cues = parse(DEMO_SCRIPT).flatMap((s) => s.entries).filter((e) => e.cue);
  assert.deepEqual(cues.map((e) => e.cue), [
    { size: "small", position: "bottom-right" }, { size: "full" },
    { size: "small", position: "top-left" }, { size: "full" },
  ], "and camera cues for CamFrame");
});
