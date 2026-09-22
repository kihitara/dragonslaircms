// Admin: /admin/articles* — list, create, edit (WYSIWYG body + settings panel),
// publish workflow, revisions, delete.
//
// Publishing freezes the article (incl. its tag slugs) into published_snapshot,
// so later edits never leak to the site until Publish is pressed again:
//   draft → save keeps draft; published → save flips to modified;
//   publish → snapshot + status published; revert → restore the snapshot.

import { roleAtLeast } from '../auth.js';
import { logActivity, saveRevision, getRevisions, getRevision, getSiteConfig, getSiteSettings } from '../db.js';
import { SURFACE_KEYS, SURFACE_LABELS } from '../tokens.js';
import { adminPage, escapeHtml, escapeAttr, formatDate, redirect, html } from '../templates/base.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { notifyNewArticle } from '../community.js';
import { MEDIA_PICKER_HEAD } from './admin-media.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';
import { PREVIEW_HEAD, previewButton, previewArticle } from './admin-preview.js';

const BASE = '/admin/articles';

// Comment modes (value → editor label). Order = dropdown order.
const COMMENT_MODE_OPTIONS = [
  ['enabled', 'Enabled — anyone can comment'],
  ['readers', 'Readers only — logged-in readers can comment'],
  ['closed', 'Closed — show existing, no new comments'],
  ['disabled', 'Disabled — hide all comments'],
];
const COMMENT_MODES = COMMENT_MODE_OPTIONS.map(([v]) => v);

export async function handleArticles(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '') || BASE;
  const method = request.method;

  if (path === BASE && method === 'GET') return listPage(env, user, url);
  if (path === `${BASE}/preview` && method === 'POST') return previewArticle(request, env, url);

  if (path === `${BASE}/new`) {
    if (method === 'GET') return editPage(env, user, url, null);
    if (method === 'POST') return create(request, env, user);
  }

  let m = path.match(/^\/admin\/articles\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'GET') return editPage(env, user, url, id);
    if (method === 'POST') return save(request, env, user, id);
  }

  m = path.match(/^\/admin\/articles\/(\d+)\/publish$/);
  if (m && method === 'POST') return publish(request, env, user, Number(m[1]));

  m = path.match(/^\/admin\/articles\/(\d+)\/schedule$/);
  if (m && method === 'POST') return schedule(request, env, user, Number(m[1]));

  m = path.match(/^\/admin\/articles\/(\d+)\/unschedule$/);
  if (m && method === 'POST') return unschedule(env, user, Number(m[1]));

  m = path.match(/^\/admin\/articles\/(\d+)\/unpublish$/);
  if (m && method === 'POST') return unpublish(env, user, Number(m[1]));

  m = path.match(/^\/admin\/articles\/(\d+)\/revert$/);
  if (m && method === 'POST') return revertToPublished(env, user, Number(m[1]));

  m = path.match(/^\/admin\/articles\/(\d+)\/delete$/);
  if (m && method === 'POST') return destroy(env, user, Number(m[1]));

  m = path.match(/^\/admin\/articles\/(\d+)\/revisions\/(\d+)\/restore$/);
  if (m && method === 'POST') return restoreRevision(env, user, Number(m[1]), Number(m[2]));

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function parseArr(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function getArticle(DB, id) {
  return DB.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
}

async function getArticleTagIds(DB, id) {
  const { results } = await DB.prepare('SELECT tag_id FROM article_tags WHERE article_id = ?').bind(id).all();
  return (results || []).map((r) => r.tag_id);
}

// Replace the article's tag set. Ids are validated against the tags table so a
// restored revision referencing a deleted tag can't violate the FK.
async function setArticleTags(DB, articleId, tagIds) {
  await DB.prepare('DELETE FROM article_tags WHERE article_id = ?').bind(articleId).run();
  for (const tid of tagIds) {
    await DB.prepare(
      'INSERT OR IGNORE INTO article_tags (article_id, tag_id) SELECT ?, id FROM tags WHERE id = ?'
    ).bind(articleId, tid).run();
  }
}

// Current series memberships for an article: series_id → position.
async function getArticleSeries(DB, id) {
  const { results } = await DB.prepare('SELECT series_id, position FROM article_series WHERE article_id = ?').bind(id).all();
  return new Map((results || []).map((r) => [r.series_id, r.position]));
}

// Replace an article's series memberships from the editor form: checkboxes
// `series_ids` (series id) plus a per-series position `series_pos_<id>`. Series
// ids are validated against the series table so a stale id can't break the FK.
async function setArticleSeries(DB, articleId, form) {
  const ids = form.getAll('series_ids').map(Number).filter(Boolean);
  await DB.prepare('DELETE FROM article_series WHERE article_id = ?').bind(articleId).run();
  for (const sid of ids) {
    const pos = parseInt(String(form.get(`series_pos_${sid}`) || '0'), 10) || 0;
    await DB.prepare(
      'INSERT OR IGNORE INTO article_series (article_id, series_id, position) SELECT ?, id, ? FROM series WHERE id = ?'
    ).bind(articleId, pos, sid).run();
  }
}

async function tagSlugsFor(DB, tagIds) {
  if (!tagIds.length) return [];
  const marks = tagIds.map(() => '?').join(',');
  const { results } = await DB.prepare(`SELECT slug FROM tags WHERE id IN (${marks})`).bind(...tagIds).all();
  return (results || []).map((r) => r.slug);
}

async function tagIdsForSlugs(DB, slugs) {
  if (!slugs?.length) return [];
  const marks = slugs.map(() => '?').join(',');
  const { results } = await DB.prepare(`SELECT id FROM tags WHERE slug IN (${marks})`).bind(...slugs).all();
  return (results || []).map((r) => r.id);
}

function articleFromForm(form) {
  const str = (k) => String(form.get(k) || '').trim();
  return {
    slug: slugify(str('slug') || str('title')) || `article-${Date.now()}`,
    title: str('title') || 'Untitled',
    subheading: str('subheading') || null,
    // Any category slug (validated against the managed list by the editor's
    // select). Sanitised to slug form; defaults to 'blog' when none is chosen.
    category: slugify(str('category')) || 'blog',
    publish_date: str('publish_date') || null,
    cover: str('cover') || null,
    // Palette surface key for the hero overlay ('' = site default). Keys only
    // ever contain [a-z0-9-] — strip anything else so it is safe in a class.
    hero_surface: str('hero_surface').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60),
    authors: form.getAll('authors').map(String),
    reviewers: form.getAll('reviewers').map(String),
    meta_title: str('meta_title') || null,
    meta_description: str('meta_description') || null,
    share_image: str('share_image') || null,
    content: String(form.get('content') || ''),
    comment_mode: COMMENT_MODES.includes(str('comment_mode')) ? str('comment_mode') : 'enabled',
    corrections_disabled: form.get('corrections_disabled') ? 1 : 0,
    tagIds: form.getAll('tags').map(Number).filter(Boolean),
  };
}

// One JSON shape for revisions AND published_snapshot: all content fields plus
// tag slugs (slugs survive tag deletion/re-creation better than ids).
async function recordOf(DB, data) {
  return {
    slug: data.slug, title: data.title, subheading: data.subheading,
    category: data.category, publish_date: data.publish_date, cover: data.cover,
    hero_surface: data.hero_surface || '',
    authors: data.authors, reviewers: data.reviewers,
    meta_title: data.meta_title, meta_description: data.meta_description,
    share_image: data.share_image, content: data.content,
    comment_mode: data.comment_mode,
    corrections_disabled: data.corrections_disabled,
    tags: await tagSlugsFor(DB, data.tagIds),
  };
}

async function updateArticle(DB, id, data, status) {
  await DB.prepare(
    `UPDATE articles SET slug = ?, title = ?, subheading = ?, category = ?, publish_date = ?,
       cover = ?, hero_surface = ?, authors = ?, reviewers = ?, meta_title = ?, meta_description = ?, share_image = ?,
       content = ?, comment_mode = ?, corrections_disabled = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    data.slug, data.title, data.subheading, data.category, data.publish_date,
    data.cover, data.hero_surface || '', JSON.stringify(data.authors), JSON.stringify(data.reviewers),
    data.meta_title, data.meta_description, data.share_image,
    data.content, data.comment_mode, data.corrections_disabled, status, id
  ).run();
  await setArticleTags(DB, id, data.tagIds);
}

const isSlugConflict = (err) => /UNIQUE/i.test(String(err?.message || err));

// ── List ─────────────────────────────────────────────────────────────────────

async function listPage(env, user, url) {
  const pageSize = await getPageSize(env.DB, user, url);
  const page = currentPage(url);
  const totalRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM articles').first();
  const total = totalRow ? totalRow.total : 0;
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, a.category, a.status, a.publish_date, a.scheduled_for,
            (SELECT COUNT(*) FROM comments c WHERE c.article_id = a.id) AS comment_count
     FROM articles a ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`
  ).bind(pageSize, (page - 1) * pageSize).all();
  const articles = results || [];

  const rows = articles.length ? articles.map((a) => {
    const scheduled = a.status === 'draft' && a.scheduled_for;
    const pill = scheduled ? 'scheduled' : a.status;
    return `
      <tr>
        <td class="cell-main"><a href="${BASE}/${a.id}">${escapeHtml(a.title)}</a></td>
        <td data-label="Category">${escapeHtml(a.category)}</td>
        <td data-label="Status"><span class="status-pill ${escapeAttr(pill)}">${escapeHtml(pill)}</span></td>
        <td data-label="Publish date">${escapeHtml(formatDate(a.publish_date) || '—')}</td>
        <td data-label="Comments">${a.comment_count}</td>
      </tr>`;
  }).join('')
    : '<tr><td colspan="5" class="muted">No articles yet.</td></tr>';

  const content = `
    <div class="page-head">
      <h1>Articles</h1>
      <div class="actions"><a class="btn" href="${BASE}/new">New article</a></div>
    </div>
    <table class="admin-table cards">
      <thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Publish date</th><th>Comments</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: 'Articles', path: BASE, content }));
}

// ── Editor ───────────────────────────────────────────────────────────────────

const EDITOR_HEAD = `
${MEDIA_PICKER_HEAD}
${CONFIRM_MODAL_HEAD}
${PREVIEW_HEAD}
<link rel="stylesheet" href="/css/wysiwyg.css">
<link rel="stylesheet" href="/css/blocks.css">
<script src="/js/wysiwyg.js" defer></script>
<style>
.rt-ed .gallery { cursor: pointer; }
.chk-group { max-height: 180px; overflow-y: auto; border: 1px solid var(--color-surface-dark); border-radius: var(--radius-sm); padding: 0.4rem 0.6rem; background: var(--color-bg); }
.chk-group label { display: flex; gap: 0.45rem; align-items: center; font-weight: 400; font-size: 0.9rem; margin: 0.15rem 0; }
.chk-group input { width: auto; }
.status-note { font-size: 0.82rem; color: var(--color-muted); }
.editor-side .card .field:last-child { margin-bottom: 0; }
.revisions-table td { font-size: 0.88rem; }
</style>`;

// Converts the local datetime picker to an ISO-UTC value on Schedule, and shows
// any stored ISO schedule time in the viewer's own timezone.
const SCHEDULE_SCRIPT = `<script>
(function () {
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-schedule-btn]');
    if (!b) return;
    var local = document.getElementById('scheduled_at_local');
    var hidden = document.getElementById('scheduled_for');
    if (local && hidden) hidden.value = local.value ? new Date(local.value).toISOString() : '';
  });
  document.querySelectorAll('[data-localtime]').forEach(function (el) {
    var iso = el.getAttribute('data-localtime'); if (!iso) return;
    var d = new Date(iso); if (!isNaN(d)) el.textContent = d.toLocaleString();
  });
})();
</script>`;

function statusPill(status) {
  const s = status || 'draft';
  const note = s === 'published' ? 'Live on the site.'
    : s === 'modified' ? 'Live, with unpublished changes — the site shows the last published version until you Publish.'
    : 'Not on the live site.';
  return `<span class="status-pill ${s}">${s}</span> <span class="status-note">${note}</span>`;
}

async function editPage(env, user, url, id) {
  const DB = env.DB;
  const article = id ? await getArticle(DB, id) : null;
  if (id && !article) {
    return html(adminPage({ env, user, title: 'Not found', path: BASE, content: '<h1>Article not found</h1>' }), { status: 404 });
  }
  const isNew = !article;
  const authors = article ? parseArr(article.authors) : [];
  const reviewers = article ? parseArr(article.reviewers) : [];
  const tagIds = article ? await getArticleTagIds(DB, id) : [];

  const people = (await DB.prepare('SELECT slug, name FROM people ORDER BY sort_order, name').all()).results || [];
  const tags = (await DB.prepare('SELECT id, title FROM tags ORDER BY title').all()).results || [];
  const categories = (await DB.prepare('SELECT slug, title FROM categories ORDER BY sort_order, title').all()).results || [];
  const seriesList = (await DB.prepare('SELECT id, title FROM series ORDER BY sort_order, title').all()).results || [];
  const seriesMembership = id ? await getArticleSeries(DB, id) : new Map();
  const revisions = article ? await getRevisions(DB, 'article', id) : [];

  // Hero colour choices: built-in surfaces plus any custom ones from the
  // palette designer (site_config 'surfaces'); custom labels live server-side
  // on the stored surface object.
  const storedSurfaces = (await getSiteConfig(DB, 'surfaces', {})) || {};
  const surfaceKeys = Array.from(new Set([...SURFACE_KEYS, ...Object.keys(storedSurfaces)]));
  const surfaceLabel = (key) => SURFACE_LABELS[key]
    || (storedSurfaces[key] && typeof storedSurfaces[key].label === 'string' && storedSurfaces[key].label)
    || key;
  const siteSettings = await getSiteSettings(DB);
  const correctionsOffSiteWide = (siteSettings.corrections_enabled ?? '1') === '0';
  const galleryDefault = siteSettings.gallery_layout_default === 'carousel' ? 'carousel' : 'grid';
  const heroSurface = article?.hero_surface || '';
  const heroOptions = [`<option value=""${heroSurface === '' ? ' selected' : ''}>Default (Slate dark)</option>`]
    .concat(surfaceKeys.map((k) =>
      `<option value="${escapeAttr(k)}"${heroSurface === k ? ' selected' : ''}>${escapeHtml(surfaceLabel(k))}</option>`))
    .join('');

  // Category select from the managed list. Preserve an article's stored slug
  // even if that category was since deleted (orphan) by adding it as an option.
  const curCat = article?.category || 'blog';
  const catList = categories.slice();
  if (curCat && !catList.some((c) => c.slug === curCat)) catList.push({ slug: curCat, title: `${curCat} (removed)` });
  const catOptions = catList.map((c) =>
    `<option value="${escapeAttr(c.slug)}"${curCat === c.slug ? ' selected' : ''}>${escapeHtml(c.title)}</option>`).join('');

  const v = (k) => escapeAttr(article?.[k] ?? '');
  const peopleChecks = (name, selected) => people.length
    ? people.map((p) => `<label><input type="checkbox" name="${name}" value="${escapeAttr(p.slug)}"${selected.includes(p.slug) ? ' checked' : ''}> ${escapeHtml(p.name)}</label>`).join('')
    : '<span class="muted small">No people yet — add some under People.</span>';
  const tagChecks = tags.length
    ? tags.map((t) => `<label><input type="checkbox" name="tags" value="${t.id}"${tagIds.includes(t.id) ? ' checked' : ''}> ${escapeHtml(t.title)}</label>`).join('')
    : '<span class="muted small">No tags yet — add some under Tags.</span>';

  // Series membership: a checkbox per series plus its position within that
  // series (only meaningful when checked). Multiple series per article.
  const seriesChecks = seriesList.length
    ? seriesList.map((s) => {
        const member = seriesMembership.has(s.id);
        const pos = member ? seriesMembership.get(s.id) : 0;
        return `<label class="series-row"><input type="checkbox" name="series_ids" value="${s.id}"${member ? ' checked' : ''}> <span>${escapeHtml(s.title)}</span>
          <input type="number" name="series_pos_${s.id}" value="${escapeAttr(String(pos))}" aria-label="Position in ${escapeAttr(s.title)}" title="Order within this series" style="width:4.5rem;margin-left:auto"></label>`;
      }).join('')
    : '<span class="muted small">No series yet — add some under Series.</span>';

  const err = url.searchParams.get('err');
  const notice = err === 'slug' ? '<div class="notice notice-error">That slug is already in use — pick another.</div>'
    : err === 'revision' ? '<div class="notice notice-error">Could not restore that revision.</div>'
    : err === 'schedule' ? '<div class="notice notice-error">Pick a date and time in the future to schedule.</div>'
    : err === 'publisher' ? '<div class="notice notice-error">Scheduling requires the publisher role.</div>'
    : url.searchParams.get('saved') ? '<div class="notice notice-green">Saved.</div>'
    : url.searchParams.get('published') ? '<div class="notice notice-green">Published — the article is live.</div>'
    : url.searchParams.get('scheduled') ? '<div class="notice notice-green">Scheduled — it will publish automatically at the chosen time.</div>'
    : url.searchParams.get('unscheduled') ? '<div class="notice notice-green">Schedule cancelled — the article is back to a normal draft.</div>'
    : url.searchParams.get('unpublished') ? '<div class="notice notice-green">Taken offline — it is back to draft and no longer on the site. Content and history are kept; press Publish to put it back.</div>'
    : '';

  const canPublish = roleAtLeast(user, 'publisher');
  const status = article?.status || 'draft';
  const action = isNew ? `${BASE}/new` : `${BASE}/${id}`;

  const revisionsHtml = !isNew && revisions.length ? `
    <h2 style="margin-top:2.2rem">Revisions</h2>
    <table class="admin-table revisions-table">
      <thead><tr><th>When</th><th>Summary</th><th>By</th><th></th></tr></thead>
      <tbody>
        ${revisions.map((r) => `
        <tr>
          <td>${escapeHtml((r.created_at || '').slice(0, 16).replace('T', ' '))}</td>
          <td>${escapeHtml(r.summary || '—')}</td>
          <td>${escapeHtml(r.user_name || '—')}</td>
          <td><form method="post" action="${BASE}/${id}/revisions/${r.id}/restore" style="margin:0">
            <button class="btn btn-secondary btn-small" type="submit" data-confirm="Restore this revision? It is applied as a new save (the live site is unaffected until you Publish)." data-confirm-ok="Restore" data-confirm-danger="0">Restore</button>
          </form></td>
        </tr>`).join('')}
      </tbody>
    </table>` : '';

  const content = `
    <form method="post" action="${action}">
      <div class="page-head">
        <h1>${isNew ? 'New article' : 'Edit article'}</h1>
        <div class="actions">
          ${previewButton(`${BASE}/preview`)}
          ${!isNew && status !== 'draft' ? `<a class="btn btn-secondary btn-small" href="/${escapeAttr(article.category)}/${escapeAttr(article.slug)}" target="_blank">View live ↗</a>` : ''}
          <button class="btn" type="submit">Save</button>
          ${!isNew && canPublish && status !== 'published' ? `<button class="btn btn-green" type="submit" formaction="${BASE}/${id}/publish">Publish</button>` : ''}
        </div>
      </div>
      ${notice}
      <div class="editor-columns">
        <div class="editor-main">
          <div class="field">
            <label for="title">Title</label>
            <input type="text" id="title" name="title" value="${v('title')}" required>
          </div>
          <div class="field">
            <label for="subheading">Subheading</label>
            <input type="text" id="subheading" name="subheading" value="${v('subheading')}">
          </div>
          <div class="field">
            <label>Body</label>
            <textarea name="content" data-richtext data-gallery data-gallery-default="${escapeAttr(galleryDefault)}">${escapeHtml(article?.content ?? '')}</textarea>
          </div>
        </div>
        <aside class="editor-side">
          <div class="card">
            <div class="field">
              <label>Status</label>
              ${statusPill(status)}
            </div>
            <div class="field">
              <label for="slug">Slug</label>
              <input type="text" id="slug" name="slug" value="${v('slug')}" placeholder="from the title if empty">
            </div>
            <div class="field">
              <label for="category">Category</label>
              <select id="category" name="category">${catOptions}</select>
              <div class="hint">Manage the list under <a href="/admin/categories">Categories</a>.</div>
            </div>
            <div class="field">
              <label for="publish_date">Publish date</label>
              <input type="date" id="publish_date" name="publish_date" value="${v('publish_date')}">
              <div class="hint">Set on first publish if left empty.</div>
            </div>
            ${canPublish && status === 'draft' ? `
            <div class="field">
              <label>Schedule</label>
              ${article?.scheduled_for ? `
              <p class="hint">Publishes automatically on <strong><span data-localtime="${escapeAttr(article.scheduled_for)}">${escapeHtml(article.scheduled_for)}</span></strong> (checked every 15 min).</p>
              <button class="btn btn-secondary btn-small" type="submit" formaction="${BASE}/${id}/unschedule" formnovalidate>Cancel schedule</button>
              ` : (isNew ? `
              <p class="hint">Save the article first, then you can schedule it to publish later.</p>
              ` : `
              <input type="datetime-local" id="scheduled_at_local" name="scheduled_at_local">
              <input type="hidden" id="scheduled_for" name="scheduled_for">
              <div class="hint">Saves the current draft and publishes it automatically at the chosen time.</div>
              <button class="btn btn-small" type="submit" formaction="${BASE}/${id}/schedule" data-schedule-btn style="margin-top:0.4rem">Schedule</button>
              `)}
            </div>` : ''}
            <div class="field">
              <label for="cover">Cover image URL</label>
              <input type="text" id="cover" name="cover" value="${v('cover')}" placeholder="https://… or /media/…" data-media>
            </div>
            <div class="field">
              <label for="hero_surface">Hero colour</label>
              <select id="hero_surface" name="hero_surface">${heroOptions}</select>
              <div class="hint">Palette surface tinting the article hero (over the cover image).</div>
            </div>
            <div class="field">
              <label>Authors</label>
              <div class="chk-group">${peopleChecks('authors', authors)}</div>
            </div>
            <div class="field">
              <label>Reviewers</label>
              <div class="chk-group">${peopleChecks('reviewers', reviewers)}</div>
            </div>
            <div class="field">
              <label>Tags</label>
              <div class="chk-group">${tagChecks}</div>
            </div>
            <div class="field">
              <label>Series</label>
              <div class="chk-group">${seriesChecks}</div>
              <div class="hint">Tick a series and set this post's position (order) within it.</div>
            </div>
            <div class="field">
              <label for="meta_title">Meta title</label>
              <input type="text" id="meta_title" name="meta_title" value="${v('meta_title')}" placeholder="Defaults to the title">
            </div>
            <div class="field">
              <label for="meta_description">Meta description</label>
              <textarea id="meta_description" name="meta_description" style="min-height:70px">${escapeHtml(article?.meta_description ?? '')}</textarea>
            </div>
            <div class="field">
              <label for="share_image">Share image URL</label>
              <input type="text" id="share_image" name="share_image" value="${v('share_image')}" placeholder="Defaults to the cover" data-media>
            </div>
            <div class="field">
              <label for="comment_mode">Comments</label>
              <select id="comment_mode" name="comment_mode">
                ${COMMENT_MODE_OPTIONS.map(([val, label]) =>
                  `<option value="${val}"${(article?.comment_mode || 'enabled') === val ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
              </select>
              <p class="hint">Enabled: anyone can comment. Readers only: logged-in readers only. Closed: existing comments stay visible, no new ones. Disabled: hide all comments (kept, not deleted — restored if re-enabled). All comments are moderated.</p>
            </div>
            <div class="field">
              <label style="display:flex;gap:0.45rem;align-items:center;font-weight:400${correctionsOffSiteWide ? ';opacity:0.55' : ''}">
                <input type="checkbox" ${correctionsOffSiteWide ? 'disabled' : 'name="corrections_disabled"'} value="1" style="width:auto"${article?.corrections_disabled ? ' checked' : ''}>
                Disable corrections on this article
              </label>
              ${correctionsOffSiteWide
                ? `<input type="hidden" name="corrections_disabled" value="${article?.corrections_disabled ? '1' : '0'}"><p class="hint">Corrections are turned off site-wide in <a href="/admin/settings">Settings</a>.</p>`
                : ''}
            </div>
            ${!isNew ? `
            <div class="field" style="display:flex;gap:0.5rem;flex-wrap:wrap">
              ${status === 'modified' ? `<button class="btn btn-secondary btn-small" type="submit" formaction="${BASE}/${id}/revert" data-confirm="Discard the unpublished changes and restore the live version?" data-confirm-ok="Revert">Revert to published</button>` : ''}
              ${canPublish && status !== 'draft' ? `<button class="btn btn-secondary btn-small" type="submit" formaction="${BASE}/${id}/unpublish" formnovalidate data-confirm="Take this article offline? It returns to draft and disappears from the site. Content and history are kept — you can publish it again anytime." data-confirm-ok="Take offline">Unpublish</button>` : ''}
              <button class="btn btn-danger btn-small" type="submit" formaction="${BASE}/${id}/delete" data-confirm="Delete this article and its comments? This cannot be undone." data-confirm-ok="Delete">Delete</button>
            </div>` : ''}
          </div>
        </aside>
      </div>
    </form>
    ${revisionsHtml}
    ${SCHEDULE_SCRIPT}`;

  return html(adminPage({
    env, user, title: isNew ? 'New article' : `Edit: ${article.title}`, path: BASE, content, extraHead: EDITOR_HEAD,
  }));
}

// ── Mutations ────────────────────────────────────────────────────────────────

async function create(request, env, user) {
  const DB = env.DB;
  const form = await request.formData();
  const data = articleFromForm(form);
  let id;
  try {
    const res = await DB.prepare(
      `INSERT INTO articles (slug, title, subheading, category, publish_date, cover, hero_surface, authors, reviewers,
         meta_title, meta_description, share_image, content, comment_mode, corrections_disabled, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
    ).bind(
      data.slug, data.title, data.subheading, data.category, data.publish_date,
      data.cover, data.hero_surface || '', JSON.stringify(data.authors), JSON.stringify(data.reviewers),
      data.meta_title, data.meta_description, data.share_image, data.content, data.comment_mode, data.corrections_disabled
    ).run();
    id = res.meta.last_row_id;
  } catch (err) {
    if (isSlugConflict(err)) return redirect(`${BASE}/new?err=slug`);
    throw err;
  }
  await setArticleTags(DB, id, data.tagIds);
  await setArticleSeries(DB, id, form);
  await saveRevision(DB, 'article', id, await recordOf(DB, data), data.title, user);
  await logActivity(DB, user, 'created', 'article', data.title);
  return redirect(`${BASE}/${id}?saved=1`);
}

async function save(request, env, user, id) {
  const DB = env.DB;
  const article = await getArticle(DB, id);
  if (!article) return redirect(BASE);
  const form = await request.formData();
  const data = articleFromForm(form);
  // Draft stays draft; a live article gains unpublished changes → modified.
  const status = article.status === 'draft' ? 'draft' : 'modified';
  try {
    await updateArticle(DB, id, data, status);
  } catch (err) {
    if (isSlugConflict(err)) return redirect(`${BASE}/${id}?err=slug`);
    throw err;
  }
  await setArticleSeries(DB, id, form);
  await saveRevision(DB, 'article', id, await recordOf(DB, data), data.title, user);
  await logActivity(DB, user, 'updated', 'article', data.title);
  return redirect(`${BASE}/${id}?saved=1`);
}

// Reconstruct the articleFromForm-shaped data object from a stored row — used by
// the scheduler, which publishes an article's already-saved draft content with
// no form in hand.
async function dataFromRow(DB, row) {
  const arr = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
  return {
    slug: row.slug, title: row.title, subheading: row.subheading,
    category: row.category || 'blog',
    publish_date: row.publish_date, cover: row.cover, hero_surface: row.hero_surface || '',
    authors: arr(row.authors), reviewers: arr(row.reviewers),
    meta_title: row.meta_title, meta_description: row.meta_description, share_image: row.share_image,
    content: row.content || '', comment_mode: row.comment_mode || 'enabled',
    corrections_disabled: row.corrections_disabled ? 1 : 0,
    tagIds: await getArticleTagIds(DB, row.id),
  };
}

// Freeze `data` as the live version: write the columns, snapshot it, set
// 'published', clear any schedule, record a revision, and (first publish only)
// email subscribers. Shared by the manual Publish action and the scheduler.
async function finalizePublish(env, id, user, data) {
  const DB = env.DB;
  const article = await getArticle(DB, id);
  if (!data.publish_date) data.publish_date = new Date().toISOString().slice(0, 10);
  const snapshot = await recordOf(DB, data);
  const firstPublish = !article.published_snapshot;
  await updateArticle(DB, id, data, 'published');
  await DB.prepare('UPDATE articles SET published_snapshot = ?, scheduled_for = NULL WHERE id = ?')
    .bind(JSON.stringify(snapshot), id).run();
  await saveRevision(DB, 'article', id, snapshot, `${data.title} (published)`, user);
  await logActivity(DB, user, 'published', 'article', data.title);
  if (firstPublish) {
    await notifyNewArticle(env, await getArticle(DB, id)); // first time live → email subscribers
  }
}

// Publish due scheduled articles. Called from the Worker's scheduled() cron.
// Returns the number published. A synthetic user attributes the activity/revision.
export async function publishScheduledArticles(env) {
  const DB = env.DB;
  const now = new Date().toISOString();
  let rows;
  try {
    ({ results: rows } = await DB.prepare(
      `SELECT * FROM articles WHERE status = 'draft' AND scheduled_for IS NOT NULL AND scheduled_for <= ?`
    ).bind(now).all());
  } catch { return 0; } // column missing (un-migrated) → nothing to do
  let published = 0;
  for (const row of rows || []) {
    try {
      await finalizePublish(env, row.id, { id: null, name: 'Scheduler' }, await dataFromRow(DB, row));
      published++;
    } catch (err) {
      console.error('[schedule] failed to publish article', row.id, err?.message || err);
    }
  }
  return published;
}

async function publish(request, env, user, id) {
  const DB = env.DB;
  if (!roleAtLeast(user, 'publisher')) {
    return html(adminPage({
      env, user, title: 'Forbidden', path: BASE,
      content: '<h1>Publisher role required</h1><p class="muted">Ask a publisher or admin to publish this article.</p>',
    }), { status: 403 });
  }
  const article = await getArticle(DB, id);
  if (!article) return redirect(BASE);

  // Publish submits the edit form: apply the save, then freeze it as the snapshot.
  const form = await request.formData();
  const data = articleFromForm(form);
  try {
    await finalizePublish(env, id, user, data);
  } catch (err) {
    if (isSlugConflict(err)) return redirect(`${BASE}/${id}?err=slug`);
    throw err;
  }
  await setArticleSeries(DB, id, form);
  return redirect(`${BASE}/${id}?published=1`);
}

// Save the current edits and schedule the article to auto-publish at a future
// time. Publisher-gated (it will publish without further review). scheduled_for
// arrives as an ISO-UTC string (the editor converts the local picker value).
async function schedule(request, env, user, id) {
  const DB = env.DB;
  if (!roleAtLeast(user, 'publisher')) return redirect(`${BASE}/${id}?err=publisher`);
  const article = await getArticle(DB, id);
  if (!article) return redirect(BASE);
  const form = await request.formData();
  const when = String(form.get('scheduled_for') || '').trim();
  const ts = when ? new Date(when) : null;
  if (!ts || isNaN(ts) || ts.getTime() <= Date.now()) {
    return redirect(`${BASE}/${id}?err=schedule`);
  }
  const data = articleFromForm(form);
  try {
    await updateArticle(DB, id, data, 'draft'); // stays hidden until the cron publishes it
  } catch (err) {
    if (isSlugConflict(err)) return redirect(`${BASE}/${id}?err=slug`);
    throw err;
  }
  await DB.prepare('UPDATE articles SET scheduled_for = ? WHERE id = ?').bind(ts.toISOString(), id).run();
  await setArticleSeries(DB, id, form);
  await saveRevision(DB, 'article', id, await recordOf(DB, data), `${data.title} (scheduled)`, user);
  await logActivity(DB, user, 'scheduled', 'article', data.title);
  return redirect(`${BASE}/${id}?scheduled=1`);
}

async function unschedule(env, user, id) {
  const DB = env.DB;
  const article = await getArticle(DB, id);
  if (!article) return redirect(BASE);
  await DB.prepare('UPDATE articles SET scheduled_for = NULL WHERE id = ?').bind(id).run();
  await logActivity(DB, user, 'unscheduled', 'article', article.title);
  return redirect(`${BASE}/${id}?unscheduled=1`);
}

// Take a live article offline: return it to 'draft' so it drops out of every
// public listing/view, keeping its content, published_snapshot and revisions.
// Re-publishing later snapshots the current working copy as usual.
async function unpublish(env, user, id) {
  const DB = env.DB;
  if (!roleAtLeast(user, 'publisher')) return redirect(`${BASE}/${id}?err=publisher`);
  const article = await getArticle(DB, id);
  if (!article) return redirect(BASE);
  if (article.status === 'draft') return redirect(`${BASE}/${id}`);
  await DB.prepare(
    "UPDATE articles SET status = 'draft', scheduled_for = NULL, updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
  await logActivity(DB, user, 'unpublished', 'article', article.title);
  return redirect(`${BASE}/${id}?unpublished=1`);
}

// Discard unpublished edits: copy the frozen snapshot back over the row.
async function revertToPublished(env, user, id) {
  const DB = env.DB;
  const article = await getArticle(DB, id);
  if (!article?.published_snapshot) return redirect(`${BASE}/${id}`);
  let snap;
  try { snap = JSON.parse(article.published_snapshot); } catch { return redirect(`${BASE}/${id}`); }

  const data = {
    slug: snap.slug, title: snap.title, subheading: snap.subheading ?? null,
    category: snap.category || 'blog',
    publish_date: snap.publish_date ?? null, cover: snap.cover ?? null,
    hero_surface: snap.hero_surface ?? '',
    authors: Array.isArray(snap.authors) ? snap.authors : [],
    reviewers: Array.isArray(snap.reviewers) ? snap.reviewers : [],
    meta_title: snap.meta_title ?? null, meta_description: snap.meta_description ?? null,
    share_image: snap.share_image ?? null, content: snap.content ?? '',
    comment_mode: snap.comment_mode || (snap.comments_disabled ? 'closed' : 'enabled'),
    tagIds: await tagIdsForSlugs(DB, snap.tags),
  };
  await updateArticle(DB, id, data, 'published');
  await saveRevision(DB, 'article', id, snap, `${data.title} (reverted to published)`, user);
  await logActivity(DB, user, 'reverted', 'article', data.title);
  return redirect(`${BASE}/${id}?saved=1`);
}

async function destroy(env, user, id) {
  const DB = env.DB;
  const article = await getArticle(DB, id);
  if (!article) return redirect(BASE);
  await DB.prepare('DELETE FROM articles WHERE id = ?').bind(id).run(); // tags/comments cascade
  await logActivity(DB, user, 'deleted', 'article', article.title);
  return redirect(BASE);
}

// Apply a stored revision as a new save (same status rules as save — the live
// site is untouched until Publish).
async function restoreRevision(env, user, id, revisionId) {
  const DB = env.DB;
  const article = await getArticle(DB, id);
  const rev = await getRevision(DB, revisionId);
  if (!article || !rev || rev.entity_type !== 'article' || rev.entity_id !== id) {
    return redirect(`${BASE}/${id}?err=revision`);
  }
  let r;
  try { r = JSON.parse(rev.data); } catch { return redirect(`${BASE}/${id}?err=revision`); }

  const data = {
    slug: r.slug || article.slug, title: r.title || 'Untitled', subheading: r.subheading ?? null,
    category: r.category || 'blog',
    publish_date: r.publish_date ?? null, cover: r.cover ?? null,
    hero_surface: r.hero_surface ?? '',
    authors: Array.isArray(r.authors) ? r.authors : [],
    reviewers: Array.isArray(r.reviewers) ? r.reviewers : [],
    meta_title: r.meta_title ?? null, meta_description: r.meta_description ?? null,
    share_image: r.share_image ?? null, content: r.content ?? '',
    comment_mode: r.comment_mode || (r.comments_disabled ? 'closed' : 'enabled'),
    tagIds: await tagIdsForSlugs(DB, r.tags),
  };
  const status = article.status === 'draft' ? 'draft' : 'modified';
  try {
    await updateArticle(DB, id, data, status);
  } catch (err) {
    if (isSlugConflict(err)) return redirect(`${BASE}/${id}?err=slug`);
    throw err;
  }
  await saveRevision(DB, 'article', id, await recordOf(DB, data), `${data.title} (restored)`, user);
  await logActivity(DB, user, 'restored a revision of', 'article', data.title);
  return redirect(`${BASE}/${id}?saved=1`);
}
