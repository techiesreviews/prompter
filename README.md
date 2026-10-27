# Prompter

A free teleprompter for talking to camera, plus an MCP server so your AI assistant can write the script with you.

**Live:** https://prompter.techies.tools

- Big text, auto-scroll, a reading line and a show clock.
- A second "main screen" window that opens each section's links as you reach them (YouTube links play full size).
- Follow my voice (Chrome and Edge): the prompter listens and keeps the line you are reading at the reading mark. Your browser's speech service hears your voice; the script stays on your device.
- Sliders for speed and text size, and a narrow column to keep your eyes near the camera.
- A checker (through the MCP server) that points out long lines, a missing main question, links in the wrong place and similar problems.
- Works offline: the page is one self-contained HTML file.

## Your script stays with you

There are no accounts and no server storage. A shared prompter link carries the whole script inside the link itself, in the part after `#` (`#s=`, deflate-raw + base64url), which browsers never send to a server. The page remembers your last script in your own browser only.

The MCP server works the same way: it reads the script from the request, checks it or packs it into a link, and sends the answer back. It keeps nothing. The only thing it holds, briefly and in memory, is a request count per client for the rate limit (see [Limits](#limits)).

## Connect your AI assistant (MCP)

Server address: `https://prompter.techies.tools/mcp` (Streamable HTTP, stateless, JSON responses, no sign-in).

- **Claude (claude.ai, Claude Desktop):** Settings → Connectors → Add custom connector, with the address above.
- **Claude Code:** `claude mcp add --transport http prompter https://prompter.techies.tools/mcp`
- **Other MCP apps (JSON config):**

  ```json
  { "mcpServers": { "prompter": { "type": "http", "url": "https://prompter.techies.tools/mcp" } } }
  ```

The prompter's demo script has steps for ChatGPT, Codex and more (PREP → "Use your AI"). Then ask: *"Help me write a prompter script about …"*. Your assistant interviews you, writes the script, checks it and gives you a link that opens it in the prompter.

Tools: `get_format`, `check_script`, `make_prompter_link`. Prompt: `write_prompter_script`. Requests are limited to 200 KB.

## Script format

```markdown
### **1 · ONE QUESTION · 01:30**

- Example: https://example.com

QL: Why one question per section?

[Answer in your own words]

One question keeps you focused.

Next: show the tool.
Now: links on screen.
```

- `### **TITLE · mm:ss**` starts a section (time optional). `---` is ignored.
- `- Label: https://full-url` is a link; put links first. Number keys 1–9 open them.
- `QL: question` is the one main question: read it silently and answer it; it is not read aloud. Shown at the top of the section.
- Plain lines are spoken. `Next: …` / `Now: …` are transitions. `[text]` is a private reminder. `- text` is a bullet.

The full format, the two style presets (`lex`, strict, and `default`, softer) and the checker live in [`src/core.mjs`](src/core.mjs). The page, the checker and the MCP server all use that one file. The `get_format` tool shows the same rules, and the demo script that opens on the page teaches them by example.

## Limits

- `/mcp` is limited per client by a Durable Object (free plan, SQLite-backed class): 60 requests a minute and 10 per 10 seconds. The Worker hashes the client IP with a fixed salt (SHA-256; IPv6 grouped by /64, IPv4-in-IPv6 counted as the IPv4 address) and uses the hash to pick one object per client, so the object never sees an IP. The salt is public, so treat the key as hashed, not anonymous. The object keeps the times of recent requests in memory only: it never writes to its storage, gets no request body (so never a script) and logs nothing. Each request first drops times older than a minute, and Cloudflare drops an idle object from memory, normally 70–140 seconds after its last request, taking any remaining times with it. So counts are gone within a few minutes of your last request. Over the limit, `/mcp` answers HTTP 429 with `Retry-After` and a JSON-RPC error that names the limit that refused.
- An in-memory guard in each Worker instance (60 per minute) runs first and stops bursts without calling the object. If the object errors or is slow, `/mcp` keeps working (fail open).
- The free Workers rate-limiting binding was removed: in a live test on 2026-10-27 it allowed about 250 requests from one IP within a few minutes.
- Cost cannot run away: the free plan has no billing for overage. Past 100,000 Worker requests a day, `/mcp` returns errors until the next day; the page itself is served as static assets and keeps working. Durable Objects have their own free daily allowance; when it runs out, the limiter fails open.

## Run it on your computer

You need [Node.js](https://nodejs.org/) 24 or newer. There are no npm dependencies.

```sh
node scripts/build.mjs           # builds dist/index.html and dist/_headers
node --test test/*.test.mjs      # runs the tests
npx wrangler dev                 # page and /mcp at http://localhost:8787
```

Opening `dist/index.html` directly also works (everything except `/mcp`). To make an offline copy with a script built in: `node scripts/embed.mjs script.md out.html`.

## Deploy your own copy

It runs on the Cloudflare Workers **free plan**: one Worker serves the page as static assets and answers `/mcp`, and one Durable Object class (SQLite-backed, the kind the free plan allows) does the rate limiting.

1. Make a free Cloudflare account and log in: `npx wrangler login`.
2. In `wrangler.jsonc`, change `"name"` if you like, and replace the `routes` entry `prompter.techies.tools` with your own domain (it must be a zone in your Cloudflare account). No domain? Remove `routes` and set `"workers_dev": true` to get a `*.workers.dev` address.
3. Deploy: `node scripts/build.mjs && npx wrangler deploy`. The first deploy creates the Durable Object class from the `migrations` entry.

Links made by your copy, and the server address in its demo script, follow your own address automatically. Three places still name `prompter.techies.tools`; change them to yours: `SITE` in `src/core.mjs` (used by offline copies opened from a file) and the `make_prompter_link` description and `instructions` text in `src/mcp.mjs`.

## Contributing

Issues and pull requests are welcome. Please keep the promises above: scripts never reach server storage or logs, the page stays one self-contained file that works offline, and everything fits the Cloudflare free plan. Run `node --test test/*.test.mjs` before you send a change, and keep changes small and focused.

## Maintainer tooling

`scripts/agents/` holds the Agent Kit, the maintainer's development tooling for AI coding agents (checks, browser screenshots and reviews). See [`docs/agents/agent-scripts.md`](docs/agents/agent-scripts.md) and [`AGENTS.md`](AGENTS.md). You don't need it to build, test or deploy. Some defaults point to the maintainer's own folders and can be changed with environment variables (`KIT_MAIN_ROOT`, `KIT_PLAYWRIGHT_MODULE`).

## License

[MIT](LICENSE) © 2026 Lex (Techies Reviews)
