# Prompter

A free teleprompter for talking to camera, plus an MCP server so your AI assistant can write the script with you.

**Live:** https://prompter.techies.tools

- Big text, auto-scroll, a reading line and a show clock.
- Drag the reading line (grab it anywhere along it) up or down to sit right under your camera; the prompter remembers it on this device. Double-click (or double-tap) the line to put it back. Text you have already read, above the line, fades almost away, so your eyes stay on the line.
- A second "main screen" window (connect it in Settings) that opens links as you reach them: the first link under the title opens when the section starts; the others are on number keys. A link placed on the line where you talk about it, or inside the sentence itself, opens when you reach that line (YouTube links play full size). With Follow my voice, saying a link's name opens it.
- Follow my voice (Chrome and Edge, a switch in Settings): the prompter listens and keeps the line you are reading at the reading mark. Your browser's speech service hears your voice; the script stays on your device. If the speech service drops (Edge does this now and then, Chrome stops listening every minute or so), it starts listening again at once by itself; only when it keeps failing does it show "Reconnecting to speech…". If it never heard you at all and can't reach the speech service for about 15 seconds, Follow my voice turns off with a message. Where Chrome can recognise speech on your computer itself, the prompter uses that (it may download a language pack the first time), so it doesn't depend on the internet.
- A start screen to open a file, paste a script, connect your AI agent (Wait for MCP) or try the demo. It offers your last script ("Continue") but never opens it by itself.
- One floating control bar: Open, previous and next section, auto-scroll, the clock (press again to restart it from 00:00) and Settings. A small dot on Open shows your AI agent is waiting or connected; a dot on Settings shows Follow my voice is on or a main screen is connected.
- Settings kept simple: text size, scroll speed, a narrow, medium or full column (narrow keeps your eyes near the camera), and three buttons: Follow my voice, the main screen and the CamFrame link.
- CamFrame link (optional, off until you turn it on in Settings): camera cue lines like `[Face full]` or `[Face small, bottom right]` switch your camera view in [CamFrame](https://github.com/techiesreviews/camframe) when you reach them. See [Camera cues](#camera-cues-camframe-link).
- Your own AI agent can open the script it wrote straight in your prompter (Wait for MCP, in the Open menu and on the start screen), as in the script editor.
- A checker (through the MCP server) that points out long lines, a missing main question, a link without its full address and similar problems.
- Works offline: the page is one self-contained HTML file.

Keys: Space play/pause · ← → previous/next section · [ ] scroll speed · − + text size · 1–9 open a section's links · F full screen. With the reading line focused (Tab key), ↑ ↓ move it a little, Page Up/Down a lot, Home/End to the top or bottom.

## Your script stays with you

There are no accounts and no server storage. A shared prompter link carries the whole script inside the link itself, in the part after `#` (`#s=`, deflate-raw + base64url), which browsers never send to a server. The page remembers your last script in your own browser only, and offers it on the start screen.

The CamFrame link (off unless you turn it on) is the one other call: when a camera cue line reaches the reading line, the page sends just that cue (for example "small, bottom right") to CamFrame on your own computer (`http://127.0.0.1:47833`). Nothing goes to a server, and the script itself never leaves the page.

The MCP server works the same way: it reads the script from the request, checks it or packs it into a link, and sends the answer back. It keeps nothing. The only thing it holds, briefly and in memory, is a request count per client for the rate limit (see [Limits](#limits)).

**Wait for MCP (live connection).** When you press Wait for MCP, the page asks this site for a private token and keeps a connection open to a small relay on Cloudflare (a Durable Object picked by a hash of the token). Your own AI agent uses the token to open a script in your prompter tab (`show_script`) or to read the one that is open (`get_open_script`). Those scripts pass through the relay in memory and are never stored or logged. The relay keeps only a short note: when the token was made, when it expires (eight hours later), whether you pressed Disconnect MCP, and your agent's name and version (for example "claude-code 2.1"). An alarm erases that note when the token expires. Disconnect MCP ends the connection at once: your agent's calls get refused from then on. The token is kept in your browser until then, so a reload stays connected.

## Connect your AI assistant (MCP)

Server address: `https://prompter.techies.tools/mcp` (Streamable HTTP, stateless, JSON responses, no sign-in).

- **Claude (claude.ai, Claude Desktop):** Settings → Connectors → Add custom connector, with the address above.
- **Claude Code:** `claude mcp add --transport http prompter https://prompter.techies.tools/mcp`
- **ChatGPT:** Settings → Apps & Connectors → Advanced settings → turn on Developer mode. Then create a connector with the address above and **No authentication**. Menu names can differ a little.
- **Codex and T3 Code:** add this to `~/.codex/config.toml` (T3 Code uses your Codex and Claude Code settings):

  ```toml
  [mcp_servers.prompter]
  url = "https://prompter.techies.tools/mcp"
  ```
- **Other MCP apps (JSON config):**

  ```json
  { "mcpServers": { "prompter": { "type": "http", "url": "https://prompter.techies.tools/mcp" } } }
  ```

Or press **Wait for MCP** on the start screen (also in the Open menu): it copies a message you paste into an AI agent that can run commands (Claude Code, Codex, T3 Code). The agent connects for that conversation only, with curl and a private token, without changing its settings. The button confirms with "Copied" and a check, then reads "Waiting for MCP" until your agent connects; then the button reads "Disconnect MCP" (the Open button gets a green dot, and its tooltip names your agent). If you open the prompter in a second tab, that tab takes over; the first one offers "Use this tab". Ask: *"Help me write a prompter script about …"*. Your agent interviews you, writes the script, checks it and opens it in your prompter. An offline copy (opened from a file) has no live connection: its **Copy MCP** copies a message for the open server, and the agent gives you a link instead.

Tools: `get_format`, `check_script`, `make_prompter_link`; with a Wait for MCP token also `show_script` and `get_open_script`. Prompt: `write_prompter_script`. Requests are limited to 200 KB.

## Script format

```markdown
### **1 · ONE QUESTION · 01:30**

- Example: https://example.com

QL: Why one question per section?

[Answer in your own words]

One question keeps you focused.

Here is the example page.
- Example page: https://example.com/page
Or read [the docs](https://example.com/docs) here.

Next: show the tool.
Now: links on screen.
```

- `### **TITLE · mm:ss**` starts a section (time optional). `---` is ignored.
- `- Label: https://full-url` is a link. Right under the title (before or after the QL), the first link opens when the section starts; the others are on number keys. Put it where you talk about it, and it opens automatically when you reach that line (the prompter shows a small ↗ marker there). Number keys 1–9 open a section's links any time; a small row at the top of the section lists them.
- `[words](https://full-url)` puts a link inside a spoken line, a bullet or a `Next:`/`Now:` line. The prompter shows only the words, like the rest of the line with a faint dotted underline, and opens the link when that line reaches the reading line. Only the words count towards the line's length. Not in `QL:` lines, `[reminders]` or titles.
- Links stay quiet while you read: the one on the main screen gets a thin orange border, and hovering a link turns it orange. The address shows only in the link's tooltip. With Follow my voice, saying a link's label opens it, so a short one-word label (like "Docs") can open when you only mention the word in passing; give links distinctive labels.
- `QL: question` is the one main question: read it silently and answer it; it is not read aloud. Shown at the top of the section.
- Plain lines are spoken. `Next: …` / `Now: …` are transitions. `[text]` is a private reminder. `- text` is a bullet.

## Camera cues (CamFrame link)

If you use CamFrame (the camera window app), the prompter can switch its view for you when you reach a cue line, so you don't have to press shortcuts mid-sentence.

**Turn it on (once, in both apps)**

1. In CamFrame: open its controls, choose **Scenes**, and switch on **Prompter link**.
2. In the prompter: open **Settings** (the gear) and press the **camera button** (next to the microphone and the screen). A blinking orange camera means it is looking for CamFrame (or reconnecting after a missed answer); a steady, glowing orange camera means it is connected; a grey crossed-out camera with an orange ring means CamFrame was not found. Hover the button to read its state in words. Press it again to turn the link off.
3. Chrome may ask once whether this page may reach apps on this device. Allow it. Use Chrome or Edge; Safari may not reach apps on your computer.

**Cheat-sheet** (a reminder line in square brackets; capitals don't matter; the cue is its own sentence starting with "Face")

| Write | CamFrame does |
| --- | --- |
| `[Face full]` | Full screen (or the Scene you picked for "Face full" in CamFrame) |
| `[Face small]` | The small camera, back where it was (or the place or Scene you picked in CamFrame) |
| `[Face small, bottom right]` | The small camera in that spot: top left, top right, bottom left, bottom right, left, right or center |
| `[Face: Demo]` | Your CamFrame Scene called "Demo" (its size, place and look) |
| `[Share screen. Face small.]` | Other words first are fine; the cue is the sentence starting with Face |

- The cue goes to CamFrame when its line reaches the reading line, whether you scroll by hand, use auto-scroll, Follow my voice or jump sections. It goes once per pass: scroll back above it and read it again, and it goes again. Jumping past several cues sends only the last one.
- Cue lines count towards the line length, so with the "lex" preset keep them to five words: `[Face small, bottom right]` or `[Share screen. Face small.]`, not `[Share screen. Face small, bottom right.]`.
- The checker warns about a cue it can't read, such as `[Face small, middle]` or `[Face big]`. A reminder that starts with "Face" but isn't a cue (like `[Face the camera]`) gets the same warning; reword it if you see one.
- A cue line shows a small camera mark and what the camera does, like **Camera: face small · Share screen.**, so you can see where a switch happens, with the link on or off.
- No note pops up when a cue goes out: the camera moving is the sign it worked.
- A single missed answer (Edge sometimes drops a call) does not break the link: the camera button blinks while it tries again, and a cue that does not get through is sent once more. If CamFrame isn't running, scrolling never waits, and after a few seconds the camera button shows "not found"; it connects again by itself when CamFrame is back.

The full format, the two style presets (`lex`, strict, and `default`, softer) and the checker live in [`src/core.mjs`](src/core.mjs). The page, the checker and the MCP server all use that one file. The `get_format` tool shows the same rules, and the page's demo ("Try the demo") teaches them by example.

## Limits

- `/mcp` is limited per client by a Durable Object (free plan, SQLite-backed class): 60 requests a minute and 10 per 10 seconds. The Worker hashes the client IP with a fixed salt (SHA-256; IPv6 grouped by /64, IPv4-in-IPv6 counted as the IPv4 address) and uses the hash to pick one object per client, so the object never sees an IP. The salt is public, so treat the key as hashed, not anonymous. The object keeps the times of recent requests in memory only: it never writes to its storage, gets no request body (so never a script) and logs nothing. Each request first drops times older than a minute, and Cloudflare drops an idle object from memory, normally 70–140 seconds after its last request, taking any remaining times with it. So counts are gone within a few minutes of your last request. Over the limit, `/mcp` answers HTTP 429 with `Retry-After` and a JSON-RPC error that names the limit that refused.
- An in-memory guard in each Worker instance (60 per minute) runs first and stops bursts without calling the object. If the object errors or is slow, `/mcp` keeps working (fail open).
- Wait for MCP: the page's own calls have in-memory guards per client in each Worker instance (20 new tokens and 30 relay connections a minute). A token lasts eight hours; calls with an expired or disconnected token get HTTP 401. A tool call waits at most 10 seconds for your tab.
- The free Workers rate-limiting binding was removed: in a live test on 2026-10-27 it allowed about 250 requests from one IP within a few minutes.
- Cost cannot run away: the free plan has no billing for overage. Past 100,000 Worker requests a day, `/mcp` returns errors until the next day; the page itself is served as static assets and keeps working. Durable Objects have their own free daily allowance; when it runs out, the limiter fails open.

## Run it on your computer

You need [Node.js](https://nodejs.org/) 24 or newer. There are no npm dependencies.

```sh
node scripts/build.mjs           # builds dist/index.html and dist/_headers
node --test test/*.test.mjs      # runs the tests
npx wrangler dev                 # page, /mcp and the live relay at http://localhost:8787
```

Opening `dist/index.html` directly also works (everything except `/mcp` and Wait for MCP; it uses your system fonts; the CamFrame link works there too). To make an offline copy with a script built in: `node scripts/embed.mjs script.md out.html`.

## Deploy your own copy

It runs on the Cloudflare Workers **free plan**: one Worker serves the page as static assets and answers `/mcp` and `/api/*`, and two Durable Object classes (SQLite-backed, the kind the free plan allows) do the rate limiting (`McpLimiter`) and the live relay (`Relay`).

1. Make a free Cloudflare account and log in: `npx wrangler login`.
2. In `wrangler.jsonc`, change `"name"` if you like, and replace the `routes` entry `prompter.techies.tools` with your own domain (it must be a zone in your Cloudflare account). No domain? Remove `routes` and set `"workers_dev": true` to get a `*.workers.dev` address.
3. Deploy: `node scripts/build.mjs && npx wrangler deploy`. The first deploy creates the Durable Object classes from the `migrations` entries.

Links made by your copy, and the server address in its demo script, follow your own address automatically. A few places still name `prompter.techies.tools`; change them to yours: `SITE` in `src/core.mjs` (used by offline copies opened from a file), the `make_prompter_link` description and both `instructions` texts in `src/mcp.mjs`, and the `wss://` address in the `connect-src` line of `scripts/build.mjs` (keep its `http://127.0.0.1:47833` for the CamFrame link).

## Contributing

Issues and pull requests are welcome. Please keep the promises above: scripts never reach server storage or logs, the page stays one self-contained file that works offline, and everything fits the Cloudflare free plan. Run `node --test test/*.test.mjs` before you send a change, and keep changes small and focused.

## Maintainer tooling

`scripts/agents/` holds the Agent Kit, the maintainer's development tooling for AI coding agents (checks, browser screenshots and reviews). See [`docs/agents/agent-scripts.md`](docs/agents/agent-scripts.md) and [`AGENTS.md`](AGENTS.md). You don't need it to build, test or deploy. Some defaults point to the maintainer's own folders and can be changed with environment variables (`KIT_MAIN_ROOT`, `KIT_PLAYWRIGHT_MODULE`).

## License

[MIT](LICENSE) © 2026 Lex (Techies Reviews)

The fonts in `fonts/`, Inter (© The Inter Project Authors) and Roboto Mono (© The Roboto Mono Project Authors), are under the [SIL Open Font License 1.1](fonts/OFL.txt).
