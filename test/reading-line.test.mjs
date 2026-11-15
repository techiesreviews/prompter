import { test } from "node:test";
import assert from "node:assert/strict";
import { LINE_INSET, LINE_REACH, readingLine, reachedCount } from "../src/reading-line.mjs";

// A stand-in for the script column: elements with a top (px from the window's top), the data the page
// gives them, and a count of the positions read, so a test can say how much one look costs.
function fakeScript(spec) {
  const reads = { n: 0 };
  const el = (top, dataset = {}, kids = []) => ({ dataset, kids, getBoundingClientRect() { reads.n++; return { top }; } });
  const sections = spec.map((s, i) => el(s.top, { i: String(i) }, s.links || []));
  for (const s of sections) s.querySelectorAll = (sel) => (sel === ".mark, .inlink" ? s.kids.map((l) => el(l.top, { l: String(l.l) })) : []);
  const cues = spec.flatMap((s) => s.cues || []).map((top, n) => el(top, { cue: String(n) }));
  const lines = spec.flatMap((s) => s.lines || []).map((top, k) => el(top, { k: String(k) }));
  const lists = { ".section": sections, "[data-cue]": cues, "[data-k]": lines };
  return { reads, querySelectorAll: (sel) => lists[sel] || [] };
}

// A window that records where it was asked to scroll.
function fakeView(scrollY = 1000) {
  return { scrollY, calls: [], scrollTo(opts) { this.calls.push(opts); } };
}

// Frames run when the test says so.
function fakeFrames() {
  const queue = [];
  const frame = (fn) => { queue.push(fn); return queue.length; };
  frame.run = () => { const now = queue.splice(0); now.forEach((fn) => fn()); return now.length; };
  return frame;
}

const SCRIPT = [
  { top: -400, lines: [-380, -300, -200], cues: [-250] },
  { top: -100, links: [{ top: -60, l: 1 }, { top: 150, l: 2 }], lines: [-80, 0, 96, 104, 200], cues: [50, 500] },
  { top: 700, lines: [720, 800] },
];

test("reachedCount: an element whose top is at most LINE_REACH px under the line has reached it", () => {
  const els = [0, 100, 104, 105, 300].map((top) => ({ getBoundingClientRect: () => ({ top }) }));
  assert.equal(LINE_REACH, 4);
  assert.equal(reachedCount(els, 100), 3);
  assert.equal(reachedCount(els, -10), 0);
  assert.equal(reachedCount(els, 1000), 5);
  assert.equal(reachedCount([], 100), 0);
});

test("look: the section, its link, the cues and the spoken line at the reading line", () => {
  const script = fakeScript(SCRIPT);
  const line = readingLine({ script, view: fakeView(), frame: fakeFrames(), onLook() {} });
  line.place(100);
  const at = line.look();
  assert.equal(at.section, 1);
  assert.equal(at.link, 1, "the last link of that section above the line");
  assert.deepEqual(at.cues, [0, 1], "every cue above the line, by number");
  assert.equal(at.line, 6, "the last spoken line whose top reached the line (104 is within reach)");
});

test("look: above every section the first one counts; no lines or links reached give -1", () => {
  const line = readingLine({ script: fakeScript(SCRIPT), view: fakeView(), frame: fakeFrames(), onLook() {} });
  line.place(-1000);
  assert.deepEqual([line.look().section, line.look().link, line.look().cues, line.look().line], [0, -1, [], -1]);
  const empty = readingLine({ script: fakeScript([]), view: fakeView(), frame: fakeFrames(), onLook() {} });
  assert.deepEqual([empty.look().section, empty.look().link, empty.look().cues, empty.look().line], [0, -1, [], -1]);
});

test("look: reads each answer once, and only the answers asked for", () => {
  const script = fakeScript(SCRIPT);
  const line = readingLine({ script, view: fakeView(), frame: fakeFrames(), onLook() {} });
  line.place(100);
  const at = line.look();
  assert.equal(script.reads.n, 0, "nothing is measured until an answer is read");
  void at.section;
  const afterSection = script.reads.n;
  void at.section;
  void at.link;
  void at.link;
  assert.ok(script.reads.n > afterSection, "the link costs its own reads");
  const afterLink = script.reads.n;
  void at.section;
  void at.link;
  assert.equal(script.reads.n, afterLink, "a second read of the same answer measures nothing");
});

test("look: a long script costs a handful of reads, not one per line", () => {
  const spec = Array.from({ length: 50 }, (_, i) => ({ top: i * 1000 - 20000, lines: Array.from({ length: 20 }, (_, j) => i * 1000 - 20000 + 40 + j * 48), cues: [i * 1000 - 20000 + 500] }));
  const script = fakeScript(spec);
  const line = readingLine({ script, view: fakeView(), frame: fakeFrames(), onLook() {} });
  line.place(300);
  const at = line.look();
  assert.deepEqual([at.section, at.line, at.cues.length], [20, 405, 20]);
  assert.ok(script.reads.n <= 30, `1000 lines, 50 sections and 50 cues in ${script.reads.n} reads`);
});

test("place: holds the line's position and says how far it moved", () => {
  const line = readingLine({ script: fakeScript([]), view: fakeView(), frame: fakeFrames(), onLook() {} });
  assert.equal(line.y, 0);
  assert.equal(line.place(300), 300);
  assert.equal(line.place(250), -50);
  assert.equal(line.y, 250);
});

test("ask: any number of asks in one frame make one look; a voice ask is kept", () => {
  const frame = fakeFrames();
  const looks = [];
  const line = readingLine({ script: fakeScript(SCRIPT), view: fakeView(), frame, onLook: (at, wants) => looks.push([at.section, wants]) });
  line.place(100);
  line.ask();
  line.ask({ voice: true });
  line.ask();
  assert.equal(frame.run(), 1, "one frame queued");
  assert.deepEqual(looks, [[1, { voice: true }]]);
  line.ask();
  frame.run();
  assert.deepEqual(looks.at(-1), [1, { voice: false }], "the next frame starts without the voice ask");
  assert.equal(frame.run(), 0, "nothing more queued");
});

test("bring: scrolls so the reading line falls LINE_INSET px into the element, or at a given point of it", () => {
  const view = fakeView(1000);
  const line = readingLine({ script: fakeScript([]), view, frame: fakeFrames(), onLook() {} });
  line.place(300);
  const el = { getBoundingClientRect: () => ({ top: 500 }) };
  assert.equal(LINE_INSET, 2);
  line.bring(el);
  line.bring(el, { smooth: true });
  line.bring(el, { at: 30 });
  assert.deepEqual(view.calls, [{ top: 1202 }, { top: 1202, behavior: "smooth" }, { top: 1230 }]);
});
