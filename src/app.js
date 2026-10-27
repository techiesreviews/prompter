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

const $ = (sel) => document.querySelector(sel);
const bar = $(".bar");
const main = $(".script");
const statusEl = $(".status");
const clockEl = $(".clock");
const connectBtn = $(".connect");
const autoBtn = $(".auto");
const voiceBtn = $(".voice");
const voiceNotice = $(".voice-notice");
const alertEl = $(".note-row.alert");
const hintEl = $(".screen-hint");
const openMenu = $(".open-menu");
const pasteDialog = $(".paste-dialog");
const speedInput = $(".speed");
const sizeInput = $(".size");
const widthSelect = $(".width");
const WINDOW_NAME = "prompter-main-screen";
const SETTLE_MS = 700; // wait this long on a section before changing the main screen
const LAST_KEY = "prompter-last-script";
const PRESET_KEY = "prompter-preset";
const VOICE_OK_KEY = "prompter-voice-ok";
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

const isDemo = () => scriptText === DEMO_SCRIPT;
const mcpUrl = () => (/^https?:$/.test(location.protocol) ? `${location.origin}/mcp` : `${SITE}/mcp`);

// ---------- Opening scripts ----------
/**
 * Show a script. `fromLink` keeps the current address (a #s= link, the demo or
 * an embedded copy); otherwise the address gets the script's #s= link.
 * `remember` keeps it as this browser's last script. Returns false if empty.
 */
async function openScript(text, { fromLink = false, remember = true, label = "" } = {}) {
  const parsed = parse(text);
  if (!parsed.length) return false;
  if (voiceOn) stopVoice();
  scriptText = text;
  sections = parsed;
  if (remember) store.set(LAST_KEY, text);
  window.scrollTo(0, 0);
  render();
  setStatus(label);
  if (!fromLink) {
    try {
      const data = await encodeScript(text);
      history.replaceState(null, "", `#s=${data}${preset === "default" ? "" : `&p=${preset}`}`);
    } catch { /* the link is a convenience; the prompter works without it */ }
  }
  return true;
}

function openDemo(label = "", { forget = false } = {}) {
  if (forget) store.set(LAST_KEY, "");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return openScript(DEMO_SCRIPT, { fromLink: true, remember: false, label });
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
      await openDemo("");
      showAlert(`This link could not be opened: ${error.message}`);
      return;
    }
    if (!(await openScript(text, { fromLink: true, label: "Opened from link" }))) {
      await openDemo("");
      showAlert("This link has no sections. Each section starts with a title line like: ### **INTRO · 00:00**");
    }
    return;
  }
  const embedded = $("#script-md").textContent;
  if (parse(embedded).length) {
    await openScript(embedded, { fromLink: true, remember: false });
    return;
  }
  const last = store.get(LAST_KEY);
  if (last && last !== DEMO_SCRIPT && await openScript(last, { label: "Your last script · Open › Back to the demo" })) return;
  await openDemo();
}

// ---------- Rendering ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lead = (s) => esc(s).replace(/^([^:]{1,12}:)/, "<b>$1</b>");
const SPOKEN = new Set(["say", "bullet", "next", "now"]);
const FILE_ACCEPT = ".md,.markdown,.txt,text/markdown,text/plain";

function demoActions(items) {
  const html = items.map((it) => {
    const action = DEMO_ACTIONS[it.text];
    if (action === "open-file") return `<label class="btn primary">${esc(it.text)}<input class="file-input" type="file" accept="${FILE_ACCEPT}"></label>`;
    if (action === "drop-hint") return `<span class="drop-hint">or ${esc(it.text.toLowerCase())}</span>`;
    if (action === "ai") return `<button class="btn" type="button" data-action="ai" aria-expanded="false" aria-controls="ai-slot">${esc(it.text)}</button>`;
    return `<button class="btn" type="button" data-action="${action}">${esc(it.text)}</button>`;
  }).join("");
  return `<div class="actions">${html}</div><div class="ai-slot" id="ai-slot" hidden></div>`;
}

// A link placed mid-section: a small marker at its line, not a spoken line.
const mark = (l, i, j) =>
  `<button class="mark" type="button" data-s="${i}" data-l="${j}" title="Opens on the main screen when it reaches the reading line">↗ ${esc(l.label)}<span class="mark-note"> · opens here</span></button>`;

function render() {
  voiceLines = [];
  const demo = isDemo();
  main.innerHTML = sections.map((s, i) => {
    const links = s.links.length
      ? `<div class="links">${s.links.map((l, j) =>
          `<button class="link" type="button" data-s="${i}" data-l="${j}">${j < 9 ? `${j + 1} · ` : ""}${esc(l.label)}<small>${esc(hostOf(l.url) || l.url)}</small></button>`).join("")}</div>`
      : "";
    // The QL main question is read silently: always show it at the top.
    const qls = s.items.filter((it) => it.type === "ql")
      .map((it) => `<p class="ql"><small>Main question · answer it, don't read it</small>${esc(it.text)}</p>`).join("");
    // Items in order, with each inline link's marker just before items[at].
    const marksAt = (n) => s.links.flatMap((l, j) => (l.inline && l.at === n ? [{ type: "mark", l, j }] : []));
    let rest = s.items.flatMap((it, n) => [...marksAt(n), it]).concat(marksAt(s.items.length))
      .filter((it) => it.type !== "ql");
    let actions = "";
    if (demo && i === 0) {
      const isAction = (it) => it.type === "bullet" && DEMO_ACTIONS[it.text];
      actions = demoActions(rest.filter(isAction));
      rest = rest.filter((it) => !isAction(it));
    }
    while (rest[0]?.type === "gap") rest.shift();
    const items = rest.map((it) => {
      if (it.type === "gap") return `<div class="gap"></div>`;
      if (it.type === "mark") return mark(it.l, i, it.j);
      const k = SPOKEN.has(it.type) ? ` data-k="${voiceLines.push(speechWords(it.text)) - 1}"` : "";
      if (it.type === "next" || it.type === "now") return `<p class="${it.type}"${k}>${lead(it.text)}</p>`;
      return `<p class="${it.type}"${k}>${esc(it.text)}</p>`;
    }).join("");
    return `<section class="section" data-i="${i}"><h2 class="title"><span>${esc(s.title)}</span><span class="time">${esc(s.time)}</span></h2>${links}${qls}${actions}${items}</section>`;
  }).join("");
  active = -1;
  shownUrl = "";
  anchor = null;
  anchorKey = "";
  voiceLinkKey = "";
  clearTimeout(settleTimer);
  voiceAt = -1;
  updateActive();
}

function toggleAiPanel(button) {
  const slot = main.querySelector(".ai-slot");
  if (!slot) return;
  if (!slot.firstElementChild) {
    slot.append($("#ai-template").content.cloneNode(true));
    slot.querySelector(".mcp-url").textContent = mcpUrl();
    slot.querySelectorAll(".mcp-snippet").forEach((el) => { el.textContent = el.textContent.replaceAll(`${SITE}/mcp`, mcpUrl()); });
  }
  slot.hidden = !slot.hidden;
  button.setAttribute("aria-expanded", String(!slot.hidden));
}

// ---------- Active section ----------
function readingLineY() { return window.innerHeight * 0.34; }

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
  els[idx]?.querySelectorAll(".mark").forEach((el) => { if (el.getBoundingClientRect().top <= y + 4) reached = Number(el.dataset.l); });
  const at = linkAt(sections, idx, reached);
  const key = at ? `${at.s}:${at.l}` : "";
  if (key === anchorKey) return;
  anchor = at;
  anchorKey = key;
  voiceLinkKey = ""; // the reading point moved on: a label heard again opens again
  clearTimeout(settleTimer);
  if (at) settleTimer = setTimeout(() => showLink(at.s, at.l, false), SETTLE_MS);
}

// ---------- Main screen ----------
function connected() { return mainWin && !mainWin.closed; }

function setConnected(on) {
  connectBtn.dataset.on = String(on);
  connectBtn.textContent = on ? "Main screen connected" : "Connect main screen";
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
  main.querySelectorAll(".link, .mark").forEach((b) => {
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

function lost() { showAlert("Main screen window lost. Click “Connect main screen” or a link button."); }
function blocked() { showAlert("No window could open. Allow pop-ups for this page."); }

// ---------- Clock ----------
const fmt = (sec) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

function updateClock() {
  if (!clockStart) return;
  const el = Math.floor((Date.now() - clockStart) / 1000);
  clockEl.textContent = fmt(el);
  const next = sections.slice(active + 1).find((s) => s.time);
  clockEl.dataset.late = String(Boolean(next && el > toSeconds(next.time)));
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
  if (on) requestAnimationFrame(tick);
}
function toggleAuto() {
  if (voiceOn) { setStatus("Auto-scroll is paused while Follow my voice is on."); return; }
  setAuto(!autoOn);
}

function setSpeed(v) {
  speed = Math.min(300, Math.max(10, Math.round(v / 10) * 10 || 40));
  speedInput.value = speed;
  store.set("prompter-speed", speed);
}

// ---------- Text size and column ----------
function setSize(px) {
  px = Math.min(110, Math.max(20, Math.round(px) || 52));
  document.documentElement.style.setProperty("--size", px + "px");
  sizeInput.value = px;
  store.set("prompter-size", px);
}
const curSize = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue("--size"), 10);

function setWidth(name) {
  const w = WIDTHS.includes(name) ? name : "full";
  document.documentElement.dataset.width = w;
  widthSelect.value = w;
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
  // same label heard again is skipped while the main screen still shows it.
  const said = heardLink(voiceLinkCandidates(), heard);
  if (said && !(said.key === voiceLinkKey && screenUrl(sections[said.s].links[said.l].url) === shownUrl)) {
    voiceLinkKey = said.key;
    clearTimeout(settleTimer);
    showLink(said.s, said.l, false);
  }
}

function voiceLinkCandidates() {
  return [active, active + 1].flatMap((si) => (sections[si]?.links || []).map((l, li) => ({ label: l.label, s: si, l: li, key: `${si}:${li}` })));
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
  openMenu.open = false;
  $(".paste-error").hidden = true;
  pasteDialog.showModal();
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
  openMenu.open = false;
  if (file.size > MAX_DECODED_BYTES) { showAlert("That file is too large for a script."); return; }
  if (await openScript(await file.text(), { label: `Loaded ${file.name}` })) showAlert("");
  else showAlert(`No sections found in ${file.name}. Each section starts with a title line like: ### **INTRO · 00:00**`);
}

// ---------- Events ----------
window.addEventListener("scroll", () => requestAnimationFrame(updateActive), { passive: true });
window.addEventListener("resize", updateActive);
// Scrolling by hand while following the voice: continue from where the reader looks.
// Keyboard and scrollbar scrolling end in "scrollend"; the prompter's own voice
// scrolling is ignored.
for (const type of ["wheel", "touchmove", "scrollend"]) {
  window.addEventListener(type, () => {
    if (voiceOn && !voiceScrolling) requestAnimationFrame(() => { voiceAt = lineAtReadingLine(); });
  }, { passive: true });
}
connectBtn.addEventListener("click", connect);
$(".start").addEventListener("click", (e) => {
  clockStart = Date.now(); e.target.textContent = "Restart clock"; clockEl.dataset.running = "true"; updateClock();
});
autoBtn.addEventListener("click", toggleAuto);
voiceBtn.addEventListener("click", toggleVoice);
speedInput.addEventListener("input", () => setSpeed(Number(speedInput.value)));
sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));
widthSelect.addEventListener("change", () => setWidth(widthSelect.value));
$(".share").addEventListener("click", copyLink);
$(".more-btn").addEventListener("click", (e) => {
  const open = bar.dataset.more !== "true";
  bar.dataset.more = String(open);
  e.currentTarget.setAttribute("aria-expanded", String(open));
});
main.addEventListener("click", (e) => {
  const b = e.target.closest(".link, .mark");
  if (b) showLink(Number(b.dataset.s), Number(b.dataset.l), true);
});
document.addEventListener("click", (e) => {
  if (openMenu.open && !e.target.closest(".open-menu")) openMenu.open = false;
  const button = e.target.closest("[data-action]");
  const action = button?.dataset.action;
  if (action === "paste") openPaste();
  else if (action === "open-paste") submitPaste();
  else if (action === "close-paste") pasteDialog.close();
  else if (action === "demo") { openMenu.open = false; showAlert(""); openDemo("", { forget: true }); }
  else if (action === "ai") toggleAiPanel(button);
  else if (action === "copy-mcp") copyText(mcpUrl(), "Server address copied.", "Copy the server address:");
  else if (action === "dismiss") showAlert("");
  else if (action === "connect") connect();
  else if (action === "hint-ok") hideHint();
  else if (action === "voice-ok") { store.set(VOICE_OK_KEY, "yes"); startVoice(); }
  else if (action === "voice-cancel") { voiceNotice.hidden = true; }
});
// File inputs live in the toolbar menu and in the demo, which is re-rendered.
document.addEventListener("change", (e) => {
  if (!e.target.matches(".file-input")) return;
  loadFile(e.target.files[0]);
  e.target.value = "";
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
// Back to an entry without a script link shows the demo; the remembered script
// is only for the first page load.
window.addEventListener("popstate", () => { if (location.hash) route(); else { showAlert(""); openDemo(); } });
document.addEventListener("keydown", (e) => {
  if (pasteDialog.open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest("textarea, select, input:not([type=range])")) return;
  const k = e.key;
  // A focused slider keeps its arrow keys; every other shortcut still works.
  if (e.target.matches?.("input[type=range]") && k.startsWith("Arrow")) return;
  if (k === "Escape" && openMenu.open) { openMenu.open = false; return; }
  // Space on these buttons presses them; on the toolbar toggles it still means auto-scroll.
  if (k === " " && e.target.closest(".note-row, .menu, .actions, .ai-panel, summary")) return;
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
setSpeed(speed);
setSize(Number(store.get("prompter-size")) || (window.innerWidth < 640 ? 32 : 52));
setWidth(store.get("prompter-width") || "full");
route();
