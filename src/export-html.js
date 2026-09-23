// HTML export — wraps rendered content in a single standalone file with the
// site's CSS, fonts and images embedded, so the download still looks right with
// no network and no CMS behind it.
//
// Unlike the live page this drops the site chrome (nav, footer, comments) and
// all scripts: it's a snapshot of the content, not a working copy of the site.
//
// Embedding has to stay inside the Worker's subrequest budget, so there are
// caps. Anything skipped is left as an absolute URL — the file still renders,
// it just needs a connection for those few assets, and says so at the end.

import { defaultTokens, tokensToCss, surfacesToCss, fontFacesToCss } from './tokens.js';
import { getThemeTokens, getSiteConfig } from './db.js';
import { escapeHtml } from './templates/base.js';

const MAX_ASSETS = 60;                      // distinct assets embedded per export
const MAX_ASSET_BYTES = 4 * 1024 * 1024;    // skip any single asset larger than this
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;   // stop embedding once the total passes this

const STYLESHEETS = ['/css/site.css', '/css/blocks.css', '/css/article.css'];

// btoa() can't take a whole large array via String.fromCharCode.apply, so walk
// the bytes in chunks.
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

// Tracks the caps across every asset in one export.
function assetBudget() {
  return { count: 0, bytes: 0, skipped: 0, cache: new Map() };
}

// Fetches an asset by URL as a data: URI, preferring the bindings over HTTP:
// R2 for /media/*, the assets binding for /css and /icons, and a real fetch
// only for genuinely external URLs. Returns null when it can't or shouldn't.
async function toDataUri(env, rawUrl, base, budget) {
  const url = String(rawUrl || '').trim();
  if (!url || url.startsWith('data:') || url.startsWith('#')) return null;
  if (budget.cache.has(url)) return budget.cache.get(url);

  const remember = (v) => { budget.cache.set(url, v); return v; };
  if (budget.count >= MAX_ASSETS || budget.bytes >= MAX_TOTAL_BYTES) { budget.skipped++; return remember(null); }

  let bytes = null;
  let type = '';
  try {
    const path = url.startsWith('/') ? url : (base && url.startsWith(base) ? url.slice(base.length) : '');

    if (path.startsWith('/media/') && env.MEDIA) {
      let key;
      try { key = decodeURIComponent(path.slice(1)); } catch { key = ''; }
      if (!key.startsWith('media/') || key.includes('..')) return remember(null);
      const obj = await env.MEDIA.get(key);
      if (!obj) return remember(null);
      bytes = new Uint8Array(await obj.arrayBuffer());
      type = obj.httpMetadata?.contentType || '';
    } else if (path && env.ASSETS) {
      const res = await env.ASSETS.fetch(new Request(`https://assets.invalid${path}`));
      if (!res.ok) return remember(null);
      bytes = new Uint8Array(await res.arrayBuffer());
      type = res.headers.get('Content-Type') || '';
    } else if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) return remember(null);
      bytes = new Uint8Array(await res.arrayBuffer());
      type = res.headers.get('Content-Type') || '';
    } else {
      return remember(null);
    }
  } catch {
    return remember(null); // a broken asset must never fail the whole export
  }

  if (!bytes || bytes.length > MAX_ASSET_BYTES || budget.bytes + bytes.length > MAX_TOTAL_BYTES) {
    budget.skipped++;
    return remember(null);
  }
  budget.count++;
  budget.bytes += bytes.length;
  return remember(`data:${(type || 'application/octet-stream').split(';')[0]};base64,${bytesToBase64(bytes)}`);
}

// Rewrites every url(...) in a stylesheet. `context` is the URL the sheet was
// loaded from, so relative paths resolve the way the browser would have.
async function inlineCssUrls(env, css, context, base, budget) {
  const refs = [...new Set([...String(css).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]))];
  let out = String(css);
  for (const ref of refs) {
    if (ref.startsWith('data:')) continue;
    let abs = ref;
    if (!/^https?:\/\//i.test(ref) && !ref.startsWith('/')) {
      abs = context.replace(/[^/]*$/, '') + ref; // relative to the sheet
    }
    const data = await toDataUri(env, abs, base, budget);
    const replacement = data || (abs.startsWith('/') ? base + abs : abs);
    out = out.split(ref).join(replacement);
  }
  return out;
}

// All the CSS the exported content needs: the runtime theme (tokens, surfaces,
// @font-face) plus the static sheets, concatenated with their assets embedded.
async function collectCss(env, base, budget) {
  const parts = [];
  try {
    const tokens = await getThemeTokens(env.DB, defaultTokens);
    const surfaces = await getSiteConfig(env.DB, 'surfaces', null);
    const fonts = await getSiteConfig(env.DB, 'fonts', null);
    const theme = [fontFacesToCss(fonts), tokensToCss(tokens), surfacesToCss(surfaces)].join('\n');
    parts.push(await inlineCssUrls(env, theme, '/theme.css', base, budget));
  } catch { /* fall back to the static sheets alone */ }

  for (const href of STYLESHEETS) {
    try {
      const res = await env.ASSETS.fetch(new Request(`https://assets.invalid${href}`));
      if (!res.ok) continue;
      parts.push(await inlineCssUrls(env, await res.text(), href, base, budget));
    } catch { /* skip a sheet we can't read */ }
  }
  return parts.join('\n');
}

// Scripts are stripped, so whatever the block scripts would have revealed has
// to be opened here or it silently vanishes from the export. Only the CMS's own
// disclosure hooks are touched: un-hiding arbitrary [hidden] would also expose
// overlays and backdrops that are meant to stay out of the way.
function revealCollapsed(html) {
  return String(html || '')
    .replace(/(<div\b[^>]*\bdata-(?:tab-panel|group-panel)\s*=\s*"[^"]*"[^>]*?)\shidden(?=[\s>])/gi, '$1')
    .replace(/(<div\b[^>]*\bgal-cap\b[^>]*?)\shidden(?=[\s>])/gi, '$1');
}

// Embeds <img> sources and inline style backgrounds. srcset is dropped first so
// only the one chosen source is embedded rather than every responsive variant.
async function inlineContentAssets(env, html, base, budget) {
  let out = String(html || '')
    .replace(/\s(?:srcset|data-srcset)\s*=\s*"[^"]*"/gi, '')
    .replace(/\ssizes\s*=\s*"[^"]*"/gi, '');

  const srcs = [...new Set([...out.matchAll(/<img\b[^>]*\ssrc\s*=\s*"([^"]+)"/gi)].map((m) => m[1]))];
  for (const src of srcs) {
    const data = await toDataUri(env, src, base, budget);
    if (data) out = out.split(`src="${src}"`).join(`src="${data}"`);
  }

  const bgs = [...new Set([...out.matchAll(/style\s*=\s*"[^"]*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]))];
  for (const bg of bgs) {
    const data = await toDataUri(env, bg, base, budget);
    if (data) out = out.split(bg).join(data);
  }

  // Whatever is left relative would break offline; absolute at least still works.
  return out.replace(/(\s(?:href|src)=")\/(?!\/)/gi, `$1${base}/`);
}

// Builds the finished document. `contentHtml` is already-rendered page or
// article HTML; scripts are stripped because an offline snapshot has nothing to
// talk to and the interactive blocks degrade to their static markup.
export async function buildExportHtml(env, { title, subtitle = '', contentHtml, base, meta = [] }) {
  const budget = assetBudget();
  const css = await collectCss(env, base, budget);
  const body = await inlineContentAssets(
    env,
    revealCollapsed(String(contentHtml || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')),
    base,
    budget
  );

  const metaLine = meta.filter(Boolean).join(' · ');
  const note = budget.skipped
    ? `\n<!-- ${budget.skipped} asset(s) were left as links rather than embedded; those need a connection. -->`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || 'Export')}</title>
<style>
${css}
/* Export-only: no site chrome, so give the content its own page frame. */
body { margin: 0; padding: 2rem 1rem 4rem; }
[data-tab-panel], [data-group-panel] { display: block !important; }
[data-tablist] button { pointer-events: none; }
.export-head { max-width: var(--container-width, 72rem); margin: 0 auto 2rem; }
.export-head h1 { margin: 0 0 0.35rem; }
.export-meta { color: var(--color-muted, #666); font-size: 0.9rem; margin: 0; }
.export-cover { margin: 0 0 2rem; }
.export-cover img { width: 100%; height: auto; display: block; border-radius: var(--radius-md, 8px); }
@media print {
  @page { margin: 16mm 14mm; }
  html, body { background: #fff !important; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { padding: 0; }
}
</style>
</head>
<body>
<div class="export-head">
<h1>${escapeHtml(title || '')}</h1>
${subtitle ? `<p class="lede">${escapeHtml(subtitle)}</p>` : ''}
${metaLine ? `<p class="export-meta">${escapeHtml(metaLine)}</p>` : ''}
</div>
${body}${note}
</body>
</html>`;
}
