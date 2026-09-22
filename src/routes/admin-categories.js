// Admin: /admin/categories* — flat CRUD for article categories. Each article
// stores one category slug in articles.category; a category's public listing is
// /category/:slug. Deleting a category leaves the slug on any article that used
// it (its permalink is /posts/:slug regardless), so those articles keep working
// — only the /category/:slug listing 404s, exactly like tags.

import { logActivity } from '../db.js';
import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';
import { MEDIA_PICKER_HEAD } from './admin-media.js';

const BASE = '/admin/categories';

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

export async function handleCategories(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '') || BASE;
  const method = request.method;

  if (path === BASE && method === 'GET') return listPage(env, user, url);

  if (path === `${BASE}/new`) {
    if (method === 'GET') return editPage(env, user, url, null);
    if (method === 'POST') return upsert(request, env, user, null);
  }

  let m = path.match(/^\/admin\/categories\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'GET') return editPage(env, user, url, id);
    if (method === 'POST') return upsert(request, env, user, id);
  }

  m = path.match(/^\/admin\/categories\/(\d+)\/delete$/);
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

async function getCategory(DB, id) {
  return DB.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first();
}

async function listPage(env, user, url) {
  const pageSize = await getPageSize(env.DB, user, url);
  const page = currentPage(url);
  const totalRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM categories').first();
  const total = totalRow ? totalRow.total : 0;
  const { results } = await env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category = c.slug) AS article_count
     FROM categories c ORDER BY c.sort_order, c.title LIMIT ? OFFSET ?`
  ).bind(pageSize, (page - 1) * pageSize).all();
  const categories = results || [];

  const rows = categories.length ? categories.map((c) => `
      <tr>
        <td class="cell-main"><a href="${BASE}/${c.id}">${escapeHtml(c.title)}</a></td>
        <td data-label="URL"><code>/category/${escapeHtml(c.slug)}</code></td>
        <td data-label="Description">${escapeHtml(plainExcerpt(c.description) || '—')}</td>
        <td data-label="Articles">${c.article_count}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No categories yet.</td></tr>';

  const content = `
    <div class="page-head">
      <h1>Categories</h1>
      <div class="actions"><a class="btn" href="${BASE}/new">New category</a></div>
    </div>
    <table class="admin-table cards">
      <thead><tr><th>Title</th><th>URL</th><th>Description</th><th>Articles</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: 'Categories', path: BASE, content }));
}

async function editPage(env, user, url, id) {
  const cat = id ? await getCategory(env.DB, id) : null;
  if (id && !cat) {
    return html(adminPage({ env, user, title: 'Not found', path: BASE, content: '<h1>Category not found</h1>' }), { status: 404 });
  }
  const isNew = !cat;
  const err = url.searchParams.get('err');
  const notice = err === 'slug' ? '<div class="notice notice-error">That slug is already in use — pick another.</div>'
    : err === 'title' ? '<div class="notice notice-error">A title is required.</div>'
    : '';

  const content = `
    <div class="page-head"><h1>${isNew ? 'New category' : 'Edit category'}</h1></div>
    ${notice}
    <form method="post" action="${isNew ? `${BASE}/new` : `${BASE}/${id}`}" style="max-width:680px">
      <div class="field">
        <label for="title">Title</label>
        <input type="text" id="title" name="title" value="${escapeAttr(cat?.title ?? '')}" required>
      </div>
      <div class="field">
        <label for="slug">Slug</label>
        <input type="text" id="slug" name="slug" value="${escapeAttr(cat?.slug ?? '')}" placeholder="from the title if empty">
        <div class="hint">Public page: /category/&lt;slug&gt;. Changing it moves that listing's URL.</div>
      </div>
      <div class="field">
        <label for="sort_order">Sort order</label>
        <input type="number" id="sort_order" name="sort_order" value="${escapeAttr(String(cat?.sort_order ?? 0))}" style="max-width:8rem">
        <div class="hint">Lower numbers first in the category dropdown.</div>
      </div>
      <div class="field">
        <label for="description">Description</label>
        <textarea id="description" name="description" data-richtext style="min-height:120px">${escapeHtml(cat?.description ?? '')}</textarea>
        <div class="hint">Shown at the top of the public /category/&lt;slug&gt; page.</div>
      </div>
      <div style="display:flex;gap:0.6rem;flex-wrap:wrap">
        <button class="btn" type="submit">Save</button>
        <a class="btn btn-secondary" href="${BASE}">Cancel</a>
        ${!isNew ? `<button class="btn btn-danger" type="submit" formaction="${BASE}/${id}/delete" data-confirm="Delete this category? Articles keep the label but their /category listing stops working." data-confirm-ok="Delete">Delete</button>` : ''}
      </div>
    </form>`;

  return html(adminPage({ env, user, title: isNew ? 'New category' : `Edit category: ${cat.title}`, path: BASE, content, extraHead: CONFIRM_MODAL_HEAD + RICHTEXT_HEAD }));
}

async function upsert(request, env, user, id) {
  const DB = env.DB;
  const form = await request.formData();
  const title = String(form.get('title') || '').trim();
  const slug = slugify(String(form.get('slug') || '').trim() || title);
  const description = String(form.get('description') || '').trim() || null;
  const sortOrder = parseInt(String(form.get('sort_order') || '0'), 10) || 0;
  const back = id ? `${BASE}/${id}` : `${BASE}/new`;
  if (!title || !slug) return redirect(`${back}?err=title`);

  try {
    if (id) {
      const existing = await getCategory(DB, id);
      if (!existing) return redirect(BASE);
      await DB.prepare('UPDATE categories SET title = ?, slug = ?, description = ?, sort_order = ? WHERE id = ?')
        .bind(title, slug, description, sortOrder, id).run();
      await logActivity(DB, user, 'updated', 'category', title);
    } else {
      await DB.prepare('INSERT INTO categories (title, slug, description, sort_order) VALUES (?, ?, ?, ?)')
        .bind(title, slug, description, sortOrder).run();
      await logActivity(DB, user, 'created', 'category', title);
    }
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || err))) return redirect(`${back}?err=slug`);
    throw err;
  }
  return redirect(BASE);
}

async function destroy(env, user, id) {
  const DB = env.DB;
  const cat = await getCategory(DB, id);
  if (!cat) return redirect(BASE);
  await DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run(); // articles keep the stored slug
  await logActivity(DB, user, 'deleted', 'category', cat.title);
  return redirect(BASE);
}
