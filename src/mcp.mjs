// Stateless MCP server (Streamable HTTP, JSON responses only) for /mcp.
// Nothing is stored: scripts arrive in the request body, are checked or
// encoded in memory, and leave only in the response.
import { check, describeProblems, formatGuide, makeLink, MAX_SCRIPT_CHARS, PRESETS } from "./core.mjs";
import { RATE_LIMIT } from "./limiter.mjs";

export const MAX_BODY_BYTES = 200 * 1024;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "techies-prompter", title: "Prompter", version: "1.0.0" };
const LONG_LINK = 16_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

const presetSchema = { type: "string", enum: Object.keys(PRESETS), description: "Style rules: \"lex\" (strict, five-word lines) or \"default\" (softer). Default: \"default\"." };
const markdownSchema = { type: "string", description: `The prompter script in Markdown (at most ${MAX_SCRIPT_CHARS} characters).` };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: "get_format",
    title: "Get the prompter script format",
    description: "Returns the prompter script format, the rules of a style preset and a short example. Call this before writing a prompter script.",
    inputSchema: { type: "object", properties: { preset: presetSchema }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "check_script",
    title: "Check a prompter script",
    description: "Checks a prompter script against a preset and lists problems with their section and line: lines with too many words, a missing QL main question, links that are not first, missing titles, and so on.",
    inputSchema: { type: "object", properties: { markdown: markdownSchema, preset: presetSchema }, required: ["markdown"], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "make_prompter_link",
    title: "Make a prompter link",
    description: "Checks the script, then returns a https://prompter.techies.tools/#s=… link that opens it in the prompter. The script is packed into the link itself; nothing is stored on any server. Give the link to the user.",
    inputSchema: { type: "object", properties: { markdown: markdownSchema, preset: presetSchema }, required: ["markdown"], additionalProperties: false },
    annotations: readOnly,
  },
];

export const PROMPTS = [
  {
    name: "write_prompter_script",
    title: "Write a prompter script",
    description: "Interview the user about a video or livestream, then write a prompter script and give them a prompter link.",
    arguments: [
      { name: "topic", description: "What the video or livestream is about.", required: true },
      { name: "preset", description: "\"lex\" or \"default\" (default).", required: false },
    ],
  },
];

function writePrompt(topic, presetName) {
  const preset = PRESETS[presetName] ? presetName : "default";
  return `Help me write a teleprompter script for a video about: ${topic}

Work like this:
1. Call the get_format tool with preset "${preset}" and follow its rules exactly.
2. Interview me before writing. Ask one short question at a time, and wait for my answer. Find out: who it is for, the one thing they should take away, how long it is, whether it is live or recorded, the main sections, the links or pages I want to show on screen in each section, and how I want to open and close. Ask what I actually think; never invent facts, results, numbers or quotes for me.
3. Propose the list of sections with start times, and let me change it.
4. Write the script in the prompter Markdown format: links first in a section (they open when it starts) or on the line where I talk about them (they open when I reach that line), one "QL:" main question that I answer in my own words, then short spoken lines in my voice.
5. Call check_script with preset "${preset}" and fix every error. Warnings are fine if they are on purpose.
6. Call make_prompter_link with preset "${preset}" and give me the link. Tell me that the script lives only in that link and on my device, so I should keep the link or the Markdown.`;
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const text = (t) => ({ type: "text", text: t });

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra } });
}

function toolError(message) {
  return { content: [text(message)], isError: true };
}

function scriptArg(args) {
  if (typeof args.markdown !== "string" || !args.markdown.trim()) return { error: "\"markdown\" must be the script text." };
  if (args.markdown.length > MAX_SCRIPT_CHARS) return { error: `The script is longer than ${MAX_SCRIPT_CHARS} characters.` };
  if (args.preset !== undefined && !PRESETS[args.preset]) return { error: `Unknown preset "${args.preset}". Use ${Object.keys(PRESETS).join(" or ")}.` };
  return { markdown: args.markdown, preset: args.preset || "default" };
}

async function callTool(name, args, origin) {
  if (name === "get_format") {
    if (args.preset !== undefined && !PRESETS[args.preset]) return toolError(`Unknown preset "${args.preset}".`);
    return { content: [text(formatGuide(args.preset || "default"))] };
  }
  const input = scriptArg(args);
  if (input.error) return toolError(input.error);
  const report = check(input.markdown, input.preset);
  if (name === "check_script") {
    return { content: [text(describeProblems(report))], structuredContent: report };
  }
  // make_prompter_link
  const link = await makeLink(input.markdown, input.preset, origin);
  const notes = [describeProblems(report)];
  if (link.length > LONG_LINK) notes.push(`The link is long (${link.length} characters); some chat apps may cut it. Shorter scripts make shorter links.`);
  return {
    content: [text(`Prompter link (the script is inside the link; nothing is stored):\n${link}\n\n${notes.join("\n\n")}`)],
    structuredContent: { link, ...report },
  };
}

async function handleMessage(msg, origin) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid request");
  }
  const isNotification = !("id" in msg);
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  if (isNotification) return null;
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return result(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER,
        instructions: "Writes teleprompter scripts for https://prompter.techies.tools. Call get_format first, interview the user, write the script, run check_script, then make_prompter_link and give the user the link. Nothing is stored server-side.",
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      return result(id, await callTool(tool.name, args, origin));
    }
    case "prompts/list":
      return result(id, { prompts: PROMPTS });
    case "prompts/get": {
      if (params.name !== "write_prompter_script") return rpcError(id, -32602, `Unknown prompt: ${params.name}`);
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim().slice(0, 500) : "(ask me)";
      return result(id, {
        description: PROMPTS[0].description,
        messages: [{ role: "user", content: text(writePrompt(topic, args.preset)) }],
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Read the body, refusing anything above MAX_BODY_BYTES even without Content-Length. */
async function readCapped(request) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder().decode(all);
}

/**
 * Per-isolate fixed-window counter. Runs on every request before the Durable
 * Object limiter. When full it drops expired entries, then the oldest window starts,
 * so rotating IPs cannot reset every count at once.
 */
export function memoryLimiter(limit = RATE_LIMIT, windowMs = 60_000, now = () => Date.now(), maxKeys = 10_000) {
  const hits = new Map();
  return {
    async limit({ key }) {
      const t = now();
      const entry = hits.get(key);
      if (!entry || t - entry.start >= windowMs) {
        if (hits.size >= maxKeys) {
          // Map order is insertion order (oldest first): only scan when the oldest has expired.
          if (t - hits.values().next().value.start >= windowMs) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
          for (const k of hits.keys()) { if (hits.size < maxKeys) break; hits.delete(k); }
        }
        hits.delete(key);
        hits.set(key, { start: t, count: 1 });
        return { success: true };
      }
      entry.count += 1;
      return entry.count <= limit ? { success: true } : { success: false, max: limit, ms: windowMs };
    },
  };
}

const instanceGuard = memoryLimiter();

/** "60 per minute" or "10 per 10 seconds": the limit that refused, else the minute limit. */
function describeLimit({ max, ms }) {
  if (!max || !ms) return "";
  const seconds = Math.round(ms / 1000);
  return ` Limit: ${max} per ${seconds === 60 ? "minute" : `${seconds} seconds`}.`;
}

/**
 * Handle one HTTP request to /mcp. The per-isolate guard runs first and stops
 * bursts that land on one instance without any extra call. `limiter` is the
 * per-client Durable Object limiter (see limiter.mjs), the one that holds
 * across instances; both use the `limit({ key })` shape and a request must
 * pass both.
 */
export async function handleMcp(request, { limiter, guard = instanceGuard } = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") {
    return json(rpcError(null, -32000, "Method not allowed. This MCP server only accepts POST (no SSE stream)."), 405, { Allow: "POST, OPTIONS" });
  }

  const key = request.headers.get("cf-connecting-ip") || "local";
  let verdict = await guard.limit({ key });
  if (verdict.success && limiter) verdict = await limiter.limit({ key });
  if (!verdict.success) {
    const wait = verdict.retryAfter || 60;
    return json(rpcError(null, -32000, `Too many requests.${describeLimit(verdict)} Try again in ${wait} seconds.`), 429, { "Retry-After": String(wait) });
  }

  const raw = await readCapped(request);
  if (raw === null) return json(rpcError(null, -32000, `Request too large. Limit: ${MAX_BODY_BYTES / 1024} KB.`), 413);

  let body;
  try { body = JSON.parse(raw); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }

  const origin = new URL(request.url).origin;
  if (Array.isArray(body)) {
    if (!body.length) return json(rpcError(null, -32600, "Invalid request"), 400);
    if (body.length > 20) return json(rpcError(null, -32600, "Batch too large"), 400);
    const replies = (await Promise.all(body.map((m) => handleMessage(m, origin)))).filter(Boolean);
    return replies.length ? json(replies) : new Response(null, { status: 202, headers: CORS });
  }
  const reply = await handleMessage(body, origin);
  return reply ? json(reply) : new Response(null, { status: 202, headers: CORS });
}
