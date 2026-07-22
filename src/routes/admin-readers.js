// Admin reader accounts: /admin/readers* — approval queue (verified pending
// accounts first), approve/reject with reader emails, delete, and a per-reader
// activity log (/admin/readers/<id>/logs, from reader_activity_log). Caller
// has already authenticated `user`.

import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';
import { getSiteSettings, logActivity } from '../db.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { sendTemplatedEmail, getSiteName } from '../email.js';
import { hashPassword } from '../auth.js';
import { logReaderActivity } from './reader.js';

export async function handleReaders(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '');

  if (path === '/admin/readers' && request.method === 'GET') {
    return listReaders(request, env, url, user);
  }

  const logsMatch = path.match(/^\/admin\/readers\/(\d+)\/logs$/);
  if (logsMatch && request.method === 'GET') {
    return readerLogsPage(env, url, user, Number(logsMatch[1]));
  }

  const pwMatch = path.match(/^\/admin\/readers\/(\d+)\/password$/);
  if (pwMatch) {
    if (request.method === 'GET') return setPasswordForm(env, user, Number(pwMatch[1]));
    if (request.method === 'POST') return setPassword(request, env, user, Number(pwMatch[1]));
  }

  if (request.method === 'POST') {
    const m = path.match(/^\/admin\/readers\/(\d+)\/(approve|reject|delete)$/);
    if (m) return readerAction(env, Number(m[1]), m[2], user);
  }

  return null;
}

// Set a reader's password directly (no email). Fills the gap where a reader is
// locked out and there is no email transport to send a reset link.
async function setPasswordForm(env, user, id, error = '') {
  const DB = env.DB;
  const reader = await DB.prepare('SELECT id, username, email FROM reader_accounts WHERE id = ?').bind(id).first();
  if (!reader) return redirect('/admin/readers');
  const content = `
    <div class="page-head">
      <h1>Set password — ${escapeHtml(reader.username)}</h1>
      <div class="actions"><a class="btn btn-secondary" href="/admin/readers">Back to readers</a></div>
    </div>
    <p class="muted small">${escapeHtml(reader.email)}</p>
    <p class="muted">Set a new password for this reader and share it with them securely — this does not email them. Any current sessions are logged out.</p>
    ${error ? `<div class="notice notice-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/admin/readers/${reader.id}/password" style="max-width:420px">
      <div class="field">
        <label for="password">New password</label>
        <input type="password" id="password" name="password" required minlength="8" autofocus autocomplete="new-password">
        <p class="hint">At least 8 characters.</p>
      </div>
      <div class="field">
        <label for="confirm">Confirm new password</label>
        <input type="password" id="confirm" name="confirm" required minlength="8" autocomplete="new-password">
      </div>
      <button class="btn" type="submit">Set password</button>
    </form>`;
  return html(adminPage({ env, user, title: `Set password — ${reader.username}`, path: '/admin/readers', content }));
}

async function setPassword(request, env, user, id) {
  const DB = env.DB;
  const reader = await DB.prepare('SELECT id, username FROM reader_accounts WHERE id = ?').bind(id).first();
  if (!reader) return redirect('/admin/readers');
  const form = await request.formData();
  const password = String(form.get('password') || '');
  const confirm = String(form.get('confirm') || '');
  if (password.length < 8) return setPasswordForm(env, user, id, 'Password must be at least 8 characters.');
  if (password !== confirm) return setPasswordForm(env, user, id, 'The two passwords do not match.');

  const hash = await hashPassword(password);
  await DB.prepare('UPDATE reader_accounts SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?')
    .bind(hash, id).run();
  await DB.prepare('DELETE FROM reader_sessions WHERE reader_account_id = ?').bind(id).run();
  await logActivity(DB, user, 'set the password for', 'reader', reader.username);
  await logReaderActivity(DB, id, 'password set by an administrator');
  return redirect('/admin/readers?ok=' + encodeURIComponent(`Password updated for ${reader.username}.`));
}

const FILTERS = ['all', 'pending', 'approved', 'rejected'];

async function listReaders(request, env, url, user) {
  const DB = env.DB;
  const filter = FILTERS.includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';
  const settings = await getSiteSettings(DB);

  const pageSize = await getPageSize(DB, user, url);
  const page = currentPage(url);
  const total = (await DB.prepare(
    `SELECT COUNT(*) n FROM reader_accounts WHERE (? = 'all' OR status = ?)`
  ).bind(filter, filter).first())?.n ?? 0;

  // Actionable first: verified pending accounts, then unverified pending.
  const { results: readers = [] } = await DB.prepare(
    `SELECT id, username, email, status, email_verified, created_at, last_login
     FROM reader_accounts
     WHERE (? = 'all' OR status = ?)
     ORDER BY CASE
       WHEN status = 'pending' AND email_verified = 1 THEN 0
       WHEN status = 'pending' THEN 1
       WHEN status = 'approved' THEN 2
       ELSE 3 END, created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(filter, filter, pageSize, (page - 1) * pageSize).all();

  const tabs = FILTERS.map((s) =>
    `<a class="btn btn-small ${s === filter ? '' : 'btn-secondary'}" href="/admin/readers${s === 'all' ? '' : `?status=${s}`}">${s}</a>`
  ).join(' ');

  const regClosed = (settings.self_registration ?? '1') === '0'
    ? '<div class="notice">Self-registration is currently <strong>disabled</strong> — no new readers can sign up. Change this under <a href="/admin/settings">Settings</a>.</div>'
    : '';

  const btn = (id, action, label, cls = 'btn-secondary', confirm = '') =>
    `<form method="post" action="/admin/readers/${id}/${action}" style="display:inline"${confirm ? ` data-confirm="${escapeAttr(confirm)}" data-confirm-ok="${escapeAttr(label)}"` : ''}><button class="btn btn-small ${cls}" type="submit">${label}</button></form>`;

  const rows = readers.map((r) => {
    const actions = [];
    if (r.status !== 'approved') actions.push(btn(r.id, 'approve', 'Approve', 'btn-green'));
    if (r.status !== 'rejected') actions.push(btn(r.id, 'reject', 'Reject'));
    actions.push(`<a class="btn btn-small btn-secondary" href="/admin/readers/${r.id}/password">Set password</a>`);
    actions.push(`<a class="btn btn-small btn-secondary" href="/admin/readers/${r.id}/logs">Logs</a>`);
    actions.push(btn(r.id, 'delete', 'Delete', 'btn-danger', 'Permanently delete this reader account, its comments links and subscription?'));
    return `
    <tr>
      <td class="cell-main"><strong>${escapeHtml(r.username)}</strong></td>
      <td data-label="Email">${escapeHtml(r.email)}</td>
      <td data-label="Status"><span class="status-pill ${escapeAttr(r.status)}">${escapeHtml(r.status)}</span></td>
      <td data-label="Verified">${r.email_verified ? '<span class="badge badge-green">verified</span>' : '<span class="muted small">unverified</span>'}</td>
      <td data-label="Registered" class="muted small">${escapeHtml((r.created_at || '').slice(0, 10))}</td>
      <td data-label="Last login" class="muted small">${escapeHtml((r.last_login || '—').slice(0, 10))}</td>
      <td><div class="row-actions">${actions.join(' ')}</div></td>
    </tr>`;
  }).join('');

  const okMsg = url.searchParams.get('ok');
  const flash = okMsg ? `<div class="notice notice-green">${escapeHtml(okMsg)}</div>` : '';

  const content = `
    <div class="page-head"><h1>Readers</h1><div class="actions">${tabs}</div></div>
    ${flash}
    ${regClosed}
    ${readers.length
      ? `<table class="admin-table cards">
          <thead><tr><th>Username</th><th>Email</th><th>Status</th><th>Verified</th><th>Registered</th><th>Last login</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      : '<p class="muted">No reader accounts here.</p>'}
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: 'Readers', path: '/admin/readers', content, extraHead: CONFIRM_MODAL_HEAD }));
}

// Per-reader activity trail: everything reader.js/api.js recorded for this
// account, newest first.
async function readerLogsPage(env, url, user, id) {
  const DB = env.DB;
  const reader = await DB.prepare('SELECT id, username, email FROM reader_accounts WHERE id = ?').bind(id).first();
  if (!reader) return redirect('/admin/readers');

  const pageSize = await getPageSize(DB, user, url);
  const page = currentPage(url);
  const total = (await DB.prepare(
    'SELECT COUNT(*) n FROM reader_activity_log WHERE reader_account_id = ?'
  ).bind(id).first())?.n ?? 0;
  const { results: entries = [] } = await DB.prepare(
    `SELECT action, detail, created_at FROM reader_activity_log
     WHERE reader_account_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(id, pageSize, (page - 1) * pageSize).all();

  const rows = entries.map((e) => `
    <tr>
      <td class="cell-main">${escapeHtml((e.created_at || '').slice(0, 16).replace('T', ' '))}</td>
      <td data-label="Action">${escapeHtml(e.action)}</td>
      <td data-label="Detail">${e.detail ? escapeHtml(e.detail) : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  const content = `
    <div class="page-head">
      <h1>Activity — ${escapeHtml(reader.username)}</h1>
      <div class="actions"><a class="btn btn-secondary" href="/admin/readers">Back to readers</a></div>
    </div>
    <p class="muted small">${escapeHtml(reader.email)}</p>
    ${entries.length
      ? `<table class="admin-table cards">
          <thead><tr><th>When</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      : '<p class="muted">No activity recorded for this reader yet.</p>'}
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: `Activity — ${reader.username}`, path: '/admin/readers', content }));
}

async function readerAction(env, id, action, user) {
  const DB = env.DB;
  const reader = await DB.prepare('SELECT id, username, email FROM reader_accounts WHERE id = ?').bind(id).first();
  if (!reader) return redirect('/admin/readers');

  if (action === 'delete') {
    // Sessions, subscription, and preferences cascade; comments keep their
    // body with reader_account_id set NULL.
    await DB.prepare('DELETE FROM reader_accounts WHERE id = ?').bind(id).run();
    await logActivity(DB, user, 'deleted', 'reader', reader.username);
    return redirect('/admin/readers');
  }

  const status = action === 'approve' ? 'approved' : 'rejected';
  await DB.prepare('UPDATE reader_accounts SET status = ? WHERE id = ?').bind(status, id).run();

  await sendTemplatedEmail(env, status === 'approved' ? 'account_approved' : 'account_rejected', reader.email, {
    site_name: await getSiteName(env),
    username: reader.username,
    link: `${env.SITE_URL || ''}/reader/login`,
  });

  await logActivity(DB, user, status === 'approved' ? 'approved' : 'rejected', 'reader', reader.username);
  return redirect('/admin/readers');
}
