// Community features surface (comments, corrections, subscription prompts)
// injected into public article/page rendering, plus publish-time
// notifications. Fragments are self-contained: they pull in
// /css/community.css themselves so callers only splice in the HTML.
//
// Comment bodies and names are UNTRUSTED reader input — always escaped, with
// line breaks preserved via nl2br().

import { getReaderSession } from './auth.js';
import { getSiteSettings } from './db.js';
import { escapeHtml, escapeAttr, formatDate } from './templates/base.js';
import { sendTemplatedEmail, getSiteName } from './email.js';
import { honeypotField, spamToken, spamTokenField } from './antispam.js';

// <link> in body is valid for stylesheets and keeps the fragment drop-in. When
// the viewer is a logged-in reader we also self-load the reduced rich-text
// editor (a deferred <script> in the fragment is fine — the textareas are
// present at load, so DOMContentLoaded auto-upgrade covers them).
const CSS_LINK = '<link rel="stylesheet" href="/css/community.css">';
const EDITOR_HEAD = '<link rel="stylesheet" href="/css/wysiwyg.css"><script src="/js/wysiwyg.js" defer></script>';

// Escape then preserve line breaks — the only transformation comment bodies get.
export function nl2br(str) {
  return escapeHtml(str).replace(/\r?\n/g, '<br>');
}

// Render a stored comment/reply body for display. body_format 'html' is already
// sanitised on write (sanitizeCommentHtml) — emit it raw. Anything else (plain
// text: anonymous / legacy comments) goes through nl2br(escapeHtml()).
function renderBody(row) {
  return row.body_format === 'html' ? String(row.body || '') : nl2br(row.body);
}

// Public URL of an article: category decides the /blog vs /news prefix.
export function articlePath(article) {
  return `/${article.category === 'news' ? 'news' : 'blog'}/${article.slug}`;
}

// ── Correction widget (shared by articles and pages) ────────────────────────

function correctionWidget({ entityType, entityId, submitted, spam = '' }) {
  if (submitted) {
    return `<div class="notice notice-green">Thank you — your correction has been sent to the editors.</div>`;
  }
  return `
  <details class="correction-widget">
    <summary>Suggest a correction</summary>
    <form method="post" action="/api/corrections" class="comment-form">
      ${spam}
      <input type="hidden" name="entity_type" value="${escapeAttr(entityType)}">
      <input type="hidden" name="entity_id" value="${escapeAttr(String(entityId))}">
      <div class="field">
        <label for="correction-body">What needs fixing?</label>
        <textarea id="correction-body" name="body" required placeholder="Quote the text and describe the problem…"></textarea>
      </div>
      <button class="btn btn-small" type="submit">Send correction</button>
    </form>
  </details>`;
}

// ── Comment rendering ────────────────────────────────────────────────────────

function displayName(row) {
  if (row.staff_reply) return row.anonymous_name || 'Staff'; // staff name is stored in anonymous_name
  return row.username || row.anonymous_name || 'Anonymous';
}

function anonymousFields() {
  return `
      <div class="field"><label>Name</label><input type="text" name="anonymous_name" required maxlength="80"></div>
      <div class="field"><label>Email <span class="muted">(optional, never shown)</span></label><input type="email" name="anonymous_email" maxlength="200"></div>`;
}

function replyHtml(reply) {
  const staff = !!reply.staff_reply;
  return `
    <div class="comment${staff ? ' staff' : ''}">
      <div class="comment-head">
        <span class="comment-author">${escapeHtml(displayName(reply))}</span>
        ${staff ? '<span class="badge">Staff</span>' : ''}
        <span class="comment-date">${escapeHtml(formatDate(reply.created_at))}</span>
      </div>
      <div class="comment-body">${renderBody(reply)}</div>
    </div>`;
}

function commentHtml(comment, replies, { reader, mode, spam = '' }) {
  // Replies follow the same rule as top-level comments: anyone (enabled),
  // logged-in readers only (readers), nobody (closed/disabled).
  const replyAllowed = mode === 'enabled' || (mode === 'readers' && !!reader);
  const replyForm = !replyAllowed ? '' : `
      <details class="reply-widget">
        <summary>Reply</summary>
        <form method="post" action="/api/comments/${comment.id}/reply" class="comment-form">
          ${reader ? '' : spam}
          ${reader
            ? `<p class="small muted">Replying as <strong>${escapeHtml(reader.username)}</strong></p>`
            : anonymousFields()}
          <div class="field"><textarea name="body" required placeholder="Write a reply…"${reader ? ' data-richtext data-rt-mode="comment"' : ''}></textarea></div>
          <button class="btn btn-small" type="submit">Post reply</button>
        </form>
      </details>`;

  return `
  <div class="comment" id="comment-${comment.id}">
    <div class="comment-head">
      <span class="comment-author">${escapeHtml(displayName(comment))}</span>
      <span class="comment-date">${escapeHtml(formatDate(comment.created_at))}</span>
    </div>
    <div class="comment-body">${renderBody(comment)}</div>
    ${replies.length ? `<div class="replies">${replies.map(replyHtml).join('')}</div>` : ''}
    ${replyForm}
  </div>`;
}

// ── Article community block ──────────────────────────────────────────────────

// Approved comments (with nested approved replies), the comment form (or a
// "comments closed" note), a subscription nudge, and the correction widget.
export async function renderArticleCommunity(request, env, article) {
  const DB = env.DB;
  const url = new URL(request.url);
  const params = url.searchParams;

  const [reader, settings] = await Promise.all([
    getReaderSession(request, DB, env.READER_SESSION_SECRET),
    getSiteSettings(DB),
  ]);

  const [{ results: comments = [] }, { results: replies = [] }] = await Promise.all([
    DB.prepare(
      `SELECT c.id, c.body, c.body_format, c.created_at, c.anonymous_name, r.username
       FROM comments c LEFT JOIN reader_accounts r ON r.id = c.reader_account_id
       WHERE c.article_id = ? AND c.status = 'approved'
       ORDER BY c.created_at ASC`
    ).bind(article.id).all(),
    DB.prepare(
      `SELECT p.id, p.comment_id, p.body, p.body_format, p.created_at, p.anonymous_name, p.staff_reply, r.username
       FROM comment_replies p
       JOIN comments c ON c.id = p.comment_id
       LEFT JOIN reader_accounts r ON r.id = p.reader_account_id
       WHERE c.article_id = ? AND p.status = 'approved'
       ORDER BY p.created_at ASC`
    ).bind(article.id).all(),
  ]);

  const repliesByComment = new Map();
  for (const rp of replies) {
    if (!repliesByComment.has(rp.comment_id)) repliesByComment.set(rp.comment_id, []);
    repliesByComment.get(rp.comment_id).push(rp);
  }

  // enabled (anyone) | readers (logged-in only) | closed (show approved, no new)
  // | disabled (hide all, reversible). Fall back for pre-migration rows.
  const mode = article.comment_mode || (article.comments_disabled ? 'closed' : 'enabled');
  const selfRegistration = (settings.self_registration ?? '1') !== '0';
  const acceptingComments = mode === 'enabled' || (mode === 'readers' && !!reader);

  // Post-submit notices (set by /api/* redirects back to this page).
  let notice = '';
  if (params.get('commented') === '1' || params.get('replied') === '1') {
    notice = `<div class="notice">Thanks! Your ${params.get('replied') === '1' ? 'reply' : 'comment'} has been received and is awaiting moderation.</div>`;
  } else if (params.get('subscribed') === '1') {
    notice = `<div class="notice notice-green">You're now subscribed to new articles.</div>`;
  } else if (params.get('unsubscribed') === '1') {
    notice = `<div class="notice">You've been unsubscribed from new-article emails.</div>`;
  }

  // Subscription nudge for logged-in readers who aren't subscribed yet.
  let subscribeHtml = '';
  if (reader) {
    const sub = await DB.prepare('SELECT 1 AS x FROM blog_subscriptions WHERE reader_account_id = ?')
      .bind(reader.id).first();
    if (!sub) {
      subscribeHtml = `
      <div class="subscription-nudge">
        <span>Enjoying the blog? Get an email when a new article is published.</span>
        <form method="post" action="/api/subscribe"><button class="btn btn-small" type="submit">Subscribe</button></form>
      </div>`;
    }
  }

  // Comment form (or closed notice). Anonymous visitors always get a Login
  // pointer (reader login stays open regardless); the register link only shows
  // when self-registration is enabled.
  // Anti-spam fields for the public forms (one token per page render).
  const spam = honeypotField() + spamTokenField(await spamToken(env));

  let formHtml;
  if (mode === 'closed') {
    formHtml = `<p class="muted">Comments are closed — no new comments are being accepted.</p>`;
  } else if (mode === 'readers' && !reader) {
    formHtml = `<p class="muted">Only registered readers can comment on this article. <a href="/reader/login">Log in</a>${selfRegistration ? ' or <a href="/reader/register">register</a>' : ''} to join the conversation.</p>`;
  } else {
    // enabled (anyone) or readers + a logged-in reader.
    const authNote = reader
      ? `<p class="small muted">Commenting as <strong>${escapeHtml(reader.username)}</strong> · <a href="/reader/dashboard">Your account</a></p>`
      : (selfRegistration
          ? `<p class="small muted">Have an account? <a href="/reader/login">Log in</a> or <a href="/reader/register">register</a> to comment under your username.</p>`
          : `<p class="small muted">Have an account? <a href="/reader/login">Log in</a> to comment under your username.</p>`);
    formHtml = `
    <form method="post" action="/api/comments" class="comment-form">
      ${reader ? '' : spam}
      <h3>Leave a comment</h3>
      ${authNote}
      <input type="hidden" name="article_id" value="${escapeAttr(String(article.id))}">
      ${reader ? '' : anonymousFields()}
      <div class="field"><textarea name="body" required placeholder="Share your thoughts…"${reader ? ' data-richtext data-rt-mode="comment"' : ''}></textarea></div>
      <button class="btn" type="submit">Post comment</button>
      <p class="small muted">All comments are held for moderation before appearing.</p>
    </form>`;
  }

  const listHtml = comments.length
    ? comments.map((c) => commentHtml(c, repliesByComment.get(c.id) || [], { reader, mode, spam })).join('')
    : '<p class="muted">No comments yet.</p>';

  // Logged-in readers get the reduced rich-text editor when they can actually
  // comment (enabled/readers); anonymous visitors keep the plain textarea.
  const editorHead = reader && acceptingComments ? EDITOR_HEAD : '';

  // 'disabled' hides the whole comments block (existing comments included) —
  // nothing is deleted, so it returns if the mode changes. Corrections are a
  // separate, independently-gated section.
  const commentsSection = mode === 'disabled' ? '' : `
<section class="comments community-block" id="comments">
  ${notice}
  ${subscribeHtml}
  <h2>Comments${comments.length ? ` (${comments.length})` : ''}</h2>
  ${listHtml}
  ${formHtml}
</section>`;

  const correctionsSection = (settings.corrections_enabled ?? '1') !== '0' && !article.corrections_disabled
    ? `<section class="community-block">${correctionWidget({ entityType: 'article', entityId: article.id, submitted: params.get('corrected') === '1', spam })}</section>`
    : '';

  return `${CSS_LINK}${editorHead}${commentsSection}${correctionsSection}`;
}

// ── Page corrections block ───────────────────────────────────────────────────

// Just the correction widget for a CMS page.
export async function renderPageCorrections(request, env, page) {
  const settings = await getSiteSettings(env.DB);
  // Off site-wide or for this page → render nothing at all.
  if ((settings.corrections_enabled ?? '1') === '0' || page.corrections_disabled) return '';
  const params = new URL(request.url).searchParams;
  const spam = honeypotField() + spamTokenField(await spamToken(env));
  return `${CSS_LINK}
<section class="community-block">
  ${correctionWidget({ entityType: 'page', entityId: page.id, submitted: params.get('corrected') === '1', spam })}
</section>`;
}

// ── Publish-time notification ────────────────────────────────────────────────

// Email every approved, subscribed reader whose new_article preference is on
// (no preference row = enabled). Called when an article is first published.
export async function notifyNewArticle(env, article) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT r.username, r.email
       FROM blog_subscriptions bs
       JOIN reader_accounts r ON r.id = bs.reader_account_id
       LEFT JOIN notification_preferences np
         ON np.reader_account_id = r.id AND np.type = 'new_article'
       WHERE r.status = 'approved' AND COALESCE(np.email_enabled, 1) = 1`
    ).all();

    const subscribers = results || [];
    if (!subscribers.length) return;

    const siteName = await getSiteName(env);
    const link = `${env.SITE_URL || ''}${articlePath(article)}`;
    for (const sub of subscribers) {
      await sendTemplatedEmail(env, 'new_article', sub.email, {
        site_name: siteName,
        username: sub.username,
        article_title: article.title,
        link,
      });
    }
  } catch (err) {
    console.error('[community] notifyNewArticle failed:', err?.message || err);
  }
}
