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

// --- HMAC-signed session cookies ---

async function getSigningKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signSessionId(sessionId, secret) {
  const key = await getSigningKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sessionId));
  return hex(new Uint8Array(sig));
}

async function verifySessionCookie(request, cookieName, secret) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
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
  if (!row || new Date(row.expires_at) < new Date() || row.status !== 'approved') return null;
  return { id: row.reader_account_id, username: row.username, email: row.email, sessionId };
}

export async function destroyReaderSession(DB, sessionId) {
  await DB.prepare('DELETE FROM reader_sessions WHERE id = ?').bind(sessionId).run();
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
