// DragonslairCMS media picker. Provides window.MEDIA:
//   MEDIA.open(callback)   — modal media library: filter by folder, search,
//                            click a file (or upload a new one) → callback(url)
//   MEDIA.attach(input)    — turn an <input data-media> into an input + Browse combo
//   MEDIA.attachAll(root)  — attach every input[data-media] under root (or document)
// Data comes from GET /admin/media/list.json; uploads POST multipart to the
// existing /admin/media/upload endpoint with json=1 so it answers JSON.
// Manual URL entry keeps working — the Browse button only fills the input.
// Everything dynamic goes into the DOM via createElement/textContent, never
// innerHTML, so file names and keys can't inject markup.
(function () {
  if (window.MEDIA) return;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ftype(name) {
    var ext = String(name || '').split('.').pop() || 'FILE';
    return ext.toUpperCase().slice(0, 5);
  }

  function fetchList() {
    return fetch('/admin/media/list.json', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { return { items: (d && d.items) || [], folders: (d && d.folders) || [] }; });
  }

  function open(callback) {
    var state = { items: [], folders: [], folder: '', q: '' };

    var overlay = el('div', 'mp-overlay');
    var modal = el('div', 'mp-modal');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');

    var head = el('div', 'mp-head');
    head.appendChild(el('strong', null, 'Media library'));
    var close = el('button', 'mp-close'); close.type = 'button';
    close.setAttribute('aria-label', 'Close'); close.textContent = '×';
    head.appendChild(close);

    var bar = el('div', 'mp-bar');
    var folderSel = el('select', 'mp-folder'); folderSel.title = 'Filter by folder';
    var search = el('input', 'mp-search'); search.type = 'text'; search.placeholder = 'Search files…';
    var upBtn = el('button', 'btn btn-secondary btn-small', 'Upload'); upBtn.type = 'button';
    var status = el('span', 'mp-status');
    bar.appendChild(folderSel); bar.appendChild(search); bar.appendChild(upBtn); bar.appendChild(status);

    var body = el('div', 'mp-body');
    modal.appendChild(head); modal.appendChild(bar); modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function done() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function choose(url) { if (callback) callback(url); done(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(); } }
    close.addEventListener('click', done);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) done(); });
    document.addEventListener('keydown', onKey, true);

    function paintFolders() {
      folderSel.innerHTML = '';
      var oAll = el('option', null, 'All folders'); oAll.value = ''; folderSel.appendChild(oAll);
      var oUn = el('option', null, 'Unfiled'); oUn.value = '__unfiled'; folderSel.appendChild(oUn);
      state.folders.forEach(function (f) {
        var o = el('option', null, f); o.value = f; folderSel.appendChild(o);
      });
      folderSel.value = state.folder;
    }

    function matches(it) {
      if (state.folder === '__unfiled' && it.folder) return false;
      if (state.folder && state.folder !== '__unfiled' && it.folder !== state.folder) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if ((it.name || '').toLowerCase().indexOf(q) < 0 && (it.key || '').toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    }

    function paintGrid() {
      body.innerHTML = '';
      var list = state.items.filter(matches);
      var images = list.filter(function (it) { return it.isImage; });
      var files = list.filter(function (it) { return !it.isImage; });

      if (!list.length) {
        body.appendChild(el('p', 'mp-empty', state.items.length ? 'No files match.' : 'No files yet — upload one above.'));
        return;
      }
      if (images.length) {
        var grid = el('div', 'mp-grid');
        images.forEach(function (it) {
          var tile = el('button', 'mp-tile'); tile.type = 'button'; tile.title = it.key;
          var thumb = el('div', 'mp-thumb');
          var img = el('img'); img.src = it.url; img.alt = ''; img.loading = 'lazy';
          thumb.appendChild(img); tile.appendChild(thumb);
          tile.appendChild(el('div', 'mp-name', it.name));
          if (it.folder) tile.appendChild(el('div', 'mp-tag', it.folder));
          tile.addEventListener('click', function () { choose(it.url); });
          grid.appendChild(tile);
        });
        body.appendChild(grid);
      }
      if (files.length) {
        var chips = el('div', 'mp-chips');
        files.forEach(function (it) {
          var chip = el('button', 'mp-chip'); chip.type = 'button'; chip.title = it.key;
          chip.appendChild(el('span', 'mp-chip-type', ftype(it.name)));
          chip.appendChild(el('span', 'mp-chip-name', it.name));
          if (it.folder) chip.appendChild(el('span', 'mp-tag', it.folder));
          chip.addEventListener('click', function () { choose(it.url); });
          chips.appendChild(chip);
        });
        body.appendChild(chips);
      }
    }

    function reload() {
      return fetchList().then(function (d) {
        state.items = d.items; state.folders = d.folders;
        paintFolders(); paintGrid();
      }, function () {
        status.textContent = 'Could not load the media library.';
      });
    }

    folderSel.addEventListener('change', function () { state.folder = folderSel.value; paintGrid(); });
    search.addEventListener('input', function () { state.q = search.value.trim(); paintGrid(); });

    // Upload from inside the picker: OS file dialog → multipart POST to the
    // normal upload endpoint (json=1) → pick the fresh file straight away.
    upBtn.addEventListener('click', function () {
      var f = el('input'); f.type = 'file'; f.style.display = 'none';
      modal.appendChild(f);
      f.addEventListener('change', function () {
        var file = f.files && f.files[0];
        f.remove();
        if (!file) return;
        status.textContent = 'Uploading…';
        var fd = new FormData();
        fd.append('file', file);
        fd.append('json', '1');
        // Viewing a real folder? Drop the new file straight into it.
        if (state.folder && state.folder !== '__unfiled') fd.append('folder', state.folder);
        fetch('/admin/media/upload', { method: 'POST', body: fd, credentials: 'same-origin' })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
            if (res.ok && res.d && res.d.url) { status.textContent = ''; choose(res.d.url); }
            else status.textContent = (res.d && res.d.error) || 'Upload failed.';
          }, function () { status.textContent = 'Upload failed.'; });
      });
      f.click();
    });

    reload();
    search.focus();
  }

  // Wrap an <input data-media> so a Browse button sits next to it. Picking
  // fills the input and fires input/change so any editor state stays in sync.
  function attach(input) {
    if (!input || input.getAttribute('data-media-done')) return;
    input.setAttribute('data-media-done', '1');
    var box = el('div', 'mp-field');
    input.parentNode.insertBefore(box, input);
    box.appendChild(input);
    var btn = el('button', 'btn btn-secondary btn-small mp-browse', 'Browse…'); btn.type = 'button';
    box.appendChild(btn);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      open(function (url) {
        input.value = url;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  window.MEDIA = {
    open: open,
    attach: attach,
    attachAll: function (root) {
      (root || document).querySelectorAll('input[data-media]:not([data-media-done])').forEach(attach);
    },
  };

  // Server-rendered fields carry data-media in the markup; pick them up on load.
  function init() { window.MEDIA.attachAll(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
