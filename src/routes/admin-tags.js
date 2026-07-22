// Admin: /admin/tags* — flat CRUD for article tags. Deleting a tag detaches it
// from articles (article_tags cascades); published snapshots keep the slug but
// the public /tags/:slug page 404s once the tag row is gone.

import { logActivity } from '../db.js';
import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';
import { MEDIA_PICKER_HEAD } from './admin-media.js';

const BASE = '/admin/tags';

// Rich-text editor assets for the description field (media picker powers the
// editor's image Browse… button).
const RICHTEXT_HEAD = `${MEDIA_PICKER_HEAD}<link rel="stylesheet" href="/css/wysiwyg.css"><script src="/js/wysiwyg.js" defer></script>`;

// Descriptions are stored as rich HTML — the list table shows a short
// plain-text excerpt so the card layout stays tidy.
function plainExcerpt(htmlStr, max = 120) {
  const text = String(htmlStr || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

export async function handleTags(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '') || BASE;
  const method = request.method;

  if (path === BASE && method === 'GET') return listPage(env, user, url);

  if (path === `${BASE}/new`) {
    if (method === 'GET') return editPage(env, user, url, null);
    if (method === 'POST') return upsert(request, env, user, null);
  }

  let m = path.match(/^\/admin\/tags\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'GET') return editPage(env, user, url, id);
    if (method === 'POST') return upsert(request, env, user, id);
  }

  m = path.match(/^\/admin\/tags\/(\d+)\/delete$/);
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

async function getTag(DB, id) {
  return DB.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first();
}

async function listPage(env, user, url) {
  const pageSize = await getPageSize(env.DB, user, url);
  const page = currentPage(url);
  const totalRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM tags').first();
  const total = totalRow ? totalRow.total : 0;
  const { results } = await env.DB.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM article_tags at WHERE at.tag_id = t.id) AS article_count
     FROM tags t ORDER BY t.title LIMIT ? OFFSET ?`
  ).bind(pageSize, (page - 1) * pageSize).all();
  const tags = results || [];

  const rows = tags.length ? tags.map((t) => `
      <tr>
        <td class="cell-main"><a href="${BASE}/${t.id}">${escapeHtml(t.title)}</a></td>
        <td data-label="URL"><code>/tags/${escapeHtml(t.slug)}</code></td>
        <td data-label="Description">${escapeHtml(plainExcerpt(t.description) || '—')}</td>
        <td data-label="Articles">${t.article_count}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No tags yet.</td></tr>';

  const content = `
    <div class="page-head">
      <h1>Tags</h1>
      <div class="actions"><a class="btn" href="${BASE}/new">New tag</a></div>
    </div>
    <table class="admin-table cards">
      <thead><tr><th>Title</th><th>URL</th><th>Description</th><th>Articles</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: 'Tags', path: BASE, content }));
}

async function editPage(env, user, url, id) {
  const tag = id ? await getTag(env.DB, id) : null;
  if (id && !tag) {
    return html(adminPage({ env, user, title: 'Not found', path: BASE, content: '<h1>Tag not found</h1>' }), { status: 404 });
  }
  const isNew = !tag;
  const err = url.searchParams.get('err');
  const notice = err === 'slug' ? '<div class="notice notice-error">That slug is already in use — pick another.</div>'
    : err === 'title' ? '<div class="notice notice-error">A title is required.</div>'
    : '';

  const content = `
    <div class="page-head"><h1>${isNew ? 'New tag' : 'Edit tag'}</h1></div>
    ${notice}
    <form method="post" action="${isNew ? `${BASE}/new` : `${BASE}/${id}`}" style="max-width:680px">
      <div class="field">
        <label for="title">Title</label>
        <input type="text" id="title" name="title" value="${escapeAttr(tag?.title ?? '')}" required>
      </div>
      <div class="field">
        <label for="slug">Slug</label>
        <input type="text" id="slug" name="slug" value="${escapeAttr(tag?.slug ?? '')}" placeholder="from the title if empty">
        <div class="hint">Public page: /tags/&lt;slug&gt;</div>
      </div>
      <div class="field">
        <label for="description">Description</label>
        <textarea id="description" name="description" data-richtext style="min-height:120px">${escapeHtml(tag?.description ?? '')}</textarea>
        <div class="hint">Shown at the top of the public /tags/&lt;slug&gt; page.</div>
      </div>
      <div style="display:flex;gap:0.6rem;flex-wrap:wrap">
        <button class="btn" type="submit">Save</button>
        <a class="btn btn-secondary" href="${BASE}">Cancel</a>
        ${!isNew ? `<button class="btn btn-danger" type="submit" formaction="${BASE}/${id}/delete" data-confirm="Delete this tag? It is removed from all articles." data-confirm-ok="Delete">Delete</button>` : ''}
      </div>
    </form>`;

  return html(adminPage({ env, user, title: isNew ? 'New tag' : `Edit tag: ${tag.title}`, path: BASE, content, extraHead: CONFIRM_MODAL_HEAD + RICHTEXT_HEAD }));
}

async function upsert(request, env, user, id) {
  const DB = env.DB;
  const form = await request.formData();
  const title = String(form.get('title') || '').trim();
  const slug = slugify(String(form.get('slug') || '').trim() || title);
  const description = String(form.get('description') || '').trim() || null;
  const back = id ? `${BASE}/${id}` : `${BASE}/new`;
  if (!title || !slug) return redirect(`${back}?err=title`);

  try {
    if (id) {
      const existing = await getTag(DB, id);
      if (!existing) return redirect(BASE);
      await DB.prepare('UPDATE tags SET title = ?, slug = ?, description = ? WHERE id = ?')
        .bind(title, slug, description, id).run();
      await logActivity(DB, user, 'updated', 'tag', title);
    } else {
      await DB.prepare('INSERT INTO tags (title, slug, description) VALUES (?, ?, ?)')
        .bind(title, slug, description).run();
      await logActivity(DB, user, 'created', 'tag', title);
    }
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || err))) return redirect(`${back}?err=slug`);
    throw err;
  }
  return redirect(BASE);
}

async function destroy(env, user, id) {
  const DB = env.DB;
  const tag = await getTag(DB, id);
  if (!tag) return redirect(BASE);
  await DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run(); // article_tags cascades
  await logActivity(DB, user, 'deleted', 'tag', tag.title);
  return redirect(BASE);
}
