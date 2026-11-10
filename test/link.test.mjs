import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeScript, encodeScript, EXAMPLE_SCRIPT, formatSavedDate, makeLink, MAX_DECODED_BYTES, readHash, savedDate, SITE } from "../src/core.mjs";

test("#s= encode/decode round trip keeps text exactly, including unicode", async () => {
  for (const text of [EXAMPLE_SCRIPT, "", "### **ÜBER · 01:00**\nHéllo 👋 — “quotes” · 中文\r\nend", "x".repeat(70_000)]) {
    const data = await encodeScript(text);
    assert.match(data, /^[A-Za-z0-9_-]*$/);
    assert.equal(await decodeScript(data), text);
  }
});

test("encoding compresses a typical script", async () => {
  const data = await encodeScript(EXAMPLE_SCRIPT);
  assert.ok(data.length < EXAMPLE_SCRIPT.length, `${data.length} >= ${EXAMPLE_SCRIPT.length}`);
});

test("makeLink and readHash agree; default preset is omitted", async () => {
  const link = await makeLink(EXAMPLE_SCRIPT, "lex");
  assert.ok(link.startsWith(`${SITE}/#s=`));
  const { data, preset } = readHash(new URL(link).hash);
  assert.equal(preset, "lex");
  assert.equal(await decodeScript(data), EXAMPLE_SCRIPT);
  assert.ok(!(await makeLink("a", "default")).includes("&p="));
  assert.ok(!(await makeLink("a", "bogus")).includes("&p="));
  assert.ok((await makeLink("a", "lex", "http://127.0.0.1:8787/")).startsWith("http://127.0.0.1:8787/#s="));
  assert.equal(readHash("#s=abc&p=evil").preset, null);
});

test("damaged link data is refused with a plain message", async () => {
  await assert.rejects(decodeScript("not base64!"), /damaged/);
  await assert.rejects(decodeScript("AAAA"), /damaged/);
  await assert.rejects(decodeScript("A"), /damaged/); // cut-off link: invalid base64 length
  await assert.rejects(decodeScript("AAAAA"), /damaged/);
});

test("decompression refuses oversized scripts (zip bombs)", async () => {
  const data = await encodeScript("a".repeat(MAX_DECODED_BYTES + 10));
  assert.ok(data.length < 5000);
  await assert.rejects(decodeScript(data), /too large/);
});

test("a link can carry the script's save date (&d=); links without one stay as they were", async () => {
  const dated = await makeLink(EXAMPLE_SCRIPT, "lex", SITE, "2026-11-10");
  assert.ok(dated.endsWith("&p=lex&d=2026-11-10"), dated);
  const read = readHash(new URL(dated).hash);
  assert.deepEqual([read.preset, read.saved], ["lex", "2026-11-10"]);
  assert.equal(await decodeScript(read.data), EXAMPLE_SCRIPT);
  const plain = await makeLink(EXAMPLE_SCRIPT, "lex");
  assert.ok(!plain.includes("&d="), "no date asked, none written");
  assert.equal(readHash(new URL(plain).hash).saved, null);
  assert.ok((await makeLink("a", "default", SITE, "2026-11-10")).endsWith("&d=2026-11-10"), "the default preset still leaves out &p=");
  assert.equal((await makeLink("a", "lex", SITE, "last week")).includes("&d="), false, "a date that is not a date is left out of the link");
  assert.equal(readHash("#s=abc&d=2026-02-31").saved, null, "a hand-edited link with a made-up date shows no date");
});

test("savedDate accepts only a real calendar date as YYYY-MM-DD", () => {
  assert.equal(savedDate("2026-11-10"), "2026-11-10");
  assert.equal(savedDate("2024-02-29"), "2024-02-29");
  for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-11-1", "10-11-2026", "2026-11-10T10:00:00Z", " 2026-11-10", "yesterday", "", null, undefined, 20261110]) {
    assert.equal(savedDate(bad), null, String(bad));
  }
});

test("formatSavedDate names the month in English, the same everywhere", () => {
  assert.equal(formatSavedDate("2026-11-10"), "10 Nov 2026");
  assert.equal(formatSavedDate("2026-01-05"), "5 Jan 2026");
  assert.equal(formatSavedDate("not a date"), "");
});
