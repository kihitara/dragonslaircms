// Lightweight, zero-config spam mitigation for the public (unauthenticated)
// forms — corrections and anonymous comments/replies. Layers, all fail-open so
// a bug or DB hiccup never blocks a genuine submission:
//   1. Honeypot   — a hidden bait field real users never fill.
//   2. Timing     — a signed token carrying the render time; reject submissions
//                   with a missing/forged token or that arrive implausibly fast.
//   3. Rate limit — a per-IP hourly cap (spam_throttle table).
//   4. Link filter— an anonymous body containing a URL is almost always a pitch.
// Logged-in readers are accountable and skip all of this (the caller decides).

const enc = new TextEncoder();
const HP_NAME = 'hp_url';       // honeypot field name
const TOKEN_NAME = 'st_token';  // timing-token field name
const MIN_AGE_MS = 3000;        // faster than this = a bot, not a human
const RATE_LIMIT = 6;           // max public submissions per IP per window
const WINDOW_MS = 60 * 60 * 1000;
const LINK_RE = /(https?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,})/i;

function hex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Hidden honeypot input — off-screen, non-tabbable, not autofilled. Include this
// in every protected form. Styled by .hp-trap in community.css.
export function honeypotField() {
  return `<div class="hp-trap" aria-hidden="true"><label>Leave this field empty <input type="text" name="${HP_NAME}" tabindex="-1" autocomplete="off" value=""></label></div>`;
}

// A signed "when this form was rendered" token. Emit once per page and drop it
// (hidden) into each protected form. No expiry — an over-long-open form still
// works; the signature just proves the token came from us and carries the age.
export async function spamToken(env) {
  const ts = String(Date.now());
  const secret = env.READER_SESSION_SECRET;
  return secret ? `${ts}.${await hmacHex(secret, ts)}` : `${ts}.`;
}
export function spamTokenField(token) {
  return `<input type="hidden" name="${TOKEN_NAME}" value="${token}">`;
}

// Verify the token and return its age in ms, or null if missing/forged.
async function tokenAgeMs(env, token) {
  const [ts, sig] = String(token || '').split('.');
  if (!ts || !/^\d+$/.test(ts)) return null;
  const secret = env.READER_SESSION_SECRET;
  if (secret) {
    const expect = await hmacHex(secret, ts);
    if (!sig || !timingSafeEqual(sig, expect)) return null;
  }
  return Date.now() - parseInt(ts, 10);
}

// Fixed-window per-IP counter. Returns true if this attempt is over the cap.
// Every attempt increments (so a flood is throttled even when other layers
// would also catch it). Fails open on any DB error.
async function overRateLimit(env, ip) {
  try {
    const now = Date.now();
    const row = await env.DB.prepare('SELECT count, window_start FROM spam_throttle WHERE ip = ?').bind(ip).first();
    let count = 0, start = now;
    if (row) {
      const ws = parseInt(row.window_start, 10);
      if (Number.isFinite(ws) && now - ws < WINDOW_MS) { count = row.count; start = ws; }
    }
    count += 1;
    await env.DB.prepare(
      'INSERT INTO spam_throttle (ip, count, window_start) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = ?, window_start = ?'
    ).bind(ip, count, String(start), count, String(start)).run();
    return count > RATE_LIMIT;
  } catch {
    return false;
  }
}

// Decide whether to accept an anonymous public submission. `data` is the parsed
// form/JSON body. Returns { ok: true } to proceed, or { ok: false } to silently
// drop (the caller should respond as if it succeeded, so bots learn nothing).
export async function guardPublicSubmission(request, env, data) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overRateLimit(env, ip)) return { ok: false };
  if (String(data[HP_NAME] || '').trim()) return { ok: false };       // honeypot tripped
  const age = await tokenAgeMs(env, data[TOKEN_NAME]);
  if (age === null || age < MIN_AGE_MS) return { ok: false };         // no/forged token, or too fast
  if (LINK_RE.test(String(data.body || ''))) return { ok: false };    // link-bearing pitch
  return { ok: true };
}
