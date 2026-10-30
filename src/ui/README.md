# Shared UI

Plain HTML and CSS pieces any site can copy. No framework, no build step needed, no dependencies.

## Range field

A slider with its name inside and an exact value you can type: one box, the name on the left (always on the fill), a fill that grows to a slim grip, faint ticks for the rest, the value on the right. Click or tab to the value and type any number between the value box's own `min` and `max`, which may reach past the slider's ends; the slider stops at its ends and the exact number is kept.

- `range-field.css`: all of the look, the fill included (no script needed to draw it). Written for Chromium, Safari and Firefox (the browser checks run in Chromium).
- `range-field.mjs`: a few dozen lines that keep the slider and the typed value in step. Import-free, so a page can inline it.

```html
<link rel="stylesheet" href="range-field.css">

<div class="range-field">
  <label for="size">Text size</label>
  <input id="size" type="range" min="20" max="110" step="2" value="52">
  <label class="range-value"><input type="number" min="10" max="300" value="52" inputmode="numeric" aria-label="Text size in pixels"><span aria-hidden="true">px</span></label>
</div>

<script type="module">
  import { rangeField } from "./range-field.mjs";
  const show = rangeField(document.querySelector(".range-field"), (value) => console.log(value));
  show(64); // a value set elsewhere (a saved setting, a shortcut key)
</script>
```

- The slider's `min`/`max`/`step` set the drag range; the value box's `min`/`max`/`step` set what can be typed (`step="any"` for decimals). Leave the box's `min`/`max` out to use the slider's.
- The unit `<span>` is optional. The box's `aria-label` names it for screen readers, unit included.
- While typing, a value applies as soon as it is whole and allowed; Enter or leaving the box tidies it (into range, onto the step); an emptied box goes back to the last value.
- Restyle with custom properties on `.range-field`: `--rf-height` (44px), `--rf-radius`, `--rf-thumb` (the fill's rounded end), `--rf-ticks` (how many), `--rf-bg`, `--rf-fill`, `--rf-grip`, `--rf-tick`, `--rf-muted` (the unit), `--rf-focus` (the ring). The font size comes from the page.

The prompter's build (`scripts/build.mjs`) inlines both files into its one-file page; `src/page.html` sets the colours.
