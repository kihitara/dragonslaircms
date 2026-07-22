// D1 query helpers. Hand-written SQL via .prepare().bind() throughout.

// ── Settings & config ────────────────────────────────────────────────────────

export async function getSiteSettings(DB) {
  const { results } = await DB.prepare('SELECT key, value FROM site_settings').all();
  return Object.fromEntries((results || []).map((r) => [r.key, r.value]));
}

export async function setSiteSetting(DB, key, value) {
  await DB.prepare(
    'INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).bind(key, value, value).run();
}

// Brand identity for page chrome: display name + logo/favicon URL. Used by the
// admin shell (via user.branding) and available for other surfaces. Falls back
// to the SITE_TITLE var and the bundled icon so a fresh, unconfigured install
// still renders. Never throws — chrome must always paint.
const DEFAULT_LOGO = '/icons/icon.svg';
export async function getBranding(env) {
  try {
    const settings = await getSiteSettings(env.DB);
    return {
      name: settings.org_name || env.SITE_TITLE || 'DragonslairCMS',
      logo: settings.logo_url || DEFAULT_LOGO,
    };
  } catch {
    return { name: env.SITE_TITLE || 'DragonslairCMS', logo: DEFAULT_LOGO };
  }
}

export async function getSiteConfig(DB, key, fallback = null) {
  const row = await DB.prepare('SELECT value FROM site_config WHERE key = ?').bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export async function setSiteConfig(DB, key, value) {
  const json = JSON.stringify(value);
  await DB.prepare(
    'INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).bind(key, json, json).run();
}

// ── Theme tokens ─────────────────────────────────────────────────────────────

// Returns tokens in the nested { group: { name: value } } shape, overlaying DB
// rows on the provided defaults so a partially-seeded table still works.
export async function getThemeTokens(DB, defaults) {
  const tokens = structuredClone(defaults);
  const { results } = await DB.prepare('SELECT grp, name, value FROM theme_tokens').all();
  for (const row of results || []) {
    if (!tokens[row.grp]) tokens[row.grp] = {};
    tokens[row.grp][row.name] = row.value;
  }
  return tokens;
}

export async function setThemeToken(DB, grp, name, value) {
  await DB.prepare(
    `INSERT INTO theme_tokens (grp, name, value, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(grp, name) DO UPDATE SET value = ?, updated_at = datetime('now')`
  ).bind(grp, name, value, value).run();
}

export async function deleteThemeToken(DB, grp, name) {
  await DB.prepare('DELETE FROM theme_tokens WHERE grp = ? AND name = ?').bind(grp, name).run();
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function getUserByEmail(DB, email) {
  return DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}

export async function touchLastLogin(DB, userId) {
  await DB.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).bind(userId).run();
}

// ── Activity log & revisions ─────────────────────────────────────────────────

// Logging must never break the request it decorates.
export async function logActivity(DB, user, action, entityType, entityLabel) {
  try {
    await DB.prepare(
      'INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_label) VALUES (?, ?, ?, ?, ?)'
    ).bind(user?.id ?? null, user?.name ?? null, action, entityType, entityLabel ?? null).run();
  } catch { /* best-effort */ }
}

export async function getRecentActivity(DB, limit = 30) {
  const { results } = await DB.prepare(
    'SELECT * FROM activity_log ORDER BY id DESC LIMIT ?'
  ).bind(limit).all();
  return results || [];
}

const REVISION_CAP = 50;

export async function saveRevision(DB, entityType, entityId, data, summary, user) {
  try {
    const json = JSON.stringify(data);
    const last = await DB.prepare(
      'SELECT data FROM revisions WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(entityType, entityId).first();
    if (last && last.data === json) return; // dedupe identical consecutive saves
    await DB.prepare(
      'INSERT INTO revisions (entity_type, entity_id, data, summary, user_id, user_name) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(entityType, entityId, json, summary ?? null, user?.id ?? null, user?.name ?? null).run();
    await DB.prepare(
      `DELETE FROM revisions WHERE entity_type = ? AND entity_id = ? AND id NOT IN (
         SELECT id FROM revisions WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT ?)`
    ).bind(entityType, entityId, entityType, entityId, REVISION_CAP).run();
  } catch { /* best-effort */ }
}

export async function getRevisions(DB, entityType, entityId) {
  const { results } = await DB.prepare(
    'SELECT id, summary, user_name, created_at FROM revisions WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC'
  ).bind(entityType, entityId).all();
  return results || [];
}

export async function getRevision(DB, id) {
  return DB.prepare('SELECT * FROM revisions WHERE id = ?').bind(id).first();
}

// ── Dashboard counts ─────────────────────────────────────────────────────────

export async function getDashboardStats(DB) {
  const count = async (sql) => {
    try { return (await DB.prepare(sql).first())?.n ?? 0; } catch { return 0; }
  };
  return {
    pages: await count('SELECT COUNT(*) n FROM pages'),
    articles: await count('SELECT COUNT(*) n FROM articles'),
    people: await count('SELECT COUNT(*) n FROM people'),
    pendingComments: await count(`SELECT COUNT(*) n FROM comments WHERE status = 'pending'`),
    openCorrections: await count(`SELECT COUNT(*) n FROM corrections WHERE status = 'open'`),
    pendingReaders: await count(`SELECT COUNT(*) n FROM reader_accounts WHERE status = 'pending' AND email_verified = 1`),
    readers: await count(`SELECT COUNT(*) n FROM reader_accounts WHERE status = 'approved'`),
  };
}
