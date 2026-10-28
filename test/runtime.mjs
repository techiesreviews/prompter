// Stand-ins for the Workers runtime, so Node can load src/worker.mjs and
// src/relay.mjs (as in the script editor's tests). Import this first, then
// load those modules with a dynamic import().
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
  return next(specifier, context);
}`));

export class FakeSocket {
  constructor() { this.sent = []; this.closed = false; this.accepted = false; }
  accept() { this.accepted = true; }
  send(text) { if (this.closed) throw new Error("closed"); this.sent.push(JSON.parse(text)); }
  close(code = 1000, reason = "") { if (this.closed) return; this.closed = true; this.code = code; this.reason = reason; }
}
export const pairs = [];
globalThis.WebSocketPair ??= class { constructor() { this[0] = new FakeSocket(); this[1] = new FakeSocket(); pairs.push(this); } };
globalThis.WebSocketRequestResponsePair ??= class { constructor(request, response) { Object.assign(this, { request, response }); } };
// Node's Response refuses status 101; the Workers runtime allows it with a socket.
if (!globalThis.Response.workersStub) {
  const BaseResponse = globalThis.Response;
  globalThis.Response = class extends BaseResponse {
    static workersStub = true;
    constructor(body, init = {}) {
      if (init?.status !== 101) { super(body, init); return; }
      super(null, { ...init, status: 200 });
      Object.defineProperty(this, "status", { value: 101 });
      this.socket = init.webSocket;
    }
  };
}
