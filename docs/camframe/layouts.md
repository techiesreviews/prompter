# CamFrame camera layouts

Two layout Scenes the Prompter saves in CamFrame for Lex's livestream cue lines (fleet issue
techiesreviews/fleet#4; Lex's decisions of 2026-11-04). CamFrame's side is its Prompter link API 2
(`docs/prompter-link-api.md` in the CamFrame repo). Code: `layoutPlan` and its helpers in
`src/camframe.mjs`, the glue in `src/app.js` (Camera layouts section); what is checked: the layout
tests in `test/camframe.test.mjs` and the Camera layouts block in `test/browser/page.mjs`.

## The two layouts

| Scene | Saved as (`POST /camframe/scenes`) | Use in the script |
| --- | --- | --- |
| Live small corner | `{"name":"Live small corner","size":"small","position":"bottom-right"}`: follows CamFrame's small size | Plugin and advisory screens: `[Face: Live small corner]` or `[Face small, bottom right]` (same result, also after the large one) |
| Live right large | `{"name":"Live right large","size":<1.5 × small>,"position":"right","withinRight":0.3}`: 432 px for the standard 288 | Branded pages with the content on the left: `[Face: Live right large]` |

`[Face full]` stays between examples. A bare `[Face small]` right after the large layout only shrinks
the camera where it is; use one of the two small lines above instead. Lex's scripts change one by one,
only when he works on them.

## What the Prompter does

There is no Camera layouts button or window (removed 2026-11-06, Lex): the Prompter saves the layouts by
itself, and the paste window's Camera cues list says where they stand.

- Only with a CamFrame that answers `"api": 2` (or later) with its full Scene list. With an older
  CamFrame, or a `file://` copy, nothing changes and the list says nothing about layouts.
- When CamFrame connects, it saves the missing layouts by itself, once per link session, small first,
  as long as that leaves one spare slot: a save that would fill CamFrame waits (the next Scene saved by
  hand there would drop its oldest). It never sends `replace` or `apply`, saving sends no cue (cue lines
  still send theirs), and never calls `/camframe/small-size`.
- Room: CamFrame keeps at most `sceneLimit` (6) Scenes, shared with Lex's own. When the missing layouts do
  not all fit, none is saved. To try again later (a slot freed, a Scene deleted), turn the camera button in
  Settings off and on: that starts a new link session. A layout deleted in CamFrame later is not saved again
  until then.
- A Scene with a layout's name that holds something else (a snapshot Scene, another size or place) is left
  alone: there is no Replace. The cue then uses what CamFrame holds. A hand resize in CamFrame changes its
  small size; a layout saved at the older size still works and the line says what it was saved at.
- **The one line** under the Camera cues list (`layoutsLine` in `src/camframe.mjs`; shown while the link
  answers and CamFrame can save layouts) says where the layouts stand, true for the last status read:
  saved (naming one at an older size), saving, not saved (no room, would fill CamFrame, deleted later, a
  refusal or a lost answer in plain words), or a Scene of Lex's own left alone. It never says saved unless
  both are. It is read out once, when the paste window opens; a save made by itself is
  quiet (it would talk over "CamFrame link: connected"). **A real screen reader has not been tried:** the
  browser checks read Chromium's accessibility tree, which shows the text can be reached, not how it sounds.
- A refused save stops and is said in the line; a lost answer is not repeated blindly: the status is read
  again.
- Saving a 7th Scene by hand in CamFrame's own settings drops its oldest Scene, which may be one of
  these two (CamFrame KG-14): keep a spare slot.

## Camera cues list (writing the cue lines)

In the "Paste a script" window a "Camera cues" list (with "Insert at cursor") puts a cue on its own line, in the
existing syntax (`faceCue` in `src/core.mjs`; the list is `cueChoices`): Face full, Face
small, Face small in each place, then `[Face: Scene]` for every Scene CamFrame lists, the two layout Scenes
first. A layout Scene is listed only when CamFrame lists it (not for an older CamFrame, or when there was no
room to save it). Where it goes is decided by the format's own reading (`cueInsertion` in `src/core.mjs`): never over a
selection, never inside a line (a caret inside a line puts the cue after it), never ahead of a section's links
or question line; where the cue would be skipped when the script is read (above the first title, outside the
start and end markers) nothing is inserted and the window says so. A blank first choice means a choice that
vanished from CamFrame never becomes another cue. Names `faceCue` cannot read back (with . ; ! ? or a bracket in them, or over 40
characters) are left out. The list shows only while the CamFrame link answers; otherwise one line says to
open CamFrame with its link on (and to turn on the camera button when that is off; the lead approved this
one line on 2026-11-06). Under the list the layouts line says where the two layouts stand. The insert is read out in the window's own status line, and the keyboard focus
goes to the text if the list disappears under it.

## Camera demo (try the cues without writing a script)

1. Open CamFrame (Prompter link on). On Prompter's start screen press "Try the camera demo" (or open
   `/#camera-demo` on the preview site).
2. Turn on the camera button in Settings: the two layouts are saved in CamFrame's Scenes by themselves
   when it connects. Open Paste a script: the line under the Camera cues list says they are saved, or why
   not (no room, or a Scene with the same name). No line: CamFrame is too old or not connected.
3. Scroll or press play: each `[Face: …]` line moves the camera when it reaches the reading line.

## Still to prove on the streaming PC (CamFrame W-30)

Needs a released CamFrame with API 2 on Lex's Windows PC, off-air, with the Prompter on the preview
site: the saves land, `[Face: Live right large]` puts the camera on the right, centred, inside the
right 30%, and `[Face small, bottom right]` / `[Face: Live small corner]` bring back exactly the
original small camera, with the same look (`look.signature`) and small size. Steps: CamFrame's W-30
row and its `docs/prompter-link-api.md` ("Checking a cue worked"). Never run `kit specs` on that PC:
the browser checks start a stand-in CamFrame on port 47833.
