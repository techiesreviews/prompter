// Agent tokens for the live connection between someone's own AI agent and
// their open prompter tab (as in the script editor, script.techies.tools).
// A token is "tp1-<birth time>-<random>", made by the Worker (POST
// /api/agent-token): the birth time is the Worker's Date.now() in base36, the
// random part 32 random bytes in base64url. The Worker's clock both writes and
// checks it, so a browser clock that is ahead or behind changes nothing. It
// needs no signature: the relay object is picked by the hash of the whole
// token, so a changed birth time is another token with an empty relay, one in
// the past only lives shorter, and one from the future is refused.
// No imports: the Worker, the relay and the tests share this file.

export const MAX_AGE_MS = 8 * 60 * 60 * 1000;
export const FUTURE_SLACK_MS = 60_000;
export const TOKEN_RE = /^tp1-([0-9a-z]{8,10})-([A-Za-z0-9_-]{43})$/;
const SALT = "techies-prompter/relay/v1";

export function newToken(now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const rand = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { token: `tp1-${now.toString(36)}-${rand}`, born: now };
}

/** { ok: true, born } for a token that may be used now, else { ok: false, reason: "invalid" | "expired" }. */
export function checkToken(token, now = Date.now()) {
  const m = String(token ?? "").match(TOKEN_RE);
  if (!m) return { ok: false, reason: "invalid" };
  const born = parseInt(m[1], 36);
  if (born > now + FUTURE_SLACK_MS) return { ok: false, reason: "invalid" };
  return now - born < MAX_AGE_MS ? { ok: true, born } : { ok: false, reason: "expired" };
}

/** The relay object's name: a salted SHA-256 of the token, so the object never sees the token itself. */
export async function relayName(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SALT}|${token}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
