// Page logic. scripts/build.mjs inlines the modules in its INLINED list above this file inside one
// function, so their exports are in scope here without imports.

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
const connectBtn = $(".screen"); // in Settings
const settingsBtn = $(".settings-btn");
const openBtn = $(".open-btn");
const autoBtn = $(".auto");
const voiceBtn = $(".voice"); // in Settings
const voiceNotice = $(".voice-notice");
const alertEl = $(".note-row.alert");
const hintEl = $(".screen-hint");
const pasteDialog = $(".paste-dialog");
const fileInput = $(".file-input");
const continueBtn = $(".continue");
const continueTitle = $(".continue-title");
const continueSaved = $(".continue-saved");
const saveNote = $(".save-note");
const widthInputs = document.querySelectorAll('input[name="width"]');
const spacingInputs = document.querySelectorAll('input[name="spacing"]');
const toastEl = $(".toast");
const toastText = $(".toast-text");
const camframeBtn = $(".big-toggle.camframe"); // in Settings
const pasteStatus = $(".paste-status"); // the same for the paste window, which is modal too
const WINDOW_NAME = "prompter-main-screen";
const SETTLE_MS = 700; // wait this long on a section before changing the main screen
const LAST_KEY = STORED.lastScript;
const LAST_SAVED_KEY = STORED.lastSaved; // the day the last script was saved (YYYY-MM-DD), "" when not known
const LINE = SETTINGS.line; // the reading line, as a share of the window height from the top
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// Some viewers (for example a sandboxed file preview) refuse storage; never let that stop the page.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }, // false: not kept (full or blocked)
  del(k) { try { localStorage.removeItem(k); } catch { /* not available */ } },
};
// The settings (SETTINGS in src/settings.mjs): read and saved through their one table.
const prefs = settingsStore(store, { phone: window.innerWidth < 640 });

// The open script's own state (openScripts in src/open-script.mjs): its text and save date, sections, the
// section and link at the reading line, the voice's place, the cues. Made fresh on each open, so nothing
// from the script before carries over; the start screen holds an empty one.
const scripts = openScripts({ clock: window });
let notKept = null; // the title of the last script opened when it could not be kept on this device ("" if none), else null
let preset = prefs.read("preset");
let mainWin = null;
let hintShown = false;
let hintTimer = 0;
let clockStart = 0;
let autoOn = false; // auto-scroll is on: what Play shows, also while the scrolling waits for the Producer's cue box
let speed = prefs.read("speed");
let lastFrame = 0;
let autoFrame = 0; // the next animation frame of the scrolling, 0 while it does not run
let voiceOn = false;
let voiceLocal = false; // this browser recognises speech on this device (no network needed)
let voiceAsking = null; // the question whether it can, while it is asked
let resumeAuto = false;
// False until the person first does something on the page after it loads: until then a scroll
// (the browser putting a reloaded page back where it was, maybe after the first look) only moves
// the starting point and sends nothing. Only a page load resets it, so a script opened later
// (by the agent, say, while auto-scroll runs) sends its cues as usual.
let cueArmed = false;
// CamFrame link (camframeLink in src/camframe.mjs): off unless turned on in Settings; the page only draws it.
const camframe = camframeLink({ fetch, clock: window, visible: () => document.visibilityState === "visible", changed: () => drawCamframe() });
// The line under the Camera cues list: the words last read out, and the read-out still due.
const layoutsSay = { said: "", timer: 0 };

const isEmpty = () => root.dataset.view === "empty";
const plainAddress = () => location.pathname + location.search;

/**
 * Show a script. `fromLink` keeps the current address (a #s= link, #demo or
 * an embedded copy); otherwise the address gets the script's #s= link, as a
 * new history entry when it replaces the start screen (so Back returns there).
 * `remember` keeps it as this browser's last script, with the day it was saved (`saved`, YYYY-MM-DD: from the
 * link, the file or the agent; null when not known) for the start screen. Returns false if empty.
 */
async function openScript(text, { fromLink = false, remember = true, label = "", saved = null } = {}) {
  const parsed = parse(text);
  if (!parsed.length) return false;
  if (voiceOn) stopVoice();
  // Opened from the start screen, or over a script whose link (and its new history entry) is still being packed.
  const fromStart = isEmpty() || scripts.now.pushOwed;
  const script = scripts.open({ text, saved: savedDate(saved), sections: parsed });
  if (remember) {
    // The date goes first, so Continue never shows one script with another's date: not kept, Continue stays with
    // the script and date it had; kept but its date not, Continue shows no date.
    const oldDate = store.get(LAST_SAVED_KEY);
    store.del(LAST_SAVED_KEY);
    const kept = store.set(LAST_KEY, text);
    notKept = kept ? null : rememberedTitle(text);
    if (kept) store.set(LAST_SAVED_KEY, script.saved || "");
    else if (oldDate !== null) store.set(LAST_SAVED_KEY, oldDate);
  }
  root.dataset.view = "script";
  $(".empty").hidden = true;
  window.scrollTo(0, 0);
  render();
  setStatus(label);
  drawAsk(); // a cue that showed by itself over the start screen waits behind the pill now
  if (!fromLink) {
    script.pushOwed = fromStart;
    let url;
    try {
      url = `#s=${await encodeScript(text)}${linkExtras(preset, script.saved)}`;
    } catch {
      // The link is a convenience; the prompter works without it. But the address must not keep another script's link.
      url = plainAddress();
    }
    // Packing takes a moment: a script (or the start screen) that came in the meantime keeps the address.
    if (!scripts.current(script)) return true;
    script.pushOwed = false;
    if (fromStart) history.pushState(null, "", url); else history.replaceState(null, "", url);
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
  // A drag of the reading line ends here; the line goes back to where it was.
  if (lineDrag && handle.hasPointerCapture(lineDrag.id)) handle.releasePointerCapture(lineDrag.id);
  scripts.close();
  main.innerHTML = "";
  camframe.dropCue();
  hideToast();
  hideHint();
  setStatus("");
  if (location.hash) history.replaceState(null, "", plainAddress());
  const title = rememberedTitle(store.get(LAST_KEY));
  const saved = savedDate(store.get(LAST_SAVED_KEY));
  continueBtn.hidden = !title;
  continueTitle.textContent = `Continue: ${title}`;
  continueSaved.hidden = !saved;
  continueSaved.textContent = saved ? `Saved ${formatSavedDate(saved)}` : "";
  if (saved) continueSaved.dateTime = saved; else continueSaved.removeAttribute("datetime");
  // Named, so it is never taken for the script Continue offers (a newer copy with the same name is "your latest").
  saveNote.hidden = notKept === null;
  saveNote.textContent = !notKept ? "Couldn’t save this script on this device"
    : notKept === title ? `Couldn’t save your latest “${notKept}” on this device` : `Couldn’t save “${notKept}” on this device`;
  if (notKept === null) continueBtn.removeAttribute("aria-describedby");
  else { continueBtn.setAttribute("aria-describedby", "save-note"); setStatus(saveNote.textContent); }
  root.dataset.view = "empty";
  $(".empty").hidden = false;
  window.scrollTo(0, 0);
  drawAsk(); // no script: a waiting cue shows by itself
}

async function route() {
  showAlert("");
  const hash = location.hash;
  if (hash.startsWith("#s=") || hash.includes("&s=")) {
    const { data, preset: p, saved } = readHash(hash);
    // Unpacking takes a moment: a newer link (Back, then Forward), script or start screen that comes first wins.
    const newest = scripts.ask();
    let text;
    try { text = await decodeScript(data || ""); } catch (error) {
      if (!newest()) return;
      showStart();
      showAlert(`This link could not be opened: ${error.message}`);
      return;
    }
    if (!newest()) return;
    // Only a link that opens a script brings its preset; a link without &p= was made for the default one.
    if (parse(text).length) {
      preset = prefs.save("preset", p);
    }
    if (!(await openScript(text, { fromLink: true, label: "Opened from link", saved }))) {
      showStart();
      showAlert("This link has no sections. Each section starts with a title line like: ### **INTRO · 00:00**");
    }
    return;
  }
  if (hash === "#demo") { await openDemo(); return; }
  if (hash === "#camera-demo") { history.replaceState(null, "", "#demo"); await openDemo(); return; } // the old address: the one demo
  const embedded = $("#script-md").textContent;
  if (parse(embedded).length) {
    await openScript(embedded, { fromLink: true, remember: false });
    return;
  }
  showStart();
}

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
    html += esc(t.slice(at, span.from)) + textLink(scripts.now.sections[i].links[span.l], i, span.l);
    at = span.to;
  }
  return html + esc(t.slice(at));
}

// A camera cue line, whether or not the CamFrame link is on: a camera mark and
// what the camera will do, then the line's other words ("Share screen.").
const CAMERA_ICON = `<svg class="cue-icon" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/></svg>`;
function cueHtml(it) {
  const rest = cueRest(it.text);
  return `<p class="note cue" data-cue="${scripts.now.cues.push(it.cue) - 1}">${CAMERA_ICON}<span class="cue-what">Camera: ${esc(cueWords(it.cue))}</span>${rest ? `<span class="cue-rest"> · ${esc(rest)}</span>` : ""}</p>`;
}

/** Draws the script just opened, once: its state (scripts.now) is fresh, and gets its spoken lines and cues here. */
function render() {
  const { sections, voiceLines } = scripts.now;
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
      if (it.cue) return cueHtml(it);
      const k = SPOKEN.has(it.type) ? ` data-k="${voiceLines.push(speechWords(it.text)) - 1}"` : "";
      return `<p class="${it.type}"${k}>${SPOKEN.has(it.type) ? lineHtml(it, i) : esc(it.text)}</p>`;
    }).join("");
    return `<section class="section" data-i="${i}"><h2 class="title"><span>${esc(s.title)}</span><span class="time">${esc(s.time)}</span></h2>${links}${qls}${items}</section>`;
  }).join("");
  camframe.dropCue();
  updateActive();
}

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

// The Producer's cues (TOOLS-464; their queue is suggestionQueue in src/suggestions.mjs): what the agent
// pushes while it is connected to the person's Producer and to this tab, newest first, at most three.
// A pill in the kind's colour at the end of the reading line says one is waiting; a tap or Enter opens it
// in a box over the dimmed script (by itself when no script is open: a live show). In the box, ← → and
// Page Up/Down move between the waiting ones (what a clicker sends), Enter uses one and Esc skips it.
// While the box shows, auto-scroll and Follow my voice wait, then go on from the same place.
// It shows only while that agent is connected here and its pushes keep coming, so it is never a dead control.
const ask = suggestionQueue();
const askPill = $(".ask-pill");
const askBox = $(".ask-box");
const askVeil = $(".ask-veil");
const askText = $(".ask-text");
const askDots = $(".ask-dots");
const askWhere = $(".ask-where");
const ASK_KINDS = {
  question: ["?", "Question"],
  next: ["?", "Question"],
  steer: ["↩", "Steer back"],
  point: ["★", "Talking point"],
  audience: ["@", "Audience"],
};
let askTimer = 0;
let askShowing = false; // the box is on screen
let askSaid = ""; // the cue last read out, so moving to another reads that one
let askNewest = ""; // the newest cue the pill showed, so a new one nudges it
let voiceHold = VOICE_FREE; // what this session heard while the box showed, and until the next pause after (voiceHeld in src/follow.mjs): never followed

const askLive = () => live && liveLink.state === "on" && ask.shown();

function drawAsk() {
  const show = askLive();
  clearTimeout(askTimer);
  // Hidden again by itself once the pushes stop.
  if (show) askTimer = setTimeout(drawAsk, ask.staleIn() + 50);
  else ask.close(false); // gone quiet: not set aside, so the next push shows a live show's box again
  const items = show ? ask.items : [];
  const box = show && ask.boxOpen(isEmpty());
  askPill.hidden = !show || box;
  if (items.length) {
    const [mark, name] = ASK_KINDS[items[0].kind];
    const more = items.length - 1;
    askPill.dataset.kind = items[0].kind;
    askPill.querySelector(".ask-pill-mark").textContent = mark;
    askPill.querySelector(".ask-pill-name").textContent = name;
    askPill.querySelector(".ask-more").textContent = more ? `+${more}` : "";
    askPill.setAttribute("aria-label", `${name} from the Producer${more ? `, ${more} more waiting` : ""}. Open it`);
    if (items[0].text !== askNewest && !askPill.hidden) {
      askPill.removeAttribute("data-fresh");
      void askPill.offsetWidth; // the nudge plays again
      askPill.setAttribute("data-fresh", "");
      setStatus(`${name} from the Producer`);
    }
  }
  askNewest = items[0]?.text ?? "";
  placePill();
  const was = askShowing;
  askShowing = box;
  askBox.hidden = !box;
  askVeil.hidden = !box;
  if (box) {
    const cur = ask.current;
    const name = ASK_KINDS[cur.kind][1];
    askBox.dataset.kind = cur.kind;
    askBox.setAttribute("aria-label", `${name} from the Producer`);
    askText.textContent = cur.text;
    askDots.replaceChildren(...(items.length > 1 ? items.map((_, i) => {
      const dot = document.createElement("span");
      dot.toggleAttribute("data-on", i === ask.at);
      return dot;
    }) : []));
    askWhere.textContent = items.length > 1 ? `${ask.at + 1} of ${items.length}` : "";
    if (cur.text !== askSaid) {
      askText.scrollTop = 0; // another cue starts at its top; a push that keeps this one keeps the place in it
      setStatus(`${name}: ${cur.text}${items.length > 1 ? `. ${ask.at + 1} of ${items.length}` : ""}`);
    }
    askSaid = cur.text;
  } else askSaid = "";
  // What the veil covers takes no focus or click while the box shows (Tab stays on the box and the control bar).
  for (const covered of [$(".empty"), main, $(".reading-line")]) covered.inert = box;
  if (box && !was) {
    hideHint(); // it sits above the dock and would cover the box's Skip and Use on a phone
    runAuto(); // the scrolling waits while the box shows; Play keeps showing whether auto-scroll is on
    // The box takes the focus however it opened (a live show's by itself too), so Enter means Use and not
    // the button that had it (Disconnect MCP, say).
    askBox.focus({ preventScroll: true });
  } else if (!box && was) {
    runAuto(); // auto-scroll, when it is on, goes on
    // Focus in the box goes off (not to the pill: no ring on it), so Space means auto-scroll again and Enter opens the pill.
    if (askBox.contains(document.activeElement)) document.activeElement.blur();
  }
}

// The pill sits at the end of the reading line where there is room right of the text column, else just
// above the line (over text already read), or low on the right above the control bar when the line is
// dragged too high for that (over text still far off), so it never covers the line being read. On the start screen (a live show set aside) it waits in the top
// corner, clear of the start card.
function placePill() {
  if (askPill.hidden) return;
  const right = main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingInlineEnd);
  const room = document.documentElement.clientWidth - right;
  const above = parseFloat(getComputedStyle(root).getPropertyValue("--line")) - 10 - askPill.offsetHeight;
  askPill.dataset.place = isEmpty() ? "corner" : room >= askPill.offsetWidth + 16 + 12 ? "line" : above >= 8 ? "above" : "low";
}
new ResizeObserver(placePill).observe(main);
window.addEventListener("resize", placePill); // the column keeps its width while the window narrows

function askOpen() {
  ask.open();
  drawAsk();
}
function askUse() { if (ask.use()) drawAsk(); }
function askSkip() { if (ask.skip()) drawAsk(); }

// The box's keys, before the page's own: a clicker's Page Up/Down and the arrows move between the waiting
// cues instead of the sections. Returns true when it took the key.
function askKey(e) {
  if (!askShowing && askPill.hidden) return false;
  if (document.querySelector("dialog[open], :popover-open") || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.target.closest?.("textarea, select, input, .pop")) return false;
  const k = e.key;
  const onButton = Boolean(e.target.closest?.("button, a"));
  if (!askShowing) {
    if (k !== "Enter" || onButton) return false;
    e.preventDefault();
    askOpen();
    return true;
  }
  if (k === "Escape") askSkip();
  else if (k === "ArrowRight" || k === "PageDown") { ask.move(1); drawAsk(); }
  else if (k === "ArrowLeft" || k === "PageUp") { ask.move(-1); drawAsk(); }
  else if (k === "ArrowDown" || k === "ArrowUp") askText.scrollBy({ top: (k === "ArrowDown" ? 0.8 : -0.8) * askText.clientHeight }); // a long cue
  else if (k === "Enter" || k === " ") {
    if (e.target.closest?.(".ask-box button")) return true; // Use and Skip press as buttons do
    if (k === "Enter" && onButton) return true; // a button the person moved to with Tab presses
    // Space on a focused button of the control bar means auto-scroll, as it does without the box (the page's key
    // handler below): Play shows the change and the scrolling still waits for the box.
    if (k === " " && e.target.closest?.(".dock button")) return false;
    if (k === "Enter") askUse();
  } else return true; // the page's own keys (digits, Space, size…) wait while the box shows; the browser's, like Tab, still work
  e.preventDefault();
  return true;
}

askPill.addEventListener("click", askOpen);
// A tap beside the box closes it; the cue waits behind the pill. In a live show that sets it aside, so the
// start screen can be used; the pill (or a new cue) brings it back.
askVeil.addEventListener("click", () => { ask.close(); drawAsk(); });

// The live relay link itself (token, socket, backoff, keepalive, tool calls) is relayLink in src/relay-link.mjs;
// the code below gives it the page's two tools and draws its state. An offline copy (file://) has no relay:
// its Copy MCP copies the open server's message, which answers with a link instead.
const live = /^https?:$/.test(location.protocol);
const liveLink = relayLink({
  WebSocket,
  fetch,
  clock: window,
  store,
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${RELAY_PATH}`,
  tools: {
    get_open_script: () => ({ result: isEmpty() ? { open: false } : { open: true, markdown: scripts.now.text, preset } }),
    async show_script(args) {
      // Opened like a #s= link: its preset, and kept as this browser's last script.
      const text = typeof args.markdown === "string" ? args.markdown : "";
      if (text.length > MAX_SCRIPT_CHARS) return { error: `The script is longer than ${MAX_SCRIPT_CHARS} characters.` };
      const found = parse(text).length;
      if (!found) return { error: "No sections found. Each section starts with a title line like: ### **INTRO · 00:00**" };
      preset = prefs.save("preset", args.preset);
      showAlert("");
      await openScript(text, { label: `Opened from ${agentName(liveLink.info?.name)}`, saved: args.saved });
      return { result: { opened: true, sections: found } }; // this script's, even if another opened while it was packed
    },
    push_suggestions(args) {
      const input = readSuggestions(args);
      if (input.error) return { error: input.error };
      const { used, skipped } = ask.push(input.items, askShowing);
      drawAsk();
      return { result: { shown: askLive(), used, skipped } }; // shown: something waits for the host
    },
    clear_suggestions() {
      const { used, skipped } = ask.clear();
      drawAsk();
      return { result: { used, skipped } };
    },
  },
  changed: () => {
    // Disconnect MCP (or the token's end) also ends the cues: nobody is left to hear what was used.
    if (liveLink.state === "off") ask.clear();
    renderAgent();
    drawAsk();
    tellProducer();
  },
});

// Opened from the Producer (one click sets up both): it tells the Producer page that opened this tab how
// the link is (never the token), so it can say "Connected: Producer + Prompter", and its Disconnect ends
// this tab's link too. Only that page, at its own address, hears it or is heard.
let producerOpener = null;
let toldProducer = "";
function tellProducer() {
  if (!producerOpener && liveLink.producer && window.opener) producerOpener = window.opener;
  if (!producerOpener) return;
  const state = liveLink.state;
  if (state === toldProducer) return;
  toldProducer = state;
  for (const origin of PRODUCER_ORIGINS) {
    try { producerOpener.postMessage({ type: PRODUCER_MESSAGES.link, state }, origin); } catch { /* closed */ }
  }
  if (state === "off") producerOpener = null; // the link ended: the next one starts fresh
}
// A tab the Producer opened to link (`#producer`) says ready to that page and takes the token only from its
// answer, once: never from the address, where a link anyone can send would tie this tab to their agent.
let producerWaiting = false;
window.addEventListener("message", (e) => {
  if (!PRODUCER_ORIGINS.includes(e.origin) || !e.source || e.source !== window.opener) return;
  const type = e.data?.type;
  if (type === PRODUCER_MESSAGES.disconnect) producerWaiting = false; // Disconnect both before the token came: none is taken after
  if (type === PRODUCER_MESSAGES.token && producerWaiting) {
    const token = producerToken(e.data.token);
    if (token) {
      producerWaiting = false;
      liveLink.adopt(token);
    }
  } else if (type === PRODUCER_MESSAGES.disconnect && liveLink.producer && liveLink.state !== "off") liveLink.disconnect();
});
// "Copied" with a check for two seconds after a copy.
const copied = { on: false, timer: 0 };
const prefetchToken = () => { if (live) liveLink.prefetchToken(); };

// The action reads Wait for MCP, Waiting for MCP, Disconnect MCP or Use this tab (Copy MCP offline);
// "Copied" with a check for two seconds after a copy. The Open button shows a dot and names the state.
function renderAgent() {
  const s = liveLink.state;
  const name = agentName(liveLink.info?.name);
  for (const act of document.querySelectorAll(".mcp-action")) {
    act.dataset.state = live ? s : "offline";
    act.toggleAttribute("data-copied", copied.on);
    act.toggleAttribute("data-failed", liveLink.failed && s === "off");
    const label = copied.on ? "Copied"
      : !live ? "Copy MCP"
      : s === "on" ? "Disconnect MCP"
      : s === "elsewhere" ? "Use this tab"
      : s === "waiting" ? "Waiting for MCP"
      : liveLink.failed ? "No connection, try again" : "Wait for MCP";
    // Only a changed label is written: the label is a polite live region.
    const el = act.querySelector(".mcp-label");
    if (el.textContent !== label) el.textContent = label;
  }
  const linked = liveLink.producer && (s === "on" || s === "waiting") ? ", linked to your Producer" : "";
  const where = (s === "on" ? ` · MCP connected to ${name}` : s === "waiting" ? " · waiting for MCP" : s === "elsewhere" ? " · MCP open in another tab" : "") + linked;
  if (s === "on" || s === "waiting") openBtn.dataset.dot = s; else delete openBtn.dataset.dot;
  openBtn.setAttribute("aria-label", `Open${where}`);
  openBtn.dataset.tip = `Open a script${where}`;
}

async function copyPrompt(button, text) {
  const box = button.parentElement.querySelector(".mcp-prompt");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard here: show the message, selected, to copy by hand.
    box.value = text;
    box.hidden = false;
    box.focus();
    box.select();
    return;
  }
  box.hidden = true;
  copied.on = true;
  renderAgent();
  clearTimeout(copied.timer);
  copied.timer = setTimeout(() => { copied.on = false; renderAgent(); }, 2000);
}

async function pressMcp(button) {
  if (!live) { copyPrompt(button, openPrompt(`${SITE}/mcp`, preset)); return; }
  if (liveLink.state === "on") { liveLink.disconnect(); return; }
  if (liveLink.state === "elsewhere") { liveLink.useHere(); return; }
  const token = await liveLink.waitForAgent((busy) => { if (busy) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy"); });
  if (token) copyPrompt(button, connectionPrompt(`${location.origin}/mcp`, token, preset));
}

$("#open-menu").addEventListener("toggle", (e) => {
  if (e.newState === "open") prefetchToken();
  else $("#open-menu .mcp-prompt").hidden = true;
});
const startMcp = $(".empty .mcp-action");
for (const type of ["pointerenter", "focus", "pointerdown"]) startMcp.addEventListener(type, prefetchToken);
// The Producer opened this tab to link it (`#producer`): the mark comes off the address at once, and the tab
// says ready to the page that opened it, at the Producer's addresses only; its token comes back by message.
const fromProducer = /^#producer\b/.test(location.hash);
if (fromProducer) history.replaceState(null, "", plainAddress());
if (live) liveLink.start();
if (live && fromProducer && window.opener) {
  producerWaiting = true;
  for (const origin of PRODUCER_ORIGINS) {
    try { window.opener.postMessage({ type: PRODUCER_MESSAGES.ready }, origin); } catch { /* closed */ }
  }
}
renderAgent();
tellProducer();

// The reading line is dragged anywhere along it (or moved with the keys when focused) to camera height and
// remembered on this device as a share of the window height. It is set on
// :root as --line in px; the page's CSS and `reading` (src/reading-line.mjs: what is at
// the line, bring this to the line) use that one value.
const handle = $(".line-handle");
const LINE_STEPS = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }; // percent
const TAP_SLOP = 8; // px a finger or pen may drift and still tap
const CLICK_SLOP = 2; // the same for a mouse, so it can still move the line a few px
const LINE_KEYS = [...Object.keys(LINE_STEPS), "Home", "End"];
let lineFrac = LINE.fallback;
// Scrolling asks for a look; the frame's one look moves the section, its link and the cues, and
// Follow my voice when a wheel, touch or scroll end asked for it.
const reading = readingLine({
  script: main,
  view: window,
  frame: requestAnimationFrame,
  onLook(at, { voice }) {
    updateActive(at);
    if (voice && voiceOn && !voiceScrolling) voiceFromReadingLine(at.line);
  },
});
let lineDrag = null; // { id, offset, from, start, slop, moved } while a pointer drags the handle
let dragFrame = 0;
let dragY = 0;
let lastTap = -Infinity; // two taps (or clicks) on the handle without a move reset the line

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
  lineFrac = settingValue("line", frac);
  const y = Math.round(viewHeight() * lineFrac);
  const delta = reading.place(y);
  root.style.setProperty("--line", `${y}px`);
  placePill(); // dragged high, the pill goes low
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
  if (save) prefs.save("line", lineFrac);
  followLine();
}

// Mouse, pen and touch drag it the same way; the page does not scroll under a finger (touch-action: none).
handle.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  lineDrag = { id: e.pointerId, offset: e.clientY - reading.y, from: e.clientY, start: lineFrac, slop: e.pointerType === "mouse" ? CLICK_SLOP : TAP_SLOP, moved: false };
  handle.dataset.dragging = "true";
});
// The line lies over the script: a link under it still opens with a click or tap.
const linkUnder = (e) => document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest(".link, .mark, .inlink")).find(Boolean);
handle.addEventListener("pointermove", (e) => {
  if (!lineDrag) { handle.classList.toggle("over-link", Boolean(linkUnder(e))); return; }
  if (lineDrag.id !== e.pointerId) return;
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
  const link = e.type === "pointerup" && linkUnder(e);
  if (link) { lastTap = -Infinity; moveLine(start, true); link.click(); return; }
  // A tap or click keeps the line where it was, unless it is the second one in
  // a row. A cancelled touch (the system took it over) puts it back too.
  const reset = e.type === "pointerup" && e.timeStamp - lastTap < 400;
  lastTap = reset || e.type !== "pointerup" ? -Infinity : e.timeStamp;
  moveLine(reset ? LINE.fallback : start, true);
}
handle.addEventListener("pointerup", endLineDrag);
handle.addEventListener("pointercancel", endLineDrag);
handle.addEventListener("lostpointercapture", endLineDrag); // showStart lets go of it mid-drag
handle.addEventListener("keydown", (e) => {
  if (!LINE_KEYS.includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  const pct = Math.round(lineFrac * 100);
  moveLine(e.key === "Home" ? LINE.min : e.key === "End" ? LINE.max : (pct + LINE_STEPS[e.key]) / 100, true);
});

/** The place under the reading line moved (the line, a section jump, line spacing): all that follows it, from one look. */
function followLine() {
  const at = reading.look();
  updateActive(at); // the page may not have scrolled (at the top), so no scroll event will do it
  if (voiceOn) voiceFromReadingLine(at.line);
}

function updateActive(look = reading.look()) {
  updateCues(look);
  const script = scripts.now;
  const idx = look.section;
  if (idx !== script.active) {
    script.active = idx;
    main.querySelectorAll(".section").forEach((el, i) => el.classList.toggle("active", i === idx));
    updateClock();
  }
  // The most recent link above the reading line goes on the main screen once
  // the reader settles there, so fast scrolling does not flash every link.
  const at = linkAt(script.sections, idx, look.link);
  const key = at ? `${at.s}:${at.l}` : "";
  if (key === script.anchorKey) return;
  script.anchor = at;
  script.anchorKey = key;
  if (at) scripts.settle(() => showLink(at.s, at.l, false), SETTLE_MS); else scripts.unsettle();
}

// A camera cue line that reaches the reading line goes to CamFrame once per
// pass down (auto-scroll, scrolling by hand, Follow my voice and section jumps
// all scroll the page). Failures only change the CamFrame button in Settings.
function updateCues(look) {
  const script = scripts.now;
  if (!script.cues.length) return;
  const now = look.cues;
  // Opening a script, or a cue already passed when the link is turned on, sends nothing.
  if (!script.cueAbove || !cueArmed) { script.cueAbove = new Set(now); return; }
  const { above, send } = cueCrossing(script.cueAbove, now);
  script.cueAbove = above;
  if (send >= 0) camframe.cue(script.cues[send], () => scripts.current(script) && script.cueAbove.has(send));
}

function setCamframeOn(on) {
  camframe.turn(prefs.save("camframe", on));
}

// The CamFrame button says how the link is doing in its name and hover title (no status
// text on screen): blinking orange while looking or reconnecting, lit orange when connected,
// a quiet crossed-out camera when not found. Connected (not after a reconnect) and not
// found are read out once.
const CAMFRAME_SAYS = {
  off: "CamFrame link: off",
  looking: "CamFrame link: looking for CamFrame",
  reconnecting: "CamFrame link: reconnecting",
  on: "CamFrame link: connected",
  lost: "CamFrame link: not found",
};
const CAMFRAME_LOST_HELP = ". Open CamFrame and turn on Prompter link in its Scenes settings. Chrome may ask once to let this page reach apps on this device: allow it.";
function drawCamframe() {
  const was = camframeBtn.dataset.state;
  const name = CAMFRAME_SAYS[camframe.state];
  camframeBtn.dataset.state = camframe.state;
  camframeBtn.setAttribute("aria-pressed", String(camframe.on));
  camframeBtn.setAttribute("aria-label", name);
  camframeBtn.title = camframe.state === "lost" ? name + CAMFRAME_LOST_HELP : name;
  updateSettingsBtn();
  showCueMenu();
  // Not again when it comes back from a missed check or two (reconnecting).
  if (was !== camframe.state && ((camframe.state === "on" && was !== "reconnecting") || camframe.state === "lost")) setStatus(`${name}.`);
}

function connected() { return mainWin && !mainWin.closed; }

// The main screen's button in Settings (orange while connected); the Settings button shows a dot then.
function setConnected(on) {
  connectBtn.dataset.on = String(on);
  const name = on ? "Main screen connected, reconnect" : "Connect main screen";
  connectBtn.setAttribute("aria-label", name);
  connectBtn.title = name;
  updateSettingsBtn();
}

// A dot on the Settings button, and its name, while Follow my voice is on or a main screen is connected.
function updateSettingsBtn() {
  const on = [voiceOn && "Follow my voice on", connectBtn.dataset.on === "true" && "main screen connected", camframe.on && camframe.state === "on" && "CamFrame connected"].filter(Boolean);
  if (on.length) settingsBtn.dataset.dot = "on"; else delete settingsBtn.dataset.dot;
  const label = ["Settings", ...on].join(" · ");
  settingsBtn.setAttribute("aria-label", label);
  settingsBtn.dataset.tip = label;
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
  const { anchor } = scripts.now;
  scripts.now.shownUrl = "";
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
  const script = scripts.now;
  const s = script.sections[si];
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
  if (url !== script.shownUrl || fromUser) {
    try { mainWin.location.href = url; } catch { mainWin = window.open(url, WINDOW_NAME); }
    script.shownUrl = url;
  }
  main.querySelectorAll(".link, .mark, .inlink").forEach((b) => {
    b.dataset.shown = String(screenUrl(script.sections[b.dataset.s].links[b.dataset.l].url) === script.shownUrl);
  });
  setStatus(`On main screen: ${s.links[li].label}`);
}

// Status messages are for screen readers only (the line is visually hidden); errors use showAlert.
// The same message again is cleared first, so it is read out again; a newer message wins.
let statusSeq = 0;
function setStatus(t) {
  const n = ++statusSeq;
  const el = pasteDialog.open ? pasteStatus : statusEl;
  if (t && el.textContent === t) { el.textContent = ""; requestAnimationFrame(() => { if (n === statusSeq) el.textContent = t; }); }
  else el.textContent = t;
}

/** A message that must not be missed (errors). Empty text hides it. */
function showAlert(t) {
  alertEl.hidden = !t;
  $(".alert-text").textContent = t;
}

// Reconnecting to speech: a short note by the reading line, read out once
// through the status line, until hideToast() or words are heard again.
const RECONNECTING = "Reconnecting to speech…";
function showToast(text) {
  toastText.textContent = text;
  toastEl.dataset.show = "true";
  setStatus(text);
}
function hideToast() {
  delete toastEl.dataset.show;
}

// Once per page: a link would have opened by itself, but no main screen is connected.
function showHint(label) {
  if (hintShown || askShowing) return; // never over a Producer's cue box; it may come once the box closes
  hintShown = true;
  $(".hint-text").textContent = `“${label}” would open on your main screen now. Connect a main screen and links open by themselves.`;
  hintEl.hidden = false;
  settingsBtn.dataset.hint = "true";
  hintTimer = setTimeout(hideHint, 15000);
}
function hideHint() {
  clearTimeout(hintTimer);
  hintEl.hidden = true;
  delete settingsBtn.dataset.hint;
}

function lost() { showAlert("Main screen window lost. Connect it again in Settings, or click a link button."); }
function blocked() { showAlert("No window could open. Allow pop-ups for this page."); }

const fmt = (sec) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

function updateClock() {
  if (!clockStart) return;
  const el = Math.floor((Date.now() - clockStart) / 1000);
  clockTime.textContent = fmt(el);
  const { sections, active } = scripts.now;
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

function tick(ts) {
  if (lastFrame) window.scrollBy(0, (speed * (ts - lastFrame)) / 1000);
  lastFrame = ts;
  autoFrame = requestAnimationFrame(tick);
}
// The scrolling runs while auto-scroll is on and the Producer's cue box does not show: the script waits
// for the box. One chain of frames at most, started afresh here, and Play's tip says which it is.
function runAuto() {
  cancelAnimationFrame(autoFrame);
  lastFrame = 0;
  autoFrame = autoOn && !askShowing ? requestAnimationFrame(tick) : 0;
  setAutoTip();
}
function setAuto(on) {
  autoOn = on;
  autoBtn.setAttribute("aria-pressed", String(on));
  runAuto();
}
let autoTipTimer = 0;
// While Follow my voice is on, play is greyed out and its tip says why (no status pops up). While the
// Producer's cue box shows, the tip says what Play's state means after the cue.
function setAutoTip() {
  autoBtn.setAttribute("aria-disabled", String(voiceOn));
  if (!voiceOn) { clearTimeout(autoTipTimer); autoBtn.removeAttribute("data-show-tip"); }
  autoBtn.dataset.tip = voiceOn ? "Auto-scroll is off while Follow my voice is on"
    : askShowing ? (autoOn ? "Auto-scroll waits for the cue · click to turn it off" : "Auto-scroll is off · click to turn it on after the cue")
    : autoOn ? "Pause · Space" : "Auto-scroll · Space";
}
function toggleAuto() {
  if (voiceOn) {
    setStatus("Auto-scroll is off while Follow my voice is on.");
    // Shown on the button for a moment, so a tap on a phone also sees why.
    autoBtn.setAttribute("data-show-tip", "");
    clearTimeout(autoTipTimer);
    autoTipTimer = setTimeout(() => autoBtn.removeAttribute("data-show-tip"), 2000);
    return;
  }
  setAuto(!autoOn);
  // The Producer's cue box shows: the script waits for it, and Play (pressed or not, its icon and its tip)
  // shows what happens when it closes.
  if (askShowing) setStatus(autoOn ? "Auto-scroll goes on when the cue closes." : "Auto-scroll stays off when the cue closes.");
}

// The sliders in Settings: drag them, or type an exact value into their box,
// also past the slider's ends, within the setting's own min and max (the boxes in page.html carry the same).
const showSpeed = rangeField($(".speed-field"), (v) => setSpeed(v));
const showSize = rangeField($(".size-field"), (v) => setSize(v));

function setSpeed(v) {
  speed = prefs.save("speed", v);
  showSpeed(speed);
}

function setSize(px) {
  px = prefs.save("size", px);
  root.style.setProperty("--size", px + "px");
  showSize(px);
}
const curSize = () => parseInt(getComputedStyle(root).getPropertyValue("--size"), 10);

function setWidth(name) {
  const w = prefs.save("width", name);
  root.dataset.width = w;
  widthInputs.forEach((input) => { input.checked = input.value === w; });
}

// Line spacing: more room between the lines; the row at the reading line stays there.
// Only while Follow my voice's own move is in progress (until its scrollend, the reader's wheel or touch, or 2 s if none comes)
// does the line being read go to the reading line instead.
function setSpacing(name) {
  const v = settingValue("spacing", name);
  // With no voice move in progress, keep what is under the reading line, as with Follow my voice off.
  const y = reading.y;
  const cur = voiceOn && voiceScrolling ? main.querySelector("p.cur") : null;
  const lines = [...main.querySelectorAll("p, .mark, .links")];
  // Below the last line (the page scrolls into the bottom padding): hold the last line's distance.
  const keep = cur || lines.find((p) => p.getBoundingClientRect().bottom > y) || lines.at(-1);
  // Where the reading line falls on that line: inside it, a share of its height (its rows grow too);
  // above it (a heading, a link row or a gap, which do not grow), the same distance in pixels.
  const kr = keep?.getBoundingClientRect();
  const dist = kr ? y - kr.top : 0;
  const inside = kr && kr.height > 0 && dist >= 0 && dist <= kr.height;
  const frac = inside ? dist / kr.height : 0;
  root.dataset.spacing = v;
  spacingInputs.forEach((input) => { input.checked = input.value === v; });
  prefs.save("spacing", v); // nothing is stored until the default is left
  // (The voice path scrolls at once, not smoothly: this is a settings change, not a move on.)
  if (cur) reading.bring(cur);
  else if (keep) reading.bring(keep, { at: inside ? frac * keep.getBoundingClientRect().height : dist });
  followLine();
}

function goSection(delta) {
  const els = main.querySelectorAll(".section");
  const target = els[Math.min(els.length - 1, Math.max(0, scripts.now.active + delta))];
  if (!target) return;
  reading.bring(target);
  followLine(); // at once, so quick repeated presses keep moving
}

// The browser's speech recognition turns the voice into words (Chrome sends
// the audio to Google for that, unless it can do it on this device); the
// script itself never leaves the page.
// Scrolled by hand, a section jump or the line moved: follow on from the line
// at the reading line (`k`, from the look), marked there without scrolling. Still on
// the followed line, the place in it is kept.
function voiceFromReadingLine(k) {
  scripts.now.voice = voiceAt(scripts.now.voice, k);
  markLine(k, false);
}

// The line being read is bright; the lines after it a little dimmer (CSS).
// The prompter's own scroll is over at its "scrollend", the reader's wheel or touch, or after 2 s if none comes.
let voiceScrolling = false;
let voiceScrollTimer = 0;
function markLine(k, scroll = true) {
  main.querySelector("p.cur")?.classList.remove("cur");
  const el = main.querySelector(`[data-k="${k}"]`);
  if (!el) return;
  el.classList.add("cur");
  if (!scroll) return;
  voiceScrolling = true;
  clearTimeout(voiceScrollTimer);
  voiceScrollTimer = setTimeout(() => { voiceScrolling = false; }, 2000);
  reading.bring(el, { smooth: !reducedMotion.matches });
}

function setVoiceButton() {
  voiceBtn.setAttribute("aria-pressed", String(voiceOn));
  updateSettingsBtn();
  setAutoTip();
}

function toggleVoice() {
  if (voiceOn) { stopVoice(); setStatus("Follow my voice is off."); return; }
  if (!prefs.read("voiceOk")) {
    hidePopovers(); // the notice shows above the bar, where Settings was
    voiceNotice.hidden = false;
    voiceNotice.querySelector('[data-action="voice-ok"]').focus();
    return;
  }
  startVoice();
}

// Each start is a fresh recognition object (src/speech.mjs keeps them going).
const voiceLang = () => navigator.language || "en-US";
function newRecognition(local) {
  const r = new Recognition();
  r.continuous = true;
  r.interimResults = true;
  r.lang = voiceLang();
  if (local) r.processLocally = true;
  return r;
}
const voiceKeeper = Recognition && speechKeeper({
  make: newRecognition,
  onSession() { scripts.now.voice = voiceSession(scripts.now.voice); voiceHold = voiceHoldSession(voiceHold, performance.now()); }, // a new session numbers its results from 0 again
  onResult: onVoiceResult,
  onReconnecting(on) { if (on) showToast(RECONNECTING); else hideToast(); },
  onLocalFailed() { voiceLocal = false; }, // its language pack went away: ask again next time
  onFatal(error) { stopVoice(VOICE_ERRORS[error] || "Follow my voice stopped. Turn it on again to retry."); },
});

function startVoice() {
  voiceNotice.hidden = true;
  showAlert("");
  voiceOn = true;
  voiceKeeper.start({ local: voiceLocal });
  // On this device where the browser can (no network, so steadier); asked during the
  // click, as installing its language pack needs one. Until then, and otherwise, the
  // browser's own speech service.
  // One question at a time, even when voice is turned off and on quickly.
  if (!voiceLocal) {
    voiceAsking ||= speechOnDevice(Recognition, voiceLang()).finally(() => { voiceAsking = null; });
    voiceAsking.then((local) => { voiceLocal = local; if (voiceOn) voiceKeeper.useLocal(local); });
  }
  scripts.now.voice = voiceStart(reading.look().line);
  resumeAuto = autoOn; // also while it waits for the cue box: back when voice goes off, not when the box closes
  setAuto(false);
  setVoiceButton();
  setStatus("Listening. Read your script out loud.");
}

function stopVoice(message = "") {
  voiceOn = false;
  voiceKeeper?.stop();
  hideToast();
  setVoiceButton();
  main.querySelector("p.cur")?.classList.remove("cur");
  if (message) showAlert(message);
  if (resumeAuto) {
    resumeAuto = false;
    setAuto(true); // while the cue box shows, the scrolling waits for it
  }
}

// Each speech result event goes to voiceStep (src/follow.mjs), which decides where the voice is and
// which link its label opens; the page marks that line and opens that link.
function onVoiceResult(e) {
  const script = scripts.now;
  // While the Producer's cue box shows, the host reads it, not the script: what is heard then, and until
  // the speech pauses after it closes, is never followed; following goes on from the same line after.
  const heard = Array.from(e.results, (r) => ({ transcript: r[0].transcript, isFinal: r.isFinal }));
  const hold = voiceHeld(voiceHold, heard, performance.now(), askShowing);
  if (hold !== voiceHold) { voiceHold = hold; return; }
  const results = voiceUnheld(heard, voiceHold);
  const { voice, line, link } = voiceStep(script.voiceLines, script.voice, results, { links: voiceLinkCandidates(), shownUrl: script.shownUrl });
  script.voice = voice;
  const cur = main.querySelector("p.cur");
  if (line >= 0 && (!cur || Number(cur.dataset.k) !== line)) markLine(line);
  if (!link) return;
  scripts.unsettle();
  showLink(link.s, link.l, false);
}

// Links inside a line are left out: their words are ordinary spoken words, so
// hearing them earlier would open the link early. They open at their line.
function voiceLinkCandidates() {
  const { sections, active } = scripts.now;
  return [active, active + 1].flatMap((si) => (sections[si]?.links || [])
    .flatMap((l, li) => (l.inText ? [] : [{ label: l.label, s: si, l: li, key: `${si}:${li}`, url: screenUrl(l.url) }])));
}

const VOICE_ERRORS = {
  "not-allowed": "The microphone is blocked. Allow it for this page to use Follow my voice.",
  "service-not-allowed": "This browser does not allow speech recognition here. Follow my voice is off.",
  "audio-capture": "No microphone found. Follow my voice is off.",
  network: "Your browser could not reach its speech service. Some browsers (like Vivaldi or Brave) cannot use it; try Chrome or Edge. Follow my voice is off.",
  "language-not-supported": "The browser's speech service does not support your language. Follow my voice is off.",
  "start-failed": "Follow my voice could not start in this browser; try Chrome or Edge. Follow my voice is off.",
};

function publicBase() {
  return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : `${SITE}/`;
}

async function copyText(text, ask) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt(ask, text);
    return false;
  }
}

// Copy link confirms on its own menu item, like Wait for MCP: Copied and a check for 2 seconds.
let linkCopiedTimer = 0;
async function copyLink(button) {
  const { text, saved } = scripts.now; // the script may change while it is packed
  const name = preset;
  const link = `${publicBase()}#s=${await encodeScript(text)}${linkExtras(name, saved)}`;
  if (!(await copyText(link, "Copy this link. The script is inside it:"))) return;
  const label = button.querySelector(".share-label");
  button.setAttribute("data-copied", "");
  label.textContent = "Copied";
  clearTimeout(linkCopiedTimer);
  setStatus("Link copied."); // read out once; the label is only what you see
  linkCopiedTimer = setTimeout(() => { button.removeAttribute("data-copied"); label.textContent = "Copy link"; }, 2000);
}

// The paste window's "Camera cues" list: the cue lines CamFrame can act on (cueChoices in core.mjs,
// the layout Scenes first), only while the link answers; otherwise one line says what to do.
function showCueMenu() {
  const live = camframe.on && (camframe.state === "on" || camframe.state === "reconnecting");
  const pick = pasteDialog.querySelector(".cue-pick");
  const off = pasteDialog.querySelector(".cue-off");
  off.hidden = live;
  off.textContent = camframe.on
    ? "Camera cues show here once CamFrame answers: open CamFrame with its Prompter link on."
    : "Camera cues show here when CamFrame is connected: turn on the camera button in Settings, and open CamFrame with its Prompter link on.";
  // The row may hold the focus when the link drops: the text takes it, so the keyboard is never lost, and the
  // window says why the list went.
  if (!live && !pick.hidden && pasteDialog.open) {
    if (pick.contains(document.activeElement)) $("#paste-text").focus();
    if (camframe.state !== "lost") setStatus(off.textContent); // "not found" is said by the link itself
  }
  pick.hidden = !live;
  const line = pasteDialog.querySelector(".cue-layouts");
  if (!live) { line.hidden = true; const note = $(".paste-error"); if (note.dataset.cue) note.hidden = true; return; } // a note about the list goes with the list
  // Where the two layouts stand in CamFrame, in one line (the window that used to say it is gone). With this
  // window open it is read out each time it settles on new words (not "Saving…"), a moment after the change
  // (so it comes after a link message, though whether a screen reader finishes that one first is untried);
  // with the window closed the Prompter says nothing (a save by itself is quiet).
  // While reconnecting the old words keep their room but cannot be read (the text box below must not jump).
  const words = layoutsLine(camframe.layouts && layoutPlan(camframe.layouts), { saving: camframe.saving, problem: camframe.problem });
  line.textContent = camframe.state === "on" || (camframe.state === "reconnecting" && line.textContent) ? words : "";
  line.style.visibility = camframe.state === "on" ? "" : "hidden";
  line.classList.toggle("error-text", Boolean(line.textContent) && !/^(Camera layouts are saved|Saving)/.test(line.textContent));
  line.hidden = !line.textContent;
  clearTimeout(layoutsSay.timer);
  if (pasteDialog.open && !line.hidden && camframe.state === "on" && !camframe.saving && line.textContent !== layoutsSay.said) {
    layoutsSay.timer = setTimeout(() => {
      if (!pasteDialog.open || line.hidden || camframe.state !== "on" || line.textContent === layoutsSay.said) return;
      layoutsSay.said = line.textContent;
      setStatus(line.textContent);
    }, 600);
  }
  // The layout Scenes first, but only those CamFrame lists: an older CamFrame, or no room, never saved them.
  const scenes = (camframe.layouts ? camframe.layouts.scenes : camframe.scenes).filter((n) => typeof n === "string");
  const choices = cueChoices(scenes, [LAYOUT_LARGE, LAYOUT_SMALL].filter((n) => scenes.some((s) => s.toLowerCase() === n.toLowerCase())));
  const select = pasteDialog.querySelector(".cue-select");
  const key = choices.map((c) => c.text).join("\n");
  if (select.dataset.key === key) return; // a check every 10 s must not reset the choice
  const chosen = select.value;
  select.dataset.key = key;
  // A blank first option: a choice that vanishes from CamFrame never turns into another cue by itself.
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose a cue…";
  select.replaceChildren(blank, ...choices.map((c) => { const o = document.createElement("option"); o.value = c.text; o.textContent = c.label; return o; }));
  select.value = choices.some((c) => c.text === chosen) ? chosen : "";
}

// Puts the chosen cue on its own line at the cursor and says so (`cueInsertion` in core.mjs decides where, by
// the format's own reading: never over a selection, never inside a line, never ahead of a section's links or
// question line). Where the cue would be skipped when the script is read (above the first title, outside the
// start and end markers) nothing is put in and the window says so.
function insertCue() {
  const text = $("#paste-text");
  const cue = pasteDialog.querySelector(".cue-select").value;
  const error = $(".paste-error");
  if (!cue) {
    error.hidden = false;
    error.dataset.cue = "1";
    error.textContent = "Choose a camera cue in the list first.";
    pasteDialog.querySelector(".cue-select").focus(); // so a second try is felt: the list takes the keyboard
    return;
  }
  const place = cueInsertion(text.value, text.selectionEnd, cue);
  if (!place) {
    error.hidden = false;
    error.dataset.cue = "1";
    error.textContent = "Put the cursor under a section title (a line like ### **INTRO · 00:00**) first: a camera cue above the first title, or outside the script's start and end markers, is skipped.";
    text.focus();
    return;
  }
  error.hidden = true;
  delete error.dataset.cue;
  text.focus();
  text.setSelectionRange(place.at, place.at);
  // As typed text, so Undo (Ctrl+Z) takes it back; setRangeText is the fallback.
  if (!document.execCommand("insertText", false, place.insert)) { text.setRangeText(place.insert, place.at, place.at, "end"); text.dispatchEvent(new Event("input", { bubbles: true })); }
  clearTimeout(layoutsSay.timer); // the insert's words must not be overwritten by a line read-out that is due
  setStatus(`Inserted camera cue ${cue}`);
}

// Choosing a cue ends the "choose one" note.
pasteDialog.querySelector(".cue-select").addEventListener("change", () => {
  const note = $(".paste-error");
  if (note.dataset.cue) { note.hidden = true; delete note.dataset.cue; }
});

function openPaste() {
  $(".paste-error").hidden = true;
  pasteStatus.textContent = ""; // the last insert's words are not news again
  showCueMenu();
  showDialog(pasteDialog);
  $("#paste-text").focus();
  layoutsSay.said = ""; // opening the window reads the line once (showCueMenu, after the window has settled)
  showCueMenu();
}

async function submitPaste() {
  const ok = await openScript($("#paste-text").value);
  if (!ok) {
    const err = $(".paste-error");
    err.hidden = false;
    delete err.dataset.cue; // this one stays whatever the list does
    err.textContent = "No sections found. Each section starts with a title line like: ### **INTRO · 00:00**";
    return;
  }
  showAlert("");
  pasteDialog.close();
  setStatus("Opened pasted script"); // after the window: its own status line goes away with it
}

// A file's last-saved time as the day on this device (YYYY-MM-DD). Null when the browser gives none, or only
// "now" (some pickers and cloud files do when they do not know), because the date is never guessed.
function localDay(ms) {
  const d = new Date(ms);
  if (!ms || Number.isNaN(d.getTime()) || Math.abs(Date.now() - ms) < 5000) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_DECODED_BYTES) { showAlert("That file is too large for a script."); return; }
  const saved = localDay(file.lastModified); // read now: a slow file (cloud) can take a while to read
  const newest = scripts.ask();
  const text = await file.text();
  if (!newest()) return; // a newer file, link, script or the start screen came while it was read
  if (await openScript(text, { label: `Loaded ${file.name}`, saved })) showAlert("");
  else showAlert(`No sections found in ${file.name}. Each section starts with a title line like: ### **INTRO · 00:00**`);
}

window.addEventListener("scroll", () => reading.ask(), { passive: true });
for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
  window.addEventListener(type, () => { cueArmed = true; }, { capture: true, passive: true });
}

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
// scrolling is ignored. A wheel or touch move ends the voice move at once.
for (const type of ["wheel", "touchmove", "scrollend"]) {
  window.addEventListener(type, () => {
    if (type === "scrollend" && voiceScrolling) { voiceScrolling = false; clearTimeout(voiceScrollTimer); return; }
    // The reader's own hand takes over: the voice move is over, even if the browser sends no scrollend.
    if (type !== "scrollend") { voiceScrolling = false; clearTimeout(voiceScrollTimer); }
    if (voiceOn && !voiceScrolling) reading.ask({ voice: true });
  }, { passive: true });
}
clockBtn.addEventListener("click", startClock);
autoBtn.addEventListener("click", toggleAuto);
// The button shows whether it is on; the first turn-on waits for the notice's Turn on.
voiceBtn.addEventListener("click", toggleVoice);
$(".prev").addEventListener("click", () => goSection(-1));
$(".next").addEventListener("click", () => goSection(1));
widthInputs.forEach((input) => input.addEventListener("change", () => setWidth(input.value)));
spacingInputs.forEach((input) => input.addEventListener("change", () => setSpacing(input.value)));
camframeBtn.addEventListener("click", () => setCamframeOn(!camframe.on));
$("#settings").addEventListener("toggle", (e) => { if (e.newState === "open") camframe.check(); });
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
const KEEP_OPEN = new Set(["mcp", "connect", "copy-link"]);
document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-action]");
  const action = button?.dataset.action;
  if (!action) return;
  if (button.closest(".pop") && !KEEP_OPEN.has(action)) hidePopovers(); // these confirm in place
  if (action === "open-file") fileInput.click();
  else if (action === "paste") openPaste();
  else if (action === "open-paste") submitPaste();
  else if (action === "insert-cue") insertCue();
  else if (action === "close-dialog") button.closest("dialog").close();
  else if (action === "copy-link") copyLink(button);
  else if (action === "start") { showAlert(""); history.pushState(null, "", plainAddress()); showStart(); }
  else if (action === "demo") { showAlert(""); openDemo(); }
  else if (action === "continue") { showAlert(""); openScript(store.get(LAST_KEY) || "", { label: "Your last script", saved: store.get(LAST_SAVED_KEY) }); }
  else if (action === "mcp") pressMcp(button);
  else if (action === "dismiss") showAlert("");
  else if (action === "connect") connect();
  else if (action === "hint-ok") hideHint();
  else if (action === "voice-ok") { prefs.save("voiceOk", true); startVoice(); }
  else if (action === "voice-cancel") { voiceNotice.hidden = true; }
  else if (action === "ask-use") askUse();
  else if (action === "ask-skip") askSkip();
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
  if (askKey(e)) return; // the Producer's cue box, open or waiting, takes its keys first
  if (isEmpty() || document.querySelector("dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest("textarea, select, input:not([type=range])")) return;
  const k = e.key;
  // A focused slider keeps its arrow keys; every other shortcut still works.
  if (e.target.matches?.("input[type=range]") && k.startsWith("Arrow")) return;
  // The focused reading line keeps its keys (arrows, Page Up/Down, Home, End).
  if (e.target.closest(".line-handle") && LINE_KEYS.includes(k)) return;
  // Space on these buttons (and the Producer's cue pill, and Use and Skip in its box) presses them; on the control bar and the links it still means auto-scroll.
  if (k === " " && e.target.closest(".note-row, .pop, .ask-box, .ask-pill")) return;
  if (k === " ") { e.preventDefault(); toggleAuto(); }
  else if (k === "ArrowRight" || k === "PageDown") { e.preventDefault(); goSection(1); }
  else if (k === "ArrowLeft" || k === "PageUp") { e.preventDefault(); goSection(-1); }
  else if (k === "+" || k === "=") setSize(curSize() + 4);
  else if (k === "-" || k === "_") setSize(curSize() - 4);
  else if (k === "]" || k === "[") setSpeed(speed + (k === "]" ? 10 : -10));
  else if (k === "f" || k === "F") {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
  }
  else if (/^[1-9]$/.test(k)) showLink(scripts.now.active, Number(k) - 1, true);
});

voiceBtn.hidden = !Recognition;
setLine(prefs.read("line"));
setSpeed(speed);
setSize(prefs.read("size"));
setWidth(prefs.read("width"));
setSpacing(prefs.read("spacing"));
camframe.turn(prefs.read("camframe"));
route();
