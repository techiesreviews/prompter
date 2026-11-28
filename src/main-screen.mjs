// The main screen's rules that need no browser (TOOLS-492): which sites cut the main screen off,
// and where a new main screen window goes. The page inlines this file at build time, so it stays
// import-free and uses only `export function` / `export const`.

/**
 * Sites known to cut the main screen off from the Prompter as their page loads
 * (Cross-Origin-Opener-Policy). Their links open in a window of their own, so the main screen stays
 * connected. The Dutch Data Protection Authority is known from the start; others are remembered on
 * the device the first time they cut it off.
 */
export const CUT_SITES_BUILT_IN = ["autoriteitpersoonsgegevens.nl"];

/** At most this many remembered sites; the oldest goes first. */
export const CUT_SITES_MAX = 50;

/** A site as it is remembered: its host name in lower case, without a leading "www.". */
export function cutSite(host) {
  return String(host || "").trim().toLowerCase().replace(/^www\./, "");
}

/** The remembered sites from what the device kept: a list of host names, never anything else. */
export function readCutSites(raw) {
  try {
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) ? [...new Set(list.filter((h) => typeof h === "string").map(cutSite).filter(Boolean))].slice(-CUT_SITES_MAX) : [];
  } catch { return []; }
}

/** The remembered sites with `host` added (last, so it goes last), or the same list when it is known or empty. */
export function rememberCutSite(list, host) {
  const site = cutSite(host);
  if (!site || list.includes(site) || CUT_SITES_BUILT_IN.includes(site)) return list;
  return [...list, site].slice(-CUT_SITES_MAX);
}

/**
 * The remembered sites without the ones that sent `host` to a window of its own (the site itself, or
 * a site it is a subdomain of), or the same list when none did. A site comes off the list when its
 * own window stayed connected (so it did not cut it off: the window had only been closed); the
 * built-in sites never come off. A site where only some pages cut it off can go on and off the list
 * this way; that is rare, and each time costs one cut-off main screen.
 */
export function forgetCutSite(list, host) {
  const site = cutSite(host);
  if (!site) return list;
  const kept = list.filter((known) => site !== known && !site.endsWith(`.${known}`));
  return kept.length === list.length ? list : kept;
}

/** Whether a link on `host` cuts the main screen off: a known site or a subdomain of one. */
export function cutsMainScreen(list, host) {
  const site = cutSite(host);
  if (!site) return false;
  return [...CUT_SITES_BUILT_IN, ...list].some((known) => site === known || site.endsWith(`.${known}`));
}

/**
 * Where a new main screen window goes: the whole free area of a screen other than the one the
 * Prompter is on (the primary one first), or null with one screen or no screen details.
 * `screens` and `current` are the browser's ScreenDetails `screens` and `currentScreen` (the
 * current one is one of the list); each has availLeft, availTop, availWidth, availHeight, isPrimary.
 */
export function mainScreenArea(screens, current) {
  const others = (screens || []).filter((s) => s && s !== current);
  if (!others.length) return null;
  const s = others.find((o) => o.isPrimary) || others[0];
  return { left: s.availLeft, top: s.availTop, width: s.availWidth, height: s.availHeight };
}

/**
 * The window features for a new main screen (or a site's own window): full size on `area` when
 * there is one, else a plain window the person drags. A page cannot open a window truly full screen
 * (Chrome dropped `fullscreen=yes` in 2024), and a page's own full screen ends when the window loads
 * another site; only the browser's own full screen (F11) stays across sites, so the main screen's own
 * page asks for it (`isFullScreen`).
 */
export function mainScreenFeatures(area) {
  if (!area) return "popup=yes,width=1400,height=900";
  return `popup=yes,left=${area.left},top=${area.top},width=${area.width},height=${area.height}`;
}

/**
 * Whether a window is full screen, from what its page can see: the browser says so (the
 * `display-mode: fullscreen` media query, which the browser's own F11 full screen matches in Chrome
 * and Edge, also when the page is zoomed; or a page's own full screen element), or the page fills the
 * whole screen, which a window with a title bar or tabs never does.
 */
export function isFullScreen({ displayFullscreen, fullscreenElement, innerWidth, innerHeight, screenWidth, screenHeight }) {
  if (displayFullscreen || fullscreenElement) return true;
  return screenWidth > 0 && screenHeight > 0 && innerWidth >= screenWidth && innerHeight >= screenHeight;
}
