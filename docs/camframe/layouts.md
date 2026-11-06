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

- Only with a CamFrame that answers `"api": 2` (or later) with its full Scene list. With an older
  CamFrame, or a `file://` copy, nothing changes and the Open menu has no Camera layouts item.
- When CamFrame connects, it saves the missing layouts by itself, once per link session, small first,
  as long as that leaves one spare slot. A save that would fill CamFrame waits for Save in the window,
  which says so: the next Scene saved by hand there would drop its oldest.
  It never sends `replace` or `apply` on its own, saving sends no cue (cue lines still send theirs), and never calls
  `/camframe/small-size`: the small size is whatever CamFrame has now, shown in the window.
- Room: CamFrame keeps at most `sceneLimit` (6) Scenes, shared with Lex's own. When the missing
  layouts do not all fit, none is saved and the window says how many Scenes to delete in CamFrame.
  The window and its read-out say "saved" only when both layouts are saved, naming one at an older
  size; otherwise they name what is left.
- A Scene with a layout's name that holds something else (a snapshot Scene, another size or place) is
  replaced only after Lex presses Replace in the window (`replace: true` for that one Scene).
  The window opens with focus on Close, so Replace and Save take a deliberate move.
- A hand resize in CamFrame changes its small size. The large layout, saved at the older size, still
  works and shows no dot; its row says "Saved at 432 px; 1.5 × today's small camera would be 450 px.
  Replace it?", and only Replace changes it. When 1.5 × would pass CamFrame's largest camera (640 px),
  the row says so and offers 640 px.
- Spoken results: a save made by itself on connecting is not read out (that would talk over "CamFrame
  link: connected"); a problem shows as a dot on the Open menu's item and a note in the window. While
  the window is open, every result and every note that changes goes to a spoken status element inside
  it, because a modal window hides the page's status line from screen readers. **A real screen reader
  has not been tried:** the browser checks read Chromium's accessibility tree, which shows the text can
  be reached, not how it sounds.
- Notes say only what is known. A Replace whose row still offers it says CamFrame "still shows the old
  Scene"; a layout still missing says to press Save if it shows, otherwise to open the window again.
  A layout deleted in CamFrame while the window is open gets a line and a Save button (nothing saves
  it by itself then). The line follows CamFrame, so it goes when the layout is back. It stands beside
  the Replace note, but not beside a refusal's note, during the opening read or after it missed.
  When saving would fill CamFrame, its warning is always in the note beside Save.
  If CamFrame answers as an older version, wherever that closes the window, nobody knows what it
  holds: a note on the page says so (visible, read out as an alert, and gone with OK) and never
  "still not saved"; a save made by itself on connecting stays silent.
- A refused save stops and is said in plain words; a lost answer is not repeated blindly: the
  status is read again. Opening the Camera layouts window reads CamFrame again and saves what is
  still missing. The item shows a dot when the window needs a look.
- Saving a 7th Scene by hand in CamFrame's own settings drops its oldest Scene, which may be one of
  these two (CamFrame KG-14): keep a spare slot.

## Camera demo (try the cues without writing a script)

1. Open CamFrame (Prompter link on). On Prompter's start screen press "Try the camera demo" (or open
   `/#camera-demo` on the preview site).
2. Turn on the camera button in Settings: the two layouts are saved in CamFrame's Scenes by themselves
   when it connects. The Open menu then has "Camera layouts"; if that item shows a dot, open it and
   follow its note (no room, or a Scene with the same name). No such item: CamFrame is too old.
3. Scroll or press play: each `[Face: …]` line moves the camera when it reaches the reading line.

## Still to prove on the streaming PC (CamFrame W-30)

Needs a released CamFrame with API 2 on Lex's Windows PC, off-air, with the Prompter on the preview
site: the saves land, `[Face: Live right large]` puts the camera on the right, centred, inside the
right 30%, and `[Face small, bottom right]` / `[Face: Live small corner]` bring back exactly the
original small camera, with the same look (`look.signature`) and small size. Steps: CamFrame's W-30
row and its `docs/prompter-link-api.md` ("Checking a cue worked"). Never run `kit specs` on that PC:
the browser checks start a stand-in CamFrame on port 47833.
