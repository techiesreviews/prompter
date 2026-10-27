// Page logic. scripts/build.mjs inlines src/core.mjs above this file inside one
// function, so parse, check, PRESETS, encodeScript … are in scope here.

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
const homeEl = $("#home");
const prompterEl = $("#prompter");
const main = $(".script");
const statusEl = $(".status");
const clockEl = $(".clock");
const connectBtn = $(".connect");
const autoBtn = $(".auto");
const problemsBtn = $(".problems-btn");
const dialog = $("dialog.problems");
const homeError = $(".home-error");
const WINDOW_NAME = "prompter-main-screen";
const SETTLE_MS = 700; // wait this long on a section before changing the main screen
const LAST_KEY = "prompter-last-script";
const PRESET_KEY = "prompter-preset";

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
let clockStart = 0;
let autoOn = false;
let speed = Number(store.get("prompter-speed")) || 40;
let lastFrame = 0;
let view = "home";

// ---------- Views ----------
function showView(name) {
  view = name;
  document.body.dataset.view = name;
  homeEl.hidden = name !== "home";
  prompterEl.hidden = name !== "prompter";
  if (name !== "prompter") setAuto(false);
}

function showHome(error = "") {
  showView("home");
  homeError.hidden = !error;
  homeError.textContent = error;
  presetTabs($(".tabs[role=tablist]"), renderPresetDocs);
  renderPresetDocs();
  const last = store.get(LAST_KEY);
  const lastBtn = $('[data-action="last"]');
  lastBtn.hidden = !last;
  if (last) {
    const parsed = parse(last);
    lastBtn.textContent = parsed.length ? `Continue: ${parsed[0].title}${parsed.length > 1 ? " …" : ""}` : "Continue last script";
  }
  window.scrollTo(0, 0);
}

/** Open a script in the prompter. `fromLink` keeps the current #s= fragment. */
async function openScript(text, { fromLink = false, label = "" } = {}) {
  const parsed = parse(text);
  if (!parsed.length) {
    showHome("No sections found. Each section starts with a title line like: ### **INTRO · 00:00**");
    return;
  }
  scriptText = text;
  sections = parsed;
  store.set(LAST_KEY, text);
  showView("prompter");
  window.scrollTo(0, 0);
  render();
  updateProblemCount();
  setStatus(label);
  if (!fromLink) {
    try {
      const data = await encodeScript(text);
      history.replaceState(null, "", `#s=${data}${preset === "default" ? "" : `&p=${preset}`}`);
    } catch { /* the link is a convenience; the prompter works without it */ }
  }
}

async function route() {
  const hash = location.hash;
  if (hash.startsWith("#s=") || hash.includes("&s=")) {
    const { data, preset: p } = readHash(hash);
    preset = p || "default"; // a link without &p= was made for the default preset
    store.set(PRESET_KEY, preset);
    try {
      await openScript(await decodeScript(data || ""), { fromLink: true, label: "Opened from link" });
    } catch (error) {
      showHome(`This link could not be opened: ${error.message}`);
    }
    return;
  }
  const embedded = parse($("#script-md").textContent);
  if (embedded.length) {
    await openScript($("#script-md").textContent, { fromLink: true });
    return;
  }
  showHome();
}

// ---------- Rendering ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lead = (s) => esc(s).replace(/^([^:]{1,12}:)/, "<b>$1</b>");

function render() {
  main.innerHTML = sections.map((s, i) => {
    const links = s.links.length
      ? `<div class="links">${s.links.map((l, j) =>
          `<button class="link" type="button" data-s="${i}" data-l="${j}">${j < 9 ? `${j + 1} · ` : ""}${esc(l.label)}<small>${esc(hostOf(l.url) || l.url)}</small></button>`).join("")}</div>`
      : "";
    // The QL main question is read silently: always show it at the top.
    const qls = s.items.filter((it) => it.type === "ql")
      .map((it) => `<p class="ql"><small>Main question · answer it, don't read it</small>${esc(it.text)}</p>`).join("");
    const rest = s.items.filter((it) => it.type !== "ql");
    while (rest[0]?.type === "gap") rest.shift();
    const items = rest.map((it) => {
      if (it.type === "gap") return `<div class="gap"></div>`;
      if (it.type === "next" || it.type === "now") return `<p class="${it.type}">${lead(it.text)}</p>`;
      return `<p class="${it.type}">${esc(it.text)}</p>`;
    }).join("");
    return `<section class="section" data-i="${i}"><h2 class="title"><span>${esc(s.title)}</span><span class="time">${esc(s.time)}</span></h2>${links}${qls}${items}</section>`;
  }).join("");
  active = -1;
  shownUrl = "";
  updateActive();
}

// ---------- Active section ----------
function readingLineY() { return window.innerHeight * 0.34; }

function updateActive() {
  if (view !== "prompter") return;
  const els = main.querySelectorAll(".section");
  const y = readingLineY();
  let idx = 0;
  els.forEach((el, i) => { if (el.getBoundingClientRect().top <= y + 4) idx = i; });
  if (idx === active) return;
  active = idx;
  els.forEach((el, i) => el.classList.toggle("active", i === idx));
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => showLink(active, 0, false), SETTLE_MS);
  updateClock();
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
      mainWin.document.body.style.cssText = "margin:0;display:grid;place-items:center;height:100vh;background:#0d1020;color:#f4f1ea;font:600 32px system-ui;text-align:center;padding:0 5vw";
      mainWin.document.body.textContent = "Drag this window to your main screen and make it full size. Pages will open here.";
    }
  } catch { /* already showing another site; fine */ }
  setConnected(true);
  setStatus("");
  shownUrl = "";
  showLink(active, 0, false);
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
  main.querySelectorAll(".link").forEach((b) => {
    b.dataset.shown = String(screenUrl(sections[b.dataset.s].links[b.dataset.l].url) === shownUrl);
  });
  statusEl.style.color = "";
  setStatus(`On main screen: ${s.links[li].label}`);
}

function setStatus(t) { statusEl.textContent = t; }

function lost() {
  setStatus("Main screen window lost. Click “Connect main screen” or a link button.");
  statusEl.style.color = "var(--accent)";
}

function blocked() {
  setStatus("No window could open. Allow pop-ups for this page.");
  statusEl.style.color = "var(--accent)";
}

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
  autoBtn.textContent = `Auto-scroll: ${on ? speed + " px/s" : "off"}`;
  if (on) requestAnimationFrame(tick);
}

// ---------- Text size ----------
function setSize(px) {
  px = Math.min(110, Math.max(20, px));
  document.documentElement.style.setProperty("--size", px + "px");
  store.set("prompter-size", px);
}
setSize(Number(store.get("prompter-size")) || (window.innerWidth < 640 ? 32 : 52));
const curSize = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue("--size"), 10);

function goSection(delta) {
  const els = main.querySelectorAll(".section");
  const target = els[Math.min(els.length - 1, Math.max(0, active + delta))];
  if (!target) return;
  window.scrollTo({ top: target.offsetTop - readingLineY() + 2 });
  updateActive(); // at once, so quick repeated presses keep moving
}

// ---------- Presets: docs and checker ----------
function presetTabs(container, onPick) {
  container.innerHTML = Object.values(PRESETS).map((p) =>
    `<button class="btn" type="button" role="tab" data-preset="${p.name}" aria-selected="${p.name === preset}">${esc(p.label)}</button>`).join("");
  container.onclick = (e) => {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    preset = b.dataset.preset;
    store.set(PRESET_KEY, preset);
    // Keep the link's &p= in step, so Back or reload restores this choice.
    const { data } = readHash(location.hash);
    if (data) history.replaceState(null, "", `#s=${data}${preset === "default" ? "" : `&p=${preset}`}`);
    container.querySelectorAll("[data-preset]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    onPick();
  };
}

function renderPresetDocs() {
  const p = PRESETS[preset];
  $(".preset-rules").innerHTML = `<p>${esc(p.summary)}</p><ul>${p.rules.map((r) =>
    `<li>${esc(r).replace(/`([^`]+)`/g, "<code>$1</code>")}</li>`).join("")}</ul>`;
}

function renderProblems() {
  const result = check(scriptText, preset);
  $(".problem-list").innerHTML = result.problems.length
    ? `<p>${result.errors} error(s), ${result.warnings} warning(s) with the ${esc(PRESETS[preset].label)} style.</p><ul>${result.problems.map((p) =>
        `<li class="sev-${p.severity}">${p.line ? `Line ${p.line}: ` : ""}${esc(p.message)}</li>`).join("")}</ul>`
    : `<p>No problems with the ${esc(PRESETS[preset].label)} style.</p>`;
  updateProblemCount(result);
}

function updateProblemCount(result = check(scriptText, preset)) {
  problemsBtn.dataset.count = String(result.problems.length);
  problemsBtn.title = `${result.errors} error(s), ${result.warnings} warning(s) with the ${PRESETS[preset].label} style`;
}

function publicBase() {
  return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : `${SITE}/`;
}

async function copyLink() {
  const link = `${publicBase()}#s=${await encodeScript(scriptText)}${preset === "default" ? "" : `&p=${preset}`}`;
  try {
    await navigator.clipboard.writeText(link);
    setStatus("Link copied. The script is inside the link.");
  } catch {
    window.prompt("Copy this link. The script is inside it:", link);
  }
}

// ---------- Loading ----------
async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_DECODED_BYTES) { showHome("That file is too large for a script."); return; }
  await openScript(await file.text(), { label: `Loaded ${file.name}` });
}

// ---------- Events ----------
window.addEventListener("scroll", () => requestAnimationFrame(updateActive), { passive: true });
window.addEventListener("resize", updateActive);
connectBtn.addEventListener("click", connect);
$(".start").addEventListener("click", (e) => {
  clockStart = Date.now(); e.target.textContent = "Restart clock"; updateClock();
});
autoBtn.addEventListener("click", () => setAuto(!autoOn));
$(".smaller").addEventListener("click", () => setSize(curSize() - 4));
$(".bigger").addEventListener("click", () => setSize(curSize() + 4));
$(".share").addEventListener("click", copyLink);
problemsBtn.addEventListener("click", () => {
  presetTabs($(".problem-tabs"), renderProblems);
  renderProblems();
  dialog.showModal();
});
main.addEventListener("click", (e) => {
  const b = e.target.closest(".link");
  if (b) showLink(Number(b.dataset.s), Number(b.dataset.l), true);
});
document.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "home") {
    history.pushState(null, "", location.pathname + location.search);
    showHome();
  } else if (action === "paste") {
    $(".paste-box").hidden = false;
    $("#paste-text").focus();
  } else if (action === "open-paste") {
    openScript($("#paste-text").value, { label: "Opened pasted script" });
  } else if (action === "sample") {
    openScript(EXAMPLE_SCRIPT, { label: "Example script" });
  } else if (action === "last") {
    openScript(store.get(LAST_KEY) || "", { label: "Last script" });
  } else if (action === "close-problems") {
    dialog.close();
  }
});
document.querySelectorAll(".file-input").forEach((input) => input.addEventListener("change", (e) => {
  loadFile(e.target.files[0]);
  e.target.value = "";
}));
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
window.addEventListener("popstate", () => { if (!location.hash) showHome(); else route(); });
document.addEventListener("keydown", (e) => {
  if (view !== "prompter" || dialog.open || e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); setAuto(!autoOn); }
  else if (k === "ArrowRight" || k === "PageDown") { e.preventDefault(); goSection(1); }
  else if (k === "ArrowLeft" || k === "PageUp") { e.preventDefault(); goSection(-1); }
  else if (k === "+" || k === "=") setSize(curSize() + 4);
  else if (k === "-" || k === "_") setSize(curSize() - 4);
  else if (k === "]" || k === "[") {
    speed = Math.min(300, Math.max(10, speed + (k === "]" ? 10 : -10)));
    store.set("prompter-speed", speed);
    setAuto(autoOn);
  }
  else if (k === "f" || k === "F") {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
  }
  else if (/^[1-9]$/.test(k)) showLink(active, Number(k) - 1, true);
});

// ---------- Start ----------
$(".format-rows").innerHTML = FORMAT.map((f) => `<tr><td><code>${esc(f.syntax)}</code></td><td>${esc(f.meaning)}</td></tr>`).join("");
if (/^https?:$/.test(location.protocol)) {
  const mcp = `${location.origin}/mcp`;
  $(".mcp-url").textContent = mcp;
  document.querySelectorAll(".mcp-snippet").forEach((el) => { el.textContent = el.textContent.replaceAll(`${SITE}/mcp`, mcp); });
}
route();
