// Public community API: POST /api/* — comments, replies, corrections, blog
// subscription. Accepts both form posts (redirects back to the Referer with a
// query flag the community fragments turn into a notice) and JSON (returns
// JSON), matching the writing project's dual-mode handlers.

import { getReaderSession } from '../auth.js';
import { redirect } from '../templates/base.js';
import { notifyAdmins, getSiteName } from '../email.js';
import { logReaderActivity } from './reader.js';
import { getSiteSettings } from '../db.js';
import { sanitizeCommentHtml, commentToText } from '../sanitize.js';
import { guardPublicSubmission } from '../antispam.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isJson(request) {
  return (request.headers.get('Content-Type') || '').includes('application/json');
}

// Read the payload from either JSON or a form post into a plain object.
async function readBody(request) {
  if (isJson(request)) return request.json().catch(() => ({}));
  const form = await request.formData().catch(() => null);
  if (!form) return {};
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
}

// Redirect back to the submitting page with a flag (?commented=1 etc.) and an
// optional #anchor, dropping any previous query so notices don't stack.
function backTo(request, flag, hash = '') {
  let path = '/';
  try { path = new URL(request.headers.get('Referer')).pathname; } catch { /* no/invalid referer */ }
  return redirect(`${path}?${flag}=1${hash}`);
}

function fail(request, message, status) {
  // Form posts get bounced back silently; JSON callers get the error.
  return isJson(request) ? json({ error: message }, status) : backTo(request, 'error');
}

export async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/$/, '');
  if (!path.startsWith('/api/')) return null;
  if (request.method !== 'POST') return null;

  if (path === '/api/comments') return postComment(request, env);
  const replyMatch = path.match(/^\/api\/comments\/(\d+)\/reply$/);
  if (replyMatch) return postReply(request, env, Number(replyMatch[1]));
  if (path === '/api/corrections') return postCorrection(request, env);
  if (path === '/api/subscribe') return setSubscription(request, env, true);
  if (path === '/api/unsubscribe') return setSubscription(request, env, false);

  return null;
}

// ── Comments ─────────────────────────────────────────────────────────────────

async function postComment(request, env) {
  const DB = env.DB;
  const data = await readBody(request);
  const articleId = parseInt(data.article_id, 10);
  const body = (data.body || '').trim();
  if (!articleId || !body) return fail(request, 'article_id and body required', 400);

  const article = await DB.prepare(
    `SELECT id, slug, category, title, comment_mode FROM articles WHERE id = ? AND status != 'draft'`
  ).bind(articleId).first();
  if (!article) return fail(request, 'article not found', 404);

  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  // Enforce the article's comment mode. closed/disabled accept no new comments;
  // 'readers' requires a logged-in reader.
  const mode = article.comment_mode || 'enabled';
  if (mode === 'closed' || mode === 'disabled') return fail(request, 'comments are closed on this article', 403);
  if (mode === 'readers' && !reader) return fail(request, 'only registered readers can comment on this article', 403);

  // Anonymous submissions run the spam gate; spam is silently accepted-looking
  // (stored/notified for no one) so bots get no signal. Readers are exempt.
  if (!reader && !(await guardPublicSubmission(request, env, data)).ok) {
    return isJson(request) ? json({ ok: true, status: 'pending' }) : backTo(request, 'commented', '#comments');
  }
  const anonymousName = (data.anonymous_name || '').trim();
  if (!reader && !anonymousName) return fail(request, 'name required for anonymous comments', 400);

  // Logged-in readers author rich HTML: sanitise on write (allowlist rebuild)
  // and store body_format='html'. Anonymous visitors keep plain text as-is.
  const storedBody = reader ? sanitizeCommentHtml(body) : body;
  const bodyFormat = reader ? 'html' : 'text';
  if (reader && !storedBody) return fail(request, 'comment is empty after formatting', 400);

  await DB.prepare(
    `INSERT INTO comments (article_id, reader_account_id, anonymous_name, anonymous_email, body, body_format)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    articleId,
    reader?.id ?? null,
    reader ? null : anonymousName,
    reader ? null : ((data.anonymous_email || '').trim() || null),
    storedBody,
    bodyFormat,
  ).run();

  // Title/target only — never the comment body.
  if (reader) await logReaderActivity(DB, reader.id, 'posted comment', article.title);

  await notifyAdmins(env, 'notify_new_comment', 'admin_new_comment', {
    site_name: await getSiteName(env),
    commenter: reader?.username || anonymousName,
    article_title: article.title,
    // HTML bodies become a plain-text snippet for the email.
    comment_body: bodyFormat === 'html' ? commentToText(storedBody) : storedBody,
    link: `${env.SITE_URL || ''}/admin/comments`,
  });

  if (isJson(request)) return json({ ok: true, status: 'pending' });
  return backTo(request, 'commented', '#comments');
}

// ── Replies ──────────────────────────────────────────────────────────────────

async function postReply(request, env, commentId) {
  const DB = env.DB;
  const data = await readBody(request);
  const body = (data.body || '').trim();
  if (!body) return fail(request, 'body required', 400);

  // The parent comment must exist; the article's comment mode also governs replies.
  const parent = await DB.prepare(
    `SELECT c.id, a.title AS article_title, a.comment_mode
     FROM comments c JOIN articles a ON a.id = c.article_id WHERE c.id = ?`
  ).bind(commentId).first();
  if (!parent) return fail(request, 'comment not found', 404);

  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  const mode = parent.comment_mode || 'enabled';
  if (mode === 'closed' || mode === 'disabled') return fail(request, 'comments are closed on this article', 403);
  if (mode === 'readers' && !reader) return fail(request, 'only registered readers can comment on this article', 403);

  if (!reader && !(await guardPublicSubmission(request, env, data)).ok) {
    return isJson(request) ? json({ ok: true, status: 'pending' }) : backTo(request, 'replied', `#comment-${commentId}`);
  }
  const anonymousName = (data.anonymous_name || '').trim();
  if (!reader && !anonymousName) return fail(request, 'name required for anonymous replies', 400);

  const storedBody = reader ? sanitizeCommentHtml(body) : body;
  const bodyFormat = reader ? 'html' : 'text';
  if (reader && !storedBody) return fail(request, 'reply is empty after formatting', 400);

  await DB.prepare(
    `INSERT INTO comment_replies (comment_id, reader_account_id, anonymous_name, anonymous_email, body, body_format)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    commentId,
    reader?.id ?? null,
    reader ? null : anonymousName,
    reader ? null : ((data.anonymous_email || '').trim() || null),
    storedBody,
    bodyFormat,
  ).run();

  // Title/target only — never the reply body.
  if (reader) await logReaderActivity(DB, reader.id, 'posted reply', parent.article_title);

  await notifyAdmins(env, 'notify_new_comment', 'admin_new_comment', {
    site_name: await getSiteName(env),
    commenter: reader?.username || anonymousName,
    article_title: parent.article_title,
    comment_body: bodyFormat === 'html' ? commentToText(storedBody) : storedBody,
    link: `${env.SITE_URL || ''}/admin/comments`,
  });

  if (isJson(request)) return json({ ok: true, status: 'pending' });
  return backTo(request, 'replied', `#comment-${commentId}`);
}

// ── Corrections ──────────────────────────────────────────────────────────────

async function postCorrection(request, env) {
  const DB = env.DB;
  const data = await readBody(request);
  const entityType = data.entity_type;
  const entityId = parseInt(data.entity_id, 10);
  const body = (data.body || '').trim();
  if (!['article', 'page'].includes(entityType) || !entityId || !body) {
    return fail(request, 'entity_type, entity_id and body required', 400);
  }

  const table = entityType === 'article' ? 'articles' : 'pages';
  const target = await DB.prepare(`SELECT id, title, corrections_disabled FROM ${table} WHERE id = ?`).bind(entityId).first();
  if (!target) return fail(request, `${entityType} not found`, 404);

  // Corrections must be enabled site-wide AND for this item. When off, the form
  // isn't shown — so anything reaching here is a bot; silently accept-and-drop.
  const settings = await getSiteSettings(DB);
  const correctionsOff = (settings.corrections_enabled ?? '1') === '0' || target.corrections_disabled;
  if (correctionsOff) return isJson(request) ? json({ ok: true }) : backTo(request, 'corrected');

  // Anonymous corrections run the spam gate (readers are exempt); spam is
  // silently dropped behind the normal success response.
  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  if (!reader && !(await guardPublicSubmission(request, env, data)).ok) {
    return isJson(request) ? json({ ok: true }) : backTo(request, 'corrected');
  }

  await DB.prepare(
    'INSERT INTO corrections (entity_type, entity_id, body) VALUES (?, ?, ?)'
  ).bind(entityType, entityId, body).run();

  // A logged-in reader gets a trail row (target only — never the body).
  if (reader) await logReaderActivity(DB, reader.id, 'submitted correction', target.title);

  await notifyAdmins(env, 'notify_new_correction', 'admin_new_correction', {
    site_name: await getSiteName(env),
    entity_type: entityType,
    entity_title: target.title,
    correction_body: body,
    link: `${env.SITE_URL || ''}/admin/corrections`,
  });

  if (isJson(request)) return json({ ok: true });
  return backTo(request, 'corrected');
}

// ── Blog subscription ────────────────────────────────────────────────────────

async function setSubscription(request, env, subscribe) {
  const DB = env.DB;
  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  if (!reader) {
    return isJson(request) ? json({ error: 'not logged in' }, 401) : redirect('/reader/login');
  }

  if (subscribe) {
    await DB.prepare('INSERT OR IGNORE INTO blog_subscriptions (reader_account_id) VALUES (?)')
      .bind(reader.id).run();
  } else {
    await DB.prepare('DELETE FROM blog_subscriptions WHERE reader_account_id = ?')
      .bind(reader.id).run();
  }
  await logReaderActivity(DB, reader.id, subscribe ? 'subscribed' : 'unsubscribed', 'blog emails');

  if (isJson(request)) return json({ ok: true, subscribed: subscribe });
  return backTo(request, subscribe ? 'subscribed' : 'unsubscribed');
}
