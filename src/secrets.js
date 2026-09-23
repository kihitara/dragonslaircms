// Session-signing secrets, self-provisioning.
//
// Admin and reader session cookies are HMAC-signed (see auth.js) with two
// separate secrets. Making the site owner generate those by hand is the one
// install step that can't be done from a browser, so when a secret isn't
// supplied as a Worker secret the CMS mints a random one on first use and
// keeps it in site_config. A supplied ADMIN_SESSION_SECRET /
// READER_SESSION_SECRET always wins, so deployments that already set them keep
// their existing sessions valid, and anyone who prefers to manage (or rotate)
// the values themselves still can.

const CONFIG_KEYS = {
  ADMIN_SESSION_SECRET: 'admin_session_secret',
  READER_SESSION_SECRET: 'reader_session_secret',
};
const NAMES = Object.keys(CONFIG_KEYS);

// Per-isolate cache. A minted secret never changes, so after the first request
// an isolate resolves both without touching D1.
const cache = new Map();

// 32 random bytes as hex — the same strength as `openssl rand -hex 32`.
function randomSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// site_config stores JSON values (see db.js), so unwrap the same way.
async function readStored(DB, names) {
  const keys = names.map((n) => CONFIG_KEYS[n]);
  const { results } = await DB.prepare(
    `SELECT key, value FROM site_config WHERE key IN (${keys.map(() => '?').join(', ')})`
  ).bind(...keys).all();
  const byKey = new Map((results || []).map((r) => [r.key, r.value]));
  const out = {};
  for (const name of names) {
    const raw = byKey.get(CONFIG_KEYS[name]);
    if (raw === undefined) continue;
    try { out[name] = JSON.parse(raw); } catch { out[name] = raw; }
  }
  return out;
}

// Returns { ADMIN_SESSION_SECRET?, READER_SESSION_SECRET? } with only the keys
// actually resolved, so the caller can spread it over env without clobbering
// anything with undefined. On a fresh install where the schema hasn't been
// applied yet the lookup throws and we return nothing: auth then fails closed
// rather than signing cookies with a placeholder.
export async function resolveSessionSecrets(env) {
  const out = {};
  const needed = [];
  for (const name of NAMES) {
    const supplied = String(env[name] || '').trim();
    if (supplied) out[name] = supplied;
    else if (cache.has(name)) out[name] = cache.get(name);
    else needed.push(name);
  }
  if (!needed.length) return out;

  try {
    const stored = await readStored(env.DB, needed);
    const missing = needed.filter((n) => !stored[n]);
    if (missing.length) {
      // INSERT OR IGNORE then re-read: if two requests race on a fresh install,
      // both adopt the row that actually landed rather than their own candidate.
      for (const name of missing) {
        await env.DB.prepare('INSERT OR IGNORE INTO site_config (key, value) VALUES (?, ?)')
          .bind(CONFIG_KEYS[name], JSON.stringify(randomSecret())).run();
      }
      Object.assign(stored, await readStored(env.DB, missing));
    }
    for (const name of needed) {
      if (!stored[name]) continue;
      cache.set(name, stored[name]);
      out[name] = stored[name];
    }
  } catch { /* site_config not there yet — leave the secrets unresolved */ }

  return out;
}
