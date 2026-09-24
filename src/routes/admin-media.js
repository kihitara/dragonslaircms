// Admin media library: /admin/media* — browse, upload and delete R2 objects.
// There is deliberately no media table: the library lists straight from the
// bucket (env.MEDIA.list with the media/ prefix), so R2 is the single source
// of truth and nothing can drift out of sync.
//
// "Folders" are virtual sorting tags, not R2 key prefixes: a key→folder map
// stored as the media_folders blob in site_config. Moving a file between
// folders never touches R2, so its URL never changes. A file with no entry
// shows as "Unfiled".
//
// Routes (caller has already authenticated `user`):
//   GET  /admin/media            library grid (?folder= filters: name or __unfiled)
//   GET  /admin/media/list.json  JSON listing for the modal picker (window.MEDIA)
//   POST /admin/media/upload     multipart upload → media/<yyyymm>/<ts>-<name>
//                                (optional folder/new_folder; json=1 → JSON reply)
//   POST /admin/media/replace    overwrite an existing key (key, file) with new
//                                bytes — same URL, same folder; must match type
//   POST /admin/media/move       re-tag a file (key, folder) — R2 untouched
//   POST /admin/media/delete     delete by key (confirm happens client-side)
//   POST /admin/media/folders/create  add an empty folder tag (name)
//   POST /admin/media/folders/rename  rename a folder tag (from, to) — R2 untouched
//   POST /admin/media/folders/delete  drop a folder tag; its files become Unfiled

import { logActivity, getSiteConfig, setSiteConfig } from '../db.js';
import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';
import { contentTypeForKey, isImageKey, fileTypeLabel, makeMediaKey } from './media.js';

// Shared <head> snippet for any admin page with media URL fields: the modal
// picker (window.MEDIA) plus its styles. Classic (non-deferred) script so
// window.MEDIA exists before the page's own editor scripts run.
export const MEDIA_PICKER_HEAD = '<link rel="stylesheet" href="/css/media-picker.css"><script src="/js/image-resize.js"></script><script src="/js/media-picker.js"></script>';

export async function handleMedia(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '');
  if (path !== '/admin/media' && !path.startsWith('/admin/media/')) return null;

  if (!env.MEDIA) {
    return html(adminPage({
      env, user, title: 'Media', path: '/admin/media',
      content: '<h1>Media</h1><p class="muted">No media bucket is configured. Bind an R2 bucket as <code>MEDIA</code> in wrangler.jsonc.</p>',
    }), { status: 500 });
  }

  if (path === '/admin/media' && request.method === 'GET') return libraryPage(env, user, url);
  if (path === '/admin/media/list.json' && request.method === 'GET') return listJson(env);
  if (path === '/admin/media/upload' && request.method === 'POST') return upload(request, env, user);
  if (path === '/admin/media/replace' && request.method === 'POST') return replace(request, env, user);
  if (path === '/admin/media/move' && request.method === 'POST') return move(request, env, user);
  if (path === '/admin/media/delete' && request.method === 'POST') return remove(request, env, user);
  if (path === '/admin/media/folders/create' && request.method === 'POST') return createFolder(request, env, user);
  if (path === '/admin/media/folders/rename' && request.method === 'POST') return renameFolder(request, env, user);
  if (path === '/admin/media/folders/delete' && request.method === 'POST') return deleteFolder(request, env, user);
  return null;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

// Walk the R2 list cursor to the end — libraries stay small enough that one
// full listing per page view is fine, and it keeps the UI dependency-free.
async function listAllMedia(env) {
  const items = [];
  let cursor;
  do {
    const res = await env.MEDIA.list({ prefix: 'media/', include: ['httpMetadata'], cursor });
    items.push(...(res.objects || []));
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  // Newest first (uploaded is an R2-provided Date).
  items.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  return items;
}

// ── Virtual folders (site_config: media_folders) ─────────────────────────────
// Shape: { folders: ['Logos', …], assign: { 'media/202607/…-x.png': 'Logos' } }

async function getFolderConfig(DB) {
  const cfg = (await getSiteConfig(DB, 'media_folders', null)) || {};
  return {
    folders: Array.isArray(cfg.folders) ? cfg.folders.filter((f) => typeof f === 'string' && f) : [],
    assign: cfg.assign && typeof cfg.assign === 'object' && !Array.isArray(cfg.assign) ? cfg.assign : {},
  };
}

async function saveFolderConfig(DB, cfg) {
  await setSiteConfig(DB, 'media_folders', {
    folders: Array.from(new Set(cfg.folders.filter(Boolean))),
    assign: cfg.assign,
  });
}

// Move a key into `folder` ('' = Unfiled). New folder names join the list.
async function assignFolder(DB, key, folder) {
  const cfg = await getFolderConfig(DB);
  if (folder) {
    cfg.assign[key] = folder;
    if (!cfg.folders.includes(folder)) cfg.folders.push(folder);
  } else {
    delete cfg.assign[key];
  }
  await saveFolderConfig(DB, cfg);
}

// Emoticons (media/emoticons/*, managed on /admin/emoticons) surface here as a
// locked virtual folder named "Emoticon": they cannot be moved or deleted from
// the library, and the name is reserved so no real folder can shadow it.
const EMOTICON_FOLDER = 'Emoticon';
const isEmoticonKey = (key) => String(key || '').startsWith('media/emoticons/');

// Folder names are flat display labels — trim, drop control chars, cap length.
// "Emoticon" is reserved for the locked virtual emoticons folder, so it can
// never be created, renamed onto, or assigned as a normal folder.
function cleanFolderName(value) {
  const name = rawFolderName(value);
  return /^emoticon$/i.test(name) ? '' : name;
}
function rawFolderName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
}

// Display name for a key: filename without the media/<yyyymm>/<ts>- prefix.
function mediaName(key) {
  return String(key || '').split('/').pop().replace(/^\d{9,}-/, '');
}

// One-shot notice pulled from ?ok= / ?err= (set by the POST redirects).
function flashHtml(url) {
  const ok = url.searchParams.get('ok');
  const err = url.searchParams.get('err');
  if (err) return `<div class="notice notice-error">${escapeHtml(err)}</div>`;
  if (ok) return `<div class="notice notice-green">${escapeHtml(ok)}</div>`;
  return '';
}

const MEDIA_STYLES = `<style>
.media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 1rem; }
.media-tile { background: var(--color-surface); border: 1px solid var(--color-surface-dark); border-radius: var(--radius-md); padding: 0.7rem; display: flex; flex-direction: column; gap: 0.5rem; }
.media-thumb { aspect-ratio: 4/3; border-radius: var(--radius-sm); background: var(--color-surface-dark); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.media-thumb img { width: 100%; height: 100%; object-fit: cover; }
.media-ftype { font-weight: 800; font-size: 0.95rem; letter-spacing: 0.08em; color: var(--color-muted); }
.media-name { font-size: 0.76rem; color: var(--color-muted); word-break: break-all; line-height: 1.35; }
.media-copy { display: flex; gap: 0.4rem; }
.media-copy input { font-size: 0.74rem; padding: 0.28rem 0.5rem; font-family: var(--font-mono); }
.media-foot { display: flex; justify-content: space-between; align-items: center; gap: 0.4rem; margin-top: auto; }
.media-actions { display: flex; gap: 0.4rem; }
.media-replace { margin: 0; }
.media-upload-form { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
.media-upload-form input[type=file] { width: auto; }
.media-upload-form select, .media-upload-form input[type=text] { width: auto; font-size: 0.85rem; padding: 0.35rem 0.5rem; }
.media-folders { display: flex; gap: 0.45rem; flex-wrap: wrap; margin-bottom: 1rem; }
.media-chip { display: inline-block; padding: 0.25rem 0.7rem; border: 1px solid var(--color-surface-dark); border-radius: var(--radius-pill); background: var(--color-surface); font-size: 0.82rem; text-decoration: none; color: var(--color-ink); }
.media-chip:hover { border-color: var(--color-brand); }
.media-chip.active { border-color: var(--color-brand); color: var(--color-brand); font-weight: 700; }
.media-chip .count { color: var(--color-muted); font-weight: 400; }
.media-move { margin: 0; display: flex; align-items: center; gap: 0.35rem; }
.media-move select { font-size: 0.78rem; padding: 0.22rem 0.4rem; width: 100%; }
.media-manage { margin: -0.4rem 0 1rem; }
.media-manage summary { cursor: pointer; font-size: 0.85rem; color: var(--color-muted); }
.media-manage summary:hover { color: var(--color-brand); }
.media-manage-rows { display: flex; flex-direction: column; gap: 0.45rem; margin-top: 0.6rem; }
.media-manage-row { display: flex; gap: 0.45rem; align-items: center; flex-wrap: wrap; }
.media-manage-row form { display: flex; gap: 0.45rem; align-items: center; margin: 0; }
.media-manage-row input[type=text] { width: auto; font-size: 0.85rem; padding: 0.3rem 0.5rem; }
.media-manage-row .count { font-size: 0.8rem; color: var(--color-muted); min-width: 4.5rem; }
</style>`;

// Copy-URL affordance: readonly input + button; falls back to select() where
// the clipboard API is unavailable (non-HTTPS dev).
const COPY_SCRIPT = `<script>
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-copy]');
  if (!btn) return;
  var input = btn.closest('.media-copy').querySelector('input');
  input.focus(); input.select();
  var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, done);
  else { try { document.execCommand('copy'); } catch (err) {} done(); }
});
</script>`;

// Replace-in-place: the tile's "Replace" button opens a hidden file input;
// picking a file asks for confirmation (it overwrites everywhere) then submits
// the per-tile form to /admin/media/replace.
const REPLACE_SCRIPT = `<script>
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-replace-btn]');
  if (!btn) return;
  var input = btn.closest('.media-replace').querySelector('[data-replace-input]');
  input.click();
});
document.addEventListener('change', function (e) {
  var input = e.target.closest('[data-replace-input]');
  if (!input || !input.files || !input.files.length) return;
  var form = input.closest('form');
  var name = input.files[0].name;
  var msg = 'Replace this file with \\u201c' + name + '\\u201d? It overwrites the current file at the same URL, so every page using it updates to the new version. This can\\u2019t be undone.';
  var go = function (yes) {
    if (yes) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
    else { input.value = ''; }
  };
  if (window.confirmModal) {
    window.confirmModal(msg, { okLabel: 'Replace', danger: true, title: 'Replace file' }).then(go);
  } else {
    go(window.confirm(msg));
  }
});
</script>`;

// Downscale images before the library upload posts them — big phone photos
// become a single web-sized WebP. Non-images (and browsers without the resizer)
// fall through to the normal multipart submit. Progressive enhancement only.
const UPLOAD_RESIZE_SCRIPT = `<script>
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (!form || !form.classList || !form.classList.contains('media-upload-form')) return;
  if (!window.IMG_RESIZE) return;
  var input = form.querySelector('input[type=file]');
  var file = input && input.files && input.files[0];
  if (!file || !window.IMG_RESIZE.isImage(file)) return; // non-image → normal upload
  e.preventDefault();
  var btn = form.querySelector('button[type=submit]');
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Processing…'; }
  window.IMG_RESIZE.toVariants(file, { single: true }).then(function (res) {
    var v = res.variants[res.variants.length - 1];
    if (!v) throw new Error('resize failed');
    var base = file.name.replace(/\\.[^.]+$/, '') || 'image';
    var fd = new FormData(form);
    fd.set('file', new File([v.blob], base + '.' + v.ext, { type: v.type }));
    fd.append('json', '1');
    return fetch(form.action, { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }).then(function (d) {
    if (d && d.ok) { window.location.assign('/admin/media'); }
    else { window.alert((d && d.error) || 'Upload failed.'); if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Upload'; } }
  }).catch(function () { window.alert('Upload failed.'); if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Upload'; } });
}, true);
</script>`;

// <option> list for a folder select: Unfiled + every known folder.
function folderOptions(folders, selected) {
  return `<option value=""${!selected ? ' selected' : ''}>Unfiled</option>` +
    folders.map((f) =>
      `<option value="${escapeAttr(f)}"${f === selected ? ' selected' : ''}>${escapeHtml(f)}</option>`
    ).join('');
}

async function libraryPage(env, user, url) {
  const [items, cfg] = await Promise.all([listAllMedia(env), getFolderConfig(env.DB)]);
  // Emoticon objects live in the locked virtual "Emoticon" folder regardless
  // of the assign map — they are managed on /admin/emoticons, not here.
  const folderOf = (key) => (isEmoticonKey(key) ? EMOTICON_FOLDER : (cfg.assign[key] || ''));
  const emoticonCount = items.filter((o) => isEmoticonKey(o.key)).length;

  // ?folder= filter: absent = All, '__unfiled', or a folder name.
  const filter = url.searchParams.get('folder') || '';
  const shown = !filter ? items
    : items.filter((o) => (filter === '__unfiled' ? !folderOf(o.key) : folderOf(o.key) === filter));

  const chip = (label, value, count) => {
    const href = value ? `/admin/media?folder=${encodeURIComponent(value)}` : '/admin/media';
    return `<a class="media-chip${filter === value ? ' active' : ''}" href="${escapeAttr(href)}">${escapeHtml(label)} <span class="count">${count}</span></a>`;
  };
  const folderBar = `
    ${cfg.folders.length || emoticonCount ? `
    <div class="media-folders">
      ${chip('All', '', items.length)}
      ${chip('Unfiled', '__unfiled', items.filter((o) => !folderOf(o.key)).length)}
      ${cfg.folders.map((f) => chip(f, f, items.filter((o) => folderOf(o.key) === f).length)).join('')}
      ${emoticonCount ? chip(EMOTICON_FOLDER, EMOTICON_FOLDER, emoticonCount) : ''}
    </div>` : ''}
    <details class="media-manage">
      <summary>Manage folders</summary>
      <div class="media-manage-rows">
        ${cfg.folders.map((f) => `
        <div class="media-manage-row">
          <form method="post" action="/admin/media/folders/rename">
            <input type="hidden" name="from" value="${escapeAttr(f)}">
            <input type="hidden" name="back" value="${escapeAttr(filter)}">
            <input type="text" name="to" value="${escapeAttr(f)}" maxlength="60" required aria-label="New name for ${escapeAttr(f)}">
            <button class="btn btn-secondary btn-small" type="submit">Rename</button>
          </form>
          <form method="post" action="/admin/media/folders/delete"
                data-confirm="Delete the folder “${escapeAttr(f)}”? Its files are kept and become Unfiled." data-confirm-ok="Delete folder">
            <input type="hidden" name="name" value="${escapeAttr(f)}">
            <input type="hidden" name="back" value="${escapeAttr(filter)}">
            <button class="btn btn-danger btn-small" type="submit">Delete</button>
          </form>
          <span class="count">${items.filter((o) => folderOf(o.key) === f).length} file(s)</span>
        </div>`).join('')}
        <div class="media-manage-row">
          <form method="post" action="/admin/media/folders/create">
            <input type="hidden" name="back" value="${escapeAttr(filter)}">
            <input type="text" name="name" placeholder="New folder name" maxlength="60" required aria-label="New folder name">
            <button class="btn btn-small" type="submit">Create</button>
          </form>
        </div>
      </div>
      <p class="muted small" style="margin:0.6rem 0 0">Folders are sorting labels only — renaming or deleting one never touches the files or their URLs.</p>
    </details>`;

  const tiles = shown.map((o) => {
    const fileUrl = url.origin + '/' + o.key;
    const contentType = o.httpMetadata?.contentType || '';
    const thumb = isImageKey(o.key, contentType)
      ? `<img src="/${escapeAttr(o.key)}" alt="" loading="lazy">`
      : `<span class="media-ftype">${escapeHtml(fileTypeLabel(o.key))}</span>`;
    const size = o.size >= 1048576 ? (o.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(o.size / 1024)) + ' KB';
    // Emoticons are locked here: no move select, no Delete — they are managed
    // on /admin/emoticons (their URLs still work as ordinary images anywhere).
    const emoticon = isEmoticonKey(o.key);
    const moveHtml = emoticon
      ? `<p class="media-move muted small" style="margin:0">${EMOTICON_FOLDER}</p>`
      : `<form method="post" action="/admin/media/move" class="media-move">
          <input type="hidden" name="key" value="${escapeAttr(o.key)}">
          <input type="hidden" name="back" value="${escapeAttr(filter)}">
          <select name="folder" onchange="this.form.submit()" title="Move to folder">${folderOptions(cfg.folders, folderOf(o.key))}</select>
        </form>`;
    const ext = extOf(o.key);
    const replaceHtml = `<form method="post" action="/admin/media/replace" enctype="multipart/form-data" class="media-replace">
            <input type="hidden" name="key" value="${escapeAttr(o.key)}">
            <input type="hidden" name="back" value="${escapeAttr(filter)}">
            <input type="file" name="file"${ext ? ` accept=".${escapeAttr(ext)}"` : ''} hidden data-replace-input>
            <button class="btn btn-secondary btn-small" type="button" data-replace-btn>Replace</button>
          </form>`;
    const footHtml = emoticon
      ? `<a class="muted small" href="/admin/emoticons">Manage on the Emoticons page</a>`
      : `<div class="media-actions">${replaceHtml}
          <form method="post" action="/admin/media/delete" data-confirm="Delete this file permanently? Anything still using it will break." data-confirm-ok="Delete">
            <input type="hidden" name="key" value="${escapeAttr(o.key)}">
            <button class="btn btn-danger btn-small" type="submit">Delete</button>
          </form></div>`;
    return `
      <div class="media-tile">
        <div class="media-thumb">${thumb}</div>
        <div class="media-name">${escapeHtml(o.key)}</div>
        ${moveHtml}
        <div class="media-copy">
          <input type="text" readonly value="${escapeAttr(fileUrl)}" onclick="this.select()">
          <button class="btn btn-secondary btn-small" type="button" data-copy>Copy</button>
        </div>
        <div class="media-foot">
          <span class="muted small">${escapeHtml(size)}</span>
          ${footHtml}
        </div>
      </div>`;
  }).join('');

  // Upload straight into the folder being viewed; the free-text input creates a
  // new folder on the fly (it wins over the select when filled in).
  const uploadFolder = filter && filter !== '__unfiled' ? filter : '';
  const content = `
    <div class="page-head">
      <h1>Media</h1>
      <div class="actions">
        <form class="media-upload-form" method="post" action="/admin/media/upload" enctype="multipart/form-data">
          <input type="file" name="file" required>
          <select name="folder" title="Folder">${folderOptions(cfg.folders, uploadFolder)}</select>
          <input type="text" name="new_folder" placeholder="…or a new folder" title="Create a new folder for this file">
          <button class="btn" type="submit">Upload</button>
        </form>
      </div>
    </div>
    ${flashHtml(url)}
    <p class="muted small">Files are stored in R2 and served from <code>/media/…</code>. URLs never change, so pages keep working as long as the file exists. Folders are just sorting labels — moving a file never changes its URL.</p>
    ${folderBar}
    ${shown.length ? `<div class="media-grid">${tiles}</div>`
      : `<p class="muted">${items.length ? 'No files in this folder yet.' : 'No files yet — upload one above.'}</p>`}
    ${COPY_SCRIPT}${REPLACE_SCRIPT}${UPLOAD_RESIZE_SCRIPT}`;

  return html(adminPage({ env, user, title: 'Media', path: '/admin/media', content, extraHead: MEDIA_STYLES + CONFIRM_MODAL_HEAD + '<script src="/js/image-resize.js"></script>' }));
}

// JSON listing for the modal picker: every object plus its folder tag.
// Emoticons appear as normal picker items (usable as ordinary images) under
// the virtual "Emoticon" folder.
async function listJson(env) {
  const [items, cfg] = await Promise.all([listAllMedia(env), getFolderConfig(env.DB)]);
  const hasEmoticons = items.some((o) => isEmoticonKey(o.key));
  return json({
    items: items.map((o) => ({
      key: o.key,
      url: '/' + o.key,
      name: mediaName(o.key),
      folder: isEmoticonKey(o.key) ? EMOTICON_FOLDER : (cfg.assign[o.key] || ''),
      isImage: isImageKey(o.key, o.httpMetadata?.contentType || ''),
      uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null,
    })),
    folders: hasEmoticons ? [...cfg.folders, EMOTICON_FOLDER] : cfg.folders,
  });
}

async function upload(request, env, user) {
  const form = await request.formData();
  const wantsJson = !!form.get('json'); // fetch() uploads (the picker) get JSON back
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) {
    if (wantsJson) return json({ error: 'Choose a file to upload.' }, 400);
    return redirect('/admin/media?err=' + encodeURIComponent('Choose a file to upload.'));
  }

  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const key = makeMediaKey(yyyymm, file.name);
  await env.MEDIA.put(key, file, {
    httpMetadata: { contentType: file.type || contentTypeForKey(key) },
  });

  // A typed "new folder" name wins over the select; both are optional.
  const folder = cleanFolderName(form.get('new_folder')) || cleanFolderName(form.get('folder'));
  if (folder) await assignFolder(env.DB, key, folder);

  await logActivity(env.DB, user, 'uploaded', 'media', key);
  if (wantsJson) return json({ ok: true, key, url: '/' + key });
  const back = folder ? 'folder=' + encodeURIComponent(folder) + '&' : '';
  return redirect('/admin/media?' + back + 'ok=' + encodeURIComponent('Uploaded ' + key));
}

// File extension of a key/name (lowercase, no dot), or '' if none.
function extOf(nameOrKey) {
  const base = String(nameOrKey || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

// Replace an existing file in place: same key → same URL, so every page still
// pointing at it shows the new bytes (subject to the short media cache window).
// The replacement must be the same file type as the original — the URL's
// extension is what the site uses to tell images from video, so changing it
// would silently break type detection wherever the file is embedded.
async function replace(request, env, user) {
  const form = await request.formData();
  const key = String(form.get('key') || '');
  const back = cleanFolderName(form.get('back'));
  const backParams = backQ(back);
  const fail = (msg) => redirect('/admin/media?' + backParams + 'err=' + encodeURIComponent(msg));

  if (!key.startsWith('media/') || key.includes('..')) return fail('Invalid media key.');
  if (isEmoticonKey(key)) {
    return fail('Emoticons cannot be replaced here — manage them on the Emoticons page.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return fail('Choose a replacement file.');

  // The object must already exist — replace never creates a new key.
  const existing = await env.MEDIA.head(key);
  if (!existing) return fail('That file no longer exists.');

  const oldExt = extOf(key);
  const newExt = extOf(file.name);
  if (oldExt && newExt !== oldExt) {
    return fail(`The replacement must be the same file type (.${oldExt}). To change the type, upload a new file and update where it is used.`);
  }

  await env.MEDIA.put(key, file, {
    httpMetadata: { contentType: file.type || contentTypeForKey(key) },
  });
  await logActivity(env.DB, user, 'replaced', 'media', key);
  return redirect('/admin/media?' + backParams + 'ok=' + encodeURIComponent('Replaced ' + key + ' — the URL is unchanged, so every reference now points at the new file. Images are cached hard, so browsers that already have the old one may need a refresh to see it.'));
}

// Re-tag a file ('' = Unfiled). Only the site_config map changes — never R2.
async function move(request, env, user) {
  const form = await request.formData();
  const key = String(form.get('key') || '');
  if (!key.startsWith('media/') || key.includes('..')) {
    return redirect('/admin/media?err=' + encodeURIComponent('Invalid media key.'));
  }
  if (isEmoticonKey(key)) {
    return redirect('/admin/media?err=' + encodeURIComponent('Emoticons stay in the Emoticon folder — manage them on the Emoticons page.'));
  }
  const folder = cleanFolderName(form.get('folder'));
  await assignFolder(env.DB, key, folder);
  await logActivity(env.DB, user, 'moved', 'media', `${key} → ${folder || 'Unfiled'}`);
  const back = cleanFolderName(form.get('back'));
  const backQ = back ? 'folder=' + encodeURIComponent(back) + '&' : '';
  return redirect('/admin/media?' + backQ + 'ok=' + encodeURIComponent(folder ? `Moved to ${folder}.` : 'Moved to Unfiled.'));
}

async function remove(request, env, user) {
  const form = await request.formData();
  const key = String(form.get('key') || '');
  // Only ever delete inside the media/ prefix — nothing else is ours.
  if (!key.startsWith('media/') || key.includes('..')) {
    return redirect('/admin/media?err=' + encodeURIComponent('Invalid media key.'));
  }
  if (isEmoticonKey(key)) {
    return redirect('/admin/media?err=' + encodeURIComponent('Emoticons cannot be deleted here — manage them on the Emoticons page.'));
  }
  await env.MEDIA.delete(key);
  // Drop the folder tag too, so the map never collects dead keys.
  const cfg = await getFolderConfig(env.DB);
  if (cfg.assign[key] !== undefined) {
    delete cfg.assign[key];
    await saveFolderConfig(env.DB, cfg);
  }
  await logActivity(env.DB, user, 'deleted', 'media', key);
  return redirect('/admin/media?ok=' + encodeURIComponent('Deleted ' + key));
}

// Query-string prefix for returning to a folder filter ('' = All).
const backQ = (folder) => (folder ? 'folder=' + encodeURIComponent(folder) + '&' : '');

// Create an empty folder tag so uploads and moves can target it straight away.
async function createFolder(request, env, user) {
  const form = await request.formData();
  const name = cleanFolderName(form.get('name'));
  const back = cleanFolderName(form.get('back'));
  if (!name) return redirect('/admin/media?' + backQ(back) + 'err=' + encodeURIComponent('Enter a folder name.'));
  const cfg = await getFolderConfig(env.DB);
  if (cfg.folders.includes(name)) {
    return redirect('/admin/media?' + backQ(back) + 'err=' + encodeURIComponent(`A folder called “${name}” already exists — pick another name.`));
  }
  cfg.folders.push(name);
  await saveFolderConfig(env.DB, cfg);
  await logActivity(env.DB, user, 'created', 'media folder', name);
  return redirect('/admin/media?' + backQ(back) + 'ok=' + encodeURIComponent(`Created the folder “${name}”.`));
}

// Rename a folder: swap the name in the list and in every assign entry pointing
// at it. Renaming onto an existing folder's name is rejected (no implicit
// merging — delete the folder instead if that's what's wanted). R2 untouched.
async function renameFolder(request, env, user) {
  const form = await request.formData();
  const from = cleanFolderName(form.get('from'));
  const to = cleanFolderName(form.get('to'));
  let back = cleanFolderName(form.get('back'));
  const cfg = await getFolderConfig(env.DB);
  if (!from || !cfg.folders.includes(from)) {
    return redirect('/admin/media?' + backQ(back) + 'err=' + encodeURIComponent('That folder no longer exists.'));
  }
  if (!to) return redirect('/admin/media?' + backQ(back) + 'err=' + encodeURIComponent('Enter a new folder name.'));
  if (to === from) return redirect('/admin/media?' + backQ(back));
  if (cfg.folders.includes(to)) {
    return redirect('/admin/media?' + backQ(back) + 'err=' + encodeURIComponent(`A folder called “${to}” already exists — pick another name.`));
  }
  cfg.folders = cfg.folders.map((f) => (f === from ? to : f));
  for (const key of Object.keys(cfg.assign)) if (cfg.assign[key] === from) cfg.assign[key] = to;
  await saveFolderConfig(env.DB, cfg);
  await logActivity(env.DB, user, 'renamed', 'media folder', `${from} → ${to}`);
  if (back === from) back = to; // keep the filter following the renamed folder
  return redirect('/admin/media?' + backQ(back) + 'ok=' + encodeURIComponent(`Renamed “${from}” to “${to}”.`));
}

// Delete a folder tag: drop it from the list and clear every assign entry so
// its files show as Unfiled. The R2 objects are NEVER touched.
async function deleteFolder(request, env, user) {
  const form = await request.formData();
  const name = cleanFolderName(form.get('name'));
  let back = cleanFolderName(form.get('back'));
  const cfg = await getFolderConfig(env.DB);
  if (!name || !cfg.folders.includes(name)) {
    return redirect('/admin/media?err=' + encodeURIComponent('That folder no longer exists.'));
  }
  cfg.folders = cfg.folders.filter((f) => f !== name);
  for (const key of Object.keys(cfg.assign)) if (cfg.assign[key] === name) delete cfg.assign[key];
  await saveFolderConfig(env.DB, cfg);
  await logActivity(env.DB, user, 'deleted', 'media folder', name);
  if (back === name) back = ''; // the filtered folder is gone — back to All
  return redirect('/admin/media?' + backQ(back) + 'ok=' + encodeURIComponent(`Deleted the folder “${name}” — its files are now Unfiled.`));
}
