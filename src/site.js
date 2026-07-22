// Shared "chrome" loader for public pages: settings, nav (with active state),
// footer config, and — when a request is passed — the logged-in reader (for the
// header's Login link / username), in one call for handing straight to sitePage().

import { getSiteSettings, getSiteConfig } from './db.js';
import { getReaderSession } from './auth.js';

export async function loadChrome(env, url, request = null) {
  const settings = await getSiteSettings(env.DB);
  const nav = (await getSiteConfig(env.DB, 'nav', { items: [] }))?.items || [];
  const footer = await getSiteConfig(env.DB, 'footer', null);
  const matches = (href) => !!href && (url.pathname === href || (href !== '/' && url.pathname.startsWith(href + '/')));
  const navItems = nav.map((i) => ({
    ...i,
    // A dropdown parent is active when it or any of its children matches.
    active: matches(i.href) || (Array.isArray(i.children) && i.children.some((c) => matches(c?.href))),
  }));
  let reader = null;
  if (request) {
    try { reader = await getReaderSession(request, env.DB, env.READER_SESSION_SECRET); } catch { /* header login is decorative */ }
  }
  return { settings, navItems, footer, reader };
}
