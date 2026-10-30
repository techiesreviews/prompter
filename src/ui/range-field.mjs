// Range field (see range-field.css): keeps a slider and its typed value in step.
// Dragging the slider shows its value in the box; typing any value between the
// box's own min and max (which may reach past the slider's ends) moves the
// slider, which stops at its ends, and keeps the exact number (screen readers
// hear it too). Enter tidies the text into range and onto the box's step;
// leaving the box with a half-typed or empty value (Tab, Escape, a click
// elsewhere) goes back to the last value. onValue(number) hears every new
// value. Returns a setter for values that change elsewhere (a shortcut key, a
// saved setting); it does not call onValue. Import-free so a page can inline it.
export function rangeField(field, onValue = () => {}) {
  const range = field.querySelector('input[type="range"]');
  const box = field.querySelector('input[type="number"]');
  const unit = box.nextElementSibling?.textContent.trim() || "";
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
    sync(v);
    if (box.valueAsNumber !== v) box.value = String(v);
  };
  // The slider stops at its ends and on its step; then it names the exact value.
  function sync(v) {
    range.value = String(v);
    if (range.valueAsNumber === v) range.removeAttribute("aria-valuetext");
    else range.setAttribute("aria-valuetext", unit ? `${v} ${unit}` : String(v));
  }
  const commit = (enter) => {
    const v = box.valueAsNumber;
    const ok = Number.isFinite(v) && (enter || v === tidy(v));
    show(ok ? tidy(v) : value);
    onValue(value);
  };
  range.addEventListener("input", () => { show(range.valueAsNumber); onValue(value); });
  box.addEventListener("input", () => {
    const v = box.valueAsNumber;
    if (!Number.isFinite(v) || v !== tidy(v)) return; // half typed: wait
    value = v;
    sync(v);
    onValue(v);
  });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(true); });
  box.addEventListener("change", () => commit(false));
  box.addEventListener("focus", () => box.select());
  show(Number.isFinite(box.valueAsNumber) ? tidy(box.valueAsNumber) : value);
  return show;
}
