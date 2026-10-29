import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, stripHeaderBreaks } from '../src/email.js';

test('escapes every value in the HTML body', () => {
  const out = renderTemplate('<p>{{commenter}} wrote: {{comment_body}}</p>', {
    commenter: '<b>Eve</b>',
    comment_body: '<a href="https://evil.example">click</a> & "more"',
  });
  assert.equal(out, '<p>&lt;b&gt;Eve&lt;/b&gt; wrote: &lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt; &amp; &quot;more&quot;</p>');
});

test('a link built by code still works inside href once escaped', () => {
  const out = renderTemplate('<a href="{{link}}">Reset</a>', { link: 'https://example.com/reset?token=abc&x=1' });
  assert.equal(out, '<a href="https://example.com/reset?token=abc&amp;x=1">Reset</a>');
});

test('the subject is plain text and loses CR and LF', () => {
  const subject = renderTemplate('{{site_name}}: new comment', { site_name: 'Tom & Jerry' }, { html: false });
  assert.equal(subject, 'Tom & Jerry: new comment');
  assert.equal(stripHeaderBreaks('Hello\r\nBcc: victim@example.com'), 'Hello Bcc: victim@example.com');
});

test('unknown placeholders stay visible', () => {
  assert.equal(renderTemplate('Hi {{nobody}}', {}), 'Hi {{nobody}}');
});
