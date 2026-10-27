#!/usr/bin/env node
// Makes an offline copy of the prompter with one script built in, for use
// without a network. Run `node scripts/build.mjs` first.
// Usage: node scripts/embed.mjs <script.md> <out.html>
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [md, out] = process.argv.slice(2);
if (!md || !out) {
  console.error("Usage: node scripts/embed.mjs <script.md> <out.html>");
  process.exit(1);
}
const template = readFileSync(join(resolve(import.meta.dirname, ".."), "dist/index.html"), "utf8");
const script = readFileSync(md, "utf8");
if (/<\/script/i.test(script)) throw new Error("Script text must not contain </script");
const start = "<!--SCRIPT-START-->";
const end = "<!--SCRIPT-END-->";
const before = template.slice(0, template.indexOf(start) + start.length);
const after = template.slice(template.indexOf(end));
writeFileSync(out, `${before}\n${script.trim()}\n${after}`);
console.log(`Wrote ${out}`);
