// Live relay between someone's own AI agent (MCP over HTTP on /mcp) and their
// open prompter tab (a WebSocket on /api/relay), as in the script editor.
// One Durable Object per hashed token. It stores only
// { createdAt, expiresAt, revoked, agent: { name, version } }, never script
// text: tool calls and their results pass through memory. An alarm just after
// expiresAt erases the note. Nothing is logged.
import { DurableObject } from "cloudflare:workers";
import { MAX_AGE_MS } from "./token.mjs";

export const PROTOCOL = "prompter";
export const ALARM_SLACK_MS = 60_000;
const MAX_CALL_MS = 35_000;
const dueOf = (meta) => meta.expiresAt + ALARM_SLACK_MS;

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    this.earlyAgent = null; // an agent that said hello before any tab: kept in memory until one connects
    // Keepalive pings from the tab are answered without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  now() { return Date.now(); }
  async meta() {
    return (await this.ctx.storage.get("meta")) ?? null;
  }
  valid(meta) {
    const now = this.now();
    return !!meta && !meta.revoked && now - meta.createdAt < MAX_AGE_MS && now < meta.expiresAt;
  }
  // Every write sets the alarm, so no note outlives its expiry.
  async save(meta) {
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(dueOf(meta));
  }
  tab() {
    return this.ctx.getWebSockets("tab").at(-1) ?? null;
  }
  send(ws, message) {
    try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  // The tab connects here. The Worker has already checked the token and passes its birth time.
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const born = Number(request.headers.get("X-Token-Born"));
    const now = this.now();
    let meta = await this.meta();
    const [client, server] = Object.values(new WebSocketPair());
    const late = !meta && !(born > 0 && now - born < MAX_AGE_MS);
    if (late || (meta && !this.valid(meta))) {
      // Not kept: accepted only to say why (4003 makes the tab forget the token), then closed.
      server.accept();
      server.close(4003, meta?.revoked ? "revoked" : "expired");
    } else {
      if (!meta) {
        meta = { createdAt: born, expiresAt: born + MAX_AGE_MS, revoked: false, agent: this.earlyAgent ?? null };
        this.earlyAgent = null;
        await this.save(meta);
      }
      // Only the newest tab receives calls; the others hear 4001 and offer "Use this tab".
      for (const old of this.ctx.getWebSockets("tab")) {
        try { old.close(4001, "Open in another tab"); } catch { /* already closed */ }
      }
      this.ctx.acceptWebSocket(server, ["tab"]);
      this.send(server, { type: "ready", createdAt: meta.createdAt });
      if (meta.agent) this.send(server, { type: "agent", ...meta.agent });
    }
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": PROTOCOL } });
  }

  async webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)); } catch { return; }
    if (msg?.type === "result" && typeof msg.id === "string") {
      this.pending.get(msg.id)?.done({ status: "ok", result: msg.result, error: msg.error });
    } else if (msg?.type === "ping") {
      this.send(ws, { type: "pong" });
    } else if (msg?.type === "revoke") {
      // Disconnect MCP. The revoked note stays until its alarm, so the token is refused until it
      // would have expired anyway. Without a note (rare) it is kept as long as any token could live.
      const now = this.now();
      const meta = (await this.meta()) ?? { createdAt: now, expiresAt: now + MAX_AGE_MS };
      await this.save({ ...meta, revoked: true, agent: null });
      for (const p of this.pending.values()) p.done({ status: "unauthorized" });
      for (const s of this.ctx.getWebSockets()) { try { s.close(4003, "revoked"); } catch { /* closed */ } }
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* closed */ }
  }

  // The note's time is up: whatever waits is refused, the tab is told, and the object is emptied.
  async alarm() {
    const meta = await this.meta();
    if (meta && this.now() < dueOf(meta)) return this.ctx.storage.setAlarm(dueOf(meta));
    for (const p of this.pending.values()) p.done({ status: "unauthorized" });
    for (const s of this.ctx.getWebSockets()) { try { s.close(4003, "expired"); } catch { /* closed */ } }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // Called by the Worker for each MCP request; message.born is the token's birth time.
  // Answers { status: "ok" | "unauthorized" | "no-tab" | "timeout", result?, error? }.
  async op(message) {
    if (!(message.born > 0) || this.now() - message.born >= MAX_AGE_MS) return { status: "unauthorized" };
    const meta = await this.meta();
    // No note yet: the tab has not reached the relay (still connecting, or its socket is blocked).
    // A young token without a note was never revoked (a revoked note stays until its alarm), so
    // the agent is told to wait for the tab ("no-tab") instead of a 401. Nothing is written here:
    // tokens are not signed, so only a tab (through /api/relay and its guard) starts a note. The
    // agent's name waits in memory and goes into the note the tab starts.
    if (!meta) {
      if (message.op === "agent") this.earlyAgent = { name: String(message.name ?? "").slice(0, 60), version: String(message.version ?? "").slice(0, 30) };
      return { status: message.op === "call" ? "no-tab" : "ok" };
    }
    if (!this.valid(meta)) return { status: "unauthorized" };
    if (message.op === "auth") return { status: "ok" };
    if (message.op === "agent") {
      meta.agent = { name: String(message.name ?? "").slice(0, 60), version: String(message.version ?? "").slice(0, 30) };
      await this.save(meta);
      const ws = this.tab();
      if (ws) this.send(ws, { type: "agent", ...meta.agent });
      return { status: "ok" };
    }
    if (message.op === "call") {
      const ws = this.tab();
      if (!ws) return { status: "no-tab" };
      const id = crypto.randomUUID();
      const timeout = Math.min(Math.max(Number(message.timeout) || 10_000, 1_000), MAX_CALL_MS);
      return await new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(id); resolve({ status: "timeout" }); }, timeout);
        this.pending.set(id, { done: (r) => { clearTimeout(timer); this.pending.delete(id); resolve(r); } });
        if (!this.send(ws, { type: "call", id, tool: message.tool, args: message.args ?? {} })) {
          this.pending.get(id)?.done({ status: "no-tab" });
        }
      });
    }
    return { status: "ok" };
  }
}
