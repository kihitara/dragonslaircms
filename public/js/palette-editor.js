// DragonslairCMS — surface palette designer. One collapsible <details> per
// surface (closed by default; the summary shows the label + surface-<key>
// class): opening it reveals the role→token pickers above a live preview
// recoloured in place (the preview's --c-* vars are set inline from the
// surface's current token choices, so the swatches and preview track the
// real theme via var(--color-…)).
//
// Reads (injected by the admin page):
//   window.__CONFIG            { surfaceKey: { role: tokenName } }
//   window.__PALETTE_SURFACES  [[key, label], …]
//   window.__PALETTE_ROLES     [[roleKey, cssVar, label], …]
//   window.__PALETTE_TOKENS    [tokenName, …]
//   window.__PALETTE_SAMPLE    HTML string for the preview
// Serialises the whole map into the hidden #config-json input on every change.
(function () {
  var root = document.getElementById('palette-editor');
  var hidden = document.getElementById('config-json');
  if (!root || !hidden) return;
  var data = (window.__CONFIG && typeof window.__CONFIG === 'object') ? window.__CONFIG : {};
  var SURFACES = window.__PALETTE_SURFACES || [];
  var ROLES = window.__PALETTE_ROLES || [];
  var TOKENS = window.__PALETTE_TOKENS || [];
  var SAMPLE = window.__PALETTE_SAMPLE || '';

  function sync() { hidden.value = JSON.stringify(data); }
  function previewStyle(roles) {
    var vars = ROLES.map(function (r) { var t = roles[r[0]]; return t ? r[1] + ':var(--color-' + t + ')' : ''; }).filter(Boolean).join(';');
    return vars + ';background:var(--c-bg);color:var(--c-text)';
  }

  SURFACES.forEach(function (s) {
    var key = s[0], label = s[1];
    if (!data[key] || typeof data[key] !== 'object') data[key] = {};
    var roles = data[key];

    var row = document.createElement('details'); row.className = 'pal-row';
    var head = document.createElement('summary'); head.className = 'pal-title';
    var h = document.createElement('span'); h.className = 'pal-name'; h.textContent = label; head.appendChild(h);
    var cls = document.createElement('code'); cls.textContent = 'surface-' + key; head.appendChild(cls);
    row.appendChild(head);
    var body = document.createElement('div'); body.className = 'pal-body';

    var fs = document.createElement('fieldset'); fs.className = 'pal-pickers';
    // Pickers flow as a wrapping grid of equal-width cells (above the preview).
    var grid = document.createElement('div'); grid.className = 'pal-fields'; fs.appendChild(grid);

    var preview = document.createElement('div'); preview.className = 'pal-preview'; preview.innerHTML = SAMPLE;
    function paintPreview() { preview.setAttribute('style', previewStyle(roles)); }
    // Make the sample's tabbed content switch (FAQ uses native <details>, no JS).
    var ptabs = preview.querySelectorAll('[data-pptab]');
    var ppanels = preview.querySelectorAll('[data-pppanel]');
    ptabs.forEach(function (t) {
      t.addEventListener('click', function () {
        var i = t.getAttribute('data-pptab');
        ptabs.forEach(function (x) { if (x.getAttribute('data-pptab') === i) x.classList.add('ppb-tab-on'); else x.classList.remove('ppb-tab-on'); });
        ppanels.forEach(function (p) { p.hidden = p.getAttribute('data-pppanel') !== i; });
      });
    });

    ROLES.forEach(function (r) {
      var fld = document.createElement('div'); fld.className = 'fld';
      var l = document.createElement('label'); l.className = 'fld-label'; l.textContent = r[2]; fld.appendChild(l);
      var tf = document.createElement('span'); tf.className = 'token-field';
      var sw = document.createElement('span'); sw.className = 'token-swatch';
      var sel = document.createElement('select');
      TOKENS.forEach(function (t) { var o = document.createElement('option'); o.value = t; o.textContent = t; if (t === roles[r[0]]) o.selected = true; sel.appendChild(o); });
      function paintSw() { sw.style.background = sel.value ? 'var(--color-' + sel.value + ')' : 'transparent'; }
      paintSw();
      sel.addEventListener('change', function () { roles[r[0]] = sel.value; paintSw(); paintPreview(); sync(); });
      tf.appendChild(sw); tf.appendChild(sel); fld.appendChild(tf); grid.appendChild(fld);
    });

    paintPreview();
    body.appendChild(fs); body.appendChild(preview);
    row.appendChild(body);
    root.appendChild(row);
  });

  var form = root.closest('form'); if (form) form.addEventListener('submit', sync);
  sync();
})();
