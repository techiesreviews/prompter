// Page logic. scripts/build.mjs inlines src/core.mjs and src/follow.mjs above
// this file inside one function, so parse, PRESETS, DEMO_SCRIPT, encodeScript,
// followLine, heardLink, linkAt, speechWords … are in scope here.

// ---------- Player view ----------
// The main-screen window shows a YouTube video full size via this same page.
if (location.hash.startsWith("#player=")) {
  const q = new URLSearchParams(location.hash.slice(1));
  const start = Number(q.get("start")) || 0;
  document.body.innerHTML = "";
  document.body.style.cssText = "margin:0;background:#000;overflow:hidden";
  document.querySelector("style").remove();
  const f = document.createElement("iframe");
  f.src = `https://www.youtube.com/embed/${encodeURIComponent(q.get("player"))}?start=${start}&rel=0`;
  f.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
  f.allowFullscreen = true;
  f.referrerPolicy = "strict-origin-when-cross-origin";
  f.style.cssText = "border:0;width:100vw;height:100vh;display:block";
  document.body.append(f);
  document.title = "Main screen · video";
  window.addEventListener("hashchange", () => location.reload());
  return;
}

// ---------- Fonts ----------
// Inter and Roboto Mono (SIL Open Font License 1.1, fonts/OFL.txt) come from
// /fonts/ when the page is served. An offline copy opened from a file uses the
// system fonts, so it never asks for a file that is not there.
if (/^https?:$/.test(location.protocol)) {
  const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
  const face = (family, file, weight) =>
    `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url("/fonts/${file}") format("woff2");unicode-range:${LATIN}}`;
  const fonts = document.createElement("style");
  fonts.textContent = face("Inter", "inter-latin.woff2", "400 800") + face("Roboto Mono", "roboto-mono-latin.woff2", "400 500");
  document.head.append(fonts);
}

const $ = (sel) => document.querySelector(sel);
const root = document.documentElement;
const main = $(".script");
const statusEl = $(".status");
const clockBtn = $(".clock");
const clockTime = $(".clock-time");
const connectBtn = $(".screen");
const autoBtn = $(".auto");
const voiceBtn = $(".voice");
const voiceNotice = $(".voice-notice");
const alertEl = $(".note-row.alert");
const hintEl = $(".screen-hint");
const pasteDialog = $(".paste-dialog");
const aiDialog = $(".ai-dialog");
const fileInput = $(".file-input");
const continueBtn = $(".continue");
const speedInput = $(".speed");
const sizeInput = $(".size");
const widthInputs = document.querySelectorAll('input[name="width"]');
const WINDOW_NAME = "prompter-main-screen";
const SETTLE_MS = 700; // wait this long on a section before changing the main screen
const LAST_KEY = "prompter-last-script";
const PRESET_KEY = "prompter-preset";
const VOICE_OK_KEY = "prompter-voice-ok";
const LINE_KEY = "prompter-line";
const LINE_DEFAULT = 0.34; // the reading line, as a share of the window height from the top
const LINE_MIN = 0.08;
const LINE_MAX = 0.75; // clear of the control bar and its notices
const WIDTHS = ["narrow", "medium", "full"];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// Some viewers (for example a sandboxed file preview) refuse storage; never let that stop the page.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* not available */ } },
};

let scriptText = "";
let preset = PRESETS[store.get(PRESET_KEY)] ? store.get(PRESET_KEY) : "default";
let sections = [];
let active = -1;
let mainWin = null;
let shownUrl = "";
let settleTimer = 0;
let anchor = null; // the link above the reading line: { s, l } or null (see linkAt)
let anchorKey = "";
let hintShown = false;
let hintTimer = 0;
let voiceLinkKey = ""; // the link Follow my voice opened last by hearing its label
let voiceLinkAt = -1; // index of the speech result that label was heard in
let clockStart = 0;
let autoOn = false;
let speed = Number(store.get("prompter-speed")) || 40;
let lastFrame = 0;
let voiceLines = []; // speechWords of each spoken line, by data-k
let voiceOn = false;
let voiceAt = -1;
let recognition = null;
let voiceRestarts = 0;
let resumeAuto = false;

const mcpUrl = () => (/^https?:$/.test(location.protocol) ? `${location.origin}/mcp` : `${SITE}/mcp`);

// ---------- Opening scripts ----------
const isEmpty = () => root.dataset.view === "empty";
const plainAddress = () => location.pathname + location.search;

/**
 * Show a script. `fromLink` keeps the current address (a #s= link, #demo or
 * an embedded copy); otherwise the address gets the script's #s= link, as a
 * new history entry when it replaces the start screen (so Back returns there).
 * `remember` keeps it as this browser's last script. Returns false if empty.
 */
async function openScript(text, { fromLink = false, remember = true, label = "" } = {}) {
  const parsed = parse(text);
  if (!parsed.length) return false;
  if (voiceOn) stopVoice();
  const fromStart = isEmpty();
  scriptText = text;
  sections = parsed;
  if (remember) store.set(LAST_KEY, text);
  root.dataset.view = "script";
  $(".empty").hidden = true;
  window.scrollTo(0, 0);
  render();
  setStatus(label);
  if (!fromLink) {
    try {
      const data = await encodeScript(text);
      const url = `#s=${data}${preset === "default" ? "" : `&p=${preset}`}`;
      if (fromStart) history.pushState(null, "", url); else history.replaceState(null, "", url);
    } catch { /* the link is a convenience; the prompter works without it */ }
  }
  return true;
}

function openDemo() {
  if (location.hash !== "#demo") history[isEmpty() ? "pushState" : "replaceState"](null, "", "#demo");
  return openScript(DEMO_SCRIPT, { fromLink: true, remember: false });
}

// A remembered script is named by its first section after PREP and INTRO
// (which most scripts start with), so the reader knows which one it is.
function rememberedTitle(text) {
  const parsed = text ? parse(text) : [];
  return (parsed.find((s) => !/^(PREP|INTRO)$/i.test(s.title)) || parsed[0])?.title || "";
}

/** The start screen: open, paste, ask your AI or try the demo. Opens nothing by itself. */
function showStart() {
  if (voiceOn) stopVoice();
  setAuto(false);
  hidePopovers();
  scriptText = "";
  sections = [];
  main.innerHTML = "";
  active = -1;
  anchor = null;
  anchorKey = "";
  clearTimeout(settleTimer);
  hideHint();
  setStatus("");
  if (location.hash) history.replaceState(null, "", plainAddress());
  const title = rememberedTitle(store.get(LAST_KEY));
  continueBtn.hidden = !title;
  continueBtn.textContent = `Continue: ${title}`;
  root.dataset.view = "empty";
  $(".empty").hidden = false;
  window.scrollTo(0, 0);
}

async function route() {
  showAlert("");
  const hash = location.hash;
  if (hash.startsWith("#s=") || hash.includes("&s=")) {
    const { data, preset: p } = readHash(hash);
    preset = p || "default"; // a link without &p= was made for the default preset
    store.set(PRESET_KEY, preset);
    let text;
    try { text = await decodeScript(data || ""); } catch (error) {
      showStart();
      showAlert(`This link could not be opened: ${error.message}`);
      return;
    }
    if (!(await openScript(text, { fromLink: true, label: "Opened from link" }))) {
      showStart();
      showAlert("This link has no sections. Each section starts with a title line like: ### **INTRO · 00:00**");
    }
    return;
  }
  if (hash === "#demo") { await openDemo(); return; }
  const embedded = $("#script-md").textContent;
  if (parse(embedded).length) {
    await openScript(embedded, { fromLink: true, remember: false });
    return;
  }
  showStart();
}

// ---------- Rendering ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SPOKEN = new Set(["say", "bullet", "next", "now"]);
const OPENS_AT_LINE = "opens on the main screen when it reaches the reading line";
// Links stay quiet: a small row at the top of the section, a small marker for
// a link on its own line mid-section, and words with a faint underline for a
// link inside a line. The address is only in the tooltip.
const ARROW = `<span class="arrow" aria-hidden="true">↗</span>`;
const hostLabel = (l) => esc(hostOf(l.url) || l.url);
const mark = (l, i, j) =>
  `<button class="mark" type="button" data-s="${i}" data-l="${j}" title="${hostLabel(l)} · ${OPENS_AT_LINE}">${ARROW}<span>${esc(l.label)}</span></button>`;
const textLink = (l, i, j) =>
  `<a class="inlink" href="${esc(l.url)}" rel="noopener noreferrer" data-s="${i}" data-l="${j}" title="${hostLabel(l)} · ${OPENS_AT_LINE}">${esc(l.label)}</a>`;

/** A line's text: a Next:/Now: label in bold, links written inside it in place. */
function lineHtml(it, i) {
  const t = it.text;
  const bold = it.type === "next" || it.type === "now" ? (t.match(/^[^:]{1,12}:/)?.[0].length ?? 0) : 0;
  let html = bold ? `<b>${esc(t.slice(0, bold))}</b>` : "";
  let at = bold;
  for (const span of it.spans || []) {
    html += esc(t.slice(at, span.from)) + textLink(sections[i].links[span.l], i, span.l);
    at = span.to;
  }
  return html + esc(t.slice(at));
}

function render() {
  voiceLines = [];
  main.innerHTML = sections.map((s, i) => {
    const links = s.links.length
      ? `<div class="links">${s.links.map((l, j) =>
          `<button class="link" type="button" data-s="${i}" data-l="${j}" title="${hostLabel(l)}${j < 9 ? ` · key ${j + 1}` : ""}"${j < 9 ? ` aria-label="${esc(l.label)}, key ${j + 1}" aria-keyshortcuts="${j + 1}"` : ""}>${ARROW}<span>${esc(l.label)}</span>${j < 9 ? `<span class="key">${j + 1}</span>` : ""}</button>`).join("")}</div>`
      : "";
    // The QL main question is read silently: always show it at the top.
    const qls = s.items.filter((it) => it.type === "ql")
      .map((it) => `<p class="ql"><small>Main question · answer it, don't read it</small>${esc(it.text)}</p>`).join("");
    // Items in order, with each own-line inline link's marker just before
    // items[at]. Links inside a line are drawn in that line's text.
    const marksAt = (n) => s.links.flatMap((l, j) => (l.inline && !l.inText && l.at === n ? [{ type: "mark", l, j }] : []));
    const rest = s.items.flatMap((it, n) => [...marksAt(n), it]).concat(marksAt(s.items.length))
      .filter((it) => it.type !== "ql");
    while (rest[0]?.type === "gap") rest.shift();
    while (rest.at(-1)?.type === "gap") rest.pop();
    const items = rest.map((it) => {
      if (it.type === "gap") return `<div class="gap"></div>`;
      if (it.type === "mark") return mark(it.l, i, it.j);
      const k = SPOKEN.has(it.type) ? ` data-k="${voiceLines.push(speechWords(it.text)) - 1}"` : "";
      return `<p class="${it.type}"${k}>${SPOKEN.has(it.type) ? lineHtml(it, i) : esc(it.text)}</p>`;
    }).join("");
    return `<section class="section" data-i="${i}"><h2 class="title"><span>${esc(s.title)}</span><span class="time">${esc(s.time)}</span></h2>${links}${qls}${items}</section>`;
  }).join("");
  active = -1;
  shownUrl = "";
  anchor = null;
  anchorKey = "";
  voiceLinkKey = "";
  voiceLinkAt = -1;
  clearTimeout(settleTimer);
  voiceAt = -1;
  updateActive();
}

// ---------- Popovers and dialogs ----------
// Open and Settings are native popovers (light dismiss, Escape) anchored above
// their bar buttons with CSS anchor positioning. Where the browser has none,
// placeAbove() puts them there by hand.
const anchored = CSS.supports?.("position-anchor: --a") ?? false;
const invokerOf = (pop) => document.querySelector(`[popovertarget="${pop.id}"]`);

function placeAbove(pop) {
  const b = invokerOf(pop).getBoundingClientRect();
  const w = pop.offsetWidth;
  const x = Math.min(window.innerWidth - w - 8, Math.max(8, b.left + b.width / 2 - w / 2)) - 8; // minus its side margin
  pop.style.inset = `auto auto ${Math.round(window.innerHeight - b.top)}px ${Math.round(x)}px`;
}

function hidePopovers() {
  document.querySelectorAll(".pop").forEach((pop) => { if (pop.matches(":popover-open")) pop.hidePopover(); });
}

for (const pop of document.querySelectorAll(".pop")) {
  const button = invokerOf(pop);
  pop.addEventListener("beforetoggle", (e) => {
    const open = e.newState === "open";
    button.setAttribute("aria-expanded", String(open));
    // Placed in the frame it first shows in, once it has a size.
    if (open && !anchored) requestAnimationFrame(() => placeAbove(pop));
  });
  // Closed with Escape, by an item or by a click outside: focus goes back to
  // its bar button. That focus only holds the bar when it is keyboard focus.
  pop.addEventListener("toggle", (e) => {
    if (e.newState === "closed" && (pop.contains(document.activeElement) || document.activeElement === document.body)) button.focus({ preventScroll: true });
  });
}

function showDialog(dialog) {
  hidePopovers();
  dialog.showModal();
}

/** "Use your AI": this server's own /mcp address, filled in once. */
function openAi() {
  const url = mcpUrl();
  aiDialog.querySelector(".mcp-url").textContent = url;
  aiDialog.querySelectorAll(".mcp-snippet").forEach((el) => { el.textContent = el.textContent.replaceAll(`${SITE}/mcp`, url); });
  showDialog(aiDialog);
}

// ---------- Reading line ----------
// Dragged by its handle (or moved with the keys on it) to camera height and
// remembered on this device as a share of the window height. It is set on
// :root as --line in px; the page's CSS and every check here use that one value.
const handle = $(".line-handle");
const LINE_STEPS = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }; // percent
const TAP_SLOP = 8; // px a finger may drift and still tap (a mouse or pen: 2px)
const LINE_KEYS = [...Object.keys(LINE_STEPS), "Home", "End"];
let lineFrac = LINE_DEFAULT;
let lineY = 0;
let lineDrag = null; // { id, offset, from, start, slop, moved } while a pointer drags the handle
let dragFrame = 0;
let dragY = 0;
let lastTap = -Infinity; // two taps (or clicks) on the handle without a move reset the line

function readingLineY() { return lineY; }
// The window height without the phone's address bar: it stays the same when the
// bar hides or shows while scrolling, so the line and the script do not jump.
const viewHeight = () => document.documentElement.clientHeight || window.innerHeight;

/**
 * Put the line at `frac` of the window height. With `keepText` the script
 * stays where it is on screen while the line moves (the page scrolls by the
 * change in its top space), except at the very top and the very end, where
 * the page cannot scroll further and the text follows the line.
 */
function setLine(frac, keepText = false) {
  lineFrac = Math.min(LINE_MAX, Math.max(LINE_MIN, Number(frac) || LINE_DEFAULT));
  const y = Math.round(viewHeight() * lineFrac);
  const delta = y - lineY;
  lineY = y;
  root.style.setProperty("--line", `${y}px`);
  const pct = Math.round(lineFrac * 100);
  handle.setAttribute("aria-valuenow", String(pct));
  handle.setAttribute("aria-valuetext", `${pct}% from the top`);
  if (keepText && delta) {
    window.scrollBy(0, delta);
    lastScrollY = window.scrollY; // not a scroll by the reader: the bar stays
  }
}

/** Move the line for the reader: the section, its link and Follow my voice follow it. */
function moveLine(frac, save = false) {
  setLine(frac, true);
  if (save) store.set(LINE_KEY, lineFrac.toFixed(4));
  updateActive();
  if (voiceOn) voiceAt = lineAtReadingLine();
}

// Mouse, pen and touch drag it the same way; the page does not scroll under a finger (touch-action: none).
handle.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  lineDrag = { id: e.pointerId, offset: e.clientY - lineY, from: e.clientY, start: lineFrac, slop: e.pointerType === "touch" ? TAP_SLOP : 2, moved: false };
  handle.dataset.dragging = "true";
});
handle.addEventListener("pointermove", (e) => {
  if (lineDrag?.id !== e.pointerId) return;
  // The line stays put until the pointer has really moved, so a tap never nudges it.
  if (!lineDrag.moved && Math.abs(e.clientY - lineDrag.from) < lineDrag.slop) return;
  lineDrag.moved = true;
  dragY = e.clientY - lineDrag.offset;
  if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; moveLine(dragY / viewHeight()); });
});
function endLineDrag(e) {
  if (lineDrag?.id !== e.pointerId) return;
  cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  const { offset, start, moved } = lineDrag;
  lineDrag = null;
  delete handle.dataset.dragging;
  if (e.type === "pointerup" && moved) { lastTap = -Infinity; moveLine((e.clientY - offset) / viewHeight(), true); return; }
  // A tap or click keeps the line where it was, unless it is the second one in
  // a row. A cancelled touch (the system took it over) puts it back too.
  const reset = e.type === "pointerup" && e.timeStamp - lastTap < 400;
  lastTap = reset || e.type !== "pointerup" ? -Infinity : e.timeStamp;
  moveLine(reset ? LINE_DEFAULT : start, true);
}
handle.addEventListener("pointerup", endLineDrag);
handle.addEventListener("pointercancel", endLineDrag);
handle.addEventListener("keydown", (e) => {
  if (!LINE_KEYS.includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  const pct = Math.round(lineFrac * 100);
  moveLine(e.key === "Home" ? LINE_MIN : e.key === "End" ? LINE_MAX : (pct + LINE_STEPS[e.key]) / 100, true);
});

// ---------- Active section ----------

function updateActive() {
  const els = main.querySelectorAll(".section");
  const y = readingLineY();
  let idx = 0;
  els.forEach((el, i) => { if (el.getBoundingClientRect().top <= y + 4) idx = i; });
  if (idx !== active) {
    active = idx;
    els.forEach((el, i) => el.classList.toggle("active", i === idx));
    updateClock();
  }
  // The most recent link above the reading line goes on the main screen once
  // the reader settles there, so fast scrolling does not flash every link.
  let reached = -1;
  els[idx]?.querySelectorAll(".mark, .inlink").forEach((el) => { if (el.getBoundingClientRect().top <= y + 4) reached = Number(el.dataset.l); });
  const at = linkAt(sections, idx, reached);
  const key = at ? `${at.s}:${at.l}` : "";
  if (key === anchorKey) return;
  anchor = at;
  anchorKey = key;
  clearTimeout(settleTimer);
  if (at) settleTimer = setTimeout(() => showLink(at.s, at.l, false), SETTLE_MS);
}

// ---------- Main screen ----------
function connected() { return mainWin && !mainWin.closed; }

function setConnected(on) {
  connectBtn.dataset.on = String(on);
  connectBtn.setAttribute("aria-label", on ? "Main screen connected, reconnect" : "Connect main screen");
  connectBtn.dataset.tip = on ? "Main screen connected · click to reconnect" : "Connect main screen · links open there";
}

function connect() {
  mainWin = window.open("", WINDOW_NAME, "popup=yes,width=1400,height=900");
  if (!mainWin) { blocked(); return; }
  try {
    if (mainWin.location.href === "about:blank") {
      mainWin.document.title = "Main screen";
      mainWin.document.body.style.cssText = "margin:0;display:grid;place-items:center;height:100vh;background:#000;color:#f4f1ea;font:600 32px system-ui;text-align:center;padding:0 5vw";
      mainWin.document.body.textContent = "Drag this window to your main screen and make it full size. Pages will open here.";
    }
  } catch { /* already showing another site; fine */ }
  setConnected(true);
  setStatus("");
  hideHint();
  shownUrl = "";
  if (anchor) showLink(anchor.s, anchor.l, false);
}

// YouTube watch pages cut the link between the prompter and its window (their
// Cross-Origin-Opener-Policy), so later sections could no longer change it.
// The full-window embed player keeps the link.
function screenUrl(url) {
  try {
    const u = new URL(url);
    let id = "";
    if (u.hostname === "youtu.be") id = u.pathname.slice(1);
    else if (/(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/watch") id = u.searchParams.get("v") || "";
    if (!id) return url;
    const start = youtubeSeconds(u.searchParams.get("t") || u.searchParams.get("start") || "0");
    // Played inside this page's own player view: YouTube's embed refuses to play
    // when opened directly (error 153), and a same-origin page keeps the link.
    return `${location.href.split("#")[0]}#player=${encodeURIComponent(id)}&start=${start}`;
  } catch { return url; }
}

function showLink(si, li, fromUser) {
  const s = sections[si];
  if (!s || !s.links[li]) return;
  const url = screenUrl(s.links[li].url);
  if (!connected()) {
    const wasConnected = connectBtn.dataset.on === "true";
    setConnected(false);
    if (!fromUser) {
      if (wasConnected) lost();
      else showHint(s.links[li].label);
      return;
    }
    mainWin = window.open(url, WINDOW_NAME, "popup=yes,width=1400,height=900");
    if (!mainWin) { blocked(); return; }
    setConnected(true);
  }
  if (url !== shownUrl || fromUser) {
    try { mainWin.location.href = url; } catch { mainWin = window.open(url, WINDOW_NAME); }
    shownUrl = url;
  }
  main.querySelectorAll(".link, .mark, .inlink").forEach((b) => {
    b.dataset.shown = String(screenUrl(sections[b.dataset.s].links[b.dataset.l].url) === shownUrl);
  });
  setStatus(`On main screen: ${s.links[li].label}`);
}

function setStatus(t) { statusEl.textContent = t; statusEl.title = t; }

/** A message that must not be missed (errors). Empty text hides it. */
function showAlert(t) {
  alertEl.hidden = !t;
  $(".alert-text").textContent = t;
}

// Once per page: a link would have opened by itself, but no main screen is connected.
function showHint(label) {
  if (hintShown) return;
  hintShown = true;
  $(".hint-text").textContent = `“${label}” would open on your main screen now. Connect a main screen and links open by themselves.`;
  hintEl.hidden = false;
  connectBtn.dataset.hint = "true";
  hintTimer = setTimeout(hideHint, 15000);
}
function hideHint() {
  clearTimeout(hintTimer);
  hintEl.hidden = true;
  delete connectBtn.dataset.hint;
}

function lost() { showAlert("Main screen window lost. Click the main screen button in the bar, or a link button."); }
function blocked() { showAlert("No window could open. Allow pop-ups for this page."); }

// ---------- Clock ----------
const fmt = (sec) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

function updateClock() {
  if (!clockStart) return;
  const el = Math.floor((Date.now() - clockStart) / 1000);
  clockTime.textContent = fmt(el);
  const next = sections.slice(active + 1).find((s) => s.time);
  clockBtn.dataset.late = String(Boolean(next && el > toSeconds(next.time)));
}
// Pressing the clock starts it; pressing it again starts it over from 00:00.
function startClock() {
  clockStart = Date.now();
  clockBtn.dataset.running = "true";
  clockBtn.dataset.tip = "Show clock · click to restart from 00:00";
  $(".clock-label").textContent = "Show clock, click to restart from 00:00: ";
  updateClock();
}
setInterval(updateClock, 1000);

// ---------- Auto-scroll ----------
function tick(ts) {
  if (!autoOn) return;
  if (lastFrame) window.scrollBy(0, (speed * (ts - lastFrame)) / 1000);
  lastFrame = ts;
  requestAnimationFrame(tick);
}
function setAuto(on) {
  autoOn = on;
  lastFrame = 0;
  autoBtn.setAttribute("aria-pressed", String(on));
  autoBtn.dataset.tip = on ? "Pause · Space" : "Auto-scroll · Space";
  if (on) requestAnimationFrame(tick);
}
function toggleAuto() {
  if (voiceOn) { setStatus("Auto-scroll is paused while Follow my voice is on."); return; }
  setAuto(!autoOn);
}

function setSpeed(v) {
  speed = Math.min(300, Math.max(10, Math.round(v / 10) * 10 || 40));
  speedInput.value = speed;
  $(".speed-val").textContent = speed;
  store.set("prompter-speed", speed);
}

// ---------- Text size and column ----------
function setSize(px) {
  px = Math.min(110, Math.max(20, Math.round(px) || 52));
  root.style.setProperty("--size", px + "px");
  sizeInput.value = px;
  $(".size-val").textContent = `${px} px`;
  store.set("prompter-size", px);
}
const curSize = () => parseInt(getComputedStyle(root).getPropertyValue("--size"), 10);

function setWidth(name) {
  const w = WIDTHS.includes(name) ? name : "medium";
  root.dataset.width = w;
  widthInputs.forEach((input) => { input.checked = input.value === w; });
  store.set("prompter-width", w);
}

function goSection(delta) {
  const els = main.querySelectorAll(".section");
  const target = els[Math.min(els.length - 1, Math.max(0, active + delta))];
  if (!target) return;
  window.scrollTo({ top: target.offsetTop - readingLineY() + 2 });
  updateActive(); // at once, so quick repeated presses keep moving
  if (voiceOn) voiceAt = lineAtReadingLine();
}

// ---------- Follow my voice ----------
// The browser's speech recognition turns the voice into words (Chrome sends
// the audio to Google for that); the script itself never leaves the page.
function lineAtReadingLine() {
  const y = readingLineY();
  let k = -1;
  main.querySelectorAll("[data-k]").forEach((el) => { if (el.getBoundingClientRect().top <= y + 4) k = Number(el.dataset.k); });
  return k;
}

let voiceScrolling = false;
function markLine(k) {
  main.querySelector("p.cur")?.classList.remove("cur");
  const el = main.querySelector(`[data-k="${k}"]`);
  if (!el) return;
  el.classList.add("cur");
  const top = el.getBoundingClientRect().top + window.scrollY - readingLineY() + 2;
  voiceScrolling = true;
  window.scrollTo({ top, behavior: reducedMotion.matches ? "auto" : "smooth" });
  setTimeout(() => { voiceScrolling = false; }, 800);
}

function setVoiceButton() {
  voiceBtn.setAttribute("aria-pressed", String(voiceOn));
}

function toggleVoice() {
  if (voiceOn) { stopVoice(); setStatus("Follow my voice is off."); return; }
  if (store.get(VOICE_OK_KEY) !== "yes") {
    voiceNotice.hidden = false;
    voiceNotice.querySelector('[data-action="voice-ok"]').focus();
    return;
  }
  startVoice();
}

function startVoice() {
  voiceNotice.hidden = true;
  showAlert("");
  try {
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = onVoiceResult;
    recognition.onerror = onVoiceError;
    recognition.onend = onVoiceEnd;
    recognition.start();
  } catch {
    recognition = null;
    showAlert("Follow my voice could not start in this browser.");
    return;
  }
  voiceOn = true;
  voiceRestarts = 0;
  voiceLinkKey = "";
  voiceLinkAt = -1;
  voiceAt = lineAtReadingLine();
  resumeAuto = autoOn;
  setAuto(false);
  setVoiceButton();
  setStatus("Listening. Read your script out loud.");
}

function stopVoice(message = "") {
  const r = recognition;
  recognition = null;
  voiceOn = false;
  if (r) {
    r.onresult = r.onerror = r.onend = null;
    try { r.abort(); } catch { /* already stopped */ }
  }
  setVoiceButton();
  main.querySelector("p.cur")?.classList.remove("cur");
  if (message) showAlert(message);
  if (resumeAuto) { resumeAuto = false; setAuto(true); }
}

function onVoiceResult(e) {
  voiceRestarts = 0;
  let heard = "";
  for (let i = Math.max(0, e.results.length - 3); i < e.results.length; i++) heard += ` ${e.results[i][0].transcript}`;
  const k = followLine(voiceLines, voiceAt, heard);
  if (k !== voiceAt && k >= 0) { voiceAt = k; markLine(k); }
  // Saying a link's label (this section or the next) opens it at once. The
  // heard words keep a label for a few more results; that echo never reopens
  // it. Only a label heard in a later result does, and only when the main
  // screen shows something else.
  const said = heardLink(voiceLinkCandidates(), heard);
  if (!said) return;
  let at = e.results.length - 1;
  while (at > 0 && !heardLink([said], e.results[at][0].transcript)) at--;
  const fresh = said.key !== voiceLinkKey
    || (at > voiceLinkAt && screenUrl(sections[said.s].links[said.l].url) !== shownUrl);
  // Heard while already on screen: remember where, so its echo stays quiet too.
  if (!fresh) { if (said.key === voiceLinkKey) voiceLinkAt = Math.max(voiceLinkAt, at); return; }
  voiceLinkKey = said.key;
  voiceLinkAt = at;
  clearTimeout(settleTimer);
  showLink(said.s, said.l, false);
}

// Links inside a line are left out: their words are ordinary spoken words, so
// hearing them earlier would open the link early. They open at their line.
function voiceLinkCandidates() {
  return [active, active + 1].flatMap((si) => (sections[si]?.links || [])
    .flatMap((l, li) => (l.inText ? [] : [{ label: l.label, s: si, l: li, key: `${si}:${li}` }])));
}

const VOICE_ERRORS = {
  "not-allowed": "The microphone is blocked. Allow it for this page to use Follow my voice.",
  "service-not-allowed": "This browser does not allow speech recognition here. Follow my voice is off.",
  "audio-capture": "No microphone found. Follow my voice is off.",
  network: "The browser's speech service could not be reached. Follow my voice is off.",
  "language-not-supported": "The browser's speech service does not support your language. Follow my voice is off.",
};

function onVoiceError(e) {
  if (e.error === "no-speech" || e.error === "aborted") return; // onend restarts
  stopVoice(VOICE_ERRORS[e.error] || "Follow my voice stopped. Turn it on again to retry.");
}

// Chrome ends a continuous session after a pause; start again while it is on.
function onVoiceEnd() {
  if (!voiceOn || !recognition) return;
  if (++voiceRestarts > 5) { stopVoice("Follow my voice stopped hearing you. Turn it on again to retry."); return; }
  voiceLinkAt = -1; // a new session numbers its results from 0 again
  try { recognition.start(); } catch { stopVoice("Follow my voice stopped. Turn it on again to retry."); }
}

// ---------- Link, paste and copy ----------
function publicBase() {
  return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : `${SITE}/`;
}

async function copyText(text, done, ask) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(done);
  } catch {
    window.prompt(ask, text);
  }
}

async function copyLink() {
  const link = `${publicBase()}#s=${await encodeScript(scriptText)}${preset === "default" ? "" : `&p=${preset}`}`;
  await copyText(link, "Link copied. The script is inside the link.", "Copy this link. The script is inside it:");
}

function openPaste() {
  $(".paste-error").hidden = true;
  showDialog(pasteDialog);
  $("#paste-text").focus();
}

async function submitPaste() {
  const ok = await openScript($("#paste-text").value, { label: "Opened pasted script" });
  if (!ok) {
    const err = $(".paste-error");
    err.hidden = false;
    err.textContent = "No sections found. Each section starts with a title line like: ### **INTRO · 00:00**";
    return;
  }
  showAlert("");
  pasteDialog.close();
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_DECODED_BYTES) { showAlert("That file is too large for a script."); return; }
  if (await openScript(await file.text(), { label: `Loaded ${file.name}` })) showAlert("");
  else showAlert(`No sections found in ${file.name}. Each section starts with a title line like: ### **INTRO · 00:00**`);
}

// ---------- Events ----------
window.addEventListener("scroll", () => requestAnimationFrame(updateActive), { passive: true });

// The control bar tucks away while scrolling down (by hand, auto-scroll or
// voice) and comes back when scrolling up, near the bottom edge, or on focus.
const dockEl = $(".dock");
let lastScrollY = window.scrollY;
let mouseNearBottom = false;
let lastTouch = 0;
function tuckDock(tucked) {
  // Only keyboard focus holds the bar: a clicked or tapped button keeps focus too.
  if (tucked && (mouseNearBottom || dockEl.querySelector(":focus-visible") || document.querySelector(".pop:popover-open"))) return;
  dockEl.dataset.tucked = String(tucked);
}
window.addEventListener("scroll", () => {
  const y = window.scrollY;
  if (Math.abs(y - lastScrollY) < 6) return;
  tuckDock(y > lastScrollY && y > 40);
  lastScrollY = y;
}, { passive: true });
// While the mouse rests near the bottom edge the bar stays, even during auto-scroll.
// A tap also sends a mousemove at the tap point; those are ignored.
document.addEventListener("touchstart", () => { lastTouch = Date.now(); mouseNearBottom = false; }, { passive: true, capture: true });
document.addEventListener("mousemove", (e) => {
  if (Date.now() - lastTouch < 1000) return;
  mouseNearBottom = e.clientY > window.innerHeight - 110;
  if (mouseNearBottom) tuckDock(false);
}, { passive: true });
document.documentElement.addEventListener("mouseleave", () => { mouseNearBottom = false; });
dockEl.addEventListener("focusin", () => { if (dockEl.querySelector(":focus-visible")) tuckDock(false); });
window.addEventListener("resize", () => { setLine(lineFrac); updateActive(); });
// Scrolling by hand while following the voice: continue from where the reader looks.
// Keyboard and scrollbar scrolling end in "scrollend"; the prompter's own voice
// scrolling is ignored.
for (const type of ["wheel", "touchmove", "scrollend"]) {
  window.addEventListener(type, () => {
    if (voiceOn && !voiceScrolling) requestAnimationFrame(() => { voiceAt = lineAtReadingLine(); });
  }, { passive: true });
}
connectBtn.addEventListener("click", connect);
clockBtn.addEventListener("click", startClock);
autoBtn.addEventListener("click", toggleAuto);
voiceBtn.addEventListener("click", toggleVoice);
$(".prev").addEventListener("click", () => goSection(-1));
$(".next").addEventListener("click", () => goSection(1));
speedInput.addEventListener("input", () => setSpeed(Number(speedInput.value)));
sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));
widthInputs.forEach((input) => input.addEventListener("change", () => setWidth(input.value)));
main.addEventListener("click", (e) => {
  const b = e.target.closest(".link, .mark, .inlink");
  if (!b) return;
  // A link inside a line is a real link: with a modifier key it opens in a new tab as usual.
  if (b.matches(".inlink")) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
  }
  showLink(Number(b.dataset.s), Number(b.dataset.l), true);
});
document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-action]");
  const action = button?.dataset.action;
  if (!action) return;
  if (button.closest(".pop")) hidePopovers();
  if (action === "open-file") fileInput.click();
  else if (action === "paste") openPaste();
  else if (action === "open-paste") submitPaste();
  else if (action === "close-dialog") button.closest("dialog").close();
  else if (action === "copy-link") copyLink();
  else if (action === "ai") openAi();
  else if (action === "start") { showAlert(""); history.pushState(null, "", plainAddress()); showStart(); }
  else if (action === "demo") { showAlert(""); openDemo(); }
  else if (action === "continue") { showAlert(""); openScript(store.get(LAST_KEY) || "", { label: "Your last script" }); }
  else if (action === "copy-mcp") copyText(mcpUrl(), "Server address copied.", "Copy the server address:");
  else if (action === "dismiss") showAlert("");
  else if (action === "connect") connect();
  else if (action === "hint-ok") hideHint();
  else if (action === "voice-ok") { store.set(VOICE_OK_KEY, "yes"); startVoice(); }
  else if (action === "voice-cancel") { voiceNotice.hidden = true; }
});
// One file input for the start screen and the Open menu.
fileInput.addEventListener("change", () => {
  loadFile(fileInput.files[0]);
  fileInput.value = "";
});
document.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  document.body.classList.add("dropping");
});
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
document.addEventListener("drop", (e) => {
  document.body.classList.remove("dropping");
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  e.preventDefault();
  loadFile(file);
});
// Fires for Back/Forward and for a new #s= link pasted into the address bar.
// Back to an entry without a script link shows the start screen.
window.addEventListener("popstate", () => { showAlert(""); route(); });
document.addEventListener("keydown", (e) => {
  if (isEmpty() || document.querySelector("dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest("textarea, select, input:not([type=range])")) return;
  const k = e.key;
  // A focused slider keeps its arrow keys; every other shortcut still works.
  if (e.target.matches?.("input[type=range]") && k.startsWith("Arrow")) return;
  // The focused reading line handle keeps its keys (arrows, Page Up/Down, Home, End).
  if (e.target.closest(".line-handle") && LINE_KEYS.includes(k)) return;
  // Space on these buttons presses them; on the control bar and the links it still means auto-scroll.
  if (k === " " && e.target.closest(".note-row, .pop")) return;
  if (k === " ") { e.preventDefault(); toggleAuto(); }
  else if (k === "ArrowRight" || k === "PageDown") { e.preventDefault(); goSection(1); }
  else if (k === "ArrowLeft" || k === "PageUp") { e.preventDefault(); goSection(-1); }
  else if (k === "+" || k === "=") setSize(curSize() + 4);
  else if (k === "-" || k === "_") setSize(curSize() - 4);
  else if (k === "]" || k === "[") setSpeed(speed + (k === "]" ? 10 : -10));
  else if (k === "f" || k === "F") {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
  }
  else if (/^[1-9]$/.test(k)) showLink(active, Number(k) - 1, true);
});

// ---------- Start ----------
voiceBtn.hidden = !Recognition;
setLine(store.get(LINE_KEY));
setSpeed(speed);
setSize(Number(store.get("prompter-size")) || (window.innerWidth < 640 ? 32 : 52));
setWidth(store.get("prompter-width") || "medium");
route();
