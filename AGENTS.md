# techies-prompter

Public teleprompter at https://prompter.techies.tools plus an open, stateless MCP endpoint at `/mcp`. Owner: Lex (non-technical; explain in plain words).

## Rules

- Agent Kit is required for all coding: read `docs/agents/agent-scripts.md`, run `scripts/agents/kit --help` and `kit doctor` first, then `kit specs` (and `kit shots`, `kit size` for page changes). Delegated work must carry this requirement.
- Scripts stay on the user's device. Never add server-side storage (KV, D1, R2, Durable Object storage, Cache API for scripts) or logging of request bodies. Keep `observability` off. Scripts travel only in the URL fragment `#s=`.
- The one exception is the `/mcp` rate limiter in `src/limiter.mjs`: a Durable Object per hashed client (salted SHA-256 of the IP, never the raw IP) that counts requests in memory only. It must never use `ctx.storage`, receive a request body, or log. Only `/mcp` may call it.
- Cloudflare free plan only. No paid features.
- `src/core.mjs` is the single source of truth for the format, presets ("lex" and "default"), checker, link encoding and the demo script. The page inlines it (and `src/follow.mjs`, the voice-follow line matching) at build time, so both must stay import-free and use only `export function`/`export const` forms.
- Follow my voice uses the browser's own speech recognition (Web Speech API) and is opt-in after a notice that the browser sends audio to its speech service. The page itself never sends audio or the script anywhere. The page's `Permissions-Policy` allows the microphone for this origin only.
- Design: the Techies Reviews dark palette (indigo night page, bright orange actions), Inter and Roboto Mono, centred script, settings sidebar (bottom sheet on phones) and a floating control bar. Text colours must meet WCAG AA (4.5:1) on their backgrounds; white on orange only at 19px bold (large text). `test/contrast.test.mjs` checks the `oklch()` tokens in `src/page.html`.
- The built page must stay one self-contained HTML file that works offline (no external scripts, styles or fetches). The only extra files are the two fonts in `fonts/` (SIL OFL 1.1, licence in `fonts/OFL.txt`), served from `/fonts/` (CSP `font-src 'self'`); the page adds their `@font-face` only when served over http(s), so a file:// copy uses system fonts.
- CSS: simple, low-specificity, shared helpers first; bounded component overrides with `@scope` only where losing them is harmless. Respect `prefers-reduced-motion`. Keep mobile usable.
- Review with `kit review` (Claude only). Do not run GPT/Codex reviews.
- Do not deploy, push or change Cloudflare resources unless the lead says so.
