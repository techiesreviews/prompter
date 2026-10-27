# Prompter

A free teleprompter for talking to camera: https://prompter.techies.tools

- Big text, auto-scroll, a reading line, a show clock and a second "main screen" window that opens each section's links (YouTube links play full size).
- No accounts and no server storage. A shared link carries the whole script in the URL fragment (`#s=`, deflate-raw + base64url), which browsers never send to a server. The last script is remembered in this browser only.
- Works offline: the page is one self-contained HTML file. `node scripts/embed.mjs script.md out.html` makes an offline copy with a script built in.
- Open MCP server at `https://prompter.techies.tools/mcp` (Streamable HTTP, stateless, JSON responses, no auth). Tools: `get_format`, `check_script`, `make_prompter_link`. Prompt: `write_prompter_script`. 60 requests per minute per IP; 200 KB request limit.

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
