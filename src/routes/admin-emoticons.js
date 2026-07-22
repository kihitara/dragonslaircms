// Admin emoticons: /admin/emoticons* — custom inline emoticons for the rich-
// text editor. Every emoticon is a 200×200 transparent-padded PNG stored in R2
// at media/emoticons/<slug>.png (uploaded HERE, never through the media
// library's own upload) plus a row in the emoticons D1 table. The category
// list — including empty categories — lives in the site_config key
// 'emoticon_categories'.
//
// Renaming a slug copies the R2 object to the new key and KEEPS the old object
// in place: content embeds the file URL at insert time, so previously-inserted
// copies keep working. Deleting removes the row and the current object, so
// inserted copies of a deleted emoticon do break (the delete confirm says so).
//
// Routes (caller has authenticated `user`; everything here is publisher+):
//   GET  /admin/emoticons             grid + upload + manage-categories panel
//   GET  /admin/emoticons/list.json   { emoticons, categories } for the editor picker
//   POST /admin/emoticons/upload      multipart: file, slug, category/new_category
//                                     (json=1 → JSON reply for the fetch() upload)
//   POST /admin/emoticons/edit        slug, new_slug, category/new_category
//   POST /admin/emoticons/delete      slug — removes the D1 row AND the R2 object
//   POST /admin/emoticons/categories/create   name
//   POST /admin/emoticons/categories/rename   from, to
//   POST /admin/emoticons/categories/delete   name — its emoticons become Uncategorised

import { roleAtLeast } from '../auth.js';
import { logActivity, getSiteConfig, setSiteConfig } from '../db.js';
import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UNCAT = 'Uncategorised';
const keyFor = (slug) => `media/emoticons/${slug}.png`;

const EMOTICONS_HEAD = '<link rel="stylesheet" href="/css/emoticons-admin.css"><script src="/js/emoticon-upload.js" defer></script>';

export async function handleEmoticons(request, env, url, user) {
  if (!roleAtLeast(user, 'publisher')) {
    return html(adminPage({
      env, user, title: 'Forbidden', path: '/admin/emoticons',
      content: '<h1>Forbidden</h1><p class="muted">This section needs the publisher role.</p>',
    }), { status: 403 });
  }
  const path = url.pathname.replace(/\/$/, '');
  if (path !== '/admin/emoticons' && !path.startsWith('/admin/emoticons/')) return null;

  if (path === '/admin/emoticons' && request.method === 'GET') return emoticonsPage(env, user, url);
  if (path === '/admin/emoticons/list.json' && request.method === 'GET') return listJson(env);
  if (path === '/admin/emoticons/upload' && request.method === 'POST') return upload(request, env, user);
  if (path === '/admin/emoticons/edit' && request.method === 'POST') return edit(request, env, user);
  if (path === '/admin/emoticons/delete' && request.method === 'POST') return remove(request, env, user);
  if (path === '/admin/emoticons/categories/create' && request.method === 'POST') return createCategory(request, env, user);
  if (path === '/admin/emoticons/categories/rename' && request.method === 'POST') return renameCategory(request, env, user);
  if (path === '/admin/emoticons/categories/delete' && request.method === 'POST') return deleteCategory(request, env, user);
  return null;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

// ── Data helpers ─────────────────────────────────────────────────────────────

async function getEmoticons(DB) {
  const { results } = await DB.prepare('SELECT slug, key, category FROM emoticons ORDER BY slug').all();
  return results || [];
}

// site_config list only — may include empty categories (created but unused).
async function getCategoryList(DB) {
  const list = (await getSiteConfig(DB, 'emoticon_categories', [])) || [];
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && c) : [];
}

const saveCategoryList = (DB, list) =>
  setSiteConfig(DB, 'emoticon_categories', Array.from(new Set(list.filter(Boolean))));

// The full category universe: the managed list, plus any category a row uses
// that the list doesn't know (defensive — rows are the ground truth).
// Uncategorised is implicit and never appears in the managed list.
function categoryUnion(list, rows) {
  const extra = [...new Set(rows.map((r) => r.category))]
    .filter((c) => c && c !== UNCAT && !list.includes(c)).sort();
  return [...list, ...extra];
}

// Category names are flat display labels — trim, drop control chars, cap length.
function cleanCategory(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
}

// The category a form asked for: a typed "new category" name wins over the
// select. Falls back to Uncategorised. Adds a genuinely new name to the list.
async function resolveCategory(DB, form, rows) {
  const typed = cleanCategory(form.get('new_category'));
  const picked = cleanCategory(form.get('category'));
  const category = typed || picked || UNCAT;
  if (category !== UNCAT) {
    const list = await getCategoryList(DB);
    if (!categoryUnion(list, rows).includes(category)) {
      list.push(category);
      await saveCategoryList(DB, list);
    }
  }
  return category;
}

// Minimal PNG header parse: signature + IHDR width/height. Workers have no
// image codecs, so this is the entire extent of server-side image inspection —
// the browser does the real transcoding (public/js/emoticon-upload.js).
function pngSize(buf) {
  const b = new Uint8Array(buf);
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null;
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null; // "IHDR"
  const dv = new DataView(buf);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

// One-shot notice pulled from ?ok= / ?err= (set by the POST redirects).
function flashHtml(url) {
  const ok = url.searchParams.get('ok');
  const err = url.searchParams.get('err');
  if (err) return `<div class="notice notice-error">${escapeHtml(err)}</div>`;
  if (ok) return `<div class="notice notice-green">${escapeHtml(ok)}</div>`;
  return '';
}

// Query-string prefix for returning to a category filter ('' = All).
const backQ = (cat) => (cat ? 'cat=' + encodeURIComponent(cat) + '&' : '');

// <option> list for a category select: Uncategorised + every known category.
function categoryOptions(categories, selected) {
  return `<option value=""${!selected || selected === UNCAT ? ' selected' : ''}>${UNCAT}</option>` +
    categories.map((c) =>
      `<option value="${escapeAttr(c)}"${c === selected ? ' selected' : ''}>${escapeHtml(c)}</option>`
    ).join('');
}

// ── Pages ────────────────────────────────────────────────────────────────────

async function emoticonsPage(env, user, url) {
  const [rows, list] = await Promise.all([getEmoticons(env.DB), getCategoryList(env.DB)]);
  const categories = categoryUnion(list, rows);
  const countOf = (c) => rows.filter((r) => r.category === c).length;
  const uncatCount = rows.filter((r) => !r.category || r.category === UNCAT).length;

  // ?cat= filter: absent = All, '__uncat', or a category name.
  const filter = url.searchParams.get('cat') || '';
  const shown = !filter ? rows
    : rows.filter((r) => (filter === '__uncat' ? (!r.category || r.category === UNCAT) : r.category === filter));

  const chip = (label, value, count) => {
    const href = value ? `/admin/emoticons?cat=${encodeURIComponent(value)}` : '/admin/emoticons';
    return `<a class="media-chip${filter === value ? ' active' : ''}" href="${escapeAttr(href)}">${escapeHtml(label)} <span class="count">${count}</span></a>`;
  };
  const chipBar = `
    <div class="media-folders">
      ${chip('All', '', rows.length)}
      ${uncatCount ? chip(UNCAT, '__uncat', uncatCount) : ''}
      ${categories.map((c) => chip(c, c, countOf(c))).join('')}
    </div>`;

  const manageBar = `
    <details class="media-manage">
      <summary>Manage categories</summary>
      <div class="media-manage-rows">
        ${categories.map((c) => `
        <div class="media-manage-row">
          <form method="post" action="/admin/emoticons/categories/rename">
            <input type="hidden" name="from" value="${escapeAttr(c)}">
            <input type="hidden" name="back" value="${escapeAttr(filter)}">
            <input type="text" name="to" value="${escapeAttr(c)}" maxlength="60" required aria-label="New name for ${escapeAttr(c)}">
            <button class="btn btn-secondary btn-small" type="submit">Rename</button>
          </form>
          <form method="post" action="/admin/emoticons/categories/delete"
                data-confirm="Delete the category “${escapeAttr(c)}”? Its emoticons are kept and become ${UNCAT}." data-confirm-ok="Delete category">
            <input type="hidden" name="name" value="${escapeAttr(c)}">
            <input type="hidden" name="back" value="${escapeAttr(filter)}">
            <button class="btn btn-danger btn-small" type="submit">Delete</button>
          </form>
          <span class="count">${countOf(c)} emoticon(s)</span>
        </div>`).join('')}
        <div class="media-manage-row">
          <form method="post" action="/admin/emoticons/categories/create">
            <input type="hidden" name="back" value="${escapeAttr(filter)}">
            <input type="text" name="name" placeholder="New category name" maxlength="60" required aria-label="New category name">
            <button class="btn btn-small" type="submit">Create</button>
          </form>
        </div>
      </div>
      <p class="muted small" style="margin:0.6rem 0 0">Categories are sorting labels only — renaming or deleting one never touches the images or their URLs.</p>
    </details>`;

  const uploadCategory = filter && filter !== '__uncat' ? filter : '';
  const uploadCard = `
    <div class="card emo-upload-card">
      <h2>Add an emoticon</h2>
      <form method="post" action="/admin/emoticons/upload" enctype="multipart/form-data" class="emo-upload-form" data-emoticon-upload>
        <div class="field"><label for="emo-file">Image</label>
          <input type="file" id="emo-file" name="file" accept="image/*" required></div>
        <div class="field"><label for="emo-slug">Slug</label>
          <input type="text" id="emo-slug" name="slug" placeholder="e.g. dragon-tail" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="60" required></div>
        <div class="field"><label for="emo-cat">Category</label>
          <select id="emo-cat" name="category">${categoryOptions(categories, uploadCategory)}</select></div>
        <div class="field"><label for="emo-newcat">…or a new category</label>
          <input type="text" id="emo-newcat" name="new_category" placeholder="Typed name wins" maxlength="60"></div>
        <button class="btn" type="submit">Upload</button>
      </form>
      <div class="notice notice-error" data-emo-upload-msg hidden></div>
      <p class="muted small" style="margin:0.6rem 0 0">Any image your browser can read is converted on upload to a
        200×200 PNG — scaled to fit and centred with transparent padding, never cropped. Slugs are lowercase
        letters, digits and hyphens. Without JavaScript, only a ready-made 200×200 PNG is accepted (the server
        cannot convert images itself).</p>
    </div>`;

  const tiles = shown.map((r) => `
      <div class="media-tile emo-tile">
        <div class="emo-thumb"><img src="/${escapeAttr(r.key)}" alt="" loading="lazy"></div>
        <div class="emo-slug"><code>:${escapeHtml(r.slug)}:</code></div>
        <div class="emo-cat">${escapeHtml(r.category || UNCAT)}</div>
        <div class="media-foot">
          <details class="emo-edit">
            <summary class="btn btn-secondary btn-small">Edit</summary>
            <form method="post" action="/admin/emoticons/edit" class="emo-edit-form">
              <input type="hidden" name="slug" value="${escapeAttr(r.slug)}">
              <input type="hidden" name="back" value="${escapeAttr(filter)}">
              <label>Slug <input type="text" name="new_slug" value="${escapeAttr(r.slug)}" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="60" required></label>
              <label>Category <select name="category">${categoryOptions(categories, r.category)}</select></label>
              <label>…or new <input type="text" name="new_category" placeholder="New category" maxlength="60"></label>
              <button class="btn btn-small" type="submit">Save</button>
            </form>
          </details>
          <form method="post" action="/admin/emoticons/delete"
                data-confirm="Delete “:${escapeAttr(r.slug)}:” permanently? Any copy already inserted into content will show as a broken image." data-confirm-ok="Delete emoticon">
            <input type="hidden" name="slug" value="${escapeAttr(r.slug)}">
            <input type="hidden" name="back" value="${escapeAttr(filter)}">
            <button class="btn btn-danger btn-small" type="submit">Delete</button>
          </form>
        </div>
      </div>`).join('');

  const content = `
    <div class="page-head"><h1>Emoticons</h1></div>
    ${flashHtml(url)}
    <p class="muted small">Emoticons are small inline images authors insert from the editor toolbar; they render
      at text height. Each one is stored as a 200×200 transparent PNG at
      <code>/media/emoticons/&lt;slug&gt;.png</code> and shows in the media library under a locked
      “Emoticon” folder. Renaming a slug keeps previously-inserted copies working — the image is copied to
      the new name and the old file stays in place. Deleting removes the file, so inserted copies break.</p>
    ${uploadCard}
    ${chipBar}
    ${manageBar}
    ${shown.length ? `<div class="media-grid emo-grid">${tiles}</div>`
      : `<p class="muted">${rows.length ? 'No emoticons in this category yet.' : 'No emoticons yet — upload one above.'}</p>`}`;

  return html(adminPage({
    env, user, title: 'Emoticons', path: '/admin/emoticons', content,
    extraHead: EMOTICONS_HEAD + CONFIRM_MODAL_HEAD,
  }));
}

// JSON listing for the editor's emoticon picker (authenticated admin route).
async function listJson(env) {
  const [rows, list] = await Promise.all([getEmoticons(env.DB), getCategoryList(env.DB)]);
  return json({
    emoticons: rows.map((r) => ({ slug: r.slug, url: '/' + r.key, category: r.category || UNCAT })),
    categories: categoryUnion(list, rows),
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────

async function upload(request, env, user) {
  const form = await request.formData();
  const wantsJson = !!form.get('json'); // the fetch() upload path (emoticon-upload.js)
  const fail = (msg, status = 400) => wantsJson
    ? json({ error: msg }, status)
    : redirect('/admin/emoticons?err=' + encodeURIComponent(msg));

  if (!env.MEDIA) return fail('No media bucket is configured — bind an R2 bucket as MEDIA in wrangler.jsonc to use emoticons.', 500);

  const slug = String(form.get('slug') || '').trim();
  if (!SLUG_RE.test(slug) || slug.length > 60) {
    return fail('Slugs are lowercase letters, digits and single hyphens — e.g. dragon-tail.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return fail('Choose an image to upload.');

  const existing = await env.DB.prepare('SELECT 1 AS x FROM emoticons WHERE slug = ?').bind(slug).first();
  if (existing) return fail(`An emoticon called “:${slug}:” already exists — pick another slug.`);

  // The browser sends a transcoded 200×200 PNG; a no-JS post sends the raw
  // file. Either way the server insists on exactly PNG 200×200 (it can read a
  // PNG header, but Workers have no codecs to convert anything).
  const buf = await file.arrayBuffer();
  const size = pngSize(buf);
  if (!size) return fail('That file is not a PNG. With JavaScript enabled the browser converts images automatically; without it, please upload a ready-made 200×200 PNG.');
  if (size.w !== 200 || size.h !== 200) {
    return fail(`That PNG is ${size.w}×${size.h} — emoticons must be exactly 200×200. With JavaScript enabled the browser resizes automatically.`);
  }

  const rows = await getEmoticons(env.DB);
  const category = await resolveCategory(env.DB, form, rows);
  const key = keyFor(slug);
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
  await env.DB.prepare('INSERT INTO emoticons (slug, key, category) VALUES (?, ?, ?)')
    .bind(slug, key, category).run();
  await logActivity(env.DB, user, 'created', 'emoticon', slug);

  const ok = `Added the emoticon “:${slug}:”.`;
  if (wantsJson) return json({ ok: true, slug, url: '/' + key, redirect: '/admin/emoticons?ok=' + encodeURIComponent(ok) });
  return redirect('/admin/emoticons?ok=' + encodeURIComponent(ok));
}

// Change slug and/or category. A slug change COPIES the R2 object to the new
// key and leaves the old object in place — content embeds the URL at insert
// time, so previously-inserted copies keep working; only the row's key moves.
async function edit(request, env, user) {
  const form = await request.formData();
  const back = String(form.get('back') || '');
  const fail = (msg) => redirect('/admin/emoticons?' + backQ(back) + 'err=' + encodeURIComponent(msg));

  if (!env.MEDIA) return fail('No media bucket is configured — bind an R2 bucket as MEDIA in wrangler.jsonc to manage emoticons.');

  const slug = String(form.get('slug') || '').trim();
  const row = await env.DB.prepare('SELECT slug, key, category FROM emoticons WHERE slug = ?').bind(slug).first();
  if (!row) return fail('That emoticon no longer exists.');

  const newSlug = String(form.get('new_slug') || '').trim();
  if (!SLUG_RE.test(newSlug) || newSlug.length > 60) {
    return fail('Slugs are lowercase letters, digits and single hyphens — e.g. dragon-tail.');
  }

  let key = row.key;
  if (newSlug !== slug) {
    const clash = await env.DB.prepare('SELECT 1 AS x FROM emoticons WHERE slug = ?').bind(newSlug).first();
    if (clash) return fail(`An emoticon called “:${newSlug}:” already exists — pick another slug.`);
    const obj = await env.MEDIA.get(row.key);
    if (!obj) return fail('The stored image for that emoticon is missing — delete and re-upload it.');
    key = keyFor(newSlug);
    // Copy, never move: the old object stays so existing insertions keep working.
    await env.MEDIA.put(key, obj.body, { httpMetadata: { contentType: 'image/png' } });
  }

  const rows = await getEmoticons(env.DB);
  const category = await resolveCategory(env.DB, form, rows);
  await env.DB.prepare('UPDATE emoticons SET slug = ?, key = ?, category = ? WHERE slug = ?')
    .bind(newSlug, key, category, slug).run();
  await logActivity(env.DB, user, 'updated', 'emoticon', newSlug !== slug ? `${slug} → ${newSlug}` : slug);
  return redirect('/admin/emoticons?' + backQ(back) + 'ok=' + encodeURIComponent(`Saved “:${newSlug}:”.`));
}

// Delete the row AND the R2 object at the row's current key. (Old keys left
// behind by earlier renames are deliberately kept — content may still use them.)
async function remove(request, env, user) {
  const form = await request.formData();
  const back = String(form.get('back') || '');
  const slug = String(form.get('slug') || '').trim();
  const row = await env.DB.prepare('SELECT slug, key FROM emoticons WHERE slug = ?').bind(slug).first();
  if (!row) return redirect('/admin/emoticons?' + backQ(back) + 'err=' + encodeURIComponent('That emoticon no longer exists.'));
  // Only ever delete inside our own prefix (and only if a bucket is bound).
  if (env.MEDIA && row.key.startsWith('media/emoticons/') && !row.key.includes('..')) await env.MEDIA.delete(row.key);
  await env.DB.prepare('DELETE FROM emoticons WHERE slug = ?').bind(slug).run();
  await logActivity(env.DB, user, 'deleted', 'emoticon', slug);
  return redirect('/admin/emoticons?' + backQ(back) + 'ok=' + encodeURIComponent(`Deleted “:${slug}:”.`));
}

// ── Category management (mirrors the media library's folder panel) ──────────

async function createCategory(request, env, user) {
  const form = await request.formData();
  const name = cleanCategory(form.get('name'));
  const back = cleanCategory(form.get('back'));
  if (!name) return redirect('/admin/emoticons?' + backQ(back) + 'err=' + encodeURIComponent('Enter a category name.'));
  if (name === UNCAT) return redirect('/admin/emoticons?' + backQ(back) + 'err=' + encodeURIComponent(`“${UNCAT}” is the built-in default — pick another name.`));
  const [rows, list] = await Promise.all([getEmoticons(env.DB), getCategoryList(env.DB)]);
  if (categoryUnion(list, rows).includes(name)) {
    return redirect('/admin/emoticons?' + backQ(back) + 'err=' + encodeURIComponent(`A category called “${name}” already exists — pick another name.`));
  }
  list.push(name);
  await saveCategoryList(env.DB, list);
  await logActivity(env.DB, user, 'created', 'emoticon category', name);
  return redirect('/admin/emoticons?' + backQ(back) + 'ok=' + encodeURIComponent(`Created the category “${name}”.`));
}

// Rename: update the list AND every row using the old name. Renaming onto an
// existing category is rejected (no implicit merging — delete instead).
async function renameCategory(request, env, user) {
  const form = await request.formData();
  const from = cleanCategory(form.get('from'));
  const to = cleanCategory(form.get('to'));
  let back = cleanCategory(form.get('back'));
  const [rows, list] = await Promise.all([getEmoticons(env.DB), getCategoryList(env.DB)]);
  const union = categoryUnion(list, rows);
  if (!from || !union.includes(from)) {
    return redirect('/admin/emoticons?' + backQ(back) + 'err=' + encodeURIComponent('That category no longer exists.'));
  }
  if (!to) return redirect('/admin/emoticons?' + backQ(back) + 'err=' + encodeURIComponent('Enter a new category name.'));
  if (to === from) return redirect('/admin/emoticons?' + backQ(back));
  if (to === UNCAT || union.includes(to)) {
    return redirect('/admin/emoticons?' + backQ(back) + 'err=' + encodeURIComponent(`A category called “${to}” already exists — pick another name.`));
  }
  const next = list.includes(from) ? list.map((c) => (c === from ? to : c)) : [...list, to];
  await saveCategoryList(env.DB, next);
  await env.DB.prepare('UPDATE emoticons SET category = ? WHERE category = ?').bind(to, from).run();
  await logActivity(env.DB, user, 'renamed', 'emoticon category', `${from} → ${to}`);
  if (back === from) back = to; // keep the filter following the renamed category
  return redirect('/admin/emoticons?' + backQ(back) + 'ok=' + encodeURIComponent(`Renamed “${from}” to “${to}”.`));
}

// Delete: drop from the list; its emoticons move to Uncategorised. R2 untouched.
async function deleteCategory(request, env, user) {
  const form = await request.formData();
  const name = cleanCategory(form.get('name'));
  let back = cleanCategory(form.get('back'));
  if (!name || name === UNCAT) return redirect('/admin/emoticons?err=' + encodeURIComponent('That category cannot be deleted.'));
  const list = await getCategoryList(env.DB);
  await saveCategoryList(env.DB, list.filter((c) => c !== name));
  await env.DB.prepare('UPDATE emoticons SET category = ? WHERE category = ?').bind(UNCAT, name).run();
  await logActivity(env.DB, user, 'deleted', 'emoticon category', name);
  if (back === name) back = ''; // the filtered category is gone — back to All
  return redirect('/admin/emoticons?' + backQ(back) + 'ok=' + encodeURIComponent(`Deleted the category “${name}” — its emoticons are now ${UNCAT}.`));
}
