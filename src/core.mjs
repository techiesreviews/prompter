// Prompter core: script parser, presets, checker and #s= link encoding.
// Single source of truth for the page (inlined by scripts/build.mjs), the
// /mcp Worker and the tests. Keep it import-free: the build strips `export`.

export const SITE = "https://prompter.techies.tools";
export const MAX_SCRIPT_CHARS = 100_000;
export const MAX_DECODED_BYTES = 1_000_000;

// ---------- Format ----------

export const FORMAT = [
  { syntax: "### **TITLE · mm:ss**", meaning: "Starts a section. The time is optional and is when the section should start." },
  { syntax: "- Label: https://full-url", meaning: "A link. Put links first under the title. Number keys 1–9 open them on the main screen." },
  { syntax: "QL: question", meaning: "The one main question of the section. Read it silently and answer it in your own words; it is not read aloud. Shown at the top of the section." },
  { syntax: "Plain line", meaning: "A spoken line." },
  { syntax: "Next: … / Now: …", meaning: "A transition: where you are going, then what you do now." },
  { syntax: "[text]", meaning: "A private reminder, shown small." },
  { syntax: "- text", meaning: "A bullet point." },
  { syntax: "---", meaning: "A divider. Ignored, so use it freely." },
];

export const PRESETS = {
  lex: {
    name: "lex",
    label: "Lex",
    summary: "Lex's own style: very short lines, one main question per section, strict order.",
    maxWords: 5,
    severity: "error",
    requireQL: true,
    qlFirst: true,
    strictTitles: true,
    pairedTransitions: true,
    prepThenIntro: true,
    rules: [
      "Order: prep first, then intro, then the show.",
      "Section titles: small (five words or fewer), numbered, ALL CAPS, with start time. PREP needs no number or time; INTRO needs no number.",
      "Each section: links first, then one QL main question, then lines of five words or fewer (only URLs may be longer). This includes the intro, transitions and reminders. PREP needs no QL.",
      "Transitions are two short lines: `Next: …` then `Now: …`.",
      "Livestreams: one main topic in depth for most of the stream; the last 5–10 minutes for other things you worked on. The title and thumbnail promise the main topic.",
    ],
  },
  default: {
    name: "default",
    label: "Default",
    summary: "Same format with softer limits. Problems are warnings, not errors.",
    maxWords: 10,
    severity: "warning",
    requireQL: false,
    qlFirst: false,
    strictTitles: false,
    pairedTransitions: false,
    prepThenIntro: false,
    rules: [
      "Every section has a title. A start time is optional.",
      "Put links first under the title.",
      "Keep lines short: a warning above ten words (URLs do not count).",
      "A QL main question is optional; use at most one per section.",
    ],
  },
};

export function getPreset(name) {
  return PRESETS[name] || PRESETS.default;
}

export const EXAMPLE_SCRIPT = `### **PREP**

- Demo: https://example.com

- Water within reach
- Phone on silent
- Demo page open

---

### **INTRO · 00:00**

QL: Why should they stay?

Writing scripts takes too long.
Reading them looks stiff.
Today: a calmer way.

Hi, I'm Sam. Welcome.

Next: the big idea.
Now: one question each.

---

### **1 · ONE QUESTION · 01:30**

- Example: https://example.com

QL: Why one question per section?

[Answer in your own words]

One question keeps you focused.
You answer, not recite.
Short lines guide your eyes.

Next: show the tool.
Now: links on screen.

---

### **2 · LINKS ON SCREEN · 06:00**

- Docs: https://developer.mozilla.org/
- Video: https://www.youtube.com/watch?v=aqz-KE-bpKQ

QL: How do links help viewers?

Press 1 for the docs.
Press 2 for the video.
The main screen follows along.

Next: wrap up.
Now: the takeaway.

---

### **3 · WRAP UP · 12:00**

QL: What should they try first?

- Write one question
- Five words per line
- Links first, always

Thanks for watching.
`;

/** Plain-text format guide for one preset, used by the MCP and docs. */
export function formatGuide(presetName) {
  const preset = getPreset(presetName);
  return [
    "# Prompter script format",
    "",
    "A prompter script is plain Markdown. The prompter shows it big, scrolls it, and opens each section's links on a second \"main screen\" window.",
    "",
    ...FORMAT.map((f) => `- \`${f.syntax}\`: ${f.meaning}`),
    "",
    "Text before the first section is ignored, so you can keep notes there.",
    "",
    `## Preset: ${preset.name}`,
    "",
    preset.summary,
    "",
    ...preset.rules.map((r) => `- ${r}`),
    "",
    "## Example",
    "",
    "```markdown",
    EXAMPLE_SCRIPT.trim(),
    "```",
  ].join("\n");
}

// ---------- Parsing ----------

const timeRe = /^(.*?)\s*·\s*(\d{1,3}:\d{2})\s*$/;
const linkRe = /^-\s*(?:(.+?):\s+)?(https?:\/\/\S+)\s*$/;
const headingRe = /^#{2,3}\s+(.*)$/;

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

/** Classify one trimmed line of a section body. */
export function classify(line) {
  if (!line) return { type: "gap" };
  if (line === "---" || /^(OPEN|Links to open):?$/i.test(line)) return { type: "skip" };
  const link = line.match(linkRe);
  if (link) return { type: "link", label: link[1] || hostOf(link[2]) || link[2], url: link[2] };
  if (/^QL:/i.test(line)) return { type: "ql", text: line.replace(/^QL:\s*/i, "") };
  if (/^\[.*\]$/.test(line)) return { type: "note", text: line.slice(1, -1) };
  if (/^(Next week|Next):/i.test(line)) return { type: "next", text: line };
  if (/^Now:/i.test(line)) return { type: "now", text: line };
  if (/^[-*]\s+/.test(line)) return { type: "bullet", text: line.replace(/^[-*]\s+/, "") };
  return { type: "say", text: line };
}

/**
 * Parse a script into sections. Each section has title, time, line, links,
 * items (everything but links, with gaps) and entries (all non-gap lines in
 * order, links included). Lines are 1-based in the original text.
 */
export function parse(md) {
  const text = String(md ?? "").replace(/\r/g, "");
  const startMark = "<!--SCRIPT-START-->";
  const offset = text.includes(startMark) ? text.slice(0, text.lastIndexOf(startMark)).split("\n").length - 1 : 0;
  const body = text.split(startMark).pop().split("<!--SCRIPT-END-->")[0];
  const out = [];
  let cur = null;
  body.split("\n").forEach((raw, index) => {
    const lineNo = index + 1 + offset;
    const line = raw.trim();
    const heading = line.match(headingRe);
    if (heading) {
      const title = heading[1].replace(/\*\*/g, "").trim();
      const t = title.match(timeRe);
      cur = { title: t ? t[1].trim() : title, time: t ? t[2] : "", line: lineNo, items: [], links: [], entries: [] };
      out.push(cur);
      return;
    }
    if (!cur) return;
    const entry = { ...classify(line), line: lineNo };
    if (entry.type === "skip") return;
    if (entry.type === "gap") {
      if (cur.items.length && cur.items.at(-1).type !== "gap") cur.items.push(entry);
      return;
    }
    if (/^#{1}\s|^#{4,}\s/.test(line)) entry.heading = true;
    cur.entries.push(entry);
    if (entry.type === "link") cur.links.push(entry);
    else cur.items.push(entry);
  });
  return out;
}

// ---------- Checking ----------

/** Words in a line, ignoring URLs, the transition label and punctuation-only tokens. */
export function countWords(text) {
  return String(text)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*(Next week|Next|Now):/i, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** YouTube start times: "90", "90s" or "1h2m30s"; anything else is 0. */
export function youtubeSeconds(t) {
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(String(t));
  return parts ? (Number(parts[1] || 0) * 3600) + (Number(parts[2] || 0) * 60) + Number(parts[3] || 0) : 0;
}

/** "mm:ss" (minutes may exceed 59) to seconds. */
export function toSeconds(t) { const [m, s] = t.split(":").map(Number); return m * 60 + s; }
const isPrep = (title) => /^PREP\b/i.test(title);
const isIntro = (title) => /^INTRO\b/i.test(title);

/**
 * Check a script against a preset. Returns { preset, ok, errors, warnings,
 * sections, problems: [{ severity, code, section, title, line, message }] }.
 * `ok` means no errors; warnings never block.
 */
export function check(md, presetName) {
  const preset = getPreset(presetName);
  const sections = parse(md);
  const problems = [];
  const add = (severity, code, s, i, line, message) =>
    problems.push({ severity, code, section: s ? i + 1 : null, title: s ? s.title : "", line, message });
  const hard = preset.severity;

  if (String(md ?? "").length > MAX_SCRIPT_CHARS) {
    add("error", "too-long", null, 0, null, `Script is longer than ${MAX_SCRIPT_CHARS} characters.`);
  }
  if (!sections.length) {
    add("error", "no-sections", null, 0, null, "No sections found. Start each section with a title line like: ### **INTRO · 00:00**");
  }

  let lastTime = -1;
  sections.forEach((s, i) => {
    const where = `Section ${i + 1}${s.title ? ` (${s.title})` : ""}`;
    if (!s.title) add("error", "missing-title", s, i, s.line, `${where} has no title.`);

    if (s.time) {
      const sec = toSeconds(s.time);
      if (sec < lastTime) add("warning", "time-order", s, i, s.line, `${where} starts at ${s.time}, before the section above it.`);
      lastTime = Math.max(lastTime, sec);
    }

    if (preset.strictTitles && s.title) {
      const letters = s.title.replace(/[^\p{L}]/gu, "");
      if (letters && s.title !== s.title.toUpperCase()) add(hard, "title-caps", s, i, s.line, `${where}: write the title in ALL CAPS.`);
      if (!isPrep(s.title) && !isIntro(s.title) && !/^\d+\s*[·.:)-]/.test(s.title)) add(hard, "title-number", s, i, s.line, `${where}: number the title, like "1 · ${s.title}".`);
      if (!isPrep(s.title) && !s.time) add(hard, "title-time", s, i, s.line, `${where}: add the start time, like "· 03:00".`);
      const titleWords = countWords(s.title.replace(/^\d+\s*[·.:)-]\s*/, ""));
      if (titleWords > preset.maxWords) add(hard, "title-long", s, i, s.line, `${where}: keep the title to ${preset.maxWords} words or fewer (now ${titleWords}).`);
    }

    if (!s.entries.length) add("warning", "empty-section", s, i, s.line, `${where} is empty.`);

    // Links first.
    let seenOther = false;
    for (const e of s.entries) {
      if (e.type === "link") {
        if (seenOther) add(hard, "link-not-first", s, i, e.line, `${where}: move the link "${e.label}" up, before the other lines.`);
        if (!hostOf(e.url)) add("error", "bad-link", s, i, e.line, `${where}: "${e.url}" is not a valid web address.`);
      } else seenOther = true;
    }
    if (s.links.length > 9) add("warning", "too-many-links", s, i, s.links[9].line, `${where} has ${s.links.length} links; only the first 9 have number keys.`);

    // The one main question.
    const qls = s.entries.filter((e) => e.type === "ql");
    const needsQL = preset.requireQL && !isPrep(s.title);
    if (needsQL && !qls.length) add(hard, "missing-ql", s, i, s.line, `${where}: add one main question, like "QL: What should they learn here?"`);
    if (qls.length > 1) add(hard, "extra-ql", s, i, qls[1].line, `${where} has ${qls.length} QL lines; keep one main question.`);
    if (preset.qlFirst && qls.length) {
      const firstNonLink = s.entries.find((e) => e.type !== "link");
      if (firstNonLink && firstNonLink.type !== "ql") add(hard, "ql-not-first", s, i, qls[0].line, `${where}: put the QL right after the links, before the spoken lines.`);
    }

    // Short lines.
    for (const e of s.entries) {
      if (e.type === "link" || e.type === "ql") continue;
      const n = countWords(e.text);
      if (n > preset.maxWords) {
        add(hard, "line-too-long", s, i, e.line, `${where}: "${e.text}" has ${n} words; keep it to ${preset.maxWords} or fewer.`);
      }
      if (e.heading) add("warning", "heading-level", s, i, e.line, `${where}: only ## or ### start a section; this line shows as text.`);
    }

    // Transitions come in pairs: Next, then Now.
    if (preset.pairedTransitions) {
      s.entries.forEach((e, k) => {
        if (e.type === "next" && s.entries[k + 1]?.type !== "now") add(hard, "transition-pair", s, i, e.line, `${where}: follow "${e.text}" with a "Now: …" line.`);
        if (e.type === "now" && s.entries[k - 1]?.type !== "next") add(hard, "transition-pair", s, i, e.line, `${where}: put a "Next: …" line before "${e.text}".`);
      });
    }
  });

  if (preset.prepThenIntro && sections.length) {
    if (!isPrep(sections[0].title)) add("warning", "order-prep", sections[0], 0, sections[0].line, "Start with a PREP section (your checklist before going live).");
    const introIndex = isPrep(sections[0].title) ? 1 : 0;
    const intro = sections[introIndex];
    if (intro && !isIntro(intro.title)) add("warning", "order-intro", intro, introIndex, intro.line, "Put the INTRO section right after PREP.");
  }

  const errors = problems.filter((p) => p.severity === "error").length;
  return { preset: preset.name, ok: errors === 0, errors, warnings: problems.length - errors, sections: sections.length, problems };
}

/** One problem per line, for people and agents. */
export function describeProblems(result) {
  if (!result.problems.length) return `No problems found (preset ${result.preset}, ${result.sections} sections).`;
  return [
    `${result.errors} error(s), ${result.warnings} warning(s) (preset ${result.preset}, ${result.sections} sections):`,
    ...result.problems.map((p) => `- ${p.severity}${p.line ? ` line ${p.line}` : ""}: ${p.message}`),
  ].join("\n");
}

// ---------- Links (#s=) ----------

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Link data is damaged.");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  let bin;
  try { bin = atob(b64); } catch { throw new Error("Link data is damaged."); }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Compress a script for the URL fragment: deflate-raw, then base64url. */
export async function encodeScript(text) {
  const stream = new Blob([new TextEncoder().encode(String(text))]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** Reverse of encodeScript; refuses output above MAX_DECODED_BYTES. */
export async function decodeScript(data) {
  const reader = new Blob([fromBase64Url(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_DECODED_BYTES) { await reader.cancel(); throw new Error("Script in the link is too large."); }
      chunks.push(value);
    }
  } catch (error) {
    if (error.message === "Script in the link is too large.") throw error;
    throw new Error("Link data is damaged.");
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder().decode(all);
}

/** Build a prompter link; the script travels only in the fragment. */
export async function makeLink(text, presetName, origin = SITE) {
  const preset = PRESETS[presetName] ? presetName : "default";
  return `${origin.replace(/\/+$/, "")}/#s=${await encodeScript(text)}${preset === "default" ? "" : `&p=${preset}`}`;
}

/** Read { data, preset } from a location hash like "#s=…&p=lex". */
export function readHash(hash) {
  const q = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const p = q.get("p");
  return { data: q.get("s"), preset: PRESETS[p] ? p : null };
}
