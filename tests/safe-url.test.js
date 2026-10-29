import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, isSafeUrl } from '../src/templates/base.js';

test('keeps paths, fragments and the allowed schemes', () => {
  for (const u of ['/about', '/a/b?c=1#d', '#top', 'https://example.com', 'http://example.com', 'mailto:a@b.c', 'tel:+6421', 'about', 'page?x=1']) {
    assert.equal(safeUrl(u), u, u);
    assert.equal(isSafeUrl(u), true, u);
  }
});

test('turns every other scheme into #', () => {
  for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:x', 'data:text/html,<b>x</b>', 'file:///etc/passwd']) {
    assert.equal(safeUrl(u), '#', u);
    assert.equal(isSafeUrl(u), false, u);
  }
});

test('ignores whitespace and control characters hidden inside a scheme', () => {
  assert.equal(safeUrl('java\tscript:alert(1)'), '#');
  assert.equal(safeUrl('java\nscript:alert(1)'), '#');
  assert.equal(safeUrl(' \u0000javascript:alert(1)'), '#');
});

test('refuses paths that browsers read as another site', () => {
  for (const u of ['//evil.com', '/\\evil.com', '\\\\evil.com', '\\evil.com']) {
    assert.equal(safeUrl(u), '#', u);
  }
});

test('an empty value stays empty and counts as safe', () => {
  assert.equal(safeUrl(''), '');
  assert.equal(safeUrl(null), '');
  assert.equal(isSafeUrl(''), true);
});
