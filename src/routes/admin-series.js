// Admin: /admin/series* — flat CRUD for article series (trips). Membership and
// per-series ordering are edited on the article itself (a checkbox + position
// per series); this screen manages the series records. Deleting a series
// detaches it from every article (article_series cascades); an article's other
// series and its content are untouched.

import { logActivity } from '../db.js';
import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';
import { MEDIA_PICKER_HEAD } from './admin-media.js';

const BASE = '/admin/series';

// Rich-text + media-picker assets (description editor, cover Browse… button).
const RICHTEXT_HEAD = `${MEDIA_PICKER_HEAD}<link rel="stylesheet" href="/css/wysiwyg.css"><script src="/js/wysiwyg.js" defer></script>`;

function plainExcerpt(htmlStr, max = 120) {
  const text = String(htmlStr || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

export async function handleSeries(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '') || BASE;
  const method = request.method;

  if (path === BASE && method === 'GET') return listPage(env, user, url);

  if (path === `${BASE}/new`) {
    if (method === 'GET') return editPage(env, user, url, null);
    if (method === 'POST') return upsert(request, env, user, null);
  }

  let m = path.match(/^\/admin\/series\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'GET') return editPage(env, user, url, id);
    if (method === 'POST') return upsert(request, env, user, id);
  }

  m = path.match(/^\/admin\/series\/(\d+)\/delete$/);
  if (m && method === 'POST') return destroy(env, user, Number(m[1]));

  return null;
}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function getSeries(DB, id) {
  return DB.prepare('SELECT * FROM series WHERE id = ?').bind(id).first();
}

async function listPage(env, user, url) {
  const pageSize = await getPageSize(env.DB, user, url);
  const page = currentPage(url);
  const totalRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM series').first();
  const total = totalRow ? totalRow.total : 0;
  const { results } = await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM article_series a WHERE a.series_id = s.id) AS article_count
     FROM series s ORDER BY s.sort_order, s.title LIMIT ? OFFSET ?`
  ).bind(pageSize, (page - 1) * pageSize).all();
  const series = results || [];

  const rows = series.length ? series.map((s) => `
      <tr>
        <td class="cell-main"><a href="${BASE}/${s.id}">${escapeHtml(s.title)}</a></td>
        <td data-label="URL"><code>/series/${escapeHtml(s.slug)}</code></td>
        <td data-label="Description">${escapeHtml(plainExcerpt(s.description) || '—')}</td>
        <td data-label="Articles">${s.article_count}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No series yet.</td></tr>';

  const content = `
    <div class="page-head">
      <h1>Series</h1>
      <div class="actions"><a class="btn" href="${BASE}/new">New series</a></div>
    </div>
    <p class="muted" style="margin-top:-0.4rem">A series is an ordered trip. Add articles to a series (and set their order) from each article's editor.</p>
    <table class="admin-table cards">
      <thead><tr><th>Title</th><th>URL</th><th>Description</th><th>Articles</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: 'Series', path: BASE, content }));
}

async function editPage(env, user, url, id) {
  const s = id ? await getSeries(env.DB, id) : null;
  if (id && !s) {
    return html(adminPage({ env, user, title: 'Not found', path: BASE, content: '<h1>Series not found</h1>' }), { status: 404 });
  }
  const isNew = !s;
  const err = url.searchParams.get('err');
  const notice = err === 'slug' ? '<div class="notice notice-error">That slug is already in use — pick another.</div>'
    : err === 'title' ? '<div class="notice notice-error">A title is required.</div>'
    : '';

  // For an existing series, show its members in reading order so the editor can
  // sanity-check the sequence (order itself is set on each article).
  let membersHtml = '';
  if (!isNew) {
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.title, a.status, asx.position
       FROM article_series asx JOIN articles a ON a.id = asx.article_id
       WHERE asx.series_id = ? ORDER BY asx.position, a.publish_date, a.id`
    ).bind(id).all();
    const rows = (results || []).map((a) => `
      <tr>
        <td>${escapeHtml(String(a.position))}</td>
        <td><a href="/admin/articles/${a.id}">${escapeHtml(a.title)}</a></td>
        <td>${escapeHtml(a.status)}</td>
      </tr>`).join('');
    membersHtml = `
      <h2 style="margin-top:2rem">Articles in this series</h2>
      ${rows ? `<table class="admin-table cards"><thead><tr><th>Pos</th><th>Article</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="muted">No articles yet — add this series to an article from its editor.</p>'}`;
  }

  const content = `
    <div class="page-head"><h1>${isNew ? 'New series' : 'Edit series'}</h1></div>
    ${notice}
    <form method="post" action="${isNew ? `${BASE}/new` : `${BASE}/${id}`}" style="max-width:680px">
      <div class="field">
        <label for="title">Title</label>
        <input type="text" id="title" name="title" value="${escapeAttr(s?.title ?? '')}" required>
      </div>
      <div class="field">
        <label for="slug">Slug</label>
        <input type="text" id="slug" name="slug" value="${escapeAttr(s?.slug ?? '')}" placeholder="from the title if empty">
        <div class="hint">Public page: /series/&lt;slug&gt;. Changing it moves that page's URL.</div>
      </div>
      <div class="field">
        <label for="sort_order">Sort order</label>
        <input type="number" id="sort_order" name="sort_order" value="${escapeAttr(String(s?.sort_order ?? 0))}" style="max-width:8rem">
        <div class="hint">Lower numbers first where series are listed.</div>
      </div>
      <div class="field">
        <label for="cover">Cover image URL</label>
        <input type="text" id="cover" name="cover" value="${escapeAttr(s?.cover ?? '')}" placeholder="https://… or /media/…" data-media>
      </div>
      <div class="field">
        <label for="description">Description</label>
        <textarea id="description" name="description" data-richtext style="min-height:120px">${escapeHtml(s?.description ?? '')}</textarea>
        <div class="hint">Shown at the top of the public /series/&lt;slug&gt; page.</div>
      </div>
      <div style="display:flex;gap:0.6rem;flex-wrap:wrap">
        <button class="btn" type="submit">Save</button>
        <a class="btn btn-secondary" href="${BASE}">Cancel</a>
        ${!isNew ? `<button class="btn btn-danger" type="submit" formaction="${BASE}/${id}/delete" data-confirm="Delete this series? It is removed from all articles (their content is untouched)." data-confirm-ok="Delete">Delete</button>` : ''}
      </div>
    </form>
    ${membersHtml}`;

  return html(adminPage({ env, user, title: isNew ? 'New series' : `Edit series: ${s.title}`, path: BASE, content, extraHead: CONFIRM_MODAL_HEAD + RICHTEXT_HEAD }));
}

async function upsert(request, env, user, id) {
  const DB = env.DB;
  const form = await request.formData();
  const title = String(form.get('title') || '').trim();
  const slug = slugify(String(form.get('slug') || '').trim() || title);
  const description = String(form.get('description') || '').trim() || null;
  const cover = String(form.get('cover') || '').trim() || null;
  const sortOrder = parseInt(String(form.get('sort_order') || '0'), 10) || 0;
  const back = id ? `${BASE}/${id}` : `${BASE}/new`;
  if (!title || !slug) return redirect(`${back}?err=title`);

  try {
    if (id) {
      const existing = await getSeries(DB, id);
      if (!existing) return redirect(BASE);
      await DB.prepare('UPDATE series SET title = ?, slug = ?, description = ?, cover = ?, sort_order = ? WHERE id = ?')
        .bind(title, slug, description, cover, sortOrder, id).run();
      await logActivity(DB, user, 'updated', 'series', title);
    } else {
      await DB.prepare('INSERT INTO series (title, slug, description, cover, sort_order) VALUES (?, ?, ?, ?, ?)')
        .bind(title, slug, description, cover, sortOrder).run();
      await logActivity(DB, user, 'created', 'series', title);
    }
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || err))) return redirect(`${back}?err=slug`);
    throw err;
  }
  return redirect(BASE);
}

async function destroy(env, user, id) {
  const DB = env.DB;
  const s = await getSeries(DB, id);
  if (!s) return redirect(BASE);
  await DB.prepare('DELETE FROM series WHERE id = ?').bind(id).run(); // article_series cascades
  await logActivity(DB, user, 'deleted', 'series', s.title);
  return redirect(BASE);
}
