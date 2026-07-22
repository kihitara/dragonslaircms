// Public people pages:
//   GET /people         → grid of people cards
//   GET /people/<slug>  → profile page (photo, name, role, bio, social links)
// Returns null for anything it doesn't recognise so the caller's 404 handles it.
//
// Bios are trusted HTML entered by CMS editors and are rendered raw inside
// .prose — everything else is escaped.
//
// Social links come from people.social_links (JSON array of { type, url,
// label? }); an empty list falls back to the legacy linkedin_url column.

import { loadChrome } from '../site.js';
import { sitePage, escapeHtml, escapeAttr, formatDate, html } from '../templates/base.js';
import { articlePath } from '../community.js';

const SOCIAL_LABELS = {
  website: 'Website', linkedin: 'LinkedIn', facebook: 'Facebook',
  twitter: 'Twitter/X', instagram: 'Instagram', bluesky: 'Bluesky',
  mastodon: 'Mastodon', other: 'Link',
};

function socialLinks(person) {
  let links = [];
  try {
    const a = JSON.parse(person.social_links || '[]');
    if (Array.isArray(a)) links = a;
  } catch { /* treat as empty */ }
  links = links.filter((l) => l && typeof l.url === 'string' && /^https?:\/\//i.test(l.url.trim()));
  if (!links.length && person.linkedin_url) {
    links = [{ type: 'linkedin', url: String(person.linkedin_url) }];
  }
  return links.map((l) => {
    const type = String(l.type || 'other');
    const label = (typeof l.label === 'string' && l.label.trim())
      || SOCIAL_LABELS[type]
      || (type.slice(0, 1).toUpperCase() + type.slice(1));
    return { url: l.url.trim(), label };
  });
}

function socialLinksHtml(person, { small = false } = {}) {
  const links = socialLinks(person);
  if (!links.length) return '';
  const items = links.map((l) =>
    `<a class="${small ? 'person-link' : 'btn btn-secondary btn-small'}" href="${escapeAttr(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)}${small ? '' : ' ↗'}</a>`);
  return `<div class="person-links${small ? ' person-links-small' : ''}">${items.join('')}</div>`;
}

const PEOPLE_STYLES = `<style>
.person-card { text-align: center; }
.person-card .avatar, .person-hero .avatar {
  width: 140px; height: 140px; border-radius: 50%; object-fit: cover;
  background: var(--c-panel, var(--color-surface)); display: inline-block;
}
.avatar-empty {
  width: 140px; height: 140px; border-radius: 50%;
  background: var(--c-panel, var(--color-surface));
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 2.4rem; font-weight: 700; color: var(--c-subtle, var(--color-muted));
}
.person-card h3 { margin: 0.9rem 0 0.2rem; }
.person-hero { display: flex; gap: 2rem; align-items: center; flex-wrap: wrap; margin-bottom: 2rem; }
.person-hero .avatar { width: 170px; height: 170px; }
.person-hero .role { font-size: 1.05rem; color: var(--c-subtle, var(--color-muted)); margin: 0.2rem 0 0.6rem; }
.person-links { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.person-card .person-links { justify-content: center; margin-top: 0.5rem; }
.person-links-small { font-size: 0.82rem; }
.person-links-small .person-link { color: var(--c-link, var(--color-brand)); }
.person-links-small .person-link + .person-link::before { content: '·'; margin-right: 0.5rem; color: var(--c-subtle, var(--color-muted)); }
.person-blurb { color: var(--c-subtle, var(--color-muted)); margin: 0.3rem 0 0.6rem; }
.person-card .person-blurb { font-size: 0.9rem; margin: 0.4rem 0 0.2rem; }
.person-hero .person-blurb { font-size: 1.05rem; max-width: 46ch; }
.person-articles { margin-top: 2.5rem; }
.person-articles .card h3 { margin: 0 0 0.4rem; font-size: 1.1rem; }
.person-articles .article-meta { margin-top: 0.2rem; }
</style>`;

export async function handlePublicPeople(request, env, url) {
  if (request.method !== 'GET') return null;
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (path !== '/people' && !path.startsWith('/people/')) return null;

  if (path === '/people') return indexPage(request, env, url);

  const match = path.match(/^\/people\/([a-z0-9-]+)$/);
  if (!match) return null;
  const person = await env.DB.prepare('SELECT * FROM people WHERE slug = ?').bind(match[1]).first();
  if (!person) return null;
  return profilePage(request, env, url, person);
}

function avatarHtml(person, cls = 'avatar') {
  return person.photo_url
    ? `<img class="${cls}" src="${escapeAttr(person.photo_url)}" alt="${escapeAttr(person.name)}" loading="lazy">`
    : `<span class="avatar-empty">${escapeHtml((person.name || '?').slice(0, 1).toUpperCase())}</span>`;
}

async function indexPage(request, env, url) {
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);
  const { results } = await env.DB.prepare('SELECT * FROM people ORDER BY sort_order, name').all();
  const people = results || [];

  const cards = people.map((p) => `
    <div class="card person-card">
      <a href="/people/${escapeAttr(p.slug)}">${avatarHtml(p)}</a>
      <h3><a href="/people/${escapeAttr(p.slug)}">${escapeHtml(p.name)}</a></h3>
      ${p.role ? `<p class="muted small">${escapeHtml(p.role)}</p>` : ''}
      ${p.blurb ? `<p class="person-blurb">${escapeHtml(p.blurb)}</p>` : ''}
      ${socialLinksHtml(p, { small: true })}
    </div>`).join('');

  const content = `
    <section class="section">
      <div class="container">
        <h1>People</h1>
        ${people.length ? `<div class="grid cols-3">${cards}</div>` : '<p class="muted">Nobody here yet.</p>'}
      </div>
    </section>`;

  return html(sitePage({
    env, title: 'People', canonical: url.origin + '/people',
    nav: navItems, footer, siteSettings: settings, reader, content, extraHead: PEOPLE_STYLES,
  }));
}

// Published/modified articles where this person is an author or a reviewer.
// The authors/reviewers columns are JSON arrays of people slugs, so a LIKE on
// the quoted slug is an exact-member match (slugs contain no quotes).
async function personArticlesHtml(DB, person) {
  const needle = `%"${person.slug}"%`;
  const { results } = await DB.prepare(
    `SELECT * FROM articles
     WHERE status IN ('published', 'modified') AND (authors LIKE ? OR reviewers LIKE ?)
     ORDER BY publish_date DESC, id DESC`
  ).bind(needle, needle).all();
  const articles = results || [];
  if (!articles.length) return '';

  const parse = (json) => {
    try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  };
  const cards = articles.map((a) => {
    const roles = [];
    if (parse(a.authors).includes(person.slug)) roles.push('Author');
    if (parse(a.reviewers).includes(person.slug)) roles.push('Reviewer');
    return `
      <article class="card">
        <h3><a href="${escapeAttr(articlePath(a))}">${escapeHtml(a.title)}</a></h3>
        <div class="article-meta">
          <span>${escapeHtml(formatDate(a.publish_date) || '')}</span>
          ${roles.map((r) => `<span class="badge">${r}</span>`).join('')}
        </div>
      </article>`;
  });

  return `
    <div class="person-articles">
      <h2>Articles</h2>
      <div class="grid cols-3">${cards.join('')}</div>
    </div>`;
}

async function profilePage(request, env, url, person) {
  const { settings, navItems, footer, reader } = await loadChrome(env, url, request);
  const articlesHtml = await personArticlesHtml(env.DB, person);

  const content = `
    <section class="section">
      <div class="container">
        <div class="person-hero">
          ${avatarHtml(person)}
          <div>
            <h1 style="margin-bottom:0">${escapeHtml(person.name)}</h1>
            ${person.role ? `<p class="role">${escapeHtml(person.role)}</p>` : ''}
            ${person.blurb ? `<p class="person-blurb">${escapeHtml(person.blurb)}</p>` : ''}
            ${socialLinksHtml(person)}
          </div>
        </div>
        ${person.bio ? `<div class="prose">${person.bio}</div>` : ''}
        ${articlesHtml}
        <p style="margin-top:2.5rem"><a href="/people">← All people</a></p>
      </div>
    </section>`;

  return html(sitePage({
    env, title: person.name,
    description: person.blurb || person.role || undefined,
    canonical: url.origin + '/people/' + person.slug,
    shareImage: person.photo_url ? new URL(person.photo_url, url.origin).href : undefined,
    nav: navItems, footer, siteSettings: settings, reader, content, extraHead: PEOPLE_STYLES,
  }));
}
