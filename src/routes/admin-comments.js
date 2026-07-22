// Admin comment moderation: /admin/comments* — queue (pending first, status
// filters), approve/reject/delete for comments and replies, and staff replies
// posted under the logged-in CMS user's name. Caller (routes/admin.js) has
// already authenticated `user`.

import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';
import { logActivity } from '../db.js';
import { sendTemplatedEmail, getSiteName } from '../email.js';
import { articlePath, nl2br } from '../community.js';
import { sanitizeCommentHtml } from '../sanitize.js';

// Reduced rich-text editor assets, loaded for the staff reply forms.
const EDITOR_HEAD = '<link rel="stylesheet" href="/css/wysiwyg.css"><script src="/js/wysiwyg.js" defer></script>';

// Full comment/reply body for the moderation view. body_format 'html' is
// already sanitised (on write) — emit raw; otherwise nl2br(escapeHtml()).
function renderBody(row) {
  return row.body_format === 'html' ? String(row.body || '') : nl2br(row.body);
}

export async function handleComments(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '');

  if (path === '/admin/comments' && request.method === 'GET') {
    return listComments(request, env, url, user);
  }

  if (request.method === 'POST') {
    let m = path.match(/^\/admin\/comments\/(\d+)\/(approve|reject|delete|reply)$/);
    if (m) {
      const id = Number(m[1]);
      if (m[2] === 'reply') return staffReply(request, env, id, user);
      if (m[2] === 'delete') return deleteComment(env, id, user);
      return moderateComment(env, id, m[2] === 'approve' ? 'approved' : 'rejected', user);
    }
    m = path.match(/^\/admin\/comments\/replies\/(\d+)\/(approve|reject|delete)$/);
    if (m) {
      const id = Number(m[1]);
      if (m[2] === 'delete') return deleteReply(env, id, user);
      return moderateReply(env, id, m[2] === 'approve' ? 'approved' : 'rejected', user);
    }
  }

  return null;
}

// ── Queue ────────────────────────────────────────────────────────────────────

const STATUSES = ['all', 'pending', 'approved', 'rejected'];

async function listComments(request, env, url, user) {
  const DB = env.DB;
  const filter = STATUSES.includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';

  const { results: comments = [] } = await DB.prepare(
    `SELECT c.*, a.title AS article_title, a.slug AS article_slug, a.category AS article_category, r.username
     FROM comments c
     JOIN articles a ON a.id = c.article_id
     LEFT JOIN reader_accounts r ON r.id = c.reader_account_id
     WHERE (? = 'all' OR c.status = ?)
     ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at DESC
     LIMIT 200`
  ).bind(filter, filter).all();

  // All replies for the listed comments, grouped in JS (any status — pending
  // replies moderate inline under their parent).
  const ids = comments.map((c) => c.id);
  let repliesByComment = new Map();
  if (ids.length) {
    const { results: replies = [] } = await DB.prepare(
      `SELECT p.*, r.username FROM comment_replies p
       LEFT JOIN reader_accounts r ON r.id = p.reader_account_id
       WHERE p.comment_id IN (${ids.map(() => '?').join(',')})
       ORDER BY p.created_at ASC`
    ).bind(...ids).all();
    for (const rp of replies) {
      if (!repliesByComment.has(rp.comment_id)) repliesByComment.set(rp.comment_id, []);
      repliesByComment.get(rp.comment_id).push(rp);
    }
  }

  const tabs = STATUSES.map((s) =>
    `<a class="btn btn-small ${s === filter ? '' : 'btn-secondary'}" href="/admin/comments${s === 'all' ? '' : `?status=${s}`}">${s}</a>`
  ).join(' ');

  const actionBtn = (action, label, cls = 'btn-secondary', confirm = '') =>
    `<form method="post" action="${action}" style="display:inline"${confirm ? ` data-confirm="${escapeAttr(confirm)}" data-confirm-ok="${escapeAttr(label)}"` : ''}><button class="btn btn-small ${cls}" type="submit">${label}</button></form>`;

  const replyRow = (rp) => {
    const who = rp.staff_reply ? `${escapeHtml(rp.anonymous_name || 'Staff')} <span class="badge">Staff</span>` : escapeHtml(rp.username || rp.anonymous_name || 'Anonymous');
    const actions = rp.staff_reply ? '' : (rp.status === 'pending'
      ? actionBtn(`/admin/comments/replies/${rp.id}/approve`, 'Approve') + ' ' + actionBtn(`/admin/comments/replies/${rp.id}/reject`, 'Reject')
      : '');
    return `
      <div class="mod-reply">
        <div class="comment-head">${who}
          <span class="status-pill ${escapeAttr(rp.status)}">${escapeHtml(rp.status)}</span>
          <span class="muted small">${escapeHtml((rp.created_at || '').slice(0, 16).replace('T', ' '))}</span>
        </div>
        <div class="comment-body small">${renderBody(rp)}</div>
        <div class="row-actions" style="justify-content:flex-start;margin-top:0.4rem">
          ${actions} ${actionBtn(`/admin/comments/replies/${rp.id}/delete`, 'Delete', 'btn-danger', 'Delete this reply?')}
        </div>
      </div>`;
  };

  const cards = comments.map((c) => {
    const who = c.username
      ? `${escapeHtml(c.username)} <span class="badge badge-green">reader</span>`
      : `${escapeHtml(c.anonymous_name || 'Anonymous')}${c.anonymous_email ? ` <span class="muted small">&lt;${escapeHtml(c.anonymous_email)}&gt;</span>` : ''}`;
    const replies = (repliesByComment.get(c.id) || []).map(replyRow).join('');
    const moderation = c.status === 'pending'
      ? actionBtn(`/admin/comments/${c.id}/approve`, 'Approve', 'btn-green') + ' ' + actionBtn(`/admin/comments/${c.id}/reject`, 'Reject')
      : (c.status === 'approved'
        ? actionBtn(`/admin/comments/${c.id}/reject`, 'Reject')
        : actionBtn(`/admin/comments/${c.id}/approve`, 'Approve'));
    return `
    <div class="card" style="margin-bottom:1rem">
      <div class="comment-head" style="display:flex;gap:0.7rem;align-items:baseline;flex-wrap:wrap">
        <strong>${who}</strong>
        <span class="status-pill ${escapeAttr(c.status)}">${escapeHtml(c.status)}</span>
        <span class="muted small">on <a href="${escapeAttr(articlePath({ category: c.article_category, slug: c.article_slug }))}#comment-${c.id}" target="_blank">${escapeHtml(c.article_title)}</a></span>
        <span class="muted small">${escapeHtml((c.created_at || '').slice(0, 16).replace('T', ' '))}</span>
      </div>
      <div class="comment-body" style="margin:0.6rem 0">${renderBody(c)}</div>
      <div class="row-actions" style="justify-content:flex-start">
        ${moderation}
        ${actionBtn(`/admin/comments/${c.id}/delete`, 'Delete', 'btn-danger', 'Delete this comment and its replies?')}
      </div>
      ${replies ? `<div style="margin-top:0.8rem;padding-left:1rem;border-left:2px solid var(--color-surface-dark)">${replies}</div>` : ''}
      <details style="margin-top:0.8rem">
        <summary class="small">Reply as ${escapeHtml(user.name)} (staff)</summary>
        <form method="post" action="/admin/comments/${c.id}/reply">
          <div class="field" style="margin-top:0.6rem"><textarea name="body" required placeholder="Write a staff reply — posted immediately" data-richtext data-rt-mode="comment"></textarea></div>
          <button class="btn btn-small" type="submit">Post staff reply</button>
        </form>
      </details>
    </div>`;
  }).join('');

  const content = `
    <div class="page-head"><h1>Comments</h1><div class="actions">${tabs}</div></div>
    ${comments.length ? cards : '<p class="muted">No comments here.</p>'}`;

  return html(adminPage({ env, user, title: 'Comments', path: '/admin/comments', content, extraHead: CONFIRM_MODAL_HEAD + EDITOR_HEAD }));
}

// ── Moderation actions ───────────────────────────────────────────────────────

async function moderateComment(env, id, status, user) {
  const DB = env.DB;
  await DB.prepare(`UPDATE comments SET status = ?, moderated_at = datetime('now') WHERE id = ?`)
    .bind(status, id).run();

  // Email the author — only if they have a reader account and their
  // comment_moderated preference is on (missing row = enabled).
  const author = await DB.prepare(
    `SELECT r.username, r.email, COALESCE(np.email_enabled, 1) AS email_enabled,
            a.title AS article_title, a.slug, a.category, c.id AS comment_id
     FROM comments c
     JOIN reader_accounts r ON r.id = c.reader_account_id
     JOIN articles a ON a.id = c.article_id
     LEFT JOIN notification_preferences np
       ON np.reader_account_id = r.id AND np.type = 'comment_moderated'
     WHERE c.id = ?`
  ).bind(id).first();

  if (author && author.email_enabled) {
    await sendTemplatedEmail(env, 'comment_moderated', author.email, {
      site_name: await getSiteName(env),
      username: author.username,
      article_title: author.article_title,
      status: status === 'approved' ? 'approved' : 'not approved',
      link: `${env.SITE_URL || ''}${articlePath(author)}#comment-${author.comment_id}`,
    });
  }

  await logActivity(DB, user, `${status === 'approved' ? 'approved' : 'rejected'}`, 'comment', `#${id}`);
  return redirect('/admin/comments');
}

async function deleteComment(env, id, user) {
  await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run(); // replies cascade
  await logActivity(env.DB, user, 'deleted', 'comment', `#${id}`);
  return redirect('/admin/comments');
}

// Approving a reply notifies the parent comment's author (comment_reply pref).
async function notifyParentAuthor(env, reply) {
  const parent = await env.DB.prepare(
    `SELECT r.username, r.email, COALESCE(np.email_enabled, 1) AS email_enabled,
            a.title AS article_title, a.slug, a.category, c.id AS comment_id
     FROM comments c
     JOIN reader_accounts r ON r.id = c.reader_account_id
     JOIN articles a ON a.id = c.article_id
     LEFT JOIN notification_preferences np
       ON np.reader_account_id = r.id AND np.type = 'comment_reply'
     WHERE c.id = ?`
  ).bind(reply.comment_id).first();
  if (!parent || !parent.email_enabled) return;

  const replyAuthor = reply.staff_reply
    ? (reply.anonymous_name || 'The site team')
    : (reply.username || reply.anonymous_name || 'Someone');

  await sendTemplatedEmail(env, 'comment_reply', parent.email, {
    site_name: await getSiteName(env),
    username: parent.username,
    reply_author: replyAuthor,
    article_title: parent.article_title,
    link: `${env.SITE_URL || ''}${articlePath(parent)}#comment-${parent.comment_id}`,
  });
}

async function moderateReply(env, id, status, user) {
  const DB = env.DB;
  await DB.prepare('UPDATE comment_replies SET status = ? WHERE id = ?').bind(status, id).run();

  if (status === 'approved') {
    const reply = await DB.prepare(
      `SELECT p.*, r.username FROM comment_replies p
       LEFT JOIN reader_accounts r ON r.id = p.reader_account_id WHERE p.id = ?`
    ).bind(id).first();
    if (reply) await notifyParentAuthor(env, reply);
  }

  await logActivity(DB, user, `${status === 'approved' ? 'approved' : 'rejected'}`, 'comment reply', `#${id}`);
  return redirect('/admin/comments');
}

async function deleteReply(env, id, user) {
  await env.DB.prepare('DELETE FROM comment_replies WHERE id = ?').bind(id).run();
  await logActivity(env.DB, user, 'deleted', 'comment reply', `#${id}`);
  return redirect('/admin/comments');
}

// ── Staff reply ──────────────────────────────────────────────────────────────

// Auto-approved reply under the CMS user's name; the name lives in
// anonymous_name with staff_reply = 1 marking it as staff.
async function staffReply(request, env, commentId, user) {
  const DB = env.DB;
  const form = await request.formData();
  const body = String(form.get('body') || '').trim();
  if (!body) return redirect('/admin/comments');

  // Staff replies are authored in the rich editor: sanitise on write and store
  // body_format='html'.
  const storedBody = sanitizeCommentHtml(body);
  if (!storedBody) return redirect('/admin/comments');

  const parent = await DB.prepare('SELECT id FROM comments WHERE id = ?').bind(commentId).first();
  if (!parent) return redirect('/admin/comments');

  await DB.prepare(
    `INSERT INTO comment_replies (comment_id, anonymous_name, body, body_format, status, staff_reply)
     VALUES (?, ?, ?, 'html', 'approved', 1)`
  ).bind(commentId, user.name, storedBody).run();

  await notifyParentAuthor(env, { comment_id: commentId, staff_reply: 1, anonymous_name: user.name });
  await logActivity(DB, user, 'replied to', 'comment', `#${commentId}`);
  return redirect('/admin/comments');
}
