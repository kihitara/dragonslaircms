import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTokens, isValidTokenValue, cleanTokens, tokensToCss, fontFacesToCss, surfacesToCss, isValidFontFace } from '../src/tokens.js';

test('every built-in default is a valid value', () => {
  for (const [group, entries] of Object.entries(defaultTokens)) {
    for (const [name, value] of Object.entries(entries)) assert.ok(isValidTokenValue(group, value), `${group}.${name} = ${value}`);
  }
});

test('the formats the editor offers are accepted', () => {
  for (const v of ['#abc', '#A1B2C3', '#a1b2c3cc', 'rgb(10, 20, 30)', 'rgba(0 0 0 / 50%)', 'hsl(270deg 80% 50%)', 'transparent', 'rebeccapurple', 'var(--color-brand)']) {
    assert.ok(isValidTokenValue('color', v), v);
  }
  for (const v of ['1100px', '1.25rem', '0', '50%', 'clamp(1rem, 2vw + 0.5rem, 2rem)', 'calc(100% - 2rem)', 'var(--size-container)']) {
    assert.ok(isValidTokenValue('size', v), v);
  }
  assert.ok(isValidTokenValue('font', "'My Display', Georgia, serif"));
  assert.ok(isValidTokenValue('weight', '600'));
});

test('anything that could break out of a declaration is refused', () => {
  const hostile = ['red;}body{display:none', 'red</style><script>alert(1)</script>', 'url(https://evil.example/x)', '#fff\n}', 'expression(alert(1))', '\\72 ed', '@import "x"', 'red /* x */'];
  for (const v of hostile) {
    for (const g of ['color', 'font', 'size', 'radius', 'weight']) assert.equal(isValidTokenValue(g, v), false, `${g}: ${v}`);
  }
  assert.equal(isValidTokenValue('font', "'Inter;}"), false);
  assert.equal(isValidTokenValue('size', 'url(x)'), false);
  assert.equal(isValidTokenValue('size', '10px; color: red'), false);
});

test('a hostile value already stored never reaches the stylesheet', () => {
  const css = tokensToCss({ color: { brand: '#930DF2', evil: 'red;}</style><script>x</script>' }, 'color-dark': { brand: 'red;}' }, size: { container: '1100px' } });
  assert.match(css, /--color-brand: #930DF2;/);
  assert.doesNotMatch(css, /script|red;}/);
  assert.deepEqual(cleanTokens({ color: { 'bad name!': '#fff' } }).color, {});
});

test('font faces and surfaces are filtered the same way', () => {
  assert.ok(isValidFontFace({ family: 'My Font', file: '/media/fonts/my-font.woff2', weight: '700', style: 'italic' }));
  for (const f of [{ family: "x'; } body {", file: '/media/fonts/a.woff2' }, { family: 'A', file: "https://evil.example/a.woff2" }, { family: 'A', file: "/media/fonts/a.woff2'); }" }, { family: 'A', file: '/media/../x.woff2' }, { family: 'A', file: '/media/fonts/a.woff2', weight: '700;}' }]) {
    assert.equal(isValidFontFace(f), false, JSON.stringify(f));
  }
  assert.doesNotMatch(fontFacesToCss({ faces: [{ family: "x'} body{", file: '/media/fonts/a.woff2' }] }), /body/);
  const surf = surfacesToCss({ 'x{}': { bg: 'brand' }, soft: { bg: 'brand);} body{' } });
  assert.doesNotMatch(surf, /x\{\}|body\{/);
});

test("production's stored values all survive (checked 2026-10-29)", () => {
  // Variable fonts give their weight as a range; an earlier rule dropped all six faces.
  const faces = ['montserrat', 'montserrat-italic', 'redhattext', 'redhattext-italic', 'redhatmono', 'redhatmono-italic']
    .map((f) => ({ family: 'X', file: `/media/fonts/${f}-variablefont_wght.woff2`, weight: '100 900', style: f.endsWith('italic') ? 'italic' : 'normal' }));
  assert.equal((fontFacesToCss({ faces }).match(/@font-face \{/g) || []).length, 6);
  for (const v of ["'RedHatText', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", "'RedHatMono', ui-monospace, SFMono-Regular, monospace", "'Montserrat', 'IBM Plex Sans', system-ui, sans-serif"]) {
    assert.ok(isValidTokenValue('font', v), v);
  }
  assert.equal(isValidFontFace({ family: 'X', file: '/media/fonts/a.woff2', weight: '100 900; }' }), false);
  assert.equal(isValidFontFace({ family: 'X', file: '/media/fonts/a.woff2', weight: '1001' }), false);
});
