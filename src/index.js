// DragonslairCMS — single Worker serving the public site, /admin, and /api.
// Static files in /public are served by the Workers assets binding before this
// code runs; everything else lands here. Public handlers return null to mean
// "not mine", falling through to the next candidate.

import { handleAdmin } from './routes/admin.js';
import { handleApi } from './routes/api.js';
import { handleReader } from './routes/reader.js';
import { handleMediaFile } from './routes/media.js';
import { handleDiscovery } from './routes/discovery.js';
import { handlePublicArticles } from './routes/public-articles.js';
import { publishScheduledArticles } from './routes/admin-articles.js';
import { handlePublicPeople } from './routes/public-people.js';
import { handlePublicPage } from './routes/public-pages.js';
import { handleSearch } from './routes/search.js';
import { defaultTokens, tokensToCss, surfacesToCss, fontFacesToCss } from './tokens.js';
import { getThemeTokens, getSiteConfig, getSiteSettings } from './db.js';
import { loadChrome } from './site.js';
import { sitePage, escapeHtml, html } from './templates/base.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Generated theme stylesheet: tokens + surfaces + @font-face from D1.
      if (path === '/theme.css') return themeCss(env);

      // Public, read-only emoticon list for the comment editor's picker
      // (the admin list endpoint is behind auth).
      if (path === '/emoticons.json') return emoticonsJson(env);

      // Resolve the admin-settable site URL / email-from once per request and
      // hand every handler a copy of env carrying the effective values, so the
      // wrangler.jsonc vars become fallbacks rather than the only source.
      const renv = await resolveEnv(env);

      if (path === '/admin' || path.startsWith('/admin/')) {
        return await handleAdmin(request, renv, url);
      }

      const candidates = [handleDiscovery, handleApi, handleReader, handleMediaFile, handleSearch, handlePublicArticles, handlePublicPeople, handlePublicPage];
      for (const handler of candidates) {
        const res = await handler(request, renv, url);
        if (res) return res;
      }

      return await notFound(request, renv, url);
    } catch (err) {
      console.error('Unhandled error:', err.stack || err);
      return html('<h1>Something went wrong</h1><p>Please try again shortly.</p>', { status: 500 });
    }
  },

  // Cron Trigger (see triggers.crons in wrangler.jsonc): publish any articles
  // whose scheduled time has passed. Free-plan compatible.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      resolveEnv(env)
        .then((renv) => publishScheduledArticles(renv))
        .then((n) => { if (n) console.log('[schedule] published', n, 'article(s)'); })
        .catch((err) => console.error('[schedule] run failed:', err?.stack || err))
    );
  },
};

// Effective env: overlay the admin-settable site_url / email_from (site_settings)
// onto the wrangler vars, which act as fallbacks. Returns a per-request copy so
// the shared env object is never mutated (no cross-request bleed). SITE_URL is
// stripped of any trailing slash so `${SITE_URL}/path` never doubles up.
async function resolveEnv(env) {
  let s = {};
  try { s = await getSiteSettings(env.DB); } catch { s = {}; }
  const siteUrl = ((s.site_url || '').trim() || env.SITE_URL || '').replace(/\/+$/, '');
  const emailFrom = (s.email_from || '').trim() || env.SITE_EMAIL_FROM;
  return { ...env, SITE_URL: siteUrl, SITE_EMAIL_FROM: emailFrom };
}

async function themeCss(env) {
  const tokens = await getThemeTokens(env.DB, defaultTokens);
  const surfaces = await getSiteConfig(env.DB, 'surfaces', null);
  const fonts = await getSiteConfig(env.DB, 'fonts', null);
  const css = [fontFacesToCss(fonts), tokensToCss(tokens), surfacesToCss(surfaces)].join('\n');
  return new Response(css, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=60', // theme edits show within a minute
    },
  });
}

async function emoticonsJson(env) {
  let emoticons = [];
  try {
    const { results } = await env.DB.prepare('SELECT slug, key, category FROM emoticons ORDER BY category, slug').all();
    emoticons = (results || []).map((r) => ({ slug: r.slug, url: '/' + r.key, category: r.category || 'Uncategorised' }));
  } catch { /* table may be absent → empty list */ }
  const categories = [...new Set(emoticons.map((e) => e.category))];
  return new Response(JSON.stringify({ emoticons, categories }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}

async function notFound(request, env, url) {
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);

  // The home page falls through to here only before a 'home' page exists.
  if (url.pathname === '/') {
    const content = `
      <section class="hero">
        <div class="container">
          <h1>${escapeHtml(settings.org_name || env.SITE_TITLE || 'My Site')}</h1>
          <p class="lede">${escapeHtml(settings.org_tagline || 'This site is being set up. Check back soon.')}</p>
        </div>
      </section>`;
    return html(sitePage({ env, title: '', nav: navItems, footer, siteSettings: settings, reader, content }));
  }

  const content = `
    <section class="section">
      <div class="container">
        <h1>Page not found</h1>
        <p class="muted">There's nothing at <code>${escapeHtml(url.pathname)}</code>.</p>
        <p><a class="btn" href="/">Back to home</a></p>
      </div>
    </section>`;
  return html(sitePage({ env, title: 'Not found', nav: navItems, footer, siteSettings: settings, reader, content }), { status: 404 });
}
