// Public site search: GET /search?q=… over published articles (title,
// subheading, body) and published, non-hidden pages (title + block text).
//
// No FTS: at a personal-site scale it is simpler and snapshot-correct to load
// the live views (the exact text that is public) and filter in memory. Multi-
// word queries AND all terms; results rank title > subheading > body, newest
// first within a tier. Returns null only for non-GET so index.js can 404.

import { sitePage, escapeHtml, escapeAttr, formatDate, html } from '../templates/base.js';
import { loadChrome } from '../site.js';
import { listPublishedArticles } from './public-articles.js';

const PER_PAGE = 10;

export async function handleSearch(request, env, url) {
  if (request.method !== 'GET') return null;
  if ((url.pathname.replace(/\/$/, '') || '/') !== '/search') return null;

  const q = String(url.searchParams.get('q') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);

  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);

  let resultsHtml;
  if (!terms.length) {
    resultsHtml = '<p class="muted">Type something above to search the site.</p>';
  } else {
    const all = await gatherResults(env, terms);
    resultsHtml = renderResults(all, terms, q, page);
  }

  const content = `
    <section class="section">
      <div class="container search-page">
        <h1>Search</h1>
        <form class="search-form" role="search" action="/search" method="get">
          <input type="search" name="q" value="${escapeAttr(q)}" placeholder="Search articles and pages…" aria-label="Search" autofocus>
          <button class="btn" type="submit">Search</button>
        </form>
        ${resultsHtml}
      </div>
    </section>`;

  return html(sitePage({
    env, title: q ? `Search: ${q}` : 'Search',
    canonical: `${env.SITE_URL}/search`,
    nav: navItems, footer, siteSettings: settings, reader, content,
    extraHead: '<meta name="robots" content="noindex">',
  }));
}

// ── Matching ─────────────────────────────────────────────────────────────────

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// Structural / non-prose keys in a page's blocks JSON — skipped so a search for
// "grid" doesn't match a block type and a term doesn't match a media path.
const SKIP_KEYS = new Set([
  'type', 'surface', 'valign', 'align', 'columns', 'variant', 'size', 'ratio',
  'id', 'icon', 'src', 'href', 'url', 'image', 'cover', 'color', 'width', 'height',
]);

// Plain text from a page's blocks JSON: every prose string value, tags stripped.
function pageBlockText(blocksJson) {
  let data;
  try { data = JSON.parse(blocksJson || '[]'); } catch { return ''; }
  const parts = [];
  const walk = (v) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) if (!SKIP_KEYS.has(k)) walk(val);
    }
  };
  walk(data);
  return stripTags(parts.join(' '));
}

// Score a document against all terms: every term must appear somewhere (AND),
// else 0. Title hits weigh most, then subheading, then body. Returns { score }.
function scoreDoc(terms, title, sub, body) {
  const t = (title || '').toLowerCase();
  const s = (sub || '').toLowerCase();
  const b = (body || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    const inT = t.includes(term), inS = s.includes(term), inB = b.includes(term);
    if (!inT && !inS && !inB) return 0; // AND: a missing term disqualifies
    score += (inT ? 5 : 0) + (inS ? 2 : 0) + (inB ? 1 : 0);
  }
  return score;
}

async function gatherResults(env, terms) {
  const out = [];

  // Articles — snapshot-correct live views (same as the public listings).
  const articles = await listPublishedArticles(env, 0);
  for (const v of articles) {
    const body = stripTags(v.content);
    const score = scoreDoc(terms, v.title, v.subheading, body);
    if (score > 0) {
      out.push({
        type: 'Article', title: v.title, url: `/posts/${v.slug}`,
        date: v.publish_date || '', sub: v.subheading || '',
        body, score,
      });
    }
  }

  // Pages — published, non-hidden; live text from the published snapshot.
  try {
    const { results } = await env.DB.prepare(
      `SELECT slug, title, blocks, published_snapshot, updated_at FROM pages
       WHERE status IN ('published', 'modified') AND COALESCE(hidden, 0) = 0`
    ).all();
    for (const p of results || []) {
      let live = p;
      if (p.published_snapshot) {
        try { live = { ...p, ...JSON.parse(p.published_snapshot) }; } catch { /* fall back */ }
      }
      const body = pageBlockText(live.blocks);
      const score = scoreDoc(terms, live.title, '', body);
      if (score > 0) {
        out.push({
          type: 'Page', title: live.title || p.slug,
          url: p.slug === 'home' ? '/' : `/${p.slug}`,
          date: p.updated_at || '', sub: '', body, score,
        });
      }
    }
  } catch { /* pages table absent → skip */ }

  // Best score first; within a tier, newest first.
  out.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
  return out;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Escape first, then wrap term matches in <mark> (terms are word-ish, so the
// escape step never changes what the regex sees).
function highlight(text, terms) {
  let out = escapeHtml(text);
  for (const term of terms) {
    if (!term) continue;
    out = out.replace(new RegExp(`(${escapeRegex(term)})`, 'gi'), '<mark>$1</mark>');
  }
  return out;
}

// A context window around the first matched term, with matches highlighted.
function snippet(body, terms, len = 220) {
  if (!body) return '';
  const lc = body.toLowerCase();
  let pos = -1;
  for (const term of terms) {
    const i = lc.indexOf(term);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  const start = pos > 60 ? pos - 60 : 0;
  const slice = body.slice(start, start + len);
  const prefix = start > 0 ? '… ' : '';
  const suffix = start + len < body.length ? ' …' : '';
  return prefix + highlight(slice, terms) + suffix;
}

function renderResults(all, terms, q, page) {
  if (!all.length) {
    return `<p class="muted">No results for “${escapeHtml(q)}”. Try different or fewer words.</p>`;
  }
  const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const cur = Math.min(page, pages);
  const slice = all.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);

  const items = slice.map((r) => `
    <article class="search-result">
      <h3><a href="${escapeAttr(r.url)}">${highlight(r.title, terms)}</a></h3>
      <div class="article-meta">
        <span class="badge">${escapeHtml(r.type)}</span>
        ${r.type === 'Article' && r.date ? `<span>${escapeHtml(formatDate(r.date))}</span>` : ''}
      </div>
      ${r.body ? `<p class="search-snippet">${snippet(r.body, terms)}</p>` : ''}
    </article>`).join('');

  const count = `<p class="muted search-count">${all.length} result${all.length === 1 ? '' : 's'} for “${escapeHtml(q)}”.</p>`;

  let pager = '';
  if (pages > 1) {
    const link = (p, label) => p === cur
      ? `<span class="current">${label}</span>`
      : `<a href="/search?q=${encodeURIComponent(q)}${p > 1 ? `&page=${p}` : ''}">${label}</a>`;
    const nums = [];
    for (let p = 1; p <= pages; p++) nums.push(link(p, String(p)));
    pager = `<nav class="pagination" aria-label="Pages">
      ${cur > 1 ? link(cur - 1, '‹ Prev') : ''}${nums.join('')}${cur < pages ? link(cur + 1, 'Next ›') : ''}
    </nav>`;
  }

  return `${count}<div class="search-results">${items}</div>${pager}`;
}
