# Kitchen extras: prompter

`scripts/agents/kit rulebook` prints the shared rulebook, then this file. Where they differ, this
file wins.

## Branches, checks and the shared file

- **Landing and release branch `main`.** The live site is built from `main`. The preview,
  https://preview.prompter.techies.tools, is its own Worker (`techies-prompter-preview`, `env.preview`
  in `wrangler.jsonc`); `npm run deploy:preview` puts the working folder's build there and never
  touches the live Worker.
- **Checks:** `kit unit` (all of `test/*.test.mjs`, about 2 s; `--affected` for a quick pass) on
  every change. The tests build the page themselves.
- **Own check commands** (`scripts/agents/project.d/`):
  - `kit specs [suite]`, the browser checks, for any change to the page, the Worker's pages or
    `src/ui/`; `kit pr` runs the suites a change reaches (`--affected`). Each file in
    `test/browser/` is one suite: `page.mjs` is the whole page (about 30 s, local `wrangler dev`),
    `range-field.mjs` the shared slider on its own (about 2 s, no server). Run the small suite
    while working and the whole set before landing. What a suite checks lives in its file, not here.
    Screenshots and close-ups (`*-close-up-*`, `range-field-*`) land in the evidence folder; open the
    close-ups first, they are a fraction of a full page.
  - `kit size` when the page or the Worker grows: bytes of the built page and the Worker sources.
- **Shared file:** none.
- **Docs the shared rulebook names:** no runner guide, issue tracker guide, UX rulebook or
  routines yet. Design rules: `AGENTS.md` and the kit's house style. The shared slider:
  `src/ui/README.md`.

## Visible changes

- **Feature list:** none. **Screenshots:** `kit specs` (desktop 1366×900 and mobile 390×844).
- Colours: `test/contrast.test.mjs` checks every text colour of the page and of each shared
  component in `src/ui/`; a component's new colour fails until it is listed there (`UI_COLOURS`).

## After a merge

- None by default. A test build for Lex goes to the preview (`npm run deploy:preview`, from the
  branch or `main`), then a check that it loads:
  `curl -s https://preview.prompter.techies.tools/ | grep -c <a string the change added>`.

## Microphone, voice and CamFrame tests

- Run them on https://preview.prompter.techies.tools or on `http://localhost` (`npx --no-install
  --package wrangler wrangler dev`, or the server `kit specs` starts), never on a `file://` copy: a
  file page asks for the microphone again after every restart and has no relay, while localhost
  and the preview are secure contexts whose permission sticks. CamFrame accepts the live site,
  the preview and localhost (`originAllowed` in CamFrame's `src/prompter-link.js`).

## Release

- **Lex lets the lead ship a finished feature without asking (2026-10-28):** after the checks and
  the review pass, land it on `main`, then
  `node scripts/build.mjs && npx --no-install --package wrangler wrangler deploy`, and send Lex the
  live link. It deploys only the `techies-prompter` Worker on `prompter.techies.tools`; never touch
  other Workers (for example `lex-prompter`), routes or domains.
- First-hour check: `curl -s https://prompter.techies.tools/ | grep -c <a string the change added>`.

## Other

- **Tooling stays outside the repo:** Playwright from `"playwright"` in `scripts/agents/kit.json`
  (or `KIT_PLAYWRIGHT_MODULE`), with Chromium installed for it; Wrangler already cached
  (`npx --no-install --package wrangler`). Nothing is installed here.
- `.scratch/`, `dist/` and `.wrangler/` are git-ignored; only `dist/` is uploaded.
