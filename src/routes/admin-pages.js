// Admin routes: /admin/pages* — list, block editor, save/publish/revert,
// revisions and delete. Mounted by routes/admin.js after authentication, so
// `user` is always a logged-in CMS user here.

import { roleAtLeast } from '../auth.js';
import { logActivity, saveRevision, getRevisions, getRevision, getSiteSettings } from '../db.js';
import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { BLOCK_MANIFEST, SURFACES } from '../blocks-manifest.js';
import { MEDIA_PICKER_HEAD } from './admin-media.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';
import { PREVIEW_HEAD, previewButton, previewPage } from './admin-preview.js';

export async function handlePages(request, env, url, user) {
  const DB = env.DB;
  const path = url.pathname.replace(/\/$/, '');
  const method = request.method;

  if (path === '/admin/pages' && method === 'GET') return pagesList(env, user, url);
  if (path === '/admin/pages/preview' && method === 'POST') return previewPage(request, env, url);
  if (path === '/admin/pages/new' && method === 'GET') return pageForm(env, user, null, url);
  if (path === '/admin/pages/new' && method === 'POST') return createPage(request, env, user);

  let m;
  if ((m = path.match(/^\/admin\/pages\/(\d+)$/))) {
    const id = parseInt(m[1], 10);
    if (method === 'GET') {
      const pg = await getPage(DB, id);
      if (!pg) return notFound(env, user, path);
      return pageForm(env, user, pg, url);
    }
    if (method === 'POST') return savePageRoute(request, env, user, id);
  }
  if ((m = path.match(/^\/admin\/pages\/(\d+)\/publish$/)) && method === 'POST') {
    return publishPage(request, env, user, parseInt(m[1], 10));
  }
  if ((m = path.match(/^\/admin\/pages\/(\d+)\/revert$/)) && method === 'POST') {
    return revertToPublished(env, user, parseInt(m[1], 10));
  }
  if ((m = path.match(/^\/admin\/pages\/(\d+)\/delete$/)) && method === 'POST') {
    return deletePage(env, user, parseInt(m[1], 10));
  }
  if ((m = path.match(/^\/admin\/pages\/(\d+)\/revisions\/(\d+)\/restore$/)) && method === 'POST') {
    return restoreRevision(env, user, parseInt(m[1], 10), parseInt(m[2], 10));
  }

  return notFound(env, user, path);
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function getPage(DB, id) {
  return DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first();
}

// Normalise a URL slug: lowercase, trim, no leading/trailing slashes, spaces→-.
// Internal slashes are kept so nested paths (company/about) work.
function cleanSlug(s) {
  return String(s || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\s+/g, '-');
}

// Build a page record from the form. Status is NOT read here — it's driven by
// the Save/Publish/Revert actions. Returns { ok, data } or { ok: false, error }.
function pageFromForm(form) {
  let blocks;
  try {
    blocks = JSON.parse(form.get('blocks') || '[]');
    if (!Array.isArray(blocks)) return { ok: false, error: 'blocks must be a JSON array' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, data: {
    slug: cleanSlug(form.get('slug')),
    title: String(form.get('title') || '').trim() || 'Untitled',
    blocks: JSON.stringify(blocks),
    meta_title: String(form.get('meta_title') || '').trim() || null,
    meta_description: String(form.get('meta_description') || '').trim() || null,
    share_image: String(form.get('share_image') || '').trim() || null,
    hidden: form.get('hidden') === '1' ? 1 : 0,
    full_width: form.get('full_width') === '1' ? 1 : 0,
    corrections_disabled: form.get('corrections_disabled') === '1' ? 1 : 0,
  } };
}

// SQLite datetime('now') format so snapshot stamps compare with updated_at.
const sqliteNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// Freeze a page's editable fields as the published_snapshot (the live version).
// Accepts a DB row or a form-data object; `updatedAt` records when this version
// went live so the public page's modified date reflects the last publish.
function pageSnapshot(p, updatedAt) {
  return JSON.stringify({
    slug: p.slug, title: p.title, blocks: p.blocks || '[]',
    meta_title: p.meta_title || null, meta_description: p.meta_description || null,
    share_image: p.share_image || null, hidden: p.hidden ? 1 : 0, full_width: p.full_width ? 1 : 0,
    updated_at: updatedAt || null,
  });
}

// Persist working content. Status transition + snapshot depend on `mode`:
//   'save'    → published page becomes 'modified' (live version frozen first);
//               draft/modified keep their status
//   'publish' → snapshot the new content and set 'published' (this is what ships)
// Returns the resulting status.
async function persistPage(DB, id, data, mode = 'save') {
  const cur = await getPage(DB, id);
  let status = cur ? cur.status : 'draft';
  let snapshot = cur ? cur.published_snapshot : null;
  if (mode === 'publish') {
    snapshot = pageSnapshot(data, sqliteNow());
    status = 'published';
  } else if (status === 'published') {
    if (!snapshot && cur) snapshot = pageSnapshot(cur, cur.updated_at);
    status = 'modified';
  }
  await DB.prepare(
    `UPDATE pages SET slug = ?, title = ?, status = ?, blocks = ?, meta_title = ?, meta_description = ?,
     share_image = ?, hidden = ?, full_width = ?, corrections_disabled = ?, published_snapshot = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(data.slug, data.title, status, data.blocks, data.meta_title, data.meta_description,
    data.share_image, data.hidden, data.full_width, data.corrections_disabled, snapshot, id).run();
  return status;
}

const isUniqueError = (e) => /UNIQUE/i.test(String(e && e.message));

// ── Route handlers ───────────────────────────────────────────────────────────

async function createPage(request, env, user) {
  const parsed = pageFromForm(await request.formData());
  if (!parsed.ok) return redirect('/admin/pages/new?err=' + encodeURIComponent('Blocks JSON invalid: ' + parsed.error));
  const d = parsed.data;
  let id;
  try {
    const res = await env.DB.prepare(
      `INSERT INTO pages (slug, title, status, blocks, meta_title, meta_description, share_image, hidden, full_width, corrections_disabled)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(d.slug, d.title, d.blocks, d.meta_title, d.meta_description, d.share_image, d.hidden, d.full_width, d.corrections_disabled).run();
    id = res.meta.last_row_id;
  } catch (e) {
    if (isUniqueError(e)) return redirect('/admin/pages/new?err=' + encodeURIComponent(`The slug "${d.slug}" is already taken.`));
    throw e;
  }
  await saveRevision(env.DB, 'page', id, d, d.title, user);
  await logActivity(env.DB, user, 'created', 'page', d.title || d.slug);
  return redirect(`/admin/pages/${id}?m=created`);
}

async function savePageRoute(request, env, user, id) {
  const pg = await getPage(env.DB, id);
  if (!pg) return redirect('/admin/pages?err=' + encodeURIComponent('Page not found.'));
  const parsed = pageFromForm(await request.formData());
  if (!parsed.ok) return redirect(`/admin/pages/${id}?err=` + encodeURIComponent('Blocks JSON invalid: ' + parsed.error));
  let status;
  try {
    status = await persistPage(env.DB, id, parsed.data, 'save');
  } catch (e) {
    if (isUniqueError(e)) return redirect(`/admin/pages/${id}?err=` + encodeURIComponent(`The slug "${parsed.data.slug}" is already taken.`));
    throw e;
  }
  await saveRevision(env.DB, 'page', id, parsed.data, parsed.data.title, user);
  await logActivity(env.DB, user, 'updated', 'page', parsed.data.title || parsed.data.slug);
  return redirect(`/admin/pages/${id}?m=` + (status === 'modified' ? 'saved_mod' : 'saved'));
}

async function publishPage(request, env, user, id) {
  if (!roleAtLeast(user, 'publisher')) return redirect(`/admin/pages/${id}?err=` + encodeURIComponent('Publishing requires the publisher role.'));
  const pg = await getPage(env.DB, id);
  if (!pg) return redirect('/admin/pages?err=' + encodeURIComponent('Page not found.'));
  // Publish saves the submitted form first, so what you see is what goes live.
  const parsed = pageFromForm(await request.formData());
  if (!parsed.ok) return redirect(`/admin/pages/${id}?err=` + encodeURIComponent('Blocks JSON invalid: ' + parsed.error));
  try {
    await persistPage(env.DB, id, parsed.data, 'publish');
  } catch (e) {
    if (isUniqueError(e)) return redirect(`/admin/pages/${id}?err=` + encodeURIComponent(`The slug "${parsed.data.slug}" is already taken.`));
    throw e;
  }
  await saveRevision(env.DB, 'page', id, parsed.data, (parsed.data.title || 'Untitled') + ' (published)', user);
  await logActivity(env.DB, user, 'published', 'page', parsed.data.title || parsed.data.slug);
  return redirect(`/admin/pages/${id}?m=published`);
}

// Discard unpublished edits: copy the published snapshot back over the working
// fields and return to 'published'. Only meaningful for 'modified' pages.
async function revertToPublished(env, user, id) {
  const pg = await getPage(env.DB, id);
  if (!pg) return redirect('/admin/pages?err=' + encodeURIComponent('Page not found.'));
  if (!pg.published_snapshot) return redirect(`/admin/pages/${id}?err=` + encodeURIComponent('No published version to revert to.'));
  let snap;
  try { snap = JSON.parse(pg.published_snapshot); }
  catch { return redirect(`/admin/pages/${id}?err=` + encodeURIComponent('Published snapshot is invalid.')); }
  await env.DB.prepare(
    `UPDATE pages SET slug = ?, title = ?, status = 'published', blocks = ?, meta_title = ?, meta_description = ?,
     share_image = ?, hidden = ?, full_width = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(snap.slug, snap.title, snap.blocks || '[]', snap.meta_title || null, snap.meta_description || null,
    snap.share_image || null, snap.hidden ? 1 : 0, snap.full_width ? 1 : 0, id).run();
  await saveRevision(env.DB, 'page', id, snap, (snap.title || 'Untitled') + ' (reverted to published)', user);
  await logActivity(env.DB, user, 'reverted', 'page', snap.title || snap.slug);
  return redirect(`/admin/pages/${id}?m=reverted`);
}

async function deletePage(env, user, id) {
  const pg = await getPage(env.DB, id);
  await env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(id).run();
  await logActivity(env.DB, user, 'deleted', 'page', pg ? (pg.title || pg.slug) : `#${id}`);
  return redirect('/admin/pages?m=deleted');
}

// Restore a previous revision (applied as a new save, so nothing is lost).
async function restoreRevision(env, user, id, revisionId) {
  const rev = await getRevision(env.DB, revisionId);
  if (!rev || rev.entity_type !== 'page' || rev.entity_id !== id) {
    return redirect(`/admin/pages/${id}?err=` + encodeURIComponent('Revision not found.'));
  }
  let data;
  try { data = JSON.parse(rev.data); }
  catch { return redirect(`/admin/pages/${id}?err=` + encodeURIComponent('Revision data is invalid.')); }
  try {
    await persistPage(env.DB, id, {
      slug: cleanSlug(data.slug), title: data.title || 'Untitled', blocks: data.blocks || '[]',
      meta_title: data.meta_title || null, meta_description: data.meta_description || null,
      share_image: data.share_image || null, hidden: data.hidden ? 1 : 0, full_width: data.full_width ? 1 : 0,
    }, 'save');
  } catch (e) {
    if (isUniqueError(e)) return redirect(`/admin/pages/${id}?err=` + encodeURIComponent('Restoring failed: that slug is now taken by another page.'));
    throw e;
  }
  await saveRevision(env.DB, 'page', id, data, (data.title || 'Untitled') + ' (restored)', user);
  await logActivity(env.DB, user, 'restored a revision of', 'page', data.title || data.slug || `#${id}`);
  return redirect(`/admin/pages/${id}?m=restored`);
}

// ── Views ────────────────────────────────────────────────────────────────────

const MESSAGES = {
  created: 'Page created as a draft. Keep editing, then Publish when ready.',
  saved: 'Saved.',
  saved_mod: 'Saved. The live page keeps showing the published version until you Publish.',
  published: 'Published — the page is live.',
  reverted: 'Reverted to the published version. Unpublished edits were discarded.',
  restored: 'Version restored as the working copy. Publish to push it live.',
  deleted: 'Page deleted.',
};

function noticeFrom(url) {
  const err = url.searchParams.get('err');
  if (err) return `<div class="notice notice-error">${escapeHtml(err)}</div>`;
  const msg = MESSAGES[url.searchParams.get('m')];
  return msg ? `<div class="notice notice-green">${escapeHtml(msg)}</div>` : '';
}

const statusPill = (s) => `<span class="status-pill ${escapeAttr(s)}">${escapeHtml(s)}</span>`;

function notFound(env, user, path) {
  return html(adminPage({
    env, user, title: 'Not found', path: '/admin/pages',
    content: `<h1>Not found</h1><p class="muted">No page route at <code>${escapeHtml(path)}</code>.</p>`,
  }), { status: 404 });
}

async function pagesList(env, user, url) {
  const pageSize = await getPageSize(env.DB, user, url);
  const page = currentPage(url);
  const totalRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM pages').first();
  const total = totalRow ? totalRow.total : 0;
  const { results } = await env.DB.prepare(
    'SELECT id, slug, title, status, updated_at FROM pages ORDER BY updated_at DESC LIMIT ? OFFSET ?'
  ).bind(pageSize, (page - 1) * pageSize).all();
  const pages = results || [];
  const rows = pages.length
    ? pages.map((p) => `
        <tr>
          <td class="cell-main"><a href="/admin/pages/${p.id}">${escapeHtml(p.title)}</a></td>
          <td data-label="URL"><code>/${escapeHtml(p.slug)}</code></td>
          <td data-label="Status">${statusPill(p.status)}</td>
          <td class="muted" data-label="Updated">${escapeHtml((p.updated_at || '').slice(0, 16).replace('T', ' '))}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No pages yet — create one.</td></tr>';

  const content = `
    <div class="page-head">
      <h1>Pages</h1>
      <div class="actions"><a class="btn" href="/admin/pages/new">New page</a></div>
    </div>
    ${noticeFrom(url)}
    <p class="muted">Each page is an ordered list of blocks. Draft pages aren't on the site; a modified page keeps serving its last published version until re-published.</p>
    <table class="admin-table cards">
      <thead><tr><th>Title</th><th>URL</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${paginationControls(url, { page, pageSize, total })}`;
  return html(adminPage({ env, user, title: 'Pages', path: '/admin/pages', content }));
}

// Inject live select options into a (cloned) manifest: the Articles block's
// "featured" picker gets the current published-article list.
async function manifestFor(env) {
  const m = structuredClone(BLOCK_MANIFEST);
  try {
    const { results } = await env.DB.prepare(
      "SELECT slug, title FROM articles WHERE status IN ('published', 'modified') ORDER BY publish_date DESC"
    ).all();
    const opts = [{ value: '', label: 'Most recent (auto)' }]
      .concat((results || []).map((a) => ({ value: a.slug, label: a.title })));
    const f = (m.articles.fields || []).find((x) => x.key === 'featured');
    if (f) f.options = opts;
  } catch { /* articles table may not be migrated yet — keep the fallback */ }
  return m;
}

// Editor-only styles (block cards, picker modal). Kept here rather than in the
// shared admin.css, which is owned by another feature.
const EDITOR_CSS = `<style>
.block-card { border: 1px solid var(--color-surface-dark); border-radius: var(--radius-md); background: var(--color-bg); margin: 0.2rem 0; }
.block-card .block-head { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.8rem; }
.block-card .blk-caret { border: none; background: transparent; cursor: pointer; font-size: 0.9rem; color: var(--color-muted); padding: 0.2rem; }
.block-card .block-headmain { flex: 1; min-width: 0; cursor: pointer; }
.block-card .block-type { font-weight: 700; font-size: 0.95rem; }
.block-card .block-sum { font-size: 0.8rem; color: var(--color-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.block-card .block-ctrls { display: flex; gap: 0.3rem; }
.block-card .block-body { padding: 0 0.9rem 0.9rem; border-top: 1px solid var(--color-surface-dark); padding-top: 0.9rem; }
.block-card.collapsed .block-body { display: none; }
.block-card .warn { color: #99271C; }
.fld { margin-bottom: 0.9rem; }
.fld-label { display: block; font-size: 0.82rem; font-weight: 600; margin-bottom: 0.3rem; }
.fld-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(180px, 100%), 1fr)); gap: 0.8rem; margin-bottom: 0.9rem; }
.fld-grid .fld { margin-bottom: 0; }
.listfield { border: 1px dashed var(--color-surface-dark); border-radius: var(--radius-sm); padding: 0.8rem; margin-bottom: 0.9rem; }
.item-card { border: 1px solid var(--color-surface-dark); border-radius: var(--radius-sm); padding: 0.7rem; margin-bottom: 0.7rem; background: var(--color-surface); }
.item-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
.item-num { font-size: 0.8rem; font-weight: 700; color: var(--color-muted); }
.item-ctrls { display: flex; gap: 0.3rem; }
.blk-insert { text-align: center; height: 14px; position: relative; }
.blk-insert button { position: absolute; left: 50%; top: -4px; transform: translateX(-50%); width: 22px; height: 22px; line-height: 1; border-radius: var(--radius-pill); border: 1px solid var(--color-surface-dark); background: var(--color-bg); color: var(--color-muted); cursor: pointer; opacity: 0; transition: opacity 0.12s; z-index: 2; }
.blk-insert:hover button, .blk-insert button:focus-visible { opacity: 1; }
.blk-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100; display: flex; align-items: flex-start; justify-content: center; padding: 8vh 1rem 1rem; }
.blk-modal { background: var(--color-bg); border-radius: var(--radius-md); width: 100%; max-width: 560px; max-height: 75vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--color-surface-dark); }
.blk-modal-head { display: flex; justify-content: space-between; align-items: center; padding: 0.9rem 1.1rem; border-bottom: 1px solid var(--color-surface-dark); }
.blk-modal-close { border: none; background: transparent; font-size: 1.4rem; cursor: pointer; color: var(--color-muted); }
.blk-modal-search { padding: 0.8rem 1.1rem 0; }
.blk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.6rem; padding: 1.1rem; overflow-y: auto; }
.blk-tile { border: 1px solid var(--color-surface-dark); border-radius: var(--radius-sm); background: var(--color-surface); padding: 0.9rem 0.6rem; cursor: pointer; font: inherit; font-size: 0.9rem; font-weight: 600; color: var(--color-ink); }
.blk-tile:hover { border-color: var(--color-brand); color: var(--color-brand); }
.blk-grid-none { color: var(--color-muted); padding: 0.5rem; }
.blocks-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.4rem; }
.blocks-head-btns { display: flex; gap: 0.4rem; }
.add-block { margin-top: 0.5rem; }
.editor-empty { padding: 0.6rem 0; }
/* Mobile containment: keep the editor inside the viewport at narrow widths.
   Grid/flex children default to min-width:auto, so any wide control (WYSIWYG
   toolbar, selects, nested repeat items) would otherwise force the whole page
   wider and cause horizontal scrolling. */
.editor-columns > * { min-width: 0; }
#block-editor, .block-card, .block-card .block-body, .listfield, .item-card, .fld { min-width: 0; max-width: 100%; }
.fld input, .fld select, .fld textarea { max-width: 100%; }
.block-card .block-head { flex-wrap: wrap; }
.item-head { flex-wrap: wrap; gap: 0.3rem 0.6rem; }
.item-ctrls { flex-wrap: wrap; }
/* Rich-text editors inside blocks: contained, and more compact than the
   full-page article editor (blocks have many of them). */
#block-editor .rt { min-width: 0; max-width: 100%; }
#block-editor .rt-ed { min-height: 140px; }
#block-editor .rt textarea[data-richtext] { min-height: 140px; }
</style>`;

async function pageForm(env, user, pg, url) {
  const isNew = !pg;
  let blocks = [];
  if (pg) { try { blocks = JSON.parse(pg.blocks || '[]'); } catch { blocks = []; } }
  if (!Array.isArray(blocks)) blocks = [];
  const v = (k) => (pg && pg[k] != null ? escapeAttr(pg[k]) : '');
  // Escape "<" so block content can never close the injected <script> tag.
  const forScript = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
  const manifest = await manifestFor(env);
  const correctionsOffSiteWide = ((await getSiteSettings(env.DB)).corrections_enabled ?? '1') === '0';
  const status = isNew ? 'draft' : (pg.status || 'draft');
  const statusNote = isNew ? 'New — Save to create it as a draft.'
    : status === 'published' ? 'Live on the site.'
    : status === 'modified' ? 'Live, with unpublished changes — visitors see the last published version until you Publish.'
    : 'Not on the live site.';

  const canPublish = roleAtLeast(user, 'publisher');
  const publishBtn = !isNew && canPublish && (status === 'draft' || status === 'modified')
    ? `<button class="btn btn-green" type="submit" formaction="/admin/pages/${pg.id}/publish" formmethod="POST">Publish</button>` : '';
  const revertBtn = !isNew && canPublish && status === 'modified' && pg.published_snapshot
    ? `<button class="btn btn-secondary" type="submit" formaction="/admin/pages/${pg.id}/revert" formmethod="POST"
         data-confirm="Discard unpublished edits and revert to the published version?" data-confirm-ok="Revert">Revert to published</button>` : '';

  const revisions = isNew ? [] : await getRevisions(env.DB, 'page', pg.id);
  const revisionRows = revisions.map((r, i) => `
      <tr>
        <td>${escapeHtml((r.created_at || '').slice(0, 16).replace('T', ' '))}</td>
        <td>${escapeHtml(r.user_name || '—')}</td>
        <td>${escapeHtml(r.summary || '')}</td>
        <td>${i === 0 ? '<span class="muted small">current</span>' : `
          <form method="POST" action="/admin/pages/${pg.id}/revisions/${r.id}/restore" style="margin:0"
                data-confirm="Restore this version? The current content is replaced (and saved as a new version, so nothing is lost)." data-confirm-ok="Restore" data-confirm-danger="0">
            <button class="btn btn-secondary btn-small" type="submit">Restore</button>
          </form>`}</td>
      </tr>`).join('');
  const revisionsHtml = revisions.length ? `
    <details style="margin-top:1.6rem">
      <summary style="cursor:pointer;font-weight:600">Version history (${revisions.length})</summary>
      <table class="admin-table" style="margin-top:0.8rem">
        <thead><tr><th>Saved</th><th>By</th><th>Summary</th><th></th></tr></thead>
        <tbody>${revisionRows}</tbody>
      </table>
    </details>` : '';

  const deleteForm = isNew ? '' : `
    <form method="POST" action="/admin/pages/${pg.id}/delete" style="margin:0"
          data-confirm="Delete this page? This cannot be undone." data-confirm-ok="Delete">
      <button class="btn btn-danger btn-small" type="submit">Delete page</button>
    </form>`;

  const content = `
    <div class="page-head">
      <h1>${isNew ? 'New page' : 'Edit page'}</h1>
      <div class="actions">
        ${previewButton('/admin/pages/preview')}
        ${!isNew && (status === 'published' || status === 'modified') ? `<a class="btn btn-secondary btn-small" href="/${escapeAttr(pg.slug === 'home' ? '' : pg.slug)}" target="_blank">View live ↗</a>` : ''}
        ${deleteForm}
      </div>
    </div>
    ${noticeFrom(url)}
    <form method="POST" action="${isNew ? '/admin/pages/new' : `/admin/pages/${pg.id}`}">
      <div class="editor-columns">
        <div class="editor-main">
          <div class="blocks-head">
            <label class="fld-label" style="font-size:1rem">Blocks</label>
            <span class="blocks-head-btns">
              <button type="button" class="btn btn-secondary btn-small" id="blocks-expand-all">Expand all</button>
              <button type="button" class="btn btn-secondary btn-small" id="blocks-collapse-all">Collapse all</button>
            </span>
          </div>
          <div id="block-editor"></div>
          <div class="add-block"><button type="button" class="btn btn-secondary btn-small" id="add-block-btn">+ Add block</button></div>
          <input type="hidden" name="blocks" id="blocks-json" value="${escapeAttr(JSON.stringify(blocks))}">
          ${revisionsHtml}
        </div>
        <div class="editor-side">
          <div class="card">
            <div class="field">
              <label>Status</label>
              ${statusPill(status)}
              <div class="hint">${escapeHtml(statusNote)}</div>
            </div>
            <div class="field">
              <label for="pg-title">Title</label>
              <input type="text" id="pg-title" name="title" value="${v('title')}" required>
            </div>
            <div class="field">
              <label for="pg-slug">Slug (URL path)</label>
              <input type="text" id="pg-slug" name="slug" value="${v('slug')}" placeholder="e.g. about — use 'home' for /" required>
            </div>
            <div class="field">
              <label style="font-weight:normal"><input type="checkbox" name="hidden" value="1"${pg && pg.hidden ? ' checked' : ''} style="width:auto"> Hidden — reachable by URL but kept out of nav/listings</label>
            </div>
            <div class="field">
              <label style="font-weight:normal"><input type="checkbox" name="full_width" value="1"${pg && pg.full_width ? ' checked' : ''} style="width:auto"> Full width — blocks span the whole browser width</label>
            </div>
            <div class="field">
              <label style="font-weight:normal${correctionsOffSiteWide ? ';opacity:0.55' : ''}"><input type="checkbox" ${correctionsOffSiteWide ? 'disabled' : 'name="corrections_disabled"'} value="1"${pg && pg.corrections_disabled ? ' checked' : ''} style="width:auto"> Disable corrections on this page</label>
              ${correctionsOffSiteWide
                ? `<input type="hidden" name="corrections_disabled" value="${pg && pg.corrections_disabled ? '1' : '0'}"><p class="hint">Corrections are turned off site-wide in <a href="/admin/settings">Settings</a>.</p>`
                : ''}
            </div>
            <div class="field">
              <label for="pg-meta-title">Meta title</label>
              <input type="text" id="pg-meta-title" name="meta_title" value="${v('meta_title')}" placeholder="Defaults to the page title">
            </div>
            <div class="field">
              <label for="pg-meta-desc">Meta description</label>
              <textarea id="pg-meta-desc" name="meta_description" style="min-height:70px">${pg ? escapeHtml(pg.meta_description || '') : ''}</textarea>
            </div>
            <div class="field">
              <label for="pg-share-img">Share image URL</label>
              <input type="text" id="pg-share-img" name="share_image" value="${v('share_image')}" placeholder="Defaults to the global share image" data-media>
            </div>
            <button class="btn" type="submit" style="width:100%;justify-content:center">Save</button>
            ${publishBtn ? `<div style="margin-top:0.6rem">${publishBtn.replace('class="btn btn-green"', 'class="btn btn-green" style="width:100%;justify-content:center"')}</div>` : ''}
            ${revertBtn ? `<div style="margin-top:0.6rem">${revertBtn}</div>` : ''}
            <div style="margin-top:0.8rem"><a class="muted small" href="/admin/pages">← Back to pages</a></div>
          </div>
        </div>
      </div>
    </form>
    <script>
      window.__BLOCK_MANIFEST = ${forScript(manifest)};
      window.__SURFACES = ${forScript(SURFACES)};
      window.__BLOCKS = ${forScript(blocks)};
    </script>
    <script src="/js/page-editor.js"></script>`;

  return html(adminPage({
    env, user, title: isNew ? 'New page' : `Edit: ${pg.title}`, path: '/admin/pages',
    content,
    // wysiwyg.js loads without defer so window.WYSIWYG exists before
    // page-editor.js (end of body) runs its first render + upgradeAll pass.
    extraHead: `<link rel="stylesheet" href="/css/blocks.css"><link rel="stylesheet" href="/css/wysiwyg.css"><script src="/js/wysiwyg.js"></script>${MEDIA_PICKER_HEAD}${CONFIRM_MODAL_HEAD}${PREVIEW_HEAD}${EDITOR_CSS}`,
  }));
}
