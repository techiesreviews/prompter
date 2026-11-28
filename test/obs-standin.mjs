// A stand-in for OBS's own WebSocket server (obs-websocket protocol v5) for the tests and the browser
// checks: never a real OBS. It speaks just enough of the protocol for the OBS link in src/obs.mjs:
// Hello (with an authentication challenge when it has a password), Identify, Identified, the
// RecordStateChanged event and the requests the page sends. Built on node:http alone (no packages),
// with the small part of the WebSocket wire format a browser and Node's own WebSocket need.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sha = (s) => createHash("sha256").update(s).digest("base64");

/** One WebSocket text frame from the server (servers never mask). */
function frame(text, opcode = 1) {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x80 | opcode, body.length])
    : body.length < 65536 ? Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(body.length)); return b; })()]);
  return Buffer.concat([head, body]);
}

/** Frames read from a client's bytes so far: [{ opcode, data }], and the bytes left over. */
function readFrames(buf) {
  const out = [];
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 15;
    let len = buf[1] & 127;
    let at = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); at = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); at = 10; }
    const masked = buf[1] & 128;
    const need = at + (masked ? 4 : 0) + len;
    if (buf.length < need) break;
    const mask = masked ? buf.subarray(at, at + 4) : null;
    const data = Buffer.from(buf.subarray(need - len, need));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    out.push({ opcode, data });
    buf = buf.subarray(need);
  }
  return { frames: out, rest: buf };
}

/**
 * Starts the stand-in. `password` (a made-up test value, never a real one) makes it ask for
 * authentication as OBS does. `answer(type, data)` may answer one request its own way:
 * { ok: false, code, comment } refuses it, { silent: true } never answers it, { delay: ms } answers it
 * as usual after that wait, { late: ms } makes the answer now, as things are, and sends it only after
 * that wait (OBS handles requests side by side, so an answer may arrive after a later event). Returns
 * { port, seen, record, connections, stopLag, startLag, drop(), stop(), clients() }: `seen` holds every message the page
 * sent (op and data), `record` OBS's recording ({ active, path, format, directory }).
 */
export async function startObsStandin({ port = 0, password = null, host = "127.0.0.1" } = {}) {
  const sockets = new Set();
  const obs = {
    password,
    answer: null,
    seen: [],
    record: { active: false, path: "", format: "%CCYY-%MM-%DD %hh-%mm-%ss", directory: "D:\\Stream" },
    connections: 0,
    /** How long after answering StopRecord the recording has really stopped (OBS answers first). */
    stopLag: 20,
    /**
     * How long after answering StartRecord the recording begins (OBS answers first, and reads the file
     * name as it begins). null: it takes the start and never records, as when OBS shows a warning instead.
     */
    startLag: 20,
    /** The requests the page sent, by type. */
    requests: (type) => obs.seen.filter((m) => m.op === 6 && (!type || m.d.requestType === type)).map((m) => m.d),
    /** Ends every connection at once, as when OBS quits or crashes (no close frame). */
    drop() { for (const s of sockets) s.destroy(); sockets.clear(); },
    /** Records as if someone pressed Start or Stop recording in OBS itself. */
    press(active) { setRecording(active); },
    /** Says it is starting and then that it stopped, with nothing recorded: as when OBS cannot write the file. */
    giveUp() {
      broadcast({ op: 5, d: { eventType: "RecordStateChanged", eventIntent: 64, eventData: { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STARTING", outputPath: null } } });
      broadcast({ op: 5, d: { eventType: "RecordStateChanged", eventIntent: 64, eventData: { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED", outputPath: null } } });
    },
    /** Says it stopped and nothing else: a late word about a recording that ended a while ago. */
    lateStop() {
      broadcast({ op: 5, d: { eventType: "RecordStateChanged", eventIntent: 64, eventData: { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED", outputPath: null } } });
    },
    clients: () => sockets.size,
    stop: () => new Promise((done) => { obs.drop(); server.close(() => done()); }),
  };
  const broadcast = (msg) => { for (const s of sockets) if (s.identified) s.write(frame(JSON.stringify(msg))); };
  function setRecording(active) {
    if (obs.record.active === active) return;
    obs.record.active = active;
    if (active) {
      obs.record.path = `${obs.record.directory}\\${obs.record.format.replace(/\//g, "\\")}.mkv`;
      obs.record.startedAt = Date.now();
      broadcast({ op: 5, d: { eventType: "RecordStateChanged", eventIntent: 64, eventData: { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STARTING", outputPath: null } } });
      broadcast({ op: 5, d: { eventType: "RecordStateChanged", eventIntent: 64, eventData: { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED", outputPath: obs.record.path } } });
    } else {
      broadcast({ op: 5, d: { eventType: "RecordStateChanged", eventIntent: 64, eventData: { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED", outputPath: obs.record.path } } });
    }
  }
  const params = () => ({ FilenameFormatting: obs.record.format });

  function request(sock, d) {
    const { requestType: type, requestId, requestData = {} } = d;
    const custom = d.asIs ? null : obs.answer?.(type, requestData);
    const send = (bytes) => {
      if (custom?.late) setTimeout(() => { if (!sock.destroyed) sock.write(bytes); }, custom.late);
      else sock.write(bytes);
    };
    const reply = (ok, responseData, code = 100, comment) => send(frame(JSON.stringify({
      op: 7, d: { requestType: type, requestId, requestStatus: { result: ok, code: ok ? 100 : code, ...(comment ? { comment } : {}) }, ...(responseData ? { responseData } : {}) },
    })));
    if (custom?.silent) return;
    if (custom?.delay) { setTimeout(() => { if (!sock.destroyed) request(sock, { ...d, asIs: true }); }, custom.delay); return; }
    if (custom && custom.ok === false) { reply(false, null, custom.code ?? 500, custom.comment); return; }
    switch (type) {
      case "GetVersion": reply(true, { obsVersion: "31.0.0", obsWebSocketVersion: "5.5.0", rpcVersion: 1 }); break;
      case "GetRecordStatus": reply(true, { outputActive: obs.record.active, outputPaused: false, outputTimecode: "00:00:00.000", outputDuration: obs.record.active ? Date.now() - obs.record.startedAt : 0, outputBytes: 0 }); break;
      case "GetProfileParameter":
        if (requestData.parameterCategory === "Output" && requestData.parameterName in params()) reply(true, { parameterValue: params()[requestData.parameterName], defaultParameterValue: "%CCYY-%MM-%DD %hh-%mm-%ss" });
        else reply(true, { parameterValue: null, defaultParameterValue: null });
        break;
      case "SetProfileParameter":
        if (requestData.parameterCategory === "Output" && requestData.parameterName === "FilenameFormatting") obs.record.format = String(requestData.parameterValue);
        reply(true);
        break;
      case "StartRecord":
        if (obs.record.active) { reply(false, null, 500, "Recording is already active."); break; }
        reply(true);
        if (obs.startLag !== null) setTimeout(() => setRecording(true), obs.startLag);
        break;
      case "StopRecord":
        if (!obs.record.active) { reply(false, null, 501, "Recording is not active."); break; }
        reply(true, { outputPath: obs.record.path });
        setTimeout(() => setRecording(false), obs.stopLag);
        break;
      default: reply(false, null, 204, "Unknown request type.");
    }
  }

  const server = createServer((req, res) => { res.writeHead(426); res.end(); });
  server.on("upgrade", (req, sock) => {
    const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((p) => p.trim());
    if (!protocols.includes("obswebsocket.json")) { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
    sock.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "Sec-WebSocket-Protocol: obswebsocket.json", "", ""].join("\r\n"));
    sockets.add(sock);
    obs.connections++;
    const challenge = createHash("sha1").update(String(Math.random())).digest("base64");
    const salt = createHash("sha1").update(String(Math.random())).digest("base64");
    const hello = { obsWebSocketVersion: "5.5.0", rpcVersion: 1 };
    if (obs.password !== null) hello.authentication = { challenge, salt };
    sock.write(frame(JSON.stringify({ op: 0, d: hello })));
    let buf = Buffer.alloc(0);
    const close = (code, reason = "") => {
      const body = Buffer.concat([Buffer.from([code >> 8, code & 255]), Buffer.from(reason)]);
      sock.write(frame(body, 8));
      sock.end();
      sockets.delete(sock);
    };
    sock.on("data", (chunk) => {
      const { frames, rest } = readFrames(Buffer.concat([buf, chunk]));
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 8) { sock.write(frame(f.data.subarray(0, 2), 8)); sock.end(); sockets.delete(sock); return; }
        if (f.opcode === 9) { sock.write(frame(f.data, 10)); continue; }
        if (f.opcode !== 1) continue;
        let msg;
        try { msg = JSON.parse(f.data.toString()); } catch { close(4002, "Unable to parse."); return; }
        obs.seen.push({ op: msg.op, d: msg.d });
        if (msg.op === 1) {
          if (obs.password !== null && msg.d?.authentication !== sha(sha(obs.password + salt) + challenge)) { close(4009, "Authentication failed."); return; }
          sock.identified = true;
          sock.write(frame(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })));
        } else if (msg.op === 6) {
          if (!sock.identified) { close(4007, "Not identified."); return; }
          request(sock, msg.d);
        }
      }
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sockets.delete(sock));
  });
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(port, host, ok); });
  server.unref();
  obs.port = server.address().port;
  return obs;
}
