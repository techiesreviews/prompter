# Prompter

A free teleprompter for talking to camera: https://prompter.techies.tools

- Big text, auto-scroll, a reading line, a show clock and a second "main screen" window that opens each section's links (YouTube links play full size).
- No accounts and no server storage. A shared link carries the whole script in the URL fragment (`#s=`, deflate-raw + base64url), which browsers never send to a server. The last script is remembered in this browser only.
- Works offline: the page is one self-contained HTML file. `node scripts/embed.mjs script.md out.html` makes an offline copy with a script built in.
- Open MCP server at `https://prompter.techies.tools/mcp` (Streamable HTTP, stateless, JSON responses, no auth). Tools: `get_format`, `check_script`, `make_prompter_link`. Prompt: `write_prompter_script`. 200 KB request limit. Rate limit: 60 requests per minute and 10 per 10 seconds per client (see "Limits" below).

## Limits

- `/mcp` is limited per client by a Durable Object (free plan, SQLite-backed class). The Worker hashes the client IP with a fixed salt (SHA-256; IPv6 grouped by /64) and uses the hash to pick one object per client, so the object never sees an IP. The object keeps the times of recent requests in memory only: it never writes to its storage, gets no request body (so never a script) and logs nothing. Counts disappear when it has been idle for about 10 seconds and Cloudflare drops it from memory. Over the limit, `/mcp` answers HTTP 429 with a JSON-RPC error and `Retry-After`.
- The 10-per-10-seconds burst cap also covers that reset: a client that pauses to clear its count still gets at most about 60 a minute.
- An in-memory guard in each Worker instance (60 per minute) runs first and stops bursts without calling the object. If the object errors or is slow, `/mcp` keeps working (fail open).
- The free Workers rate-limiting binding was removed: in a live test on 2026-10-27 it allowed about 250 requests from one IP within a few minutes.
- Cost cannot run away: the free plan has no billing for overage. Past 100,000 Worker requests a day, `/mcp` returns errors until the next day; the page itself is served as static assets and keeps working. Durable Objects have their own free daily allowance; when it runs out, the limiter fails open.

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

Presets live in `src/core.mjs` (`lex` strict, `default` softer) and are shared by the page, the checker and the MCP.

## Develop

See `AGENTS.md` and `docs/agents/agent-scripts.md` (Agent Kit). Build: `node scripts/build.mjs` → `dist/`. No npm dependencies.
