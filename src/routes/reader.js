// Reader account routes: /reader/* — self-registration (when the setting
// allows), email verification, login/logout, dashboard, and settings.
// Reader pages render with the public site chrome (sitePage + loadChrome).

import {
  hashPassword, verifyPassword,
  createReaderSession, getReaderSession, destroyReaderSession, clearReaderSessionCookie,
  clientIp, isLockedOut, recordLoginFailure, clearLoginFailures,
  generateVerificationToken, generateResetToken,
} from '../auth.js';
import { loadChrome } from '../site.js';
import { sitePage, escapeHtml, escapeAttr, formatDate, redirect, html } from '../templates/base.js';
import { sendTemplatedEmail, notifyAdmins, getSiteName, emailEnabled } from '../email.js';
import { articlePath } from '../community.js';
import { sanitizeCommentHtml, commentToText } from '../sanitize.js';

const CSS_LINK = '<link rel="stylesheet" href="/css/community.css">';
// Reduced rich-text editor assets (used on the edit-comment screen).
const EDITOR_HEAD = '<link rel="stylesheet" href="/css/wysiwyg.css"><script src="/js/wysiwyg.js" defer></script>';

// Reader activity trail (reader_activity_log), surfaced per account in the
// admin. Mirrors logActivity(): recording must never break the request it
// decorates, and details stay short and human-readable — never passwords or
// comment bodies. Also imported by api.js for the community endpoints.
export async function logReaderActivity(DB, readerId, action, detail = null) {
  if (!readerId) return;
  try {
    await DB.prepare(
      'INSERT INTO reader_activity_log (reader_account_id, action, detail) VALUES (?, ?, ?)'
    ).bind(readerId, action, detail).run();
  } catch { /* best-effort */ }
}
const NOTIF_TYPES = [
  { type: 'new_article', label: 'A new article is published (requires blog subscription)' },
  { type: 'comment_reply', label: 'Someone replies to one of my comments' },
  { type: 'comment_moderated', label: 'One of my comments is approved or rejected' },
];

export async function handleReader(request, env, url) {
  const path = url.pathname.replace(/\/$/, '');
  if (path !== '/reader' && !path.startsWith('/reader/')) return null;
  const DB = env.DB;

  // Own-comment management (edit/delete) — id-bearing paths, matched first.
  let m = path.match(/^\/reader\/comments\/(\d+)\/edit$/);
  if (m) return editComment(request, env, url, Number(m[1]));
  m = path.match(/^\/reader\/comments\/(\d+)\/delete$/);
  if (m) return request.method === 'POST' ? deleteOwnComment(request, env, Number(m[1])) : redirect('/reader/dashboard');
  m = path.match(/^\/reader\/replies\/(\d+)\/delete$/);
  if (m) return request.method === 'POST' ? deleteOwnReply(request, env, Number(m[1])) : redirect('/reader/dashboard');

  switch (path) {
    case '/reader':
      return redirect('/reader/dashboard');
    case '/reader/register':
      return register(request, env, url);
    case '/reader/verify':
      return verify(request, env, url);
    case '/reader/login':
      return login(request, env, url);
    case '/reader/forgot':
      return forgot(request, env, url);
    case '/reader/reset':
      return reset(request, env, url);
    case '/reader/logout': {
      const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
      if (reader) {
        await destroyReaderSession(DB, reader.sessionId);
        await logReaderActivity(DB, reader.id, 'logged out');
      }
      return redirect('/', { 'Set-Cookie': clearReaderSessionCookie() });
    }
    case '/reader/dashboard':
      return dashboard(request, env, url);
    case '/reader/settings':
      return settings(request, env, url);
    case '/reader/settings/password':
      if (request.method === 'POST') return changePassword(request, env);
      return redirect('/reader/settings');
    case '/reader/settings/notifications':
      if (request.method === 'POST') return saveNotifications(request, env);
      return redirect('/reader/settings');
    default:
      return null;
  }
}

// Public-chrome page wrapper shared by all reader screens.
async function readerPage(request, env, url, { title, content, status = 200, extraHead = '' }) {
  const { settings: siteSettings, navItems, footer, reader } = await loadChrome(env, url, request);
  return html(sitePage({
    env, title, nav: navItems, footer, siteSettings, reader, content,
    extraHead: `${CSS_LINK}<meta name="robots" content="noindex">${extraHead}`,
  }), { status });
}

function narrow(inner) {
  return `<section class="section"><div class="container"><div class="reader-card">${inner}</div></div></section>`;
}

// ── Registration ─────────────────────────────────────────────────────────────

function registerFormHtml({ error = '', username = '', email = '' } = {}) {
  return `
    <h1>Create a reader account</h1>
    <p class="muted">Comment under your own name, subscribe to the blog, and manage your notifications.</p>
    ${error ? `<div class="notice notice-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/reader/register">
      <div class="field"><label for="username">Username</label>
        <input type="text" id="username" name="username" value="${escapeAttr(username)}" required maxlength="80" autocomplete="username"></div>
      <div class="field"><label for="email">Email</label>
        <input type="email" id="email" name="email" value="${escapeAttr(email)}" required maxlength="200" autocomplete="email">
        <p class="hint">You'll need to verify this address before your account is activated.</p></div>
      <div class="field"><label for="password">Password</label>
        <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
        <p class="hint">At least 8 characters.</p></div>
      <button class="btn" type="submit">Register</button>
      <p class="small muted" style="margin-top:1rem">Already have an account? <a href="/reader/login">Log in</a></p>
    </form>`;
}

async function register(request, env, url) {
  const DB = env.DB;
  const { settings } = await loadChrome(env, url);

  // Missing setting = enabled; '0' switches self-registration off entirely.
  if ((settings.self_registration ?? '1') === '0') {
    return readerPage(request, env, url, {
      title: 'Registration closed', status: 404,
      content: narrow(`<h1>Registration is closed</h1><p class="muted">This site is not accepting new reader accounts at the moment.</p><p><a class="btn btn-secondary" href="/">Back to the site</a></p>`),
    });
  }

  const emailOn = await emailEnabled(env);
  const requiresApproval = (settings.registration_requires_approval ?? '1') !== '0';

  if (request.method === 'GET') {
    if (url.searchParams.get('success') === '1') {
      // Confirmation copy depends on whether we emailed a verification link and
      // whether approval is required.
      const { title, body } = emailOn
        ? { title: 'Check your email', body: `<p>Thanks for registering! We've sent you a verification link — click it within 24 hours to verify your address.</p><p class="muted">${requiresApproval ? 'Once verified, your account will be reviewed by the site team before you can log in.' : 'Once verified, you can log in straight away.'}</p>` }
        : requiresApproval
          ? { title: 'Registration received', body: `<p>Thanks for registering! Your account is now awaiting approval by the site team — you'll be able to log in once it's approved.</p>` }
          : { title: 'Account created', body: `<p>Thanks for registering! Your account is ready — you can <a href="/reader/login">log in</a> now.</p>` };
      return readerPage(request, env, url, { title, content: narrow(`<h1>${escapeHtml(title)}</h1>${body}`) });
    }
    const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
    if (reader) return redirect('/reader/dashboard');
    return readerPage(request, env, url, { title: 'Register', content: narrow(registerFormHtml()) });
  }

  const form = await request.formData();
  const username = String(form.get('username') || '').trim();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const password = String(form.get('password') || '');

  const bad = (error) => readerPage(request, env, url, { title: 'Register', content: narrow(registerFormHtml({ error, username, email })) });

  if (!username || username.length < 2) return bad('Please choose a username (at least 2 characters).');
  if (!email.includes('@')) return bad('Please enter a valid email address.');
  if (password.length < 8) return bad('Password must be at least 8 characters.');

  const [existEmail, existUser] = await Promise.all([
    DB.prepare('SELECT id FROM reader_accounts WHERE email = ?').bind(email).first(),
    DB.prepare('SELECT id FROM reader_accounts WHERE username = ?').bind(username).first(),
  ]);
  if (existEmail) return bad('That email is already registered.');
  if (existUser) return bad('That username is already taken.');

  const passwordHash = await hashPassword(password);
  const siteName = await getSiteName(env);
  const siteUrl = env.SITE_URL || '';

  if (emailOn) {
    const { token, expires } = generateVerificationToken();
    const inserted = await DB.prepare(
      `INSERT INTO reader_accounts (username, email, password_hash, status, email_verified, verification_token, verification_expires)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`
    ).bind(username, email, passwordHash, token, expires).run();
    await logReaderActivity(DB, inserted.meta?.last_row_id, 'registered', email);
    await sendTemplatedEmail(env, 'verify_email', email, {
      site_name: siteName,
      username,
      link: `${siteUrl}/reader/verify?token=${token}`,
    });
    await notifyAdmins(env, 'notify_new_registration', 'admin_new_registration', {
      site_name: siteName,
      username,
      email,
      status_line: 'They have just registered; a verification email has been sent to them.',
      link: `${siteUrl}/admin/readers`,
    });
    return redirect('/reader/register?success=1');
  }

  // No-email mode: there's no way to deliver a verification link, so skip that
  // step (mark verified) and keep the admin-approval gate as the anti-spam
  // check. If approval is off, the account is usable immediately.
  const status = requiresApproval ? 'pending' : 'approved';
  const inserted = await DB.prepare(
    `INSERT INTO reader_accounts (username, email, password_hash, status, email_verified, verification_token, verification_expires)
     VALUES (?, ?, ?, ?, 1, NULL, NULL)`
  ).bind(username, email, passwordHash, status).run();
  await logReaderActivity(DB, inserted.meta?.last_row_id, 'registered', email);
  await notifyAdmins(env, 'notify_new_registration', 'admin_new_registration', {
    site_name: siteName,
    username,
    email,
    status_line: requiresApproval ? 'They are awaiting your approval.' : 'Their account is active.',
    link: `${siteUrl}/admin/readers`,
  });
  return redirect('/reader/register?success=1');
}

// ── Email verification ───────────────────────────────────────────────────────

async function verify(request, env, url) {
  const DB = env.DB;
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return redirect('/reader/login?error=invalid_token');

  const reader = await DB.prepare(
    'SELECT id, username, email, status, verification_expires FROM reader_accounts WHERE verification_token = ?'
  ).bind(token).first();
  if (!reader) return redirect('/reader/login?error=invalid_token');
  if (reader.verification_expires && new Date(reader.verification_expires) < new Date()) {
    return redirect('/reader/login?error=token_expired');
  }

  await DB.prepare(
    'UPDATE reader_accounts SET email_verified = 1, verification_token = NULL, verification_expires = NULL WHERE id = ?'
  ).bind(reader.id).run();
  await logReaderActivity(DB, reader.id, 'verified email', reader.email);

  const siteName = await getSiteName(env);
  const siteUrl = env.SITE_URL || '';
  const settings = await DB.prepare(`SELECT value FROM site_settings WHERE key = 'registration_requires_approval'`).first();
  const requiresApproval = (settings?.value ?? '1') !== '0';

  if (!requiresApproval && reader.status === 'pending') {
    // Approval switched off: verified accounts go live immediately.
    await DB.prepare(`UPDATE reader_accounts SET status = 'approved' WHERE id = ?`).bind(reader.id).run();
    await sendTemplatedEmail(env, 'account_approved', reader.email, {
      site_name: siteName,
      username: reader.username,
      link: `${siteUrl}/reader/login`,
    });
    return redirect('/reader/login?verified=1&approved=1');
  }

  // Still pending: tell the admins there's an account ready to review.
  await notifyAdmins(env, 'notify_new_registration', 'admin_new_registration', {
    site_name: siteName,
    username: reader.username,
    email: reader.email,
    status_line: 'They have verified their email and are awaiting your approval.',
    link: `${siteUrl}/admin/readers`,
  });
  return redirect('/reader/login?verified=1');
}

// ── Login / logout ───────────────────────────────────────────────────────────

function loginFormHtml({ error = '', notice = '', email = '', showRegister = true, showForgot = true } = {}) {
  return `
    <h1>Reader login</h1>
    ${notice ? `<div class="notice notice-green">${escapeHtml(notice)}</div>` : ''}
    ${error ? `<div class="notice notice-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/reader/login">
      <div class="field"><label for="email">Email</label>
        <input type="email" id="email" name="email" value="${escapeAttr(email)}" required autofocus autocomplete="username"></div>
      <div class="field"><label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password"></div>
      <button class="btn" type="submit">Log in</button>
      ${showForgot ? `<p class="small muted" style="margin-top:1rem"><a href="/reader/forgot">Forgot your password?</a></p>` : ''}
      ${showRegister
        ? `<p class="small muted">No account yet? <a href="/reader/register">Register</a></p>`
        : `<p class="small muted">New user account registrations currently disabled</p>`}
    </form>`;
}

async function login(request, env, url) {
  const DB = env.DB;
  const { settings } = await loadChrome(env, url);
  const showRegister = (settings.self_registration ?? '1') !== '0';
  const showForgot = await emailEnabled(env); // no email = no self-service reset

  if (request.method === 'GET') {
    const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
    if (reader) return redirect('/reader/dashboard');
    let error = '', notice = '';
    const err = url.searchParams.get('error');
    if (err === 'invalid_token') error = 'That verification link is invalid or has already been used.';
    if (err === 'token_expired') error = 'That verification link has expired. Please register again.';
    if (url.searchParams.get('verified') === '1') {
      notice = url.searchParams.get('approved') === '1'
        ? 'Email verified — your account is active. You can log in now.'
        : 'Email verified! Your account is now awaiting approval by the site team.';
    }
    if (url.searchParams.get('reset') === '1') notice = 'Your password has been reset — please log in with your new password.';
    return readerPage(request, env, url, { title: 'Log in', content: narrow(loginFormHtml({ error, notice, showRegister, showForgot })) });
  }

  const ip = clientIp(request);
  const form = await request.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const password = String(form.get('password') || '');

  const bad = (error, status = 401) => readerPage(request, env, url, { title: 'Log in', content: narrow(loginFormHtml({ error, email, showRegister, showForgot })), status });

  if (await isLockedOut(DB, ip)) {
    return bad('Too many failed attempts. Try again in 15 minutes.', 429);
  }

  const reader = email
    ? await DB.prepare('SELECT * FROM reader_accounts WHERE email = ?').bind(email).first()
    : null;
  const ok = reader && await verifyPassword(password, reader.password_hash);
  if (!ok) {
    await recordLoginFailure(DB, ip);
    return bad('Invalid email or password.');
  }

  // Only approved accounts get sessions; explain the state to everyone else.
  if (reader.status === 'pending') {
    return bad(reader.email_verified
      ? 'Your account is awaiting approval by the site team.'
      : 'Please verify your email first — check your inbox for the verification link.', 403);
  }
  if (reader.status === 'rejected') {
    return bad('Your account registration was not approved. Contact the site owner if you think this is a mistake.', 403);
  }

  await clearLoginFailures(DB, ip);
  await DB.prepare(`UPDATE reader_accounts SET last_login = datetime('now') WHERE id = ?`).bind(reader.id).run();
  const { cookieHeader } = await createReaderSession(DB, reader.id, env.READER_SESSION_SECRET);
  await logReaderActivity(DB, reader.id, 'logged in');
  return redirect('/reader/dashboard', { 'Set-Cookie': cookieHeader });
}

// ── Forgot / reset password ────────────────────────────────────────────────

function forgotFormHtml({ error = '' } = {}) {
  return `
    <h1>Reset your password</h1>
    <p class="muted">Enter your account email and we'll send you a link to reset your password.</p>
    ${error ? `<div class="notice notice-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/reader/forgot">
      <div class="field"><label for="email">Email</label>
        <input type="email" id="email" name="email" required autofocus autocomplete="username"></div>
      <button class="btn" type="submit">Send reset link</button>
      <p class="small muted" style="margin-top:1rem"><a href="/reader/login">Back to log in</a></p>
    </form>`;
}

// Always shows the same confirmation, whether or not the email had an account,
// so the form can't reveal which addresses are registered.
async function forgot(request, env, url) {
  const DB = env.DB;
  // No-email mode: there's no way to send a reset link, so point readers at an
  // admin (who can set a new password from Admin → Readers).
  if (!(await emailEnabled(env))) {
    return readerPage(request, env, url, {
      title: 'Reset password',
      content: narrow(`<h1>Reset your password</h1>
        <div class="notice">Password resets by email aren't available on this site. Please contact an administrator, who can set a new password for your account.</div>
        <p class="small muted"><a href="/reader/login">Back to log in</a></p>`),
    });
  }
  if (request.method !== 'POST') {
    return readerPage(request, env, url, { title: 'Reset password', content: narrow(forgotFormHtml()) });
  }
  const form = await request.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();
  if (email) {
    const reader = await DB.prepare('SELECT * FROM reader_accounts WHERE email = ?').bind(email).first();
    // Only approved accounts can reset — pending/rejected have no usable login.
    if (reader && reader.status === 'approved') {
      const { token, expires } = generateResetToken();
      await DB.prepare('UPDATE reader_accounts SET reset_token = ?, reset_expires = ? WHERE id = ?')
        .bind(token, expires, reader.id).run();
      await sendTemplatedEmail(env, 'reset_password', reader.email, {
        site_name: await getSiteName(env),
        name: reader.username,
        link: `${env.SITE_URL || ''}/reader/reset?token=${token}`,
      });
      await logReaderActivity(DB, reader.id, 'requested a password reset');
    }
  }
  return readerPage(request, env, url, {
    title: 'Reset password',
    content: narrow(`<h1>Check your email</h1>
      <div class="notice notice-green">If an account exists for that email, we've sent a link to reset its password. The link expires in 1 hour.</div>
      <p class="small muted"><a href="/reader/login">Back to log in</a></p>`),
  });
}

async function readerByResetToken(DB, token) {
  if (!token) return null;
  const reader = await DB.prepare('SELECT * FROM reader_accounts WHERE reset_token = ?').bind(token).first();
  if (!reader || reader.status !== 'approved') return null;
  if (!reader.reset_expires || new Date(reader.reset_expires) < new Date()) return null;
  return reader;
}

function resetFormHtml({ token = '', error = '' } = {}) {
  return `
    <h1>Choose a new password</h1>
    ${error ? `<div class="notice notice-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/reader/reset">
      <input type="hidden" name="token" value="${escapeAttr(token)}">
      <div class="field"><label for="password">New password</label>
        <input type="password" id="password" name="password" required minlength="8" autofocus autocomplete="new-password">
        <p class="hint">At least 8 characters.</p></div>
      <div class="field"><label for="confirm">Confirm new password</label>
        <input type="password" id="confirm" name="confirm" required minlength="8" autocomplete="new-password"></div>
      <button class="btn" type="submit">Set new password</button>
    </form>`;
}

const resetInvalidHtml = `<h1>Reset link invalid</h1>
  <div class="notice notice-error">This reset link is invalid or has expired.</div>
  <p class="small muted"><a href="/reader/forgot">Request a new link</a></p>`;

async function reset(request, env, url) {
  const DB = env.DB;
  if (request.method !== 'POST') {
    const token = (url.searchParams.get('token') || '').trim();
    const reader = await readerByResetToken(DB, token);
    if (!reader) return readerPage(request, env, url, { title: 'Reset password', content: narrow(resetInvalidHtml), status: 400 });
    return readerPage(request, env, url, { title: 'Reset password', content: narrow(resetFormHtml({ token })) });
  }

  const form = await request.formData();
  const token = String(form.get('token') || '').trim();
  const password = String(form.get('password') || '');
  const confirm = String(form.get('confirm') || '');

  const reader = await readerByResetToken(DB, token);
  if (!reader) return readerPage(request, env, url, { title: 'Reset password', content: narrow(resetInvalidHtml), status: 400 });
  const bad = (error) => readerPage(request, env, url, { title: 'Reset password', content: narrow(resetFormHtml({ token, error })), status: 400 });
  if (password.length < 8) return bad('Password must be at least 8 characters.');
  if (password !== confirm) return bad('The two passwords do not match.');

  const hash = await hashPassword(password);
  // New password, burn the token, and drop existing sessions.
  await DB.prepare('UPDATE reader_accounts SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?')
    .bind(hash, reader.id).run();
  await DB.prepare('DELETE FROM reader_sessions WHERE reader_account_id = ?').bind(reader.id).run();
  await logReaderActivity(DB, reader.id, 'reset password');
  return redirect('/reader/login?reset=1');
}

// ── Dashboard ────────────────────────────────────────────────────────────────

async function dashboard(request, env, url) {
  const DB = env.DB;
  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  if (!reader) return redirect('/reader/login');

  const [subscribed, { results: comments = [] }, { results: replies = [] }] = await Promise.all([
    DB.prepare('SELECT 1 AS x FROM blog_subscriptions WHERE reader_account_id = ?').bind(reader.id).first(),
    DB.prepare(
      `SELECT c.id, c.body, c.body_format, c.status, c.created_at, c.edited_at, a.title, a.slug, a.category
       FROM comments c JOIN articles a ON a.id = c.article_id
       WHERE c.reader_account_id = ? ORDER BY c.created_at DESC LIMIT 100`
    ).bind(reader.id).all(),
    DB.prepare(
      `SELECT p.id, p.comment_id, p.body, p.body_format, p.status, p.created_at, a.title, a.slug, a.category
       FROM comment_replies p
       JOIN comments c ON c.id = p.comment_id
       JOIN articles a ON a.id = c.article_id
       WHERE p.reader_account_id = ? ORDER BY p.created_at DESC LIMIT 100`
    ).bind(reader.id).all(),
  ]);

  let notice = '';
  if (url.searchParams.get('subscribed') === '1') notice = '<div class="notice notice-green">You\'re now subscribed to new articles.</div>';
  if (url.searchParams.get('unsubscribed') === '1') notice = '<div class="notice">You\'ve been unsubscribed from new-article emails.</div>';
  if (url.searchParams.get('edited') === '1') notice = '<div class="notice notice-green">Comment updated — it has been sent back for re-moderation.</div>';
  if (url.searchParams.get('deleted') === '1') notice = '<div class="notice">Deleted.</div>';

  const subCard = subscribed
    ? `<p>You're <strong>subscribed</strong> to the blog — you'll get an email when a new article goes live.</p>
       <form method="post" action="/api/unsubscribe"><button class="btn btn-secondary btn-small" type="submit">Unsubscribe</button></form>`
    : `<p>You're <strong>not subscribed</strong> to the blog. Subscribe to get an email when a new article is published.</p>
       <form method="post" action="/api/subscribe"><button class="btn btn-small" type="submit">Subscribe</button></form>`;

  // Show a plain-text preview: HTML bodies are flattened via commentToText so
  // raw markup doesn't clutter the table; plain bodies are shown as stored.
  const excerpt = (row) => {
    const text = row.body_format === 'html' ? commentToText(row.body) : String(row.body || '');
    return escapeHtml(text.length > 120 ? text.slice(0, 120) + '…' : text);
  };
  const deleteBtn = (action, what) =>
    `<form method="post" action="${escapeAttr(action)}" style="display:inline" onsubmit="return confirm('Delete this ${what}? This cannot be undone.')">
       <button class="btn btn-secondary btn-small" type="submit">Delete</button></form>`;

  const commentsHtml = comments.length
    ? `<table class="reader-table">
        <thead><tr><th>Article</th><th>Comment</th><th>Status</th><th>Posted</th><th></th></tr></thead>
        <tbody>${comments.map((c) => `
          <tr>
            <td><a href="${escapeAttr(articlePath(c))}#comment-${c.id}">${escapeHtml(c.title)}</a></td>
            <td class="comment-excerpt">${excerpt(c)}${c.edited_at ? ' <span class="muted small">(edited)</span>' : ''}</td>
            <td><span class="status-pill ${escapeAttr(c.status)}">${escapeHtml(c.status)}</span></td>
            <td class="muted small">${escapeHtml(formatDate(c.created_at))}</td>
            <td><div class="own-actions">
              ${c.status !== 'rejected' ? `<a class="btn btn-secondary btn-small" href="/reader/comments/${c.id}/edit">Edit</a>` : ''}
              ${deleteBtn(`/reader/comments/${c.id}/delete`, 'comment')}
            </div></td>
          </tr>`).join('')}
        </tbody></table>`
    : '<p class="muted">You haven\'t commented yet.</p>';

  const repliesHtml = replies.length
    ? `<h2>Your replies</h2>
      <table class="reader-table">
        <thead><tr><th>Article</th><th>Reply</th><th>Status</th><th>Posted</th><th></th></tr></thead>
        <tbody>${replies.map((r) => `
          <tr>
            <td><a href="${escapeAttr(articlePath(r))}#comment-${r.comment_id}">${escapeHtml(r.title)}</a></td>
            <td class="comment-excerpt">${excerpt(r)}</td>
            <td><span class="status-pill ${escapeAttr(r.status)}">${escapeHtml(r.status)}</span></td>
            <td class="muted small">${escapeHtml(formatDate(r.created_at))}</td>
            <td><div class="own-actions">${deleteBtn(`/reader/replies/${r.id}/delete`, 'reply')}</div></td>
          </tr>`).join('')}
        </tbody></table>`
    : '';

  const content = `
    <section class="section"><div class="container">
      <div class="reader-head">
        <h1>Hi, ${escapeHtml(reader.username)}</h1>
        <div><a class="btn btn-secondary btn-small" href="/reader/settings">Settings</a>
        <a class="btn btn-secondary btn-small" href="/reader/logout">Log out</a></div>
      </div>
      ${notice}
      <div class="card" style="margin-bottom:1.5rem"><h3>Blog subscription</h3>${subCard}</div>
      <h2>Your comments</h2>
      <p class="muted small">Comments are shown to other readers once approved by the site team. Editing a comment sends it back for re-moderation.</p>
      ${commentsHtml}
      ${repliesHtml}
    </div></section>`;

  return readerPage(request, env, url, { title: 'Your account', content });
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function getPrefs(DB, readerId) {
  // Missing preference row = enabled.
  const prefs = { new_article: true, comment_reply: true, comment_moderated: true };
  const { results } = await DB.prepare(
    'SELECT type, email_enabled FROM notification_preferences WHERE reader_account_id = ?'
  ).bind(readerId).all();
  for (const row of results || []) {
    if (row.type in prefs) prefs[row.type] = !!row.email_enabled;
  }
  return prefs;
}

async function settings(request, env, url) {
  const DB = env.DB;
  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  if (!reader) return redirect('/reader/login');

  const prefs = await getPrefs(DB, reader.id);

  const flash = {
    password: '<div class="notice notice-green">Password updated.</div>',
    notifications: '<div class="notice notice-green">Notification preferences saved.</div>',
  }[url.searchParams.get('success')] || '';
  const errorFlash = {
    wrong_password: '<div class="notice notice-error">Your current password was incorrect.</div>',
    password_short: '<div class="notice notice-error">New password must be at least 8 characters.</div>',
    password_mismatch: '<div class="notice notice-error">New passwords did not match.</div>',
  }[url.searchParams.get('error')] || '';

  const content = `
    <section class="section"><div class="container"><div class="reader-card">
      <p><a href="/reader/dashboard">← Back to your account</a></p>
      <h1>Settings</h1>
      ${flash}${errorFlash}
      <p class="muted small">Logged in as <strong>${escapeHtml(reader.username)}</strong> (${escapeHtml(reader.email)})</p>

      <h2>Email notifications</h2>
      <form method="post" action="/reader/settings/notifications">
        ${NOTIF_TYPES.map(({ type, label }) => `
          <div class="field checkbox-field">
            <label><input type="checkbox" name="${escapeAttr(type)}"${prefs[type] ? ' checked' : ''}> ${escapeHtml(label)}</label>
          </div>`).join('')}
        <button class="btn btn-small" type="submit">Save preferences</button>
      </form>

      <hr>
      <h2>Change password</h2>
      <form method="post" action="/reader/settings/password">
        <div class="field"><label for="current_password">Current password</label>
          <input type="password" id="current_password" name="current_password" required autocomplete="current-password"></div>
        <div class="field"><label for="new_password">New password</label>
          <input type="password" id="new_password" name="new_password" required minlength="8" autocomplete="new-password"></div>
        <div class="field"><label for="confirm_password">Confirm new password</label>
          <input type="password" id="confirm_password" name="confirm_password" required autocomplete="new-password"></div>
        <button class="btn btn-small" type="submit">Change password</button>
      </form>
    </div></div></section>`;

  return readerPage(request, env, url, { title: 'Settings', content });
}

async function changePassword(request, env) {
  const DB = env.DB;
  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  if (!reader) return redirect('/reader/login');

  const form = await request.formData();
  const current = String(form.get('current_password') || '');
  const next = String(form.get('new_password') || '');
  const confirm = String(form.get('confirm_password') || '');

  const row = await DB.prepare('SELECT password_hash FROM reader_accounts WHERE id = ?').bind(reader.id).first();
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    return redirect('/reader/settings?error=wrong_password');
  }
  if (next.length < 8) return redirect('/reader/settings?error=password_short');
  if (next !== confirm) return redirect('/reader/settings?error=password_mismatch');

  await DB.prepare('UPDATE reader_accounts SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(next), reader.id).run();
  await logReaderActivity(DB, reader.id, 'changed password');
  return redirect('/reader/settings?success=password');
}

async function saveNotifications(request, env) {
  const DB = env.DB;
  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  if (!reader) return redirect('/reader/login');

  const form = await request.formData();
  const enabledTypes = [];
  for (const { type } of NOTIF_TYPES) {
    const enabled = form.has(type) ? 1 : 0;
    if (enabled) enabledTypes.push(type.replaceAll('_', ' '));
    await DB.prepare(
      `INSERT INTO notification_preferences (reader_account_id, type, email_enabled) VALUES (?, ?, ?)
       ON CONFLICT(reader_account_id, type) DO UPDATE SET email_enabled = ?`
    ).bind(reader.id, type, enabled, enabled).run();
  }
  await logReaderActivity(DB, reader.id, 'updated notification preferences',
    enabledTypes.length ? `on: ${enabledTypes.join(', ')}` : 'all off');
  return redirect('/reader/settings?success=notifications');
}

// ── Own-comment management ───────────────────────────────────────────────────
// Readers can edit or delete their own comments. Editing sends the comment
// back to 'pending' for re-moderation (mirrors the writing project); rejected
// comments can only be deleted, not edited.

async function editComment(request, env, url, commentId) {
  const DB = env.DB;
  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  if (!reader) return redirect('/reader/login');

  // Ownership is enforced in the query, not just the UI.
  const comment = await DB.prepare(
    `SELECT c.id, c.body, c.body_format, c.status, a.title AS article_title
     FROM comments c JOIN articles a ON a.id = c.article_id
     WHERE c.id = ? AND c.reader_account_id = ?`
  ).bind(commentId, reader.id).first();
  if (!comment || comment.status === 'rejected') return redirect('/reader/dashboard');

  if (request.method === 'GET') {
    // The editor reads the textarea value as innerHTML: an html body is already
    // sanitised so it goes in raw; a legacy plain-text body is escaped so its
    // characters show literally and the editor treats it as text.
    const seed = comment.body_format === 'html' ? String(comment.body || '') : escapeHtml(comment.body);
    const content = narrow(`
      <p><a href="/reader/dashboard">← Back to your account</a></p>
      <h1>Edit comment</h1>
      <p class="muted small">On <strong>${escapeHtml(comment.article_title)}</strong>. Saving sends your comment back for re-moderation before it reappears.</p>
      <form method="post" action="/reader/comments/${comment.id}/edit">
        <div class="field"><label for="body">Comment</label>
          <textarea id="body" name="body" required data-richtext data-rt-mode="comment">${seed}</textarea></div>
        <button class="btn" type="submit">Save changes</button>
        <a class="btn btn-secondary" href="/reader/dashboard">Cancel</a>
      </form>`);
    return readerPage(request, env, url, { title: 'Edit comment', content, extraHead: EDITOR_HEAD });
  }

  const form = await request.formData();
  const body = String(form.get('body') || '').trim();
  if (!body) return redirect(`/reader/comments/${commentId}/edit`);

  // Reader edits are rich HTML: sanitise on write and store body_format='html'.
  const storedBody = sanitizeCommentHtml(body);
  if (!storedBody) return redirect(`/reader/comments/${commentId}/edit`);

  await DB.prepare(
    `UPDATE comments SET body = ?, body_format = 'html', edited_at = datetime('now'), status = 'pending', moderated_at = NULL
     WHERE id = ? AND reader_account_id = ?`
  ).bind(storedBody, commentId, reader.id).run();
  await logReaderActivity(DB, reader.id, 'edited comment', comment.article_title);
  return redirect('/reader/dashboard?edited=1');
}

async function deleteOwnComment(request, env, commentId) {
  const DB = env.DB;
  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  if (!reader) return redirect('/reader/login');

  // Fetch the article title for the activity trail before the row goes.
  const comment = await DB.prepare(
    `SELECT a.title FROM comments c JOIN articles a ON a.id = c.article_id
     WHERE c.id = ? AND c.reader_account_id = ?`
  ).bind(commentId, reader.id).first();

  // Replies are removed by the comment_replies FK cascade.
  await DB.prepare('DELETE FROM comments WHERE id = ? AND reader_account_id = ?')
    .bind(commentId, reader.id).run();
  if (comment) await logReaderActivity(DB, reader.id, 'deleted comment', comment.title);
  return redirect('/reader/dashboard?deleted=1');
}

async function deleteOwnReply(request, env, replyId) {
  const DB = env.DB;
  const reader = await getReaderSession(request, DB, env.READER_SESSION_SECRET);
  if (!reader) return redirect('/reader/login');

  // Fetch the article title for the activity trail before the row goes.
  const reply = await DB.prepare(
    `SELECT a.title FROM comment_replies p
     JOIN comments c ON c.id = p.comment_id JOIN articles a ON a.id = c.article_id
     WHERE p.id = ? AND p.reader_account_id = ? AND p.staff_reply = 0`
  ).bind(replyId, reader.id).first();

  // staff_reply = 0 guard: staff replies are never reader-owned.
  await DB.prepare('DELETE FROM comment_replies WHERE id = ? AND reader_account_id = ? AND staff_reply = 0')
    .bind(replyId, reader.id).run();
  if (reply) await logReaderActivity(DB, reader.id, 'deleted reply', reply.title);
  return redirect('/reader/dashboard?deleted=1');
}
