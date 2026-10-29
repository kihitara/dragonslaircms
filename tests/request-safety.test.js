import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossSiteRequest, withSecurityHeaders } from '../src/csp.js';
import { siteUrlError, normaliseSiteUrl } from '../src/site-url.js';

const url = new URL('https://example.com/admin/pages/1');
const req = (method, origin) => new Request(url, { method, headers: origin === undefined ? {} : { Origin: origin } });

test('a POST from this site, or with no Origin, is allowed', () => {
  assert.equal(crossSiteRequest(req('POST', 'https://example.com'), url), false);
  assert.equal(crossSiteRequest(req('POST'), url), false);
  assert.equal(crossSiteRequest(req('GET', 'https://evil.example'), url), false);
});

test('a POST from another app on the same domain, another site, null or garbage is refused', () => {
  for (const o of ['https://other-app.example.com', 'https://evil.example', 'null', 'not a url', 'http://example.com:8080']) {
    assert.equal(crossSiteRequest(req('POST', o), url), true, o);
  }
});

test('every response gets the security headers, and keeps its own', async () => {
  const res = withSecurityHeaders(new Response('x', { headers: { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'none'" } }), url);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Strict-Transport-Security'), 'max-age=63072000; includeSubDomains');
  assert.equal(res.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.equal(withSecurityHeaders(new Response('x'), url).headers.get('X-Frame-Options'), 'DENY');
});

test('only the print routes may be framed, and only by this site', () => {
  const print = new URL('https://example.com/admin/articles/7/print');
  assert.equal(withSecurityHeaders(new Response('x'), print).headers.get('X-Frame-Options'), 'SAMEORIGIN');
});

test('the site URL rule', () => {
  for (const ok of ['', 'https://example.com', 'https://blog.example.com:8443', 'http://localhost:8799', 'http://127.0.0.1:8787', 'http://dev.localhost']) {
    assert.equal(siteUrlError(ok), null, ok);
  }
  for (const bad of ['http://example.com', 'https://example.com/', 'https://example.com/path', 'https://a.b?x=1', 'javascript:alert(1)', 'example.com', 'http://192.168.1.2']) {
    assert.notEqual(siteUrlError(bad), null, bad);
  }
  assert.equal(normaliseSiteUrl('  https://example.com/// '), 'https://example.com');
});
