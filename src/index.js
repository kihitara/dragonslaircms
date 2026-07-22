// DragonslairCMS — single Worker serving the public site, /admin, and /api.
// Static files in /public are served by the Workers assets binding before this
// code runs; everything else lands here. Public handlers return null to mean
// "not mine", falling through to the next candidate.

import { handleAdmin } from './routes/admin.js';
import { handleApi } from './routes/api.js';
import { handleReader } from './routes/reader.js';
import { handleMediaFile } from './routes/media.js';
import { handlePublicArticles } from './routes/public-articles.js';
import { handlePublicPeople } from './routes/public-people.js';
import { handlePublicPage } from './routes/public-pages.js';
import { defaultTokens, tokensToCss, surfacesToCss, fontFacesToCss } from './tokens.js';
import { getThemeTokens, getSiteConfig } from './db.js';
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

      if (path === '/admin' || path.startsWith('/admin/')) {
        return await handleAdmin(request, env, url);
      }

      const candidates = [handleApi, handleReader, handleMediaFile, handlePublicArticles, handlePublicPeople, handlePublicPage];
      for (const handler of candidates) {
        const res = await handler(request, env, url);
        if (res) return res;
      }

      return await notFound(request, env, url);
    } catch (err) {
      console.error('Unhandled error:', err.stack || err);
      return html('<h1>Something went wrong</h1><p>Please try again shortly.</p>', { status: 500 });
    }
  },
};

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
