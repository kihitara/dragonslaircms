import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCommentHtml } from '../src/sanitize.js';

test('keeps the allowed formatting and rebuilds it', () => {
  assert.equal(sanitizeCommentHtml('<p>Hi <b>there</b></p>'), '<p>Hi <strong>there</strong></p>');
  assert.equal(sanitizeCommentHtml('<ul><li>one<li>two</ul>'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(
    sanitizeCommentHtml('<img class="rt-emoticon" src="/media/emoticons/smile.png" alt="smile">'),
    '<img src="/media/emoticons/smile.png" alt="smile" class="rt-emoticon">',
  );
});

test('drops scripts, handlers, links and other images', () => {
  assert.equal(sanitizeCommentHtml('<p onclick=alert(1)>x</p>'), '<p>x</p>');
  assert.equal(sanitizeCommentHtml('<script>alert(1)</script>'), 'alert(1)');
  assert.equal(sanitizeCommentHtml('<a href="javascript:x">y</a>'), 'y');
  assert.equal(sanitizeCommentHtml('<img src=x onerror=alert(1)>'), '');
  assert.equal(sanitizeCommentHtml('<img class="rt-emoticon" src="https://evil.example/x.png">'), '');
});

test('keeps a lone < as text and quoted > inside a tag', () => {
  assert.equal(sanitizeCommentHtml('a < b and <3'), 'a &lt; b and &lt;3');
  assert.equal(sanitizeCommentHtml('<p title="a>b">x</p>'), '<p>x</p>');
});

test('an unclosed tag becomes text and nothing is left open', () => {
  assert.equal(sanitizeCommentHtml('<p>open'), '<p>open</p>');
  assert.equal(sanitizeCommentHtml("<p class='a"), "&lt;p class='a");
});

test('runs in linear time on hostile input', () => {
  // These made the old regex tokeniser quadratic: 0.8 s at 48 KB. The public
  // body cap is 10,000 characters; allow a wide margin for slow machines.
  for (const s of ['<a '.repeat(16000), '<a x="'.repeat(16000), '<a x="\'<'.repeat(7000)]) {
    const t = performance.now();
    sanitizeCommentHtml(s);
    assert.ok(performance.now() - t < 100, `took ${performance.now() - t} ms`);
  }
});
