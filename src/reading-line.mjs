// The reading line: where it sits on screen, and what of the script has reached it.
// The page asks it "what is at the line" (the section, the link reached in it, the camera cues
// above it, the spoken line) and "bring this to the line". However many scrolls and wheels ask
// in one animation frame, it looks once in that frame; a move by the reader (the line dragged,
// a section jump, line height, paragraph spacing or layout) looks at once, so it follows without waiting. A look measures only the
// answers read from it, each once, and finds each by halving: the script's elements of one
// kind sit top to bottom in page order, so a look reads a handful of positions, not every line.
// Inlined into the page by scripts/build.mjs (no imports; `export function`/`export const` only).

/** A top this many px below the line still counts as reached. */
export const LINE_REACH = 4;
/** An element brought to the line sits with the line this many px inside its top. */
export const LINE_INSET = 2;

/** How many of `els` (page order, tops never going up) have reached the line at `y`. */
export function reachedCount(els, y) {
  let lo = 0;
  let hi = els.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (els[mid].getBoundingClientRect().top <= y + LINE_REACH) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The reading line over `script` (the script column). `view` scrolls (the window), `frame`
 * queues an animation frame, and `onLook(at, { voice })` gets the frame's one look after
 * `ask()`, with voice true when any ask that frame was for Follow my voice.
 */
export function readingLine({ script, view, frame, onLook }) {
  let y = 0;
  let queued = false;
  let voice = false;

  /** What is at the line now. Each answer is measured when first read, then kept. */
  function look() {
    const kept = new Map();
    const once = (key, measure) => {
      if (!kept.has(key)) kept.set(key, measure());
      return kept.get(key);
    };
    const sections = () => once("sections", () => script.querySelectorAll(".section"));
    const lastOf = (els, key) => {
      const n = reachedCount(els, y);
      return n ? Number(els[n - 1].dataset[key]) : -1;
    };
    // Stepping back from the last line reached while the one before still reaches below the line.
    const rowLines = () => once("rowLines", () => {
      const els = script.querySelectorAll("[data-k]");
      let n = reachedCount(els, y);
      if (!n) return { first: -1, last: -1 };
      const last = Number(els[n - 1].dataset.k);
      while (n > 1 && els[n - 2].getBoundingClientRect().bottom > y) n--;
      return { first: Number(els[n - 1].dataset.k), last };
    });
    return {
      /** The last section whose top reached the line; the first when none has. */
      get section() { return once("section", () => Math.max(0, reachedCount(sections(), y) - 1)); },
      /** The last own-line or in-line link of that section above the line (its data-l), or -1. */
      get link() {
        return once("link", () => {
          const el = sections()[this.section];
          return el ? lastOf(el.querySelectorAll(".mark, .inlink"), "l") : -1;
        });
      },
      /** The numbers (data-cue) of every camera cue above the line. */
      get cues() {
        return once("cues", () => {
          const els = script.querySelectorAll("[data-cue]");
          return Array.from(els).slice(0, reachedCount(els, y)).map((el) => Number(el.dataset.cue));
        });
      },
      /**
       * The spoken line (data-k) at the line, or -1: the first one still on the row there (several
       * lines can share a row), else the last whose top reached the line.
       */
      get line() { return rowLines().first; },
      /** The last spoken line whose top reached the line (the last one starting on that row), or -1. */
      get lastLine() { return rowLines().last; },
    };
  }

  return {
    get y() { return y; },
    /** Put the line `next` px from the window's top; returns how far it moved. */
    place(next) {
      const moved = next - y;
      y = next;
      return moved;
    },
    look,
    /** Look in the next frame (once, however many ask); `voice` when Follow my voice should follow on. */
    ask({ voice: forVoice = false } = {}) {
      voice ||= forVoice;
      if (queued) return;
      queued = true;
      frame(() => {
        const wants = { voice };
        queued = false;
        voice = false;
        onLook(look(), wants);
      });
    },
    /** Scroll so the line falls `at` px into `el` (smoothly with `smooth`). */
    bring(el, { at = LINE_INSET, smooth = false } = {}) {
      const top = el.getBoundingClientRect().top + view.scrollY - y + at;
      view.scrollTo(smooth ? { top, behavior: "smooth" } : { top });
    },
  };
}
