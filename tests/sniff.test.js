import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffType, uploadError, servedInline, nameWithSniffedExt, MB } from '../src/sniff.js';

const bytes = (...parts) => {
  const out = [];
  for (const p of parts) typeof p === 'string' ? out.push(...[...p].map((c) => c.charCodeAt(0))) : out.push(...p);
  return new Uint8Array(out);
};
const ftyp = (major, ...compat) => bytes([0, 0, 0, 16 + 4 * compat.length], 'ftyp', major, [0, 0, 0, 0], ...compat);

test('recognises each format by its signature', () => {
  assert.equal(sniffType(bytes([0xff, 0xd8, 0xff, 0xe0])).type, 'image/jpeg');
  assert.equal(sniffType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).type, 'image/png');
  assert.equal(sniffType(bytes('GIF89a')).type, 'image/gif');
  assert.equal(sniffType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')).type, 'image/webp');
  assert.equal(sniffType(ftyp('avif', 'mif1')).type, 'image/avif');
  assert.equal(sniffType(ftyp('heic', 'mif1')).kind, 'heic');
  assert.equal(sniffType(ftyp('isom', 'mp41')).type, 'video/mp4');
  assert.equal(sniffType(ftyp('qt  ')).type, 'video/quicktime');
  assert.equal(sniffType(bytes([0x1a, 0x45, 0xdf, 0xa3])).type, 'video/webm');
  assert.equal(sniffType(bytes('%PDF-1.7')).type, 'application/pdf');
  assert.equal(sniffType(bytes('  <svg xmlns="http://www.w3.org/2000/svg">')).kind, 'svg');
  assert.equal(sniffType(bytes('<?xml version="1.0"?>\n<svg>')).kind, 'svg');
  assert.equal(sniffType(bytes('<!DOCTYPE html><html>')).kind, 'html');
  assert.equal(sniffType(bytes('hello')).kind, 'other');
});

test('the name and the browser are ignored: HTML called photo.png is HTML', () => {
  const s = sniffType(bytes('<html><script>alert(1)</script>'));
  assert.equal(s.kind, 'html');
  assert.equal(nameWithSniffedExt('photo.png', s), 'photo.html');
  assert.equal(nameWithSniffedExt('notes.zip', sniffType(bytes('PK'))), 'notes.zip');
});

test('who may upload what, and how big', () => {
  const svg = sniffType(bytes('<svg>'));
  const html = sniffType(bytes('<!doctype html>'));
  const jpeg = sniffType(bytes([0xff, 0xd8, 0xff]));
  assert.match(uploadError(svg, 100, { purpose: 'library', isAdmin: false }), /Only an admin/);
  assert.match(uploadError(html, 100, { purpose: 'library', isAdmin: false }), /Only an admin/);
  assert.equal(uploadError(svg, 100, { purpose: 'library', isAdmin: true }), null);
  assert.match(uploadError(svg, 100, { purpose: 'photo', isAdmin: true }), /photo needs/);
  assert.equal(uploadError(jpeg, 8 * MB, { purpose: 'photo', isAdmin: false }), null);
  assert.match(uploadError(jpeg, 8 * MB + 1, { purpose: 'library', isAdmin: true }), /limit/);
  assert.match(uploadError(sniffType(ftyp('heic')), 100, { purpose: 'library', isAdmin: true }), /HEIC/);
});

test('only images, video, PDF, HTML and fonts are served inline', () => {
  for (const t of ['image/png', 'image/svg+xml', 'video/mp4', 'application/pdf', 'text/html; charset=utf-8', 'font/woff2']) assert.ok(servedInline(t), t);
  for (const t of ['application/octet-stream', 'application/zip', 'text/plain', 'application/javascript', 'audio/mpeg']) assert.equal(servedInline(t), false, t);
});
