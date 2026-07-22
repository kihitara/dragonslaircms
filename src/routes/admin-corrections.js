// Admin corrections: /admin/corrections* — list open/done with resolved
// article/page titles and links, mark done/reopen, delete. Caller has already
// authenticated `user`.

import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import { CONFIRM_MODAL_HEAD } from '../templates/confirm-modal.js';
import { logActivity } from '../db.js';
import { getPageSize, currentPage, paginationControls } from '../pagination.js';
import { articlePath, nl2br } from '../community.js';

export async function handleCorrections(request, env, url, user) {
  const path = url.pathname.replace(/\/$/, '');

  if (path === '/admin/corrections' && request.method === 'GET') {
    return listCorrections(request, env, url, user);
  }

  if (request.method === 'POST') {
    const m = path.match(/^\/admin\/corrections\/(\d+)\/(done|reopen|delete)$/);
    if (m) return correctionAction(env, Number(m[1]), m[2], user);
  }

  return null;
}

const FILTERS = ['all', 'open', 'done'];

async function listCorrections(request, env, url, user) {
  const DB = env.DB;
  const filter = FILTERS.includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';

  const pageSize = await getPageSize(DB, user, url);
  const page = currentPage(url);
  const total = (await DB.prepare(
    `SELECT COUNT(*) n FROM corrections WHERE (? = 'all' OR status = ?)`
  ).bind(filter, filter).first())?.n ?? 0;

  const { results: corrections = [] } = await DB.prepare(
    `SELECT * FROM corrections
     WHERE (? = 'all' OR status = ?)
     ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(filter, filter, pageSize, (page - 1) * pageSize).all();

  // Resolve entity titles/links in two batched lookups.
  const articleIds = [...new Set(corrections.filter((c) => c.entity_type === 'article').map((c) => c.entity_id))];
  const pageIds = [...new Set(corrections.filter((c) => c.entity_type === 'page').map((c) => c.entity_id))];
  const [articles, pages] = await Promise.all([
    articleIds.length
      ? DB.prepare(`SELECT id, title, slug, category FROM articles WHERE id IN (${articleIds.map(() => '?').join(',')})`)
          .bind(...articleIds).all().then((r) => r.results || [])
      : [],
    pageIds.length
      ? DB.prepare(`SELECT id, title, slug FROM pages WHERE id IN (${pageIds.map(() => '?').join(',')})`)
          .bind(...pageIds).all().then((r) => r.results || [])
      : [],
  ]);
  const articleMap = new Map(articles.map((a) => [a.id, a]));
  const pageMap = new Map(pages.map((p) => [p.id, p]));

  const tabs = FILTERS.map((s) =>
    `<a class="btn btn-small ${s === filter ? '' : 'btn-secondary'}" href="/admin/corrections${s === 'all' ? '' : `?status=${s}`}">${s}</a>`
  ).join(' ');

  const entityCell = (c) => {
    if (c.entity_type === 'article') {
      const a = articleMap.get(c.entity_id);
      if (!a) return `<span class="muted">deleted article #${c.entity_id}</span>`;
      return `<a href="${escapeAttr(articlePath(a))}" target="_blank">${escapeHtml(a.title)}</a>
        <span class="muted small">(article · <a href="/admin/articles/${a.id}">edit</a>)</span>`;
    }
    const p = pageMap.get(c.entity_id);
    if (!p) return `<span class="muted">deleted page #${c.entity_id}</span>`;
    return `<a href="/${escapeAttr(p.slug)}" target="_blank">${escapeHtml(p.title)}</a>
      <span class="muted small">(page · <a href="/admin/pages/${p.id}">edit</a>)</span>`;
  };

  const btn = (id, action, label, cls = 'btn-secondary', confirm = '') =>
    `<form method="post" action="/admin/corrections/${id}/${action}" style="display:inline"${confirm ? ` data-confirm="${escapeAttr(confirm)}" data-confirm-ok="${escapeAttr(label)}"` : ''}><button class="btn btn-small ${cls}" type="submit">${label}</button></form>`;

  const rows = corrections.map((c) => `
    <tr>
      <td class="cell-main">${entityCell(c)}</td>
      <td data-label="Correction">${nl2br(c.body)}</td>
      <td data-label="Status"><span class="status-pill ${escapeAttr(c.status)}">${escapeHtml(c.status)}</span></td>
      <td data-label="Submitted" class="muted small">${escapeHtml((c.created_at || '').slice(0, 16).replace('T', ' '))}</td>
      <td><div class="row-actions">
        ${c.status === 'open' ? btn(c.id, 'done', 'Mark done', 'btn-green') : btn(c.id, 'reopen', 'Reopen')}
        ${btn(c.id, 'delete', 'Delete', 'btn-danger', 'Delete this correction?')}
      </div></td>
    </tr>`).join('');

  const content = `
    <div class="page-head"><h1>Corrections</h1><div class="actions">${tabs}</div></div>
    ${corrections.length
      ? `<table class="admin-table cards">
          <thead><tr><th>Where</th><th>Correction</th><th>Status</th><th>Submitted</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      : '<p class="muted">No corrections here.</p>'}
    ${paginationControls(url, { page, pageSize, total })}`;

  return html(adminPage({ env, user, title: 'Corrections', path: '/admin/corrections', content, extraHead: CONFIRM_MODAL_HEAD }));
}

async function correctionAction(env, id, action, user) {
  const DB = env.DB;
  if (action === 'delete') {
    await DB.prepare('DELETE FROM corrections WHERE id = ?').bind(id).run();
    await logActivity(DB, user, 'deleted', 'correction', `#${id}`);
  } else {
    const status = action === 'done' ? 'done' : 'open';
    await DB.prepare('UPDATE corrections SET status = ? WHERE id = ?').bind(status, id).run();
    await logActivity(DB, user, action === 'done' ? 'closed' : 'reopened', 'correction', `#${id}`);
  }
  return redirect('/admin/corrections');
}
