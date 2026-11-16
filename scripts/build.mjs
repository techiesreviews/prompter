#!/usr/bin/env node
// Builds dist/: one self-contained index.html (core, follow, the open script's state, speech, agent, the relay's wire list and tab
// link, camframe, the reading line, the range field + app inlined, and the range field's styles), the _headers file whose
// Content-Security-Policy pins that inline script's hash, and the two font files
// (the page falls back to system fonts without them).
// Usage: node scripts/build.mjs [outDir=dist] [--host <host> | --host=<host>]
// --host names the address the page is served from (default the live prompter.techies.tools): the relay's
// WebSocket is allowed there, and any other address (the preview) asks search engines to stay away.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(join(root, file), "utf8");

/** Font files served from /fonts/ (SIL OFL 1.1; the licence travels with them). */
export const FONTS = ["inter-latin.woff2", "roboto-mono-latin.woff2", "OFL.txt"];

/**
 * Shared modules inlined into the page, in this order, without `export`. A module may import names from
 * one inlined before it (`import { … } from "./wire.mjs";`): they share the page's scope, so that line is dropped.
 */
export const INLINED = ["src/core.mjs", "src/follow.mjs", "src/open-script.mjs", "src/speech.mjs", "src/agent.mjs", "src/wire.mjs", "src/relay-link.mjs", "src/camframe.mjs", "src/reading-line.mjs", "src/ui/range-field.mjs"];

/** Shared component styles inlined into the page's style at its marker. */
export const UI_CSS = ["src/ui/range-field.css"];

/** Inline the page script: the shared modules, then the app, in one function scope. */
export function pageScript(files = INLINED, source = read) {
  const modules = files.map((file, i) => {
    const code = source(file).replace(/^import \{([^}]*)\} from "(\.\.?\/[^"]+)";[ \t]*\n/gm, (line, names, spec) => {
      if (/\bas\b/.test(names)) throw new Error(`${file}: an aliased import (${line.trim()}) cannot be inlined`);
      if (!files.slice(0, i).includes(posix.join(posix.dirname(file), spec))) throw new Error(`${file} imports ${spec}, which is not inlined before it`);
      return "";
    });
    if (/^\s*import\s/m.test(code)) throw new Error(`${file} must not import anything`);
    const stripped = code.replace(/^export (?=(async )?function |const |let |class )/gm, "");
    if (/^export\b/m.test(stripped)) throw new Error(`${file} has an export form the build cannot strip`);
    return stripped;
  });
  return `\n(() => {\n${modules.join("\n")}\n${source("src/app.js")}\n})();\n`;
}

/** The live address; a build for any other host (the preview) is kept out of search engines. */
export const LIVE_HOST = "prompter.techies.tools";

export function build(dir = join(root, "dist"), { host = LIVE_HOST } = {}) {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) throw new Error(`not a host name: ${host}`);
  const cssMarker = "/*@UI-CSS@*/";
  const page = read("src/page.html");
  if (!page.includes(cssMarker)) throw new Error(`src/page.html is missing ${cssMarker}`);
  const template = page.replace(cssMarker, () => UI_CSS.map((file) => read(file).trim()).join("\n"));
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
    // browsers whose 'self' does not cover it), plus CamFrame on this computer once the user turns on its link,
    // and room for OBS's WebSocket on this computer (its default port 4455; the page makes no OBS call yet).
    `connect-src 'self' wss://${host} http://127.0.0.1:47833 ws://127.0.0.1:4455 ws://localhost:4455`,
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
  writeFileSync(join(dir, "robots.txt"), host === LIVE_HOST ? "User-agent: *\nAllow: /\nDisallow: /mcp\n" : "User-agent: *\nDisallow: /\n");
  mkdirSync(join(dir, "fonts"), { recursive: true });
  for (const file of FONTS) copyFileSync(join(root, "fonts", file), join(dir, "fonts", file));
  return { html, headers, hash, dir };
}

if (import.meta.main) {
  // A --host with no value, or any other flag, stops the build rather than quietly building for the live site.
  const args = process.argv.slice(2);
  let host = LIVE_HOST;
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host" && args[i + 1] && !args[i + 1].startsWith("-")) host = args[++i];
    else if (args[i].startsWith("--host=")) host = args[i].slice("--host=".length);
    else if (args[i].startsWith("-") || dirs.length) { console.error(`Usage: node scripts/build.mjs [outDir=dist] [--host <host>] (not: ${args.slice(i).join(" ")})`); process.exit(2); }
    else dirs.push(args[i]);
  }
  const { dir, html } = build(resolve(root, dirs[0] || "dist"), { host });
  console.log(`Wrote ${dir}/index.html (${html.length} bytes), _headers, robots.txt, fonts/ for ${host}`);
}
