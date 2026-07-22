// Server-side sanitiser for UNTRUSTED comment HTML. Cloudflare Workers have no
// DOM, and — more importantly — we never want to "clean" attacker input in
// place. Instead we tokenise the input and REBUILD the output from a strict
// allowlist: every emitted tag is one we construct ourselves, every text run is
// escaped, and every attribute is dropped except a validated emoticon src. A
// crafted <script>, onerror=, javascript: URL, or malformed tag can only ever
// end up as escaped text, never as live markup.
//
// Allowed elements: strong/em (b/i mapped to them), ul/ol/li, blockquote, p, br,
// and <img class="rt-emoticon"> whose src is a same-origin /media/emoticons/ URL.

const ALLOWED = { strong: 1, em: 1, ul: 1, ol: 1, li: 1, blockquote: 1, p: 1, br: 1 };
const TAG_MAP = { b: 'strong', i: 'em' };
const VOID = { br: 1 };
// Emoticon src: same-origin path only, safe filename, image extension. No
// scheme, no '"'/'<'/'>' can pass, so it can't break out of the attribute.
const EMO_SRC = /^\/media\/emoticons\/[a-z0-9._-]+\.(png|jpe?g|gif|webp|svg)$/i;

function escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Read one attribute value out of a raw tag's attribute string.
function readAttr(raw, name) {
  const m = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(raw || '');
  if (!m) return null;
  return m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
}

// Sanitise a rich comment body. Returns safe HTML (may be '' if nothing
// survives). Tags are balanced: stray closes are ignored, and anything left
// open at the end is closed, so a comment can never leak markup into the page.
export function sanitizeCommentHtml(input) {
  const src = String(input == null ? '' : input);
  const out = [];
  const stack = [];
  // Each token is: a tag (attributes may contain quoted '>'), a run of text
  // without '<', or a lone '<' that isn't a tag start (kept as literal text so
  // "a < b" and "<3" survive rather than vanishing).
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[4] != null) { out.push(escText(m[4])); continue; }
    if (m[5] != null) { out.push('&lt;'); continue; }
    const closing = m[1] === '/';
    const raw = m[3] || '';
    let name = m[2].toLowerCase();
    if (TAG_MAP[name]) name = TAG_MAP[name];

    if (name === 'img') {
      if (closing) continue;
      const cls = readAttr(raw, 'class') || '';
      const s = readAttr(raw, 'src') || '';
      if (/(^|\s)rt-emoticon(\s|$)/.test(cls) && EMO_SRC.test(s)) {
        const alt = readAttr(raw, 'alt') || '';
        out.push('<img src="' + escAttr(s) + '" alt="' + escAttr(alt) + '" class="rt-emoticon">');
      }
      continue; // any non-emoticon image is dropped
    }
    if (!ALLOWED[name]) continue; // unknown tag: dropped (its text is emitted separately)
    if (VOID[name]) { out.push('<' + name + '>'); continue; }
    if (closing) {
      const idx = stack.lastIndexOf(name);
      if (idx === -1) continue; // stray close
      for (let i = stack.length - 1; i >= idx; i--) out.push('</' + stack[i] + '>');
      stack.splice(idx);
    } else {
      // Auto-close a same-tag parent that can't nest (li in li, p in p) so the
      // rebuilt markup stays well-formed.
      if ((name === 'li' || name === 'p') && stack[stack.length - 1] === name) {
        out.push('</' + name + '>'); stack.pop();
      }
      out.push('<' + name + '>');
      stack.push(name);
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) out.push('</' + stack[i] + '>');

  // Drop empty leaf blocks left by the rebuild (e.g. <p></p>, <blockquote></blockquote>).
  let html = out.join('')
    .replace(/<(p|blockquote|li)>\s*<\/\1>/g, '')
    .replace(/(<br>\s*)+<\/(p|blockquote|li)>/g, '</$2>')
    .trim();
  return html;
}

// Plain text → escaped HTML with line breaks preserved. Used for the anonymous
// (non-rich) comment path so all stored bodies of format 'html' are safe HTML.
export function textToCommentHtml(text) {
  return escText(String(text == null ? '' : text)).replace(/\r?\n/g, '<br>');
}

// HTML comment → plain text, for email notifications and list previews.
export function commentToText(html) {
  return String(html == null ? '' : html)
    .replace(/<\/(p|blockquote|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
