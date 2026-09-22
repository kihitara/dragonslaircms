// Runtime server-side block renderer: turns a page's [{ type, props }] array
// into HTML. The registry here is the parallel of the editing schema in
// src/blocks-manifest.js: adding a block = an entry in both.
//
// Escaping contract: every plain-text/URL prop goes through escapeHtml/escapeAttr.
// Rich-text props (authored in the admin by trusted CMS users) are output raw.

import { escapeHtml, escapeAttr, formatDate } from './base.js';
import { articlePath } from '../community.js';

// ── Named icons (themeable — stroke follows the card colour) ────────────────
// MUST stay in sync with ICON_NAMES in src/blocks-manifest.js.
const ICONS = {
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  lightbulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.5 1 1.2 1 2V16h6v-.5c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.18 2.18 0 0 0-2.9-.1z"/><path d="M12 15l-3-3a22 22 0 0 1 2-4A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>',
  'chart-up': '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
};

function iconSvg(name) {
  const paths = ICONS[name];
  if (!paths) return '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// ── Shared fragments ─────────────────────────────────────────────────────────

// Rich-text prop → wrapped raw HTML (trusted). Nothing when blank.
const rich = (html, cls = '') =>
  html ? `<div class="rich${cls ? ' ' + cls : ''}">${html}</div>` : '';

const isUrl = (s) => typeof s === 'string' && /^(https?:|\/)/.test(s);
const isVideoUrl = (s) => /\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i.test(String(s || ''));

// Section wrapper: full-bleed surface band + centred container. `bgImage`
// turns the band into a cover image with an optional scrim.
function section(type, surf, inner, { bgImage = '', overlay = 'none', loose = false } = {}) {
  const cls = `block block-${type} surface-${surf}${loose ? ' block-loose' : ''}${bgImage ? ' has-bg' : ''}`;
  let bg = '';
  if (bgImage) {
    bg = `<img class="block-bg" src="${escapeAttr(bgImage)}" alt="">`;
    if (overlay && overlay !== 'none') bg += `<div class="block-scrim scrim-${escapeAttr(overlay)}"></div>`;
  }
  return `<section class="${cls}">${bg}<div class="container">${inner}</div></section>`;
}

// Standard structured-block layout: intro → content → outro. An optional legacy
// `heading` prop (pre-intro data) still renders as the section h2.
function structured(type, props, surf, inner) {
  const heading = props.heading ? `<h2>${escapeHtml(props.heading)}</h2>` : '';
  return section(type, surf, heading + rich(props.intro, 'block-intro') + inner + rich(props.outro, 'block-outro'));
}

function ctaButtons(ctas, centered = false) {
  const list = (Array.isArray(ctas) ? ctas : []).filter((c) => c && (c.label || c.href));
  if (!list.length) return '';
  const btns = list.map((c) =>
    `<a class="btn${c.style === 'secondary' ? ' btn-secondary' : ''}" href="${escapeAttr(c.href || '#')}">${escapeHtml(c.label || '')}</a>`
  ).join('');
  return `<div class="cta-row${centered ? ' center' : ''}">${btns}</div>`;
}

const colsClass = (n, max = 4) => {
  const c = Math.min(Math.max(parseInt(n, 10) || 1, 1), max);
  return c > 1 ? ` cols-${c}` : '';
};

// ── Block renderers ──────────────────────────────────────────────────────────
// Each takes (props, env) and returns HTML (possibly a promise).

const RENDERERS = {
  hero(p) {
    const inner = [
      p.eyebrow ? `<p class="eyebrow">${escapeHtml(p.eyebrow)}</p>` : '',
      p.heading ? `<h1>${escapeHtml(p.heading)}</h1>` : '',
      rich(p.subheading, 'lede'),
      ctaButtons(p.ctas),
    ].join('');
    return section('hero', p.surface || 'brand', inner, { bgImage: p.bgImage, overlay: p.overlay, loose: true });
  },

  richText(p) {
    return structured('rich-text', p, p.surface || 'default', rich(p.html));
  },

  ctaBanner(p) {
    const inner = `<div class="cta-banner-inner">${rich(p.body)}${ctaButtons(p.ctas, true)}</div>`;
    return section('cta-banner', p.surface || 'soft', inner, { bgImage: p.bgImage, overlay: p.overlay });
  },

  featureGrid(p) {
    const items = Array.isArray(p.items) ? p.items : [];
    const large = p.textSize === 'large';
    const iconLeft = p.iconPosition === 'left';
    const centered = p.align === 'center';
    // Vertical alignment of card content when cards in a row differ in height
    // ('top' is the natural default — no class emitted).
    const valign = p.valign === 'middle' || p.valign === 'bottom' ? ` fg-valign-${p.valign}` : '';
    const badge = p.iconBadge === 'solid' ? 'badge-solid' : p.iconBadge === 'circle' ? 'badge-circle' : '';
    const iconSize = ['sm', 'lg', 'xl'].includes(p.iconSize) ? p.iconSize : 'sm';
    const cards = items.map((item) => {
      const surf = item.surface || '';
      const cardCls = surf === 'none' ? 'fg-card fg-plain'
        : surf ? `fg-card fg-surfaced surface-${escapeAttr(surf)}`
        : 'fg-card fg-panel';
      const media = item.video
        ? `<video class="fg-media" controls preload="metadata" src="${escapeAttr(item.video)}"${isUrl(item.image) ? ` poster="${escapeAttr(item.image)}"` : ''}></video>`
        : isUrl(item.image) ? `<img class="fg-media" src="${escapeAttr(item.image)}" alt="${escapeAttr(item.alt || '')}" loading="lazy">` : '';
      const icon = item.iconName && ICONS[item.iconName]
        ? `<span class="fg-icon icon-${iconSize} ${badge}">${iconSvg(item.iconName)}</span>`
        : isUrl(item.icon) ? `<span class="fg-icon icon-${iconSize} ${badge}"><img src="${escapeAttr(item.icon)}" alt="" loading="lazy"></span>` : '';
      const body = rich(item.body, large ? 'rich-lg' : '');
      if (media && !body && !icon) return `<article class="${cardCls} fg-media-only">${media}</article>`;
      return `<article class="${cardCls}${centered && !iconLeft ? ' center' : ''}">
        ${media}
        <div class="fg-body${iconLeft ? ' icon-left' : ''}">${media ? '' : icon}${body}</div>
      </article>`;
    }).join('');
    return structured('feature-grid', p, p.surface || 'default', `<div class="grid${colsClass(p.columns ?? 3)}${valign}">${cards}</div>`);
  },

  statGrid(p) {
    const items = Array.isArray(p.items) ? p.items : [];
    const n = Math.min(items.length || 1, 4);
    const cards = items.map((it) => `
      <div class="card stat-card">
        <div class="stat-value">${escapeHtml(it.value || '')}</div>
        ${it.label ? `<div class="stat-label">${escapeHtml(it.label)}</div>` : ''}
      </div>`).join('');
    return structured('stat-grid', p, p.surface || 'default', `<div class="grid${colsClass(n)}">${cards}</div>`);
  },

  logoStrip(p) {
    const size = ['small', 'medium', 'large'].includes(p.logoSize) ? p.logoSize : 'small';
    const logos = (Array.isArray(p.logos) ? p.logos : []).filter((l) => l && l.src).map((l) => {
      const img = `<img src="${escapeAttr(l.src)}" alt="${escapeAttr(l.alt || '')}" loading="lazy">`;
      return l.href ? `<a href="${escapeAttr(l.href)}">${img}</a>` : img;
    }).join('');
    return structured('logo-strip', p, p.surface || 'muted', `<div class="logo-row logos-${size}">${logos}</div>`);
  },

  numberedSteps(p) {
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const style = p.numberStyle || 'numeric';
    const marker = (i) => style === 'none' ? ''
      : style === 'alpha' ? String.fromCharCode(65 + i)
      : String(i + 1).padStart(2, '0');
    const lis = steps.map((s, i) => {
      const m = marker(i);
      return `<li>${m ? `<div class="step-marker">${escapeHtml(m)}</div>` : ''}${rich(s.body)}</li>`;
    }).join('');
    return structured('numbered-steps', p, p.surface || 'default', `<ol class="steps grid${colsClass(p.columns ?? 3)}">${lis}</ol>`);
  },

  twoColumn(p) {
    const inner = `<div class="grid cols-2 two-col"><div>${rich(p.leftBody)}</div><div>${rich(p.rightBody)}</div></div>`;
    return structured('two-column', p, p.surface || 'default', inner);
  },

  comparisonTable(p) {
    const rows = Array.isArray(p.rows) ? p.rows : [];
    const labels = { 1: p.col1Label, 2: p.col2Label, 3: p.col3Label, 4: p.col4Label };
    const filled = (v) => v != null && String(v).trim() !== '';
    const colCount = parseInt(p.columns, 10);
    // Explicit column count when set; otherwise auto-detect (legacy blocks).
    const cols = (colCount >= 2 && colCount <= 4)
      ? [1, 2, 3, 4].slice(0, colCount)
      : [1, 2, 3, 4].filter((n) => filled(labels[n]) || rows.some((r) => filled(r[`col${n}`])));
    const hasLabels = (p.rowLabels == null || p.rowLabels === '') ? rows.some((r) => filled(r.label)) : !!p.rowLabels;
    const head = `<tr>${hasLabels ? '<th></th>' : ''}${cols.map((n) => `<th scope="col">${escapeHtml(labels[n] || '')}</th>`).join('')}</tr>`;
    const body = rows.map((r) =>
      `<tr>${hasLabels ? `<th scope="row">${escapeHtml(r.label || '')}</th>` : ''}${cols.map((n) => `<td>${rich(r[`col${n}`])}</td>`).join('')}</tr>`
    ).join('');
    const table = `<div class="table-scroll"><table class="compare-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
    return structured('comparison-table', p, p.surface || 'default', table);
  },

  faq(p) {
    const items = (Array.isArray(p.items) ? p.items : []).map((it) => `
      <details class="faq-item">
        <summary><span>${escapeHtml(it.question || '')}</span><span class="faq-mark" aria-hidden="true">+</span></summary>
        ${rich(it.answer, 'faq-answer')}
      </details>`).join('');
    return structured('faq', p, p.surface || 'default', `<div class="faq-list">${items}</div>`);
  },

  pullQuote(p) {
    const inner = p.quote ? `
      <figure class="pull-quote">
        <blockquote>${rich(p.quote, 'quote-text')}</blockquote>
        ${p.attribution ? `<figcaption>— ${escapeHtml(p.attribution)}</figcaption>` : ''}
      </figure>` : '';
    return structured('pull-quote', p, p.surface || 'default', inner);
  },

  media(p) {
    const inner = p.src ? `
      <figure class="media-figure">
        <img src="${escapeAttr(p.src)}" alt="${escapeAttr(p.alt || '')}" loading="lazy" decoding="async">
        ${p.caption ? `<figcaption>${escapeHtml(p.caption)}</figcaption>` : ''}
      </figure>` : '';
    return structured('media', p, p.surface || 'default', inner);
  },

  capabilityList(p) {
    const items = (Array.isArray(p.items) ? p.items : []).map((it) => `
      <li>
        <span class="cap-tick" aria-hidden="true">✓</span>
        <div><span class="cap-text">${escapeHtml(it.text || '')}</span>${rich(it.description, 'cap-detail')}</div>
      </li>`).join('');
    return structured('capability-list', p, p.surface || 'default', `<ul class="cap-list grid${colsClass(p.columns ?? 1, 2)}">${items}</ul>`);
  },

  timeline(p) {
    const items = (Array.isArray(p.items) ? p.items : []).map((it) => `
      <li>
        ${it.date ? `<div class="tl-date">${escapeHtml(it.date)}</div>` : ''}
        ${it.title ? `<h3>${escapeHtml(it.title)}</h3>` : ''}
        ${rich(it.body, 'tl-body')}
      </li>`).join('');
    const hasAside = !!p.aside;
    const asideLeft = p.asidePosition !== 'right';
    const inner = hasAside
      ? `<div class="grid cols-2 tl-split">${asideLeft ? rich(p.aside, 'tl-aside') : ''}<ol class="timeline">${items}</ol>${!asideLeft ? rich(p.aside, 'tl-aside') : ''}</div>`
      : `<ol class="timeline">${items}</ol>`;
    return structured('timeline', p, p.surface || 'default', inner);
  },

  relatedContent(p) {
    const items = (Array.isArray(p.items) ? p.items : []).map((it) => `
      <li class="card related-card">
        <h3><a href="${escapeAttr(it.href || '#')}">${escapeHtml(it.title || '')}</a></h3>
        ${rich(it.blurb, 'muted related-blurb')}
        <span class="related-more" aria-hidden="true">Read more →</span>
      </li>`).join('');
    const n = Math.min(Math.max(parseInt(p.columns, 10) || 3, 2), 3);
    return structured('related-content', p, p.surface || 'default', `<ul class="related-list grid cols-${n}">${items}</ul>`);
  },

  async vacancies(p, env) {
    const EMP = {
      FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract',
      TEMPORARY: 'Temporary', INTERN: 'Internship', VOLUNTEER: 'Volunteer', OTHER: 'Other',
    };
    const jobs = Array.isArray(p.items) ? p.items : [];
    const items = jobs.map((job) => {
      const meta = [job.location, job.employmentType && (EMP[job.employmentType] || job.employmentType)].filter(Boolean).join(' · ');
      return `
      <article class="vacancy">
        ${isUrl(job.image) ? `<img src="${escapeAttr(job.image)}" alt="" loading="lazy">` : ''}
        <div class="vacancy-meta">
          ${job.department ? `<span class="vacancy-dept">${escapeHtml(job.department)}</span>` : ''}
          ${job.date ? `<time datetime="${escapeAttr(job.date)}">${escapeHtml(formatDate(job.date))}</time>` : ''}
        </div>
        <h3><a href="${escapeAttr(job.href || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(job.title || '')}</a></h3>
        ${meta ? `<p class="muted small">${escapeHtml(meta)}</p>` : ''}
        ${job.closing_date ? `<p class="muted small vacancy-close">Applications close <time datetime="${escapeAttr(job.closing_date)}">${escapeHtml(formatDate(job.closing_date))}</time></p>` : ''}
      </article>`;
    }).join('');
    // Google JobPosting structured data — one JSON-LD script per role. The
    // description is a plain textarea in the editor but is stripped of any
    // markup anyway; "<" is JSON-encoded so content can't close the script tag.
    let orgName = '';
    try {
      const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'org_name'").first();
      orgName = (row && row.value) || '';
    } catch { /* settings table may not be migrated yet */ }
    if (!orgName) orgName = env.SITE_TITLE || '';
    const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const jsonLd = jobs.filter((j) => j && j.title).map((job) => {
      const data = { '@context': 'https://schema.org', '@type': 'JobPosting', title: job.title };
      const desc = stripHtml(job.description);
      if (desc) data.description = desc;
      if (job.date) data.datePosted = job.date;
      if (job.closing_date) data.validThrough = job.closing_date;
      if (orgName) data.hiringOrganization = { '@type': 'Organization', name: orgName };
      return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
    }).join('\n');
    return structured('vacancies', p, p.surface || 'default', `<div class="grid cols-3">${items}</div>${jsonLd}`);
  },

  embed(p) {
    const height = ['small', 'medium', 'large', 'full'].includes(p.height) ? p.height : 'auto';
    const label = p.title || 'Embedded content';
    let content = '';
    if (p.embedCode) {
      // Owner-pasted embed code (trusted) — injected raw so it sizes itself.
      content = height === 'auto'
        ? `<div role="group" aria-label="${escapeAttr(label)}">${p.embedCode}</div>`
        : `<div role="group" aria-label="${escapeAttr(label)}" class="embed-fixed embed-${height}">${p.embedCode}</div>`;
    } else if (p.fileUrl) {
      content = `<iframe src="${escapeAttr(p.fileUrl)}" title="${escapeAttr(label)}" loading="lazy" class="embed-frame ${height === 'auto' ? 'embed-page' : `embed-${height}`}"></iframe>`;
    }
    const hasAside = !!p.aside;
    const asideLeft = p.asidePosition !== 'right';
    const inner = hasAside
      ? `<div class="grid cols-2 embed-split">${asideLeft ? rich(p.aside) : ''}<div class="embed-main">${content}</div>${!asideLeft ? rich(p.aside) : ''}</div>`
      : content;
    return structured('embed', p, p.surface || 'default', inner);
  },

  // Gallery: a horizontal carousel of images/videos; a per-page island (below)
  // opens a lightbox with the full media + caption. Each item is a real link to
  // the file, so without JS clicking still opens the media. A video item shows
  // its cover as the thumbnail (and poster); an image item shows itself.
  gallery(p) {
    const items = (Array.isArray(p.items) ? p.items : []).filter((it) => it && (it.file || it.cover));
    if (!items.length) return structured('gallery', p, p.surface || 'default', '');
    const slides = items.map((it, i) => {
      const file = String(it.file || '');
      const video = isVideoUrl(file);
      const cover = isUrl(it.cover) ? it.cover : '';
      const thumb = video ? cover : (isUrl(file) ? file : cover);
      const alt = it.alt || '';
      const thumbHtml = thumb
        ? `<img class="gal-thumb" src="${escapeAttr(thumb)}" alt="${escapeAttr(alt)}" loading="lazy">`
        : '<span class="gal-thumb gal-thumb-empty" aria-hidden="true"></span>';
      const caption = it.caption ? `<div class="gal-cap" hidden>${it.caption}</div>` : '';
      return `<a class="gal-item" href="${escapeAttr(file || thumb)}" data-gal-item data-media="${video ? 'video' : 'image'}"
          data-src="${escapeAttr(file)}" data-cover="${escapeAttr(cover)}" data-alt="${escapeAttr(alt)}"
          aria-label="${escapeAttr(alt || (video ? 'Play video' : 'View image'))}">
        ${thumbHtml}${video ? '<span class="gal-play" aria-hidden="true">▶</span>' : ''}${caption}
      </a>`;
    }).join('');
    const inner = `
      <div class="gallery" data-gallery>
        <button type="button" class="gal-nav gal-prev" aria-label="Scroll back">‹</button>
        <div class="gal-track" data-gal-track>${slides}</div>
        <button type="button" class="gal-nav gal-next" aria-label="Scroll forward">›</button>
      </div>`;
    return structured('gallery', p, p.surface || 'default', inner);
  },

  // Tabs: server renders every panel; a small island (appended once per page by
  // renderBlocks) wires up switching + ARIA. Without JS all panels stay visible.
  tabs(p) {
    const tabs = (Array.isArray(p.tabs) ? p.tabs : []).filter(Boolean);
    if (!tabs.length) return structured('tabs', p, p.surface || 'default', '');
    const grouped = !!p.grouped;
    const vertical = grouped || p.tabPosition === 'left';
    let nav = '';
    if (grouped) {
      // Bucket tabs by group (first-appearance order; blank → "More"), keeping
      // GLOBAL indices so buttons and panels pair by value, not DOM position.
      const groups = [];
      const byKey = {};
      tabs.forEach((t, i) => {
        const key = String((t && t.group) || '').trim() || 'More';
        if (!(key in byKey)) { byKey[key] = { label: key, idx: [] }; groups.push(byKey[key]); }
        byKey[key].idx.push(i);
      });
      nav = groups.map((g, gi) => `
        <div data-group="${gi}">
          <button type="button" data-group-toggle="${gi}" aria-expanded="${gi === 0}">${escapeHtml(g.label)} <span aria-hidden="true">▾</span></button>
          <div data-group-panel="${gi}"${gi !== 0 ? ' hidden' : ''}>
            ${g.idx.map((i) => `<button type="button" data-tab="${i}" aria-selected="${i === 0}">${escapeHtml(tabs[i].title || '')}</button>`).join('')}
          </div>
        </div>`).join('');
    } else {
      nav = tabs.map((t, i) => `<button type="button" data-tab="${i}" aria-selected="${i === 0}">${escapeHtml(t.title || '')}</button>`).join('');
    }
    const panels = tabs.map((t, i) => `<div data-tab-panel="${i}"${i !== 0 ? ' hidden' : ''}>${rich(t.body)}</div>`).join('');
    const inner = `
      <div class="tabs${vertical ? ' tabs-vertical' : ' tabs-top'}" data-tabs${grouped ? ' data-grouped' : ''}>
        <div class="tab-list" data-tablist>${nav}</div>
        <div class="tab-panels">${panels}</div>
      </div>`;
    return structured('tabs', p, p.surface || 'default', inner);
  },

  // Articles grid: featured lead tile + compact tiles, from live articles in D1.
  async articles(p, env) {
    const { results } = await env.DB.prepare(
      `SELECT slug, title, subheading, category, cover, publish_date FROM articles
       WHERE status IN ('published', 'modified')
       ORDER BY (publish_date IS NULL), publish_date DESC, updated_at DESC LIMIT 50`
    ).all();
    const all = results || [];
    const n = Number(p.count) === 7 ? 7 : 3;
    const cat = p.category && p.category !== 'all' ? p.category : null;
    const pool = cat ? all.filter((a) => a.category === cat) : all;
    let feat = p.featured ? all.find((a) => a.slug === p.featured) : null;
    if (!feat) feat = pool[0] || null;
    const rest = pool.filter((a) => !feat || a.slug !== feat.slug).slice(0, Math.max(0, n - 1));
    const smalls = rest.slice(0, 2);
    const more = rest.slice(2);
    const tile = (a, featured = false) => `
      <article class="article-tile${featured ? ' featured' : ''}">
        ${a.cover ? `<img class="tile-cover" src="${escapeAttr(a.cover)}" alt="" loading="lazy">` : '<div class="tile-cover tile-cover-empty"></div>'}
        <span class="badge">${escapeHtml(a.category || 'blog')}</span>
        <h3><a href="${escapeAttr(articlePath(a))}">${escapeHtml(a.title)}</a></h3>
        ${a.subheading ? `<p class="muted">${escapeHtml(a.subheading)}</p>` : ''}
        ${a.publish_date ? `<p class="muted small"><time datetime="${escapeAttr(a.publish_date)}">${escapeHtml(formatDate(a.publish_date))}</time></p>` : ''}
      </article>`;
    const inner = feat
      ? `<div class="articles-lead">${tile(feat, true)}<div class="articles-side">${smalls.map((a) => tile(a)).join('')}</div></div>
         ${more.length ? `<div class="grid cols-4 articles-more">${more.map((a) => tile(a)).join('')}</div>` : ''}`
      : '<p class="muted">No articles published yet.</p>';
    return structured('articles', p, p.surface || 'default', inner);
  },

  // Team grid: reads the shared people directory. Cards show the plain-text
  // blurb (NOT the bio, which is rich HTML and belongs on the profile page)
  // and link photo + name to the person's full profile at /people/<slug>.
  async teamGrid(p, env) {
    let results;
    try {
      ({ results } = await env.DB.prepare(
        'SELECT slug, name, role, blurb, photo_url, linkedin_url, social_links FROM people ORDER BY sort_order, name'
      ).all());
    } catch {
      try {
        // blurb column not migrated yet — cards render without a description.
        ({ results } = await env.DB.prepare(
          'SELECT slug, name, role, photo_url, linkedin_url, social_links FROM people ORDER BY sort_order, name'
        ).all());
      } catch {
        // social_links column not migrated yet either — the legacy linkedin_url
        // fallback below still renders a link.
        ({ results } = await env.DB.prepare(
          'SELECT slug, name, role, photo_url, linkedin_url FROM people ORDER BY sort_order, name'
        ).all());
      }
    }
    const people = results || [];
    const slugs = (Array.isArray(p.members) ? p.members : [])
      .map((m) => (typeof m === 'string' ? m : m && m.slug)).filter(Boolean);
    const list = slugs.length
      ? slugs.map((s) => people.find((pe) => pe.slug === s)).filter(Boolean)
      : people;
    // social_links: JSON array of { type, url, label? }. Label falls back to a
    // capitalised type name (Twitter reads as "Twitter/X").
    const socialLabel = (l) => {
      if (l.label) return l.label;
      const t = String(l.type || '').toLowerCase();
      if (t === 'twitter') return 'Twitter/X';
      if (t === 'linkedin') return 'LinkedIn';
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Link';
    };
    const socialLinks = (pe) => {
      let links = [];
      try {
        const arr = JSON.parse(pe.social_links || '[]');
        if (Array.isArray(arr)) links = arr.filter((l) => l && l.url);
      } catch { /* malformed JSON — fall back below */ }
      if (!links.length && pe.linkedin_url) links = [{ type: 'linkedin', url: pe.linkedin_url }];
      if (!links.length) return '';
      const a = links.map((l) =>
        `<a class="team-social" href="${escapeAttr(l.url)}" target="_blank" rel="noopener">${escapeHtml(socialLabel(l))}</a>`
      ).join('');
      return `<div class="team-links">${a}</div>`;
    };
    const cards = list.map((pe) => {
      const profile = `/people/${escapeAttr(pe.slug)}`;
      return `
      <div class="card team-card">
        ${pe.photo_url ? `<a class="team-photo-link" href="${profile}"><img class="team-photo" src="${escapeAttr(pe.photo_url)}" alt="${escapeAttr(pe.name)}" width="160" height="160" loading="lazy"></a>` : ''}
        <h3><a href="${profile}">${escapeHtml(pe.name)}</a></h3>
        ${pe.role ? `<p class="team-role">${escapeHtml(pe.role)}</p>` : ''}
        ${pe.blurb ? `<p class="muted team-blurb">${escapeHtml(pe.blurb)}</p>` : ''}
        ${socialLinks(pe)}
      </div>`;
    }).join('');
    return structured('team-grid', p, p.surface || 'default', `<div class="grid cols-3">${cards}</div>`);
  },
};

// Tab-switching island — appended once when the page has a tabs block. Buttons
// carry the GLOBAL tab index in data-tab; panels in data-tab-panel, so pairing
// is by value (grouped mode reorders the buttons).
const TABS_SCRIPT = `<script>
document.querySelectorAll('[data-tabs]').forEach(function (root) {
  var tabs = Array.prototype.slice.call(root.querySelectorAll('[data-tab]'));
  var panels = Array.prototype.slice.call(root.querySelectorAll('[data-tab-panel]'));
  if (!tabs.length) return;
  var toggles = Array.prototype.slice.call(root.querySelectorAll('[data-group-toggle]'));
  var gpanels = Array.prototype.slice.call(root.querySelectorAll('[data-group-panel]'));
  function openGroup(gi) {
    toggles.forEach(function (b, j) { b.setAttribute('aria-expanded', j === gi ? 'true' : 'false'); });
    gpanels.forEach(function (p, j) { p.hidden = j !== gi; });
  }
  function activate(idx, focus) {
    var key = String(idx);
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === key;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
      if (on) { var g = t.closest('[data-group]'); if (g) openGroup(Number(g.getAttribute('data-group'))); }
    });
    panels.forEach(function (p) { p.hidden = p.getAttribute('data-tab-panel') !== key; });
  }
  toggles.forEach(function (btn, gi) {
    btn.addEventListener('click', function () {
      openGroup(gi);
      var first = gpanels[gi] && gpanels[gi].querySelector('[data-tab]');
      if (first) activate(Number(first.getAttribute('data-tab')));
    });
  });
  tabs.forEach(function (tab) {
    tab.setAttribute('role', 'tab');
    tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
    tab.addEventListener('click', function () { activate(Number(tab.getAttribute('data-tab'))); });
    tab.addEventListener('keydown', function (e) {
      var pos = tabs.indexOf(tab), n = tabs.length, to = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (pos + 1) % n;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (pos - 1 + n) % n;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      if (to !== null) { e.preventDefault(); activate(Number(tabs[to].getAttribute('data-tab')), true); }
    });
  });
});
</script>
<noscript><style>[data-tablist]{display:none}[data-tab-panel][hidden]{display:block}</style></noscript>`;

// Gallery island — appended once when the page has a gallery block. Wires the
// carousel prev/next scroll and a shared lightbox (open on item click, prev/
// next, Esc, arrows, backdrop/close). Items are links, so no-JS clicks still
// open the file. Caption HTML is authored by trusted CMS users (rendered raw).
export const GALLERY_SCRIPT = `<script>
(function () {
  var galleries = document.querySelectorAll('[data-gallery]');
  if (!galleries.length) return;
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  var lb = document.createElement('div');
  lb.className = 'gal-lightbox'; lb.hidden = true;
  lb.innerHTML = '<div class="gal-lb-backdrop" data-gal-close></div>'
    + '<button type="button" class="gal-lb-close" data-gal-close aria-label="Close">×</button>'
    + '<button type="button" class="gal-lb-nav gal-lb-prev" aria-label="Previous">‹</button>'
    + '<div class="gal-lb-stage" data-gal-stage role="dialog" aria-modal="true" aria-label="Media viewer"></div>'
    + '<button type="button" class="gal-lb-nav gal-lb-next" aria-label="Next">›</button>';
  document.body.appendChild(lb);
  var stage = lb.querySelector('[data-gal-stage]');
  var group = null, idx = 0, lastFocus = null;

  function draw() {
    var it = group[idx];
    var media = it.getAttribute('data-media');
    var src = it.getAttribute('data-src');
    var cover = it.getAttribute('data-cover');
    var alt = it.getAttribute('data-alt') || '';
    var capEl = it.querySelector('.gal-cap');
    var html = media === 'video'
      ? '<video class="gal-lb-media" src="' + esc(src) + '"' + (cover ? ' poster="' + esc(cover) + '"' : '') + ' controls autoplay playsinline></video>'
      : '<img class="gal-lb-media" src="' + esc(src) + '" alt="' + esc(alt) + '">';
    if (capEl) html += '<div class="gal-lb-cap rich">' + capEl.innerHTML + '</div>';
    stage.innerHTML = html;
  }
  function open(items, i) { group = items; idx = i; lastFocus = document.activeElement; draw(); lb.hidden = false; document.body.style.overflow = 'hidden'; lb.querySelector('.gal-lb-close').focus(); }
  function close() { lb.hidden = true; stage.innerHTML = ''; document.body.style.overflow = ''; group = null; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  function step(d) { if (!group) return; idx = (idx + d + group.length) % group.length; draw(); }

  lb.querySelectorAll('[data-gal-close]').forEach(function (b) { b.addEventListener('click', close); });
  lb.querySelector('.gal-lb-prev').addEventListener('click', function () { step(-1); });
  lb.querySelector('.gal-lb-next').addEventListener('click', function () { step(1); });
  document.addEventListener('keydown', function (e) {
    if (lb.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  galleries.forEach(function (g) {
    var items = Array.prototype.slice.call(g.querySelectorAll('[data-gal-item]'));
    items.forEach(function (it, i) { it.addEventListener('click', function (e) { e.preventDefault(); open(items, i); }); });
    var track = g.querySelector('[data-gal-track]');
    function scrollByItem(d) { var first = track.querySelector('[data-gal-item]'); var w = first ? first.getBoundingClientRect().width + 16 : track.clientWidth * 0.8; track.scrollBy({ left: d * w, behavior: 'smooth' }); }
    var prev = g.querySelector('.gal-prev'), next = g.querySelector('.gal-next');
    if (prev) prev.addEventListener('click', function () { scrollByItem(-1); });
    if (next) next.addEventListener('click', function () { scrollByItem(1); });
  });
})();
</script>`;

// ── Entry point ──────────────────────────────────────────────────────────────
// blocks: parsed [{ type, props }] array. ctx.title (optional) provides a
// visually-hidden h1 when the page has no hero, so it is never h1-less (SEO).
export async function renderBlocks(env, blocks, ctx = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const parts = [];
  const hasHero = list.some((b) => b && b.type === 'hero');
  if (ctx.title && !hasHero) parts.push(`<h1 class="visually-hidden">${escapeHtml(ctx.title)}</h1>`);
  for (const block of list) {
    const fn = block && RENDERERS[block.type];
    if (!fn) continue; // unknown block type — skipped, never fatal
    try {
      parts.push(await fn(block.props || {}, env));
    } catch (err) {
      console.error(`Block "${block.type}" failed to render:`, err.stack || err);
    }
  }
  if (list.some((b) => b && b.type === 'tabs')) parts.push(TABS_SCRIPT);
  if (list.some((b) => b && b.type === 'gallery')) parts.push(GALLERY_SCRIPT);
  return parts.join('\n');
}
