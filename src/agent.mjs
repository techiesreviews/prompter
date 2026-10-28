// The messages Wait for MCP and Copy MCP put on the clipboard, and the
// connected agent's name as the page shows it. scripts/build.mjs inlines this
// file into the page (like core.mjs), so it stays import-free and uses only
// `export function` / `export const`. test/mcp.test.mjs checks the messages
// against the server.

const AGENT_BRANDS = [
  [/claude|anthropic/i, "Claude"],
  [/codex/i, "Codex"],
  [/chatgpt|openai/i, "ChatGPT"],
  [/gemini/i, "Gemini"],
  [/cursor/i, "Cursor"],
  [/copilot/i, "Copilot"],
];

/**
 * The agent's name from its MCP clientInfo name, as the script editor shows
 * it: the model's own name for known agents ("claude-code" → "Claude"), else
 * the name made readable ("my-tool" → "My Tool", a trailing "client" dropped).
 */
export function agentName(raw) {
  let name = String(raw || "").trim();
  const known = AGENT_BRANDS.find(([re]) => re.test(name));
  if (known) return known[1];
  const bare = name.replace(/[\s_-]+(?:mcp[\s_-]+)?client$/i, "").trim();
  if (bare) name = bare;
  if (!name) return "Agent";
  if (!/[A-Z ]/.test(name)) name = name.split(/[-_]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return name.slice(0, 60);
}

const mdCode = (text) => `\`${text}\``;
const MCP_HEADERS = `${mdCode("Content-Type: application/json")} and ${mdCode("Accept: application/json, text/event-stream")}`;

/**
 * Wait for MCP: a temporary, direct connection (curl, no MCP settings) with
 * this tab's token, so the agent can put the script into the open prompter.
 */
export function connectionPrompt(url, token, preset) {
  return `Connect to my Prompter for this conversation using a temporary, direct MCP connection over streamable HTTP, so you can help me write a teleprompter script and put it in my open prompter.

Server: ${mdCode(url)}

Authorization: ${mdCode(`Bearer ${token}`)}

**Use curl to send MCP JSON-RPC requests. Do not modify MCP configuration, install anything, create helper files, or restart yourself.** Keep the token in memory; never save it or repeat it in responses.

Send each JSON-RPC message as its own POST with the headers ${mdCode("Authorization")}, ${MCP_HEADERS}; the response body is the JSON-RPC result. Start with ${mdCode("initialize")} (protocolVersion "2025-11-25"), then use ${mdCode("tools/call")}. Give curl a timeout of at least 40 seconds. Use the style preset ${mdCode(preset)} in every tool call.

1. Call ${mdCode("get_format")} and follow the format and the rules it returns.
2. Interview me about my video or livestream, a few questions at a time.
3. Write the script, call ${mdCode("check_script")} and fix what it reports.
4. Call ${mdCode("show_script")}: it opens the script in my prompter, in the tab where I copied this message. To change the script that is open there, read it first with ${mdCode("get_open_script")}. Call ${mdCode("make_prompter_link")} only if I ask for a link.

Everything stops when I choose Disconnect MCP: calls then fail with 401, so discard the token. The token also stops working after eight hours.`;
}

/**
 * Copy MCP in an offline copy (opened from a file, so no live connection):
 * the open server, which answers with a link instead.
 */
export function openPrompt(url, preset) {
  return `Connect to Prompter for this conversation using a temporary, direct MCP connection over streamable HTTP, so you can help me write a teleprompter script.

Server: ${mdCode(url)} (open, no sign-in)

**Use curl to send MCP JSON-RPC requests. Do not modify MCP configuration, install anything, create helper files, or restart yourself.**

Send each JSON-RPC message as its own POST with the headers ${MCP_HEADERS}; the response body is the JSON-RPC result. Start with ${mdCode("initialize")} (protocolVersion "2025-11-25"), then use ${mdCode("tools/call")}. Use the style preset ${mdCode(preset)} in every tool call.

1. Call ${mdCode("get_format")} and follow the format and the rules it returns.
2. Interview me about my video or livestream, a few questions at a time.
3. Write the script, call ${mdCode("check_script")} and fix what it reports.
4. Call ${mdCode("make_prompter_link")} and give me the link: it opens the script in the prompter. The script travels inside the link; nothing is stored on the server.`;
}
