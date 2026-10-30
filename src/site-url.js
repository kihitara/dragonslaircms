// The one check on the site URL, from Forge's src/site-url.js. Every link in an
// email starts with it, so it decides where a password-reset link points.
//
// A scheme and a host, with an optional port, and no path, query or trailing
// slash. https:// for any host; http:// only for a loopback host (localhost, a
// *.localhost name, 127.0.0.1 or [::1], any port), which is what lets mail work
// under `wrangler dev`. A production site is never recorded as plain http.

const LOOPBACK = (host) => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';

// What is wrong with a site URL, or null. An empty value is allowed: it leaves
// email switched off until one is set.
export function siteUrlError(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  let u;
  try { u = new URL(v); } catch { return 'The site URL needs to be a whole address, such as https://example.com.'; }
  if (u.origin !== v) return 'The site URL is just the address, with nothing after the name: no path, no query and no slash at the end.';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && LOOPBACK(u.hostname)) return null;
  return 'The site URL has to start https:// (plain http is only for this computer, under wrangler dev).';
}

// The origin for a public page's own absolute links (canonical tags, the feed,
// the sitemap, export bases): the configured site URL, or else the origin the
// request arrived on. Never used for email, which needs the site URL itself.
export function publicOrigin(env, url) {
  return (env.SITE_URL || url.origin).replace(/\/+$/, '');
}

// A typed value tidied the way people expect: surrounding spaces and any
// trailing slashes go before it is checked.
export function normaliseSiteUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}
