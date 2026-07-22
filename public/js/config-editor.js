// DragonslairCMS — recursive, schema-driven config editor (Navigation, Footer,
// Fonts). Reads window.__SCHEMA + window.__CONFIG injected by the admin page,
// renders nested forms (group objects + repeatable lists; lists can nest), and
// serialises the whole object into the hidden #config-json input the server
// saves. Degrades safely: the hidden input keeps its initial value if this
// script doesn't run.
(function () {
  var SCHEMA = window.__SCHEMA || { fields: [] };
  var data = (window.__CONFIG && typeof window.__CONFIG === 'object') ? window.__CONFIG : {};
  var root = document.getElementById('config-editor');
  var hidden = document.getElementById('config-json');
  if (!root || !hidden) return;

  // Which collapsible items are expanded, keyed by the item object (survives the
  // full render() on add/remove/reorder so an open section doesn't snap shut).
  var openItems = new WeakSet();

  function sync() { hidden.value = JSON.stringify(data); }

  function makeInput(field, value, onChange) {
    if (field.type === 'token') {
      // Colour-token picker: a swatch + a <select> of token names. The admin
      // page injects the live theme CSS, so var(--color-<name>) previews live.
      var wrap = document.createElement('span'); wrap.className = 'token-field';
      var sw = document.createElement('span'); sw.className = 'token-swatch';
      var sel = document.createElement('select');
      (field.options || []).forEach(function (opt) {
        var o = document.createElement('option'); o.value = opt; o.textContent = opt; if (opt === value) o.selected = true; sel.appendChild(o);
      });
      function paint() { sw.style.background = sel.value ? 'var(--color-' + sel.value + ')' : 'transparent'; }
      paint();
      sel.addEventListener('change', function () { paint(); onChange(sel.value); sync(); });
      wrap.appendChild(sw); wrap.appendChild(sel);
      return wrap;
    }
    var el;
    if (field.type === 'textarea') {
      el = document.createElement('textarea'); el.value = value == null ? '' : value;
    } else if (field.type === 'boolean') {
      el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!value;
    } else if (field.type === 'select') {
      el = document.createElement('select');
      (field.options || []).forEach(function (opt) {
        var val = opt && typeof opt === 'object' ? opt.value : opt;
        var lab = opt && typeof opt === 'object' ? opt.label : opt;
        var o = document.createElement('option'); o.value = val; o.textContent = lab;
        if (val === value) o.selected = true; el.appendChild(o);
      });
    } else {
      el = document.createElement('input'); el.type = 'text'; el.value = value == null ? '' : value;
      if (field.type === 'media') el.setAttribute('data-media', ''); // media library can attach an Upload button
    }
    var evt = (field.type === 'boolean' || field.type === 'select') ? 'change' : 'input';
    el.addEventListener(evt, function () {
      onChange(field.type === 'boolean' ? el.checked : el.value); sync();
    });
    return el;
  }

  function labelled(text, el) {
    var w = document.createElement('div'); w.className = 'fld';
    var l = document.createElement('label'); l.className = 'fld-label'; l.textContent = text;
    w.appendChild(l); w.appendChild(el); return w;
  }
  function miniBtn(t, fn, dis) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-secondary btn-small';
    b.textContent = t; if (dis) b.disabled = true; b.addEventListener('click', fn); return b;
  }

  // Render the schema fields for object obj into the container element.
  function renderFields(container, fields, obj) {
    fields.forEach(function (field) {
      if (field.type === 'group') {
        if (!obj[field.key] || typeof obj[field.key] !== 'object') obj[field.key] = {};
        var fs = document.createElement('fieldset');
        var lg = document.createElement('legend'); lg.textContent = field.label; fs.appendChild(lg);
        renderFields(fs, field.fields || [], obj[field.key]);
        container.appendChild(fs);
      } else if (field.type === 'list') {
        if (!Array.isArray(obj[field.key])) obj[field.key] = [];
        var arr = obj[field.key];
        var fsl = document.createElement('fieldset');
        var lgl = document.createElement('legend'); lgl.textContent = field.label; fsl.appendChild(lgl);
        arr.forEach(function (item, i) {
          if (typeof item !== 'object' || item === null) { item = {}; arr[i] = item; }
          // Controls (reorder / remove). pd() lets them sit inside a <summary>
          // without toggling the disclosure when clicked.
          var pd = field.collapsible ? function (fn) { return function (e) { e.preventDefault(); e.stopPropagation(); fn(); }; } : function (fn) { return fn; };
          var ctrls = document.createElement('div'); ctrls.className = 'block-ctrls';
          ctrls.appendChild(miniBtn('↑', pd(function () { if (i > 0) { var t = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = t; render(); } }), i === 0));
          ctrls.appendChild(miniBtn('↓', pd(function () { if (i < arr.length - 1) { var t = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = t; render(); } }), i === arr.length - 1));
          ctrls.appendChild(miniBtn('Remove', pd(function () { arr.splice(i, 1); render(); })));

          if (field.collapsible) {
            // Collapsed by default, showing the summaryKey field (label / title)
            // so long menus / footer columns stay scannable. Title tracks edits.
            var det = document.createElement('details'); det.className = 'cfg-item';
            if (openItems.has(item)) det.open = true; // restore expanded state across re-renders
            det.addEventListener('toggle', function () { if (det.open) openItems.add(item); else openItems['delete'](item); });
            var sum = document.createElement('summary');
            var title = document.createElement('span'); title.className = 'cfg-item-title';
            var setTitle = function () {
              var v = (item[field.summaryKey] == null ? '' : String(item[field.summaryKey])).trim();
              title.textContent = v || '(' + (field.itemLabel || 'item') + ')';
            };
            setTitle();
            sum.appendChild(title); sum.appendChild(ctrls);
            det.appendChild(sum);
            var inner = document.createElement('div'); inner.className = 'cfg-item-body';
            renderFields(inner, field.itemFields || [], item);
            det.appendChild(inner);
            det.addEventListener('input', setTitle); det.addEventListener('change', setTitle); // live summary
            fsl.appendChild(det);
          } else {
            var card = document.createElement('div'); card.className = 'item-card';
            renderFields(card, field.itemFields || [], item);
            card.appendChild(ctrls);
            fsl.appendChild(card);
          }
        });
        fsl.appendChild(miniBtn('+ Add ' + (field.itemLabel || 'item'), function () { var ni = {}; arr.push(ni); if (field.collapsible) openItems.add(ni); render(); }));
        container.appendChild(fsl);
      } else {
        container.appendChild(labelled(field.label, makeInput(field, obj[field.key], function (v) { obj[field.key] = v; })));
      }
    });
  }

  function render() {
    root.innerHTML = '';
    renderFields(root, SCHEMA.fields || [], data);
    if (window.MEDIA) window.MEDIA.attachAll(root); // media library hook (if that admin feature is present)
    sync();
  }

  var form = root.closest('form');
  if (form) form.addEventListener('submit', sync);
  render();
})();
