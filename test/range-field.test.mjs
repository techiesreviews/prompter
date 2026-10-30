import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeField } from "../src/ui/range-field.mjs";

// Small stand-ins for the two inputs: a slider stops at its ends and on its step,
// a number box keeps whatever text it is given.
class Input extends EventTarget {
  constructor(attrs) { super(); Object.assign(this, { min: "", max: "", step: "", value: "", attrs: {} }, attrs); }
  get valueAsNumber() { return this.value === "" ? NaN : Number(this.value); }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  select() {}
}
class Range extends Input {
  set value(v) {
    const lo = Number(this.min), hi = Number(this.max), step = Number(this.step) || 1;
    const n = Math.min(hi, Math.max(lo, lo + Math.round((Number(v) - lo) / step) * step));
    this._v = String(n);
  }
  get value() { return this._v; }
}

function field({ range, box, unit = "" }) {
  const r = new Range({ min: "20", max: "110", step: "2", ...range });
  const b = new Input({ value: r.value, ...box, nextElementSibling: unit ? { textContent: unit } : null });
  const heard = [];
  const show = rangeField({ querySelector: (sel) => (sel.includes("range") ? r : b) }, (v) => heard.push(v));
  const type = (text) => { b.value = text; b.dispatchEvent(new Event("input")); };
  const leave = () => b.dispatchEvent(new Event("change"));
  const enter = () => { b.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter" })); leave(); };
  return { r, b, heard, show, type, leave, enter };
}

test("range field: typing applies whole allowed values at once and keeps the exact number", () => {
  const f = field({ range: { value: "52" }, box: { min: "10", max: "300" }, unit: "px" });
  f.type("4");
  assert.deepEqual(f.heard, [], "half typed (below the minimum): wait");
  f.type("47");
  assert.deepEqual([f.heard, f.r.value, f.b.value, f.r.attrs["aria-valuetext"]], [[47], "48", "47", "47 px"], "the slider sits nearest and names the exact value");
  f.type("150");
  assert.deepEqual([f.r.value, f.r.attrs["aria-valuetext"]], ["110", "150 px"], "past the slider's end it stops there");
  f.type("60");
  assert.equal(f.r.attrs["aria-valuetext"], undefined, "on the slider's own step: no extra name");
});

test("range field: Enter tidies into range; leaving half typed or empty goes back", () => {
  const f = field({ range: { value: "52" }, box: { min: "10", max: "300" } });
  f.type("5");
  f.leave();
  assert.deepEqual([f.b.value, f.heard.at(-1)], ["52", 52], "leaving (Tab, Escape) while half typed: the last value, not the smallest");
  f.type("");
  f.leave();
  assert.equal(f.b.value, "52", "emptied: the last value");
  f.type("5");
  f.enter();
  assert.deepEqual([f.b.value, f.r.value, f.heard.at(-1)], ["10", "20", 10], "Enter: the smallest allowed");
  f.type("999");
  f.enter();
  assert.deepEqual([f.b.value, f.heard.at(-1)], ["300", 300], "Enter: the largest allowed");
});

test("range field: the box's own step, step any, and the slider's limits when the box has none", () => {
  const stepped = field({ range: { min: "1", max: "100", step: "1", value: "5" }, box: { min: "1", step: "5" } });
  stepped.type("7");
  assert.deepEqual(stepped.heard, [], "off the box's step: not applied while typing");
  stepped.enter();
  assert.equal(stepped.b.value, "6", "Enter puts it on the step, counted from min");
  const any = field({ range: { min: "0", max: "100", step: "1", value: "5" }, box: { step: "any" } });
  any.type("12.5");
  assert.deepEqual([any.heard, any.r.value], [[12.5], "13"], "step any keeps decimals");
  any.type("150");
  any.enter();
  assert.equal(any.b.value, "100", "without min/max the box uses the slider's");
});

test("range field: dragging shows the value; the setter updates both without calling back", () => {
  const f = field({ range: { value: "52" }, box: { min: "10", max: "300" } });
  f.r.value = "70";
  f.r.dispatchEvent(new Event("input"));
  assert.deepEqual([f.b.value, f.heard], ["70", [70]]);
  f.show(200);
  assert.deepEqual([f.b.value, f.r.value, f.heard], ["200", "110", [70]]);
});
