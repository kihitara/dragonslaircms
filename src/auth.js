// Auth: PBKDF2 password hashing + HMAC-signed session cookies backed by D1.
// Two separate session realms with separate secrets so a compromised reader
// session can never be replayed against the admin:
//   - CMS users  (users/sessions tables, ADMIN_SESSION_SECRET, dlc_session)
//   - Readers    (reader_accounts/reader_sessions, READER_SESSION_SECRET, dlc_reader)

const SESSION_TTL_DAYS = 30;

const hex = (arr) => Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (str) => new Uint8Array(str.match(/.{2}/g).map((b) => parseInt(b, 16)));

// --- Password hashing (PBKDF2-SHA256, 100k iterations) ---

export async function hashPassword(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, keyMaterial, 256
  );
  return hex(salt) + ':' + hex(new Uint8Array(bits));
}

// Constant-time string compare (equal-length hex). Avoids leaking match
// position via early-exit timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex] = String(stored || '').split(':');
    if (!saltHex || !hashHex) return false; // malformed/empty hash → auth failure, never a throw
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: 100000 }, keyMaterial, 256
    );
    return timingSafeEqual(hex(new Uint8Array(bits)), hashHex);
  } catch {
    return false;
  }
}

// A hash of a password nobody knows, in the stored form. Signing in to an
// address with no account checks the password against this instead of
// returning early, so the response takes as long either way and the form
// can't be used to ask whether somebody has an account here.
const DUMMY_HASH =
  'da9cde319544686abca4db6ec5b28ee2:cf42446e65b92c18c52507905b2cba25a9ed0843434512ceab8ec871c1c43a33';

export const burnTime = (password) => verifyPassword(password, DUMMY_HASH);

// --- Password rules ---
// Length and the breach list do the work; there are no character-class rules.
// The maximum is about cost, not strength: PBKDF2 runs over whatever it is
// given, so the length is checked before anything is hashed. The breach check
// uses Have I Been Pwned's range API by k-anonymity (only five hex characters
// of the SHA-1 leave the Worker) and fails open, so an outage there never
// stops anybody setting a password.

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const HIBP_TIMEOUT_MS = 2000;

async function isBreachedPassword(password) {
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const h = hex(new Uint8Array(digest)).toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'DragonslairCMS-password-check' },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const suffix = h.slice(5);
    for (const line of (await res.text()).split('\n')) {
      const [suf, count] = line.trim().split(':');
      if (suf === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    return false; // fail open, timeouts included
  }
}

// The one place that decides whether a new password is acceptable. Every path
// that sets one calls it: setup, reset, an admin creating or editing an
// account, and a reader registering, resetting or changing theirs.
export async function passwordError(password) {
  const pw = String(password || '');
  if (pw.length < PASSWORD_MIN) return `Passwords need to be at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `Passwords can be at most ${PASSWORD_MAX} characters.`;
  if (await isBreachedPassword(pw)) {
    return 'That password has turned up in a known data breach, so it is not safe to use. Please choose a different one.';
  }
  return null;
}

// --- HMAC-signed session cookies ---

// Fails closed: with no secret there is no key, and nothing can be signed or
// verified. Encoding a missing secret would otherwise give an empty HMAC key.
async function getSigningKey(secret) {
  if (!secret) throw new Error('Session secret is not available');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signSessionId(sessionId, secret) {
  const key = await getSigningKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sessionId));
  return hex(new Uint8Array(sig));
}

async function verifySessionCookie(request, cookieName, secret) {
  const cookieHeader = request.headers.get('Cookie') || '';
  // Anchored to the start of a cookie, so `x_dlc_session=` can't stand in.
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  if (!match) return null;
  const [sessionId, sigHex] = match[1].split('.');
  if (!sessionId || !sigHex) return null;
  try {
    const key = await getSigningKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, unhex(sigHex), new TextEncoder().encode(sessionId));
    return valid ? sessionId : null;
  } catch {
    return null;
  }
}

function cookieHeaderFor(cookieName, sessionId, sigHex, expires) {
  return `${cookieName}=${sessionId}.${sigHex}; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=${expires.toUTCString()}`;
}

function clearCookie(cookieName) {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// --- CMS user sessions ---

const ADMIN_COOKIE = 'dlc_session';

export async function createSession(DB, userId, secret) {
  const sessionId = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000);
  const sigHex = await signSessionId(sessionId, secret);
  await DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(sessionId, userId, expires.toISOString()).run();
  return { cookieHeader: cookieHeaderFor(ADMIN_COOKIE, sessionId, sigHex, expires) };
}

export async function getSession(request, DB, secret) {
  const sessionId = await verifySessionCookie(request, ADMIN_COOKIE, secret);
  if (!sessionId) return null;
  const row = await DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.name, u.role, u.active, u.last_login
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).bind(sessionId).first();
  if (!row || new Date(row.expires_at) < new Date() || !row.active) return null;
  return { id: row.user_id, email: row.email, name: row.name, role: row.role, last_login: row.last_login, sessionId };
}

export async function destroySession(DB, sessionId) {
  await DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

// Every session for a staff account, or every one but `keepSessionId`. Used
// when an account is deactivated or its password changes, so reactivating it
// later can't bring an old session back to life.
export function destroyUserSessionsStmt(DB, userId, keepSessionId = null) {
  return keepSessionId
    ? DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').bind(userId, keepSessionId)
    : DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId);
}

export function clearSessionCookie() {
  return clearCookie(ADMIN_COOKIE);
}

// --- Reader sessions ---

const READER_COOKIE = 'dlc_reader';

export async function createReaderSession(DB, readerId, secret) {
  const sessionId = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000);
  const sigHex = await signSessionId(sessionId, secret);
  await DB.prepare('INSERT INTO reader_sessions (id, reader_account_id, expires_at) VALUES (?, ?, ?)')
    .bind(sessionId, readerId, expires.toISOString()).run();
  return { cookieHeader: cookieHeaderFor(READER_COOKIE, sessionId, sigHex, expires) };
}

export async function getReaderSession(request, DB, secret) {
  const sessionId = await verifySessionCookie(request, READER_COOKIE, secret);
  if (!sessionId) return null;
  const row = await DB.prepare(
    `SELECT s.reader_account_id, s.expires_at, r.username, r.email, r.status, r.email_verified
     FROM reader_sessions s JOIN reader_accounts r ON r.id = s.reader_account_id WHERE s.id = ?`
  ).bind(sessionId).first();
  // Status and the address are separate questions, and both must be satisfied.
  if (!row || new Date(row.expires_at) < new Date() || row.status !== 'approved' || !row.email_verified) return null;
  return { id: row.reader_account_id, username: row.username, email: row.email, sessionId };
}

export async function destroyReaderSession(DB, sessionId) {
  await DB.prepare('DELETE FROM reader_sessions WHERE id = ?').bind(sessionId).run();
}

// The reader counterpart of destroyUserSessionsStmt.
export function destroyReaderSessionsStmt(DB, readerId, keepSessionId = null) {
  return keepSessionId
    ? DB.prepare('DELETE FROM reader_sessions WHERE reader_account_id = ? AND id <> ?').bind(readerId, keepSessionId)
    : DB.prepare('DELETE FROM reader_sessions WHERE reader_account_id = ?').bind(readerId);
}

export function clearReaderSessionCookie() {
  return clearCookie(READER_COOKIE);
}

// --- Login rate limiting (shared by admin + reader logins) ---
// 5 failures per IP → 15-minute lockout. Fails open on DB errors so an
// unmigrated table degrades to "no rate limiting", never a crash.

const MAX_FAILS = 5;
const LOCKOUT_MINUTES = 15;

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function isLockedOut(DB, ip) {
  try {
    const row = await DB.prepare('SELECT locked_until FROM login_attempts WHERE ip = ?').bind(ip).first();
    return !!(row && row.locked_until && new Date(row.locked_until) > new Date());
  } catch {
    return false;
  }
}

export async function recordLoginFailure(DB, ip) {
  try {
    const row = await DB.prepare('SELECT fails FROM login_attempts WHERE ip = ?').bind(ip).first();
    const fails = (row ? row.fails : 0) + 1;
    const lockedUntil = fails >= MAX_FAILS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
      : null;
    await DB.prepare(
      `INSERT INTO login_attempts (ip, fails, locked_until) VALUES (?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET fails = ?, locked_until = ?`
    ).bind(ip, fails, lockedUntil, fails, lockedUntil).run();
  } catch { /* rate limiting is best-effort */ }
}

export async function clearLoginFailures(DB, ip) {
  try {
    await DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  } catch { /* best-effort */ }
}

// --- Email verification tokens (reader self-registration) ---

export function generateVerificationToken() {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); // 24h
  return { token, expires };
}

// --- Password-reset tokens (forgot-password, admin + reader) ---
// Single-use, short-lived (1 hour). 256 bits of entropy → not guessable.

export function generateResetToken() {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + 3600 * 1000).toISOString(); // 1h
  return { token, expires };
}

// --- Roles (ascending privilege) ---
// editor    — content: Pages, Articles, People, Media, moderation
// publisher — editor + Branding/Palette/Fonts/Nav/Footer/Settings + Publish
// admin     — publisher + user management
const ROLES = ['editor', 'publisher', 'admin'];

export function roleAtLeast(user, minRole) {
  return ROLES.indexOf(user.role) >= ROLES.indexOf(minRole);
}
