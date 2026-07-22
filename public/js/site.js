// Theme toggle: explicit choice wins (persisted), otherwise OS preference.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) {}
  if (saved === 'dark' || saved === 'light') {
    document.documentElement.setAttribute('data-theme', saved);
  }

  function currentTheme() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit) return explicit;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function updateButtons() {
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      var dark = currentTheme() === 'dark';
      btn.textContent = dark ? '☀' : '☾'; // sun / moon
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    updateButtons();
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = currentTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) {}
        updateButtons();
      });
    });
  });
})();

// Mobile site menu: hamburger toggles the nav dropdown; closes on outside
// click, Escape, or resizing back to desktop.
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.querySelector('.site-menu-toggle');
    if (!btn) return;
    function setOpen(open) {
      document.body.classList.toggle('site-nav-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    btn.addEventListener('click', function () {
      setOpen(!document.body.classList.contains('site-nav-open'));
    });
    document.addEventListener('click', function (e) {
      if (!document.body.classList.contains('site-nav-open')) return;
      if (e.target.closest('.site-nav') && !e.target.closest('a')) return; // clicks inside the panel (bar links) keep it open
      if (e.target.closest('.site-menu-toggle')) return;
      setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 640) setOpen(false);
    });
  });
})();

// Nav dropdowns: hover/focus handles desktop via CSS; on touch (no hover) the
// first tap on a parent opens its menu instead of navigating. Outside click
// and Escape close any open dropdown.
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var drops = document.querySelectorAll('.site-nav .nav-drop');
    if (!drops.length) return;
    function closeAll(except) {
      drops.forEach(function (d) {
        if (d === except) return;
        d.classList.remove('open');
        var t = d.querySelector('.nav-drop-toggle');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
    }
    var hoverless = window.matchMedia('(hover: none)').matches;
    drops.forEach(function (d) {
      var toggle = d.querySelector('.nav-drop-toggle');
      if (!toggle) return;
      toggle.addEventListener('click', function (e) {
        var isButton = toggle.tagName === 'BUTTON';
        var open = d.classList.contains('open');
        var inPanel = window.matchMedia('(max-width: 640px)').matches;
        // In the mobile panel every parent toggles (admin-sidebar behaviour).
        // On desktop, buttons toggle; links toggle on touch (first tap opens,
        // second follows the link) and navigate normally with a mouse.
        if (isButton || inPanel || (hoverless && !open)) {
          e.preventDefault();
          if (!inPanel) closeAll(d); // panel sections collapse independently
          d.classList.toggle('open', !open);
          toggle.setAttribute('aria-expanded', String(!open));
        }
      });
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.nav-drop')) closeAll(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll(null);
    });
  });
})();
