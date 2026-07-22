// Editor preview: POST the current (unsaved) editor form to a preview endpoint
// and show the rendered page in a slide-out panel with an <iframe>. Triggered
// by a [data-preview-url] button. Nothing is saved — this just mirrors what the
// live page would look like. Non-live: it does not update as you type; press
// Preview again to refresh.
(function () {
  var btn = document.querySelector('[data-preview-url]');
  if (!btn) return;
  var endpoint = btn.getAttribute('data-preview-url');

  // The Preview button may sit outside the editor <form> (page editor) or
  // inside it (article editor) — resolve the form robustly.
  function editorForm() {
    return btn.closest('form')
      || (document.getElementById('blocks-json') && document.getElementById('blocks-json').closest('form'))
      || (document.querySelector('.editor-columns') && document.querySelector('.editor-columns').closest('form'))
      || document.querySelector('form');
  }

  var panel, iframe, backdrop, keyHandler;

  function build() {
    backdrop = document.createElement('div');
    backdrop.className = 'pv-backdrop';
    backdrop.addEventListener('click', close);

    panel = document.createElement('div');
    panel.className = 'pv-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Page preview');

    var head = document.createElement('div');
    head.className = 'pv-head';
    var title = document.createElement('div');
    title.className = 'pv-title';
    title.innerHTML = 'Preview <span class="pv-note">Not published — how it will look once live</span>';
    var close_ = document.createElement('button');
    close_.type = 'button';
    close_.className = 'pv-close';
    close_.setAttribute('aria-label', 'Close preview');
    close_.innerHTML = '&times;';
    close_.addEventListener('click', close);
    head.appendChild(title);
    head.appendChild(close_);

    iframe = document.createElement('iframe');
    iframe.className = 'pv-frame';
    iframe.setAttribute('title', 'Preview');

    panel.appendChild(head);
    panel.appendChild(iframe);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    keyHandler = function (e) { if (e.key === 'Escape') close(); };
  }

  function open() {
    if (!panel) build();
    document.body.classList.add('pv-open');
    backdrop.classList.add('show');
    panel.classList.add('show');
    document.addEventListener('keydown', keyHandler, true);
  }
  function close() {
    if (!panel) return;
    panel.classList.remove('show');
    backdrop.classList.remove('show');
    document.body.classList.remove('pv-open');
    document.removeEventListener('keydown', keyHandler, true);
    iframe.removeAttribute('srcdoc'); // stop any playing media
  }

  function setMessage(msg) {
    iframe.srcdoc = '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;margin:0;display:flex;'
      + 'align-items:center;justify-content:center;height:100vh;color:#666">' + msg + '</body>';
  }

  btn.addEventListener('click', function () {
    var form = editorForm();
    if (!form) return;
    open();
    setMessage('Rendering preview…');
    fetch(endpoint, { method: 'POST', body: new FormData(form), credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (htmlText) { if (panel.classList.contains('show')) iframe.srcdoc = htmlText; })
      .catch(function () { setMessage('Preview failed — try saving first, then Preview again.'); });
  });
})();
