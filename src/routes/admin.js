// Admin routes: /admin/* — auth gate, login/logout, dashboard, and the
// dispatcher that hands each section to its feature module.

import {
  getSession, createSession, destroySession, clearSessionCookie,
  verifyPassword, hashPassword, clientIp, isLockedOut, recordLoginFailure, clearLoginFailures,
  generateResetToken,
} from '../auth.js';
import { getUserByEmail, touchLastLogin, getDashboardStats, logActivity, getBranding } from '../db.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { sendTemplatedEmail, getSiteName, emailEnabled } from '../email.js';
import { adminPage, adminLoginPage, adminForgotPage, adminResetPage, adminSetupPage, escapeHtml, redirect, html } from '../templates/base.js';

import { handlePages } from './admin-pages.js';
import { handleArticles } from './admin-articles.js';
import { handleTags } from './admin-tags.js';
import { handleCategories } from './admin-categories.js';
import { handleSeries } from './admin-series.js';
import { handlePeople } from './admin-people.js';
import { handleMedia } from './admin-media.js';
import { handleUsers } from './admin-users.js';
import { handleComments } from './admin-comments.js';
import { handleCorrections } from './admin-corrections.js';
import { handleReaders } from './admin-readers.js';
import {
  handleBranding, handlePalette, handleFonts,
  handleNavigation, handleFooter, handleSettings, handleEmails,
} from './admin-branding.js';
import { handleEmoticons } from './admin-emoticons.js';

// section name (first path segment after /admin/) → handler
const SECTIONS = {
  pages: handlePages,
  articles: handleArticles,
  categories: handleCategories,
  series: handleSeries,
  tags: handleTags,
  people: handlePeople,
  media: handleMedia,
  users: handleUsers,
  comments: handleComments,
  corrections: handleCorrections,
  readers: handleReaders,
  branding: handleBranding,
  palette: handlePalette,
  emoticons: handleEmoticons,
  fonts: handleFonts,
  navigation: handleNavigation,
  footer: handleFooter,
  settings: handleSettings,
  emails: handleEmails,
};

export async function handleAdmin(request, env, url) {
  const path = url.pathname.replace(/\/$/, '') || '/admin';
  const DB = env.DB;
  const branding = await getBranding(env); // name + logo for admin chrome / cards
  const emailOn = await emailEnabled(env); // gates the email-based password reset

  // First run: with no CMS users yet, the only thing you can do is create the
  // first admin. Setup is served ONLY while the users table is empty.
  if (path === '/admin/setup') return handleSetup(request, env, branding);

  // Login + forgot/reset password are the only other unauthenticated routes.
  if (path === '/admin/login') {
    if (await noUsers(DB)) return redirect('/admin/setup');
    if (request.method === 'POST') return handleLogin(request, env, branding, emailOn);
    const notice = url.searchParams.get('reset') === '1'
      ? 'Your password has been reset — please log in with your new password.' : '';
    return html(adminLoginPage({ notice, branding, showForgot: emailOn }));
  }
  if (path === '/admin/forgot') {
    // No-email mode: email-based reset can't work. Another admin can reset a
    // password from Admin → Users, so send them there instead.
    if (!emailOn) {
      return html(adminForgotPage({ branding, unavailable: true }));
    }
    if (request.method === 'POST') return handleForgot(request, env, branding);
    return html(adminForgotPage({ branding }));
  }
  if (path === '/admin/reset') {
    if (request.method === 'POST') return handleReset(request, env, branding);
    return handleResetForm(request, env, url, branding);
  }

  const user = await getSession(request, DB, env.ADMIN_SESSION_SECRET);
  if (!user) return redirect(await noUsers(DB) ? '/admin/setup' : '/admin/login');
  user.branding = branding; // adminPage reads this for the wordmark/logo

  if (path === '/admin/logout') {
    await destroySession(DB, user.sessionId);
    return redirect('/admin/login', { 'Set-Cookie': clearSessionCookie() });
  }

  if (path === '/admin') return dashboard(env, user, url);

  // Moderation-queue counts for the sidebar badges (fetched by admin-nav.js).
  if (path === '/admin/badges.json') {
    const count = async (sql) => {
      try { return (await DB.prepare(sql).first())?.n ?? 0; } catch { return 0; }
    };
    return new Response(JSON.stringify({
      comments: await count(`SELECT COUNT(*) n FROM comments WHERE status = 'pending'`)
        + await count(`SELECT COUNT(*) n FROM comment_replies WHERE status = 'pending' AND staff_reply = 0`),
      corrections: await count(`SELECT COUNT(*) n FROM corrections WHERE status = 'open'`),
      readers: await count(`SELECT COUNT(*) n FROM reader_accounts WHERE status = 'pending' AND email_verified = 1`),
    }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  const section = path.split('/')[2];
  const handler = SECTIONS[section];
  if (handler) {
    const res = await handler(request, env, url, user);
    if (res) return res;
  }

  return html(adminPage({
    env, user, title: 'Not found', path,
    content: `<h1>Not found</h1><p class="muted">No admin page at <code>${escapeHtml(path)}</code>.</p>`,
  }), { status: 404 });
}

// Create the first admin account. Reachable only while the users table is empty
// (handleAdmin gates it); once any user exists, setup is closed.
async function handleSetup(request, env, branding) {
  const DB = env.DB;
  if (!(await noUsers(DB))) return redirect('/admin/login'); // already set up
  if (request.method !== 'POST') return html(adminSetupPage({ branding }));

  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const password = String(form.get('password') || '');
  if (!name || !email || password.length < 8) {
    return html(adminSetupPage({ error: 'Enter a name, a valid email, and a password of at least 8 characters.', name, email, branding }), { status: 400 });
  }

  const hash = await hashPassword(password);
  let userId;
  try {
    const res = await DB.prepare(
      `INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)`
    ).bind(email, name, hash).run();
    userId = res.meta.last_row_id;
  } catch {
    return html(adminSetupPage({ error: 'Could not create that account — an admin may already exist. Try logging in.', name, email, branding }), { status: 400 });
  }
  await logActivity(DB, { id: userId, name }, 'created', 'first admin account', email);
  const { cookieHeader } = await createSession(DB, userId, env.ADMIN_SESSION_SECRET);
  return redirect('/admin', { 'Set-Cookie': cookieHeader });
}

// True when there are no CMS users (fresh install). Fails safe to false so a
// broken/absent table never traps the admin in the setup screen.
async function noUsers(DB) {
  try {
    const row = await DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return (row?.n ?? 0) === 0;
  } catch {
    return false;
  }
}

async function handleLogin(request, env, branding, showForgot) {
  const DB = env.DB;
  const ip = clientIp(request);
  const form = await request.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const password = String(form.get('password') || '');

  if (await isLockedOut(DB, ip)) {
    return html(adminLoginPage({ error: 'Too many failed attempts. Try again in 15 minutes.', email, branding, showForgot }), { status: 429 });
  }

  const user = email ? await getUserByEmail(DB, email) : null;
  const ok = user && user.active && await verifyPassword(password, user.password_hash);
  if (!ok) {
    await recordLoginFailure(DB, ip);
    return html(adminLoginPage({ error: 'Invalid email or password.', email, branding, showForgot }), { status: 401 });
  }

  await clearLoginFailures(DB, ip);
  await touchLastLogin(DB, user.id);
  const { cookieHeader } = await createSession(DB, user.id, env.ADMIN_SESSION_SECRET);
  await logActivity(DB, { id: user.id, name: user.name }, 'logged in', 'session', user.email);
  return redirect('/admin', { 'Set-Cookie': cookieHeader });
}

// Forgot password: email a reset link if the account exists. The response is
// always the same generic confirmation so the form can't reveal which emails
// have accounts.
async function handleForgot(request, env, branding) {
  const DB = env.DB;
  const form = await request.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();
  if (email) {
    const user = await getUserByEmail(DB, email);
    if (user && user.active) {
      const { token, expires } = generateResetToken();
      await DB.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?')
        .bind(token, expires, user.id).run();
      await sendTemplatedEmail(env, 'reset_password', user.email, {
        site_name: await getSiteName(env),
        name: user.name,
        link: `${env.SITE_URL || ''}/admin/reset?token=${token}`,
      });
      await logActivity(DB, { id: user.id, name: user.name }, 'requested a password reset', 'session', user.email);
    }
  }
  return html(adminForgotPage({ sent: true, branding }));
}

// Look up a reset token and confirm it's unexpired.
async function userByResetToken(DB, token) {
  if (!token) return null;
  const user = await DB.prepare('SELECT * FROM users WHERE reset_token = ?').bind(token).first();
  if (!user || !user.active) return null;
  if (!user.reset_expires || new Date(user.reset_expires) < new Date()) return null;
  return user;
}

async function handleResetForm(request, env, url, branding) {
  const token = (url.searchParams.get('token') || '').trim();
  const user = await userByResetToken(env.DB, token);
  if (!user) return html(adminResetPage({ invalid: true, branding }), { status: 400 });
  return html(adminResetPage({ token, branding }));
}

async function handleReset(request, env, branding) {
  const DB = env.DB;
  const form = await request.formData();
  const token = String(form.get('token') || '').trim();
  const password = String(form.get('password') || '');
  const confirm = String(form.get('confirm') || '');

  const user = await userByResetToken(DB, token);
  if (!user) return html(adminResetPage({ invalid: true, branding }), { status: 400 });
  if (password.length < 8) return html(adminResetPage({ token, error: 'Password must be at least 8 characters.', branding }), { status: 400 });
  if (password !== confirm) return html(adminResetPage({ token, error: 'The two passwords do not match.', branding }), { status: 400 });

  const hash = await hashPassword(password);
  // Set the new password, burn the token, and drop any existing sessions so an
  // attacker holding an old session is logged out.
  await DB.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?')
    .bind(hash, user.id).run();
  await DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
  await logActivity(DB, { id: user.id, name: user.name }, 'reset password', 'session', user.email);
  return redirect('/admin/login?reset=1');
}

async function dashboard(env, user, url) {
  const DB = env.DB;
  const stats = await getDashboardStats(DB);

  const pageSize = await getPageSize(DB, user, url);
  const page = currentPage(url);
  const total = (await DB.prepare('SELECT COUNT(*) n FROM activity_log').first())?.n ?? 0;
  const { results: activity = [] } = await DB.prepare(
    'SELECT * FROM activity_log ORDER BY id DESC LIMIT ? OFFSET ?'
  ).bind(pageSize, (page - 1) * pageSize).all();

  const stat = (num, label, href) =>
    `<a class="stat" href="${href}" style="text-decoration:none"><div class="num">${num}</div><div class="label">${escapeHtml(label)}</div></a>`;

  const activityHtml = activity.length
    ? activity.map((a) => `
        <div class="activity-item">
          <span class="when">${escapeHtml((a.created_at || '').slice(0, 16).replace('T', ' '))}</span>
          <span><strong>${escapeHtml(a.user_name || 'System')}</strong> ${escapeHtml(a.action)} ${escapeHtml(a.entity_type)}${a.entity_label ? ` — ${escapeHtml(a.entity_label)}` : ''}</span>
        </div>`).join('')
    : '<p class="muted">No activity yet.</p>';

  const content = `
    <div class="page-head"><h1>Dashboard</h1></div>
    <div class="dash-stats">
      ${stat(stats.pages, 'Pages', '/admin/pages')}
      ${stat(stats.articles, 'Articles', '/admin/articles')}
      ${stat(stats.people, 'People', '/admin/people')}
      ${stat(stats.pendingComments, 'Comments awaiting review', '/admin/comments')}
      ${stat(stats.openCorrections, 'Open corrections', '/admin/corrections')}
      ${stat(stats.pendingReaders, 'Readers awaiting approval', '/admin/readers')}
      ${stat(stats.readers, 'Approved readers', '/admin/readers')}
    </div>
    <h2>Recent activity</h2>
    ${activityHtml}
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: 'Dashboard', path: '/admin', content }));
}
