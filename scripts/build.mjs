#!/usr/bin/env node
// Builds dist/: one self-contained index.html (core, follow, agent + app inlined), the
// _headers file whose Content-Security-Policy pins that inline script's hash,
// and the two font files (the page falls back to system fonts without them).
// Usage: node scripts/build.mjs [outDir=dist]
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(join(root, file), "utf8");

/** Font files served from /fonts/ (SIL OFL 1.1; the licence travels with them). */
export const FONTS = ["inter-latin.woff2", "roboto-mono-latin.woff2", "OFL.txt"];

/** Shared modules inlined into the page, in this order, without `export`. */
export const INLINED = ["src/core.mjs", "src/follow.mjs", "src/agent.mjs"];

/** Inline the page script: the shared modules, then the app, in one function scope. */
export function pageScript() {
  const modules = INLINED.map((file) => {
    const source = read(file);
    if (/^\s*import\s/m.test(source)) throw new Error(`${file} must not import anything`);
    const stripped = source.replace(/^export (?=(async )?function |const |let |class )/gm, "");
    if (/^export\b/m.test(stripped)) throw new Error(`${file} has an export form the build cannot strip`);
    return stripped;
  });
  return `\n(() => {\n${modules.join("\n")}\n${read("src/app.js")}\n})();\n`;
}

export function build(dir = join(root, "dist")) {
  const template = read("src/page.html");
  const marker = "<script>/*@APP@*/</script>";
  if (!template.includes(marker)) throw new Error(`src/page.html is missing ${marker}`);
  const script = pageScript();
  if (/<\/script/i.test(script)) throw new Error("page script must not contain </script");
  const html = template.replace(marker, () => `<script>${script}</script>`);
  const hash = createHash("sha256").update(script).digest("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src 'self'",
    // Only the page's own calls: a token for Wait for MCP and the relay's WebSocket (wss: spelled out for
    // browsers whose 'self' does not cover it).
    "connect-src 'self' wss://prompter.techies.tools",
    "frame-src https://www.youtube.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = `/*
  Content-Security-Policy: ${csp}
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(self), geolocation=()
/fonts/*
  Cache-Control: public, max-age=2592000
`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "_headers"), headers);
  writeFileSync(join(dir, "robots.txt"), "User-agent: *\nAllow: /\nDisallow: /mcp\n");
  mkdirSync(join(dir, "fonts"), { recursive: true });
  for (const file of FONTS) copyFileSync(join(root, "fonts", file), join(dir, "fonts", file));
  return { html, headers, hash, dir };
}

if (import.meta.main) {
  const { dir, html } = build(resolve(root, process.argv[2] || "dist"));
  console.log(`Wrote ${dir}/index.html (${html.length} bytes), _headers, robots.txt, fonts/`);
}
