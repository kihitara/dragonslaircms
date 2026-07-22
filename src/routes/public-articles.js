// Public article routes: /blog, /news (paginated listings), /blog/:slug,
// /news/:slug (article pages) and /tags/:slug (tag listings).
//
// Everything renders from published_snapshot — the version frozen at Publish —
// so in-progress edits ('modified' status) never leak. Articles published
// before snapshots existed fall back to their current fields. Returns null for
// unmatched paths so the caller's 404 handles them.

import { sitePage, escapeHtml, escapeAttr, formatDate, html } from '../templates/base.js';
import { loadChrome } from '../site.js';
import { renderArticleCommunity } from '../community.js';

const PER_PAGE = 9;

export async function handlePublicArticles(request, env, url) {
  if (request.method !== 'GET') return null;
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (path === '/blog' || path === '/news') return listingPage(request, env, url, path.slice(1));

  let m = path.match(/^\/(blog|news)\/([a-z0-9-]+)$/);
  if (m) return articlePage(request, env, url, m[1], m[2]);

  m = path.match(/^\/tags\/([a-z0-9-]+)$/);
  if (m) return tagPage(request, env, url, m[1]);

  return null;
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
// tags is an array of slugs, or null meaning "resolve from article_tags".
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
      category: s.category === 'news' ? 'news' : 'blog',
      publish_date: s.publish_date || row.publish_date,
      cover: s.cover || '',
      hero_surface: s.hero_surface || '', // pre-hero snapshots → '' (site default)
      authors: Array.isArray(s.authors) ? s.authors : [],
      reviewers: Array.isArray(s.reviewers) ? s.reviewers : [],
      meta_title: s.meta_title || '',
      meta_description: s.meta_description || '',
      share_image: s.share_image || '',
      content: s.content || '',
      tags: Array.isArray(s.tags) ? s.tags : [],
    };
  }
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subheading: row.subheading || '',
    category: row.category === 'news' ? 'news' : 'blog',
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
  return {
    personName: Object.fromEntries(people.map((p) => [p.slug, p.name])),
    personPhoto: Object.fromEntries(people.map((p) => [p.slug, p.photo_url || ''])),
    tagTitle: Object.fromEntries(tags.map((t) => [t.slug, t.title])),
  };
}

// Fill in tags for snapshot-less views from the live article_tags rows.
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
  const href = `/${view.category}/${escapeAttr(view.slug)}`;
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

// ── Category listings: /blog, /news ─────────────────────────────────────────

async function listingPage(request, env, url, category) {
  const DB = env.DB;
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);

  const total = (await DB.prepare(
    `SELECT COUNT(*) n FROM articles WHERE category = ? AND status IN ('published', 'modified')`
  ).bind(category).first())?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  const { results } = await DB.prepare(
    `SELECT * FROM articles WHERE category = ? AND status IN ('published', 'modified')
     ORDER BY publish_date DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(category, PER_PAGE, (page - 1) * PER_PAGE).all();

  const views = (results || []).map(liveView).filter(Boolean);
  await resolveTags(DB, views);
  const lookups = await loadLookups(DB);
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);

  const heading = category === 'news' ? 'News' : 'Blog';
  const content = cardsSection(heading, '', views.map((v) => card(v, lookups)), paginationHtml(`/${category}`, page, pages));

  return html(sitePage({
    env, title: heading, canonical: `${env.SITE_URL}/${category}`,
    nav: navItems, footer, siteSettings: settings, reader, content,
  }));
}

// Build the article hero + body content from a resolved view. Shared by the
// live article page and the admin preview so both render identically. The
// caller supplies communityHtml ('' for previews, which have no comments).
export function renderArticleContent(view, lookups, communityHtml = '') {
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

  const heroHtml = `
    <header class="article-hero surface-${escapeAttr(surfaceKey)}">
      ${view.cover ? `<img class="article-hero-media" src="${escapeAttr(view.cover)}" alt="">` : ''}
      <div class="article-hero-overlay"></div>
      <div class="container article-hero-inner">
        <p class="article-hero-eyebrow">${escapeHtml(view.category)}</p>
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
        ${communityHtml}
      </div>
    </article>`;
}

// ── Article page: /blog/:slug, /news/:slug ──────────────────────────────────

async function articlePage(request, env, url, category, slug) {
  const DB = env.DB;
  const row = await DB.prepare('SELECT * FROM articles WHERE slug = ?').bind(slug).first();
  const view = liveView(row);
  if (!view || view.category !== category) return null; // drafts & wrong category → site 404

  await resolveTags(DB, [view]);
  const lookups = await loadLookups(DB);
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);

  // Community module owns comments/corrections rendering; it sees
  // comments_disabled on the row and decides what to show.
  const communityHtml = await renderArticleCommunity(request, env, row);
  const content = renderArticleContent(view, lookups, communityHtml);

  return html(sitePage({
    env,
    title: view.meta_title || view.title,
    description: view.meta_description || view.subheading || '',
    shareImage: view.share_image || view.cover || '',
    canonical: `${env.SITE_URL}/${category}/${view.slug}`,
    nav: navItems, footer, siteSettings: settings, reader, content,
    extraHead: '<link rel="stylesheet" href="/css/article.css">',
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
