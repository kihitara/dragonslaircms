// Markdown export — turns a saved page or article row into a single Markdown
// file for download. Runs in the Worker (no DOM), so HTML→Markdown is
// string/regex based over the editor's known tag set rather than a parser.
//
// Pages are block documents, so their Markdown is structural: one section per
// block, its fields labelled from BLOCK_MANIFEST. That keeps the export honest
// about layout the format can't represent (grids, tabs, surfaces) and means a
// newly added block type exports itself with no change here. Articles are a
// single rich-text body, so they convert straight to prose.
//
// This is a system-agnostic backup, not an import format — nothing reads it back.

import { BLOCK_MANIFEST } from './blocks-manifest.js';

// ── HTML → Markdown ──────────────────────────────────────────────────────────

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

// Text with no Markdown structure left in it — for alt text, captions, cells.
function plain(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag || '');
  return m ? decode(m[2] !== undefined ? m[2] : m[3]) : '';
};

// Inline formatting. Runs last, on text that no longer holds block tags.
function inline(html) {
  return decode(String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '  \n')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `**${inline(t)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `_${inline(t)}_`)
    .replace(/<s\b[^>]*>([\s\S]*?)<\/s>/gi, (_, t) => `~~${inline(t)}~~`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => '`' + plain(t) + '`')
    .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, (_, t) => `^${plain(t)}`)
    .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, (_, t) => `~${plain(t)}`)
    .replace(/<img\b([^>]*)>/gi, (_, a) => `![${attr(a, 'alt')}](${attr(a, 'src')})`)
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, a, t) => {
      const href = attr(a, 'href');
      const text = inline(t).trim();
      return href ? `[${text || href}](${href})` : text;
    })
    .replace(/<[^>]*>/g, '')) // u and any stray wrapper: keep the text, drop the tag
    .replace(/[ \t]+\n/g, '\n');
}

// One <li> per line, recursing into nested lists (indented four spaces).
function listItems(inner, ordered) {
  const out = [];
  let i = 0;
  String(inner || '').replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    let nested = '';
    const rest = body.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (__, tag, sub) => {
      nested += '\n' + listItems(sub, tag.toLowerCase() === 'ol').replace(/^/gm, '    ');
      return '';
    });
    const marker = ordered ? `${++i}. ` : '- ';
    out.push(marker + inline(rest).trim() + nested);
    return '';
  });
  return out.join('\n');
}

// Regex can't match balanced tags, and both atomic blocks nest <div>s. Scan for
// an opening <div> whose attributes satisfy `test`, then walk forward counting
// opens and closes to find its real end, and hand the whole element to `render`.
function replaceDivBlocks(html, test, render) {
  const open = /<div\b([^>]*)>/gi;
  let out = '';
  let i = 0;
  for (;;) {
    open.lastIndex = i;
    const m = open.exec(html);
    if (!m) return out + html.slice(i);
    const after = m.index + m[0].length;
    if (!test(m[1])) { out += html.slice(i, after); i = after; continue; }

    const scan = /<div\b[^>]*>|<\/div\s*>/gi;
    scan.lastIndex = after;
    let depth = 1;
    let end = -1;
    let tag;
    while ((tag = scan.exec(html))) {
      if (tag[0][1] === '/') { if (--depth === 0) { end = scan.lastIndex; break; } }
      else depth++;
    }
    if (end < 0) return out + html.slice(i); // unbalanced — leave the rest alone

    out += html.slice(i, m.index) + render(html.slice(m.index, end), m[1]);
    i = end;
  }
}

// The editor's atomic blocks (see wysiwyg.js): a callout becomes a labelled
// blockquote, a gallery becomes its images in order — neither has a native
// Markdown form, so the aim is a faithful reading, not a round trip.
function calloutToMd(whole, attrs) {
  const type = (/rt-callout-([a-z]+)/i.exec(attrs) || [, 'info'])[1];
  // Structure is fixed: <div callout><span icon/><div body>…</div></div>.
  const inner = String(whole)
    .replace(/^<div\b[^>]*>/i, '').replace(/<\/div\s*>\s*$/i, '')
    .replace(/<span\b[^>]*rt-callout-icon[^>]*>[\s\S]*?<\/span>/i, '')
    .replace(/^\s*<div\b[^>]*>/i, '').replace(/<\/div\s*>\s*$/i, '');
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  const body = blockHtmlToMd(inner).trim() || '_(empty)_';
  return `> **${label}**\n>\n` + body.replace(/^/gm, '> ').replace(/^>\s+$/gm, '>');
}

function galleryToMd(whole) {
  const shots = [];
  String(whole).replace(/<a\b([^>]*\bgal-item\b[^>]*)>([\s\S]*?)<\/a>/gi, (_, tag, body) => {
    const src = attr(tag, 'data-src') || attr(tag, 'href');
    const alt = attr(tag, 'data-alt');
    const cap = plain((/<div\b[^>]*gal-cap[^>]*>([\s\S]*?)<\/div>/i.exec(body) || [, ''])[1]);
    if (src) shots.push(`![${alt}](${src})` + (cap ? `\n\n_${cap}_` : ''));
    return '';
  });
  return shots.length ? shots.join('\n\n') : '';
}

// Block-level pass. The nesting containers are resolved first (so their bodies
// convert on raw HTML, never on text already holding placeholders), then code
// fences are lifted out so the inline pass can't reach inside them.
function blockHtmlToMd(html) {
  const stash = [];
  const keep = (md) => `\u0000${stash.push(md) - 1}\u0000`;

  let s = String(html || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ''); // decorative icons carry no text

  s = replaceDivBlocks(s, (a) => /\brt-callout\b/i.test(a) && !/rt-callout-(body|icon)/i.test(a),
    (whole, attrs) => keep(calloutToMd(whole, attrs)));
  s = replaceDivBlocks(s, (a) => /\bgallery\b/i.test(a), (whole) => keep(galleryToMd(whole)));

  s = s
    .replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
      (_, code) => keep('```\n' + decode(code.replace(/<[^>]*>/g, '')).replace(/\s+$/, '') + '\n```'))
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
      (_, code) => keep('```\n' + decode(code.replace(/<[^>]*>/g, '')).replace(/\s+$/, '') + '\n```'));

  s = s
    .replace(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi, (_, fig) => {
      const img = (/<img\b[^>]*>/i.exec(fig) || [''])[0];
      const cap = plain((/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(fig) || [, ''])[1]);
      return '\n\n' + inline(img).trim() + (cap ? `\n\n_${cap}_` : '') + '\n\n';
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, t) => `\n\n${'#'.repeat(Number(lvl))} ${inline(t).trim()}\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_, q) => '\n\n' + blockHtmlToMd(q).trim().replace(/^/gm, '> ').replace(/^>\s+$/gm, '>') + '\n\n')
    .replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_, tag, items) => '\n\n' + listItems(items, tag.toLowerCase() === 'ol') + '\n\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `\n\n${inline(t).trim()}\n\n`)
    .replace(/<\/?div\b[^>]*>/gi, '\n\n');

  s = inline(s).replace(/\u0000(\d+)\u0000/g, (_, i) => '\n\n' + (stash[Number(i)] || '') + '\n\n');
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export const htmlToMd = blockHtmlToMd;

// ── Frontmatter ──────────────────────────────────────────────────────────────

// JSON-encoding every value keeps this valid YAML for scalars without needing a
// YAML quoting/escaping implementation.
function frontmatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) lines.push(`${k}: ${JSON.stringify(v == null ? '' : v)}`);
  lines.push('---');
  return lines.join('\n');
}

// ── Pages ────────────────────────────────────────────────────────────────────

const optionLabel = (field, value) => {
  const hit = (field.options || []).find((o) => String(o.value) === String(value));
  return hit ? hit.label : value;
};

// Splits a block's fields into settings (scalars → a bullet list) and content
// (text and rich text → labelled prose), so the body reads top to bottom.
function fieldsToMd(fields, props, depth = 0) {
  const settings = [];
  const content = [];

  for (const f of fields || []) {
    const v = props ? props[f.key] : undefined;
    if (v === undefined || v === null || v === '') continue;

    if (f.type === 'list') {
      const items = Array.isArray(v) ? v : [];
      if (!items.length) continue;
      const body = items.map((item, i) => {
        const sub = fieldsToMd(f.itemFields || [], item, depth + 1);
        return `_${f.label} ${i + 1}:_` + (sub ? `\n\n${sub}` : '');
      }).join('\n\n');
      content.push(`**${f.label}**\n\n${body}`);
      continue;
    }

    if (f.type === 'richtext') {
      const md = blockHtmlToMd(v);
      if (md) content.push(`**${f.label}:**\n\n${md}`);
      continue;
    }

    if (f.type === 'text' || f.type === 'textarea') {
      content.push(`**${f.label}:** ${decode(String(v)).trim()}`);
      continue;
    }

    if (f.type === 'boolean') { settings.push(`- ${f.label}: ${v ? 'Yes' : 'No'}`); continue; }
    if (f.type === 'select') { settings.push(`- ${f.label}: ${optionLabel(f, v)}`); continue; }
    settings.push(`- ${f.label}: ${decode(String(v)).trim()}`); // number, media, date
  }

  return [settings.join('\n'), content.join('\n\n')].filter(Boolean).join('\n\n');
}

export function pageToMarkdown(page) {
  let blocks = [];
  try { blocks = JSON.parse(page.blocks || '[]'); } catch { blocks = []; }
  if (!Array.isArray(blocks)) blocks = [];

  const fm = frontmatter({
    type: 'page',
    title: page.title || '',
    slug: page.slug || '',
    status: page.status || 'draft',
    hidden: !!page.hidden,
    full_width: !!page.full_width,
    meta_title: page.meta_title || '',
    meta_description: page.meta_description || '',
    share_image: page.share_image || '',
    updated_at: page.updated_at || '',
  });

  const body = blocks.map((b, i) => {
    const def = BLOCK_MANIFEST[b.type];
    const head = `## ${i + 1}. ${def ? def.label : b.type} (\`${b.type}\`)`;
    const fields = fieldsToMd(def ? def.fields : [], b.props || {});
    return head + (fields ? `\n\n${fields}` : '');
  }).join('\n\n');

  return `${fm}\n\n# ${page.title || page.slug || 'Untitled'}\n\n${body || '_(no blocks)_'}\n`;
}

// ── Articles ─────────────────────────────────────────────────────────────────

export function articleToMarkdown(article, { categoryTitle = '', seriesTitles = [], tagNames = [] } = {}) {
  const fm = frontmatter({
    type: 'article',
    title: article.title || '',
    slug: article.slug || '',
    subheading: article.subheading || '',
    status: article.status || 'draft',
    category: categoryTitle || article.category || '',
    series: seriesTitles,
    tags: tagNames,
    publish_date: article.publish_date || '',
    cover: article.cover || '',
    meta_title: article.meta_title || '',
    meta_description: article.meta_description || '',
    updated_at: article.updated_at || '',
  });

  const parts = [`# ${article.title || article.slug || 'Untitled'}`];
  if (article.subheading) parts.push(`_${decode(article.subheading).trim()}_`);
  if (article.cover) parts.push(`![](${article.cover})`);
  const body = blockHtmlToMd(article.content || '');
  parts.push(body || '_(no content)_');

  return `${fm}\n\n${parts.join('\n\n')}\n`;
}

// ── Filenames ────────────────────────────────────────────────────────────────

// Slugs may hold slashes (nested pages), so flatten to one safe segment.
export function exportFilename(slug, ext) {
  const base = String(slug || 'export').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'export';
  return `${base}.${ext}`;
}
