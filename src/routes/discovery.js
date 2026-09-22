// Discovery routes — how feed readers and search engines find the site:
//   GET /feed.xml (and /rss.xml)  RSS 2.0 of the latest published articles
//   GET /sitemap.xml              pages + articles + tag listings
//   GET /robots.txt               allow all, point at the sitemap
// Registered in index.js before the page catch-all. Read-only, cached briefly.

import { listPublishedArticles, loadLookups } from './public-articles.js';
import { articlePath } from '../community.js';
import { getSiteSettings } from '../db.js';

const FEED_ITEMS = 20;

export async function handleDiscovery(request, env, url) {
  if (request.method !== 'GET') return null;
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (path === '/feed.xml' || path === '/rss.xml') return feed(env, url);
  if (path === '/sitemap.xml') return sitemap(env, url);
  if (path === '/robots.txt') return robots(env, url);
  return null;
}

// The site's absolute origin for building links: the configured SITE_URL, or the
// request origin as a fallback (no trailing slash).
const originOf = (env, url) => (env.SITE_URL || url.origin).replace(/\/+$/, '');

// XML text escaping (feeds/sitemaps are XML, not HTML).
function xml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Wrap trusted rich HTML for <content:encoded>, neutralising any literal ]]>.
function cdata(s) {
  return '<![CDATA[' + String(s || '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}

// Make root-relative URLs (/media/…, /blog/…) absolute so feed readers, which
// have no page base, resolve images and links. Handles src/href and srcset.
function absolutize(htmlStr, base) {
  return String(htmlStr || '').replace(/(src|href|srcset)="([^"]*)"/gi, (m, attr, val) => {
    if (attr.toLowerCase() === 'srcset') {
      const fixed = val.split(',').map((part) => {
        const seg = part.trim();
        return seg.startsWith('/') ? base + seg : seg;
      }).join(', ');
      return `${attr}="${fixed}"`;
    }
    return val.startsWith('/') ? `${attr}="${base}${val}"` : m;
  });
}

// YYYY-MM-DD → RFC-822 (RSS pubDate). Falls back to '' for a missing date.
function rfc822(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.length <= 10 ? dateStr + 'T00:00:00Z' : dateStr);
  return isNaN(d) ? '' : d.toUTCString();
}

async function feed(env, url) {
  const base = originOf(env, url);
  const settings = await getSiteSettings(env.DB);
  const siteName = settings.org_name || env.SITE_TITLE || 'My Site';
  const description = settings.org_tagline || settings.seo_description || `${siteName} — latest posts`;

  const [views, lookups] = await Promise.all([
    listPublishedArticles(env, FEED_ITEMS),
    loadLookups(env.DB),
  ]);

  const items = views.map((v) => {
    const link = base + articlePath(v);
    const authors = (v.authors || []).map((s) => lookups.personName[s]).filter(Boolean).join(', ');
    const cats = (v.tags || []).map((t) => lookups.tagTitle[t]).filter(Boolean);
    const pub = rfc822(v.publish_date);
    const summary = v.meta_description || v.subheading || '';
    return `    <item>
      <title>${xml(v.title)}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="true">${xml(link)}</guid>
      ${pub ? `<pubDate>${xml(pub)}</pubDate>` : ''}
      ${authors ? `<dc:creator>${xml(authors)}</dc:creator>` : ''}
      ${cats.map((c) => `<category>${xml(c)}</category>`).join('')}
      ${summary ? `<description>${xml(summary)}</description>` : ''}
      <content:encoded>${cdata(absolutize(v.content, base))}</content:encoded>
    </item>`;
  }).join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(siteName)}</title>
    <link>${xml(base + '/')}</link>
    <atom:link href="${xml(base + '/feed.xml')}" rel="self" type="application/rss+xml" />
    <description>${xml(description)}</description>
    <language>en</language>
    ${views[0] && rfc822(views[0].publish_date) ? `<lastBuildDate>${xml(rfc822(views[0].publish_date))}</lastBuildDate>` : ''}
${items}
  </channel>
</rss>`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

async function sitemap(env, url) {
  const base = originOf(env, url);
  const rows = [];
  const add = (loc, lastmod) => rows.push(
    `  <url><loc>${xml(base + loc)}</loc>${lastmod ? `<lastmod>${xml(String(lastmod).slice(0, 10))}</lastmod>` : ''}</url>`
  );

  add('/');
  add('/posts');

  // Category listings that actually have published articles.
  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT c.slug FROM categories c
       JOIN articles a ON a.category = c.slug
       WHERE a.status IN ('published', 'modified')`
    ).all();
    for (const c of results || []) add('/category/' + c.slug);
  } catch { /* categories table absent → skip */ }

  // Published, non-hidden pages (home already covered by '/').
  try {
    const { results } = await env.DB.prepare(
      `SELECT slug, updated_at FROM pages WHERE status IN ('published', 'modified') AND COALESCE(hidden, 0) = 0`
    ).all();
    for (const p of results || []) {
      if (p.slug === 'home') continue;
      add('/' + p.slug, p.updated_at);
    }
  } catch { /* pages table absent → skip */ }

  // Published articles.
  const views = await listPublishedArticles(env, 0);
  for (const v of views) add(articlePath(v), v.publish_date);

  // Series indexes that actually have published articles.
  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT s.slug FROM series s
       JOIN article_series asx ON asx.series_id = s.id
       JOIN articles a ON a.id = asx.article_id
       WHERE a.status IN ('published', 'modified')`
    ).all();
    for (const s of results || []) add('/series/' + s.slug);
  } catch { /* series tables absent → skip */ }

  // Tag listings that actually have published articles.
  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT t.slug FROM tags t
       JOIN article_tags at ON at.tag_id = t.id
       JOIN articles a ON a.id = at.article_id
       WHERE a.status IN ('published', 'modified')`
    ).all();
    for (const t of results || []) add('/tags/' + t.slug);
  } catch { /* tables absent → skip */ }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.join('\n')}
</urlset>`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

function robots(env, url) {
  const base = originOf(env, url);
  const body = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /reader

Sitemap: ${base}/sitemap.xml
`;
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}
