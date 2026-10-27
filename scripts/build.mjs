#!/usr/bin/env node
// Builds dist/: one self-contained index.html (core + app inlined) and the
// _headers file whose Content-Security-Policy pins that inline script's hash.
// Usage: node scripts/build.mjs [outDir=dist]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(join(root, file), "utf8");

/** Inline the page script: core without `export`, then the app, in one function scope. */
export function pageScript() {
  const core = read("src/core.mjs");
  if (/^\s*import\s/m.test(core)) throw new Error("src/core.mjs must not import anything");
  const stripped = core.replace(/^export (?=(async )?function |const |let |class )/gm, "");
  if (/^export\b/m.test(stripped)) throw new Error("src/core.mjs has an export form the build cannot strip");
  return `\n(() => {\n${stripped}\n${read("src/app.js")}\n})();\n`;
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
    "frame-src https://www.youtube.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = `/*
  Content-Security-Policy: ${csp}
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=()
`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "_headers"), headers);
  writeFileSync(join(dir, "robots.txt"), "User-agent: *\nAllow: /\nDisallow: /mcp\n");
  return { html, headers, hash, dir };
}

if (import.meta.main) {
  const { dir, html } = build(resolve(root, process.argv[2] || "dist"));
  console.log(`Wrote ${dir}/index.html (${html.length} bytes), _headers, robots.txt`);
}
