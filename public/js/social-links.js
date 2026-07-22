// DragonslairCMS — repeatable "Social links" rows on the people admin form.
// Markup contract (rendered by src/routes/admin-people.js):
//   <div id="social-links" data-links='[{"type":"linkedin","url":"…"},…]'></div>
//   <input type="hidden" name="social_links" id="social-links-json">
// Rows are [type select][URL input][label input (Other only)][Remove], plus an
// Add button. The rows serialise to the hidden input as a JSON array of
// { type, url, label? } on every change and again on form submit; rows with an
// empty URL are dropped. The server re-validates types and URLs.
(function () {
  'use strict';
  if (window.SOCIAL_LINKS) return;

  var TYPES = [
    ['website', 'Website'], ['linkedin', 'LinkedIn'], ['facebook', 'Facebook'],
    ['twitter', 'Twitter/X'], ['instagram', 'Instagram'], ['bluesky', 'Bluesky'],
    ['mastodon', 'Mastodon'], ['other', 'Other'],
  ];

  function init(box) {
    if (!box || box.getAttribute('data-sl-done')) return;
    box.setAttribute('data-sl-done', '1');
    var hidden = document.getElementById('social-links-json');

    var links = [];
    try {
      var a = JSON.parse(box.getAttribute('data-links') || '[]');
      if (Array.isArray(a)) links = a;
    } catch (e) { /* start empty */ }

    var rows = document.createElement('div');
    rows.className = 'sl-rows';
    box.appendChild(rows);

    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-secondary btn-small';
    add.textContent = '+ Add link';
    add.addEventListener('click', function () {
      addRow({ type: 'website', url: '', label: '' });
      serialize();
      var last = rows.lastElementChild;
      if (last) { var u = last.querySelector('.sl-url'); if (u) u.focus(); }
    });
    box.appendChild(add);

    function addRow(link) {
      var row = document.createElement('div'); row.className = 'sl-row';

      var sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Link type');
      TYPES.forEach(function (t) {
        var op = document.createElement('option');
        op.value = t[0]; op.textContent = t[1];
        if (t[0] === link.type) op.selected = true;
        sel.appendChild(op);
      });

      var url = document.createElement('input');
      url.type = 'url'; url.className = 'sl-url';
      url.placeholder = 'https://…';
      url.value = link.url || '';
      url.setAttribute('aria-label', 'Link URL');

      var label = document.createElement('input');
      label.type = 'text'; label.className = 'sl-label';
      label.placeholder = 'Label';
      label.value = link.label || '';
      label.maxLength = 80;
      label.setAttribute('aria-label', 'Custom label');

      var rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'sl-rm';
      rm.textContent = 'Remove'; rm.title = 'Remove this link';
      rm.addEventListener('click', function () { row.remove(); serialize(); });

      function toggleLabel() { label.style.display = sel.value === 'other' ? '' : 'none'; }
      sel.addEventListener('change', function () { toggleLabel(); serialize(); });
      url.addEventListener('input', serialize);
      label.addEventListener('input', serialize);
      toggleLabel();

      row.appendChild(sel); row.appendChild(url); row.appendChild(label); row.appendChild(rm);
      rows.appendChild(row);
    }

    function serialize() {
      var out = [];
      rows.querySelectorAll('.sl-row').forEach(function (row) {
        var type = row.querySelector('select').value;
        var u = row.querySelector('.sl-url').value.trim();
        var l = row.querySelector('.sl-label').value.trim();
        if (!u) return;
        var item = { type: type, url: u };
        if (type === 'other' && l) item.label = l;
        out.push(item);
      });
      if (hidden) hidden.value = JSON.stringify(out);
    }

    links.forEach(addRow);
    serialize();

    var form = box.closest('form');
    if (form) form.addEventListener('submit', serialize);
  }

  function boot() { init(document.getElementById('social-links')); }
  window.SOCIAL_LINKS = { init: init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
