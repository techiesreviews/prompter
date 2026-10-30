import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMFRAME_MISSES, CAMFRAME_ORIGIN, CAMFRAME_RETRY_MS, camframeAfterCheck, camframeCall, cueCrossing, cueReport, cueRest, cueWords } from "../src/camframe.mjs";
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

test("cueReport says what happened to a cue at the reading line", () => {
  const cue = { size: "small", position: "bottom-right" };
  assert.equal(cueReport("sent", cue), "CamFrame switched to face small, bottom right.");
  assert.equal(cueReport("refused", { size: "small", scene: "Demo" }, 'CamFrame has no Scene named "Demo".'), 'CamFrame did not switch to Scene “Demo”: CamFrame has no Scene named "Demo".');
  assert.equal(cueReport("refused", { size: "full" }), "CamFrame did not switch to face full: it refused the cue.");
  assert.match(cueReport("unreached", cue), /^Could not reach CamFrame to switch to face small, bottom right\. .*browser may have blocked it/);
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
