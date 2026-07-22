-- DragonslairCMS D1 Schema
-- Apply with: wrangler d1 execute dragonslaircms --file=schema.sql [--remote]

-- ── CMS users & sessions ────────────────────────────────────────────────────
-- Back-office accounts. Role hierarchy: admin > publisher > editor.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK(role IN ('admin', 'publisher', 'editor')),
  password_hash TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  notify_new_registration INTEGER NOT NULL DEFAULT 1,
  notify_new_comment      INTEGER NOT NULL DEFAULT 1,
  notify_new_correction   INTEGER NOT NULL DEFAULT 1,
  page_size     INTEGER NOT NULL DEFAULT 20,   -- admin list-pagination preference
  reset_token   TEXT,                          -- forgot-password: single-use token
  reset_expires TEXT,                          -- ISO expiry (1 hour)
  -- Migration (pre-existing databases):
  --   ALTER TABLE users ADD COLUMN page_size INTEGER NOT NULL DEFAULT 20;
  --   ALTER TABLE users ADD COLUMN reset_token TEXT;
  --   ALTER TABLE users ADD COLUMN reset_expires TEXT;
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Login rate-limiting: failed sign-in attempts per client IP (admin + reader).
CREATE TABLE IF NOT EXISTS login_attempts (
  ip           TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- Anti-spam throttle: per-IP count of public form submissions (corrections,
-- anonymous comments) in a rolling window. See src/antispam.js.
-- Migration (pre-existing databases):
--   CREATE TABLE IF NOT EXISTS spam_throttle (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spam_throttle (
  ip           TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);

-- ── Reader accounts ─────────────────────────────────────────────────────────
-- Front-end-only "Reader" role: blog subscription, own comments, notification
-- preferences. Self-registration is toggled via site_settings.

CREATE TABLE IF NOT EXISTS reader_accounts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT    NOT NULL UNIQUE,
  email                TEXT    NOT NULL UNIQUE,
  password_hash        TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  email_verified       INTEGER NOT NULL DEFAULT 0,
  verification_token   TEXT    UNIQUE,
  verification_expires TEXT,
  reset_token          TEXT,    -- forgot-password: single-use token
  reset_expires        TEXT,    -- ISO expiry (1 hour)
  -- Migration (pre-existing databases):
  --   ALTER TABLE reader_accounts ADD COLUMN reset_token TEXT;
  --   ALTER TABLE reader_accounts ADD COLUMN reset_expires TEXT;
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login           TEXT
);

CREATE TABLE IF NOT EXISTS reader_sessions (
  id                TEXT PRIMARY KEY,
  reader_account_id INTEGER NOT NULL REFERENCES reader_accounts(id) ON DELETE CASCADE,
  expires_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reader_sessions_account ON reader_sessions(reader_account_id);

-- ── Pages ───────────────────────────────────────────────────────────────────
-- Each page is an ordered list of blocks stored as JSON: [{ type, props }, …].
-- status: draft (not on site) | published (live) | modified (live, with edits
-- not yet re-published). published_snapshot freezes the live version so edits
-- never leak until Publish is pressed again.

CREATE TABLE IF NOT EXISTS pages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  slug               TEXT    NOT NULL UNIQUE,
  title              TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'modified')),
  blocks             TEXT    NOT NULL DEFAULT '[]',
  meta_title         TEXT,
  meta_description   TEXT,
  share_image        TEXT,
  hidden             INTEGER NOT NULL DEFAULT 0,   -- excluded from nav/listings but reachable
  full_width         INTEGER NOT NULL DEFAULT 0,
  corrections_disabled INTEGER NOT NULL DEFAULT 0, -- hide the "suggest a correction" form on this page
  -- Migration (pre-existing databases): ALTER TABLE pages ADD COLUMN corrections_disabled INTEGER NOT NULL DEFAULT 0;
  published_snapshot TEXT,                          -- JSON of the live version
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Articles ────────────────────────────────────────────────────────────────
-- Rich-text body (WYSIWYG HTML). Authors/reviewers are JSON arrays of people
-- slugs. Same draft/published/modified + snapshot pattern as pages.

CREATE TABLE IF NOT EXISTS articles (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  slug               TEXT    NOT NULL UNIQUE,
  title              TEXT    NOT NULL,
  subheading         TEXT,
  category           TEXT    NOT NULL DEFAULT 'blog',   -- blog | news
  status             TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'modified')),
  publish_date       TEXT,
  cover              TEXT,
  authors            TEXT    NOT NULL DEFAULT '[]',
  reviewers          TEXT    NOT NULL DEFAULT '[]',
  meta_title         TEXT,
  meta_description   TEXT,
  share_image        TEXT,
  content            TEXT    NOT NULL DEFAULT '',
  comments_disabled  INTEGER NOT NULL DEFAULT 0,   -- legacy; superseded by comment_mode
  -- comment_mode: enabled (anyone) | readers (logged-in only) | closed (show
  -- approved, no new) | disabled (hide all, reversible). Migrated from the
  -- legacy flag (comments_disabled=1 → 'closed').
  comment_mode       TEXT    NOT NULL DEFAULT 'enabled' CHECK(comment_mode IN ('enabled', 'readers', 'closed', 'disabled')),
  -- Migration (pre-existing databases):
  --   ALTER TABLE articles ADD COLUMN comment_mode TEXT NOT NULL DEFAULT 'enabled';
  --   UPDATE articles SET comment_mode = 'closed' WHERE comments_disabled = 1;
  corrections_disabled INTEGER NOT NULL DEFAULT 0, -- hide the "suggest a correction" form on this article
  hero_surface       TEXT    NOT NULL DEFAULT '',   -- palette surface for the cover-image hero overlay
  -- Migration (pre-existing databases):
  --   ALTER TABLE articles ADD COLUMN hero_surface TEXT NOT NULL DEFAULT '';
  --   ALTER TABLE articles ADD COLUMN corrections_disabled INTEGER NOT NULL DEFAULT 0;
  published_snapshot TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_articles_status  ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_publish ON articles(publish_date DESC);

-- ── Tags (articles) ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

-- ── People ──────────────────────────────────────────────────────────────────
-- Directory referenced by article authors/reviewers and people-display blocks.

CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT,
  blurb       TEXT,               -- plain-text one-liner: team grid card + profile tagline
  -- Migration (pre-existing databases): ALTER TABLE people ADD COLUMN blurb TEXT;
  bio         TEXT,
  photo_url   TEXT,
  linkedin_url TEXT,                -- legacy; superseded by social_links
  -- JSON array of { type: website|linkedin|facebook|twitter|instagram|bluesky|mastodon|other, url, label? }
  -- Migration (pre-existing databases):
  --   ALTER TABLE people ADD COLUMN social_links TEXT NOT NULL DEFAULT '[]';
  --   UPDATE people SET social_links = json_array(json_object('type','linkedin','url',linkedin_url)) WHERE linkedin_url IS NOT NULL AND linkedin_url != '';
  social_links TEXT NOT NULL DEFAULT '[]',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Comments (articles) ─────────────────────────────────────────────────────
-- Moderation-first: everything is pending until a CMS user approves it.

CREATE TABLE IF NOT EXISTS comments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id        INTEGER NOT NULL REFERENCES articles(id)       ON DELETE CASCADE,
  reader_account_id INTEGER REFERENCES reader_accounts(id)         ON DELETE SET NULL,
  anonymous_name    TEXT,
  anonymous_email   TEXT,
  body              TEXT    NOT NULL,
  body_format       TEXT    NOT NULL DEFAULT 'text',  -- 'text' (escaped) | 'html' (sanitised rich, readers)
  status            TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  edited_at         TEXT,
  moderated_at      TEXT
  -- Migration (pre-existing databases): ALTER TABLE comments ADD COLUMN body_format TEXT NOT NULL DEFAULT 'text';
);
CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_status  ON comments(status);

CREATE TABLE IF NOT EXISTS comment_replies (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id        INTEGER NOT NULL REFERENCES comments(id)        ON DELETE CASCADE,
  reader_account_id INTEGER REFERENCES reader_accounts(id)          ON DELETE SET NULL,
  anonymous_name    TEXT,
  anonymous_email   TEXT,
  body              TEXT    NOT NULL,
  body_format       TEXT    NOT NULL DEFAULT 'text',  -- 'text' (escaped) | 'html' (sanitised rich)
  status            TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  staff_reply       INTEGER NOT NULL DEFAULT 0,   -- posted by a CMS user; auto-approved
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  -- Migration (pre-existing databases): ALTER TABLE comment_replies ADD COLUMN body_format TEXT NOT NULL DEFAULT 'text';
);

-- ── Blog subscriptions ──────────────────────────────────────────────────────
-- Readers subscribe to the blog as a whole; new published articles notify them.

CREATE TABLE IF NOT EXISTS blog_subscriptions (
  reader_account_id INTEGER PRIMARY KEY REFERENCES reader_accounts(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Corrections (articles and pages) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS corrections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT    NOT NULL CHECK(entity_type IN ('article', 'page')),
  entity_id   INTEGER NOT NULL,
  body        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'done')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_corrections_entity ON corrections(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON corrections(status);

-- ── Notification preferences (readers) ──────────────────────────────────────
-- type: 'new_article' | 'comment_reply' | 'comment_moderated'

CREATE TABLE IF NOT EXISTS notification_preferences (
  reader_account_id INTEGER NOT NULL REFERENCES reader_accounts(id) ON DELETE CASCADE,
  type              TEXT    NOT NULL,
  email_enabled     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (reader_account_id, type)
);

-- ── Email templates ─────────────────────────────────────────────────────────
-- Defaults live in code (src/email.js); rows here override them.

CREATE TABLE IF NOT EXISTS email_templates (
  key        TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Branding: design tokens ─────────────────────────────────────────────────
-- One row per token, grouped (color/font/radius/size/weight). Seeded from the
-- defaults in src/tokens.js on first run; /theme.css is generated from these.

CREATE TABLE IF NOT EXISTS theme_tokens (
  grp        TEXT NOT NULL,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (grp, name)
);

-- ── Structured site config ──────────────────────────────────────────────────
-- JSON blobs keyed by name: nav, footer, fonts, surfaces (palettes).

CREATE TABLE IF NOT EXISTS site_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Global settings ─────────────────────────────────────────────────────────
-- Key/value: org name, tagline, SEO defaults, favicon, and feature toggles
-- (e.g. self_registration = '0'|'1', registration_requires_approval = '0'|'1').

CREATE TABLE IF NOT EXISTS site_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── Emoticons ───────────────────────────────────────────────────────────────
-- Custom inline emoticons for the rich-text editor. The image lives in R2
-- under media/emoticons/ (a locked virtual folder in the media library);
-- content embeds the file URL at insert time, so renaming a slug never breaks
-- existing insertions — only deleting the file does. Category list (incl.
-- empty categories) lives in site_config key 'emoticon_categories'.
-- Migration (pre-existing databases): run this CREATE TABLE, then seed the
-- four defaults from assets/emoticons/ (see README).

CREATE TABLE IF NOT EXISTS emoticons (
  slug       TEXT PRIMARY KEY,               -- lowercase-and-hyphens, unique
  key        TEXT NOT NULL,                  -- R2 object key (media/emoticons/…)
  category   TEXT NOT NULL DEFAULT 'Uncategorised',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Reader activity log ─────────────────────────────────────────────────────
-- Per-reader action trail (login, comments, subscription changes …), shown on
-- the reader's Logs page in the admin. Logging is best-effort, never fatal.
-- Migration (pre-existing databases): run this CREATE TABLE + CREATE INDEX.

CREATE TABLE IF NOT EXISTS reader_activity_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reader_account_id INTEGER REFERENCES reader_accounts(id) ON DELETE CASCADE,
  action            TEXT NOT NULL,
  detail            TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reader_activity ON reader_activity_log(reader_account_id, id DESC);

-- ── Revisions ───────────────────────────────────────────────────────────────
-- One JSON snapshot per save of a page/article, for rollback (capped at 50).

CREATE TABLE IF NOT EXISTS revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT    NOT NULL,
  entity_id   INTEGER NOT NULL,
  data        TEXT    NOT NULL,
  summary     TEXT,
  user_id     INTEGER,
  user_name   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_revisions_entity ON revisions(entity_type, entity_id, id DESC);

-- ── Activity log ────────────────────────────────────────────────────────────
-- Every create/edit/delete/publish, attributed to a CMS user. Logging must
-- never break a request.

CREATE TABLE IF NOT EXISTS activity_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  user_name    TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_label TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(id DESC);
