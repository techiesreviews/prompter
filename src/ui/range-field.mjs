// Range field (see range-field.css): keeps a slider and its typed value in step.
// Dragging the slider shows its value in the box; typing any value between the
// box's own min and max (which may reach past the slider's ends) moves the
// slider, which stops at its ends, and keeps the exact number. Enter or leaving
// the box tidies the text (into range, onto the box's step); a box left empty
// goes back to the last value. onValue(number) hears every new value. Returns a
// setter for values that change elsewhere (a shortcut key, a saved setting).
// Import-free so a page can inline it.
export function rangeField(field, onValue = () => {}) {
  const range = field.querySelector('input[type="range"]');
  const box = field.querySelector('input[type="number"]');
  const lo = Number(box.min || range.min);
  const hi = Number(box.max || range.max);
  const step = box.step === "any" ? 0 : Number(box.step) || 1;
  const tidy = (v) => {
    const stepped = step ? Number((lo + Math.round((v - lo) / step) * step).toFixed(10)) : v;
    return Math.min(hi, Math.max(lo, stepped));
  };
  let value = Number(range.value);
  const show = (v) => {
    value = v;
    range.value = String(v);
    if (box.valueAsNumber !== v) box.value = String(v);
  };
  range.addEventListener("input", () => { show(range.valueAsNumber); onValue(value); });
  box.addEventListener("input", () => {
    const v = box.valueAsNumber;
    if (!Number.isFinite(v) || v !== tidy(v)) return; // half typed: wait
    value = v;
    range.value = String(v);
    onValue(v);
  });
  box.addEventListener("change", () => {
    show(Number.isFinite(box.valueAsNumber) ? tidy(box.valueAsNumber) : value);
    onValue(value);
  });
  box.addEventListener("focus", () => box.select());
  show(Number.isFinite(box.valueAsNumber) ? tidy(box.valueAsNumber) : value);
  return show;
}
