// Admin people directory: /admin/people* — the team/author records referenced
// by article authors/reviewers and rendered at /people/<slug>.
//
// Routes (caller has already authenticated `user`):
//   GET  /admin/people             list, ordered by sort_order then name
//   GET  /admin/people/new         create form
//   POST /admin/people/new         create
//   GET  /admin/people/<id>        edit form
//   POST /admin/people/<id>        update
//   POST /admin/people/<id>/delete delete (confirm happens client-side)
//
// Photo: either paste a URL, or upload a file directly — uploads land in R2
// under media/people/… and the photo_url field is set to the served path.

import { logActivity } from '../db.js';
import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { contentTypeForKey, makeMediaKey } from './media.js';
import { MEDIA_PICKER_HEAD } from './admin-media.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';

export async function handlePeople(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '');
  if (path !== '/admin/people' && !path.startsWith('/admin/people/')) return null;
  const DB = env.DB;

  if (path === '/admin/people' && request.method === 'GET') return listPage(env, user, url);
  if (path === '/admin/people/new') {
    if (request.method === 'GET') return html(adminPage({ env, user, title: 'New person', path, content: formHtml(null, url), extraHead: FORM_HEAD }));
    if (request.method === 'POST') return save(request, env, user, null);
  }
  const idMatch = path.match(/^\/admin\/people\/(\d+)$/);
  if (idMatch) {
    const person = await DB.prepare('SELECT * FROM people WHERE id = ?').bind(parseInt(idMatch[1], 10)).first();
    if (!person) return notFound(env, user, path);
    if (request.method === 'GET') return html(adminPage({ env, user, title: 'Edit person', path: '/admin/people', content: formHtml(person, url), extraHead: FORM_HEAD }));
    if (request.method === 'POST') return save(request, env, user, person);
  }
  const delMatch = path.match(/^\/admin\/people\/(\d+)\/delete$/);
  if (delMatch && request.method === 'POST') {
    const person = await DB.prepare('SELECT * FROM people WHERE id = ?').bind(parseInt(delMatch[1], 10)).first();
    if (!person) return notFound(env, user, path);
    await DB.prepare('DELETE FROM people WHERE id = ?').bind(person.id).run();
    await logActivity(DB, user, 'deleted', 'person', person.name || person.slug);
    return redirect('/admin/people?ok=' + encodeURIComponent('Person deleted.'));
  }
  return null;
}

const PEOPLE_STYLES = `<style>
.person-thumb { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: var(--color-surface-dark); display: block; }
.person-thumb-empty { width: 42px; height: 42px; border-radius: 50%; background: var(--color-surface-dark); display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--color-muted); }
.person-cell { display: inline-flex; align-items: center; gap: 0.6rem; }
.person-cell .person-thumb, .person-cell .person-thumb-empty { flex: none; }
.photo-preview { max-width: 140px; border-radius: var(--radius-sm); display: block; margin-bottom: 0.5rem; }
.sl-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem; }
.sl-row select { flex: 0 0 130px; }
.sl-row .sl-url { flex: 1 1 220px; min-width: 0; }
.sl-row .sl-label { flex: 0 1 150px; min-width: 0; }
.sl-row .sl-rm {
  background: var(--color-bg); color: var(--color-ink);
  border: 1px solid var(--color-surface-dark); border-radius: var(--radius-sm);
  padding: 0.35rem 0.6rem; font: inherit; font-size: 0.8rem; cursor: pointer;
}
.sl-row .sl-rm:hover { border-color: var(--color-danger, #c33); color: var(--color-danger, #c33); }
</style>`;

// Form pages add the rich-text editor (bio) + the social-links rows component;
// the media picker powers both the photo field and the editor's image Browse….
const FORM_HEAD = PEOPLE_STYLES + MEDIA_PICKER_HEAD + CONFIRM_MODAL_HEAD
  + '<link rel="stylesheet" href="/css/wysiwyg.css"><script src="/js/wysiwyg.js" defer></script>'
  + '<script src="/js/social-links.js" defer></script>';

// Social links: JSON array of { type, url, label? } in people.social_links.
const SOCIAL_TYPES = new Set(['website', 'linkedin', 'facebook', 'twitter', 'instagram', 'bluesky', 'mastodon', 'other']);

// Validate a posted social_links JSON string → clean array (bad rows dropped).
function parseSocialLinks(raw) {
  let arr;
  try { arr = JSON.parse(String(raw || '[]')); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  const out = [];
  for (const l of arr.slice(0, 20)) {
    if (!l || typeof l !== 'object') continue;
    const url = String(l.url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) continue; // http(s) URLs only
    const item = { type: SOCIAL_TYPES.has(l.type) ? l.type : 'other', url: url.slice(0, 500) };
    const label = String(l.label || '').trim().slice(0, 80);
    if (label) item.label = label;
    out.push(item);
  }
  return out;
}

// Read side: prefer social_links; an empty list falls back to the legacy
// linkedin_url column as a single LinkedIn row.
function personSocialLinks(person) {
  const links = parseSocialLinks(person?.social_links);
  if (!links.length && person?.linkedin_url) {
    return [{ type: 'linkedin', url: String(person.linkedin_url) }];
  }
  return links;
}

function notFound(env, user, path) {
  return html(adminPage({
    env, user, title: 'Not found', path: '/admin/people',
    content: '<h1>Person not found</h1><p class="muted"><a href="/admin/people">Back to people</a></p>',
  }), { status: 404 });
}

function flashHtml(url) {
  const ok = url.searchParams.get('ok');
  const err = url.searchParams.get('err');
  if (err) return `<div class="notice notice-error">${escapeHtml(err)}</div>`;
  if (ok) return `<div class="notice notice-green">${escapeHtml(ok)}</div>`;
  return '';
}

function cleanSlug(value) {
  return String(value || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

async function listPage(env, user, url) {
  const pageSize = await getPageSize(env.DB, user, url);
  const page = currentPage(url);
  const totalRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM people').first();
  const total = totalRow ? totalRow.total : 0;
  const { results } = await env.DB.prepare(
    'SELECT * FROM people ORDER BY sort_order, name LIMIT ? OFFSET ?'
  ).bind(pageSize, (page - 1) * pageSize).all();
  const people = results || [];

  const rows = people.map((p) => {
    const thumb = p.photo_url
      ? `<img class="person-thumb" src="${escapeAttr(p.photo_url)}" alt="" loading="lazy">`
      : `<div class="person-thumb-empty">${escapeHtml((p.name || '?').slice(0, 1).toUpperCase())}</div>`;
    return `
      <tr>
        <td class="cell-main"><span class="person-cell">${thumb}<a href="/admin/people/${p.id}"><strong>${escapeHtml(p.name)}</strong></a></span></td>
        <td data-label="Role">${escapeHtml(p.role || '—')}</td>
        <td data-label="Slug"><code>${escapeHtml(p.slug)}</code></td>
        <td data-label="Order">${p.sort_order}</td>
        <td><div class="row-actions">
          <a class="btn btn-secondary btn-small" href="/people/${escapeAttr(p.slug)}" target="_blank">View</a>
          <a class="btn btn-secondary btn-small" href="/admin/people/${p.id}">Edit</a>
        </div></td>
      </tr>`;
  }).join('');

  const content = `
    <div class="page-head">
      <h1>People</h1>
      <div class="actions"><a class="btn" href="/admin/people/new">New person</a></div>
    </div>
    ${flashHtml(url)}
    <p class="muted small">One record per person. Article authors/reviewers and people blocks reference these — edit a bio once and it updates everywhere.</p>
    ${people.length ? `
    <table class="admin-table cards">
      <thead><tr><th>Name</th><th>Role</th><th>Slug</th><th>Order</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${paginationControls(url, { page, pageSize, total })}` : '<p class="muted">No people yet — add one.</p>'}`;

  return html(adminPage({ env, user, title: 'People', path: '/admin/people', content, extraHead: PEOPLE_STYLES }));
}

function formHtml(person, url) {
  const isNew = !person;
  const v = (k) => (person && person[k] != null ? escapeAttr(person[k]) : '');
  const action = isNew ? '/admin/people/new' : `/admin/people/${person.id}`;
  return `
    <div class="page-head"><h1>${isNew ? 'New person' : 'Edit person'}</h1></div>
    ${flashHtml(url)}
    <form method="post" action="${action}" enctype="multipart/form-data" style="max-width:680px">
      <div class="field">
        <label for="name">Name</label>
        <input type="text" id="name" name="name" value="${v('name')}" required>
      </div>
      <div class="field">
        <label for="slug">Slug</label>
        <input type="text" id="slug" name="slug" value="${v('slug')}" placeholder="e.g. jane-drake">
        <div class="hint">Public profile lives at /people/&lt;slug&gt;. Leave blank to derive from the name.</div>
      </div>
      <div class="field">
        <label for="role">Role / title</label>
        <input type="text" id="role" name="role" value="${v('role')}">
      </div>
      <div class="field">
        <label for="blurb">Blurb</label>
        <input type="text" id="blurb" name="blurb" value="${v('blurb')}">
        <div class="hint">One-liner shown on team grids and as the profile tagline.</div>
      </div>
      <div class="field">
        <label for="bio">Bio</label>
        <textarea id="bio" name="bio" data-richtext style="min-height:180px">${person ? escapeHtml(person.bio || '') : ''}</textarea>
        <div class="hint">Rendered on the public profile page.</div>
      </div>
      <div class="field">
        <label for="photo_url">Photo URL</label>
        ${person && person.photo_url ? `<img class="photo-preview" src="${v('photo_url')}" alt="">` : ''}
        <input type="text" id="photo_url" name="photo_url" value="${v('photo_url')}" placeholder="/media/people/… or https://…" data-media>
      </div>
      <div class="field">
        <label for="photo_file">…or upload a new photo</label>
        <input type="file" id="photo_file" name="photo_file" accept="image/*">
        <div class="hint">Uploads to the media library under media/people/ and replaces the URL above.</div>
      </div>
      <div class="field">
        <label>Social links</label>
        <div id="social-links" data-links="${escapeAttr(JSON.stringify(personSocialLinks(person)))}"></div>
        <input type="hidden" name="social_links" id="social-links-json">
        <div class="hint">Shown on the public profile and people cards. Pick “Other” to set a custom label.</div>
      </div>
      <div class="field">
        <label for="sort_order">Sort order</label>
        <input type="number" id="sort_order" name="sort_order" value="${person ? person.sort_order : 0}" style="max-width:120px">
        <div class="hint">Lower numbers appear first.</div>
      </div>
      <div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap">
        <button class="btn" type="submit">${isNew ? 'Create person' : 'Save person'}</button>
        <a class="btn btn-secondary" href="/admin/people">Cancel</a>
        ${isNew ? '' : `<button class="btn btn-danger" type="submit" formaction="/admin/people/${person.id}/delete" formnovalidate data-confirm="Delete this person? This cannot be undone." data-confirm-ok="Delete">Delete</button>`}
      </div>
    </form>`;
}

async function save(request, env, user, existing) {
  const DB = env.DB;
  const form = await request.formData();
  const str = (k) => String(form.get(k) ?? '').trim();

  const name = str('name');
  const slug = cleanSlug(str('slug')) || cleanSlug(name);
  const backTo = existing ? `/admin/people/${existing.id}` : '/admin/people/new';
  if (!name || !slug) return redirect(backTo + '?err=' + encodeURIComponent('Name (and a derivable slug) are required.'));

  // Slugs are UNIQUE — check up front for a friendly error instead of a throw.
  const clash = await DB.prepare('SELECT id FROM people WHERE slug = ?').bind(slug).first();
  if (clash && (!existing || clash.id !== existing.id)) {
    return redirect(backTo + '?err=' + encodeURIComponent(`The slug “${slug}” is already in use.`));
  }

  let photoUrl = str('photo_url');
  // Direct upload wins over the URL field: store in R2 under media/people/…
  const file = form.get('photo_file');
  if (file && typeof file !== 'string' && file.size) {
    if (!env.MEDIA) return redirect(backTo + '?err=' + encodeURIComponent('No media bucket is configured — paste a URL instead.'));
    const key = makeMediaKey('people', file.name);
    await env.MEDIA.put(key, file, { httpMetadata: { contentType: file.type || contentTypeForKey(key) } });
    await logActivity(DB, user, 'uploaded', 'media', key);
    photoUrl = '/' + key;
  }

  const bio = String(form.get('bio') ?? ''); // trusted HTML, stored as-is
  const socialLinks = parseSocialLinks(form.get('social_links'));
  // Legacy compat: keep linkedin_url populated while anything still reads it.
  const linkedin = (socialLinks.find((l) => l.type === 'linkedin') || {}).url || '';
  const sortOrder = parseInt(form.get('sort_order'), 10) || 0;

  if (existing) {
    await DB.prepare(
      `UPDATE people SET slug = ?, name = ?, role = ?, blurb = ?, bio = ?, photo_url = ?, linkedin_url = ?, social_links = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(slug, name, str('role'), str('blurb'), bio, photoUrl, linkedin, JSON.stringify(socialLinks), sortOrder, existing.id).run();
    await logActivity(DB, user, 'updated', 'person', name);
    return redirect('/admin/people?ok=' + encodeURIComponent(`Saved ${name}.`));
  }

  await DB.prepare(
    'INSERT INTO people (slug, name, role, blurb, bio, photo_url, linkedin_url, social_links, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(slug, name, str('role'), str('blurb'), bio, photoUrl, linkedin, JSON.stringify(socialLinks), sortOrder).run();
  await logActivity(DB, user, 'created', 'person', name);
  return redirect('/admin/people?ok=' + encodeURIComponent(`Added ${name}.`));
}
