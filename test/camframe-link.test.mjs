// The CamFrame link (camframeLink in src/camframe.mjs) driven without a real CamFrame: a fake fetch
// answers as CamFrame would, and a fake clock runs the checks, retries and waits on demand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMFRAME_CHECK_MS, CAMFRAME_ORIGIN, CUE_RETRY_MS, CUE_SETTLE_MS, camframeLink, LAYOUT_LARGE, LAYOUT_SMALL } from "../src/camframe.mjs";

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((done) => { setImmediate(done); }); };

/** Timers that run only when the test moves time on with `advance(ms)`. */
function fakeClock() {
  let now = 0;
  let ids = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { timers.set(++ids, { fn, at: now + ms, every }); return ids; };
  return {
    clock: {
      setTimeout: (fn, ms) => add(fn, ms, 0),
      clearTimeout: (id) => { timers.delete(id); },
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearInterval: (id) => { timers.delete(id); },
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
      await flush();
    },
  };
}

/**
 * A stand-in for CamFrame behind `fetch`: `down` refuses every call, `reply(path, body)` may answer one
 * call its own way ({ status, body }, or { hold: promise } to answer only once that resolves), and saves
 * to /camframe/scenes are kept in `status` the way CamFrame keeps them.
 */
function fakeCamFrame(status = { app: "camframe", version: "test", scenes: ["Demo"] }) {
  const cam = {
    status,
    down: false,
    reply: null,
    calls: [],
    paths: () => cam.calls.map((c) => c.path),
    async fetch(url, init) {
      assert.ok(url.startsWith(`${CAMFRAME_ORIGIN}/camframe/`), url);
      const path = url.slice(`${CAMFRAME_ORIGIN}/camframe/`.length);
      const body = init.body ? JSON.parse(init.body) : undefined;
      cam.calls.push({ path, body });
      const custom = cam.reply?.(path, body);
      if (custom?.hold) await custom.hold;
      if (cam.down) throw new TypeError("Failed to fetch");
      if (custom?.body) return new Response(JSON.stringify(custom.body), { status: custom.status ?? 200 });
      if (path === "status") return new Response(JSON.stringify(cam.status));
      if (path === "scenes") {
        if (cam.status.scenes.includes(body.name)) return new Response(JSON.stringify({ ok: false, code: "scene-exists", error: "Exists." }), { status: 409 });
        const scene = { kind: "layout", ...body, followsSmallSize: body.size === "small" || undefined, size: body.size === "small" ? cam.status.smallSize : body.size };
        cam.status = { ...cam.status, scenes: [...cam.status.scenes, body.name], sceneDetails: [...cam.status.sceneDetails, scene] };
        return new Response(JSON.stringify({ ok: true, scene }));
      }
      return new Response(JSON.stringify({ ok: true, cue: body }));
    },
  };
  return cam;
}

/** A CamFrame with API 2 that holds `details` as its Scenes. */
const api2 = (details = [], { sceneLimit = 10, smallSize = 288 } = {}) => ({ app: "camframe", version: "test", api: 2, sceneLimit, smallSize, scenes: details.map((d) => d.name), sceneDetails: details });

function linkWith(cam, { visible = () => true } = {}) {
  const time = fakeClock();
  const changes = [];
  let link = null;
  link = camframeLink({ fetch: cam.fetch, clock: time.clock, visible, changed: () => changes.push(link?.state) });
  return { link, time, changes };
}

test("connect: turned on, the link looks for CamFrame, says connected when it answers, and checks every 10 s while the page is in view", async () => {
  const cam = fakeCamFrame();
  let shown = true;
  const { link, time, changes } = linkWith(cam, { visible: () => shown });
  assert.equal(link.on, false);
  assert.equal(link.state, "off");
  link.turn(true);
  assert.equal(link.on, true);
  assert.equal(link.state, "looking", "looking at once, before CamFrame answers");
  assert.ok(changes.includes("looking"), "the page is told so it can draw the button");
  await time.advance(0);
  assert.equal(link.state, "on");
  assert.deepEqual(link.scenes, ["Demo"]);
  assert.deepEqual(cam.paths(), ["status"]);
  await time.advance(CAMFRAME_CHECK_MS - 1);
  assert.deepEqual(cam.paths(), ["status"], "no check before the 10 s are up");
  await time.advance(1);
  assert.deepEqual(cam.paths(), ["status", "status"]);
  shown = false;
  await time.advance(CAMFRAME_CHECK_MS);
  assert.equal(cam.calls.length, 2, "no check while the page is out of view");
  shown = true;
  link.check(); // opening Settings checks at once
  await time.advance(0);
  assert.equal(cam.calls.length, 3);
  const session = link.session;
  link.turn(false);
  assert.equal(link.state, "off");
  assert.deepEqual(link.scenes, []);
  assert.equal(link.session, session + 1, "each turn on or off starts a new session");
  link.check();
  await time.advance(CAMFRAME_CHECK_MS * 3);
  assert.equal(cam.calls.length, 3, "turned off, it calls CamFrame no more");
});

test("retry and backoff: a miss checks again after 1 s, the next after 2 s, the third says not found", async () => {
  const cam = fakeCamFrame();
  cam.down = true;
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(0);
  assert.equal(link.state, "looking", "one miss while looking keeps looking");
  assert.equal(link.misses, 1);
  await time.advance(999);
  assert.equal(cam.calls.length, 1, "no retry before 1 s");
  await time.advance(1);
  assert.equal(cam.calls.length, 2);
  assert.equal(link.misses, 2);
  await time.advance(1999);
  assert.equal(cam.calls.length, 2, "the second retry waits 2 s");
  await time.advance(1);
  assert.equal(cam.calls.length, 3);
  assert.equal(link.state, "lost");
  assert.equal(link.misses, 3);
  await time.advance(CAMFRAME_CHECK_MS - 3001);
  assert.equal(cam.calls.length, 3, "not found: no quick retries, only the usual checks");

  // Back: the next check connects; a later miss says reconnecting, the answer after it connects again.
  cam.down = false;
  await time.advance(CAMFRAME_CHECK_MS);
  assert.equal(link.state, "on");
  assert.equal(link.misses, 0);
  cam.down = true;
  await time.advance(1); // the next usual check, at 20 s
  assert.equal(link.state, "reconnecting");
  cam.down = false;
  await time.advance(1000);
  assert.equal(link.state, "on");
});

test("retry and backoff: a quick retry that falls due while the page is out of view waits for the usual checks", async () => {
  const cam = fakeCamFrame();
  cam.down = true;
  let shown = true;
  const { link, time } = linkWith(cam, { visible: () => shown });
  link.turn(true);
  await time.advance(0);
  shown = false;
  await time.advance(1000);
  assert.equal(cam.calls.length, 1);
});

test("stale session: an answer from before the link was turned off and on again is dropped", async () => {
  const cam = fakeCamFrame();
  let release;
  const held = new Promise((done) => { release = done; });
  cam.reply = (path) => (cam.calls.length === 1 ? { hold: held } : null);
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(0);
  assert.equal(link.state, "looking", "the first status is still on its way");
  link.turn(false);
  cam.down = true;
  link.turn(true);
  await time.advance(0);
  assert.equal(link.misses, 1, "the new session's own check missed");
  cam.down = false;
  release();
  await time.advance(0);
  assert.equal(link.state, "looking", "the late answer from the old session changes nothing");
  assert.equal(link.misses, 1);

  // A newer check wins over an older one still on its way, in the same session.
  let releaseOld;
  let used = false;
  const old = new Promise((done) => { releaseOld = done; });
  cam.reply = (path) => (path === "status" && !used ? (used = true, { hold: old, body: { app: "camframe", version: "old", scenes: ["Old"] } }) : null);
  link.check();
  link.check();
  await time.advance(0);
  assert.deepEqual(link.scenes, ["Demo"]);
  releaseOld();
  await time.advance(0);
  assert.deepEqual(link.scenes, ["Demo"], "the older answer landing late is dropped");
});

test("stale session: a cue's second try is not sent once the link was turned off and on in between", async () => {
  const cam = fakeCamFrame();
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(0);
  cam.down = true;
  link.sendCue({ size: "full" });
  await time.advance(0);
  link.turn(false);
  link.turn(true);
  cam.down = false;
  await time.advance(CUE_RETRY_MS);
  assert.equal(cam.paths().filter((p) => p === "cue").length, 1, "the old cue's retry was dropped");
});

test("cue resend: a cue that does not get through goes once more after 400 ms; two misses count as a missed check", async () => {
  const cam = fakeCamFrame();
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(0);
  cam.calls.length = 0;
  let fails = 1;
  cam.reply = (path) => (path === "cue" && fails-- > 0 ? { body: "not json" } : null);
  link.sendCue({ size: "small", position: "bottom-right" });
  await time.advance(CUE_RETRY_MS - 1);
  assert.deepEqual(cam.paths(), ["cue"], "the second try waits 400 ms");
  await time.advance(1);
  assert.deepEqual(cam.calls.map((c) => [c.path, c.body]), [["cue", { size: "small", position: "bottom-right" }], ["cue", { size: "small", position: "bottom-right" }]]);
  assert.equal(link.state, "on", "the second try got through");

  // Both tries miss: reconnecting, and a status check soon.
  cam.calls.length = 0;
  cam.down = true;
  link.sendCue({ size: "full" });
  await time.advance(CUE_RETRY_MS);
  assert.deepEqual(cam.paths(), ["cue", "cue"]);
  assert.equal(link.state, "reconnecting");
  cam.down = false;
  await time.advance(1000);
  assert.deepEqual(cam.paths(), ["cue", "cue", "status"]);
  assert.equal(link.state, "on");
});

test("cue resend: a cue whose first try failed is not sent again once a new script opens (dropCue) or a newer cue goes", async () => {
  const cam = fakeCamFrame();
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(0);
  cam.calls.length = 0;
  let fails = 1;
  cam.reply = (path) => (path === "cue" && fails-- > 0 ? { body: "not json" } : null);
  link.sendCue({ size: "small" });
  await time.advance(0);
  link.dropCue(); // a new script opened before the second try
  await time.advance(CUE_RETRY_MS);
  assert.deepEqual(cam.paths(), ["cue"], "the old script's cue is not sent again");
  assert.equal(link.state, "on", "and its dropped retry counts as no miss");

  // A newer cue sent while the older one waits for its second try: the older cue is not sent again.
  cam.calls.length = 0;
  fails = 1;
  link.sendCue({ size: "small" });
  await time.advance(0);
  link.sendCue({ size: "full" });
  await time.advance(CUE_RETRY_MS);
  assert.deepEqual(cam.calls.map((c) => c.body), [{ size: "small" }, { size: "full" }], "the older cue's second try is dropped");
});

test("cue resend after reconnect: a cue answered while reconnecting checks the status, which connects again", async () => {
  const cam = fakeCamFrame();
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(0);
  cam.down = true;
  await time.advance(CAMFRAME_CHECK_MS);
  assert.equal(link.state, "reconnecting");
  cam.down = false;
  cam.calls.length = 0;
  link.sendCue({ size: "full" });
  await time.advance(0);
  assert.deepEqual(cam.paths(), ["cue", "status"], "the cue got through, then the status is read at once");
  assert.equal(link.state, "on");
  assert.equal(link.misses, 0);
});

test("cue settle: a cue waits 250 ms at the reading line, so only the last of several goes, and only while it is still there and the link is on", async () => {
  const cam = fakeCamFrame();
  const { link, time } = linkWith(cam);
  link.cue({ size: "full" }, () => true);
  await time.advance(CUE_SETTLE_MS);
  assert.equal(cam.calls.length, 0, "with the link off nothing is sent");
  link.turn(true);
  await time.advance(0);
  cam.calls.length = 0;
  link.cue({ size: "full" }, () => true);
  await time.advance(100);
  link.cue({ size: "small" }, () => true);
  await time.advance(CUE_SETTLE_MS - 1);
  assert.equal(cam.calls.length, 0);
  await time.advance(1);
  assert.deepEqual(cam.calls.map((c) => c.body), [{ size: "small" }], "only the last cue went");
  link.cue({ size: "full" }, () => false);
  await time.advance(CUE_SETTLE_MS);
  assert.equal(cam.calls.length, 1, "a cue scrolled back below the line before it settled is not sent");
  link.cue({ size: "full" }, () => true);
  link.dropCue();
  await time.advance(CUE_SETTLE_MS);
  assert.equal(cam.calls.length, 1, "a new script drops a cue still waiting");
});

test("layout save: a CamFrame with API 2 gets the two missing layouts once per session, small first, then the status is read", async () => {
  const cam = fakeCamFrame(api2([{ name: "Demo", kind: "scene" }]));
  const { link, time } = linkWith(cam);
  let release;
  let used = false;
  const held = new Promise((done) => { release = done; });
  cam.reply = (path) => (path === "scenes" && !used ? (used = true, { hold: held }) : null);
  link.turn(true);
  await time.advance(0);
  assert.equal(link.saving, true, "saving while CamFrame has not answered the first save");
  release();
  await time.advance(0);
  assert.equal(link.saving, false);
  assert.deepEqual(cam.calls.map((c) => [c.path, c.body?.name]), [["status", undefined], ["scenes", LAYOUT_SMALL], ["scenes", LAYOUT_LARGE], ["status", undefined]]);
  assert.deepEqual(cam.calls[2].body, { name: LAYOUT_LARGE, size: 432, position: "right", withinRight: 0.3 });
  assert.equal(link.problem, "");
  assert.deepEqual(link.layouts.scenes, ["Demo", LAYOUT_SMALL, LAYOUT_LARGE]);
  assert.deepEqual(link.scenes, ["Demo", LAYOUT_SMALL, LAYOUT_LARGE]);
  assert.equal(link.state, "on");

  // Deleted by hand afterwards: the next check does not save again in this session; a new session does.
  cam.status = api2([{ name: "Demo", kind: "scene" }]);
  await time.advance(CAMFRAME_CHECK_MS);
  assert.equal(cam.paths().filter((p) => p === "scenes").length, 2);
  link.turn(false);
  link.turn(true);
  await time.advance(0);
  assert.equal(cam.paths().filter((p) => p === "scenes").length, 4);
});

test("layout save: a refusal says why; an older CamFrame or a CamFrame with no spare slot gets nothing saved", async () => {
  const cam = fakeCamFrame(api2([]));
  cam.reply = (path) => (path === "scenes" ? { status: 409, body: { ok: false, code: "scene-limit", error: "Full." } } : null);
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(0);
  assert.deepEqual(cam.paths(), ["status", "scenes", "status"], "stops at the first refusal");
  assert.match(link.problem, /no room for another Scene/);

  const older = fakeCamFrame();
  const second = linkWith(older);
  second.link.turn(true);
  await second.time.advance(0);
  assert.equal(second.link.layouts, null);
  assert.deepEqual(older.paths(), ["status"]);

  const tight = fakeCamFrame(api2([{ name: "A", kind: "scene" }, { name: "B", kind: "scene" }], { sceneLimit: 4 }));
  const third = linkWith(tight);
  third.link.turn(true);
  await third.time.advance(0);
  assert.deepEqual(tight.paths(), ["status"], "saving both would fill CamFrame: nothing is saved");
  assert.equal(third.link.saving, false);
});

test("layout save: when the status read after the saves misses, CamFrame's yes counts and the check retries soon", async () => {
  const cam = fakeCamFrame(api2([]));
  let statusCalls = 0;
  cam.reply = (path) => (path === "status" && ++statusCalls === 2 ? { body: "nope" } : null);
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(0);
  assert.equal(link.state, "reconnecting");
  assert.deepEqual(link.layouts.scenes, [LAYOUT_SMALL, LAYOUT_LARGE]);
  assert.equal(link.problem, "");
  await time.advance(1000);
  assert.equal(link.state, "on");
});

test("layout save: a save left from before the link was turned off and on never holds up the new session's", async () => {
  const cam = fakeCamFrame(api2([]));
  let release;
  let used = false;
  const held = new Promise((done) => { release = done; });
  cam.reply = (path) => (path === "scenes" && !used ? (used = true, { hold: held }) : null);
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(0);
  assert.equal(link.saving, true);
  link.turn(false);
  assert.equal(link.saving, false, "the old session's save is not this session's");
  link.turn(true);
  await time.advance(0);
  assert.deepEqual(cam.calls.map((c) => [c.path, c.body?.name]), [["status", undefined], ["scenes", LAYOUT_SMALL], ["status", undefined], ["scenes", LAYOUT_SMALL], ["scenes", LAYOUT_LARGE], ["status", undefined]], "the new session saves both by itself");
  assert.equal(link.saving, false);
  assert.deepEqual(link.layouts.scenes, [LAYOUT_SMALL, LAYOUT_LARGE]);
  release();
  await time.advance(0);
  assert.equal(link.saving, false);
  assert.equal(link.problem, "", "the old save's late answer changes nothing");
  assert.deepEqual(link.layouts.scenes, [LAYOUT_SMALL, LAYOUT_LARGE]);
});

test("layout save: a status check sent while the layouts are saved says nothing about after the save", async () => {
  const cam = fakeCamFrame(api2([]));
  const before = cam.status;
  let releaseSave;
  let releaseCheck;
  const save = new Promise((done) => { releaseSave = done; });
  const check = new Promise((done) => { releaseCheck = done; });
  let saves = 0;
  let checks = 0;
  cam.reply = (path) => {
    if (path === "scenes" && ++saves === 1) return { hold: save };
    if (path === "status" && ++checks === 2) return { hold: check, body: before };
    return null;
  };
  const { link, time } = linkWith(cam);
  link.turn(true);
  await time.advance(CAMFRAME_CHECK_MS); // the usual check goes while the first save waits for its answer
  assert.deepEqual(cam.paths(), ["status", "scenes", "status"]);
  releaseSave();
  await time.advance(0);
  assert.deepEqual(link.layouts.scenes, [LAYOUT_SMALL, LAYOUT_LARGE]);
  releaseCheck();
  await time.advance(0);
  assert.deepEqual(link.layouts.scenes, [LAYOUT_SMALL, LAYOUT_LARGE], "the older check's answer, without the layouts, is dropped");
  assert.equal(link.problem, "");
});
