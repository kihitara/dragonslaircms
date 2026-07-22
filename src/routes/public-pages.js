// Public page rendering: resolves GET requests against the pages table and
// renders the PUBLISHED view only. Returns null when there's no live page at
// the path, so index.js can fall through to its own 404 / other handlers.

import { sitePage, html, escapeHtml, formatDate } from '../templates/base.js';
import { loadChrome } from '../site.js';
import { renderBlocks } from '../templates/blocks.js';
import { renderPageCorrections } from '../community.js';

// Render a page's blocks to HTML, with `extra` (corrections, dates — or '')
// appended inside the flow. Shared with the admin preview so a preview renders
// blocks through the exact same path as the live page.
export async function renderPageBlocksContent(env, live, extra = '') {
  let blocks;
  try { blocks = JSON.parse(live.blocks || '[]'); } catch { blocks = []; }
  if (!Array.isArray(blocks)) blocks = [];
  const blocksHtml = await renderBlocks(env, blocks, { title: live.title });
  return blocksHtml + extra;
}

export async function handlePublicPage(request, env, url) {
  if (request.method !== 'GET') return null;

  // '/' serves the page with slug 'home'; anything else matches by slug
  // (internal slashes allowed, so nested paths like company/about work).
  let slug;
  try { slug = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').toLowerCase(); }
  catch { return null; }
  if (!slug) slug = 'home';

  const pg = await env.DB.prepare('SELECT * FROM pages WHERE slug = ?').bind(slug).first();
  if (!pg || pg.status === 'draft') return null; // drafts are never public

  // Live version = the published snapshot when present; a page published before
  // snapshots existed (or never re-saved) falls back to its current fields.
  let live = pg;
  if (pg.published_snapshot) {
    try { live = { ...pg, ...JSON.parse(pg.published_snapshot) }; } catch { /* fall back to current fields */ }
  }

  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);

  const corrections = await renderPageCorrections(request, env, pg);

  // Published (created_at) + last-updated line at the foot of every page.
  // "Last updated" tracks the published snapshot's stamp (frozen at publish
  // time), not pg.updated_at — so unpublished draft edits don't move it.
  const pub = formatDate(pg.created_at);
  const upd = formatDate(live.updated_at || pg.updated_at);
  const dateParts = [];
  if (pub) dateParts.push(`Published ${escapeHtml(pub)}`);
  if (upd) dateParts.push(`Last updated ${escapeHtml(upd)}`);
  const dateLine = dateParts.length
    ? `<div class="container"><p class="page-dates">${dateParts.join(' · ')}</p></div>`
    : '';

  const extra = (corrections ? `\n<div class="container">${corrections}</div>` : '') + `\n${dateLine}`;
  const content = await renderPageBlocksContent(env, live, extra);

  const isHome = slug === 'home';
  const title = live.meta_title || (isHome ? '' : live.title);
  const canonical = url.origin + (isHome ? '/' : '/' + slug);

  return html(sitePage({
    env,
    title,
    description: live.meta_description || settings.seo_description || '',
    canonical,
    shareImage: live.share_image || settings.og_image_url || '',
    nav: navItems,
    footer,
    siteSettings: settings,
    reader,
    bodyClass: live.full_width ? 'page-full-width' : '',
    content,
    extraHead: `<link rel="stylesheet" href="/css/blocks.css">${live.hidden ? '<meta name="robots" content="noindex">' : ''}`,
  }));
}
