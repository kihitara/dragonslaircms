// Admin sidebar behaviour: mobile hamburger toggle + notification badges.
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    // Hamburger: toggles the sidebar on small screens.
    var burger = document.querySelector('.hamburger');
    if (burger) {
      burger.addEventListener('click', function () {
        var open = document.body.classList.toggle('nav-open');
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      // Navigating (or tapping outside the sidebar) closes the menu.
      document.addEventListener('click', function (e) {
        if (!document.body.classList.contains('nav-open')) return;
        if (e.target.closest('.admin-sidebar') || e.target.closest('.hamburger')) return;
        document.body.classList.remove('nav-open');
        burger.setAttribute('aria-expanded', 'false');
      });
    }

    // Badges: counts for moderation queues, on the items and (summed) on the
    // collapsed section header so the numbers stay visible either way.
    fetch('/admin/badges.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (counts) {
        if (!counts) return;
        var sections = new Map(); // <details> element → sum
        document.querySelectorAll('.admin-sidebar [data-badge]').forEach(function (link) {
          var n = counts[link.getAttribute('data-badge')] || 0;
          if (!n) return;
          var b = document.createElement('span');
          b.className = 'nav-badge';
          b.textContent = n > 99 ? '99+' : String(n);
          link.appendChild(b);
          var details = link.closest('details.nav-section');
          if (details) sections.set(details, (sections.get(details) || 0) + n);
        });
        sections.forEach(function (sum, details) {
          var summary = details.querySelector('summary');
          if (!summary) return;
          var b = document.createElement('span');
          b.className = 'nav-badge';
          b.textContent = sum > 99 ? '99+' : String(sum);
          summary.appendChild(b);
        });
      })
      .catch(function () { /* badges are decoration — never break the page */ });
  });
})();
