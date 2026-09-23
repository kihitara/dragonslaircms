// "PDF" button in the editor action bars: loads the record's /print view into a
// hidden same-origin iframe and prints just that frame, so the editor is never
// navigated away and no popup is opened. The print view prints itself once its
// fonts have settled (see PRINT_SCRIPT in admin-export.js).
//
// The browser's own print dialog produces the PDF — Workers can't render one
// without the paid Browser Rendering binding.
(function () {
  'use strict';

  var busy = false;

  function cleanUp(frame, btn, label) {
    if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    if (btn) { btn.disabled = false; btn.textContent = label; }
    busy = false;
  }

  function print(url, btn) {
    if (busy) return;
    busy = true;
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing…';

    var frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';

    var done = false;
    function finish() { if (!done) { done = true; cleanUp(frame, btn, label); } }

    frame.addEventListener('load', function () {
      try {
        // The print view prints itself; afterprint tells us when to tidy up.
        frame.contentWindow.addEventListener('afterprint', finish);
      } catch (e) { /* cross-origin should be impossible here, but never trap the button */ }
      // Fallback: some browsers never fire afterprint (and Safari fires it late).
      setTimeout(finish, 60000);
      btn.textContent = label;
      btn.disabled = false;
    });

    frame.addEventListener('error', function () {
      alert('Could not build the print view. Save the page and try again.');
      finish();
    });

    frame.src = url;
    document.body.appendChild(frame);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-print-url]');
    if (!btn) return;
    e.preventDefault();
    print(btn.getAttribute('data-print-url'), btn);
  });
})();
