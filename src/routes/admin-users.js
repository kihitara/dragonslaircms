// Admin user management: /admin/users* — admin-only CRUD for CMS accounts.
//
// Routes (caller has already authenticated `user`; role gate enforced here):
//   GET  /admin/users             list
//   GET  /admin/users/new         create form (password pre-generated, editable)
//   POST /admin/users/new         create
//   GET  /admin/users/<id>        edit form
//   POST /admin/users/<id>        update (optional password reset)
//   GET  /admin/users/<id>/logs   paginated activity_log trail for this user
//   POST /admin/users/<id>/delete delete
//
// Lockout protections:
//   - the LAST active admin can never be deleted, deactivated or demoted
//   - users can never delete themselves, change their own role, or
//     deactivate their own account
// Passwords are hashed with hashPassword() and never logged anywhere.

import { hashPassword, roleAtLeast } from '../auth.js';
import { logActivity } from '../db.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';

const ROLES = ['editor', 'publisher', 'admin'];
const ROLE_HELP = {
  editor: 'Editor — Pages, Articles, People, Media, moderation',
  publisher: 'Publisher — the above + branding, navigation & publishing',
  admin: 'Admin — full access, including users',
};

export async function handleUsers(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '');
  if (path !== '/admin/users' && !path.startsWith('/admin/users/')) return null;
  const DB = env.DB;

  if (!roleAtLeast(user, 'admin')) {
    return html(adminPage({
      env, user, title: 'Users', path: '/admin/users',
      content: '<h1>Admins only</h1><p class="muted">User management requires the admin role.</p>',
    }), { status: 403 });
  }

  if (path === '/admin/users' && request.method === 'GET') return listPage(env, user, url);
  if (path === '/admin/users/new') {
    if (request.method === 'GET') return html(adminPage({ env, user, title: 'New user', path, content: formHtml(null, user, url) }));
    if (request.method === 'POST') return create(request, env, user);
  }
  const logsMatch = path.match(/^\/admin\/users\/(\d+)\/logs$/);
  if (logsMatch && request.method === 'GET') return logsPage(env, user, url, parseInt(logsMatch[1], 10));
  const idMatch = path.match(/^\/admin\/users\/(\d+)$/);
  if (idMatch) {
    const target = await DB.prepare('SELECT * FROM users WHERE id = ?').bind(parseInt(idMatch[1], 10)).first();
    if (!target) return notFound(env, user);
    if (request.method === 'GET') return html(adminPage({ env, user, title: 'Edit user', path: '/admin/users', content: formHtml(target, user, url), extraHead: CONFIRM_MODAL_HEAD }));
    if (request.method === 'POST') return update(request, env, user, target);
  }
  const delMatch = path.match(/^\/admin\/users\/(\d+)\/delete$/);
  if (delMatch && request.method === 'POST') return remove(env, user, parseInt(delMatch[1], 10));
  return null;
}

function notFound(env, user) {
  return html(adminPage({
    env, user, title: 'Not found', path: '/admin/users',
    content: '<h1>User not found</h1><p class="muted"><a href="/admin/users">Back to users</a></p>',
  }), { status: 404 });
}

function flashHtml(url) {
  const ok = url.searchParams.get('ok');
  const err = url.searchParams.get('err');
  if (err) return `<div class="notice notice-error">${escapeHtml(err)}</div>`;
  if (ok) return `<div class="notice notice-green">${escapeHtml(ok)}</div>`;
  return '';
}

// Readable random password for the create form — the admin can copy it or
// type their own. Ambiguous characters (0/O, 1/l/I) are excluded.
function generatePassword(length = 16) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function countActiveAdmins(DB) {
  const row = await DB.prepare(`SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1`).first();
  return row?.n ?? 0;
}

function userFromForm(form) {
  const str = (k) => String(form.get(k) ?? '').trim();
  return {
    email: str('email').toLowerCase(),
    name: str('name'),
    role: ROLES.includes(form.get('role')) ? form.get('role') : 'editor',
    active: form.get('active') === '1' ? 1 : 0,
  };
}

async function listPage(env, user, url) {
  const DB = env.DB;
  const pageSize = await getPageSize(DB, user, url);
  const page = currentPage(url);
  const total = (await DB.prepare('SELECT COUNT(*) n FROM users').first())?.n ?? 0;
  const { results } = await DB.prepare(
    'SELECT id, email, name, role, active, last_login FROM users ORDER BY name LIMIT ? OFFSET ?'
  ).bind(pageSize, (page - 1) * pageSize).all();
  const users = results || [];

  const rows = users.map((u) => `
    <tr>
      <td class="cell-main"><a href="/admin/users/${u.id}"><strong>${escapeHtml(u.name)}</strong></a>${u.id === user.id ? ' <span class="muted small">(you)</span>' : ''}</td>
      <td data-label="Email">${escapeHtml(u.email)}</td>
      <td data-label="Role"><span class="badge">${escapeHtml(u.role)}</span></td>
      <td data-label="Status">${u.active ? '<span class="status-pill approved">Active</span>' : '<span class="status-pill rejected">Disabled</span>'}</td>
      <td data-label="Last login">${u.last_login ? escapeHtml(String(u.last_login).slice(0, 16).replace('T', ' ')) : '<span class="muted">never</span>'}</td>
      <td><div class="row-actions">
        <a class="btn btn-secondary btn-small" href="/admin/users/${u.id}">Edit</a>
        <a class="btn btn-secondary btn-small" href="/admin/users/${u.id}/logs">Logs</a>
      </div></td>
    </tr>`).join('');

  const content = `
    <div class="page-head">
      <h1>Users</h1>
      <div class="actions"><a class="btn" href="/admin/users/new">New user</a></div>
    </div>
    ${flashHtml(url)}
    <p class="muted small"><strong>Editors</strong> manage content. <strong>Publishers</strong> also control design and publishing. <strong>Admins</strong> additionally manage users.</p>
    <table class="admin-table cards">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: 'Users', path: '/admin/users', content }));
}

// Per-user activity trail: every activity_log row this account produced,
// newest first.
async function logsPage(env, user, url, id) {
  const DB = env.DB;
  const target = await DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(id).first();
  if (!target) return notFound(env, user);

  const pageSize = await getPageSize(DB, user, url);
  const page = currentPage(url);
  const total = (await DB.prepare('SELECT COUNT(*) n FROM activity_log WHERE user_id = ?').bind(id).first())?.n ?? 0;
  const { results: entries = [] } = await DB.prepare(
    `SELECT action, entity_type, entity_label, created_at FROM activity_log
     WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(id, pageSize, (page - 1) * pageSize).all();

  const rows = entries.map((e) => `
    <tr>
      <td class="cell-main">${escapeHtml((e.created_at || '').slice(0, 16).replace('T', ' '))}</td>
      <td data-label="Action">${escapeHtml(e.action)}</td>
      <td data-label="Entity">${escapeHtml(e.entity_type)}</td>
      <td data-label="Label">${e.entity_label ? escapeHtml(e.entity_label) : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  const content = `
    <div class="page-head">
      <h1>Activity — ${escapeHtml(target.name)}</h1>
      <div class="actions"><a class="btn btn-secondary" href="/admin/users">Back to users</a></div>
    </div>
    <p class="muted small">${escapeHtml(target.email)}</p>
    ${entries.length
      ? `<table class="admin-table cards">
          <thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Label</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      : '<p class="muted">No activity recorded for this user yet.</p>'}
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: `Activity — ${target.name}`, path: '/admin/users', content }));
}

function formHtml(target, user, url) {
  const isNew = !target;
  const isSelf = !!(target && target.id === user.id);
  const v = (k) => (target && target[k] != null ? escapeAttr(target[k]) : '');
  const role = target ? target.role : 'editor';
  const active = isNew ? true : !!target.active;
  const roleOpts = ROLES.map((r) =>
    `<option value="${r}"${role === r ? ' selected' : ''}>${escapeHtml(ROLE_HELP[r])}</option>`
  ).join('');

  return `
    <div class="page-head"><h1>${isNew ? 'New user' : 'Edit user'}</h1></div>
    ${flashHtml(url)}
    <form method="post" action="${isNew ? '/admin/users/new' : `/admin/users/${target.id}`}" style="max-width:620px">
      <div class="field">
        <label for="name">Name</label>
        <input type="text" id="name" name="name" value="${v('name')}" required>
      </div>
      <div class="field">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" value="${v('email')}" required>
      </div>
      <div class="field">
        <label for="role">Role</label>
        <select id="role" name="role"${isSelf ? ' disabled' : ''}>${roleOpts}</select>
        ${isSelf ? '<div class="hint">You can’t change your own role or deactivate your own account.</div>' : ''}
      </div>
      <div class="field">
        <label>Status</label>
        <label style="font-weight:normal;display:flex;gap:0.45rem;align-items:center">
          <input type="checkbox" name="active" value="1"${active ? ' checked' : ''}${isSelf ? ' disabled' : ''} style="width:auto"> Active — can sign in
        </label>
      </div>
      <div class="field">
        <label for="password">${isNew ? 'Password' : 'Reset password'}</label>
        ${isNew
          ? `<input type="text" id="password" name="password" value="${escapeAttr(generatePassword())}" autocomplete="off" required>
             <div class="hint">Pre-generated — copy it and share it with the user, or type your own (at least 8 characters).</div>`
          : `<input type="password" id="password" name="password" autocomplete="new-password" placeholder="Leave blank to keep the current password">`}
      </div>
      <div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap">
        <button class="btn" type="submit">${isNew ? 'Create user' : 'Save user'}</button>
        <a class="btn btn-secondary" href="/admin/users">Cancel</a>
        ${isNew || isSelf ? '' : `<button class="btn btn-danger" type="submit" formaction="/admin/users/${target.id}/delete" formnovalidate data-confirm="Delete this user? This cannot be undone." data-confirm-ok="Delete">Delete</button>`}
      </div>
    </form>`;
}

async function create(request, env, user) {
  const DB = env.DB;
  const form = await request.formData();
  const data = userFromForm(form);
  const password = String(form.get('password') || '') || generatePassword(); // never logged
  const back = '/admin/users/new';

  if (!data.name || !data.email) return redirect(back + '?err=' + encodeURIComponent('Name and email are required.'));
  if (password.length < 8) return redirect(back + '?err=' + encodeURIComponent('Password must be at least 8 characters.'));
  const clash = await DB.prepare('SELECT id FROM users WHERE email = ?').bind(data.email).first();
  if (clash) return redirect(back + '?err=' + encodeURIComponent('A user with that email already exists.'));

  await DB.prepare(
    'INSERT INTO users (email, name, role, password_hash, active) VALUES (?, ?, ?, ?, ?)'
  ).bind(data.email, data.name, data.role, await hashPassword(password), data.active).run();
  await logActivity(DB, user, 'created', 'user', `${data.name} (${data.email})`);
  return redirect('/admin/users?ok=' + encodeURIComponent(`User “${data.name}” created.`));
}

async function update(request, env, user, target) {
  const DB = env.DB;
  const form = await request.formData();
  const data = userFromForm(form);
  const password = String(form.get('password') || ''); // never logged
  const back = `/admin/users/${target.id}`;

  if (!data.name || !data.email) return redirect(back + '?err=' + encodeURIComponent('Name and email are required.'));
  if (password && password.length < 8) return redirect(back + '?err=' + encodeURIComponent('Password must be at least 8 characters.'));
  const clash = await DB.prepare('SELECT id FROM users WHERE email = ?').bind(data.email).first();
  if (clash && clash.id !== target.id) return redirect(back + '?err=' + encodeURIComponent('A user with that email already exists.'));

  if (target.id === user.id) {
    // No self-lockout: keep own role and stay active regardless of the form
    // (the fields are disabled in the UI, this enforces it server-side).
    data.role = target.role;
    data.active = 1;
  } else if (target.role === 'admin' && target.active && (data.role !== 'admin' || !data.active)
      && (await countActiveAdmins(DB)) <= 1) {
    return redirect(back + '?err=' + encodeURIComponent('This is the only active admin — promote another admin first.'));
  }

  await DB.prepare('UPDATE users SET email = ?, name = ?, role = ?, active = ? WHERE id = ?')
    .bind(data.email, data.name, data.role, data.active, target.id).run();
  if (password) {
    await DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(await hashPassword(password), target.id).run();
  }
  await logActivity(DB, user, 'updated', 'user', `${data.name} (${data.email})`);
  return redirect('/admin/users?ok=' + encodeURIComponent(`User “${data.name}” saved.`));
}

async function remove(env, user, id) {
  const DB = env.DB;
  if (id === user.id) return redirect('/admin/users?err=' + encodeURIComponent('You cannot delete your own account.'));
  const target = await DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) return redirect('/admin/users?err=' + encodeURIComponent('User not found.'));
  if (target.role === 'admin' && target.active && (await countActiveAdmins(DB)) <= 1) {
    return redirect('/admin/users?err=' + encodeURIComponent('This is the only active admin — promote another admin first.'));
  }
  await DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run(); // sessions cascade
  await logActivity(DB, user, 'deleted', 'user', `${target.name} (${target.email})`);
  return redirect('/admin/users?ok=' + encodeURIComponent('User deleted.'));
}
