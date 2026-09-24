// Public article routes: /posts (all posts), /posts/:slug (article page),
// /category/:slug (category listing) and /tags/:slug (tag listing). The old
// two-prefix scheme (/blog, /news, /blog/:slug, /news/:slug) 301-redirects here.
//
// Everything renders from published_snapshot — the version frozen at Publish —
// so in-progress edits ('modified' status) never leak. Articles published
// before snapshots existed fall back to their current fields. Returns null for
// unmatched paths so the caller's 404 handles them.

import { sitePage, escapeHtml, escapeAttr, formatDate, html } from '../templates/base.js';
import { loadChrome } from '../site.js';
import { getSiteSettings } from '../db.js';
import { renderArticleCommunity } from '../community.js';
import { GALLERY_SCRIPT } from '../templates/blocks.js';

// Article bodies can embed a gallery (WYSIWYG). When present, the article page
// pulls in the shared gallery styles (head) plus the lightbox/carousel island,
// which must run AFTER the markup — so it is appended to the content, exactly
// like renderBlocks does for page Gallery blocks, not placed in <head>.
const ARTICLE_HEAD = '<link rel="stylesheet" href="/css/article.css">';
function hasGallery(contentHtml) { return /data-gallery/.test(contentHtml || ''); }
function articleExtraHead(contentHtml) {
  return hasGallery(contentHtml) ? `${ARTICLE_HEAD}<link rel="stylesheet" href="/css/blocks.css">` : ARTICLE_HEAD;
}

const PER_PAGE = 9;

// Permanent redirect that short-circuits the handler chain (a real Response,
// not null, so index.js stops here rather than falling through to pages).
function redirectPermanent(location) {
  return new Response(null, { status: 301, headers: { Location: location } });
}

export async function handlePublicArticles(request, env, url) {
  if (request.method !== 'GET') return null;
  const path = url.pathname.replace(/\/$/, '') || '/';

  // Root: serve the blog feed when the site is in "article feed" home mode,
  // otherwise fall through so the page router renders the "home" page.
  if (path === '/') {
    let mode = 'page';
    try { mode = (await getSiteSettings(env.DB)).home_mode || 'page'; } catch { /* default */ }
    return mode === 'feed' ? homeFeedPage(request, env, url) : null;
  }

  // Legacy permalinks → the new flat scheme (keeps indexed URLs alive).
  let m = path.match(/^\/(blog|news)\/([a-z0-9-]+)$/);
  if (m) return redirectPermanent(`/posts/${m[2]}`);
  if (path === '/blog') return redirectPermanent('/category/blog');
  if (path === '/news') return redirectPermanent('/category/news');

  if (path === '/posts') return allPostsPage(request, env, url);

  m = path.match(/^\/posts\/([a-z0-9-]+)$/);
  if (m) return articlePage(request, env, url, m[1]);

  m = path.match(/^\/category\/([a-z0-9-]+)$/);
  if (m) return categoryPage(request, env, url, m[1]);

  if (path === '/series') return seriesIndexPage(request, env, url);

  m = path.match(/^\/series\/([a-z0-9-]+)$/);
  if (m) return seriesPage(request, env, url, m[1]);

  m = path.match(/^\/tags\/([a-z0-9-]+)$/);
  if (m) return tagPage(request, env, url, m[1]);

  return null;
}

// Published articles as resolved views (snapshot-correct fields, tags as slugs),
// newest first, across all categories. Shared with the feed and sitemap so they
// use the exact same "what's live" logic as the listing pages. limit 0 = all.
export async function listPublishedArticles(env, limit = 0) {
  const base = `SELECT * FROM articles WHERE status IN ('published', 'modified') ORDER BY publish_date DESC, id DESC`;
  const stmt = limit ? env.DB.prepare(base + ' LIMIT ?').bind(limit) : env.DB.prepare(base);
  const { results } = await stmt.all();
  const views = (results || []).map(liveView).filter(Boolean);
  await resolveTags(env.DB, views);
  return views;
}

// ── View resolution ──────────────────────────────────────────────────────────

function parseArr(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Rich HTML → plain text for meta descriptions (tags stripped, common
// entities decoded — the template re-escapes on output).
function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// The public-facing version of an article row: the frozen snapshot when there
// is one, else the row itself (published with no snapshot yet). Drafts → null.
// tags is always null here, meaning "resolve from article_tags": they're
// navigation rather than frozen content, the tag listings already select on the
// live join, and reading the snapshot's slugs meant a renamed tag silently
// vanished from its own articles until each was republished.
function liveView(row) {
  if (!row || row.status === 'draft') return null;
  let s = null;
  if (row.published_snapshot) {
    try { s = JSON.parse(row.published_snapshot); } catch { s = null; }
  }
  if (s) {
    return {
      id: row.id,
      slug: s.slug || row.slug,
      title: s.title || row.title,
      subheading: s.subheading || '',
      category: s.category || row.category || '',
      publish_date: s.publish_date || row.publish_date,
      cover: s.cover || '',
      hero_surface: s.hero_surface || '', // pre-hero snapshots → '' (site default)
      authors: Array.isArray(s.authors) ? s.authors : [],
      reviewers: Array.isArray(s.reviewers) ? s.reviewers : [],
      meta_title: s.meta_title || '',
      meta_description: s.meta_description || '',
      share_image: s.share_image || '',
      content: s.content || '',
      tags: null,
    };
  }
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subheading: row.subheading || '',
    category: row.category || '',
    publish_date: row.publish_date,
    cover: row.cover || '',
    hero_surface: row.hero_surface || '',
    authors: parseArr(row.authors),
    reviewers: parseArr(row.reviewers),
    meta_title: row.meta_title || '',
    meta_description: row.meta_description || '',
    share_image: row.share_image || '',
    content: row.content || '',
    tags: null,
  };
}

// slug → display-name lookups used by cards and meta rows.
export async function loadLookups(DB) {
  const people = (await DB.prepare('SELECT slug, name, photo_url FROM people').all()).results || [];
  const tags = (await DB.prepare('SELECT slug, title FROM tags').all()).results || [];
  // categories may not exist on an un-migrated database → treat as none.
  let categories = [];
  try { categories = (await DB.prepare('SELECT slug, title FROM categories').all()).results || []; } catch { /* no table yet */ }
  return {
    personName: Object.fromEntries(people.map((p) => [p.slug, p.name])),
    personPhoto: Object.fromEntries(people.map((p) => [p.slug, p.photo_url || ''])),
    tagTitle: Object.fromEntries(tags.map((t) => [t.slug, t.title])),
    categoryTitle: Object.fromEntries(categories.map((c) => [c.slug, c.title])),
  };
}

// Fill in each view's tags from the live article_tags rows.
async function resolveTags(DB, views) {
  for (const v of views) {
    if (v.tags !== null) continue;
    const { results } = await DB.prepare(
      'SELECT t.slug FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = ?'
    ).bind(v.id).all();
    v.tags = (results || []).map((r) => r.slug);
  }
}

// ── Shared fragments ─────────────────────────────────────────────────────────

function tagBadges(tags, lookups) {
  const known = (tags || []).filter((slug) => lookups.tagTitle[slug]);
  if (!known.length) return '';
  return `<div class="tag-list">${known.map((slug) =>
    `<a class="badge" href="/tags/${escapeAttr(slug)}">${escapeHtml(lookups.tagTitle[slug])}</a>`
  ).join('')}</div>`;
}

function card(view, lookups) {
  const href = `/posts/${escapeAttr(view.slug)}`;
  const names = view.authors.map((slug) => lookups.personName[slug]).filter(Boolean);
  return `
    <article class="card article-card">
      ${view.cover ? `<a href="${href}"><img class="cover" src="${escapeAttr(view.cover)}" alt="" loading="lazy"></a>` : ''}
      <h3><a href="${href}">${escapeHtml(view.title)}</a></h3>
      ${view.subheading ? `<p class="muted small">${escapeHtml(view.subheading)}</p>` : ''}
      <div class="article-meta">
        <span>${escapeHtml(formatDate(view.publish_date))}</span>
        ${names.length ? `<span>·</span><span>${escapeHtml(names.join(', '))}</span>` : ''}
      </div>
      ${tagBadges(view.tags, lookups)}
    </article>`;
}

function paginationHtml(basePath, page, pages) {
  if (pages <= 1) return '';
  const link = (p, label, cls = '') =>
    p === page
      ? `<span class="current">${label}</span>`
      : `<a class="${cls}" href="${basePath}${p > 1 ? `?page=${p}` : ''}">${label}</a>`;
  const nums = [];
  for (let p = 1; p <= pages; p++) nums.push(link(p, String(p)));
  return `<nav class="pagination" aria-label="Pages">
    ${page > 1 ? link(page - 1, '‹ Newer') : ''}
    ${nums.join('')}
    ${page < pages ? link(page + 1, 'Older ›') : ''}
  </nav>`;
}

// introHtml is trusted, already-rendered HTML (or '') — callers escape/wrap.
function cardsSection(heading, introHtml, cards, pagination) {
  return `
    <section class="section">
      <div class="container">
        <h1>${escapeHtml(heading)}</h1>
        ${introHtml || ''}
        ${cards.length ? `<div class="grid cols-3">${cards.join('')}</div>` : '<p class="muted">Nothing published here yet.</p>'}
        ${pagination}
      </div>
    </section>`;
}

// ── Listings ─────────────────────────────────────────────────────────────────

// Shared renderer for a paginated card grid (all posts, a category, or a tag):
// resolves the rows to views, loads chrome, and wraps them in a sitePage.
async function renderListing(request, env, url, { rows, total, page, heading, introHtml = '', basePath, canonical, description = '' }) {
  const views = (rows || []).map(liveView).filter(Boolean);
  await resolveTags(env.DB, views);
  const lookups = await loadLookups(env.DB);
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const content = cardsSection(heading, introHtml, views.map((v) => card(v, lookups)), paginationHtml(basePath, page, pages));
  return html(sitePage({
    env, title: heading, description,
    canonical, nav: navItems, footer, siteSettings: settings, reader, content,
  }));
}

// /posts — every published article, newest first.
async function allPostsPage(request, env, url) {
  const DB = env.DB;
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const total = (await DB.prepare(
    `SELECT COUNT(*) n FROM articles WHERE status IN ('published', 'modified')`
  ).first())?.n ?? 0;
  const { results } = await DB.prepare(
    `SELECT * FROM articles WHERE status IN ('published', 'modified')
     ORDER BY publish_date DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(PER_PAGE, (page - 1) * PER_PAGE).all();

  return renderListing(request, env, url, {
    rows: results, total, page, heading: 'Posts',
    basePath: '/posts', canonical: `${env.SITE_URL}/posts`,
  });
}

// / — blog home: the latest posts with a "Browse" sidebar linking to the
// category, series and tag listings that actually have published posts.
async function homeFeedPage(request, env, url) {
  const DB = env.DB;
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const total = (await DB.prepare(
    `SELECT COUNT(*) n FROM articles WHERE status IN ('published', 'modified')`
  ).first())?.n ?? 0;
  const { results } = await DB.prepare(
    `SELECT * FROM articles WHERE status IN ('published', 'modified')
     ORDER BY publish_date DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(PER_PAGE, (page - 1) * PER_PAGE).all();

  const views = (results || []).map(liveView).filter(Boolean);
  await resolveTags(DB, views);
  const lookups = await loadLookups(DB);
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const siteTitle = settings.org_name || env.SITE_TITLE || 'Home';
  const cards = views.map((v) => card(v, lookups));
  const aside = await browseSidebar(DB);

  const content = `
    <section class="section">
      <div class="container blog-home">
        <div class="blog-main">
          <h1 class="visually-hidden">${escapeHtml(siteTitle)}</h1>
          ${settings.org_tagline ? `<p class="blog-home-tagline">${escapeHtml(settings.org_tagline)}</p>` : ''}
          ${cards.length ? `<div class="blog-feed">${cards.join('')}</div>` : '<p class="muted">Nothing published here yet.</p>'}
          ${paginationHtml('/', page, pages)}
        </div>
        ${aside ? `<aside class="blog-aside">${aside}</aside>` : ''}
      </div>
    </section>`;

  return html(sitePage({
    // Empty title → sitePage renders just the site name (no SEO-template wrap),
    // the same as the static home page.
    env, title: '', description: settings.org_tagline || settings.seo_description || '',
    canonical: `${env.SITE_URL}/`,
    nav: navItems, footer, siteSettings: settings, reader, content,
  }));
}

// "Browse" sidebar: category / series / tag lists (only ones with published
// posts), each linking to its existing listing page, plus an RSS link.
async function browseSidebar(DB) {
  const sections = [];
  const listBlock = (title, items, prefix) => {
    if (!items.length) return '';
    const links = items.map((it) =>
      `<li><a href="/${prefix}/${escapeAttr(it.slug)}">${escapeHtml(it.title)}</a> <span class="browse-count">${it.n}</span></li>`).join('');
    return `<div class="browse-group"><h2 class="browse-head">${escapeHtml(title)}</h2><ul class="browse-list">${links}</ul></div>`;
  };
  try {
    const { results } = await DB.prepare(
      `SELECT c.slug, c.title, COUNT(a.id) n FROM categories c
       JOIN articles a ON a.category = c.slug AND a.status IN ('published', 'modified')
       GROUP BY c.id ORDER BY c.sort_order, c.title`
    ).all();
    sections.push(listBlock('Categories', results || [], 'category'));
  } catch { /* table absent */ }
  try {
    const { results } = await DB.prepare(
      `SELECT s.slug, s.title, COUNT(a.id) n FROM series s
       JOIN article_series x ON x.series_id = s.id
       JOIN articles a ON a.id = x.article_id AND a.status IN ('published', 'modified')
       GROUP BY s.id ORDER BY s.sort_order, s.title`
    ).all();
    sections.push(listBlock('Series', results || [], 'series'));
  } catch { /* table absent */ }
  try {
    const { results } = await DB.prepare(
      `SELECT t.slug, t.title, COUNT(a.id) n FROM tags t
       JOIN article_tags at ON at.tag_id = t.id
       JOIN articles a ON a.id = at.article_id AND a.status IN ('published', 'modified')
       GROUP BY t.id ORDER BY t.title`
    ).all();
    sections.push(listBlock('Tags', results || [], 'tags'));
  } catch { /* table absent */ }
  const body = sections.filter(Boolean).join('');
  if (!body) return '';
  return `${body}<div class="browse-group"><a class="browse-rss" href="/feed.xml">Subscribe (RSS)</a></div>`;
}

// /category/:slug — one category's posts. Unknown slug → null so the request
// falls through to the page router (a page could own that path).
async function categoryPage(request, env, url, slug) {
  const DB = env.DB;
  let cat;
  try { cat = await DB.prepare('SELECT * FROM categories WHERE slug = ?').bind(slug).first(); }
  catch { cat = null; } // categories table absent (un-migrated) → not a category
  if (!cat) return null;

  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const total = (await DB.prepare(
    `SELECT COUNT(*) n FROM articles WHERE category = ? AND status IN ('published', 'modified')`
  ).bind(slug).first())?.n ?? 0;
  const { results } = await DB.prepare(
    `SELECT * FROM articles WHERE category = ? AND status IN ('published', 'modified')
     ORDER BY publish_date DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(slug, PER_PAGE, (page - 1) * PER_PAGE).all();

  return renderListing(request, env, url, {
    rows: results, total, page, heading: cat.title,
    introHtml: cat.description ? `<div class="prose" style="margin-bottom:1.6rem">${cat.description}</div>` : '',
    description: stripTags(cat.description),
    basePath: `/category/${escapeAttr(slug)}`, canonical: `${env.SITE_URL}/category/${cat.slug}`,
  });
}

// ── Series: /series (index), /series/:slug (ordered trip) ────────────────────

// Published members of a series in reading order (position, then date).
async function seriesMembers(DB, seriesId) {
  const { results } = await DB.prepare(
    `SELECT a.* FROM articles a
     JOIN article_series asx ON asx.article_id = a.id
     WHERE asx.series_id = ? AND a.status IN ('published', 'modified')
     ORDER BY asx.position, a.publish_date, a.id`
  ).bind(seriesId).all();
  return results || [];
}

// /series — a directory of series that have at least one published article.
async function seriesIndexPage(request, env, url) {
  const DB = env.DB;
  let list = [];
  try {
    ({ results: list } = await DB.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM article_series asx JOIN articles a ON a.id = asx.article_id
                    WHERE asx.series_id = s.id AND a.status IN ('published', 'modified')) AS n
       FROM series s ORDER BY s.sort_order, s.title`
    ).all());
  } catch { return null; } // series table absent → fall through
  const withPosts = (list || []).filter((s) => s.n > 0);
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);
  const cards = withPosts.map((s) => `
    <article class="card">
      ${s.cover ? `<a href="/series/${escapeAttr(s.slug)}"><img class="cover" src="${escapeAttr(s.cover)}" alt="" loading="lazy"></a>` : ''}
      <h3><a href="/series/${escapeAttr(s.slug)}">${escapeHtml(s.title)}</a></h3>
      <div class="article-meta"><span>${s.n} part${s.n === 1 ? '' : 's'}</span></div>
    </article>`);
  const content = cardsSection('Series', '', cards, '');
  return html(sitePage({
    env, title: 'Series', canonical: `${env.SITE_URL}/series`,
    nav: navItems, footer, siteSettings: settings, reader, content,
  }));
}

// /series/:slug — the trip's published posts in reading order (no pagination;
// trips are short and the sequence matters more than paging).
async function seriesPage(request, env, url, slug) {
  const DB = env.DB;
  let s;
  try { s = await DB.prepare('SELECT * FROM series WHERE slug = ?').bind(slug).first(); }
  catch { s = null; } // series table absent → not a series
  if (!s) return null;

  const rows = await seriesMembers(DB, s.id);
  const views = rows.map(liveView).filter(Boolean);
  await resolveTags(DB, views);
  const lookups = await loadLookups(DB);
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);
  const intro = s.description ? `<div class="prose" style="margin-bottom:1.6rem">${s.description}</div>` : '';
  const content = cardsSection(s.title, intro, views.map((v) => card(v, lookups)), '');
  return html(sitePage({
    env, title: s.title, description: stripTags(s.description),
    canonical: `${env.SITE_URL}/series/${s.slug}`,
    nav: navItems, footer, siteSettings: settings, reader, content,
  }));
}

// Series navigation for one article: for each series it belongs to, its position
// among the published members and prev/next links. Returns '' when in none.
async function seriesNavForArticle(DB, articleId) {
  let memberships = [];
  try {
    ({ results: memberships } = await DB.prepare(
      `SELECT s.id, s.slug, s.title FROM article_series asx
       JOIN series s ON s.id = asx.series_id
       WHERE asx.article_id = ? ORDER BY asx.position, s.title`
    ).bind(articleId).all());
  } catch { return ''; }
  const boxes = [];
  for (const s of memberships || []) {
    const members = await seriesMembers(DB, s.id);
    const idx = members.findIndex((a) => a.id === articleId);
    if (idx === -1) continue; // current article not a published member
    const prev = members[idx - 1];
    const next = members[idx + 1];
    const nav = [
      prev ? `<a class="series-nav-link series-prev" href="/posts/${escapeAttr(prev.slug)}"><span class="series-nav-dir">‹ Previous</span><span class="series-nav-title">${escapeHtml(prev.title)}</span></a>` : '',
      next ? `<a class="series-nav-link series-next" href="/posts/${escapeAttr(next.slug)}"><span class="series-nav-dir">Next ›</span><span class="series-nav-title">${escapeHtml(next.title)}</span></a>` : '',
    ].filter(Boolean).join('');
    boxes.push(`
      <aside class="series-box">
        <p class="series-box-label">Part ${idx + 1} of ${members.length} in <a href="/series/${escapeAttr(s.slug)}">${escapeHtml(s.title)}</a></p>
        ${nav ? `<nav class="series-box-nav">${nav}</nav>` : ''}
      </aside>`);
  }
  return boxes.join('');
}

// Build the article hero + body content from a resolved view. Shared by the
// live article page and the admin preview so both render identically. The
// caller supplies communityHtml ('' for previews, which have no comments) and
// seriesHtml (prev/next series boxes, '' for previews).
export function renderArticleContent(view, lookups, communityHtml = '', seriesHtml = '') {
  const personLink = (pslug) => lookups.personName[pslug]
    ? `<a href="/people/${escapeAttr(pslug)}">${escapeHtml(lookups.personName[pslug])}</a>`
    : '';
  const authorLinks = view.authors.map(personLink).filter(Boolean).join(', ');
  const reviewerLinks = view.reviewers.map(personLink).filter(Boolean).join(', ');

  // Hero band: cover image (when set) under a semi-transparent tint of the
  // chosen palette surface; text picks up the surface's --c-* colours. The
  // surface key is admin-sanitised, but re-sanitise before using in a class.
  const surfaceKey = String(view.hero_surface || '').replace(/[^a-z0-9_-]/gi, '') || 'dark';
  const avatars = view.authors
    .map((s) => lookups.personPhoto[s]
      ? `<img src="${escapeAttr(lookups.personPhoto[s])}" alt="" loading="lazy">`
      : '')
    .filter(Boolean).join('');
  const dateHtml = view.publish_date
    ? `<time datetime="${escapeAttr(view.publish_date)}">${escapeHtml(formatDate(view.publish_date))}</time>`
    : '';
  const metaBits = [
    authorLinks
      ? `<span class="article-hero-byline">${avatars ? `<span class="article-hero-avatars">${avatars}</span>` : ''}<span>By ${authorLinks}</span></span>`
      : '',
    dateHtml,
    reviewerLinks ? `<span>Reviewed by ${reviewerLinks}</span>` : '',
    tagBadges(view.tags, lookups),
  ].filter(Boolean);

  // Category eyebrow links to the category listing; shows the title when known
  // (falls back to the raw slug for orphaned categories / admin previews).
  const catTitle = (lookups.categoryTitle && lookups.categoryTitle[view.category]) || view.category;
  const eyebrow = view.category
    ? `<p class="article-hero-eyebrow"><a href="/category/${escapeAttr(view.category)}">${escapeHtml(catTitle)}</a></p>`
    : '';

  const heroHtml = `
    <header class="article-hero surface-${escapeAttr(surfaceKey)}">
      ${view.cover ? `<img class="article-hero-media" src="${escapeAttr(view.cover)}" alt="">` : ''}
      <div class="article-hero-overlay"></div>
      <div class="container article-hero-inner">
        ${eyebrow}
        <h1 class="article-hero-title">${escapeHtml(view.title)}</h1>
        ${view.subheading ? `<p class="article-hero-sub">${escapeHtml(view.subheading)}</p>` : ''}
        ${metaBits.length ? `<div class="article-hero-meta">${metaBits.join('')}</div>` : ''}
      </div>
    </header>`;

  return `
    ${heroHtml}
    <article class="section">
      <div class="container">
        <div class="prose">
${view.content}
        </div>
        ${seriesHtml}
        ${communityHtml}
      </div>
    </article>`;
}

// ── Article page: /posts/:slug ──────────────────────────────────────────────

async function articlePage(request, env, url, slug) {
  const DB = env.DB;
  const row = await DB.prepare('SELECT * FROM articles WHERE slug = ?').bind(slug).first();
  const view = liveView(row);
  if (!view) return null; // drafts & unknown slugs → site 404

  await resolveTags(DB, [view]);
  const lookups = await loadLookups(DB);
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);

  // Community module owns comments/corrections rendering; it sees
  // comments_disabled on the row and decides what to show.
  const communityHtml = await renderArticleCommunity(request, env, row);
  const seriesHtml = await seriesNavForArticle(DB, row.id);
  const content = renderArticleContent(view, lookups, communityHtml, seriesHtml)
    + (hasGallery(view.content) ? GALLERY_SCRIPT : '');

  return html(sitePage({
    env,
    title: view.meta_title || view.title,
    description: view.meta_description || view.subheading || '',
    shareImage: view.share_image || view.cover || '',
    canonical: `${env.SITE_URL}/posts/${view.slug}`,
    nav: navItems, footer, siteSettings: settings, reader, content,
    extraHead: articleExtraHead(view.content),
  }));
}

// ── Tag listing: /tags/:slug ─────────────────────────────────────────────────

async function tagPage(request, env, url, slug) {
  const DB = env.DB;
  const tag = await DB.prepare('SELECT * FROM tags WHERE slug = ?').bind(slug).first();
  if (!tag) return null;

  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const total = (await DB.prepare(
    `SELECT COUNT(*) n FROM articles a JOIN article_tags at ON at.article_id = a.id
     WHERE at.tag_id = ? AND a.status IN ('published', 'modified')`
  ).bind(tag.id).first())?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  const { results } = await DB.prepare(
    `SELECT a.* FROM articles a JOIN article_tags at ON at.article_id = a.id
     WHERE at.tag_id = ? AND a.status IN ('published', 'modified')
     ORDER BY a.publish_date DESC, a.id DESC LIMIT ? OFFSET ?`
  ).bind(tag.id, PER_PAGE, (page - 1) * PER_PAGE).all();

  const views = (results || []).map(liveView).filter(Boolean);
  await resolveTags(DB, views);
  const lookups = await loadLookups(DB);
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);

  // Tag descriptions are trusted rich HTML entered by CMS editors (WYSIWYG) —
  // rendered raw inside .prose; the meta description gets a stripped version.
  const content = cardsSection(
    `Tagged: ${tag.title}`,
    tag.description ? `<div class="prose" style="margin-bottom:1.6rem">${tag.description}</div>` : '',
    views.map((v) => card(v, lookups)),
    paginationHtml(`/tags/${escapeAttr(slug)}`, page, pages)
  );

  return html(sitePage({
    env, title: tag.title, description: stripTags(tag.description),
    canonical: `${env.SITE_URL}/tags/${tag.slug}`,
    nav: navItems, footer, siteSettings: settings, reader, content,
  }));
}
