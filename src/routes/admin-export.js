// Download a page or article as Markdown, standalone HTML, or PDF.
//
// All three come off the SAVED row rather than the published snapshot, so a
// draft can be exported and what you get matches what the editor is showing.
//
// PDF has no server-side step: Workers can't render one without the paid
// Browser Rendering binding, so /print serves the same standalone HTML with a
// print stylesheet and calls window.print(), and the browser's own "Save as
// PDF" produces the file. That keeps the whole CMS on the Workers Free plan.

import { renderBlocks } from '../templates/blocks.js';
import { formatDate } from '../templates/base.js';
import { pageToMarkdown, articleToMarkdown, exportFilename } from '../export-md.js';
import { buildExportHtml } from '../export-html.js';

// Opens what the stripped scripts would have opened, waits for webfonts so the
// PDF isn't printed with fallback faces, then prints. Works both in the hidden
// iframe the editor uses and in a tab opened directly.
const PRINT_SCRIPT = `<script>
(function () {
  function go() { try { window.focus(); window.print(); } catch (e) {} }
  function ready() {
    try {
      document.querySelectorAll('details').forEach(function (d) { d.open = true; });
    } catch (e) {}
    try {
      if (document.fonts && document.fonts.ready) { document.fonts.ready.then(go, go); return; }
    } catch (e) {}
    go();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
</script>`;

const mdResponse = (md, filename) => new Response(md, {
  headers: {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  },
});

const htmlDownload = (doc, filename) => new Response(doc, {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  },
});

// Served into an iframe/tab to be printed, so no Content-Disposition: the
// browser names the PDF itself from the document title.
const printResponse = (doc) => new Response(doc, {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  },
});

const baseUrl = (env, url) => (env.SITE_URL || url.origin).replace(/\/+$/, '');

const dateMeta = (row) => [
  formatDate(row.publish_date || row.created_at) ? `Published ${formatDate(row.publish_date || row.created_at)}` : '',
  formatDate(row.updated_at) ? `Last updated ${formatDate(row.updated_at)}` : '',
];

// ── Pages ────────────────────────────────────────────────────────────────────

export async function exportPage(env, url, page, kind) {
  if (kind === 'md') return mdResponse(pageToMarkdown(page), exportFilename(page.slug, 'md'));

  let blocks;
  try { blocks = JSON.parse(page.blocks || '[]'); } catch { blocks = []; }
  if (!Array.isArray(blocks)) blocks = [];

  const doc = await buildExportHtml(env, {
    title: page.title,
    contentHtml: await renderBlocks(env, blocks, { title: page.title }),
    base: baseUrl(env, url),
    meta: dateMeta(page),
  });

  if (kind === 'print') return printResponse(doc.replace('</body>', `${PRINT_SCRIPT}\n</body>`));
  return htmlDownload(doc, exportFilename(page.slug, 'html'));
}

// ── Articles ─────────────────────────────────────────────────────────────────

// Category and series are stored as ids/joins, so resolve them to titles for
// the Markdown frontmatter rather than exporting raw keys.
async function articleLookups(env, article) {
  const out = { categoryTitle: '', seriesTitles: [], tagNames: [] };
  try {
    const cat = await env.DB.prepare('SELECT title FROM categories WHERE slug = ?').bind(article.category || '').first();
    out.categoryTitle = cat?.title || article.category || '';
  } catch { out.categoryTitle = article.category || ''; }
  try {
    const { results } = await env.DB.prepare(
      `SELECT s.title FROM series s JOIN article_series a ON a.series_id = s.id
       WHERE a.article_id = ? ORDER BY a.position, s.title`
    ).bind(article.id).all();
    out.seriesTitles = (results || []).map((r) => r.title);
  } catch { /* series are optional */ }
  try {
    const { results } = await env.DB.prepare(
      `SELECT t.title FROM tags t JOIN article_tags a ON a.tag_id = t.id
       WHERE a.article_id = ? ORDER BY t.title`
    ).bind(article.id).all();
    out.tagNames = (results || []).map((r) => r.title);
  } catch { /* tags are optional */ }
  return out;
}

export async function exportArticle(env, url, article, kind) {
  const lookups = await articleLookups(env, article);
  if (kind === 'md') {
    return mdResponse(articleToMarkdown(article, lookups), exportFilename(article.slug, 'md'));
  }

  // .container + .prose is how the live article page wraps a body — the rich-text
  // rules (inline emoticons, callouts, galleries) are all scoped to .prose.
  const cover = article.cover
    ? `<figure class="export-cover"><img src="${article.cover}" alt=""></figure>`
    : '';
  const doc = await buildExportHtml(env, {
    title: article.title,
    subtitle: article.subheading || '',
    contentHtml: `<div class="container">${cover}<div class="prose">${article.content || ''}</div></div>`,
    base: baseUrl(env, url),
    meta: [...dateMeta(article), lookups.categoryTitle].filter(Boolean),
  });

  if (kind === 'print') return printResponse(doc.replace('</body>', `${PRINT_SCRIPT}\n</body>`));
  return htmlDownload(doc, exportFilename(article.slug, 'html'));
}

// ── Editor UI ────────────────────────────────────────────────────────────────

// Download links + the print trigger for an editor action bar. `base` is the
// record's admin path, e.g. /admin/pages/12.
export function exportButtons(base) {
  return `<span class="export-group">
    <a class="btn btn-secondary btn-small" href="${base}/export.md" download>Markdown</a>
    <a class="btn btn-secondary btn-small" href="${base}/export.html" download>HTML</a>
    <button type="button" class="btn btn-secondary btn-small" data-print-url="${base}/print">PDF</button>
  </span>`;
}

export const EXPORT_HEAD = '<script src="/js/export-print.js" defer></script>';
