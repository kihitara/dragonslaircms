// DragonslairCMS design tokens — the ONE place design defaults are defined.
//
// `defaultTokens` seeds the branding admin's theme store (theme_tokens table).
// At runtime /theme.css is generated from the live tokens: the `color` group is
// the light theme, and the `color-dark` group overrides the same names for the
// dark theme (via [data-theme="dark"] and prefers-color-scheme). Components
// consume var(--color-…) etc. — never a hardcoded hex — so editing a token in
// the admin re-themes the whole site instantly.
//
// Seed palette derives from the DragonslairCMS icon gradient:
//   #930DF2 (vivid purple) → #555272 (slate) → #3E6B43 (deep green)
// with modern grey/white/black neutrals.

export const defaultTokens = {
  // Light theme colours.
  color: {
    // Brand (purple)
    brand: '#930DF2',
    'brand-light': '#AE4BF6',
    'brand-dark': '#6C0AB4',
    'brand-soft': '#F5EBFE',
    // Accent (green)
    accent: '#4E8A56',
    'accent-light': '#6FB077',
    'accent-dark': '#3E6B43',
    'accent-soft': '#E6F2E7',
    // Slate (from the icon's midpoint)
    slate: '#555272',
    'slate-soft': '#ECEBF2',
    // Neutrals & text (semantic)
    bg: '#FFFFFF',
    surface: '#F5F5F7',
    'surface-dark': '#E2E2E7',
    ink: '#1B1B1F',
    muted: '#63636B',
  },
  // Dark theme overrides — same names, flipped values.
  'color-dark': {
    brand: '#B573F7',
    'brand-light': '#C896FA',
    'brand-dark': '#8E2BE8',
    'brand-soft': '#2B1943',
    accent: '#6FB077',
    'accent-light': '#8CC793',
    'accent-dark': '#57955F',
    'accent-soft': '#1C2A1E',
    slate: '#8E8BAD',
    'slate-soft': '#26243A',
    bg: '#141417',
    surface: '#1E1E23',
    'surface-dark': '#2C2C33',
    ink: '#EDEDF2',
    muted: '#9C9CA7',
  },
  font: {
    sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
    display: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
    mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
  },
  radius: {
    sm: '8px',
    md: '12px',
    lg: '20px',
    pill: '9999px',
  },
  size: {
    container: '1100px',
  },
  weight: {
    heading: '700',
  },
};

// --- What a token value may be ---------------------------------------------
// Theme values are written into CSS: /theme.css for every visitor, and an
// inline <style> on the palette page. A value is never escaped into CSS; it is
// checked against a strict pattern for its kind, on save and again whenever CSS
// is generated, so a value stored before these checks can't break out either.
// None of the patterns allow ; { } < > \ @ or url(.

const TOKEN_KEY = /^[a-z0-9_-]+$/i;
const COLOR_VALUE = [
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^(?:rgba?|hsla?)\([0-9.,%\s/deg+-]{1,60}\)$/i,
  /^[a-z]{3,30}$/i, // named colours, transparent, currentColor
  /^var\(--[a-z0-9-]{1,60}\)$/i,
];
// One family: a quoted name, or bare words. A stack is families and commas.
const FONT_FAMILY = `(?:'[A-Za-z0-9 _-]{1,60}'|"[A-Za-z0-9 _-]{1,60}"|[A-Za-z0-9_-]{1,60}(?: [A-Za-z0-9_-]{1,60})*)`;
const FONT_STACK = new RegExp(`^${FONT_FAMILY}(?:\\s*,\\s*${FONT_FAMILY}){0,15}$`);
// Lengths: numbers with units, the four maths functions and var(--x).
const LENGTH_CHARS = /^[0-9a-z.%+*/(), -]{1,120}$/i;
const LENGTH_WORDS = new Set(['px', 'rem', 'em', 'vw', 'vh', 'vmin', 'vmax', 'ch', 'ex', 'clamp', 'min', 'max', 'calc', 'var']);
const WEIGHT_VALUE = /^(?:[1-9]00|normal|bold|bolder|lighter)$/;

function isLength(v) {
  if (!LENGTH_CHARS.test(v)) return false;
  return (v.match(/-*[a-z][a-z0-9-]*/gi) || []).every((w) => LENGTH_WORDS.has(w.toLowerCase()) || /^--[a-z0-9-]+$/i.test(w));
}

export function isValidTokenValue(group, value) {
  const v = String(value ?? '').trim();
  if (!v || /[\r\n]/.test(v)) return false;
  if (group === 'color' || group === 'color-dark') return COLOR_VALUE.some((re) => re.test(v));
  if (group === 'font') return FONT_STACK.test(v);
  if (group === 'radius' || group === 'size') return isLength(v);
  if (group === 'weight') return WEIGHT_VALUE.test(v);
  return false;
}

// Only the token groups, names and values that are safe to write as CSS.
export function cleanTokens(tokens) {
  const out = {};
  for (const [group, entries] of Object.entries(tokens || {})) {
    const kept = {};
    for (const [name, value] of Object.entries(entries || {})) {
      if (TOKEN_KEY.test(name) && isValidTokenValue(group, value)) kept[name] = String(value).trim();
    }
    out[group] = kept;
  }
  return out;
}

// A face from Admin > Fonts: a family name, a font file in the media library,
// a weight and a style. A variable font's face gives its weight as a range,
// such as "100 900".
const FACE_FAMILY = /^[A-Za-z0-9 _-]{1,60}$/;
const FACE_WEIGHT = /^(?:normal|bold|(?:[1-9]\d{0,2}|1000)(?: (?:[1-9]\d{0,2}|1000))?)$/;
const FACE_FILE = /^\/media\/[A-Za-z0-9._/-]{1,200}\.(?:woff2|woff|ttf|otf)$/;
export function isValidFontFace(f) {
  return !!f && FACE_FAMILY.test(String(f.family || ''))
    && FACE_FILE.test(String(f.file || '')) && !String(f.file).includes('..')
    && FACE_WEIGHT.test(String(f.weight || '400'))
    && ['normal', 'italic'].includes(String(f.style || 'normal'));
}

// { color: { brand: '#…' } } -> { 'color-brand': '#…' } (skips color-dark).
export function flattenTokens(tokens) {
  const out = {};
  for (const [group, entries] of Object.entries(tokens)) {
    if (group === 'color-dark') continue;
    for (const [name, value] of Object.entries(entries || {})) {
      out[`${group}-${name}`] = value;
    }
  }
  return out;
}

// Emit the theme stylesheet: :root light values + dark overrides applied both
// by explicit choice (html[data-theme="dark"]) and by OS preference when the
// visitor hasn't chosen (html without data-theme).
export function tokensToCss(rawTokens) {
  const tokens = cleanTokens(rawTokens);
  const flat = flattenTokens(tokens);
  const rootLines = Object.entries(flat).map(([k, v]) => `  --${k}: ${v};`);
  const darkLines = Object.entries(tokens['color-dark'] || {}).map(([k, v]) => `  --color-${k}: ${v};`);
  return [
    '/* AUTO-GENERATED from theme tokens — edit in Admin > Branding. */',
    `:root {\n${rootLines.join('\n')}\n}`,
    `[data-theme="dark"] {\n${darkLines.join('\n')}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${darkLines.map((l) => '  ' + l).join('\n')}\n  }\n}`,
    '',
  ].join('\n');
}

// --- Uploaded fonts (@font-face) --------------------------------------------
// Turn the Fonts admin config ({ faces: [{ family, file, weight, style }] })
// into @font-face rules so a custom family named in the tokens actually loads.
export function fontFacesToCss(config) {
  const FORMAT = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };
  const faces = Array.isArray(config) ? config : (config && Array.isArray(config.faces) ? config.faces : []);
  const rules = faces
    .filter(isValidFontFace)
    .map((f) => {
      const ext = String(f.file).split('?')[0].split('.').pop().toLowerCase();
      const fmt = FORMAT[ext];
      const src = `url('${f.file}')` + (fmt ? ` format('${fmt}')` : '');
      return [
        '@font-face {',
        `  font-family: '${f.family}';`,
        `  src: ${src};`,
        `  font-weight: ${f.weight || '400'};`,
        `  font-style: ${f.style || 'normal'};`,
        '  font-display: swap;',
        '}',
      ].join('\n');
    });
  return rules.length
    ? '/* AUTO-GENERATED @font-face rules from Admin > Fonts. */\n' + rules.join('\n\n') + '\n'
    : '/* No custom fonts uploaded — add them in Admin > Fonts. */\n';
}

// --- Surface palettes ---------------------------------------------------------
// Each surface maps semantic ROLES to colour TOKEN names; blocks pick a surface
// and components consume the --c-* variables. Because the underlying --color-*
// variables flip in dark mode, every surface adapts automatically.

export const SURFACE_KEYS = ['default', 'muted', 'soft', 'green', 'brand', 'dark'];

export const SURFACE_LABELS = {
  default: 'Default (page)', muted: 'Muted grey', soft: 'Soft purple',
  green: 'Soft green', brand: 'Brand purple', dark: 'Slate dark',
};

// [roleKey, cssVar, label] — order = display order in the palette editor.
export const SURFACE_ROLES = [
  ['bg', '--c-bg', 'Background'],
  ['text', '--c-text', 'Body text'],
  ['heading', '--c-heading', 'Headings'],
  ['subtle', '--c-subtle', 'Subtle / muted text'],
  ['feature', '--c-feature', 'Feature / accent'],
  ['link', '--c-link', 'Links'],
  ['panel', '--c-panel', 'Card background'],
  ['panelBorder', '--c-panel-border', 'Card border'],
  ['hairline', '--c-hairline', 'Hairline / divider'],
  ['btnBg', '--c-btn-bg', 'Button background'],
  ['btn', '--c-btn', 'Button text'],
  ['tabBg', '--c-tab-bg', 'Tab background (active)'],
  ['tabText', '--c-tab', 'Tab text (active)'],
];

export const defaultSurfaces = {
  default: { bg: 'bg', text: 'ink', heading: 'ink', subtle: 'muted', feature: 'brand', link: 'brand', panel: 'surface', panelBorder: 'surface-dark', hairline: 'surface-dark', btnBg: 'brand', btn: 'bg', tabBg: 'brand-soft', tabText: 'brand-dark' },
  muted: { bg: 'surface', text: 'ink', heading: 'ink', subtle: 'muted', feature: 'brand', link: 'brand', panel: 'bg', panelBorder: 'surface-dark', hairline: 'surface-dark', btnBg: 'brand', btn: 'bg', tabBg: 'brand-soft', tabText: 'brand-dark' },
  soft: { bg: 'brand-soft', text: 'ink', heading: 'brand-dark', subtle: 'muted', feature: 'brand', link: 'brand-dark', panel: 'bg', panelBorder: 'surface-dark', hairline: 'surface-dark', btnBg: 'brand', btn: 'bg', tabBg: 'bg', tabText: 'brand-dark' },
  green: { bg: 'accent-soft', text: 'ink', heading: 'accent-dark', subtle: 'muted', feature: 'accent-dark', link: 'accent-dark', panel: 'bg', panelBorder: 'surface-dark', hairline: 'surface-dark', btnBg: 'accent-dark', btn: 'bg', tabBg: 'bg', tabText: 'accent-dark' },
  brand: { bg: 'brand-dark', text: 'brand-soft', heading: 'bg', subtle: 'slate-soft', feature: 'accent-light', link: 'brand-soft', panel: 'brand', panelBorder: 'brand-light', hairline: 'brand-light', btnBg: 'accent-light', btn: 'ink', tabBg: 'brand-soft', tabText: 'brand-dark' },
  dark: { bg: 'ink', text: 'surface', heading: 'bg', subtle: 'slate-soft', feature: 'brand-light', link: 'brand-light', panel: 'slate', panelBorder: 'slate-soft', hairline: 'slate', btnBg: 'brand-light', btn: 'ink', tabBg: 'slate-soft', tabText: 'ink' },
};

// Generate the .surface-* { --c-*: var(--color-*) } sheet from a surfaces map.
// Falls back to defaultSurfaces per surface/role so a partial map still works.
export function surfacesToCss(surfaces) {
  const s = surfaces && typeof surfaces === 'object' ? surfaces : {};
  // Surface keys and token names go into selectors and var() names, so only
  // plain names are used, whatever is stored.
  const keys = Array.from(new Set([...SURFACE_KEYS, ...Object.keys(s)])).filter((k) => /^[a-z0-9-]+$/.test(k));
  const blocks = keys.map((key) => {
    const roles = s[key] || {};
    const fallback = defaultSurfaces[key] || defaultSurfaces.default;
    const decls = SURFACE_ROLES.map(([rk, cssVar]) => {
      const tok = TOKEN_KEY.test(roles[rk] || '') ? roles[rk] : fallback[rk];
      return tok ? `  ${cssVar}: var(--color-${tok});` : null;
    }).filter(Boolean).join('\n');
    return `.surface-${key} {\n${decls}\n}`;
  });
  return '/* AUTO-GENERATED from the palette designer — edit in Admin > Palette. */\n' + blocks.join('\n\n') + '\n';
}
