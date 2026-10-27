import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeScript, encodeScript, EXAMPLE_SCRIPT, makeLink, MAX_DECODED_BYTES, readHash, SITE } from "../src/core.mjs";

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
