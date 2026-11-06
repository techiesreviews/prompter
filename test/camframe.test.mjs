import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMFRAME_MISSES, CAMFRAME_ORIGIN, CAMFRAME_RETRY_MS, camframeAfterCheck, camframeCall, cueCrossing, cueRest, cueWords, LAYOUT_LARGE, LAYOUT_SMALL, layoutMatches, layoutPlan, layoutProblem, layoutRoomWords, layoutsLine, layoutsWithSaved, layoutsSupported, layoutWants } from "../src/camframe.mjs";
import { check, classify, faceCue, FACE_SPOTS, formatGuide, parse } from "../src/core.mjs";

test("faceCue: Lex's existing cue lines still work", () => {
  assert.deepEqual(faceCue("Share screen. Face small."), { cue: { size: "small" } });
  assert.deepEqual(faceCue("Keep sharing. Face small."), { cue: { size: "small" } });
  assert.deepEqual(faceCue("Stop share. Face full."), { cue: { size: "full" } });
});

test("faceCue: places, Scenes, any case, and the British spelling of centre", () => {
  assert.deepEqual(faceCue("Share screen. Face small, bottom right."), { cue: { size: "small", position: "bottom-right" } });
  assert.deepEqual(faceCue("face SMALL top-left"), { cue: { size: "small", position: "top-left" } });
  assert.deepEqual(faceCue("Face small, left"), { cue: { size: "small", position: "left" } });
  assert.deepEqual(faceCue("Face small, Centre."), { cue: { size: "small", position: "center" } });
  assert.deepEqual(faceCue("Face: Demo"), { cue: { size: "small", scene: "Demo" } });
  assert.deepEqual(faceCue("Show code. FACE: Talking head."), { cue: { size: "small", scene: "Talking head" } });
  for (const spot of FACE_SPOTS) assert.deepEqual(faceCue(`Face small, ${spot.replace("-", " ")}`), { cue: { size: "small", position: spot } });
});

test("faceCue: only a sentence that starts with Face is a cue; malformed ones say why", () => {
  assert.equal(faceCue("Answer in your own words"), null);
  assert.equal(faceCue("Look at your face, then smile"), null);
  assert.equal(faceCue(""), null);
  assert.match(faceCue("Face small, middle").problem, /"middle" is not a place; use top left/);
  assert.match(faceCue("Face full, top left").problem, /a place goes only with Face small/);
  assert.match(faceCue("Face big").problem, /is not a camera cue/);
  assert.match(faceCue("Face:").problem, /name a CamFrame Scene/);
  assert.match(faceCue(`Face: ${"x".repeat(41)}`).problem, /at most 40 characters/);
  assert.match(faceCue("Face full. Face small.").problem, /one camera cue per line/);
});

test("parse keeps a cue on its reminder line; the checker warns on malformed cues in both presets", () => {
  const script = "### **1 · DEMO · 00:00**\n\nQL: What now?\n\n[Share screen. Face small.]\nHere is the code.\n[Face small, middle]\n[Face: Demo]\n";
  const [section] = parse(script);
  const notes = section.items.filter((it) => it.type === "note");
  assert.deepEqual(notes.map((n) => n.cue ?? n.problem), [{ size: "small" }, notes[1].problem, { size: "small", scene: "Demo" }]);
  assert.deepEqual(classify("[Stop share. Face full.]"), { type: "note", text: "Stop share. Face full.", cue: { size: "full" } });
  for (const preset of ["lex", "default"]) {
    const cueProblems = check(script, preset).problems.filter((p) => p.code === "camera-cue");
    assert.equal(cueProblems.length, 1, preset);
    assert.equal(cueProblems[0].severity, "warning");
    assert.equal(cueProblems[0].line, 7);
  }
});

test("cue lines still count towards the lex five-word limit", () => {
  const problems = check("### **1 · DEMO · 00:00**\n\nQL: What now?\n\n[Share screen. Face small, bottom right.]\n[Face small, bottom right.]\n", "lex").problems;
  assert.deepEqual(problems.filter((p) => p.code === "line-too-long").map((p) => p.line), [5]);
  assert.equal(problems.filter((p) => p.code === "camera-cue").length, 0);
});

test("the format guide (and so get_format) teaches the cue syntax", () => {
  const guide = formatGuide("lex");
  assert.match(guide, /\[Face full\] · \[Face small, bottom right\] · \[Face: Scene name\]/);
  assert.match(guide, /top left, top right, bottom left, bottom right, left, right or center/);
});

test("cueCrossing: each cue is sent once per pass down and re-arms when scrolled back above it", () => {
  let state = cueCrossing(new Set(), []);
  assert.equal(state.send, -1);
  state = cueCrossing(state.above, [0]);
  assert.equal(state.send, 0, "cue 0 reaches the reading line");
  state = cueCrossing(state.above, [0]);
  assert.equal(state.send, -1, "staying past it sends nothing again");
  state = cueCrossing(state.above, [0, 1]);
  assert.equal(state.send, 1);
  state = cueCrossing(state.above, [0]);
  assert.equal(state.send, -1, "scrolling back up above cue 1 sends nothing");
  state = cueCrossing(state.above, [0, 1]);
  assert.equal(state.send, 1, "and the next pass down sends it again");
  state = cueCrossing(state.above, [0, 1, 2, 3, 4]);
  assert.equal(state.send, 4, "a jump past several cues sends only the last one");
  state = cueCrossing(new Set(), []);
  assert.deepEqual([...state.above], []);
});

test("camframeCall: talks only to CamFrame on this computer and sends only the cue", async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/status")) return new Response(JSON.stringify({ app: "camframe", version: "0.6.0", scenes: ["Demo"] }));
    return new Response(JSON.stringify({ ok: false, error: 'CamFrame has no Scene named "Outro".' }), { status: 404 });
  };
  assert.equal(CAMFRAME_ORIGIN, "http://127.0.0.1:47833");
  assert.deepEqual(await camframeCall("status"), { ok: true, body: { app: "camframe", version: "0.6.0", scenes: ["Demo"] } });
  const refused = await camframeCall("cue", { size: "small", scene: "Outro" });
  assert.equal(refused.ok, false);
  assert.match(refused.body.error, /no Scene named "Outro"/);
  assert.deepEqual(calls.map((c) => [c.url, c.init.method, c.init.body]), [
    ["http://127.0.0.1:47833/camframe/status", "GET", undefined],
    ["http://127.0.0.1:47833/camframe/cue", "POST", '{"size":"small","scene":"Outro"}'],
  ]);
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  assert.equal(calls[1].init.credentials, "omit");

  globalThis.fetch = async () => new Response("<html>not camframe</html>");
  await assert.rejects(camframeCall("status"), /Not CamFrame/);
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(camframeCall("cue", { size: "full" }), /Failed to fetch/);
});

test("cue lines in plain words: what the camera does, and the line's other words", () => {
  assert.equal(cueWords({ size: "full" }), "face full");
  assert.equal(cueWords({ size: "small" }), "face small");
  assert.equal(cueWords({ size: "small", position: "bottom-right" }), "face small, bottom right");
  assert.equal(cueWords({ size: "small", scene: "Talking head" }), "Scene “Talking head”");
  assert.equal(cueRest("Share screen. Face small."), "Share screen.");
  assert.equal(cueRest("Stop share. Face full."), "Stop share.");
  assert.equal(cueRest("Face small, bottom right"), "");
  assert.equal(cueRest("Show code. FACE: Demo. Then smile!"), "Show code. Then smile!");
});

test("camframeAfterCheck: one missed check is not \"not found\"; several in a row are; an answer reconnects", () => {
  assert.equal(CAMFRAME_MISSES, 3);
  assert.deepEqual(CAMFRAME_RETRY_MS, [1000, 2000]);
  let s = camframeAfterCheck("on", 0, false);
  assert.deepEqual(s, { state: "reconnecting", misses: 1, retry: 1000 }, "one miss while connected: reconnecting, check again in a second");
  s = camframeAfterCheck(s.state, s.misses, true);
  assert.deepEqual(s, { state: "on", misses: 0, retry: -1 }, "the next answer: connected again, count reset");
  s = camframeAfterCheck("on", 0, false);
  s = camframeAfterCheck(s.state, s.misses, false);
  assert.deepEqual(s, { state: "reconnecting", misses: 2, retry: 2000 }, "a second miss waits a little longer");
  s = camframeAfterCheck(s.state, s.misses, false);
  assert.deepEqual(s, { state: "lost", misses: 3, retry: -1 }, "three in a row: not found, back to the usual checks");
  s = camframeAfterCheck(s.state, s.misses, false);
  assert.equal(s.state, "lost", "stays not found while CamFrame is gone");
  assert.deepEqual(camframeAfterCheck(s.state, s.misses, true), { state: "on", misses: 0, retry: -1 }, "CamFrame back: connected by itself");
  assert.deepEqual(camframeAfterCheck("looking", 0, false), { state: "looking", misses: 1, retry: 1000 }, "a first look that misses keeps looking");
  assert.equal(camframeAfterCheck("looking", 2, false).state, "lost");
});

// ---- Camera layouts: the two layout Scenes the Prompter saves in CamFrame (API 2) ----

// A status like CamFrame API 2's (docs/prompter-link-api.md in CamFrame), with `extra` on top.
const SMALL_DETAIL = { id: "a", name: "Live small corner", kind: "layout", size: 288, followsSmallSize: true, position: "bottom-right", savedSize: 288, keepsLiveLook: true };
const LARGE_DETAIL = { id: "b", name: "Live right large", kind: "layout", size: 432, followsSmallSize: false, position: "right", withinRight: 0.3, savedSize: 432, keepsLiveLook: true };
const api2 = (extra = {}) => ({ app: "camframe", version: "0.6.0", scenes: ["Interview"], api: 2, sceneLimit: 6, smallSize: 288, margin: 32, sceneDetails: [{ id: "i", name: "Interview", kind: "snapshot", size: 400, position: { x: 28, y: 104 } }], ...extra });

test("layoutsSupported: only a CamFrame with API 2 that lists its Scenes in full", () => {
  assert.equal(layoutsSupported(api2()), true);
  assert.equal(layoutsSupported({ app: "camframe", version: "0.5.0", scenes: ["Demo"] }), false, "an older CamFrame has no api field");
  assert.equal(layoutsSupported(api2({ api: 1 })), false);
  assert.equal(layoutsSupported({ app: "camframe", version: "0.6.0", scenes: [], api: 2 }), false, "a file:// copy gets only app, version, scenes and api (and may not save)");
  assert.equal(layoutsSupported(null), false);
  assert.equal(layoutsSupported(api2({ api: 3 })), true, "a later API keeps the same calls");
});

test("layoutWants: the small corner follows the small size; the large one is 1.5 times it, on the right, inside the right 30%", () => {
  assert.deepEqual(layoutWants(288), [
    { name: LAYOUT_SMALL, size: "small", position: "bottom-right" },
    { name: LAYOUT_LARGE, size: 432, position: "right", withinRight: 0.3 },
  ]);
  assert.equal(LAYOUT_SMALL, "Live small corner");
  assert.equal(LAYOUT_LARGE, "Live right large");
  assert.equal(layoutWants(300)[1].size, 450, "whatever small size CamFrame shows now");
  assert.equal(layoutWants(500)[1].size, 640, "never past CamFrame's largest camera");
  assert.equal(layoutWants(undefined)[1].size, 432, "no small size given: CamFrame's standard 288");
  for (const want of layoutWants(288)) assert.equal("replace" in want || "apply" in want, false, "never replaces or moves the camera by itself");
});

test("layoutMatches: same layout only when kind, size, place and right share agree", () => {
  const [small, large] = layoutWants(288);
  assert.equal(layoutMatches(SMALL_DETAIL, small), true);
  assert.equal(layoutMatches(LARGE_DETAIL, large), true);
  assert.equal(layoutMatches({ ...SMALL_DETAIL, followsSmallSize: false }, small), false, "a fixed 288 does not follow the small size");
  assert.equal(layoutMatches({ ...SMALL_DETAIL, position: "bottom-left" }, small), false);
  assert.equal(layoutMatches({ ...SMALL_DETAIL, withinRight: 0.5 }, small), false);
  assert.equal(layoutMatches({ ...SMALL_DETAIL, kind: "snapshot" }, small), false, "a Scene saved in CamFrame's own settings also sets the camera and look");
  assert.equal(layoutMatches({ ...LARGE_DETAIL, size: 400 }, large), false);
  assert.equal(layoutMatches({ ...LARGE_DETAIL, withinRight: undefined }, large), false);
  assert.equal(layoutMatches({ ...LARGE_DETAIL, followsSmallSize: true }, large), false);
  assert.equal(layoutMatches(undefined, large), false);
});

test("layoutPlan: what is saved, what is missing, what differs, and whether there is room", () => {
  const fresh = layoutPlan(api2());
  assert.deepEqual(fresh.rows.map((r) => [r.name, r.state]), [[LAYOUT_SMALL, "missing"], [LAYOUT_LARGE, "missing"]]);
  assert.deepEqual(fresh.save.map((s) => s.name), [LAYOUT_SMALL, LAYOUT_LARGE], "small first, while the camera is at its original size");
  assert.deepEqual(fresh.room, { has: 1, limit: 6, need: 2, ok: true, free: 5 });
  assert.equal(fresh.smallSize, 288);
  assert.equal(fresh.largeSize, 432);
  assert.equal(fresh.done, false);

  const both = layoutPlan(api2({ scenes: ["Interview", "Live small corner", "Live right large"], sceneDetails: [SMALL_DETAIL, LARGE_DETAIL] }));
  assert.deepEqual(both.rows.map((r) => r.state), ["ready", "ready"]);
  assert.deepEqual(both.save, []);
  assert.equal(both.done, true);
  assert.equal(both.room.ok, true);

  // Names match without regard to case, as in CamFrame.
  const lower = layoutPlan(api2({ scenes: ["live small corner"], sceneDetails: [{ ...SMALL_DETAIL, name: "live small corner" }] }));
  assert.deepEqual(lower.rows.map((r) => r.state), ["ready", "missing"]);
  assert.deepEqual(lower.save.map((s) => s.name), [LAYOUT_LARGE]);

  // Upper case too, whatever the user's language (toLocaleLowerCase would miss it in Turkish).
  assert.deepEqual(layoutPlan(api2({ scenes: ["LIVE SMALL CORNER"], sceneDetails: [{ ...SMALL_DETAIL, name: "LIVE SMALL CORNER" }] })).rows.map((r) => r.state), ["ready", "missing"]);

  // A small size of 0 or less is not a size: CamFrame's standard 288, the same for both numbers.
  for (const bad of [0, -5]) assert.deepEqual([layoutPlan(api2({ smallSize: bad })).smallSize, layoutPlan(api2({ smallSize: bad })).largeSize], [288, 432]);

  // A Scene of Lex's own with the same name is never saved over without asking.
  const other = layoutPlan(api2({ scenes: ["Live right large"], sceneDetails: [{ ...LARGE_DETAIL, kind: "snapshot" }] }));
  assert.deepEqual(other.rows.map((r) => r.state), ["missing", "different"]);
  assert.deepEqual(other.save.map((s) => s.name), [LAYOUT_SMALL], "only the missing one; the different one waits for a yes");
  assert.equal(other.done, false);

  // A small size that is not 288: the large one is 1.5 times it, and an older 432 Scene now differs.
  const smallOf300 = { smallSize: 300, scenes: ["Live small corner", "Live right large"], sceneDetails: [{ ...SMALL_DETAIL, size: 300 }, { ...LARGE_DETAIL, position: "left" }] };
  assert.equal(layoutPlan(api2(smallOf300)).rows[1].state, "different", "another place is not only a size change");
  assert.equal(layoutPlan(api2({ ...smallOf300, sceneDetails: [SMALL_DETAIL, { ...LARGE_DETAIL, kind: "snapshot" }] })).rows[1].state, "different", "a snapshot Scene is not this layout");
  assert.equal(layoutPlan(api2({ ...smallOf300, sceneDetails: [SMALL_DETAIL, { ...LARGE_DETAIL, followsSmallSize: true }] })).rows[1].state, "different");
  const bigger = layoutPlan(api2({ smallSize: 300, scenes: ["Live small corner", "Live right large"], sceneDetails: [{ ...SMALL_DETAIL, size: 300 }, LARGE_DETAIL] }));
  assert.equal(bigger.largeSize, 450);
  assert.deepEqual(bigger.rows.map((r) => r.state), ["ready", "resized"], "its own layout at an older size is not someone else's Scene");
  assert.equal(bigger.rows[1].saved, 432, "what was saved");
  assert.equal(bigger.done, true, "still saved and working, so nothing needs a look");
});

test("layoutPlan: never saves one of two and then runs out of room; blocks up front", () => {
  const five = ["A", "B", "C", "D", "E"];
  const full = layoutPlan(api2({ scenes: five, sceneDetails: five.map((name) => ({ name, kind: "snapshot" })) }));
  assert.deepEqual(full.room, { has: 5, limit: 6, need: 2, ok: false, free: 1 });
  assert.deepEqual(full.save, [], "nothing is saved without room for both");
  const fourPlusOne = ["A", "B", "C", "D", "Live small corner"];
  const roomForLarge = layoutPlan(api2({ scenes: fourPlusOne, sceneDetails: [...fourPlusOne.slice(0, 4).map((name) => ({ name, kind: "snapshot" })), SMALL_DETAIL] }));
  assert.equal(roomForLarge.room.ok, true, "one already there: one more fits");
  assert.deepEqual(roomForLarge.save.map((s) => s.name), [LAYOUT_LARGE]);
  const six = ["A", "B", "C", "D", "Live small corner", "Live right large"];
  assert.equal(layoutPlan(api2({ scenes: six, sceneDetails: [...six.slice(0, 4).map((name) => ({ name, kind: "snapshot" })), SMALL_DETAIL, LARGE_DETAIL] })).room.ok, true, "both there: nothing needed");
});

test("layoutProblem: CamFrame's refusals and a missed call in plain words", () => {
  assert.match(layoutProblem({ ok: false, body: { code: "scene-limit", error: "x" } }), /no room for another Scene\. Delete Scenes you do not use in CamFrame until one slot stays free/);
  assert.match(layoutProblem({ ok: false, body: { code: "scene-exists", error: "x" } }), /already has a Scene with this name/);
  assert.match(layoutProblem({ ok: false, body: { code: "not-ready", error: "x" } }), /CamFrame's window is not open yet/);
  assert.match(layoutProblem({ ok: false, body: { error: "Not allowed." } }), /CamFrame refused: Not allowed\./, "anything else: CamFrame's own words");
  assert.match(layoutProblem({ ok: false, body: {} }), /CamFrame refused/);
  assert.match(layoutProblem(null), /CamFrame did not answer while saving the layouts\. Turn the camera button off and on/);
  for (const answer of [null, { ok: false, body: { code: "scene-limit" } }, { ok: false, body: { code: "not-ready" } }]) assert.doesNotMatch(layoutProblem(answer), /Camera layouts again|Replace|Save/, "no word of a window that is gone");
});

test("layoutRoomWords: how many Scenes to delete in CamFrame, true also after another layout was saved", () => {
  assert.equal(layoutRoomWords({ has: 1, limit: 6, need: 2, ok: true, free: 5 }), "");
  assert.equal(layoutRoomWords({ has: 5, limit: 6, need: 2, ok: false, free: 1 }), "No room to save the layouts: CamFrame keeps at most 6 Scenes and has 5, and 2 more are needed, with one slot left free. Delete 2 Scenes you do not use in CamFrame, then turn the camera button in Settings off and on.");
  assert.match(layoutRoomWords({ has: 6, limit: 6, need: 1, ok: false, free: 0 }), /has 6, and 1 more is needed, with one slot left free\. Delete 2 Scenes /);
  assert.match(layoutRoomWords({ has: 6, limit: 6, need: 2, ok: false, free: 0 }), /Delete 3 Scenes /);
  assert.match(layoutRoomWords({ has: 8, limit: 6, need: 2, ok: false, free: 0 }), /has 8, .* Delete 5 Scenes /, "more Scenes than the limit: all of the extra ones count");
});

test("layoutPlan: both layouts ready needs no room, even with more Scenes than the limit", () => {
  const eight = ["A", "B", "C", "D", "E", "F"];
  const plan = layoutPlan(api2({ scenes: [...eight, "Live small corner", "Live right large"], sceneDetails: [...eight.map((name) => ({ name, kind: "snapshot" })), SMALL_DETAIL, LARGE_DETAIL] }));
  assert.equal(plan.room.ok, true);
  assert.equal(layoutRoomWords(plan.room), "");
});

test("layoutsWithSaved: CamFrame's yes counts when the check after it missed, without changing the old status", () => {
  const before = api2({ scenes: ["Interview", "live right large"], sceneDetails: [{ id: "i", name: "Interview", kind: "snapshot" }, { name: "live right large", kind: "snapshot" }] });
  const after = layoutsWithSaved(before, [SMALL_DETAIL, LARGE_DETAIL]);
  assert.deepEqual(after.scenes, ["Interview", "Live right large", "Live small corner"], "added, or replaced in place whatever the case");
  assert.deepEqual(layoutPlan(after).rows.map((r) => r.state), ["ready", "ready"]);
  assert.deepEqual(before.scenes, ["Interview", "live right large"], "the old status is left as it was");
  assert.equal(before.sceneDetails[1].kind, "snapshot");
});

test("layoutPlan: an automatic save always leaves a spare slot", () => {
  const scenes = (n) => Array.from({ length: n }, (_, k) => `S${k}`);
  const withScenes = (n) => api2({ scenes: scenes(n), sceneDetails: scenes(n).map((name) => ({ name, kind: "snapshot" })) });
  const three = layoutPlan(withScenes(3));
  assert.equal(three.tight, false, "3 + 2 = 5 of 6: one slot stays free");
  assert.deepEqual(three.auto.map((s) => s.name), [LAYOUT_SMALL, LAYOUT_LARGE]);
  const four = layoutPlan(withScenes(4));
  assert.equal(four.tight, true, "4 + 2 = 6 of 6: no slot left");
  assert.deepEqual(four.auto, [], "nothing saved by itself");
  const five = layoutPlan(withScenes(5));
  assert.equal(five.room.ok, false);
  assert.equal(five.tight, false, "no room at all is not the same as tight");
  const one = ["A", "B", "C", "D", "Live small corner"];
  const oneLeft = layoutPlan(api2({ scenes: one, sceneDetails: [...one.slice(0, 4).map((name) => ({ name, kind: "snapshot" })), SMALL_DETAIL] }));
  assert.equal(oneLeft.tight, true, "only the large one missing, and it would take the last slot");
  const both = layoutPlan(api2({ scenes: [...scenes(4), LAYOUT_SMALL, LAYOUT_LARGE], sceneDetails: [SMALL_DETAIL, LARGE_DETAIL] }));
  assert.equal(both.tight, false, "nothing missing: nothing to hold back, even when CamFrame is full");
});

test("layoutsLine: where the layouts stand, true for the status, with no word of a window", () => {
  const scenes = (n) => Array.from({ length: n }, (_, k) => `S${k}`);
  const withScenes = (n, extra = []) => api2({ scenes: [...scenes(n), ...extra.map((d) => d.name)], sceneDetails: [...scenes(n).map((name) => ({ name, kind: "snapshot" })), ...extra] });
  assert.equal(layoutsLine(null), "");
  assert.equal(layoutsLine(layoutPlan(withScenes(1, [SMALL_DETAIL, LARGE_DETAIL]))), "Camera layouts are saved in CamFrame's Scenes: Live small corner and Live right large.");
  assert.match(layoutsLine(layoutPlan(withScenes(1, [SMALL_DETAIL, { ...LARGE_DETAIL, size: 400 }]))), /saved in CamFrame's Scenes: .* Live right large is at 400 px, saved before the small camera changed\.$/);
  assert.equal(layoutsLine(layoutPlan(withScenes(1)), { saving: true }), "Saving the camera layouts in CamFrame…");
  assert.equal(layoutsLine(layoutPlan(withScenes(1)), { problem: "CamFrame refused: no." }), "CamFrame refused: no.");
  assert.match(layoutsLine(layoutPlan(withScenes(1, [SMALL_DETAIL]))), /^Not saved in CamFrame: Live right large\. Turn the camera button off and on to save it\.$/, "deleted later: nothing saves it before the next connect");
  assert.match(layoutsLine(layoutPlan(withScenes(4))), /^Not saved: Live small corner and Live right large\. Saving would fill CamFrame \(6 of 6 Scenes\) and leave no spare slot, so the Prompter waits\. Delete a Scene you do not use in CamFrame, then turn the camera button in Settings off and on\.$/);
  assert.match(layoutsLine(layoutPlan(withScenes(5))), /^No room to save the layouts: /);
  assert.match(layoutsLine(layoutPlan(withScenes(1, [{ name: LAYOUT_SMALL, kind: "snapshot" }, LARGE_DETAIL]))), /^CamFrame already has a different Scene named Live small corner; the Prompter leaves it alone, so the cue uses what CamFrame holds\.$/);
  for (const plan of [withScenes(4), withScenes(5), withScenes(1, [SMALL_DETAIL])]) assert.doesNotMatch(layoutsLine(layoutPlan(plan)), /Camera layouts window|Replace|press Save/i);
});

