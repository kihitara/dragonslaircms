// DragonslairCMS block editor for the admin page form. Reads
// window.__BLOCK_MANIFEST + window.__BLOCKS + window.__SURFACES (injected by
// the server), renders per-block forms with add/remove/reorder/collapse and
// insert-between, and writes the serialized blocks array into the hidden
// #blocks-json input the server saves. If this script fails to run, the hidden
// input keeps its initial value, so a submit is a safe no-op (no data loss).
(function () {
  var MANIFEST = window.__BLOCK_MANIFEST || {};
  var state = Array.isArray(window.__BLOCKS) ? window.__BLOCKS : [];
  var root = document.getElementById('block-editor');
  var hidden = document.getElementById('blocks-json');
  if (!root || !hidden) return;

  // Collapse state is tracked by block-object reference (a WeakSet) so it survives
  // re-renders after reorder/remove — those keep the same objects, just moved.
  var collapsed = new WeakSet();

  function sync() {
    hidden.value = JSON.stringify(state);
  }

  function defaultProps(type) {
    var out = {};
    (MANIFEST[type].fields || []).forEach(function (f) {
      out[f.key] = f.type === 'list' ? [] : f.type === 'boolean' ? false
        : f.type === 'number' ? (f.default != null ? f.default : 0)
        : f.type === 'select' && f.options && f.options.length
          ? (typeof f.options[0] === 'object' ? f.options[0].value : f.options[0])
        : '';
    });
    return out;
  }

  // One form control per field type. richtext = a textarea marked data-richtext,
  // upgraded to the WYSIWYG (window.WYSIWYG, /js/wysiwyg.js) after each render —
  // the editor mirrors its HTML back into the textarea and fires 'input', so the
  // listener below keeps state (and the hidden JSON) current on every keystroke.
  // media = a text input for an image/file URL.
  function makeInput(field, value, onChange) {
    var el;
    if (field.type === 'textarea' || field.type === 'richtext') {
      el = document.createElement('textarea');
      el.value = value == null ? '' : value;
      if (field.type === 'richtext') { el.rows = 8; el.setAttribute('data-richtext', ''); }
    } else if (field.type === 'boolean') {
      el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!value;
    } else if (field.type === 'number') {
      el = document.createElement('input'); el.type = 'number'; el.value = value == null ? '' : value;
    } else if (field.type === 'select') {
      el = document.createElement('select');
      (field.options || []).forEach(function (opt) {
        var val = opt && typeof opt === 'object' ? opt.value : opt;
        var lab = opt && typeof opt === 'object' ? opt.label : opt;
        var o = document.createElement('option'); o.value = val; o.textContent = lab;
        if (val === value) o.selected = true;
        el.appendChild(o);
      });
    } else {
      el = document.createElement('input');
      el.type = field.type === 'date' ? 'date' : 'text';
      el.value = value == null ? '' : value;
      if (field.type === 'media') {
        el.placeholder = 'https://… or /media/…';
        el.setAttribute('data-media', ''); // media picker adds a Browse button (window.MEDIA)
      }
    }
    var evt = (field.type === 'boolean' || field.type === 'select') ? 'change' : 'input';
    el.addEventListener(evt, function () {
      var v = field.type === 'boolean' ? el.checked
        : field.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
      onChange(v); sync();
    });
    return el;
  }

  function labelled(text, el) {
    var wrap = document.createElement('div'); wrap.className = 'fld';
    var lab = document.createElement('label'); lab.className = 'fld-label'; lab.textContent = text;
    wrap.appendChild(lab); wrap.appendChild(el); return wrap;
  }

  function miniBtn(text, fn, disabled) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-secondary btn-small';
    b.textContent = text; if (disabled) b.disabled = true; b.addEventListener('click', fn); return b;
  }

  // Declarative conditional fields: a field with a showIf rule (evaluated against
  // the BLOCK props) is hidden when its condition fails. Unset values pass gte
  // (back-compat with legacy blocks) but fail truthy.
  function fieldVisible(field, props) {
    var c = field && field.showIf;
    if (!c) return true;
    var v = props ? props[c.prop] : undefined;
    if (c.gte != null) return v == null || v === '' || Number(v) >= c.gte;
    if (c.truthy) return !!v;
    if (c.falsy) return !v;
    if (c.equals !== undefined) return v === c.equals;
    return true;
  }

  function renderList(block, field) {
    var wrap = document.createElement('div'); wrap.className = 'listfield';
    var lab = document.createElement('div'); lab.className = 'fld-label'; lab.textContent = field.label;
    wrap.appendChild(lab);
    if (!Array.isArray(block.props[field.key])) block.props[field.key] = [];
    var items = block.props[field.key];
    items.forEach(function (item, ii) {
      var card = document.createElement('div'); card.className = 'item-card';
      var head = document.createElement('div'); head.className = 'item-head';
      var num = document.createElement('span'); num.className = 'item-num'; num.textContent = '#' + (ii + 1);
      var ctrls = document.createElement('span'); ctrls.className = 'item-ctrls';
      ctrls.appendChild(miniBtn('↑', function () { var t = items[ii - 1]; items[ii - 1] = items[ii]; items[ii] = t; render(); }, ii === 0));
      ctrls.appendChild(miniBtn('↓', function () { var t = items[ii + 1]; items[ii + 1] = items[ii]; items[ii] = t; render(); }, ii === items.length - 1));
      ctrls.appendChild(miniBtn('Remove', function () { items.splice(ii, 1); render(); }));
      head.appendChild(num); head.appendChild(ctrls); card.appendChild(head);
      field.itemFields.forEach(function (itf) {
        if (!fieldVisible(itf, block.props)) return; // item-field visibility keys off the BLOCK's props
        card.appendChild(labelled(itf.label, makeInput(itf, item[itf.key], function (v) { item[itf.key] = v; })));
      });
      wrap.appendChild(card);
    });
    wrap.appendChild(miniBtn('+ Add ' + field.label, function () {
      var it = {}; field.itemFields.forEach(function (itf) { it[itf.key] = itf.type === 'boolean' ? false : ''; });
      items.push(it); render();
    }));
    return wrap;
  }

  // First non-empty text/textarea/richtext value in the block — a one-line
  // summary shown when collapsed, so blocks are identifiable without opening.
  function blockSummary(block, def) {
    if (!def || !block || !block.props) return '';
    var fields = def.fields || [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.type !== 'text' && f.type !== 'textarea' && f.type !== 'richtext') continue;
      var raw = block.props[f.key];
      if (raw == null || raw === '') continue;
      var text = String(raw);
      if (f.type === 'richtext') { var tmp = document.createElement('div'); tmp.innerHTML = text; text = tmp.textContent || ''; }
      text = text.replace(/\s+/g, ' ').trim();
      if (text) return text.length > 90 ? text.slice(0, 90) + '…' : text;
    }
    return '';
  }

  // ---- Block picker: a modal with a searchable list of block types.
  // Inserts the chosen block at the given index. ----
  var picker = null;
  function closePicker() {
    if (!picker) return;
    picker.remove(); picker = null;
    document.removeEventListener('keydown', onPickKey, true);
  }
  function onPickKey(e) { if (e.key === 'Escape') { e.preventDefault(); closePicker(); } }

  function openPicker(index) {
    closePicker();
    var at = index == null ? state.length : index;
    picker = document.createElement('div'); picker.className = 'blk-modal-overlay';
    picker.addEventListener('mousedown', function (e) { if (e.target === picker) closePicker(); });

    var modal = document.createElement('div'); modal.className = 'blk-modal';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    var head = document.createElement('div'); head.className = 'blk-modal-head';
    var title = document.createElement('strong'); title.textContent = 'Add a block';
    var close = document.createElement('button'); close.type = 'button'; close.className = 'blk-modal-close';
    close.setAttribute('aria-label', 'Close'); close.innerHTML = '&times;';
    close.addEventListener('click', closePicker);
    head.appendChild(title); head.appendChild(close);

    var searchWrap = document.createElement('div'); searchWrap.className = 'blk-modal-search';
    var search = document.createElement('input'); search.type = 'text'; search.placeholder = 'Search blocks…';
    searchWrap.appendChild(search);

    var grid = document.createElement('div'); grid.className = 'blk-grid';
    modal.appendChild(head); modal.appendChild(searchWrap); modal.appendChild(grid);
    picker.appendChild(modal);

    var types = Object.keys(MANIFEST).map(function (k) { return { key: k, label: MANIFEST[k].label || k }; });
    types.sort(function (a, b) { return a.label.localeCompare(b.label); });

    function choose(key) {
      state.splice(at, 0, { type: key, props: defaultProps(key) });
      collapsed.delete(state[at]); // new block starts expanded
      closePicker(); render();
    }
    function paint(q) {
      grid.innerHTML = ''; var ql = (q || '').toLowerCase().trim(); var any = false;
      types.forEach(function (t) {
        if (ql && t.label.toLowerCase().indexOf(ql) < 0 && t.key.toLowerCase().indexOf(ql) < 0) return;
        any = true;
        var b = document.createElement('button'); b.type = 'button'; b.className = 'blk-tile'; b.title = t.label;
        var nm = document.createElement('span'); nm.className = 'blk-tile-name'; nm.textContent = t.label;
        b.appendChild(nm);
        b.addEventListener('click', function () { choose(t.key); });
        grid.appendChild(b);
      });
      if (!any) { var none = document.createElement('div'); none.className = 'blk-grid-none'; none.textContent = 'No matches'; grid.appendChild(none); }
    }
    paint('');
    search.addEventListener('input', function () { paint(search.value); });
    // Enter inserts the first visible match.
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); var first = grid.querySelector('.blk-tile'); if (first) first.click(); }
    });

    document.body.appendChild(picker);
    search.focus();
    document.addEventListener('keydown', onPickKey, true);
  }

  function insertRow(index) {
    var row = document.createElement('div'); row.className = 'blk-insert';
    var b = document.createElement('button');
    b.type = 'button'; b.title = 'Insert a block here'; b.setAttribute('aria-label', 'Insert a block here');
    b.textContent = '+';
    b.addEventListener('click', function () { openPicker(index); });
    row.appendChild(b); return row;
  }

  function render() {
    closePicker();
    root.innerHTML = '';
    if (!state.length) {
      var empty = document.createElement('p'); empty.className = 'editor-empty muted';
      empty.textContent = 'No blocks yet — add one below.'; root.appendChild(empty);
    }
    state.forEach(function (block, idx) {
      root.appendChild(insertRow(idx)); // insert-above affordance
      var def = MANIFEST[block.type];
      var card = document.createElement('div'); card.className = 'block-card';
      if (collapsed.has(block)) card.className += ' collapsed';
      var head = document.createElement('div'); head.className = 'block-head';

      var caret = document.createElement('button');
      caret.type = 'button'; caret.className = 'blk-caret'; caret.setAttribute('aria-label', 'Collapse or expand block');
      caret.textContent = collapsed.has(block) ? '▸' : '▾';

      var main = document.createElement('div'); main.className = 'block-headmain';
      var title = document.createElement('span'); title.className = 'block-type';
      title.textContent = def ? def.label : block.type;
      var sum = document.createElement('div'); sum.className = 'block-sum';
      sum.textContent = blockSummary(block, def);
      main.appendChild(title); main.appendChild(sum);

      function toggle() {
        var c = collapsed.has(block);
        if (c) collapsed.delete(block); else collapsed.add(block);
        card.classList.toggle('collapsed', !c);
        caret.textContent = !c ? '▸' : '▾';
        if (!c) sum.textContent = blockSummary(block, def); // refresh the preview text as it collapses
      }
      caret.addEventListener('click', toggle);
      main.addEventListener('click', toggle);
      head.appendChild(caret); head.appendChild(main);

      var ctrls = document.createElement('span'); ctrls.className = 'block-ctrls';
      ctrls.appendChild(miniBtn('↑', function () { var t = state[idx - 1]; state[idx - 1] = state[idx]; state[idx] = t; render(); }, idx === 0));
      ctrls.appendChild(miniBtn('↓', function () { var t = state[idx + 1]; state[idx + 1] = state[idx]; state[idx] = t; render(); }, idx === state.length - 1));
      ctrls.appendChild(miniBtn('Remove', function () { state.splice(idx, 1); render(); }));
      head.appendChild(ctrls); card.appendChild(head);

      var bodyEl = document.createElement('div'); bodyEl.className = 'block-body';
      if (!def) {
        var warn = document.createElement('p'); warn.className = 'warn';
        warn.textContent = 'Unknown block type "' + block.type + '" — remove it or fix the type in the saved JSON.';
        bodyEl.appendChild(warn);
      } else {
        if (!block.props || typeof block.props !== 'object') block.props = {};
        // Compact controls (selects / numbers / toggles) flow side by side in a
        // grid; wide fields (text, rich text, media, lists) take the full row.
        var grp = null;
        function addCompact(el) {
          if (!grp) { grp = document.createElement('div'); grp.className = 'fld-grid'; bodyEl.appendChild(grp); }
          grp.appendChild(el);
        }
        function addWide(el) { grp = null; bodyEl.appendChild(el); }
        var COMPACT = { select: 1, number: 1, boolean: 1 };

        // Background (surface) picker — applies to every block.
        var surfaces = window.__SURFACES || [];
        if (surfaces.length) {
          var sSel = document.createElement('select');
          surfaces.forEach(function (s) {
            var o = document.createElement('option'); o.value = s.value; o.textContent = s.label;
            if ((block.props.surface || '') === s.value) o.selected = true;
            sSel.appendChild(o);
          });
          sSel.addEventListener('change', function () {
            if (sSel.value) block.props.surface = sSel.value; else delete block.props.surface;
            sync();
          });
          addCompact(labelled('Background', sSel));
        }
        // Keys that other fields' showIf depends on — changing them re-renders so
        // dependent fields appear/disappear live.
        var controllers = {};
        def.fields.forEach(function (f) {
          if (f.showIf && f.showIf.prop) controllers[f.showIf.prop] = 1;
          (f.itemFields || []).forEach(function (itf) { if (itf.showIf && itf.showIf.prop) controllers[itf.showIf.prop] = 1; });
        });
        def.fields.forEach(function (field) {
          if (!fieldVisible(field, block.props)) return;
          if (field.type === 'list') { addWide(renderList(block, field)); return; }
          var onCh = controllers[field.key]
            ? function (v) { block.props[field.key] = v; render(); }
            : function (v) { block.props[field.key] = v; };
          var el = labelled(field.label, makeInput(field, block.props[field.key], onCh));
          if (COMPACT[field.type]) addCompact(el); else addWide(el);
        });
      }
      card.appendChild(bodyEl);
      root.appendChild(card);
    });
    root.appendChild(insertRow(state.length)); // insert-at-end affordance
    if (window.MEDIA) window.MEDIA.attachAll(root); // media picker hook (if that admin feature is present)
    // Upgrade every richtext textarea this render created (top-level fields AND
    // repeat items) to the WYSIWYG. Safe to call repeatedly: upgraded textareas
    // carry data-rt-done and are skipped.
    if (window.WYSIWYG) window.WYSIWYG.upgradeAll(root);
    sync();
  }

  var addBtn = document.getElementById('add-block-btn');
  if (addBtn) addBtn.addEventListener('click', function () { openPicker(state.length); });

  function setAllCollapsed(c) {
    state.forEach(function (b) { if (c) collapsed.add(b); else collapsed.delete(b); });
    render();
  }
  var expandAll = document.getElementById('blocks-expand-all');
  var collapseAll = document.getElementById('blocks-collapse-all');
  if (expandAll) expandAll.addEventListener('click', function () { setAllCollapsed(false); });
  if (collapseAll) collapseAll.addEventListener('click', function () { setAllCollapsed(true); });

  var form = root.closest('form');
  if (form) form.addEventListener('submit', sync);

  state.forEach(function (b) { collapsed.add(b); }); // blocks start collapsed on load
  render();
})();
