import { test } from "node:test";
import assert from "node:assert/strict";
import { CUT_SITES_BUILT_IN, CUT_SITES_MAX, cutSite, cutsMainScreen, forgetCutSite, mainScreenArea, mainScreenFeatures, readCutSites, rememberCutSite } from "../src/main-screen.mjs";

test("the Data Protection Authority is known from the start, with or without www, and its subdomains", () => {
  assert.deepEqual(CUT_SITES_BUILT_IN, ["autoriteitpersoonsgegevens.nl"]);
  assert.equal(cutsMainScreen([], "www.autoriteitpersoonsgegevens.nl"), true);
  assert.equal(cutsMainScreen([], "autoriteitpersoonsgegevens.nl"), true);
  assert.equal(cutsMainScreen([], "Forms.AutoriteitPersoonsgegevens.nl"), true);
  assert.equal(cutsMainScreen([], "notautoriteitpersoonsgegevens.nl"), false, "only the site itself and its subdomains");
  assert.equal(cutsMainScreen([], "example.com"), false);
  assert.equal(cutsMainScreen([], ""), false);
});

test("a site that cut the main screen off is remembered once, without www, and then known", () => {
  assert.equal(cutSite("WWW.Example.COM "), "example.com");
  const list = rememberCutSite([], "www.example.com");
  assert.deepEqual(list, ["example.com"]);
  assert.equal(rememberCutSite(list, "example.com"), list, "known: the same list");
  assert.equal(rememberCutSite(list, ""), list, "no site: the same list");
  assert.equal(rememberCutSite(list, "www.autoriteitpersoonsgegevens.nl"), list, "built in: not stored");
  assert.equal(cutsMainScreen(list, "example.com"), true);
  assert.equal(cutsMainScreen(list, "news.example.com"), true);
  assert.equal(cutsMainScreen(list, "example.org"), false);
});

test("a site whose own window stayed connected comes off the list; the built-in sites never do", () => {
  const list = ["example.com", "example.org"];
  assert.deepEqual(forgetCutSite(list, "www.Example.com"), ["example.org"]);
  assert.equal(forgetCutSite(list, "example.net"), list, "not there: the same list");
  assert.deepEqual(forgetCutSite(list, "docs.example.org"), ["example.com"], "a subdomain the remembered site sent to its own window: that site comes off, so the device is never stuck with it");
  assert.equal(forgetCutSite(list, "notexample.com"), list, "only the site itself and its subdomains");
  assert.equal(forgetCutSite(list, ""), list);
  assert.equal(forgetCutSite([], "autoriteitpersoonsgegevens.nl").length, 0);
  assert.equal(cutsMainScreen(forgetCutSite([], "autoriteitpersoonsgegevens.nl"), "autoriteitpersoonsgegevens.nl"), true, "built in: still known");
});

test("the remembered list keeps at most its maximum, the newest last", () => {
  let list = [];
  for (let i = 0; i < CUT_SITES_MAX + 5; i++) list = rememberCutSite(list, `site${i}.example`);
  assert.equal(list.length, CUT_SITES_MAX);
  assert.equal(list[0], "site5.example");
  assert.equal(list.at(-1), `site${CUT_SITES_MAX + 4}.example`);
});

test("what the device kept is read as host names only; anything else is an empty list", () => {
  assert.deepEqual(readCutSites(null), []);
  assert.deepEqual(readCutSites(""), []);
  assert.deepEqual(readCutSites("not json"), []);
  assert.deepEqual(readCutSites('{"a":1}'), []);
  assert.deepEqual(readCutSites('["www.Example.com", 3, null, "", "example.com", "b.example"]'), ["example.com", "b.example"]);
  const many = JSON.stringify(Array.from({ length: CUT_SITES_MAX + 3 }, (_, i) => `s${i}.example`));
  assert.equal(readCutSites(many).length, CUT_SITES_MAX);
});

test("a new main screen goes full size on another screen than the Prompter's, the primary one first", () => {
  const laptop = { availLeft: 0, availTop: 0, availWidth: 1440, availHeight: 870, isPrimary: false };
  const big = { availLeft: 1440, availTop: -200, availWidth: 2560, availHeight: 1400, isPrimary: true };
  const third = { availLeft: -1920, availTop: 0, availWidth: 1920, availHeight: 1050, isPrimary: false };
  assert.deepEqual(mainScreenArea([laptop, big], laptop), { left: 1440, top: -200, width: 2560, height: 1400 });
  assert.deepEqual(mainScreenArea([laptop, big], big), { left: 0, top: 0, width: 1440, height: 870 }, "the Prompter on the primary: the other one");
  assert.deepEqual(mainScreenArea([laptop, third, big], laptop), { left: 1440, top: -200, width: 2560, height: 1400 });
  assert.deepEqual(mainScreenArea([laptop, third], laptop), { left: -1920, top: 0, width: 1920, height: 1050 });
  assert.equal(mainScreenArea([laptop], laptop), null, "one screen: the person places it");
  assert.equal(mainScreenArea(null, null), null, "no screen details");
});

test("the window features: full size and full screen on that area, else a plain window", () => {
  assert.equal(mainScreenFeatures({ left: 1440, top: -200, width: 2560, height: 1400 }), "popup=yes,left=1440,top=-200,width=2560,height=1400,fullscreen=yes");
  assert.equal(mainScreenFeatures(null), "popup=yes,width=1400,height=900");
});
