// Shared list pagination: page size is a per-user preference (users.page_size)
// changed via ?ps= and remembered; page number travels in ?page=.

export const PAGE_SIZES = [20, 50, 100];

// Resolve the effective page size for this request. A valid ?ps= is persisted
// as the user's preference; otherwise the stored preference (default 20) wins.
export async function getPageSize(DB, user, url) {
  const requested = Number(url.searchParams.get('ps'));
  if (PAGE_SIZES.includes(requested)) {
    try {
      await DB.prepare('UPDATE users SET page_size = ? WHERE id = ?').bind(requested, user.id).run();
    } catch { /* unmigrated column → session-only preference */ }
    return requested;
  }
  try {
    const row = await DB.prepare('SELECT page_size FROM users WHERE id = ?').bind(user.id).first();
    if (row && PAGE_SIZES.includes(row.page_size)) return row.page_size;
  } catch { /* fall through to default */ }
  return PAGE_SIZES[0];
}

export function currentPage(url) {
  const p = Number(url.searchParams.get('page'));
  return Number.isInteger(p) && p > 0 ? p : 1;
}

// Rebuild the current URL with some query params changed (null deletes).
function withParams(url, changes) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) u.searchParams.delete(k);
    else u.searchParams.set(k, String(v));
  }
  return u.pathname + u.search;
}

// Controls row: prev/next + a window of page links, and the per-page selector.
// Renders nothing when the list fits one page at the smallest size.
export function paginationControls(url, { page, pageSize, total }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1 && total <= PAGE_SIZES[0]) return '';

  const link = (p, label, cls = '') =>
    p === null
      ? `<span class="${cls}">${label}</span>`
      : `<a class="${cls}" href="${withParams(url, { page: p === 1 ? null : p })}">${label}</a>`;

  // Window of up to 7 page numbers centred on the current page.
  const windowStart = Math.max(1, Math.min(page - 3, pages - 6));
  const windowEnd = Math.min(pages, windowStart + 6);
  const numbers = [];
  for (let p = windowStart; p <= windowEnd; p++) {
    numbers.push(p === page ? link(null, String(p), 'current') : link(p, String(p)));
  }

  const sizeOptions = PAGE_SIZES.map((s) =>
    `<option value="${withParams(url, { ps: s, page: null })}"${s === pageSize ? ' selected' : ''}>${s}</option>`
  ).join('');

  return `
  <div class="list-pagination">
    <div class="pagination">
      ${page > 1 ? link(page - 1, '‹') : ''}
      ${numbers.join('')}
      ${page < pages ? link(page + 1, '›') : ''}
    </div>
    <label class="page-size">Per page
      <select onchange="location=this.value">${sizeOptions}</select>
    </label>
  </div>`;
}
