// Admin preview: render a page/article from the CURRENT (unsaved) editor form
// state exactly as it would appear on the live site, without saving or
// publishing. The editor POSTs its form here via fetch and shows the returned
// HTML in a slide-out panel (public/js/preview.js). Nothing is written to the
// DB; the response is marked noindex so it can never be crawled if leaked.
//
// These handlers are reached through handlePages / handleArticles, so the admin
// auth gate has already run.

import { sitePage, html } from '../templates/base.js';
import { loadChrome } from '../site.js';
import { renderPageBlocksContent } from './public-pages.js';
import { renderArticleContent, loadLookups } from './public-articles.js';

const NOINDEX = '<meta name="robots" content="noindex">';

// <head> snippet for any editor page with a Preview button.
export const PREVIEW_HEAD = '<link rel="stylesheet" href="/css/preview.css"><script src="/js/preview.js" defer></script>';

// The Preview button markup. `endpoint` is the preview POST route; the button
// carries it in data-preview-url and public/js/preview.js wires the panel.
export function previewButton(endpoint) {
  return `<button type="button" class="btn btn-secondary btn-small" data-preview-url="${endpoint}">Preview</button>`;
}


// POST /admin/pages/preview — form fields match the page editor's save form.
export async function previewPage(request, env, url) {
  const form = await request.formData();
  let blocks;
  try { blocks = JSON.parse(form.get('blocks') || '[]'); } catch { blocks = []; }
  if (!Array.isArray(blocks)) blocks = [];

  const live = {
    title: String(form.get('title') || 'Untitled'),
    blocks: JSON.stringify(blocks),
    full_width: form.get('full_width') === '1' ? 1 : 0,
  };
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);
  const content = await renderPageBlocksContent(env, live, '');

  return html(sitePage({
    env,
    title: String(form.get('meta_title') || '').trim() || (live.title === 'Untitled' ? '' : live.title),
    description: String(form.get('meta_description') || '').trim(),
    nav: navItems, footer, siteSettings: settings, reader,
    bodyClass: live.full_width ? 'page-full-width' : '',
    content,
    extraHead: `<link rel="stylesheet" href="/css/blocks.css">${NOINDEX}`,
  }));
}

// POST /admin/articles/preview — form fields match the article editor's form.
export async function previewArticle(request, env, url) {
  const form = await request.formData();

  // The form posts tag IDs; the renderer works in slugs. Resolve them.
  const tagIds = form.getAll('tags').map(Number).filter(Boolean);
  let tagSlugs = [];
  if (tagIds.length) {
    const placeholders = tagIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT slug FROM tags WHERE id IN (${placeholders})`
    ).bind(...tagIds).all();
    tagSlugs = (results || []).map((r) => r.slug);
  }

  const view = {
    slug: 'preview',
    title: String(form.get('title') || 'Untitled'),
    subheading: String(form.get('subheading') || ''),
    category: form.get('category') === 'news' ? 'news' : 'blog',
    publish_date: String(form.get('publish_date') || ''),
    cover: String(form.get('cover') || ''),
    hero_surface: String(form.get('hero_surface') || '').toLowerCase().replace(/[^a-z0-9_-]/g, ''),
    authors: form.getAll('authors').map(String),
    reviewers: form.getAll('reviewers').map(String),
    meta_title: String(form.get('meta_title') || ''),
    meta_description: String(form.get('meta_description') || ''),
    share_image: String(form.get('share_image') || ''),
    content: String(form.get('content') || ''),
    tags: tagSlugs,
  };

  const lookups = await loadLookups(env.DB);
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);
  const content = renderArticleContent(view, lookups, '');

  return html(sitePage({
    env,
    title: view.meta_title || view.title,
    description: view.meta_description || view.subheading || '',
    shareImage: view.share_image || view.cover || '',
    nav: navItems, footer, siteSettings: settings, reader,
    content,
    extraHead: `<link rel="stylesheet" href="/css/article.css">${NOINDEX}`,
  }));
}
