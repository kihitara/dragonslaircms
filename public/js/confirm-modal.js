// DragonslairCMS styled confirm/alert dialogs — replaces the browser's native
// confirm()/alert() across the admin. Provides:
//   window.confirmModal(message, opts) → Promise<boolean>
//     opts: { okLabel: 'Confirm', cancelLabel: 'Cancel', danger: true, title }
//   window.alertModal(message, opts)   → Promise (single OK button)
// Server-rendered markup opts in declaratively — no inline JS needed:
//   <form data-confirm="Really delete?">…      gated on submit (incl. Enter key)
//   <button data-confirm="Really?" …>          gated on click (formaction respected)
//   <a data-confirm="Really?" href="…">        gated on click
// Optional attributes: data-confirm-ok="Delete" labels the confirm button,
// data-confirm-danger="0" swaps the danger styling for the primary button.
// Everything dynamic goes into the DOM via textContent, never innerHTML, so
// messages and labels can't inject markup.
(function () {
  if (window.confirmModal) return;

  function confirmModal(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement('div'); overlay.className = 'cfm-overlay';
      var box = document.createElement('div'); box.className = 'cfm-box';
      box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true');
      if (opts.title) {
        var h = document.createElement('div'); h.className = 'cfm-title'; h.textContent = opts.title;
        box.appendChild(h);
      }
      var msg = document.createElement('p'); msg.className = 'cfm-msg'; msg.textContent = message || 'Are you sure?';
      box.appendChild(msg);

      var acts = document.createElement('div'); acts.className = 'cfm-actions';
      var cancel = null;
      if (!opts.alert) {
        cancel = document.createElement('button'); cancel.type = 'button';
        cancel.className = 'btn btn-secondary'; cancel.textContent = opts.cancelLabel || 'Cancel';
        acts.appendChild(cancel);
      }
      var ok = document.createElement('button'); ok.type = 'button';
      ok.className = opts.danger === false ? 'btn' : 'btn btn-danger';
      ok.textContent = opts.okLabel || 'Confirm';
      acts.appendChild(ok);
      box.appendChild(acts); overlay.appendChild(box); document.body.appendChild(overlay);

      function done(v) { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); }
      // Capture + stopPropagation so Esc/Enter don't also reach whatever sits
      // underneath (an editor, another modal, a form).
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
      }
      ok.addEventListener('click', function () { done(true); });
      if (cancel) cancel.addEventListener('click', function () { done(false); });
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) done(false); });
      document.addEventListener('keydown', onKey, true);
      ok.focus();
    });
  }

  function alertModal(message, opts) {
    opts = opts || {};
    return confirmModal(message, { alert: true, okLabel: opts.okLabel || 'OK', danger: opts.danger === true, title: opts.title });
  }

  function attrOpts(el) {
    return {
      okLabel: el.getAttribute('data-confirm-ok') || 'Confirm',
      danger: el.getAttribute('data-confirm-danger') !== '0',
    };
  }

  // Gate clicks on buttons/links carrying data-confirm (capture phase, before
  // the browser acts). On confirm the element is marked and re-triggered, so
  // formaction/formnovalidate submit buttons keep working.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest
      ? e.target.closest('button[data-confirm], a[data-confirm], input[type=submit][data-confirm]') : null;
    if (!el || el.getAttribute('data-confirmed')) return;
    e.preventDefault(); e.stopPropagation();
    confirmModal(el.getAttribute('data-confirm'), attrOpts(el)).then(function (yes) {
      if (!yes) return;
      el.setAttribute('data-confirmed', '1');
      if (el.tagName === 'A') { window.location.href = el.href; }
      else if (el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(el); }
      else { el.click(); }
      el.removeAttribute('data-confirmed');
    });
  }, true);

  // Gate submits of <form data-confirm> (covers Enter-key submits and forms
  // whose button carries no data-confirm of its own).
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.getAttribute || !form.getAttribute('data-confirm') || form.getAttribute('data-confirmed')) return;
    // Already confirmed via a data-confirm button click? Let it through.
    if (e.submitter && e.submitter.getAttribute && e.submitter.getAttribute('data-confirmed')) return;
    e.preventDefault(); e.stopPropagation();
    var submitter = e.submitter || null;
    confirmModal(form.getAttribute('data-confirm'), attrOpts(form)).then(function (yes) {
      if (!yes) return;
      form.setAttribute('data-confirmed', '1');
      if (typeof form.requestSubmit === 'function') { submitter ? form.requestSubmit(submitter) : form.requestSubmit(); }
      else { form.submit(); }
      form.removeAttribute('data-confirmed');
    });
  }, true);

  window.confirmModal = confirmModal;
  window.alertModal = alertModal;
})();
