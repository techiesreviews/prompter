// The OBS link (src/obs.mjs) against a stand-in OBS WebSocket server (test/obs-standin.mjs, protocol v5,
// with and without a password), plus the plain helpers: scene and take names, the take memory and
// what the record light shows. Never a real OBS; the passwords here are made up for the test.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { createServer } from "node:net";
import {
  OBS_URL, OBS_PROTOCOL, addTake, clockText, isTakeName, obsAfterMiss, obsAuth, obsLink, readTakes, sceneOf, starTake,
  takeName, takeView, takesFor, videoKey, nextTake,
} from "../src/obs.mjs";
import { startObsStandin } from "./obs-standin.mjs";

const FAST = { retry: [30, 60], again: 120, wait: 400, newer: 50 };
const until = async (what, ms = 3000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => { setTimeout(done, 5); });
  }
};
// Every link a test makes is turned off at the end, also when the test failed half way.
const links = new Set();
after(() => { for (const l of links) l.turn(false); });
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

function link(obs, { password = "", ...more } = {}) {
  const ended = [];
  const recorded = []; // per take that ended: whether OBS ever recorded it
  const changes = [];
  const l = obsLink({
    WebSocket, subtle: webcrypto.subtle, url: `ws://127.0.0.1:${obs.port}`, delays: FAST,
    changed: () => changes.push(l.state), ended: (name, took) => { ended.push(name); recorded.push(took); }, ...more,
  });
  links.add(l);
  l.turn(true, password);
  return { l, ended, recorded, changes };
}

// ---------- names ----------

test("the page talks to OBS's own WebSocket server on this computer, as the CSP allows", () => {
  assert.equal(OBS_URL, "ws://127.0.0.1:4455");
  assert.equal(OBS_PROTOCOL, "obswebsocket.json");
});

test("a numbered section is a scene: its number and its title make the take's folder and file name", () => {
  const s = sceneOf("2 · What it really costs");
  assert.deepEqual([s.number, s.tag, s.base], [2, "S2", "02-what-it-really-costs"]);
  assert.equal(takeName(s, 3), "scenes/02-what-it-really-costs/scene-02-what-it-really-costs-take-03");
  assert.equal(takeName(sceneOf("12 · THE FIX"), 14), "scenes/12-the-fix/scene-12-the-fix-take-14");
  assert.equal(sceneOf("1 · ANSWER, DON'T RECITE").base, "01-answer-dont-recite", "apostrophes go, other marks are dashes");
  assert.equal(sceneOf("3 · Café crème & co.").base, "03-cafe-creme-co", "accents are dropped, never in a file name");
  assert.equal(sceneOf("4. Pace and pauses").base, "04-pace-and-pauses");
  const long = sceneOf("5 · A very long section title that goes on and on and on forever");
  assert.ok(long.base.length <= 43 && !long.base.endsWith("-"), long.base);
  assert.match(sceneOf("6 · ???").base, /^06-scene-[a-z0-9]{6}$/, "a title with no letters still names the scene");
  assert.ok(isTakeName(takeName(sceneOf("6 · ???"), 1)) && isTakeName(takeName(long, 1)), "still one of our names");
});

test("different titles never share a scene's takes, even when their file names would", () => {
  // Titles with no Latin letters, and long titles that start alike, each keep a folder of their own.
  const [a, b] = [sceneOf("开场介绍"), sceneOf("使用心得")];
  assert.notEqual(a.base, b.base);
  assert.match(a.base, /^00-scene-[a-z0-9]{6}$/);
  const start = "A very long unnumbered section title that starts the same way";
  const [c, d] = [sceneOf(`${start} and ends here`), sceneOf(`${start} but ends elsewhere`)];
  assert.notEqual(c.base, d.base);
  assert.ok(c.base.length <= 43 && d.base.length <= 43, `${c.base} ${d.base}`);
  // A title that mixes Latin words with others, or runs past 40 characters, never keeps the bare Latin part.
  const latin = "Opening and what this video covers";
  const [e, f] = [sceneOf(`${latin} 开场介绍`), sceneOf(`${latin} 使用心得`)];
  assert.ok(`${latin} 开场介绍`.length > 40 - 6, "titles close to the limit");
  assert.notEqual(e.base, f.base, `${e.base} ${f.base}`);
  assert.notEqual(sceneOf("Короткий INTRO").base, sceneOf("Другой INTRO").base, "short mixed titles too");
  const [g, h] = [sceneOf("A title that runs a little past forty chars!!"), sceneOf("A title that runs a little past forty chars??")];
  assert.notEqual(g.base, h.base, "a long title is marked even when its marks are what differ");
  assert.equal(sceneOf("开场介绍").base, a.base, "the same title is the same scene each time");
  assert.equal(sceneOf("INTRO").base, "00-intro", "a short Latin title keeps its plain name");
});

test("a section without a number is a scene too, shown by its name", () => {
  const s = sceneOf("INTRO");
  assert.deepEqual([s.number, s.tag, s.base], [0, "INTRO", "00-intro"]);
  assert.equal(sceneOf("A much longer unnumbered title").tag.length <= 14, true, "the tag stays short");
});

test("a take name is told apart from a name OBS or the person chose", () => {
  assert.equal(isTakeName("scenes/02-what-it-really-costs/scene-02-what-it-really-costs-take-03"), true);
  assert.equal(isTakeName("%CCYY-%MM-%DD %hh-%mm-%ss"), false);
  assert.equal(isTakeName(""), false);
  assert.equal(isTakeName(null), false);
});

test("the timer reads minutes and seconds", () => {
  assert.deepEqual([clockText(0), clockText(999), clockText(61_000), clockText(3_599_000), clockText(3_661_000)], ["00:00", "00:00", "01:01", "59:59", "1:01:01"]);
  assert.equal(clockText(-5), "00:00");
});

// ---------- takes and the best one ----------

test("takes are counted per scene of a script; the newest take is the best until another is starred", () => {
  const video = videoKey(["1 · Hook", "2 · What it really costs"]);
  let book = readTakes(null);
  assert.deepEqual(takesFor(book, video, "02-x"), { takes: [], best: 0 });
  book = addTake(book, video, "02-x", 1);
  book = addTake(book, video, "02-x", 2);
  assert.deepEqual(takesFor(book, video, "02-x"), { takes: [1, 2], best: 2 });
  book = starTake(book, video, "02-x", 1);
  assert.deepEqual(takesFor(book, video, "02-x"), { takes: [1, 2], best: 1 });
  book = addTake(book, video, "02-x", 3);
  assert.deepEqual(takesFor(book, video, "02-x"), { takes: [1, 2, 3], best: 3 }, "a new take carries the star again");
  assert.deepEqual(takesFor(book, video, "01-y"), { takes: [], best: 0 }, "other scenes are their own");
  assert.deepEqual(takesFor(book, videoKey(["1 · Other"]), "02-x"), { takes: [], best: 0 }, "another script has none of its own");
  assert.deepEqual(takesFor(readTakes(JSON.stringify(book)), video, "02-x"), { takes: [1, 2, 3], best: 3 }, "kept as text and read back");
  assert.deepEqual(starTake(book, video, "02-x", 9), book, "a take that does not exist cannot be starred");
  // Counting a given take: once, however often OBS's word about it arrives.
  assert.deepEqual(takesFor(addTake(book, video, "02-x", 4, 5), video, "02-x"), { takes: [1, 2, 3, 5], best: 5 }, "only the numbers this script recorded");
  assert.equal(addTake(book, video, "02-x", 4, 3), book, "a take already counted is not counted again");
});

test("damaged take memory reads as empty; only the latest scripts are kept", () => {
  for (const bad of ["", "{", "[]", "null", '{"videos":5}', '{"videos":{"a":{"scenes":{"b":{"takes":"x"}}}}}', '{"videos":{"a":{"scenes":{"b":{"takes":[0,-1,"2"]}}}}}']) {
    assert.deepEqual(takesFor(readTakes(bad), "a", "b"), { takes: [], best: 0 }, bad);
  }
  let book = readTakes(null);
  for (let i = 0; i < 30; i++) book = addTake(book, `v${i}`, "01-a", i);
  assert.ok(Object.keys(book.videos).length <= 20, "older scripts are let go");
  assert.deepEqual(takesFor(book, "v29", "01-a"), { takes: [1], best: 1 }, "the newest stays");
  assert.deepEqual(takesFor(book, "v0", "01-a"), { takes: [], best: 0 }, "the oldest went");
  // A scene folder's numbers never come back, even once every script that recorded them was let go.
  book = addTake(readTakes(null), "old", "05-kept", 1, 7);
  for (let i = 0; i < 25; i++) book = addTake(book, `w${i}`, "01-a", 2 + i);
  assert.ok(!Object.hasOwn(book.videos, "old"), "the old script was let go");
  assert.equal(nextTake(book, "05-kept"), 8, "the folder's take 7 is still above");
  assert.equal(nextTake(readTakes(JSON.stringify(book)), "05-kept"), 8, "also read back from the device");
  assert.equal(nextTake(readTakes('{"videos":{},"highest":{"05-kept":"7","06-x":-2}}'), "05-kept"), 1, "a damaged number is not one");
  assert.deepEqual(takesFor(readTakes('{"videos":{"a":{"at":1,"scenes":{"b":{"takes":[4,2,4],"best":9}}}}}'), "a", "b"), { takes: [2, 4], best: 4 }, "sorted, once each; a best not taken is the newest");
});

test("the light shows the take as the chosen mockup does", () => {
  // No take yet: take 1, no star.
  assert.deepEqual(takeView({ takes: [], best: 0 }, 0, false), { take: 1, star: "none" });
  // No take of this script yet, but the folder has takes from another: the take R records next.
  assert.deepEqual(takeView({ takes: [], best: 0 }, 0, false, 4), { take: 4, star: "none" });
  // While recording: the take being recorded, no star.
  assert.deepEqual(takeView({ takes: [1, 2], best: 2 }, 0, true), { take: 3, star: "none" });
  // After takes: the newest, starred when it is the best.
  assert.deepEqual(takeView({ takes: [1, 2], best: 2 }, 0, false), { take: 2, star: "on" });
  assert.deepEqual(takeView({ takes: [1, 2], best: 1 }, 0, false), { take: 2, star: "off" });
  assert.deepEqual(takeView({ takes: [4, 6], best: 6 }, 0, false, 7), { take: 6, star: "on" });
  // An older take picked on the rail; a number this script never recorded is not.
  assert.deepEqual(takeView({ takes: [1, 2, 3], best: 3 }, 1, false), { take: 1, star: "off" });
  assert.deepEqual(takeView({ takes: [1, 2, 3], best: 1 }, 1, false), { take: 1, star: "on" });
  assert.deepEqual(takeView({ takes: [4, 6], best: 6 }, 5, false, 7), { take: 6, star: "on" });
  assert.deepEqual(takeView({ takes: [1, 2, 3], best: 3 }, 1, true), { take: 4, star: "none" }, "recording shows the new take");
});

// ---------- the link's state ----------

test("one missed try is not 'not found'; several in a row are", () => {
  assert.deepEqual(obsAfterMiss("connecting", 0), { state: "connecting", misses: 1, retry: 0 });
  assert.deepEqual(obsAfterMiss("on", 0), { state: "reconnecting", misses: 1, retry: 0 });
  assert.deepEqual(obsAfterMiss("reconnecting", 1), { state: "reconnecting", misses: 2, retry: 1 });
  assert.deepEqual(obsAfterMiss("reconnecting", 2), { state: "lost", misses: 3, retry: -1 });
  assert.deepEqual(obsAfterMiss("lost", 3), { state: "lost", misses: 4, retry: -1 });
});

test("the password answer is OBS's own: base64 sha256 of the secret and salt, then with the challenge", async () => {
  const sha = (s) => createHash("sha256").update(s).digest("base64");
  const auth = { salt: "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", challenge: "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=" };
  assert.equal(await obsAuth("made-up-test-secret", auth, webcrypto.subtle), sha(sha("made-up-test-secret" + auth.salt) + auth.challenge));
});

test("OBS without a password: a take sets the name, records, gives OBS its own name back, and stops", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  assert.equal(l.state, "connecting");
  await until(() => l.state === "on");
  assert.equal(l.recording, false);
  const name = takeName(sceneOf("2 · What it really costs"), 3);
  assert.equal(await l.start(name), true);
  assert.deepEqual([l.recording, l.pending], [false, name], "OBS took the start: recording only once OBS says so");
  await until(() => l.recording);
  assert.deepEqual([l.take, l.pending, obs.record.active], [name, "", true]);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\02-what-it-really-costs\\scene-02-what-it-really-costs-take-03.mkv", "OBS records under the scene and take name");
  await until(() => obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  assert.ok(l.since > 0, "the timer has a start");
  // The order OBS was told: its name read once on connecting (none of ours left there), then read again,
  // the take's set, record, its own put back.
  const sets = obs.requests("SetProfileParameter").map((d) => d.requestData.parameterValue);
  assert.deepEqual(sets, [name, "%CCYY-%MM-%DD %hh-%mm-%ss"]);
  assert.deepEqual(obs.requests().map((d) => d.requestType).filter((x) => x !== "GetRecordStatus"), ["GetProfileParameter", "GetProfileParameter", "SetProfileParameter", "StartRecord", "SetProfileParameter"]);
  assert.equal(obs.seen.find((m) => m.op === 1).d.eventSubscriptions & 64, 64, "it hears OBS's recording events");
  assert.equal(await l.start(name), false, "a second start while recording does nothing");
  obs.stopLag = 200;
  assert.equal(await l.stop(), true);
  // OBS took the stop but is still finishing the file: the take goes on until OBS says it stopped.
  assert.deepEqual([l.recording, l.stopping, l.take], [true, true, name]);
  assert.deepEqual(ended, [], "not stopped before OBS says so");
  assert.equal(await l.stop(), true, "a second stop while stopping is taken, and sends nothing");
  assert.equal(obs.requests("StopRecord").length, 1);
  await until(() => !obs.record.active);
  await until(() => ended.length === 1);
  assert.deepEqual([l.recording, l.stopping, l.take], [false, false, null]);
  assert.deepEqual(ended, [name], "the take counts once");
  await sleep(50);
  assert.deepEqual(ended, [name], "OBS's stopped event does not count it again");
  l.turn(false);
  assert.equal(l.state, "off");
  await until(() => obs.clients() === 0);
});

test("OBS with a password: the right one connects and is never sent itself", async (t) => {
  const secret = "made-up-test-secret";
  const obs = await startObsStandin({ password: secret });
  t.after(() => obs.stop());
  const { l } = link(obs, { password: secret });
  await until(() => l.state === "on");
  assert.equal(JSON.stringify(obs.seen).includes(secret), false, "the password itself never goes over the wire");
  l.turn(false);
});

test("OBS with a password: a wrong one says so and does not keep trying", async (t) => {
  const obs = await startObsStandin({ password: "made-up-test-secret" });
  t.after(() => obs.stop());
  const { l } = link(obs, { password: "not-it" });
  await until(() => l.state === "wrong");
  await sleep(300);
  assert.equal(l.state, "wrong");
  assert.equal(obs.connections, 1, "a refused password is not tried again by itself");
  assert.equal(await l.start("scenes/01-a/scene-01-a-take-01"), false, "no take without a connection");
  // A new password tries again.
  l.turn(true, "made-up-test-secret");
  await until(() => l.state === "on");
  l.turn(false);
});

test("OBS with a password and none typed: asks for the password", async (t) => {
  const obs = await startObsStandin({ password: "made-up-test-secret" });
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "password");
  await sleep(300);
  assert.equal(l.state, "password");
  assert.equal(obs.connections, 1);
  assert.equal(obs.seen.some((m) => m.op === 1), false, "nothing is sent without a password");
  l.turn(false);
});

test("no OBS: tries again, then says not found, and keeps looking without stopping anything", async (t) => {
  const free = createServer();
  await new Promise((ok) => { free.listen(0, "127.0.0.1", ok); });
  const port = free.address().port;
  await new Promise((ok) => { free.close(ok); });
  const changes = [];
  const l = obsLink({ WebSocket, subtle: webcrypto.subtle, url: `ws://127.0.0.1:${port}`, delays: FAST, changed: () => changes.push(l.state) });
  links.add(l);
  l.turn(true, "");
  await until(() => l.state === "lost");
  assert.deepEqual([...new Set(changes)], ["connecting", "lost"], "one miss keeps connecting; three say not found");
  assert.equal(await l.start("scenes/01-a/scene-01-a-take-01"), false);
  assert.equal(await l.stop(), false);
  // OBS opens on that port: the usual look finds it.
  const obs = await startObsStandin({ port });
  t.after(() => obs.stop());
  await until(() => l.state === "on");
  l.turn(false);
});

test("a dropped connection mid-take reconnects by itself and the take goes on", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended, changes } = link(obs);
  await until(() => l.state === "on");
  const name = takeName(sceneOf("3 · The fix"), 1);
  await l.start(name);
  await until(() => obs.record.active);
  obs.drop();
  await until(() => l.state === "reconnecting");
  assert.equal(l.take, name, "the take is kept while it reconnects");
  await until(() => l.state === "on");
  assert.equal(l.recording, true, "still recording after the reconnect");
  assert.ok(changes.includes("reconnecting"));
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 1);
  assert.deepEqual(ended, [name]);
  l.turn(false);
});

test("a take OBS stopped while the connection was down counts once it is back", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  const name = takeName(sceneOf("3 · The fix"), 2);
  await l.start(name);
  await until(() => l.recording); // OBS said it records the take
  obs.drop();
  obs.press(false);
  await until(() => l.state === "on" && !l.recording);
  assert.deepEqual(ended, [name]);
  l.turn(false);
});

test("a recording started or stopped in OBS itself shows, but is no take", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  obs.press(true);
  await until(() => l.recording);
  assert.equal(l.take, null);
  obs.press(false);
  await until(() => !l.recording);
  assert.deepEqual(ended, []);
  // Our take stopped in OBS itself still counts.
  const name = takeName(sceneOf("1 · Hook"), 1);
  await l.start(name);
  await until(() => obs.record.active);
  obs.press(false);
  await until(() => ended.length === 1 && !l.recording);
  assert.deepEqual(ended, [name]);
  l.turn(false);
});

test("OBS refusing to record says so on the light and leaves OBS's own name as it was", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  obs.answer = (type) => (type === "StartRecord" ? { ok: false, code: 500, comment: "No output." } : null);
  assert.equal(await l.start(takeName(sceneOf("1 · Hook"), 1)), false);
  assert.equal(l.recording, false);
  assert.equal(l.problem, "start");
  await until(() => obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss"); // going back, not waited for by the start
  assert.deepEqual(ended, []);
  obs.answer = null;
  assert.equal(await l.start(takeName(sceneOf("1 · Hook"), 1)), true);
  assert.equal(l.problem, "", "a take that starts clears it");
  await l.stop();
  l.turn(false);
});

test("an OBS name left from a take that never finished is not kept as OBS's own", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  obs.record.format = "scenes/01-hook/scene-01-hook-take-04";
  const { l } = link(obs);
  await until(() => l.state === "on");
  await l.start(takeName(sceneOf("1 · Hook"), 5));
  await until(() => obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  await l.stop();
  l.turn(false);
});

test("a take's name left in OBS by a tab closed while the take waited goes back once the link connects with nothing of ours waiting", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  obs.record.format = takeName(sceneOf("3 · Left behind"), 2); // the tab before was closed before OBS began that take
  const { l } = link(obs);
  await until(() => l.state === "on");
  await until(() => obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  // A person's own format is left alone.
  obs.record.format = "my own %CCYY";
  l.turn(false);
  l.turn(true);
  await until(() => l.state === "on");
  await sleep(100);
  assert.equal(obs.record.format, "my own %CCYY");
  l.turn(false);
});

test("a start OBS never answers fails in time; the take's name stays while OBS may still begin, and a stop calls the take off", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended, recorded } = link(obs);
  await until(() => l.state === "on");
  obs.answer = (type) => (type === "StartRecord" ? { silent: true } : null);
  const name = takeName(sceneOf("1 · Hook"), 1);
  assert.equal(await l.start(name), false);
  assert.equal(l.problem, "start");
  await sleep(FAST.wait * 2 + 100);
  assert.deepEqual([l.maybe, l.recording, obs.record.format], [name, false, name], "OBS may still begin it: the take's name stays in OBS");
  assert.ok(obs.requests("GetRecordStatus").length >= 3, "OBS is asked again whether it records");
  assert.equal(await l.stop(), true, "a stop calls the take off");
  await until(() => ended.length === 1 && obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  assert.deepEqual([ended, l.maybe, l.recording, l.stopping, l.problem], [[name], "", false, false, ""], "the take is over, and OBS's own name is back");
  assert.deepEqual(recorded, [false], "OBS recorded nothing: the take is called off, never read out as stopped");
  l.turn(false);
});

test("turning the link off gives up a take whose start got no answer: OBS's own name goes back once the link is on again", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "on");
  obs.answer = (type) => (type === "StartRecord" ? { silent: true } : null);
  const name = takeName(sceneOf("1 · Hook"), 2);
  assert.equal(await l.start(name), false);
  assert.equal(l.maybe, name);
  l.turn(false);
  assert.equal(l.maybe, "", "the page is no longer told OBS may be recording it");
  obs.answer = null;
  l.turn(true, "");
  await until(() => l.state === "on" && obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  assert.deepEqual([l.recording, l.maybe], [false, ""]);
  l.turn(false);
});

// ---------- counting takes: every name OBS may have used is counted, once ----------

function counting(obs) {
  const began = [];
  return { began, ...link(obs, { began: (name) => began.push(name) }) };
}

test("a take counts once, as soon as OBS takes the start", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began } = counting(obs);
  await until(() => l.state === "on");
  const name = takeName(sceneOf("1 · Hook"), 1);
  assert.equal(await l.start(name), true);
  assert.deepEqual(began, [name]);
  await until(() => obs.record.active);
  await sleep(50);
  assert.deepEqual(began, [name], "OBS's started event does not count it again");
  await l.stop();
  obs.answer = (type) => (type === "StartRecord" ? { ok: false, code: 500, comment: "No output." } : null);
  assert.equal(await l.start(takeName(sceneOf("1 · Hook"), 2)), false);
  assert.deepEqual(began, [name], "a start OBS refused made no file: not counted");
  l.turn(false);
});

test("a take whose start OBS confirmed by its event counts, even when the answer is lost to a drop", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  // OBS starts recording and says so, then the connection drops before it answers the request.
  obs.answer = (type) => {
    if (type !== "StartRecord") return null;
    obs.press(true);
    setTimeout(() => obs.drop(), 10);
    return { silent: true };
  };
  const name = takeName(sceneOf("2 · Middle"), 1);
  assert.equal(await l.start(name), true, "OBS said it started: the take is on");
  assert.deepEqual(began, [name]);
  obs.answer = null;
  await until(() => l.state === "on" && l.recording);
  assert.equal(l.take, name, "back on, it is still our take");
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 1);
  assert.deepEqual(ended, [name]);
  l.turn(false);
});

test("a start whose answer never comes is counted, so its name is never used twice; back on, a running one is the take", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  // OBS starts recording, but neither its event nor its answer gets through before the drop.
  obs.answer = (type) => {
    if (type !== "StartRecord") return null;
    obs.record.active = true;
    obs.record.startedAt = Date.now();
    setTimeout(() => obs.drop(), 10);
    return { silent: true };
  };
  const name = takeName(sceneOf("2 · Middle"), 2);
  assert.equal(await l.start(name), false);
  assert.deepEqual(began, [name], "OBS may have started it: counted");
  obs.answer = null;
  await until(() => l.state === "on" && l.recording);
  assert.equal(l.take, name, "OBS was recording it after all");
  assert.equal(l.problem, "", "and the light no longer says it didn't start");
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 1);
  assert.deepEqual(ended, [name]);
  l.turn(false);
});

test("a stop asked while a start gets no answer before a drop still stops the take once OBS is back", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  // OBS starts recording, but neither its event nor its answer gets through; the stop comes meanwhile.
  obs.answer = (type) => {
    if (type !== "StartRecord") return null;
    obs.record.active = true;
    obs.record.startedAt = Date.now();
    setTimeout(() => obs.drop(), 60);
    return { silent: true };
  };
  const name = takeName(sceneOf("2 · Middle"), 3);
  const started = l.start(name);
  await until(() => obs.requests("StartRecord").length === 1);
  assert.equal(await l.stop(), true, "the stop is taken while the take is starting");
  assert.equal(await started, false);
  assert.deepEqual(began, [name]);
  obs.answer = null;
  await until(() => obs.requests("StopRecord").length === 1);
  await until(() => !obs.record.active && ended.length === 1);
  assert.deepEqual(ended, [name], "the take stopped once OBS was back");
  assert.equal(l.recording, false);
  l.turn(false);
});

test("a stop asked while a take is still starting stops it as soon as it has started", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  obs.answer = (type) => (type === "StartRecord" ? { delay: 150 } : null);
  const name = takeName(sceneOf("3 · End"), 1);
  const started = l.start(name);
  await until(() => obs.requests("StartRecord").length === 1);
  assert.equal(l.starting, name, "the take is starting");
  assert.equal(await l.stop(), true, "the stop is taken");
  assert.equal(await started, true);
  assert.deepEqual(began, [name], "OBS took it, so it counts");
  await until(() => ended.length === 1 && !obs.record.active);
  assert.equal(l.recording, false);
  assert.equal(obs.requests("StopRecord").length, 1, "OBS was told to stop");
  assert.deepEqual(ended, [name]);
  assert.equal(l.starting, "");
  // Asked before OBS was told to record: it never records.
  obs.answer = (type) => (type === "GetProfileParameter" ? { delay: 100 } : null);
  const second = l.start(takeName(sceneOf("3 · End"), 2));
  await until(() => l.starting);
  await l.stop();
  assert.equal(await second, false);
  assert.equal(obs.requests("StartRecord").length, 1, "no second StartRecord");
  assert.equal(l.problem, "", "not a trouble: it was called off");
  await until(() => obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  assert.deepEqual(began, [name]);
  l.turn(false);
});

test("the next take number stays above every take of that scene folder, also under an older version of the script", () => {
  let book = readTakes(null);
  assert.equal(nextTake(book, "02-x"), 1);
  book = addTake(book, "old-script", "02-x", 1);
  book = addTake(book, "old-script", "02-x", 2);
  book = addTake(book, "other", "03-y", 3);
  // A title fixed in another section: a new video key, the same folder on disk.
  assert.deepEqual(takesFor(book, "new-script", "02-x").takes, []);
  assert.equal(nextTake(book, "02-x"), 3, "never take-01 again: that file is there");
  assert.equal(nextTake(book, "03-y"), 2);
  book = addTake(book, "new-script", "02-x", 4, nextTake(book, "02-x"));
  assert.deepEqual(takesFor(book, "new-script", "02-x"), { takes: [3], best: 3 }, "the rail shows only this script's take, not the old version's");
  assert.equal(nextTake(book, "02-x"), 4);
  // Back to the old version: its next take is still above the new one's.
  book = addTake(book, "old-script", "02-x", 5, nextTake(book, "02-x"));
  assert.deepEqual(takesFor(book, "old-script", "02-x"), { takes: [1, 2, 4], best: 4 });
  assert.deepEqual(starTake(book, "old-script", "02-x", 3), book, "another script's take cannot be starred here");
});

test("a take started straight after a stop waits until OBS has really stopped, then records", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  obs.stopLag = 300; // OBS answers StopRecord before the recording has finished stopping
  const { l, began } = counting(obs);
  await until(() => l.state === "on");
  const first = takeName(sceneOf("2 · Middle"), 1);
  assert.equal(await l.start(first), true);
  // OBS said it started (its own file name is back): a stop now goes to OBS at once.
  await until(() => obs.record.active && l.recording && obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  assert.equal(await l.stop(), true);
  assert.equal(obs.requests("StopRecord").length, 1);
  const second = takeName(sceneOf("2 · Middle"), 2);
  assert.equal(await l.start(second), true, "the redo records");
  assert.equal(l.problem, "");
  await until(() => obs.record.active);
  assert.match(obs.record.path, /take-02\.mkv$/);
  assert.equal(obs.requests("StartRecord").length, 2, "never refused as still running");
  assert.deepEqual(began, [first, second]);
  // OBS's own file name is back after the redo too, and stays (the stop's put-back never undoes the redo's).
  await until(() => obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(obs.record.format, "%CCYY-%MM-%DD %hh-%mm-%ss");
  l.turn(false);
});

test("a stop asked while the connection is down goes to OBS once it is back, if OBS still records the take", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  const name = takeName(sceneOf("3 · The fix"), 4);
  await l.start(name);
  await until(() => obs.record.active && l.recording);
  obs.drop();
  await until(() => l.state === "reconnecting");
  assert.equal(await l.stop(), true, "taken while the connection is down (the reader moved to another scene)");
  assert.deepEqual([l.recording, l.stopping, l.take], [true, true, name], "Stopping shows while the stop waits for OBS");
  await until(() => obs.requests("StopRecord").length === 1);
  await until(() => !obs.record.active && ended.length === 1);
  assert.deepEqual(ended, [name]);
  assert.equal(l.recording, false);
  l.turn(false);
});

test("a stop slower than the usual wait: OBS is asked, and the take ends only once OBS no longer records", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  obs.stopLag = 1000; // FAST.wait is 400
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  const first = takeName(sceneOf("2 · Middle"), 1);
  await l.start(first);
  await until(() => obs.record.active && obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  const asked = obs.requests("GetRecordStatus").length;
  assert.equal(await l.stop(), true);
  const second = l.start(takeName(sceneOf("2 · Middle"), 2));
  await sleep(600);
  assert.ok(obs.requests("GetRecordStatus").length > asked, "OBS was asked after the usual wait");
  assert.deepEqual([l.recording, l.stopping, ended], [true, true, []], "still stopping while OBS records");
  assert.equal(obs.requests("StartRecord").length, 1, "the next take still waits");
  await until(() => ended.length === 1);
  assert.deepEqual(ended, [first]);
  assert.equal(await second, true, "the next take records once OBS has stopped");
  await until(() => obs.record.active);
  assert.match(obs.record.path, /take-02\.mkv$/);
  l.turn(false);
});

test("a start not answered on a connection still up is settled at once: OBS's own later recording is never taken for it", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  obs.answer = (type) => (type === "StartRecord" ? { silent: true } : null);
  const name = takeName(sceneOf("4 · Late"), 1);
  const started = l.start(name);
  await until(() => obs.requests("StartRecord").length === 1);
  assert.equal(await l.stop(), true, "a stop asked while it starts");
  assert.equal(await started, false);
  assert.deepEqual(began, [name], "OBS may have used the name: counted");
  await until(() => obs.requests("GetRecordStatus").length >= 2); // once at connect, once to settle
  await sleep(50);
  obs.answer = null;
  obs.press(true); // recorded later in OBS itself
  await until(() => l.recording);
  await sleep(50);
  assert.equal(l.take, null, "not taken for the take that never started");
  assert.equal(obs.requests("StopRecord").length, 0, "the person's own recording is not stopped");
  assert.equal(obs.record.active, true);
  obs.press(false);
  await until(() => !l.recording);
  assert.deepEqual(ended, []);
  // The same, but OBS did record the take: it is the take, and the stop asked goes to OBS.
  obs.answer = (type) => {
    if (type !== "StartRecord") return null;
    obs.record.active = true;
    obs.record.startedAt = Date.now();
    return { silent: true };
  };
  const other = takeName(sceneOf("4 · Late"), 2);
  const again = l.start(other);
  await until(() => obs.requests("StartRecord").length === 2);
  await l.stop();
  assert.equal(await again, false);
  obs.answer = null;
  await until(() => obs.requests("StopRecord").length === 1 && !obs.record.active && ended.length === 1);
  assert.deepEqual(ended, [other]);
  assert.equal(l.problem, "", "no trouble shown for a take that did record");
  l.turn(false);
});

test("turning the link off mid-take leaves OBS recording", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "on");
  await l.start(takeName(sceneOf("1 · Hook"), 1));
  await until(() => obs.record.active && l.recording);
  l.turn(false);
  await until(() => obs.clients() === 0);
  assert.equal(obs.requests("StopRecord").length, 0, "OBS was not told to stop");
  assert.equal(obs.record.active, true, "OBS goes on recording");
  assert.deepEqual([l.state, l.recording], ["off", false]);
});

test("a connection lost before OBS answered the start: the take's name stays after the reconnect, and OBS beginning then records the take", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  obs.answer = (type) => { if (type !== "StartRecord") return null; obs.answer = null; setTimeout(() => obs.drop(), 0); return { silent: true }; };
  const name = takeName(sceneOf("1 · Hook"), 1);
  assert.equal(await l.start(name), false);
  assert.deepEqual(began, [name], "OBS was asked to record: the name is used");
  await until(() => l.state === "on" && obs.clients() === 1);
  await sleep(FAST.wait + 150); // OBS was asked how things are, and asked again: it does not record yet
  assert.deepEqual([obs.record.active, obs.record.format, l.maybe], [false, name, name], "OBS may still begin the take: its name stays in OBS");
  obs.press(true); // OBS begins the recording it was asked for
  await until(() => l.recording);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\01-hook\\scene-01-hook-take-01.mkv", "the recording has the take's name");
  await until(() => obs.record.format === "%CCYY-%MM-%DD %hh-%mm-%ss");
  assert.deepEqual([l.take, l.maybe, l.problem], [name, "", ""], "it is the take, and no trouble shows");
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 1 && !obs.record.active);
  assert.deepEqual(ended, [name]);
  l.turn(false);
});

// ---------- a stop is held until OBS says it has stopped, also through a dropped connection ----------

const OWN_FORMAT = "%CCYY-%MM-%DD %hh-%mm-%ss";
// A take recording, OBS's own file name back in place: a stop now goes straight to OBS.
async function recordingTake(obs, l, title, take) {
  const name = takeName(sceneOf(title), take);
  assert.equal(await l.start(name), true);
  await until(() => obs.record.active && l.recording && obs.record.format === OWN_FORMAT);
  return name;
}

test("a stop lost to a dropped connection is kept: Stopping shows meanwhile, and OBS is told again once it is back", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  const name = await recordingTake(obs, l, "3 · The fix", 5);
  // The connection drops while OBS handles StopRecord: no answer, and OBS goes on recording.
  obs.answer = (type) => {
    if (type !== "StopRecord") return null;
    obs.answer = null;
    setTimeout(() => obs.drop(), 10);
    return { silent: true };
  };
  assert.equal(await l.stop(), true, "the stop is kept, not given up");
  assert.notEqual(l.state, "on");
  assert.deepEqual([l.recording, l.stopping, l.take, l.problem], [true, true, name, ""], "Stopping, with no trouble shown for the stop");
  await until(() => obs.requests("StopRecord").length === 2);
  await until(() => !obs.record.active && ended.length === 1);
  assert.deepEqual(ended, [name]);
  assert.deepEqual([l.state, l.recording, l.stopping, l.take], ["on", false, false, null]);
  l.turn(false);
});

test("a stop OBS took just before the connection dropped still shows Stopping, and the take ends once OBS is back", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  obs.stopLag = 250; // OBS is still finishing the file when the connection drops
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  const name = await recordingTake(obs, l, "3 · The fix", 6);
  assert.equal(await l.stop(), true);
  obs.drop();
  await until(() => l.state === "reconnecting");
  assert.deepEqual([l.recording, l.stopping, l.take], [true, true, name], "still Stopping through the drop");
  assert.deepEqual(ended, []);
  await until(() => ended.length === 1);
  await until(() => l.state === "on" && !obs.record.active);
  assert.deepEqual([l.recording, l.stopping, l.take], [false, false, null]);
  await sleep(350);
  assert.deepEqual(ended, [name], "counted once");
  l.turn(false);
});

test("a stop asked while OBS is not found is kept, shows Stopping, and stops the take once OBS is found again", async (t) => {
  let obs = await startObsStandin();
  t.after(() => obs.stop());
  const port = obs.port;
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  const name = await recordingTake(obs, l, "2 · Middle", 7);
  const since = obs.record.startedAt;
  await obs.stop();
  await until(() => l.state === "lost");
  assert.equal(await l.stop(), true, "taken while OBS is not found");
  assert.deepEqual([l.recording, l.stopping, l.take], [true, true, name]);
  assert.equal(await l.stop(), true, "a second press changes nothing");
  // OBS answers again, still recording that take.
  obs = await startObsStandin({ port });
  obs.record.active = true;
  obs.record.startedAt = since;
  l.retry();
  await until(() => obs.requests("StopRecord").length === 1 && !obs.record.active && ended.length === 1);
  assert.deepEqual(ended, [name]);
  await until(() => !l.recording);
  assert.deepEqual([l.state, l.stopping, l.take], ["on", false, null]);
  l.turn(false);
});

test("a status check OBS is slow to answer never ends Stopping early", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  obs.stopLag = 1500; // FAST.wait is 400: OBS is asked at 400 and has not answered by 800
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  const name = await recordingTake(obs, l, "2 · Middle", 8);
  assert.equal(await l.stop(), true);
  obs.answer = (type) => (type === "GetRecordStatus" ? { silent: true } : null);
  await sleep(1000);
  assert.ok(obs.requests("GetRecordStatus").length >= 2, "OBS was asked");
  assert.deepEqual([l.recording, l.stopping, ended], [true, true, []], "still Stopping while OBS records");
  obs.answer = null;
  await until(() => ended.length === 1);
  assert.deepEqual(ended, [name]);
  assert.deepEqual([l.recording, l.stopping], [false, false]);
  l.turn(false);
});

test("a kept stop never stops another recording: one begun in OBS after the stop was asked is left alone", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs, { delays: { ...FAST, retry: [300, 600] } });
  await until(() => l.state === "on");
  const name = await recordingTake(obs, l, "1 · Hook", 9);
  obs.drop();
  await until(() => l.state === "reconnecting");
  assert.equal(await l.stop(), true);
  // OBS had crashed. It is back, and the person records in OBS itself before the page has reconnected.
  await sleep(120);
  obs.record.active = false;
  obs.press(true);
  await until(() => l.state === "on" && ended.length === 1);
  await sleep(100);
  assert.deepEqual(ended, [name], "the take ended with the crash");
  assert.equal(obs.requests("StopRecord").length, 0, "the person's own recording is not stopped");
  assert.deepEqual([obs.record.active, l.recording, l.stopping, l.take], [true, true, false, null], "it shows as OBS's own recording");
  l.turn(false);
});

test("a stop asked for a start OBS never answered stops no other recording: one begun in OBS later is left alone", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const began = [];
  const { l, ended } = link(obs, { delays: { ...FAST, retry: [300, 600] }, began: (name) => began.push(name) });
  await until(() => l.state === "on");
  // OBS never takes the start (it hangs, then goes away); the stop comes while the page still waits.
  obs.answer = (type) => {
    if (type !== "StartRecord") return null;
    setTimeout(() => obs.drop(), 60);
    return { silent: true };
  };
  const name = takeName(sceneOf("2 · Middle"), 5);
  const started = l.start(name);
  await until(() => obs.requests("StartRecord").length === 1);
  assert.equal(await l.stop(), true, "the stop is taken while the take is starting");
  assert.equal(await started, false);
  obs.answer = null;
  // OBS is back, and the person records in OBS itself before the page has reconnected.
  await sleep(120);
  obs.press(true);
  await until(() => l.state === "on" && l.recording);
  await sleep(100);
  assert.equal(obs.requests("StopRecord").length, 0, "the person's own recording is not stopped");
  assert.deepEqual([obs.record.active, l.recording, l.stopping, l.take], [true, true, false, null], "it shows as OBS's own recording, not as the take");
  assert.deepEqual([began, ended], [[name], []], "the name stays counted, and no take ended");
  // The old stop is gone: a stop now is the person's own and stops that recording.
  assert.equal(await l.stop(), true);
  await until(() => !obs.record.active && !l.recording);
  l.turn(false);
});

// A start OBS never answered, then the connection dropped: `recording` says what OBS does for the stop
// asked only after that drop.
async function unansweredStart(t, title, take, recording) {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const began = [];
  const { l, ended, recorded } = link(obs, { delays: { ...FAST, retry: [300, 600] }, began: (name) => began.push(name) });
  await until(() => l.state === "on");
  obs.answer = (type) => {
    if (type !== "StartRecord") return null;
    if (recording) { obs.record.active = true; obs.record.startedAt = Date.now(); }
    setTimeout(() => obs.drop(), 10);
    return { silent: true };
  };
  const name = takeName(sceneOf(title), take);
  assert.equal(await l.start(name), false);
  obs.answer = null;
  assert.deepEqual([l.state, l.recording, l.maybe], ["reconnecting", false, name], "OBS may be recording it: the page is told which take");
  return { obs, l, ended, recorded, began, name };
}

test("a stop asked after an unanswered start dropped the connection is kept, and stops the take once OBS is back", async (t) => {
  const { obs, l, ended, recorded, began, name } = await unansweredStart(t, "2 · Middle", 6, true);
  assert.equal(await l.stop(), true, "the stop is kept while OBS is out of reach");
  assert.equal(l.stopping, true, "and Stopping shows meanwhile");
  assert.equal(await l.stop(), true, "a second stop sends nothing more");
  await until(() => obs.requests("StopRecord").length === 1);
  await until(() => !obs.record.active && ended.length === 1);
  assert.deepEqual([ended, began], [[name], [name]], "the take stopped once OBS was back, and counts once");
  assert.deepEqual(recorded, [true], "OBS took the stop: it recorded the take");
  assert.deepEqual([l.recording, l.stopping, l.take, l.maybe], [false, false, null, ""]);
  await sleep(100);
  assert.equal(obs.requests("StopRecord").length, 1, "OBS is told once");
  l.turn(false);
});

test("a stop kept for an unanswered start that OBS never recorded ends without a word to OBS", async (t) => {
  const { obs, l, ended, recorded, name } = await unansweredStart(t, "2 · Middle", 7, false);
  assert.equal(await l.stop(), true);
  assert.equal(l.stopping, true);
  await until(() => l.state === "on" && !l.stopping);
  await sleep(100);
  assert.equal(obs.requests("StopRecord").length, 0, "nothing to stop");
  assert.deepEqual([l.recording, l.take, l.maybe, l.problem], [false, null, "", ""]);
  assert.deepEqual(ended, [name], "the page hears that the take is over");
  assert.deepEqual(recorded, [false], "and that OBS never recorded it");
  l.turn(false);
});

test("a stop kept for an unanswered start stops no other recording: one begun in OBS later is left alone", async (t) => {
  const { obs, l, ended, name } = await unansweredStart(t, "2 · Middle", 8, false);
  assert.equal(await l.stop(), true);
  // OBS is back, and the person records in OBS itself before the page has reconnected.
  await sleep(120);
  obs.press(true);
  await until(() => l.state === "on" && l.recording);
  await sleep(100);
  assert.equal(obs.requests("StopRecord").length, 0, "the person's own recording is not stopped");
  assert.deepEqual([obs.record.active, l.recording, l.stopping, l.take, l.maybe], [true, true, false, null, ""], "it shows as OBS's own recording, not as the take");
  assert.deepEqual(ended, [name], "the take the stop was asked for is over");
  obs.press(false);
  await until(() => !l.recording);
  l.turn(false);
});

test("OBS's own name still on its way back never lands on the next take's name", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "on");
  // OBS is slow to put its own name back after take 1, and slow to begin take 2: without waiting for
  // the first, it would land between naming take 2 and the start of its recording.
  obs.answer = (type, data) => (type === "SetProfileParameter" && data.parameterValue === OWN_FORMAT ? { delay: 250 } : null);
  const one = takeName(sceneOf("3 · Twice"), 1);
  assert.equal(await l.start(one), true);
  await until(() => obs.record.active);
  assert.equal(await l.stop(), true);
  await until(() => !obs.record.active && !l.recording && !l.pending && !l.stopping);
  obs.startLag = 400;
  const two = takeName(sceneOf("3 · Twice"), 2);
  assert.equal(await l.start(two), true);
  await until(() => obs.record.active);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\03-twice\\scene-03-twice-take-02.mkv", "take 2 records under its own name");
  await until(() => obs.record.format === OWN_FORMAT);
  assert.equal(await l.stop(), true);
  await until(() => !obs.record.active && !l.recording && !l.pending && !l.stopping);
  l.turn(false);
});

test("OBS's own name put back slower than the usual wait still never lands on the next take's name", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "on");
  // OBS answers the put-back after take 1 only after the usual wait (FAST.wait is 400), and still does it:
  // the next take's name must not be set until that write has been answered.
  obs.answer = (type, data) => (type === "SetProfileParameter" && data.parameterValue === OWN_FORMAT ? { delay: 650 } : null);
  const one = takeName(sceneOf("3 · Slow back"), 1);
  assert.equal(await l.start(one), true);
  await until(() => obs.record.active);
  assert.equal(await l.stop(), true);
  await until(() => !obs.record.active && !l.recording && !l.pending && !l.stopping);
  obs.startLag = 300;
  const two = takeName(sceneOf("3 · Slow back"), 2);
  assert.equal(await l.start(two), true);
  await until(() => obs.record.active, 4000);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\03-slow-back\\scene-03-slow-back-take-02.mkv", "take 2 records under its own name");
  await until(() => obs.record.format === OWN_FORMAT, 4000);
  assert.equal(await l.stop(), true);
  await until(() => !obs.record.active && !l.recording && !l.pending && !l.stopping);
  l.turn(false);
});

test("R calls off a take waiting for OBS's own name to go back, however slow OBS is to answer it", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "on");
  obs.answer = (type, data) => (type === "SetProfileParameter" && data.parameterValue === OWN_FORMAT ? { delay: 3000 } : null);
  const one = takeName(sceneOf("6 · Held"), 1);
  assert.equal(await l.start(one), true);
  await until(() => obs.record.active);
  assert.equal(await l.stop(), true);
  await until(() => !obs.record.active && !l.recording && !l.pending && !l.stopping);
  const two = takeName(sceneOf("6 · Held"), 2);
  const began = Date.now();
  const started = l.start(two);
  await sleep(100);
  assert.equal(l.starting, two, "take 2 waits for the put-back");
  assert.equal(await l.stop(), true);
  assert.equal(await started, false, "called off");
  assert.ok(Date.now() - began < 1000, `well before OBS answers (${Date.now() - began} ms)`);
  assert.equal(obs.requests("StartRecord").length, 1, "OBS was never asked to record take 2");
  assert.ok(!obs.requests("SetProfileParameter").some((d) => d.requestData.parameterValue === two), "take 2's name was never set");
  l.turn(false);
});

test("a start whose take name OBS never answers ends in time, even while OBS's own name is slow to go back", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "on");
  const name = takeName(sceneOf("7 · Stuck"), 1);
  obs.answer = (type, data) => (type === "SetProfileParameter" ? (data.parameterValue === name ? { silent: true } : { delay: 2 * FAST.wait }) : null);
  const began = Date.now();
  const started = l.start(name);
  await until(() => l.starting === "", 4 * FAST.wait);
  assert.ok(Date.now() - began < FAST.wait + 300, `Starting ends soon after the usual wait (${Date.now() - began} ms)`);
  assert.equal(await started, false);
  await until(() => obs.record.format === OWN_FORMAT, 4000);
  l.turn(false);
});

test("a take OBS began and stopped before its answer to the start came is over: the late answer never brings it back", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended, recorded } = link(obs);
  await until(() => l.state === "on");
  obs.answer = (type) => (type === "StartRecord" ? { late: 300 } : null);
  const one = takeName(sceneOf("4 · Quick"), 1);
  const started = l.start(one);
  await until(() => obs.record.active);
  obs.press(false); // stopped in OBS itself before OBS's answer to the start arrives
  await until(() => ended.length === 1);
  assert.equal(await started, true, "OBS took the start");
  assert.deepEqual([ended, recorded], [[one], [true]], "the take ended once, recorded");
  assert.deepEqual([l.recording, l.pending, l.starting, l.take], [false, "", "", null], "nothing waits after the late answer");
  obs.answer = null;
  const two = takeName(sceneOf("4 · Quick"), 2);
  assert.equal(await l.start(two), true, "the next take starts");
  await until(() => obs.record.active && l.recording && l.take === two);
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 2);
  l.turn(false);
});

test("OBS takes the start but begins late: its own name goes back only once it records", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  obs.startLag = 1000; // FAST.wait is 400: OBS is asked at 400 and at 800, and does not record yet
  const name = takeName(sceneOf("5 · Slow"), 1);
  assert.equal(await l.start(name), true);
  await sleep(900);
  assert.equal(obs.record.active, false);
  assert.equal(obs.record.format, name, "the take's name stays until OBS records");
  assert.ok(obs.requests("GetRecordStatus").length >= 3, "OBS was asked whether it records");
  await until(() => obs.record.active);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\05-slow\\scene-05-slow-take-01.mkv", "the late recording has the take's name");
  await until(() => obs.record.format === OWN_FORMAT);
  assert.deepEqual([l.recording, l.take, began], [true, name, [name]]);
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 1);
  l.turn(false);
});

test("OBS's started word is lost: asked after the usual wait, OBS records, and its own name goes back", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "on");
  obs.startLag = null; // the stand-in sends no started word by itself
  const name = takeName(sceneOf("5 · Slow"), 2);
  assert.equal(await l.start(name), true);
  // OBS records, but its word that it started never reaches the page.
  obs.record.active = true;
  obs.record.startedAt = Date.now();
  assert.equal(obs.record.format, name);
  await until(() => obs.record.format === OWN_FORMAT);
  assert.deepEqual([l.recording, l.take], [true, name]);
  assert.ok(obs.requests("GetRecordStatus").length >= 2, "OBS was asked whether it records");
  l.turn(false);
});

test("a take OBS took but never began is called off by a stop: OBS's own name goes back", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = counting(obs);
  await until(() => l.state === "on");
  obs.startLag = null; // OBS takes the start and never records (it shows a warning instead)
  const name = takeName(sceneOf("5 · Slow"), 3);
  assert.equal(await l.start(name), true);
  assert.equal(await l.stop(), true, "the stop is taken");
  await until(() => ended.length === 1);
  assert.deepEqual([ended, l.recording, l.pending, l.take, l.stopping, l.problem], [[name], false, "", null, false, ""], "the take is over");
  await until(() => obs.record.format === OWN_FORMAT);
  assert.equal(obs.requests("StopRecord").length, 0, "OBS records nothing: nothing to stop");
  l.turn(false);
});

// ---------- a stop asked for a take OBS took but has not begun yet is held like any other ----------

test("a stop asked before OBS says the take began shows Stopping at once, and reaches OBS once the take has begun", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  obs.startLag = 250; // well over FAST.newer: on a connection still up the page hears that it is this take
  const name = takeName(sceneOf("6 · Late start"), 3);
  assert.equal(await l.start(name), true);
  assert.equal(await l.stop(), true, "the stop is taken");
  assert.deepEqual([l.stopping, l.recording, l.pending], [true, false, name], "Stopping shows at once, for the take OBS has not begun yet");
  assert.equal(obs.requests("StopRecord").length, 0, "nothing to stop yet: OBS has not begun");
  await until(() => ended.length === 1 && !obs.record.active);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\06-late-start\\scene-06-late-start-take-03.mkv", "the take was recorded under its name");
  assert.equal(obs.requests("StopRecord").length, 1, "the stop reached OBS once the take had begun");
  assert.deepEqual([ended, l.recording, l.stopping], [[name], false, false]);
  await until(() => obs.record.format === OWN_FORMAT);
  l.turn(false);
});

test("a stop asked for a take OBS took but had not begun when the connection dropped stops no other recording: one begun in OBS later is left alone", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs, { delays: { ...FAST, retry: [300, 600] } });
  await until(() => l.state === "on");
  obs.startLag = null; // OBS takes the start, and has not begun when the connection drops
  const name = takeName(sceneOf("6 · Late start"), 4);
  assert.equal(await l.start(name), true);
  obs.drop();
  await until(() => l.state === "reconnecting");
  assert.equal(await l.stop(), true, "the stop is taken");
  assert.deepEqual([l.stopping, l.pending], [true, name], "Stopping shows at once, also with OBS out of reach");
  // The take never began. The person records in OBS itself, well after the stop was asked (FAST.newer
  // is 50), before the page has reconnected.
  await sleep(120);
  obs.press(true);
  await until(() => l.state === "on" && ended.length === 1);
  await sleep(100);
  assert.deepEqual(ended, [name], "the take is over");
  assert.equal(obs.requests("StopRecord").length, 0, "the person's own recording is not stopped");
  assert.deepEqual([obs.record.active, l.recording, l.stopping, l.take], [true, true, false, null], "it shows as OBS's own recording");
  await until(() => obs.record.format === OWN_FORMAT);
  l.turn(false);
});

test("a stop asked while the take was still starting, then a drop before OBS began: a recording begun in OBS later is left alone", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs, { delays: { ...FAST, retry: [300, 600] } });
  await until(() => l.state === "on");
  obs.startLag = null;
  obs.answer = (type) => (type === "StartRecord" ? { delay: 100 } : null);
  const name = takeName(sceneOf("6 · Late start"), 5);
  const started = l.start(name);
  await until(() => obs.requests("StartRecord").length === 1);
  assert.equal(await l.stop(), true, "the stop is taken while the take starts");
  assert.equal(await started, true);
  assert.deepEqual([l.stopping, l.pending], [true, name], "OBS took the start: the stop is held, and Stopping shows");
  obs.drop();
  await until(() => l.state === "reconnecting");
  await sleep(120);
  obs.press(true);
  await until(() => l.state === "on" && ended.length === 1);
  await sleep(100);
  assert.equal(obs.requests("StopRecord").length, 0, "the person's own recording is not stopped");
  assert.deepEqual([obs.record.active, l.recording, l.stopping, l.take, ended], [true, true, false, null, [name]]);
  l.turn(false);
});

test("a stop asked for a take OBS took, then a drop: the take OBS begins soon after is stopped once OBS is back, and one it never began is called off", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs, { delays: { ...FAST, retry: [300, 600], newer: 2000 } });
  await until(() => l.state === "on");
  obs.startLag = 150; // OBS begins while the page is still out of reach
  const name = takeName(sceneOf("6 · Late start"), 6);
  assert.equal(await l.start(name), true);
  obs.drop();
  await until(() => l.state === "reconnecting");
  assert.equal(await l.stop(), true);
  assert.equal(l.stopping, true);
  await until(() => ended.length === 1 && !obs.record.active);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\06-late-start\\scene-06-late-start-take-06.mkv", "it was that take");
  assert.equal(obs.requests("StopRecord").length, 1, "the stop reached OBS once it was back");
  assert.deepEqual([ended, l.recording, l.stopping], [[name], false, false]);
  await until(() => obs.record.format === OWN_FORMAT);
  // The same, and OBS never begins: back on, OBS records nothing, so the take is called off.
  obs.startLag = null;
  const next = takeName(sceneOf("6 · Late start"), 7);
  assert.equal(await l.start(next), true);
  obs.drop();
  await until(() => l.state === "reconnecting");
  assert.equal(await l.stop(), true);
  await until(() => l.state === "on" && ended.length === 2);
  assert.deepEqual([ended, l.recording, l.stopping, l.take], [[name, next], false, false, null]);
  assert.equal(obs.requests("StopRecord").length, 1, "no second stop: OBS recorded nothing");
  await until(() => obs.record.format === OWN_FORMAT);
  l.turn(false);
});

// ---------- the take's name is kept until OBS records: through a reconnect, and a start not answered yet ----------

test("a connection lost after OBS took the start, before it began recording: the take keeps its name, and a stop reaches it", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  obs.startLag = 700; // OBS begins well after the page has reconnected
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  const name = takeName(sceneOf("6 · Late start"), 2);
  assert.equal(await l.start(name), true);
  obs.drop();
  await until(() => l.state === "reconnecting");
  await until(() => l.state === "on");
  await sleep(100); // OBS was asked how things are: it does not record yet
  assert.equal(obs.record.active, false);
  assert.deepEqual([obs.record.format, l.recording, l.pending, ended], [name, false, name, []], "the take still waits for OBS to begin: its name stays in OBS");
  await until(() => obs.record.active);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\06-late-start\\scene-06-late-start-take-02.mkv", "the recording has the take's name");
  await until(() => obs.record.format === OWN_FORMAT);
  assert.deepEqual([l.recording, l.take, began, ended], [true, name, [name], []]);
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 1 && !obs.record.active);
  assert.deepEqual(ended, [name]);
  assert.equal(obs.requests("StopRecord").length, 1, "the stop reached OBS");
  l.turn(false);
});

test("OBS answers a start only after the usual wait: the recording still gets the take's name, and a stop reaches it", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  obs.answer = (type) => (type === "StartRecord" ? { delay: FAST.wait + 250 } : null);
  const name = takeName(sceneOf("6 · Late answer"), 1);
  assert.equal(await l.start(name), false, "no answer within the usual wait");
  obs.answer = null;
  assert.equal(l.problem, "start");
  await until(() => obs.record.active);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\06-late-answer\\scene-06-late-answer-take-01.mkv", "the recording has the take's name");
  await until(() => l.recording && obs.record.format === OWN_FORMAT);
  assert.deepEqual([l.take, l.maybe, l.problem, began], [name, "", "", [name]], "it is the take, and no trouble shows");
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 1 && !obs.record.active);
  assert.deepEqual(ended, [name]);
  assert.equal(obs.requests("StopRecord").length, 1, "the stop reached OBS");
  l.turn(false);
});

test("OBS slow to say how things are after a reconnect: a take still waiting to begin is asked about again", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  obs.startLag = null; // the stand-in sends no started word by itself
  const { l, ended } = link(obs, { delays: { ...FAST, retry: [500, 600] } });
  await until(() => l.state === "on");
  const name = takeName(sceneOf("6 · Late start"), 3);
  assert.equal(await l.start(name), true);
  obs.drop();
  // The page is back only after its usual look at OBS came due, and OBS does not answer the first look.
  obs.answer = (type) => { if (type !== "GetRecordStatus") return null; obs.answer = null; return { silent: true }; };
  await until(() => l.state === "reconnecting");
  await until(() => l.state === "on" && obs.answer === null);
  // OBS records, and its word that it started never reaches the page.
  obs.record.active = true;
  obs.record.startedAt = Date.now();
  await until(() => obs.record.format === OWN_FORMAT);
  assert.deepEqual([l.recording, l.take, ended], [true, name, []], "asked again, OBS records: it is the take");
  l.turn(false);
});

test("OBS slow to say how things are after a start it never answered: asked again, and the take is found once it records", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "on");
  obs.answer = (type) => (type === "StartRecord" || type === "GetRecordStatus" ? { silent: true } : null);
  const name = takeName(sceneOf("6 · Late answer"), 2);
  assert.equal(await l.start(name), false);
  await until(() => obs.requests("GetRecordStatus").length >= 2); // once at connect, once after the start
  obs.answer = null;
  // OBS records, and its word that it started never reaches the page.
  obs.record.active = true;
  obs.record.startedAt = Date.now();
  await until(() => l.recording);
  assert.deepEqual([l.take, l.maybe, l.problem], [name, "", ""], "asked again, OBS records: it is the take");
  await until(() => obs.record.format === OWN_FORMAT);
  l.turn(false);
});

test("a drop while the next take waits on a stop: the waiting take is called off, and the stop still reaches OBS", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, began, ended } = counting(obs);
  await until(() => l.state === "on");
  const first = await recordingTake(obs, l, "2 · Middle", 1);
  obs.answer = (type) => {
    if (type !== "StopRecord") return null;
    obs.answer = null;
    setTimeout(() => obs.drop(), 30);
    return { silent: true };
  };
  const stopped = l.stop();
  const second = l.start(takeName(sceneOf("2 · Middle"), 2)); // R again, while the stop is under way
  assert.equal(await stopped, true);
  assert.equal(await second, false, "the waiting take is called off by the drop");
  await until(() => obs.requests("StopRecord").length === 2 && !obs.record.active && ended.length === 1);
  assert.deepEqual([began, ended], [[first], [first]]);
  assert.equal(obs.requests("StartRecord").length, 1, "the take that waited never recorded");
  await until(() => !l.recording);
  assert.deepEqual([l.stopping, l.starting], [false, ""]);
  l.turn(false);
});

test("OBS refusing a stop says so and lets the stop go; OBS saying nothing records ends the take", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  const name = await recordingTake(obs, l, "1 · Hook", 2);
  obs.answer = (type) => (type === "StopRecord" ? { ok: false, code: 500, comment: "Not now." } : null);
  assert.equal(await l.stop(), false);
  assert.deepEqual([l.recording, l.stopping, l.problem, l.take], [true, false, "stop", name]);
  // 501 is obs-websocket's "output not running": the recording had stopped already.
  obs.answer = (type) => (type === "StopRecord" ? { ok: false, code: 501, comment: "Recording is not active." } : null);
  assert.equal(await l.stop(), true);
  assert.deepEqual([l.recording, l.stopping, l.problem, l.take], [false, false, "", null]);
  assert.deepEqual(ended, [name]);
  l.turn(false);
});

test("a stop of OBS's own recording: whenStopped waits until OBS has really stopped; with OBS out of reach it is not kept", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  obs.stopLag = 200;
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  obs.press(true); // recorded in OBS itself
  await until(() => l.recording);
  assert.equal(await l.stop(), true);
  assert.deepEqual([l.recording, l.stopping, obs.record.active], [true, true, true]);
  await l.whenStopped();
  assert.deepEqual([l.recording, l.stopping, obs.record.active], [false, false, false]);
  await l.whenStopped(); // nothing stopping: at once
  // Out of reach, the page cannot know whether OBS still records its own recording: no stop is kept.
  obs.press(true);
  await until(() => l.recording);
  obs.drop();
  await until(() => l.state === "reconnecting");
  assert.equal(await l.stop(), false);
  assert.equal(l.stopping, false);
  await until(() => l.state === "on");
  await sleep(100);
  assert.equal(obs.requests("StopRecord").length, 1, "only the first stop went to OBS");
  assert.deepEqual([obs.record.active, ended], [true, []]);
  l.turn(false);
});

test("turning the link off lets a kept stop go: OBS is left as it is", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  await recordingTake(obs, l, "1 · Hook", 3);
  obs.drop();
  await until(() => l.state === "reconnecting");
  assert.equal(await l.stop(), true);
  assert.equal(l.stopping, true);
  l.turn(false);
  assert.deepEqual([l.state, l.recording, l.stopping], ["off", false, false]);
  await l.whenStopped();
  l.turn(true, "");
  await until(() => l.state === "on" && l.recording);
  await sleep(100);
  assert.equal(obs.requests("StopRecord").length, 0, "the stop let go is not sent after all");
  assert.deepEqual([obs.record.active, l.take, ended], [true, null, []]);
  l.turn(false);
});

// ---------- recording only once OBS says so (OBS takes a start before the recording begins) ----------

test("a take OBS took and has not begun is not recording yet: only once OBS says it began, and the time counts from then", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  obs.startLag = 250;
  const name = takeName(sceneOf("7 · Wait for OBS"), 1);
  const asked = Date.now();
  assert.equal(await l.start(name), true, "OBS took the start");
  assert.deepEqual([l.recording, l.pending, l.take, l.starting], [false, name, null, ""], "taken, not begun: not recording yet");
  assert.equal(await l.start(takeName(sceneOf("7 · Wait for OBS"), 2)), false, "no second take on top of one OBS has not begun");
  await until(() => l.recording);
  assert.deepEqual([l.pending, l.take, l.problem], ["", name, ""], "OBS said it began: now it records the take");
  assert.ok(l.since >= asked + 200, `the time counts from when OBS began, not from the click: ${l.since - asked} ms after it`);
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 1);
  assert.deepEqual([ended, l.recording, l.pending], [[name], false, ""]);
  l.turn(false);
});

test("OBS takes a start and never begins: the link never says recording, says OBS did not start after the usual wait, and a stop calls the take off", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  obs.startLag = null; // as when OBS shows a warning instead of recording
  const name = takeName(sceneOf("7 · Wait for OBS"), 3);
  const seen = [];
  const watch = setInterval(() => seen.push(l.recording), 10);
  t.after(() => clearInterval(watch));
  assert.equal(await l.start(name), true, "OBS took the start");
  assert.deepEqual([l.recording, l.pending, l.problem], [false, name, ""]);
  await until(() => l.problem === "start");
  assert.ok(obs.requests("GetRecordStatus").length >= 2, "OBS was asked whether it records");
  assert.deepEqual([l.recording, l.pending, obs.record.format], [false, name, name], "still not recording; the take keeps its name in OBS, as it may begin yet");
  assert.equal(await l.stop(), true, "the stop is taken");
  await until(() => ended.length === 1);
  clearInterval(watch);
  assert.ok(!seen.includes(true), "never recording, from the click to the call-off");
  assert.deepEqual([ended, l.recording, l.pending, l.stopping, l.problem], [[name], false, "", false, ""]);
  assert.equal(obs.requests("StopRecord").length, 0, "nothing was recording: no stop went to OBS");
  await until(() => obs.record.format === OWN_FORMAT);
  l.turn(false);
});

test("a take OBS did not begin at first and begins after all: the trouble goes, and it records the take", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  obs.startLag = null;
  const name = takeName(sceneOf("7 · Wait for OBS"), 4);
  assert.equal(await l.start(name), true);
  await until(() => l.problem === "start");
  obs.press(true); // OBS begins after all, under the take's name still there
  await until(() => l.recording);
  assert.deepEqual([l.take, l.pending, l.problem], [name, "", ""]);
  assert.equal(obs.record.path, "D:\\Stream\\scenes\\07-wait-for-obs\\scene-07-wait-for-obs-take-04.mkv");
  await until(() => obs.record.format === OWN_FORMAT);
  assert.equal(await l.stop(), true);
  await until(() => ended.length === 1 && !obs.record.active);
  l.turn(false);
});

test("OBS's started word is lost for a take not begun yet: asked after the usual wait, OBS records, and the link says recording from when OBS began", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l } = link(obs);
  await until(() => l.state === "on");
  obs.startLag = null;
  const name = takeName(sceneOf("7 · Wait for OBS"), 5);
  assert.equal(await l.start(name), true);
  assert.equal(l.recording, false);
  // OBS begins without a word to the page (the event is lost): only asking tells.
  obs.record.active = true;
  obs.record.startedAt = Date.now();
  const began = obs.record.startedAt;
  await until(() => l.recording);
  assert.deepEqual([l.take, l.pending, l.problem], [name, "", ""]);
  assert.ok(Math.abs(l.since - began) < 100, `the time counts from when OBS began: ${l.since - began} ms off`);
  l.turn(false);
});

test("OBS takes a start and gives the take up without recording (it cannot write the file): never recording, the take is over, and the link says OBS did not start", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended, recorded } = link(obs);
  await until(() => l.state === "on");
  obs.startLag = null;
  const name = takeName(sceneOf("7 · Wait for OBS"), 6);
  const seen = [];
  const watch = setInterval(() => seen.push(l.recording), 10);
  t.after(() => clearInterval(watch));
  assert.equal(await l.start(name), true, "OBS took the start");
  obs.giveUp(); // OBS says starting, then stopped: nothing was recorded
  await until(() => ended.length === 1);
  clearInterval(watch);
  assert.ok(!seen.includes(true), "never recording");
  assert.deepEqual([ended, l.recording, l.pending, l.take, l.stopping, l.problem], [[name], false, "", null, false, "start"]);
  assert.deepEqual(recorded, [false]);
  assert.equal(obs.requests("StopRecord").length, 0);
  await until(() => obs.record.format === OWN_FORMAT);
  // The next take starts as usual.
  obs.startLag = 20;
  const next = takeName(sceneOf("7 · Wait for OBS"), 7);
  assert.equal(await l.start(next), true);
  await until(() => l.recording);
  assert.deepEqual([l.take, l.problem], [next, ""]);
  l.turn(false);
});

test("a late word that an older recording stopped never ends a take OBS took and has not begun", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on");
  obs.startLag = null;
  const name = takeName(sceneOf("7 · Wait for OBS"), 8);
  assert.equal(await l.start(name), true, "OBS took the start");
  obs.lateStop(); // stopped, with no "starting" before it: not about this take
  await sleep(80);
  assert.deepEqual([ended, l.pending, l.problem], [[], name, ""], "the take still waits for OBS to begin");
  assert.equal(obs.record.format, name, "the take's name stays in OBS");
  // OBS begins it after all: the file is the take's.
  obs.press(true);
  await until(() => l.recording);
  assert.equal(l.take, name);
  assert.match(obs.record.path, /scene-07-wait-for-obs-take-08\.mkv$/);
  l.turn(false);
});

// ---------- an old answer about the recording never undoes what OBS said since ----------

test("an answer OBS made before a take began, arriving after OBS said it started, never ends the take", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  const { l, ended } = link(obs);
  await until(() => l.state === "on" && obs.requests("GetRecordStatus").length === 1);
  // OBS never answers the start. Asked then whether it records, it says no, and that answer is held back.
  let held = 0;
  obs.answer = (type) => (type === "StartRecord" ? { silent: true } : type === "GetRecordStatus" && !held++ ? { late: 200 } : null);
  const name = takeName(sceneOf("8 · Crossed answers"), 1);
  const starting = l.start(name);
  await until(() => obs.requests("GetRecordStatus").length === 2);
  obs.press(true); // OBS begins the take, and says so, before the old answer arrives
  await until(() => l.recording);
  assert.equal(await starting, false, "the start itself got no answer");
  assert.equal(l.take, name);
  await sleep(350); // the old "not recording" answer has arrived by now
  assert.deepEqual([l.recording, l.take, ended, obs.record.active], [true, name, [], true], "the take goes on: nothing said it stopped");
  assert.equal(await l.stop(), true, "and a stop still reaches it");
  await until(() => ended.length === 1 && !obs.record.active);
  assert.equal(obs.requests("StopRecord").length, 1);
  l.turn(false);
});

test("an old answer after a reconnect never hides a recording OBS began since", async (t) => {
  const obs = await startObsStandin();
  t.after(() => obs.stop());
  let held = 0;
  obs.answer = (type) => (type === "GetRecordStatus" && !held++ ? { late: 200 } : null);
  const { l } = link(obs);
  await until(() => l.state === "on" && obs.requests("GetRecordStatus").length === 1);
  obs.press(true); // a recording begun in OBS itself, after OBS made its answer
  await until(() => l.recording);
  await sleep(350);
  assert.deepEqual([l.recording, l.take, obs.record.active], [true, null, true], "OBS records, and the link still says so");
  l.turn(false);
});
