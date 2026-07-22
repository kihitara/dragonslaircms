// Branding/Design + Settings admin sections:
//   /admin/branding    — theme token editor (colours light+dark, fonts, radius…)
//   /admin/palette     — surface palette designer (role → token, live preview)
//   /admin/fonts       — @font-face manager (R2 uploads + face list)
//   /admin/navigation  — site header menu (schema-driven config editor)
//   /admin/footer      — site footer (schema-driven config editor)
//   /admin/settings    — org / SEO / registration settings
//   /admin/emails      — email template overrides
// Every section requires publisher+. The /admin dispatcher routes each path
// prefix to the exported handler; handlers do their own sub-path/method routing.

import { roleAtLeast } from '../auth.js';
import {
  getThemeTokens, setThemeToken, deleteThemeToken,
  getSiteConfig, setSiteConfig, getSiteSettings, setSiteSetting, logActivity,
} from '../db.js';
import { adminPage, escapeHtml, escapeAttr, redirect, html } from '../templates/base.js';
import {
  defaultTokens, tokensToCss,
  SURFACE_KEYS, SURFACE_LABELS, SURFACE_ROLES, defaultSurfaces,
} from '../tokens.js';
import {
  NAV_SCHEMA, NAV_DEFAULT, FOOTER_SCHEMA, FOOTER_DEFAULT, FONTS_SCHEMA, FONTS_DEFAULT,
} from '../config-schemas.js';
import { EMAIL_TEMPLATE_DEFAULTS } from '../email.js';
import { MEDIA_PICKER_HEAD } from './admin-media.js';

// ── Shared helpers ───────────────────────────────────────────────────────────

const BRANDING_CSS = '<link rel="stylesheet" href="/css/branding-admin.css">';
// Custom colour picker (swatch + popover) — the native <input type="color">
// is unusable on iOS, so colour fields are text inputs upgraded by this JS.
const COLOR_PICKER_HEAD = '<link rel="stylesheet" href="/css/color-picker.css"><script src="/js/color-picker.js" defer></script>';
const THEME_NOTE = 'Changes go live on the site within about a minute (/theme.css is cached for 60 seconds).';

const TOKEN_NAME = /^[a-z0-9_-]+$/i;
const HEX6 = /^#[0-9a-fA-F]{6}$/;

const slugify = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// JSON destined for an inline <script> — escape < so '</script>' can't break out.
const forScript = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
const backWith = (path, param, text) => `${path}?${param}=${encodeURIComponent(text)}`;

function requirePublisher(env, user, path) {
  if (roleAtLeast(user, 'publisher')) return null;
  return html(adminPage({
    env, user, title: 'Forbidden', path,
    content: '<h1>Forbidden</h1><p class="muted">This section needs the publisher role.</p>',
  }), { status: 403 });
}

// Flash-in-the-URL notices (?msg= / ?err=) — no session flash infrastructure.
function noticeHtml(url) {
  const err = url.searchParams.get('err');
  if (err) return `<div class="notice notice-error">${escapeHtml(err)}</div>`;
  const msg = url.searchParams.get('msg');
  if (msg) return `<div class="notice notice-green">${escapeHtml(msg)}</div>`;
  return '';
}

function notFoundPage(env, user, path) {
  return html(adminPage({
    env, user, title: 'Not found', path,
    content: `<h1>Not found</h1><p class="muted">No admin page at <code>${escapeHtml(path)}</code>.</p>`,
  }), { status: 404 });
}

// ── Branding: theme token editor ─────────────────────────────────────────────

const TOKEN_GROUPS = new Set(['color', 'color-dark', 'font', 'radius', 'size', 'weight']);
const WEIGHT_OPTIONS = [
  ['100', '100 — Thin'], ['200', '200 — Extra-light'], ['300', '300 — Light'],
  ['400', '400 — Regular'], ['500', '500 — Medium'], ['600', '600 — Semibold'],
  ['700', '700 — Bold'], ['800', '800 — Extra-bold'], ['900', '900 — Black'],
];

export async function handleBranding(request, env, url, user) {
  const gate = requirePublisher(env, user, '/admin/branding'); if (gate) return gate;
  const path = url.pathname.replace(/\/$/, '');

  if (request.method === 'POST') {
    if (path === '/admin/branding') return saveBranding(request, env, user);
    if (path === '/admin/branding/reset') return resetBrandingToken(request, env, user);
    if (path === '/admin/branding/delete') return deleteBrandingColor(request, env, user);
    return redirect('/admin/branding');
  }
  if (path !== '/admin/branding') return notFoundPage(env, user, path);

  const tokens = await getThemeTokens(env.DB, defaultTokens);

  // Colour fields: 6-digit hex values get the custom picker (a .color-field
  // text input that /js/color-picker.js pairs with a swatch button + popover);
  // other values (rgb()/named) stay plain text inputs, still editable.
  const colorInput = (grp, name, value) => HEX6.test(value || '')
    ? `<input type="text" class="color-field" name="token:${grp}:${escapeAttr(name)}" value="${escapeAttr(value)}" spellcheck="false">`
    : `<input type="text" name="token:${grp}:${escapeAttr(name)}" value="${escapeAttr(value || '')}">`;
  const resetBtn = (grp, name) =>
    `<button class="btn btn-secondary btn-small" type="submit" formaction="/admin/branding/reset" name="target" value="${escapeAttr(`${grp}:${name}`)}" title="Discard the saved value and return to the built-in default (unsaved edits above are not kept)">Reset</button>`;

  // Seed colour names in their defined order, custom ones appended.
  const seedColors = Object.keys(defaultTokens.color);
  const allColors = new Set([...seedColors, ...Object.keys(tokens.color || {}), ...Object.keys(tokens['color-dark'] || {})]);
  const colorNames = [...seedColors, ...[...allColors].filter((n) => !seedColors.includes(n)).sort()];

  const colorRows = colorNames.map((name) => `
      <tr>
        <td class="cell-main"><code>${escapeHtml(name)}</code></td>
        <td data-label="Light theme">${colorInput('color', name, tokens.color?.[name] ?? '')}</td>
        <td data-label="Dark theme">${colorInput('color-dark', name, tokens['color-dark']?.[name] ?? '')}</td>
        <td class="row-actions">${seedColors.includes(name)
          ? resetBtn('color', name)
          : `<button class="btn btn-danger btn-small" type="submit" formaction="/admin/branding/delete" name="target" value="${escapeAttr(name)}" title="Remove this custom colour from both themes">Delete</button>`}</td>
      </tr>`).join('');

  // Non-colour groups render as name/value/reset rows; weight gets a select.
  const tokenGroup = (grp, heading, hint) => {
    const defaults = defaultTokens[grp] || {};
    const names = [...new Set([...Object.keys(defaults), ...Object.keys(tokens[grp] || {})])];
    if (!names.length) return '';
    const rows = names.map((name) => {
      const value = tokens[grp]?.[name] ?? '';
      const input = grp === 'weight'
        ? `<select name="token:weight:${escapeAttr(name)}">${WEIGHT_OPTIONS.map(([v, l]) =>
            `<option value="${v}"${String(value || '700') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`
        : `<input type="text" name="token:${grp}:${escapeAttr(name)}" value="${escapeAttr(value)}">`;
      return `
      <tr>
        <td class="cell-main"><code>${escapeHtml(name)}</code></td>
        <td data-label="Value">${input}</td>
        <td class="row-actions">${Object.prototype.hasOwnProperty.call(defaults, name) ? resetBtn(grp, name) : ''}</td>
      </tr>`;
    }).join('');
    return `
      <div class="token-group">
        <h3>${escapeHtml(heading)}</h3>
        ${hint ? `<p class="muted small">${hint}</p>` : ''}
        <table class="admin-table token-table cards"><tbody>${rows}</tbody></table>
      </div>`;
  };

  const section = (title, body, open = false) => `
      <details class="branding-section"${open ? ' open' : ''}>
        <summary>${escapeHtml(title)}</summary>
        <div class="branding-section-body">${body}</div>
      </details>`;

  const coloursBody = `
        <p class="muted small">Each colour has a light-theme value and a dark-theme override (same name, flipped value).</p>
        <table class="admin-table token-table cards">
          <thead><tr><th>Token</th><th>Light theme</th><th>Dark theme</th><th></th></tr></thead>
          <tbody>${colorRows}</tbody>
        </table>
        <div class="token-group">
          <h3>Add a colour</h3>
          <p class="muted small">Custom colours join both themes and become pickable in the Palette designer.</p>
          <div class="addrow">
            <input type="text" name="newColorName" placeholder="e.g. highlight">
            <label>Light <input type="text" class="color-field" name="newColorLight" value="#42DADA" spellcheck="false"></label>
            <label>Dark <input type="text" class="color-field" name="newColorDark" value="#2A8F8F" spellcheck="false"></label>
          </div>
        </div>`;

  const typographyBody =
    tokenGroup('font', 'Fonts', `CSS font stacks. To use an uploaded font, put its family name first (e.g. <code>'MyDisplayFont', system-ui, sans-serif</code>) and add the file under <a href="/admin/fonts">Fonts</a>.`)
    + tokenGroup('weight', 'Headings', 'Font weight for headings site-wide — pick one your chosen font actually includes.');

  const sizesBody =
    tokenGroup('radius', 'Corner radius', '')
    + tokenGroup('size', 'Sizes', '');

  const content = `
    <div class="page-head"><h1>Branding</h1></div>
    ${noticeHtml(url)}
    <p class="muted">Design tokens drive every colour, font and radius on the site — components only ever
      use <code>var(--color-…)</code>, so editing a token re-themes everything. ${escapeHtml(THEME_NOTE)}</p>
    <form method="post" action="/admin/branding">
      ${section('Colours', coloursBody, true)}
      ${section('Typography', typographyBody)}
      ${section('Sizes', sizesBody)}
      <div class="form-actions">
        <button class="btn" type="submit">Save theme</button>
        <span class="muted small">${escapeHtml(THEME_NOTE)}</span>
      </div>
    </form>`;

  return html(adminPage({ env, user, title: 'Branding', path, content, extraHead: BRANDING_CSS + COLOR_PICKER_HEAD }));
}

async function saveBranding(request, env, user) {
  const DB = env.DB;
  const form = await request.formData();
  const ops = [];
  for (const [field, value] of form.entries()) {
    const m = field.match(/^token:([^:]+):(.+)$/);
    if (!m || !TOKEN_GROUPS.has(m[1]) || !TOKEN_NAME.test(m[2])) continue;
    const v = String(value).trim();
    if (v) ops.push(setThemeToken(DB, m[1], m[2], v)); // empty = leave alone; use Reset to revert
  }
  const newName = slugify(form.get('newColorName'));
  if (newName) {
    const light = String(form.get('newColorLight') || '').trim() || '#888888';
    const dark = String(form.get('newColorDark') || '').trim() || light;
    ops.push(setThemeToken(DB, 'color', newName, light));
    ops.push(setThemeToken(DB, 'color-dark', newName, dark));
  }
  await Promise.all(ops);
  await logActivity(DB, user, 'updated', 'branding', 'design tokens');
  return redirect(backWith('/admin/branding', 'msg', 'Theme saved. ' + THEME_NOTE));
}

// Reset = delete the DB row(s); getThemeTokens overlays rows on the code
// defaults, so a missing row falls straight back to src/tokens.js.
async function resetBrandingToken(request, env, user) {
  const form = await request.formData();
  const [grp, name] = String(form.get('target') || '').split(':');
  if (!TOKEN_GROUPS.has(grp) || !TOKEN_NAME.test(name || '')) return redirect('/admin/branding');
  await deleteThemeToken(env.DB, grp, name);
  if (grp === 'color') await deleteThemeToken(env.DB, 'color-dark', name); // colour resets cover both themes
  await logActivity(env.DB, user, 'reset', 'branding', `${grp}/${name}`);
  return redirect(backWith('/admin/branding', 'msg', `Reset ${grp}/${name} to its default.`));
}

async function deleteBrandingColor(request, env, user) {
  const form = await request.formData();
  const name = String(form.get('target') || '');
  if (!TOKEN_NAME.test(name)) return redirect('/admin/branding');
  if (Object.prototype.hasOwnProperty.call(defaultTokens.color, name)) {
    return redirect(backWith('/admin/branding', 'err', 'Built-in colours cannot be deleted — use Reset instead.'));
  }
  await deleteThemeToken(env.DB, 'color', name);
  await deleteThemeToken(env.DB, 'color-dark', name);
  await logActivity(env.DB, user, 'deleted', 'branding', `colour ${name}`);
  return redirect(backWith('/admin/branding', 'msg', `Deleted custom colour "${name}".`));
}

// ── Palette: surface designer ────────────────────────────────────────────────

// Sample markup recoloured by each surface's --c-* variables in the preview.
const PALETTE_SAMPLE = `
<h3 class="ppb-h">Heading sample</h3>
<p class="ppb-text">Body copy with a <a class="ppb-link" href="#" onclick="return false">link</a>, <span class="ppb-subtle">subtle text</span> and a <span class="ppb-feature">feature accent</span>.</p>
<div class="ppb-grid">
  <div class="ppb-card"><div class="ppb-h">Feature card</div><p class="ppb-subtle">Short description.</p></div>
  <div class="ppb-card"><div class="ppb-stat">98%</div><div class="ppb-subtle">Stat label</div></div>
</div>
<div>
  <div class="ppb-tabs"><button type="button" class="ppb-tab ppb-tab-on" data-pptab="0">First tab</button><button type="button" class="ppb-tab" data-pptab="1">Second tab</button></div>
  <p class="ppb-text" data-pppanel="0">First tab panel content.</p>
  <p class="ppb-text" data-pppanel="1" hidden>Second tab panel content.</p>
</div>
<div class="ppb-tablewrap"><table class="ppb-table"><thead><tr><th>Column A</th><th>Column B</th></tr></thead><tbody><tr><td>Value one</td><td>Value two</td></tr></tbody></table></div>
<details class="ppb-faq-item" open><summary class="ppb-faq-q"><span>A question?</span><span class="ppb-faq-plus ppb-feature">+</span></summary><p class="ppb-subtle ppb-faq-a">The answer shows here when opened.</p></details>
<div class="ppb-cta"><div class="ppb-h">Ready to start?</div><span class="ppb-btn">Button</span> <span class="ppb-btn-secondary">Secondary</span></div>`;

const surfaceLabel = (key, stored) =>
  SURFACE_LABELS[key] || (stored[key] && typeof stored[key].label === 'string' && stored[key].label) || key;

export async function handlePalette(request, env, url, user) {
  const gate = requirePublisher(env, user, '/admin/palette'); if (gate) return gate;
  const path = url.pathname.replace(/\/$/, '');
  const DB = env.DB;

  if (request.method === 'POST') {
    if (path === '/admin/palette') return savePalette(request, env, user);
    if (path === '/admin/palette/add') return addSurface(request, env, user);
    if (path === '/admin/palette/delete') return deleteSurface(request, env, user);
    return redirect('/admin/palette');
  }
  if (path !== '/admin/palette') return notFoundPage(env, user, path);

  const tokens = await getThemeTokens(DB, defaultTokens);
  const stored = (await getSiteConfig(DB, 'surfaces', {})) || {};
  const customKeys = Object.keys(stored).filter((k) => !SURFACE_KEYS.includes(k)).sort();
  const keys = [...SURFACE_KEYS, ...customKeys];

  // Full role map per surface for the editor (stored values over defaults);
  // labels never round-trip through the client, they're re-attached on save.
  const config = {};
  for (const key of keys) {
    const fallback = defaultSurfaces[key] || defaultSurfaces.default;
    const s = stored[key] || {};
    const roles = {};
    for (const [rk] of SURFACE_ROLES) {
      roles[rk] = (typeof s[rk] === 'string' && s[rk]) ? s[rk] : fallback[rk];
    }
    config[key] = roles;
  }
  const surfaces = keys.map((k) => [k, surfaceLabel(k, stored)]);
  const paletteTokens = Object.keys(tokens.color || {});

  const customList = customKeys.length
    ? customKeys.map((k) => `
        <form method="post" action="/admin/palette/delete" style="display:inline-flex;align-items:center;gap:.5rem;margin-right:1.2rem">
          <code>surface-${escapeHtml(k)}</code>
          <button class="btn btn-danger btn-small" type="submit" name="key" value="${escapeAttr(k)}">Delete</button>
        </form>`).join('')
    : '<p class="muted small">No custom surfaces yet.</p>';

  const content = `
    <div class="page-head"><h1>Palette</h1></div>
    ${noticeHtml(url)}
    <p class="muted">Each surface maps colour roles to theme tokens; blocks pick a surface and every
      component on it recolours. Because the underlying tokens flip in dark mode, surfaces adapt
      automatically. ${escapeHtml(THEME_NOTE)}</p>
    <form method="post" action="/admin/palette">
      <div id="palette-editor"></div>
      <input type="hidden" name="config" id="config-json" value="${escapeAttr(JSON.stringify(config))}">
      <div class="form-actions">
        <button class="btn" type="submit">Save palettes</button>
        <span class="muted small">${escapeHtml(THEME_NOTE)}</span>
      </div>
    </form>
    <div class="card" style="margin-top:1.6rem">
      <h2>Custom surfaces</h2>
      <p class="muted small">A custom surface becomes a <code>surface-&lt;key&gt;</code> class usable anywhere
        surfaces are picked. New surfaces start as a copy of Default (page).</p>
      ${customList}
      <form method="post" action="/admin/palette/add" class="addrow" style="margin-top:.8rem">
        <input type="text" name="name" placeholder="e.g. Highlight" required>
        <button class="btn btn-small" type="submit">Add surface</button>
      </form>
    </div>
    <script>
      window.__CONFIG = ${forScript(config)};
      window.__PALETTE_SURFACES = ${forScript(surfaces)};
      window.__PALETTE_ROLES = ${forScript(SURFACE_ROLES)};
      window.__PALETTE_TOKENS = ${forScript(paletteTokens)};
      window.__PALETTE_SAMPLE = ${forScript(PALETTE_SAMPLE)};
    </script>
    <script src="/js/palette-editor.js"></script>`;

  // Inject the live token CSS so swatches/previews are exact even while
  // /theme.css is still serving its cached (up to 60 s old) copy.
  const extraHead = `${BRANDING_CSS}<style>${tokensToCss(tokens)}</style>`;
  return html(adminPage({ env, user, title: 'Palette', path, content, extraHead }));
}

async function savePalette(request, env, user) {
  const DB = env.DB;
  const form = await request.formData();
  let parsed;
  try {
    parsed = JSON.parse(String(form.get('config') || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  } catch (e) {
    return redirect(backWith('/admin/palette', 'err', 'Palette invalid: ' + e.message));
  }
  const prev = (await getSiteConfig(DB, 'surfaces', {})) || {};
  const roleKeys = SURFACE_ROLES.map(([rk]) => rk);
  const clean = {};
  for (const [key, roles] of Object.entries(parsed)) {
    if (!/^[a-z0-9-]+$/.test(key) || !roles || typeof roles !== 'object') continue;
    const out = {};
    for (const rk of roleKeys) {
      if (typeof roles[rk] === 'string' && TOKEN_NAME.test(roles[rk])) out[rk] = roles[rk];
    }
    // Keep the custom surface's display label (server-side only).
    if (prev[key] && typeof prev[key].label === 'string') out.label = prev[key].label;
    clean[key] = out;
  }
  await setSiteConfig(DB, 'surfaces', clean);
  await logActivity(DB, user, 'updated', 'palette', 'surface palettes');
  return redirect(backWith('/admin/palette', 'msg', 'Palettes saved. ' + THEME_NOTE));
}

async function addSurface(request, env, user) {
  const DB = env.DB;
  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const key = slugify(name);
  if (!key) return redirect(backWith('/admin/palette', 'err', 'Enter a surface name.'));
  const stored = (await getSiteConfig(DB, 'surfaces', {})) || {};
  if (SURFACE_KEYS.includes(key) || stored[key]) {
    return redirect(backWith('/admin/palette', 'err', `A surface called "${key}" already exists.`));
  }
  stored[key] = { label: name, ...defaultSurfaces.default };
  await setSiteConfig(DB, 'surfaces', stored);
  await logActivity(DB, user, 'created', 'palette', `surface ${key}`);
  return redirect(backWith('/admin/palette', 'msg', `Surface "${key}" added — set its colours below and Save.`));
}

async function deleteSurface(request, env, user) {
  const DB = env.DB;
  const form = await request.formData();
  const key = String(form.get('key') || '');
  if (SURFACE_KEYS.includes(key)) {
    return redirect(backWith('/admin/palette', 'err', 'Built-in surfaces cannot be deleted.'));
  }
  const stored = (await getSiteConfig(DB, 'surfaces', {})) || {};
  if (stored[key]) {
    delete stored[key];
    await setSiteConfig(DB, 'surfaces', stored);
    await logActivity(env.DB, user, 'deleted', 'palette', `surface ${key}`);
  }
  return redirect(backWith('/admin/palette', 'msg', `Surface "${key}" deleted.`));
}

// ── Schema-driven config sections (Navigation / Footer / Fonts) ──────────────

function renderConfigEditorPage({ env, user, url, path, title, intro, schema, config, extraCards = '' }) {
  const content = `
    <div class="page-head"><h1>${escapeHtml(title)}</h1></div>
    ${noticeHtml(url)}
    <p class="muted">${intro}</p>
    ${extraCards}
    <form method="post" action="${escapeAttr(path)}">
      <div id="config-editor"></div>
      <input type="hidden" name="config" id="config-json" value="${escapeAttr(JSON.stringify(config))}">
      <div class="form-actions"><button class="btn" type="submit">Save</button></div>
    </form>
    <script>window.__SCHEMA = ${forScript(schema)}; window.__CONFIG = ${forScript(config)};</script>
    <script src="/js/config-editor.js"></script>`;
  // MEDIA_PICKER_HEAD: config-editor marks media-type fields with data-media,
  // which window.MEDIA turns into URL + Browse combos.
  return html(adminPage({ env, user, title, path, content, extraHead: BRANDING_CSS + MEDIA_PICKER_HEAD }));
}

// Parse the posted #config-json; returns { ok, value | error }.
async function parsePostedConfig(request) {
  const form = await request.formData();
  try {
    const parsed = JSON.parse(String(form.get('config') || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return { ok: true, value: parsed, form };
  } catch (e) {
    return { ok: false, error: e.message, form };
  }
}

async function configSection(request, env, url, user, { path, key, schema, fallback, title, intro, savedNote }) {
  const gate = requirePublisher(env, user, path); if (gate) return gate;
  const current = url.pathname.replace(/\/$/, '');
  if (current !== path) return notFoundPage(env, user, current);

  if (request.method === 'POST') {
    const parsed = await parsePostedConfig(request);
    if (!parsed.ok) return redirect(backWith(path, 'err', `${title} config invalid: ${parsed.error}`));
    await setSiteConfig(env.DB, key, parsed.value);
    await logActivity(env.DB, user, 'updated', key, title);
    return redirect(backWith(path, 'msg', `${title} saved. ${savedNote}`));
  }

  const config = (await getSiteConfig(env.DB, key, fallback)) || fallback;
  return renderConfigEditorPage({ env, user, url, path, title, intro, schema, config });
}

export function handleNavigation(request, env, url, user) {
  return configSection(request, env, url, user, {
    path: '/admin/navigation', key: 'nav', schema: NAV_SCHEMA, fallback: NAV_DEFAULT,
    title: 'Navigation',
    intro: 'The site header menu. Each item links directly; add child links for a one-level dropdown.',
    savedNote: 'Changes are live immediately.',
  });
}

export function handleFooter(request, env, url, user) {
  return configSection(request, env, url, user, {
    path: '/admin/footer', key: 'footer', schema: FOOTER_SCHEMA, fallback: FOOTER_DEFAULT,
    title: 'Footer',
    intro: 'The site footer: link columns and the bottom-bar note.',
    savedNote: 'Changes are live immediately.',
  });
}

// ── Fonts: face list + R2 upload ─────────────────────────────────────────────

// ext → both the R2 content type and the @font-face format() in tokens.js.
const FONT_TYPES = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

export async function handleFonts(request, env, url, user) {
  const gate = requirePublisher(env, user, '/admin/fonts'); if (gate) return gate;
  const path = url.pathname.replace(/\/$/, '');
  const DB = env.DB;

  if (request.method === 'POST') {
    if (path === '/admin/fonts/upload') return uploadFont(request, env, user);
    if (path === '/admin/fonts') {
      const parsed = await parsePostedConfig(request);
      if (!parsed.ok) return redirect(backWith('/admin/fonts', 'err', `Fonts config invalid: ${parsed.error}`));
      // Normalise to { faces: [{ family, file, weight, style }] } — the shape
      // fontFacesToCss consumes (it skips faces missing family or file).
      const faces = (Array.isArray(parsed.value.faces) ? parsed.value.faces : [])
        .filter((f) => f && typeof f === 'object')
        .map((f) => ({
          family: String(f.family || '').trim(),
          file: String(f.file || '').trim(),
          weight: String(f.weight || '').trim() || '400',
          style: f.style === 'italic' ? 'italic' : 'normal',
        }));
      await setSiteConfig(DB, 'fonts', { faces });
      await logActivity(DB, user, 'updated', 'fonts', 'font faces');
      return redirect(backWith('/admin/fonts', 'msg', `Fonts saved. ${THEME_NOTE}`));
    }
    return redirect('/admin/fonts');
  }
  if (path !== '/admin/fonts') return notFoundPage(env, user, path);

  const uploadCard = `
    <div class="card" style="margin-bottom:1.4rem">
      <h2>Upload a font file</h2>
      <p class="muted small">Stored in media under <code>fonts/</code> and added to the face list below
        automatically. Add one face per weight/style you need.</p>
      <form method="post" action="/admin/fonts/upload" enctype="multipart/form-data" class="upload-row">
        <div class="field grow"><label for="font-file">Font file (.woff2 recommended)</label>
          <input type="file" id="font-file" name="file" accept=".woff2,.woff,.ttf,.otf" required></div>
        <div class="field"><label for="font-family">Family name</label>
          <input type="text" id="font-family" name="family" placeholder="e.g. MyDisplayFont"></div>
        <div class="field"><label for="font-weight">Weight</label>
          <input type="text" id="font-weight" name="weight" value="400"></div>
        <div class="field"><label for="font-style">Style</label>
          <select id="font-style" name="style"><option value="normal">Normal</option><option value="italic">Italic</option></select></div>
        <button class="btn" type="submit">Upload</button>
      </form>
    </div>`;

  const config = (await getSiteConfig(DB, 'fonts', FONTS_DEFAULT)) || FONTS_DEFAULT;
  return renderConfigEditorPage({
    env, user, url, path: '/admin/fonts', title: 'Fonts',
    intro: `Font faces become <code>@font-face</code> rules in /theme.css, so a custom family named in
      <a href="/admin/branding">Branding</a> actually loads. Each face's family name must match the one
      used in the Branding font stack. ${escapeHtml(THEME_NOTE)}`,
    schema: FONTS_SCHEMA, config, extraCards: uploadCard,
  });
}

async function uploadFont(request, env, user) {
  const DB = env.DB;
  if (!env.MEDIA) {
    return redirect(backWith('/admin/fonts', 'err', 'No media bucket is configured, so fonts cannot be uploaded. Bind an R2 bucket as MEDIA in wrangler.jsonc.'));
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.name) {
    return redirect(backWith('/admin/fonts', 'err', 'Choose a font file to upload.'));
  }
  const safe = String(file.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  const ext = safe.split('.').pop();
  if (!FONT_TYPES[ext]) {
    return redirect(backWith('/admin/fonts', 'err', 'Unsupported file type — use .woff2, .woff, .ttf or .otf.'));
  }
  // Bytes live in R2; the media route serves them back at /media/<key>.
  await env.MEDIA.put(`fonts/${safe}`, await file.arrayBuffer(), {
    httpMetadata: { contentType: FONT_TYPES[ext] },
  });

  const config = (await getSiteConfig(DB, 'fonts', FONTS_DEFAULT)) || FONTS_DEFAULT;
  const faces = Array.isArray(config.faces) ? config.faces : [];
  faces.push({
    family: String(form.get('family') || '').trim() || safe.replace(/\.[^.]+$/, ''),
    file: `/media/fonts/${safe}`,
    weight: String(form.get('weight') || '').trim() || '400',
    style: form.get('style') === 'italic' ? 'italic' : 'normal',
  });
  await setSiteConfig(DB, 'fonts', { faces });
  await logActivity(DB, user, 'uploaded', 'fonts', safe);
  return redirect(backWith('/admin/fonts', 'msg',
    `Uploaded ${safe} and added a face for it. Check its family name matches the Branding font stack. ${THEME_NOTE}`));
}

// ── Settings ─────────────────────────────────────────────────────────────────

const TEXT_SETTINGS = [
  ['org_name', 'Organisation name', 'text', 'Shown in the header, footer, admin and page titles.'],
  ['org_tagline', 'Tagline', 'text', 'Short line shown on the home page and in the footer.'],
  ['logo_url', 'Logo / favicon image', 'media', 'Shown in the site header, the admin, and as the browser tab icon. Defaults to the bundled icon. A square SVG or PNG works best.'],
  ['seo_title_template', 'SEO title template', 'text', 'Optional — how page titles are composed, e.g. "%s — My Site" or "%s | My Site".'],
  ['seo_description', 'Default SEO description', 'textarea', 'Used when a page has no description of its own.'],
  ['og_image_url', 'Default share image URL', 'media', 'Open Graph image used when a page has no share image.'],
];
// Toggles default ON when the row is absent. Fourth element groups them into
// fieldsets.
const TOGGLE_SETTINGS = [
  ['email_enabled', 'Send outgoing email', 'Sending email needs the send_email binding in wrangler.jsonc plus a domain set up for Cloudflare Email Routing (Workers Paid). Turn this OFF if you are on the Workers Free plan or have no email domain — the site then uses in-app notifications only, and sign-up skips email verification while password resets are handled by an admin (see Readers). Email is also skipped automatically when the binding is absent.', 'Email'],
  ['self_registration', 'Allow reader self-registration', 'Visitors can create their own reader accounts. When off, the registration page is closed.', 'Reader registration'],
  ['registration_requires_approval', 'New registrations require approval', 'New readers wait for a CMS user to approve them before they can sign in.', 'Reader registration'],
  ['corrections_enabled', 'Enable the “Suggest a correction” form', 'When off, the correction form is removed from every page and article site-wide (and the per-item toggle is disabled). Turn this off to shut out correction-form spam entirely.', 'Corrections'],
];

export async function handleSettings(request, env, url, user) {
  const gate = requirePublisher(env, user, '/admin/settings'); if (gate) return gate;
  const path = url.pathname.replace(/\/$/, '');
  if (path !== '/admin/settings') return notFoundPage(env, user, path);
  const DB = env.DB;

  if (request.method === 'POST') {
    const form = await request.formData();
    for (const [key] of TEXT_SETTINGS) {
      await setSiteSetting(DB, key, String(form.get(key) ?? '').trim());
    }
    for (const [key] of TOGGLE_SETTINGS) {
      await setSiteSetting(DB, key, form.get(key) ? '1' : '0'); // unchecked boxes aren't posted
    }
    await logActivity(DB, user, 'updated', 'settings', 'site settings');
    return redirect(backWith('/admin/settings', 'msg', 'Settings saved.'));
  }

  const settings = await getSiteSettings(DB);
  const isOn = (key) => String(settings[key] ?? '1') !== '0'; // absent row = enabled

  const textFields = TEXT_SETTINGS.map(([key, label, kind, hint]) => `
    <div class="field">
      <label for="set-${key}">${escapeHtml(label)}</label>
      ${kind === 'textarea'
        ? `<textarea id="set-${key}" name="${key}" rows="3">${escapeHtml(settings[key] || '')}</textarea>`
        : `<input type="text" id="set-${key}" name="${key}" value="${escapeAttr(settings[key] || '')}"${kind === 'media' ? ' data-media' : ''}>`}
      <p class="hint">${escapeHtml(hint)}</p>
    </div>`).join('');

  // Group the toggles into a fieldset each (by their fourth element).
  const toggleGroups = {};
  TOGGLE_SETTINGS.forEach(([key, label, hint, group]) => {
    (toggleGroups[group] = toggleGroups[group] || []).push(`
    <div class="field field-check">
      <label><input type="checkbox" name="${key}" value="1"${isOn(key) ? ' checked' : ''}> ${escapeHtml(label)}</label>
      <p class="hint">${escapeHtml(hint)}</p>
    </div>`);
  });
  const toggleFieldsets = Object.keys(toggleGroups).map((g) =>
    `<fieldset><legend>${escapeHtml(g)}</legend>${toggleGroups[g].join('')}</fieldset>`
  ).join('');

  const content = `
    <div class="page-head"><h1>Settings</h1></div>
    ${noticeHtml(url)}
    <form method="post" action="/admin/settings">
      <fieldset><legend>Organisation &amp; SEO</legend>${textFields}</fieldset>
      ${toggleFieldsets}
      <div class="form-actions"><button class="btn" type="submit">Save settings</button></div>
    </form>`;

  return html(adminPage({ env, user, title: 'Settings', path, content, extraHead: BRANDING_CSS + MEDIA_PICKER_HEAD }));
}

// ── Email templates ──────────────────────────────────────────────────────────
// Defaults live in code (src/email.js EMAIL_TEMPLATE_DEFAULTS); rows in
// email_templates override them. Reset = delete the row.

const EMAIL_KEY = /^[a-z0-9_-]+$/i;

export async function handleEmails(request, env, url, user) {
  const gate = requirePublisher(env, user, '/admin/emails'); if (gate) return gate;
  const path = url.pathname.replace(/\/$/, '');
  const DB = env.DB;

  if (path === '/admin/emails') return emailsList(env, user, url);

  const mReset = path.match(/^\/admin\/emails\/([^/]+)\/reset$/);
  if (mReset && request.method === 'POST') {
    const key = mReset[1];
    if (!EMAIL_KEY.test(key)) return redirect('/admin/emails');
    await DB.prepare('DELETE FROM email_templates WHERE key = ?').bind(key).run();
    await logActivity(DB, user, 'reset', 'email template', key);
    // A custom template (no code default) is gone entirely once its row is deleted.
    return EMAIL_TEMPLATE_DEFAULTS[key]
      ? redirect(backWith(`/admin/emails/${key}`, 'msg', 'Reset to the default template.'))
      : redirect(backWith('/admin/emails', 'msg', `Deleted custom template "${key}".`));
  }

  const mEdit = path.match(/^\/admin\/emails\/([^/]+)$/);
  if (mEdit) {
    const key = mEdit[1];
    if (!EMAIL_KEY.test(key)) return notFoundPage(env, user, path);
    if (request.method === 'POST') return saveEmailTemplate(request, env, user, key);
    return emailEditPage(env, user, url, key);
  }

  return notFoundPage(env, user, path);
}

async function emailsList(env, user, url) {
  const { results } = await env.DB.prepare('SELECT key, subject FROM email_templates').all();
  const dbMap = Object.fromEntries((results || []).map((r) => [r.key, r]));
  const keys = [...new Set([...Object.keys(EMAIL_TEMPLATE_DEFAULTS), ...Object.keys(dbMap)])].sort();

  const rows = keys.map((key) => {
    const row = dbMap[key];
    const def = EMAIL_TEMPLATE_DEFAULTS[key];
    return `
      <tr>
        <td class="cell-main"><a href="/admin/emails/${escapeAttr(key)}"><code>${escapeHtml(key)}</code></a></td>
        <td data-label="Subject">${escapeHtml(row?.subject ?? def?.subject ?? '')}</td>
        <td data-label="Source">${row
          ? '<span class="status-pill modified">Customised</span>'
          : '<span class="status-pill draft">Default</span>'}</td>
      </tr>`;
  }).join('');

  const content = `
    <div class="page-head"><h1>Email templates</h1></div>
    ${noticeHtml(url)}
    <p class="muted">Subjects and bodies for every email the site sends. Defaults live in code;
      editing a template stores an override — Reset returns to the default.</p>
    ${keys.length ? `
    <table class="admin-table cards">
      <thead><tr><th>Template</th><th>Subject</th><th>Source</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : '<p class="muted">No email templates yet — they appear here once the email system defines its defaults.</p>'}`;

  return html(adminPage({ env, user, title: 'Email templates', path: '/admin/emails', content, extraHead: BRANDING_CSS }));
}

async function emailEditPage(env, user, url, key) {
  const def = EMAIL_TEMPLATE_DEFAULTS[key];
  const row = await env.DB.prepare('SELECT * FROM email_templates WHERE key = ?').bind(key).first();
  if (!def && !row) return notFoundPage(env, user, `/admin/emails/${key}`);

  const subject = row?.subject ?? def?.subject ?? '';
  const body = row?.body ?? def?.body ?? '';

  // Document the {{variable}} placeholders when the default declares them.
  const varsHtml = Array.isArray(def?.variables) && def.variables.length
    ? `<p class="hint">Available placeholders:</p><ul class="small">${def.variables.map((v) => `<li><code>${escapeHtml(v)}</code></li>`).join('')}</ul>`
    : `<p class="hint">Placeholders written as <code>{{variable}}</code> are replaced with real values when
        the email is sent. The available variables depend on the template — the default subject and body
        show the ones it uses.</p>`;

  const content = `
    <p class="small"><a href="/admin/emails">← All email templates</a></p>
    <div class="page-head"><h1>Email template: <code>${escapeHtml(key)}</code></h1></div>
    ${noticeHtml(url)}
    <form method="post" action="/admin/emails/${escapeAttr(key)}">
      <div class="field">
        <label for="et-subject">Subject</label>
        <input type="text" id="et-subject" name="subject" value="${escapeAttr(subject)}" required>
      </div>
      <div class="field">
        <label for="et-body">Body (plain text)</label>
        <textarea id="et-body" name="body" rows="14" style="font-family:var(--font-mono);font-size:.85rem" required>${escapeHtml(body)}</textarea>
        ${varsHtml}
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Save template</button>
        ${row ? `<button class="btn btn-secondary btn-small" type="submit" formaction="/admin/emails/${escapeAttr(key)}/reset"
            title="${def ? 'Delete the override and return to the built-in default' : 'Delete this custom template entirely'}">
            ${def ? 'Reset to default' : 'Delete custom template'}</button>` : ''}
        ${!row && def ? '<span class="muted small">Currently using the built-in default.</span>' : ''}
      </div>
    </form>`;

  return html(adminPage({ env, user, title: `Email template — ${key}`, path: '/admin/emails', content, extraHead: BRANDING_CSS }));
}

async function saveEmailTemplate(request, env, user, key) {
  const form = await request.formData();
  const subject = String(form.get('subject') || '').trim();
  const body = String(form.get('body') || '').trim();
  if (!subject || !body) {
    return redirect(backWith(`/admin/emails/${key}`, 'err', 'Subject and body are both required.'));
  }
  await env.DB.prepare(
    `INSERT INTO email_templates (key, subject, body, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET subject = ?, body = ?, updated_at = datetime('now')`
  ).bind(key, subject, body, subject, body).run();
  await logActivity(env.DB, user, 'updated', 'email template', key);
  return redirect(backWith(`/admin/emails/${key}`, 'msg', 'Template saved.'));
}
