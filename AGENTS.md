# techies-prompter

Public teleprompter at https://prompter.techies.tools plus an open, stateless MCP endpoint at `/mcp`. Owner: Lex (non-technical; explain in plain words).

## Rules

- Agent Kit is required for all coding: read `docs/agents/agent-scripts.md`, run `scripts/agents/kit --help` and `kit doctor` first, then `kit specs` (and `kit shots`, `kit size` for page changes). Delegated work must carry this requirement.
- Scripts stay on the user's device. Never add server-side storage (KV, D1, R2, Durable Objects, Cache API for scripts) or logging of request bodies. Keep `observability` off. Scripts travel only in the URL fragment `#s=`.
- Cloudflare free plan only. No paid features.
- `src/core.mjs` is the single source of truth for the format, presets ("lex" and "default"), checker and link encoding. The page inlines it at build time, so it must stay import-free and use only `export function`/`export const` forms.
- The built page must stay one self-contained HTML file that works offline (no external scripts, styles, fonts or fetches).
- CSS: simple, low-specificity, shared helpers first; bounded component overrides with `@scope` only where losing them is harmless. Respect `prefers-reduced-motion`. Keep mobile usable.
- Review with `kit review` (Claude only). Do not run GPT/Codex reviews.
- Do not deploy, push or change Cloudflare resources unless the lead says so.
