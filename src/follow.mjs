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

/** Fuzzy word match: equal, a cut-off interim word, or one typo in a longer word. */
export function sameWord(heard, word) {
  if (heard === word) return true;
  if (heard.length >= 3 && word.startsWith(heard)) return true;
  return Math.min(heard.length, word.length) >= 4 && editDistanceAtMostOne(heard, word);
}

/**
 * Score how well the end of what was heard matches one line: the longest
 * in-order fuzzy match, where later heard words weigh more. So the line that
 * holds the words just spoken beats the line that held the words before them.
 */
function lineScore(tail, words) {
  const rows = tail.length + 1;
  const cols = words.length + 1;
  const best = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const count = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const options = [[best[i - 1][j], count[i - 1][j]], [best[i][j - 1], count[i][j - 1]]];
      if (sameWord(tail[i - 1], words[j - 1])) options.push([best[i - 1][j - 1] + i, count[i - 1][j - 1] + 1]);
      [best[i][j], count[i][j]] = options.reduce((a, b) => (b[0] > a[0] ? b : a));
    }
  }
  return { score: best[tail.length][words.length], matched: count[tail.length][words.length] };
}

/**
 * Pick the line being read. `lines` holds each spoken line's speechWords
 * (QL questions and [reminders] left out by the caller); `current` is the
 * line followed so far (-1 before the first); `heard` is recent recognised text.
 * Looks `ahead` lines forward and at most `back` lines back, so it never jumps
 * far backwards. Returns `current` when nothing matches well enough.
 */
export function followLine(lines, current, heard, { ahead = 6, back = 1, tailWords = 6 } = {}) {
  const tail = speechWords(heard).slice(-tailWords);
  if (!tail.length || !lines.length) return current;
  const from = Math.max(0, current - back);
  const to = Math.min(lines.length - 1, Math.max(current, 0) + ahead);
  let pick = current;
  let pickScore = 0;
  for (let k = from; k <= to; k++) {
    const words = lines[k];
    if (!words?.length) continue;
    // Two matching words (or the whole of a one-word line), one of them the
    // word heard last: the speaker is on this line now.
    if (!words.some((w) => sameWord(tail.at(-1), w))) continue;
    const { score, matched } = lineScore(tail, words);
    if (matched < Math.min(2, words.length)) continue;
    // Small pull towards the line already followed; going back costs more
    // than going forward, so a repeated phrase moves on.
    const step = k - Math.max(current, 0);
    const weighted = score - (step < 0 ? 1.5 : 0.5) * Math.abs(step) + (k === current ? 0.75 : 0);
    if (weighted > pickScore) { pick = k; pickScore = weighted; }
  }
  return pick;
}
