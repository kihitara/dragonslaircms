// Base HTML shells for the public site and the admin, plus shared helpers.

export function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeAttr(str) {
  return escapeHtml(str);
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Set data-theme before first paint so a saved choice doesn't flash.
const THEME_BOOT = `<script>try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>`;

function headHtml({ title, description, canonical, shareImage, favicon = '/icons/icon.svg', extraHead = '' }) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${description ? `<meta name="description" content="${escapeAttr(description)}">` : ''}
${canonical ? `<link rel="canonical" href="${escapeAttr(canonical)}">` : ''}
<meta property="og:title" content="${escapeAttr(title)}">
${description ? `<meta property="og:description" content="${escapeAttr(description)}">` : ''}
${shareImage ? `<meta property="og:image" content="${escapeAttr(shareImage)}">` : ''}
<link rel="icon" href="${escapeAttr(favicon)}">
${THEME_BOOT}
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/css/site.css">
${extraHead}`;
}

// ── Public site shell ────────────────────────────────────────────────────────

export function sitePage({ env, title, description, canonical, shareImage, nav = [], footer = null, siteSettings = {}, reader = null, bodyClass = '', content, extraHead = '' }) {
  const siteTitle = siteSettings.org_name || env.SITE_TITLE || 'My Site';
  const logo = siteSettings.logo_url || '/icons/icon.svg';
  // The SEO title template (Settings) composes per-page titles: %s is the page
  // title and the template usually embeds the site name itself. When it's set,
  // it wins; otherwise fall back to "<page> — <site>". A page with no title of
  // its own (e.g. the home page) always shows just the site title.
  const titleTemplate = (siteSettings.seo_title_template || '').trim();
  const fullTitle = !title
    ? siteTitle
    : (titleTemplate.includes('%s')
      ? titleTemplate.replace('%s', () => title) // fn replacer: no $-substitution in the title
      : `${title} — ${siteTitle}`);
  // Reader account link: their username (→ dashboard) when logged in, else a
  // Login link. Always shown — self-registration only gates NEW sign-ups.
  const readerLink = reader
    ? `<a class="site-account" href="/reader/dashboard">${escapeHtml(reader.username)}</a>`
    : `<a class="site-account" href="/reader/login">Login</a>`;
  // Items with children render as a dropdown (one level, per NAV_SCHEMA):
  // hover/focus opens on desktop, tap toggles on touch, inline list on mobile.
  const navHtml = nav.map((item) => {
    const kids = (Array.isArray(item.children) ? item.children : []).filter((c) => c && c.label);
    if (!kids.length) {
      return `<a href="${escapeAttr(item.href)}"${item.active ? ' class="active"' : ''}>${escapeHtml(item.label)}</a>`;
    }
    const toggle = item.href
      ? `<a class="nav-drop-toggle${item.active ? ' active' : ''}" href="${escapeAttr(item.href)}" aria-haspopup="true" aria-expanded="false">${escapeHtml(item.label)}<span class="nav-caret" aria-hidden="true">▾</span></a>`
      : `<button class="nav-drop-toggle${item.active ? ' active' : ''}" type="button" aria-haspopup="true" aria-expanded="false">${escapeHtml(item.label)}<span class="nav-caret" aria-hidden="true">▾</span></button>`;
    const menu = kids.map((c) =>
      `<a href="${escapeAttr(c.href)}">${escapeHtml(c.label)}</a>`
    ).join('');
    // Dropdowns always render closed — on every page, desktop and mobile. Only a
    // hover/click opens them (JS/CSS); navigating reloads the page, so a fresh
    // load is always closed. The active parent still gets .active for highlighting.
    return `<div class="nav-drop">${toggle}<div class="nav-drop-menu">${menu}</div></div>`;
  }).join('');

  const footerCols = (footer?.columns || []).map((col) => `
    <div>
      <h4>${escapeHtml(col.title || '')}</h4>
      <ul>${(col.links || []).map((l) => `<li><a href="${escapeAttr(l.href)}">${escapeHtml(l.label)}</a></li>`).join('')}</ul>
    </div>`).join('');

  // RSS autodiscovery — public pages only (this shell), so feed readers and
  // browsers can find /feed.xml from any page.
  const feedLink = `<link rel="alternate" type="application/rss+xml" title="${escapeAttr(siteTitle)} — RSS" href="/feed.xml">`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
${headHtml({ title: fullTitle, description, canonical, shareImage, favicon: logo, extraHead: feedLink + extraHead })}
</head>
<body class="surface-default ${bodyClass}">
<header class="site-header">
  <div class="container">
    <a class="site-logo" href="/"><img src="${escapeAttr(logo)}" alt="" width="34" height="34"><span class="site-logo-text">${escapeHtml(siteTitle)}</span></a>
    <button class="site-menu-toggle" type="button" aria-label="Menu" aria-expanded="false">☰</button>
    <nav class="site-nav">
      <a class="site-nav-title" href="/">${escapeHtml(siteTitle)}</a>
      ${navHtml}
      ${readerLink}
      <a class="site-search-link" href="/search" aria-label="Search" title="Search">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>
      </a>
      <button class="theme-toggle" type="button" aria-label="Toggle theme">☾</button>
    </nav>
  </div>
</header>
<main>
${content}
</main>
<footer class="site-footer">
  <div class="container">
    ${footerCols ? `<div class="footer-cols">${footerCols}</div>` : ''}
    <div class="footer-meta">
      <span>© ${new Date().getFullYear()} ${escapeHtml(siteTitle)}</span>
      <span>${escapeHtml(footer?.note || siteSettings.org_tagline || '')}</span>
    </div>
  </div>
</footer>
<script src="/js/site.js" defer></script>
</body>
</html>`;
}

// ── Admin shell ──────────────────────────────────────────────────────────────

const ADMIN_NAV = [
  { href: '/admin', label: 'Dashboard', exact: true },
  { group: 'Content' },
  { href: '/admin/pages', label: 'Pages' },
  { href: '/admin/articles', label: 'Articles' },
  { href: '/admin/categories', label: 'Categories' },
  { href: '/admin/series', label: 'Series' },
  { href: '/admin/tags', label: 'Tags' },
  { href: '/admin/people', label: 'People' },
  { href: '/admin/media', label: 'Media' },
  { group: 'Community' },
  { href: '/admin/comments', label: 'Comments', badge: 'comments' },
  { href: '/admin/corrections', label: 'Corrections', badge: 'corrections' },
  { href: '/admin/readers', label: 'Readers', badge: 'readers' },
  { group: 'Design', minRole: 'publisher' },
  { href: '/admin/branding', label: 'Branding', minRole: 'publisher' },
  { href: '/admin/palette', label: 'Palette', minRole: 'publisher' },
  { href: '/admin/emoticons', label: 'Emoticons', minRole: 'publisher' },
  { href: '/admin/fonts', label: 'Fonts', minRole: 'publisher' },
  { href: '/admin/navigation', label: 'Navigation', minRole: 'publisher' },
  { href: '/admin/footer', label: 'Footer', minRole: 'publisher' },
  { group: 'System', minRole: 'publisher' },
  { href: '/admin/settings', label: 'Settings', minRole: 'publisher' },
  { href: '/admin/emails', label: 'Email templates', minRole: 'publisher' },
  { href: '/admin/users', label: 'Users', minRole: 'admin' },
];

const ROLE_ORDER = ['editor', 'publisher', 'admin'];
const atLeast = (user, min) => !min || ROLE_ORDER.indexOf(user.role) >= ROLE_ORDER.indexOf(min);

// Sidebar: ungrouped items render flat (Dashboard); each {group} heading and
// the items after it become a collapsible <details> section, opened only when
// the current page lives inside it. Badge hooks (data-badge) are filled by
// /js/admin-nav.js from /admin/badges.json.
function sidebarNav(user, path) {
  const visible = ADMIN_NAV.filter((i) => atLeast(user, i.minRole));
  const isActive = (i) => i.exact ? path === i.href : (path === i.href || path.startsWith(i.href + '/'));
  const itemHtml = (i) =>
    `<a class="nav-item${isActive(i) ? ' active' : ''}" href="${i.href}"${i.badge ? ` data-badge="${i.badge}"` : ''}><span>${escapeHtml(i.label)}</span></a>`;

  const parts = [];
  let section = null; // { title, items }
  const flush = () => {
    if (!section) return;
    const open = section.items.some(isActive);
    parts.push(`
  <details class="nav-section"${open ? ' open' : ''}>
    <summary><span>${escapeHtml(section.title)}</span></summary>
    <div class="nav-section-items">${section.items.map(itemHtml).join('')}</div>
  </details>`);
    section = null;
  };
  for (const i of visible) {
    if (i.group) { flush(); section = { title: i.group, items: [] }; }
    else if (section) section.items.push(i);
    else parts.push(itemHtml(i));
  }
  flush();
  return parts.join('');
}

export function adminPage({ env, user, title, path = '', content, extraHead = '' }) {
  // Branding (name + logo) is attached to the per-request user in handleAdmin;
  // fall back to the env title + bundled icon if it's ever missing.
  const brand = (user && user.branding) || { name: env.SITE_TITLE || 'DragonslairCMS', logo: '/icons/icon.svg' };
  const brandName = escapeHtml(brand.name);
  const brandLogo = escapeAttr(brand.logo);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${headHtml({ title: `${title} — Admin`, favicon: brand.logo, extraHead: `<link rel="stylesheet" href="/css/admin.css">${extraHead}` })}
</head>
<body class="admin-body">
<div class="admin-topbar">
  <button class="hamburger" type="button" aria-label="Menu" aria-expanded="false">☰</button>
  <a class="site-logo" href="/admin"><img src="${brandLogo}" alt="" width="28" height="28">${brandName}</a>
</div>
<aside class="admin-sidebar">
  <a class="site-logo" href="/admin"><img src="${brandLogo}" alt="" width="34" height="34">${brandName}</a>
  ${sidebarNav(user, path)}
  <div class="sidebar-footer">
    ${escapeHtml(user.name)} <span class="badge">${escapeHtml(user.role)}</span><br>
    <a href="/" target="_blank">View site ↗</a> · <a href="/admin/logout">Log out</a>
    <button class="theme-toggle" type="button" aria-label="Toggle theme" style="margin-top:0.5rem">☾</button>
  </div>
</aside>
<div class="admin-main">
${content}
</div>
<script src="/js/site.js" defer></script>
<script src="/js/admin-nav.js" defer></script>
</body>
</html>`;
}

// Shared login-card shell for the unauthenticated admin screens. `branding`
// ({ name, logo }) comes from handleAdmin; defaults keep a fresh install working.
function adminCard(title, inner, branding = {}) {
  const name = escapeHtml(branding.name || 'DragonslairCMS');
  const logo = escapeAttr(branding.logo || '/icons/icon.svg');
  return `<!DOCTYPE html>
<html lang="en">
<head>
${headHtml({ title: `${title} — Admin`, favicon: branding.logo || '/icons/icon.svg', extraHead: '<link rel="stylesheet" href="/css/admin.css"><meta name="robots" content="noindex">' })}
</head>
<body>
<div class="login-wrap">
  <div class="login-card">
    <div class="site-logo"><img src="${logo}" alt=""></div>
    <h1>${name}</h1>
    ${inner}
  </div>
</div>
</body>
</html>`;
}

export function adminLoginPage({ error = '', notice = '', email = '', branding = {}, showForgot = true } = {}) {
  return adminCard('Log in', `
    ${notice ? `<div class="notice notice-green">${escapeHtml(notice)}</div>` : ''}
    ${error ? `<div class="notice notice-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/admin/login">
      <div class="field">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" value="${escapeAttr(email)}" required autofocus autocomplete="username">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>
      <button class="btn" type="submit" style="width:100%;justify-content:center">Log in</button>
      ${showForgot ? `<p class="small muted center" style="margin-top:1rem"><a href="/admin/forgot">Forgot your password?</a></p>` : ''}
    </form>`, branding);
}

// Request a reset link. Shows a generic confirmation after submit (sent=true).
export function adminForgotPage({ error = '', email = '', sent = false, branding = {}, unavailable = false } = {}) {
  if (unavailable) {
    return adminCard('Reset password', `
      <div class="notice">Password reset by email is turned off on this site. Ask another administrator to set a new password for you from <strong>Admin → Users</strong>.</div>
      <p class="small muted center"><a href="/admin/login">Back to log in</a></p>`, branding);
  }
  if (sent) {
    return adminCard('Reset password', `
      <div class="notice notice-green">If an account exists for that email, we've sent a link to reset its password. The link expires in 1 hour.</div>
      <p class="small muted center"><a href="/admin/login">Back to log in</a></p>`, branding);
  }
  return adminCard('Reset password', `
    <p class="muted">Enter your account email and we'll send you a link to reset your password.</p>
    ${error ? `<div class="notice notice-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/admin/forgot">
      <div class="field">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" value="${escapeAttr(email)}" required autofocus autocomplete="username">
      </div>
      <button class="btn" type="submit" style="width:100%;justify-content:center">Send reset link</button>
      <p class="small muted center" style="margin-top:1rem"><a href="/admin/login">Back to log in</a></p>
    </form>`, branding);
}

// Choose a new password (valid token) or explain an invalid/expired link.
export function adminResetPage({ token = '', error = '', invalid = false, branding = {} } = {}) {
  if (invalid) {
    return adminCard('Reset password', `
      <div class="notice notice-error">This reset link is invalid or has expired.</div>
      <p class="small muted center"><a href="/admin/forgot">Request a new link</a></p>`, branding);
  }
  return adminCard('Reset password', `
    <p class="muted">Choose a new password for your account.</p>
    ${error ? `<div class="notice notice-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/admin/reset">
      <input type="hidden" name="token" value="${escapeAttr(token)}">
      <div class="field">
        <label for="password">New password</label>
        <input type="password" id="password" name="password" required minlength="8" autofocus autocomplete="new-password">
        <p class="hint">At least 8 characters.</p>
      </div>
      <div class="field">
        <label for="confirm">Confirm new password</label>
        <input type="password" id="confirm" name="confirm" required minlength="8" autocomplete="new-password">
      </div>
      <button class="btn" type="submit" style="width:100%;justify-content:center">Set new password</button>
    </form>`, branding);
}

// First-run: create the very first admin account. Only served while the users
// table is empty (gated in handleAdmin); posts to /admin/setup.
export function adminSetupPage({ error = '', name = '', email = '', branding = {} } = {}) {
  return adminCard('Set up', `
    <p class="muted">Welcome! Create the first administrator account to get started. You can add more users later.</p>
    ${error ? `<div class="notice notice-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/admin/setup">
      <div class="field">
        <label for="name">Your name</label>
        <input type="text" id="name" name="name" value="${escapeAttr(name)}" required autofocus>
      </div>
      <div class="field">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" value="${escapeAttr(email)}" required autocomplete="username">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
        <p class="hint">At least 8 characters.</p>
      </div>
      <button class="btn" type="submit" style="width:100%;justify-content:center">Create admin account</button>
    </form>`, branding);
}

export function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { Location: location, ...extraHeaders } });
}

export function html(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
}
