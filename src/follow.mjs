// Voice follow: find the script line the speaker is reading from what the
// browser's speech recognition heard. Pure functions, inlined into the page by
// scripts/build.mjs like core.mjs, so keep this file import-free and use only
// `export function` / `export const` forms.

/** Lowercase words without accents, punctuation, URLs or a Next:/Now: label. */
export function speechWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*(next week|next|now):/, " ")
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function editDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Words people say all the time. Alone, or only with each other, they never
// move the followed line: "the" or "you" is in nearly every line. Any word of
// one or two letters counts as common too.
export const COMMON_WORDS = new Set(("a an the and or but so to of in on at by for with from as into about over "
  + "is are was were be been am do does did dont doesnt didnt have has had will would can cant could should "
  + "it its this that these those there here then than now just very really also too not no yes "
  + "i im ive me my we our you youre your he she they them their his her what when where why how who which "
  + "get got go going up down out all some more like well okay ok um uh yeah "
  + "de het een en van je jij ik dat die dit op te met voor niet maar dus er ook wel nog naar om als bij aan").split(" "));

/** A common word: short or on the list above. */
export function commonWord(word) {
  return word.length <= 2 || COMMON_WORDS.has(word);
}

/**
 * Fuzzy word match: equal, a cut-off interim word, or one typo in a longer
 * word. Common words must match exactly ("the" is not "them").
 */
export function sameWord(heard, word) {
  if (heard === word) return true;
  if (commonWord(heard) || commonWord(word)) return false;
  if (word.startsWith(heard)) return true;
  return Math.min(heard.length, word.length) >= 4 && editDistanceAtMostOne(heard, word);
}

/**
 * Where Follow my voice starts: at the first word of `line` (the line at the
 * reading line; -1 before the first). `line` is the line followed, `word` the
 * next word in it to hear, `heard` the last few words heard ({ w, used }, used
 * when it moved the cursor) and `moved` whether anything has been followed since.
 */
export function followStart(line) {
  return { line: Math.max(0, line), word: 0, heard: [], moved: false };
}

/**
 * Follow the speaker word by word. `lines` holds each spoken line's
 * speechWords (QL questions and [reminders] left out by the caller); `state`
 * comes from followStart or an earlier call; `words` are newly heard words
 * (speechWords), each heard once. Returns the new state; `state` is not
 * changed, so interim words can be tried from the last final state and then
 * thrown away.
 *
 * Each heard word moves a cursor through the script, in order:
 * - in the current line, to the next word or a few words on (a common word
 *   only to the very next one); finishing a line moves to the next line;
 * - to the next line when its start is heard: two words in a row, one of
 *   them not common;
 * - further ahead (at most `ahead` lines) or one line back only after a
 *   strong run: three words in a row, two of them not common.
 * So a single word, or a pair of common words, that also appears in a later
 * line never moves the line. "In a row" forgives one missed or extra word.
 */
export function followWords(lines, state, words, { ahead = 6, keep = 8 } = {}) {
  // All words in one list; starts[k] is where line k begins in it.
  const flat = [];
  const starts = lines.map((ws, k) => {
    const s = flat.length;
    for (const w of ws || []) flat.push({ w, k });
    return s;
  });
  if (!flat.length) return state;
  const line = Math.min(Math.max(0, state.line), lines.length - 1);
  let at = Math.min(flat.length, starts[line] + Math.max(0, state.word));
  const heard = state.heard.slice();
  let moved = state.moved;
  for (const w of words) {
    const word = { w, used: false };
    heard.push(word);
    if (heard.length > keep) heard.shift();
    const j = nextWord(flat, starts, at, heard, ahead);
    if (j >= 0) { at = j + 1; moved = word.used = true; }
  }
  if (at >= flat.length) {
    const last = flat.at(-1).k;
    return { line: last, word: lines[last].length, heard, moved };
  }
  return { line: flat[at].k, word: at - starts[flat[at].k], heard, moved };
}

/** The script word the newest heard word is, or -1 when it does not move the cursor. */
function nextWord(flat, starts, at, heard, ahead) {
  const cur = flat[Math.min(at, flat.length - 1)].k;
  const lo = cur > 0 ? starts[cur - 1] : 0;
  const strong = (r) => r.n >= 3 && r.strong >= 2;
  let pick = -1;
  let pickRun = 0;
  let pickFar = Infinity;
  for (let j = lo; j < flat.length && flat[j].k <= cur + ahead; j++) {
    if (!sameWord(heard.at(-1).w, flat[j].w)) continue;
    // Going forward only new words count (not heard before and not used to
    // move already); going back, all of them.
    const { all, ahead: fresh } = runTo(flat, heard, j, at);
    const d = flat[j].k - cur;
    let ok;
    if (d === 0) ok = j === at || (j > at && ((j - at <= 3 && !commonWord(flat[j].w)) || strong(fresh)));
    else if (d === 1) ok = (fresh.n >= 2 && fresh.strong >= 1 && fresh.first <= starts[flat[j].k] + 1) || strong(fresh);
    else ok = d > 1 ? strong(fresh) : d === -1 && strong(all);
    if (!ok) continue;
    // The longest run of words counted wins; on a tie, the nearest word ahead, then behind.
    const run = j >= at ? fresh.n : all.n;
    const far = j >= at ? j - at : flat.length + at - j;
    if (run > pickRun || (run === pickRun && far < pickFar)) { pick = j; pickRun = run; pickFar = far; }
  }
  return pick;
}

/**
 * The heard words, ending with the newest, that match the script in order up
 * to word `j`, forgiving one missed or extra word between matches: `all` of
 * them, and the new ones `ahead` of the cursor `at` (heard words not used to
 * move before). Each has `n` matches, `strong` of them not common words,
 * starting at script word `first`.
 */
function runTo(flat, heard, j, at) {
  const all = { n: 0, strong: 0, first: j };
  const fresh = { n: 0, strong: 0, first: j };
  let i = heard.length - 1;
  for (;;) {
    for (const r of j >= at && !heard[i].used ? [all, fresh] : [all]) {
      r.n++;
      r.first = j;
      if (!commonWord(flat[j].w)) r.strong++;
    }
    const step = [[1, 1], [2, 1], [1, 2], [2, 2]].find(([di, dj]) => i - di >= 0 && j - dj >= 0 && sameWord(heard[i - di].w, flat[j - dj].w));
    if (!step) return { all, ahead: fresh };
    i -= step[0];
    j -= step[1];
  }
}

/**
 * Find the link whose label the speaker just said. `links` are candidates with
 * a `label`, in priority order (the current section's links, then the next
 * section's); `heard` is recent recognised text. A label matches when all its
 * words are heard together as whole words (case and accents ignored) within
 * the last `tailWords` words, so a label said a while ago does not match
 * again. When several match, the one said last wins; a tie goes to the
 * earlier candidate. Returns the candidate or null.
 */
export function heardLink(links, heard, { tailWords = 8 } = {}) {
  const tail = speechWords(heard).slice(-tailWords);
  let pick = null;
  let pickEnd = -1;
  for (const link of links) {
    const words = speechWords(link?.label);
    if (!words.length) continue;
    for (let end = tail.length; end >= words.length; end--) {
      if (words.every((w, i) => tail[end - words.length + i] === w)) {
        if (end > pickEnd) { pick = link; pickEnd = end; }
        break;
      }
    }
  }
  return pick;
}

/** Waits before starting speech recognition again after a network error, one per try in a row (about 15 s in all). */
export const SPEECH_RETRY_MS = [500, 1000, 2000, 4000, 8000];

/**
 * After a speech recognition error: how long to wait before starting again
 * (ms), or -1 to give up. Only a network error is retried: Edge's speech
 * service drops now and then in normal use. `fails` counts the network
 * errors in a row with no words recognised between them, this one not
 * included, so a browser that never reaches its service still gives up.
 */
export function speechRetryWait(error, fails) {
  return error === "network" && fails < SPEECH_RETRY_MS.length ? SPEECH_RETRY_MS[fails] : -1;
}
