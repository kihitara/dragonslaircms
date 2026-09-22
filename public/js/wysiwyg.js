// DragonslairCMS rich-text editor. No dependencies, no build step: upgrades any
// <textarea data-richtext> into a toolbar + contentEditable surface and mirrors
// the HTML back into the (hidden) textarea, so a plain form POST carries the body.
//
// Output is the small HTML vocabulary the site's .prose styles: h2-h4, p, ul/ol,
// a, blockquote, code/pre, hr, sup/sub, nested lists (indent/outdent), inline
// text-align styles, and <figure><img alt><figcaption> for images. Pasted
// content that looks like Markdown or carries rich formatting opens a choice
// dialog (keep formatting / convert Markdown / plain text) before insertion.
// document.execCommand is deprecated but universally supported and the right fit
// for a no-bundler admin; the HTML source toggle is the escape hatch.
(function () {
  'use strict';
  if (window.WYSIWYG) return;

  var ICONS = {
    link: '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none"><path d="M7.05025 1.53553C8.03344 0.552348 9.36692 0 10.7574 0C13.6528 0 16 2.34721 16 5.24264C16 6.63308 15.4477 7.96656 14.4645 8.94975L12.4142 11L11 9.58579L13.0503 7.53553C13.6584 6.92742 14 6.10264 14 5.24264C14 3.45178 12.5482 2 10.7574 2C9.89736 2 9.07258 2.34163 8.46447 2.94975L6.41421 5L5 3.58579L7.05025 1.53553Z" fill="currentColor"/><path d="M7.53553 13.0503L9.58579 11L11 12.4142L8.94975 14.4645C7.96656 15.4477 6.63308 16 5.24264 16C2.34721 16 0 13.6528 0 10.7574C0 9.36693 0.552347 8.03344 1.53553 7.05025L3.58579 5L5 6.41421L2.94975 8.46447C2.34163 9.07258 2 9.89736 2 10.7574C2 12.5482 3.45178 14 5.24264 14C6.10264 14 6.92742 13.6584 7.53553 13.0503Z" fill="currentColor"/><path d="M5.70711 11.7071L11.7071 5.70711L10.2929 4.29289L4.29289 10.2929L5.70711 11.7071Z" fill="currentColor"/></svg>',
    image: '<svg fill="currentColor" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path d="M30 2.497h-28c-1.099 0-2 0.901-2 2v23.006c0 1.099 0.9 2 2 2h28c1.099 0 2-0.901 2-2v-23.006c0-1.099-0.901-2-2-2zM30 27.503l-28-0v-5.892l8.027-7.779 8.275 8.265c0.341 0.414 0.948 0.361 1.379 0.035l3.652-3.306 6.587 6.762c0.025 0.025 0.053 0.044 0.080 0.065v1.85zM30 22.806l-5.876-6.013c-0.357-0.352-0.915-0.387-1.311-0.086l-3.768 3.282-8.28-8.19c-0.177-0.214-0.432-0.344-0.709-0.363-0.275-0.010-0.547 0.080-0.749 0.27l-7.309 7.112v-14.322h28v18.309zM23 12.504c1.102 0 1.995-0.894 1.995-1.995s-0.892-1.995-1.995-1.995-1.995 0.894-1.995 1.995c0 1.101 0.892 1.995 1.995 1.995z"></path></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    indent: '<svg fill="currentColor" viewBox="0 0 1920 1920" xmlns="http://www.w3.org/2000/svg"><path d="M1920 1518.813v225.882H112.941v-225.882H1920Zm0-451.878v225.995H112.941v-225.995H1920ZM282.376 112.955l529.468 389.421-529.468 389.308V615.317H.023V389.435h282.353v-276.48ZM1920 615.283v225.883H903.53V615.283H1920Zm0-451.877V389.4H903.53V163.406H1920Z" fill-rule="evenodd"/></svg>',
    outdent: '<svg fill="currentColor" viewBox="0 0 1920 1920" xmlns="http://www.w3.org/2000/svg"><path d="M1920 1518.813v225.882H112.941v-225.882H1920Zm0-451.878v225.995H112.941v-225.995H1920ZM515.656 112.955v276.48h274.898v225.882H515.656v276.367L-.034 502.376l515.69-389.421ZM1920 615.283v225.883H903.53V615.283H1920Zm0-451.877V389.4H903.53V163.406H1920Z" fill-rule="evenodd"/></svg>',
    alignLeft: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 18H14M4 14H20M4 10H14M4 6H20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alignCenter: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17 18H7M20 14H4M17 10H7M20 6H4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alignRight: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 18H10M20 14H4M20 10H10M20 6H4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    anchor: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M11 3C11 2.44772 11.4477 2 12 2C12.5523 2 13 2.44772 13 3C13 3.55228 12.5523 4 12 4C11.4477 4 11 3.55228 11 3ZM13 5.82929C14.1652 5.41746 15 4.30622 15 3C15 1.34315 13.6569 0 12 0C10.3431 0 9 1.34315 9 3C9 4.30622 9.83481 5.41746 11 5.82929V8H8C7.44772 8 7 8.44772 7 9C7 9.55228 7.44772 10 8 10H11V20.9381C7.57272 20.5107 4.81871 17.9154 4.15356 14.5678L5.29289 15.7071C5.68342 16.0976 6.31658 16.0976 6.70711 15.7071C7.09763 15.3166 7.09763 14.6834 6.70711 14.2929L3.70711 11.2929C3.42111 11.0069 2.99099 10.9213 2.61732 11.0761C2.24364 11.2309 2 11.5955 2 12V13C2 18.5228 6.47715 23 12 23C17.5228 23 22 18.5228 22 13V12C22 11.5955 21.7564 11.2309 21.3827 11.0761C21.009 10.9213 20.5789 11.0069 20.2929 11.2929L17.2929 14.2929C16.9024 14.6834 16.9024 15.3166 17.2929 15.7071C17.6834 16.0976 18.3166 16.0976 18.7071 15.7071L19.8464 14.5678C19.1813 17.9154 16.4273 20.5107 13 20.9381V10H16C16.5523 10 17 9.55228 17 9C17 8.44772 16.5523 8 16 8H13V5.82929Z" fill="currentColor"/></svg>',
    // assets/emoticons/toolbar-icon.svg (dragon glyph), recoloured to currentColor.
    emoticon: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M29.618 14.609h0c-2.916-0.277-5.098-1.914-5.821-4.221-0.416-1.324-2.062-2.281-3.957-2.861-2.037-5.066-3.416-7.824-9.806-7.101 2.295 1.796 4.134 4.205 5.075 6.415-1.843-0.529-3.573-0.808-5.182-0.877-3.508-0.769-7.443 0.817-8.6 4.557v20.114h13.274c-8.696-3.148-10.981-19.033-1.86-15.998-0.16 0.474-0.322 0.928-0.477 1.347 2.049 5.319 7.099 10.027 10.576 10.495 0.414 0.015 1.056-0.17 1.8-0.522-0.139-0.044-0.273-0.102-0.401-0.176-0.777-0.448-1.166-1.368-1.14-2.434-0.734 0.386-1.511 0.447-2.129 0.090-0.915-0.528-1.21-1.812-0.823-3.14-0.707 0.173-1.381 0.057-1.821-0.383-0.554-0.553-0.595-1.474-0.193-2.368-0.229-0.038-0.434-0.135-0.594-0.295-0.549-0.549-0.36-1.628 0.423-2.41s1.863-0.971 2.413-0.422c0.241 0.241 0.34 0.584 0.309 0.959 0.698-0.164 1.36-0.046 1.795 0.389 0.384 0.383 0.521 0.944 0.435 1.549 0.534-0.141 1.060-0.101 1.504 0.156 0.583 0.336 0.914 0.979 0.978 1.745 0.949-0.632 2.006-0.794 2.824-0.322 0.965 0.557 1.333 1.842 1.048 3.229 1.497-2.081 2.158-4.725 0.351-7.515z"></path></svg>',
    // assets/callouts/toolbar-icon.svg (exclamation in circle), currentColor.
    callout: '<svg viewBox="0 0 1920 1920" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" fill-rule="evenodd" d="M960 0c530.193 0 960 429.807 960 960s-429.807 960-960 960S0 1490.193 0 960 429.807 0 960 0Zm-9.838 1342.685c-84.47 0-153.19 68.721-153.19 153.19 0 84.47 68.72 153.192 153.19 153.192s153.19-68.721 153.19-153.191-68.72-153.19-153.19-153.19ZM1153.658 320H746.667l99.118 898.623h208.755L1153.658 320Z"/></svg>',
  };

  // Per-type callout icons (assets/callouts/*.svg, normalised to currentColor).
  // Embedded inline in the stored markup, so the public page renders callouts
  // with no extra assets or scripts; colour comes from the CSS accent (--co-c).
  var CALLOUT_ICONS = {
    success: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12ZM16.0303 8.96967C16.3232 9.26256 16.3232 9.73744 16.0303 10.0303L11.0303 15.0303C10.7374 15.3232 10.2626 15.3232 9.96967 15.0303L7.96967 13.0303C7.67678 12.7374 7.67678 12.2626 7.96967 11.9697C8.26256 11.6768 8.73744 11.6768 9.03033 11.9697L10.5 13.4393L12.7348 11.2045L14.9697 8.96967C15.2626 8.67678 15.7374 8.67678 16.0303 8.96967Z"/></svg>',
    info: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12ZM12 17.75C12.4142 17.75 12.75 17.4142 12.75 17V11C12.75 10.5858 12.4142 10.25 12 10.25C11.5858 10.25 11.25 10.5858 11.25 11V17C11.25 17.4142 11.5858 17.75 12 17.75ZM12 7C12.5523 7 13 7.44772 13 8C13 8.55228 12.5523 9 12 9C11.4477 9 11 8.55228 11 8C11 7.44772 11.4477 7 12 7Z"/></svg>',
    warning: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M30.555 25.219l-12.519-21.436c-1.044-1.044-2.738-1.044-3.782 0l-12.52 21.436c-1.044 1.043-1.044 2.736 0 3.781h28.82c1.046-1.045 1.046-2.738 0.001-3.781zM14.992 11.478c0-0.829 0.672-1.5 1.5-1.5s1.5 0.671 1.5 1.5v7c0 0.828-0.672 1.5-1.5 1.5s-1.5-0.672-1.5-1.5v-7zM16.501 24.986c-0.828 0-1.5-0.67-1.5-1.5 0-0.828 0.672-1.5 1.5-1.5s1.5 0.672 1.5 1.5c0 0.83-0.672 1.5-1.5 1.5z"/></svg>',
    error: '<svg viewBox="0 0 1200 1200" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M600,0C268.629,0,0,268.629,0,600s268.629,600,600,600s600-268.629,600-600S931.371,0,600,0z M197.314,439.453h805.371v321.094H197.314V439.453z"/></svg>',
  };

  // Callouts are atomic in the editor: contenteditable="false" keeps the caret
  // out so a callout moves/deletes as one unit and clicks reopen its dialog.
  // clean() strips the attribute again, so stored HTML stays presentation-only.
  function lockCallouts(root) {
    Array.prototype.slice.call(root.querySelectorAll('.rt-callout')).forEach(function (el) {
      el.setAttribute('contenteditable', 'false');
    });
  }

  // Galleries are atomic in the editor too: contenteditable="false" so they move/
  // delete as one unit and a click reopens the gallery builder. clean() strips
  // the attribute so stored HTML is the plain public markup.
  function lockGalleries(root) {
    Array.prototype.slice.call(root.querySelectorAll('.gallery[data-gallery]')).forEach(function (el) {
      el.setAttribute('contenteditable', 'false');
    });
  }

  // Emoticon list, fetched ONCE per endpoint per page and shared by every editor
  // instance. Admin editors use /admin/emoticons/list.json (default); comment-
  // mode editors on public/reader pages use the PUBLIC /emoticons.json, which
  // logged-out visitors can reach. Cached per-URL; a failed fetch clears that
  // URL's cache so reopening the picker retries.
  var emoFetch = {};
  function loadEmoticons(endpoint) {
    var url = endpoint || '/admin/emoticons/list.json';
    if (!emoFetch[url]) {
      emoFetch[url] = fetch(url, { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { return { emoticons: (d && d.emoticons) || [], categories: (d && d.categories) || [] }; })
        .catch(function (e) { emoFetch[url] = null; throw e; });
    }
    return emoFetch[url];
  }

  function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  // Named-anchor id: lowercase, non-alphanumerics → hyphens, trimmed — the same
  // shape as slugs elsewhere, so hand-written #links behave predictably.
  function slugAnchor(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  var BLOCK = /^(P|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|HR|FIGURE|IFRAME|TABLE|DIV|SECTION|ARTICLE)$/;

  // Tidy contentEditable's serialization: trim whitespace at each element's text
  // edges, drop whitespace-only nodes between top-level blocks, wrap loose inline
  // content in <p>, drop empty text blocks, one block per line. <pre>/<code> kept.
  function clean(html) {
    var box = document.createElement('div');
    box.innerHTML = html;
    // Callouts are locked (contenteditable=false) while editing — never store that.
    Array.prototype.slice.call(box.querySelectorAll('.rt-callout')).forEach(function (el) {
      el.removeAttribute('contenteditable');
    });
    // Galleries: drop the editor-only contenteditable so stored HTML is public.
    Array.prototype.slice.call(box.querySelectorAll('.gallery[data-gallery]')).forEach(function (el) {
      el.removeAttribute('contenteditable');
    });
    // Selection-bookmark markers are transient; unwrap any that slipped in (e.g.
    // if the editor blurred while a dialog was open) so they never persist.
    Array.prototype.slice.call(box.querySelectorAll('[data-rt-marker]')).forEach(function (m) {
      while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
      m.parentNode.removeChild(m);
    });
    (function walk(node) {
      if (node.tagName === 'PRE' || node.tagName === 'CODE') return;
      Array.prototype.slice.call(node.childNodes).forEach(function (n) { if (n.nodeType === 1) walk(n); });
      if (node.firstChild && node.firstChild.nodeType === 3) node.firstChild.textContent = node.firstChild.textContent.replace(/^[ \t\r\n\f]+/, '');
      if (node.lastChild && node.lastChild.nodeType === 3) node.lastChild.textContent = node.lastChild.textContent.replace(/[ \t\r\n\f]+$/, '');
    })(box);
    Array.prototype.slice.call(box.querySelectorAll('code')).forEach(function (c) {
      if (!c.textContent.replace(/\s/g, '') && c.parentNode) c.parentNode.removeChild(c);
    });
    var DROP_IF_EMPTY = /^(P|H[1-6]|LI|BLOCKQUOTE)$/;
    // anchor — an anchor marker (<a class="rt-anchor">) carries no text but must survive.
    function isEmpty(el) { return !el.textContent.replace(/\s/g, '') && !el.querySelector('img, a.rt-anchor'); }
    var out = [], buf = [];
    function flush() { var h = buf.join('').replace(/^\s+|\s+$/g, ''); buf = []; if (h) out.push('<p>' + h + '</p>'); }
    Array.prototype.slice.call(box.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && BLOCK.test(n.tagName)) {
        flush();
        if (!(DROP_IF_EMPTY.test(n.tagName) && isEmpty(n))) out.push(n.outerHTML);
      } else if (n.nodeType === 1) {
        buf.push(n.outerHTML);
      } else if (n.nodeType === 3) {
        buf.push(escHtml(n.textContent));
      }
    });
    flush();
    return out.join('\n');
  }

  // Sanitise pasted rich HTML (Word / web): allow-list of semantic tags + attrs,
  // b/i/strike mapped to strong/em/s, headings clamped to h2-h4, scripts/styles/
  // comments/tables dropped, inline styles and classes stripped, unsafe URLs cut.
  function sanitizeRich(html) {
    var ALLOW = { P: ['class'], H2: [], H3: [], H4: [], STRONG: [], EM: [], U: [], S: [], SUB: [], SUP: [], A: ['href'], UL: [], OL: [], LI: ['class'], BLOCKQUOTE: [], BR: [], HR: [], CODE: [], PRE: [], IMG: ['src', 'alt', 'class'], FIGURE: [], FIGCAPTION: [] };
    // Editor styling classes worth preserving on in-editor copy/paste; every
    // other class token is dropped (external pastes never inject styling hooks).
    var KEEP_CLASS = { 'rt-lg': 1, 'rt-sm': 1, 'rt-emoticon': 1 };
    var MAP = { B: 'STRONG', I: 'EM', STRIKE: 'S', DEL: 'S', H1: 'H2', H5: 'H4', H6: 'H4' };
    var DROP = { SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, TITLE: 1, HEAD: 1, NOSCRIPT: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, SVG: 1, FORM: 1, INPUT: 1, BUTTON: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1, CAPTION: 1, COL: 1, COLGROUP: 1 };
    function safeUrl(u) { u = String(u || '').trim(); return /^(https?:|mailto:|tel:|\/|#)/i.test(u) ? u : ''; }
    function unwrap(el) { var p = el.parentNode; if (!p) return; while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el); }
    var tmp = document.createElement('div');
    tmp.innerHTML = String(html == null ? '' : html);
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 8) { node.removeChild(child); return; }
        if (child.nodeType !== 1) return;
        var tag = child.tagName.toUpperCase();
        if (DROP[tag]) { node.removeChild(child); return; }
        walk(child);
        var mapped = MAP[tag] || tag;
        if (!ALLOW[mapped]) { unwrap(child); return; }
        if (mapped !== tag) {
          var rep = document.createElement(mapped);
          while (child.firstChild) rep.appendChild(child.firstChild);
          node.replaceChild(rep, child); child = rep;
        }
        var allowed = ALLOW[mapped];
        Array.prototype.slice.call(child.attributes).forEach(function (a) {
          var n = a.name.toLowerCase();
          if (allowed.indexOf(n) < 0) { child.removeAttribute(a.name); return; }
          if (n === 'href') { var h = safeUrl(a.value); h ? child.setAttribute('href', h) : child.removeAttribute('href'); }
          else if (n === 'src') { if (!safeUrl(a.value)) node.removeChild(child); } // drop data:/unsafe images
          else if (n === 'class') { var kept = a.value.split(/\s+/).filter(function (c) { return KEEP_CLASS[c]; }); kept.length ? child.setAttribute('class', kept.join(' ')) : child.removeAttribute('class'); }
        });
      });
    })(tmp);
    // Collapse whitespace runs except inside <pre>/<code> — renders the same, but
    // keeps the source one line per paragraph instead of mid-sentence breaks.
    (function normalize(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (c) {
        if (c.nodeType === 3) c.textContent = c.textContent.replace(/\s+/g, ' ');
        else if (c.nodeType === 1 && c.tagName !== 'PRE' && c.tagName !== 'CODE') normalize(c);
      });
    })(tmp);
    Array.prototype.slice.call(tmp.querySelectorAll('p, h2, h3, h4, strong, em, u, s, sub, sup, a, li, blockquote')).forEach(function (el) {
      if (!el.textContent.replace(/\s/g, '') && !el.querySelector('img')) el.remove();
    });
    return clean(tmp.innerHTML);
  }

  // Plain text → paragraph HTML. Blank lines separate paragraphs (single newlines
  // within one are soft-wraps → collapsed); with no blank lines, every line is its
  // own paragraph. Beats the browser default of <br>-separated text with no <p>.
  function textToBlocks(text) {
    text = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    if (!text) return '';
    var hasBlank = /\n[ \t]*\n/.test(text);
    var parts = hasBlank ? text.split(/\n[ \t]*\n/) : text.split(/\n/);
    return parts.map(function (p) {
      if (hasBlank) p = p.replace(/\s*\n\s*/g, ' ');
      p = p.replace(/^\s+|\s+$/g, '');
      return p ? '<p>' + escHtml(p) + '</p>' : '';
    }).filter(Boolean).join('');
  }

  // ---- Markdown paste conversion ----

  function safeUrl(u) { u = String(u || '').trim(); return /^(https?:|mailto:|tel:|\/|#)/i.test(u) ? u : ''; }

  // Inline Markdown → HTML. Code / images / links are stashed before emphasis so
  // their contents (and URLs) aren't mangled, then restored. Headings and other
  // block constructs are handled by mdToHtml; this is the text within a block.
  function mdInline(s) {
    s = String(s == null ? '' : s);
    var slots = [];
    function stash(html) { slots.push(html); return '\x01' + (slots.length - 1) + '\x01'; }
    s = s.replace(/`([^`]+)`/g, function (m, c) { return stash('<code>' + escHtml(c) + '</code>'); });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, alt, url) {
      return safeUrl(url) ? stash('<img src="' + escAttr(url) + '" alt="' + escAttr(alt) + '">') : m;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, txt, url) {
      return safeUrl(url) ? stash('<a href="' + escAttr(url) + '">' + escHtml(txt) + '</a>') : m;
    });
    s = escHtml(s); // escape the remaining plain text (placeholders are control chars, untouched)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // _italic_ — only at word boundaries, so snake_case / file_name aren't mangled.
    s = s.replace(/(^|[^A-Za-z0-9_])_(?=\S)([^_]+?)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>');
    return s.replace(/\x01(\d+)\x01/g, function (m, i) { return slots[+i]; });
  }

  // Block-level Markdown → HTML. Common subset: fenced code, ATX headings (mapped
  // to h2-h4 so body content never emits an h1), hr, blockquotes, bullet/ordered
  // lists, and paragraphs. Not a full CommonMark implementation.
  function mdToHtml(src) {
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var fences = [];
    text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, function (m, code) { fences.push(code.replace(/\n+$/, '')); return '\x02' + (fences.length - 1) + '\x02'; });
    var lines = text.split('\n');
    var rt = function (s) { return s.replace(/\s+$/, ''); };          // right-trim
    var isUl = function (s) { return /^[-*+]\s+/.test(s); };
    var isOl = function (s) { return /^\d+\.\s+/.test(s); };
    var special = function (s) { return /^(#{1,6})\s+/.test(s) || /^>\s?/.test(s) || isUl(s) || isOl(s) || /^(\*{3,}|-{3,}|_{3,})\s*$/.test(s) || /^\x02\d+\x02$/.test(s); };
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var ln = rt(lines[i]);
      if (!ln.trim()) { i++; continue; }                              // blank
      var fm = ln.match(/^\x02(\d+)\x02$/);
      if (fm) { out.push('<pre><code>' + escHtml(fences[+fm[1]]) + '</code></pre>'); i++; continue; }
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(ln)) { out.push('<hr>'); i++; continue; }
      var hm = ln.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { var lv = Math.min(4, Math.max(2, hm[1].length + 1)); out.push('<h' + lv + '>' + mdInline(hm[2].replace(/\s+#+\s*$/, '')) + '</h' + lv + '>'); i++; continue; }
      if (/^>\s?/.test(ln)) {                                         // blockquote: consume consecutive > lines
        var q = [];
        while (i < lines.length && /^>\s?/.test(rt(lines[i]))) { q.push(rt(lines[i]).replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + mdInline(q.join(' ')) + '</blockquote>');
        continue;
      }
      if (isUl(ln) || isOl(ln)) {                                     // list: group items, handle wraps + blank-line-separated items
        var ordered = isOl(ln), items = [];
        while (i < lines.length) {
          var l = rt(lines[i]);
          var m = ordered ? l.match(/^\d+\.\s+(.*)$/) : l.match(/^[-*+]\s+(.*)$/);
          if (m) { items.push(m[1]); i++; }                           // new item
          else if (!l.trim()) {                                       // blank: keep the list only if the next non-blank line is another same-type item
            var j = i + 1; while (j < lines.length && !rt(lines[j]).trim()) j++;
            var next = j < lines.length ? rt(lines[j]) : '';
            if (items.length && (ordered ? isOl(next) : isUl(next))) { i = j; } else break;
          }
          else if (items.length && (ordered ? isUl(l) : isOl(l))) break; // the other list type → end this list
          else if (items.length) { items[items.length - 1] += ' ' + l.trim(); i++; } // wrapped / continuation line
          else break;
        }
        var tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.map(function (it) { return '<li>' + mdInline(it) + '</li>'; }).join('') + '</' + tag + '>');
        continue;
      }
      var para = [];                                                  // paragraph: consecutive non-blank, non-special lines
      while (i < lines.length) { var p = rt(lines[i]); if (!p.trim() || special(p)) break; para.push(p); i++; }
      out.push('<p>' + mdInline(para.join(' ')) + '</p>');
    }
    return out.filter(Boolean).join('\n');
  }

  // Cheap Markdown sniff for pasted text: headings, fenced code, lists,
  // blockquotes, **bold** or [links](…) anywhere in the paste.
  function looksLikeMarkdown(text) {
    var t = String(text == null ? '' : text);
    if (!t) return false;
    return /(^|\n)#{1,6}\s+\S/.test(t)
      || /(^|\n)```/.test(t)
      || /(^|\n)\s{0,3}[-*+]\s+\S/.test(t)
      || /(^|\n)\s{0,3}\d+\.\s+\S/.test(t)
      || /(^|\n)>\s?\S/.test(t)
      || /\*\*[^*\n]+\*\*/.test(t)
      || /\[[^\]]+\]\([^)\s]+\)/.test(t);
  }

  // Does sanitised clipboard HTML carry real formatting (not just plain
  // paragraphs)? Decides whether a paste warrants the choice dialog.
  function hasRichMarkup(html) {
    return /<(h[2-4]|ul|ol|li|blockquote|pre|code|strong|em|u|s|sub|sup|a|img|figure|hr)\b/i.test(String(html == null ? '' : html));
  }

  // Wrap loose top-level text / inline nodes in <p> so the editor always edits
  // real paragraphs, and seed an empty editor with a paragraph to type into.
  // Run on load / when content is set — never per keystroke.
  function ensureBlocks(ed) {
    var buf = [];
    function flush(before) {
      if (!buf.length) return;
      var meaningful = buf.some(function (n) { return (n.nodeType === 3 && n.textContent.replace(/\s/g, '')) || n.nodeType === 1; });
      if (meaningful) { var p = document.createElement('p'); buf.forEach(function (n) { p.appendChild(n); }); ed.insertBefore(p, before || null); }
      else { buf.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); }); }
      buf = [];
    }
    Array.prototype.slice.call(ed.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && BLOCK.test(n.tagName)) flush(n);
      else buf.push(n);
    });
    flush(null);
    if (!ed.firstChild) ed.innerHTML = '<p><br></p>';
  }

  function upgrade(ta) {
    if (!ta || ta.getAttribute('data-rt-done')) return;
    ta.setAttribute('data-rt-done', '1');

    // Reduced "comment" mode (logged-in readers / staff replies): a small
    // toolbar (bold/italic/lists/blockquote/emoticon) and the PUBLIC emoticon
    // endpoint, since these editors render on logged-out/reader pages.
    var mode = ta.getAttribute('data-rt-mode') || '';
    var emoEndpoint = mode === 'comment' ? '/emoticons.json' : '/admin/emoticons/list.json';
    // Galleries are opt-in per editor (article body only). The site default
    // layout presets the builder; each gallery can still be switched.
    var galleryEnabled = ta.hasAttribute('data-gallery');
    var galleryDefault = ta.getAttribute('data-gallery-default') === 'carousel' ? 'carousel' : 'grid';

    var wrap = document.createElement('div'); wrap.className = 'rt';
    var bar = document.createElement('div'); bar.className = 'rt-bar';
    var ed = document.createElement('div'); ed.className = 'rt-ed'; ed.setAttribute('contenteditable', 'true');
    ed.innerHTML = ta.value || '';
    ensureBlocks(ed);
    lockCallouts(ed);
    lockGalleries(ed);

    ta.parentNode.insertBefore(wrap, ta);
    wrap.appendChild(bar); wrap.appendChild(ed); wrap.appendChild(ta);
    ta.style.display = 'none';

    // Toolbar clicks steal focus, so remember the selection to act on.
    var savedRange = null;
    // Freeze a clone (not the live range) so a later selection change — e.g. a
    // tap collapsing the caret — can't mutate what we saved. While a dialog is
    // open we STOP updating savedRange: each dialog captures the selection when
    // it opens, and on touch, tapping the URL field / Insert button bounces a
    // collapsed caret back into the editor (a selectionchange) that would
    // otherwise clobber it — the reason modal inserts landed at the start.
    function saveSel() { if (dlg) return; var s = window.getSelection(); if (s && s.rangeCount && ed.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); }
    function restoreSel() { ed.focus(); if (savedRange) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); } }
    ed.addEventListener('keyup', saveSel);
    ed.addEventListener('mouseup', saveSel);
    ed.addEventListener('focus', saveSel);
    // Touch: selecting text via the native handles fires neither mouseup nor
    // keyup — only selectionchange. Without this, savedRange stays stale/empty
    // and the toolbar acts on the wrong spot (e.g. a link dropped at the start
    // instead of wrapping the highlight). Guarded to in-editor selections, so
    // dialog inputs and the page never overwrite it.
    document.addEventListener('selectionchange', saveSel);
    // Belt to that: grab the selection the instant the toolbar is pressed, in
    // the capture phase — before the tap itself can move or collapse it.
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (evt) {
      bar.addEventListener(evt, saveSel, true);
    });

    function sync() { ta.value = clean(ed.innerHTML); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    // Skip sync while a dialog is open (same reason as blur): the paste-choice
    // dialog leaves focus on the editor, so typing then would serialize a
    // marker-stripped ta.value before the paste is confirmed. Dialog exits sync.
    ed.addEventListener('input', function () { if (!dlg) sync(); });
    // Skip sync while a dialog is open: its field stealing focus fires blur, but
    // the live editor still holds the marker — syncing now would write a
    // marker-stripped copy that diverges from the screen. Every dialog exit syncs.
    ed.addEventListener('blur', function () { if (!dlg) sync(); });

    // Pastes never carry Word/web junk in: clipboard HTML goes through the
    // sanitiser, plain text becomes real <p> paragraphs. When the paste carries
    // real formatting or looks like Markdown, a choice dialog asks how to
    // insert it (keep formatting / convert Markdown / plain text).
    ed.addEventListener('paste', function (e) {
      var cd = e.clipboardData; if (!cd || !cd.getData) return;
      // Pasting into the editor abandons any open insert dialog: close it and unwind
      // its bookmark FIRST — saveSel() no-ops while a dialog is open, so leaving it
      // open would freeze the caret at the dialog's position instead of the paste
      // point, and the dialog's marker would be orphaned in the live editor.
      if (dlg) { closeDlg(); clearMarker(true); }
      var rich = cd.getData('text/html');
      var text = cd.getData('text/plain');
      var richHtml = rich ? sanitizeRich(rich) : '';
      var isRich = !!richHtml && hasRichMarkup(richHtml);
      var isMd = !!text && looksLikeMarkdown(text);
      if (isRich || isMd) { e.preventDefault(); saveSel(); doPasteChoice(richHtml, isRich, text, isMd); return; }
      if (richHtml) { e.preventDefault(); saveSel(); insert(richHtml); return; } // plain-looking HTML → cleaned paragraphs
      // No usable text. If the clipboard DID carry html, everything sanitised away
      // (e.g. a bare table) — swallow the paste rather than let the browser's default
      // insert the raw markup. Only a paste with neither html nor text (e.g. an image
      // file) falls through to the browser.
      if (!text) { if (rich) e.preventDefault(); return; }
      e.preventDefault(); saveSel(); insert(textToBlocks(text));
    });

    // Click an inserted image / link → reopen its settings. Images open on any
    // click; links only on a collapsed click so selecting their text isn't hijacked.
    // Emoticons (img.rt-emoticon) are checked first so the image dialog never
    // grabs them — clicking one reopens the picker to replace it in place.
    ed.addEventListener('click', function (e) {
      var t = e.target; if (!t || !t.closest) return;
      // Galleries first: they contain imgs/links that the image/link handlers
      // below would otherwise grab. Clicking one reopens the gallery builder.
      var gal = t.closest('.gallery[data-gallery]');
      if (gal && ed.contains(gal)) { e.preventDefault(); doGallery(gal); return; }
      // Callouts next: they contain an svg/img icon (and, for "other", an
      // img.rt-emoticon), so this must win before the emoticon/image handlers.
      var co = t.closest('.rt-callout');
      if (co && ed.contains(co)) { e.preventDefault(); doCallout(co); return; }
      var emo = t.closest('img.rt-emoticon');
      if (emo && ed.contains(emo)) { e.preventDefault(); doEmoticon(emo); return; }
      var fig = t.closest('figure');
      if (fig && ed.contains(fig) && fig.querySelector('img')) { e.preventDefault(); doImage(fig); return; }
      var img = t.closest('img');
      if (img && ed.contains(img)) { e.preventDefault(); doImage(img); return; }
      var s = window.getSelection();
      if (!s || !s.isCollapsed) return;
      var an = t.closest('a.rt-anchor');
      if (an && ed.contains(an)) { e.preventDefault(); doAnchor(an); return; }
      var a = t.closest('a');
      if (a && ed.contains(a)) { e.preventDefault(); doLink(a); }
    });

    try { document.execCommand('defaultParagraphSeparator', false, 'p'); document.execCommand('styleWithCSS', false, false); } catch (e) { /* older engines */ }

    function exec(cmd, val) { restoreSel(); try { document.execCommand(cmd, false, val == null ? null : val); } catch (e) { /* unsupported command */ } ed.focus(); saveSel(); sync(); }
    function insert(html) { restoreSel(); try { document.execCommand('insertHTML', false, html); } catch (e) { /* unsupported */ } ed.focus(); saveSel(); sync(); }

    // ---- selection bookmark (marker) for dialog-driven inserts ----
    // A dialog's text input takes focus; on touch, iOS then won't hand the
    // selection back to the contenteditable, so execCommand/insert would run at
    // position 0. So when a dialog opens we drop a marker node at the selection
    // and, on confirm, do pure DOM insertion at that marker — no focus/selection
    // restore needed. clean() strips any stray marker, so it never persists.
    var insMarker = null;
    // collapse=true → a point marker at the selection start (preserves any
    // selected text, for inserts like image/anchor/emoticon). Otherwise the
    // marker WRAPS the selection (for wrapping a link around it).
    function placeMarker(collapse) {
      // unwrap(true): a leftover marker from an abandoned dialog may WRAP selected
      // text — dropping it (false) would delete that text from the document.
      clearMarker(true);
      var range = savedRange;
      if (!range) { insMarker = null; return; }
      if (collapse) { range = range.cloneRange(); range.collapse(true); }
      var m = document.createElement('span'); m.setAttribute('data-rt-marker', '1');
      try {
        if (range.collapsed) { range.insertNode(m); }
        else { m.appendChild(range.extractContents()); range.insertNode(m); }
        insMarker = m;
      } catch (e) { insMarker = null; }
    }
    // unwrap=true restores the wrapped selection (cancel); false just drops it.
    function clearMarker(unwrap) {
      if (!insMarker) return;
      var m = insMarker; insMarker = null;
      if (!m.parentNode) return;
      if (unwrap && m.childNodes.length) {
        var frag = document.createDocumentFragment();
        while (m.firstChild) frag.appendChild(m.firstChild);
        m.parentNode.replaceChild(frag, m);
      } else { m.parentNode.removeChild(m); }
      if (ed.normalize) ed.normalize();
    }
    // Direct child of ed that contains the marker (its top-level block).
    function topBlock(n) { while (n && n.parentNode && n.parentNode !== ed) n = n.parentNode; return (n && n.parentNode === ed) ? n : null; }
    function caretAfter(node) {
      if (!node) return;
      try {
        var r = document.createRange();
        if (node.nodeType === 1) r.setStartAfter(node); else r.setStart(node, node.length || 0);
        r.collapse(true); savedRange = r.cloneRange();
      } catch (e) { /* range may be detached */ }
    }
    function finishInsert() {
      lockCallouts(ed);
      // Best-effort caret placement after the insert. If the browser can't
      // (e.g. iOS just after a dialog), the content is already in place — no harm.
      if (savedRange) { try { ed.focus(); var s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); } catch (e) { /* ignore */ } }
      sync();
    }
    var BLOCK_TAG = /^(FIGURE|DIV|P|H[1-6]|UL|OL|BLOCKQUOTE|PRE|HR|TABLE)$/;
    // Insert html at the marker: inline content replaces the marker in place;
    // block content splits the marker's paragraph and sits between the halves
    // (matching what execCommand('insertHTML') used to do on desktop).
    function insertHtml(html) {
      if (!insMarker || !insMarker.parentNode) { insMarker = null; insert(html); return; } // no/detached marker → desktop fallback
      var tmp = document.createElement('div'); tmp.innerHTML = html;
      var isBlock = tmp.firstChild && tmp.firstChild.nodeType === 1 && BLOCK_TAG.test(tmp.firstChild.tagName);
      if (!isBlock) {
        var parent = insMarker.parentNode;
        var frag = document.createDocumentFragment(); var last = null;
        while (tmp.firstChild) last = frag.appendChild(tmp.firstChild);
        parent.replaceChild(frag, insMarker); insMarker = null;
        caretAfter(last);
      } else {
        var block = topBlock(insMarker);
        var nodes = Array.prototype.slice.call(tmp.childNodes);
        if (!block) {
          nodes.forEach(function (n) { ed.appendChild(n); });
          if (insMarker.parentNode) insMarker.parentNode.removeChild(insMarker); insMarker = null;
        } else {
          var tail = document.createElement(block.tagName.toLowerCase());
          if (block.className) tail.className = block.className;
          var sib = insMarker.nextSibling;
          while (sib) { var next = sib.nextSibling; tail.appendChild(sib); sib = next; }
          if (insMarker.parentNode) insMarker.parentNode.removeChild(insMarker);
          insMarker = null;
          var ref = block.nextSibling;
          nodes.forEach(function (n) { ed.insertBefore(n, ref); });
          // a.rt-anchor counts as content (like in clean()) — a block/tail holding
          // only a named anchor must survive, or the in-page target vanishes.
          if (tail.textContent.trim() || tail.querySelector('img, figure, br, a.rt-anchor')) ed.insertBefore(tail, ref);
          if (!block.textContent.trim() && !block.querySelector('img, figure, a.rt-anchor')) block.parentNode.removeChild(block);
        }
        caretAfter(nodes[nodes.length - 1]);
      }
      finishInsert();
    }
    // Replace the marker with a new element wrapping the marker's contents
    // (used for links over a selection: <a href>…selected text…</a>).
    function wrapMarkerWith(tag, attrs) {
      // No / detached marker (placement failed, or the editor was rebuilt) →
      // desktop fallback via the saved selection, like insertHtml falls back to
      // insert() — never a silent no-op or a throw on a stale parentNode.
      if (!insMarker || !insMarker.parentNode) {
        insMarker = null;
        if (tag === 'a' && attrs && attrs.href) exec('createLink', attrs.href);
        return;
      }
      var el = document.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) el.setAttribute(k, attrs[k]); });
      if (insMarker.childNodes.length) { while (insMarker.firstChild) el.appendChild(insMarker.firstChild); }
      else { el.textContent = (attrs && attrs.href) || ''; }
      insMarker.parentNode.replaceChild(el, insMarker); insMarker = null;
      caretAfter(el); finishInsert();
    }

    // ---- per-block text size (paragraphs & list items) ----
    // rt-sm / rt-lg classes on p/li; clean() serialises blocks via outerHTML so
    // the classes round-trip. The same classes are styled publicly in site.css.
    function blockOf(node) {
      while (node && node !== ed) { if (node.nodeType === 1 && (node.tagName === 'P' || node.tagName === 'LI')) return node; node = node.parentNode; }
      return null;
    }
    function selectedBlocks() {
      var s = window.getSelection();
      if (!s || !s.rangeCount) return [];
      var r = s.getRangeAt(0);
      if (r.collapsed) { var b = blockOf(s.anchorNode); return b ? [b] : []; }
      var out = [];
      Array.prototype.forEach.call(ed.querySelectorAll('p, li'), function (el) { if (r.intersectsNode(el)) out.push(el); });
      if (!out.length) { var b2 = blockOf(s.anchorNode); if (b2) out.push(b2); }
      return out;
    }
    // Set/clear an rt-lg | rt-sm size class on each paragraph/list-item the
    // selection touches ('' = Normal → class removed).
    function applySize(cls) {
      restoreSel();
      selectedBlocks().forEach(function (el) {
        el.classList.remove('rt-lg', 'rt-sm');
        if (cls) el.classList.add(cls);
        if (!el.classList.length) el.removeAttribute('class'); // no empty class=""
      });
      ed.focus(); saveSel(); sync();
    }

    // ---- inline dialog (link / image) ----
    var dlg = null;
    function closeDlg() { if (dlg) { dlg.remove(); dlg = null; } }
    function openDlg(fields, onInsert, opts) {
      opts = opts || {};
      saveSel(); closeDlg();
      // For "insert new" flows, bookmark the selection with a marker now, before
      // the input steals focus — the insert then happens at the marker, not via
      // an unreliable selection restore. Editing an existing element sets no mark.
      if (opts.mark) placeMarker(opts.mark === 'caret');
      dlg = document.createElement('div'); dlg.className = 'rt-dlg';
      var inputs = {};
      fields.forEach(function (f) {
        var row = document.createElement('div'); row.className = 'rt-dlg-row';
        var sp = document.createElement('span'); sp.textContent = f.label; row.appendChild(sp);
        var inp = document.createElement('input'); inp.type = 'text';
        if (f.value) inp.value = f.value;
        if (f.placeholder) inp.placeholder = f.placeholder;
        inputs[f.key] = inp; row.appendChild(inp); dlg.appendChild(row);
        if (f.media && window.MEDIA) window.MEDIA.attach(inp); // Browse… button → media library picker
      });
      var act = document.createElement('div'); act.className = 'rt-dlg-actions';
      var ins = document.createElement('button'); ins.type = 'button'; ins.className = 'rt-dlg-ins'; ins.textContent = opts.okLabel || 'Insert';
      var can = document.createElement('button'); can.type = 'button'; can.className = 'rt-dlg-can'; can.textContent = 'Cancel';
      ins.addEventListener('click', function () {
        var vals = {};
        Object.keys(inputs).forEach(function (k) {
          vals[k] = inputs[k].value.trim();
          // The media picker stashes a responsive-variant manifest on the input;
          // surface it as "<key>Meta" so the image dialog can build a srcset.
          if (inputs[k].__mediaMeta) vals[k + 'Meta'] = inputs[k].__mediaMeta;
        });
        closeDlg(); onInsert(vals);
      });
      can.addEventListener('click', function () { closeDlg(); clearMarker(true); sync(); restoreSel(); });
      act.appendChild(ins); act.appendChild(can);
      if (opts.onRemove) {
        var rem = document.createElement('button'); rem.type = 'button'; rem.className = 'rt-dlg-rem'; rem.textContent = opts.removeLabel || 'Remove';
        rem.addEventListener('click', function () { closeDlg(); clearMarker(true); opts.onRemove(); });
        act.appendChild(rem);
      }
      dlg.appendChild(act);
      wrap.appendChild(dlg);
      var first = fields[0]; if (first) inputs[first.key].focus();
    }

    function inEd(node, test) { while (node && node !== ed) { if (node.nodeType === 1 && test(node)) return node; node = node.parentNode; } return null; }
    function selNode() { var s = window.getSelection(); return s && s.rangeCount ? s.anchorNode : null; }
    function unwrapEl(el) { var p = el.parentNode; if (!p) return; while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el); if (p.normalize) p.normalize(); ed.focus(); saveSel(); sync(); }

    // A hyperlink to edit — excludes named-anchor markers (rt-anchor), so the
    // Insert-link tool never grabs/unwraps an anchor target.
    function linkOf(n) { return inEd(n, function (el) { return el.tagName === 'A' && !(el.classList && el.classList.contains('rt-anchor')); }); }
    function anchorOf(n) { return inEd(n, function (el) { return el.tagName === 'A' && el.classList && el.classList.contains('rt-anchor'); }); }

    // link: an existing <a> to edit (from a click), else derived from the selection;
    // none → insert a new link. Editing offers Save + Remove link (unlink).
    function doLink(link) {
      if (!link) link = linkOf(selNode());
      if (link) {
        openDlg([
          { key: 'text', label: 'Text', value: link.textContent },
          { key: 'href', label: 'Link URL', placeholder: 'https://…', value: link.getAttribute('href') || '' },
        ], function (v) {
          if (!v.href) { restoreSel(); return; }
          link.setAttribute('href', v.href);
          if (v.text && v.text !== link.textContent) link.textContent = v.text;
          ed.focus(); saveSel(); sync();
        }, { okLabel: 'Save', removeLabel: 'Remove link', onRemove: function () { unwrapEl(link); } });
        return;
      }
      var txt = savedRange ? savedRange.toString() : '';
      if (txt) openDlg([{ key: 'href', label: 'Link URL', placeholder: 'https://…' }],
        function (v) { if (v.href) wrapMarkerWith('a', { href: v.href }); else { clearMarker(true); sync(); } },
        { mark: true });
      else openDlg([{ key: 'text', label: 'Text' }, { key: 'href', label: 'Link URL', placeholder: 'https://…' }],
        function (v) { if (v.href) insertHtml('<a href="' + escAttr(v.href) + '">' + escHtml(v.text || v.href) + '</a>'); else { clearMarker(true); sync(); } },
        { mark: 'caret' });
    }

    // anchor: a named in-page target — an empty <a id="…" class="rt-anchor"> (no href)
    // you link to with #name. It stays constant even if a nearby heading's text changes.
    // Editing offers Save + Remove; the name is slugified (lowercase, numbers, hyphens).
    function doAnchor(anchor) {
      if (!anchor) anchor = anchorOf(selNode());
      openDlg([
        { key: 'name', label: 'Anchor name', placeholder: 'e.g. pricing-section', value: anchor ? (anchor.getAttribute('id') || '') : '' },
      ], function (v) {
        var name = slugAnchor(v.name);
        if (!name) { clearMarker(true); sync(); restoreSel(); return; }
        if (anchor) { anchor.setAttribute('id', name); ed.focus(); saveSel(); sync(); }
        else insertHtml('<a id="' + escAttr(name) + '" class="rt-anchor"></a>');
      }, anchor ? { okLabel: 'Save', removeLabel: 'Remove anchor', onRemove: function () { if (anchor.parentNode) { anchor.parentNode.removeChild(anchor); ed.focus(); saveSel(); sync(); } } } : { mark: 'caret' });
    }

    // image by URL: target is an existing <figure>/<img> to edit (from a click).
    function doImage(target) {
      var figure = target && target.tagName === 'FIGURE' ? target : null;
      var img = figure ? figure.querySelector('img') : (target && target.tagName === 'IMG' ? target : null);
      var capEl = figure ? figure.querySelector('figcaption') : null;
      openDlg([
        { key: 'src', label: 'Image URL', placeholder: 'https://… or /media/…', media: true, value: img ? (img.getAttribute('src') || '') : '' },
        { key: 'alt', label: 'Alt text', value: img ? (img.getAttribute('alt') || '') : '' },
        { key: 'caption', label: 'Caption', value: capEl ? capEl.textContent : '' },
      ], function (v) {
        if (!v.src) { clearMarker(true); sync(); return; }
        var attrs = 'src="' + escAttr(v.src) + '" alt="' + escAttr(v.alt) + '" loading="lazy"';
        // Responsive srcset when the picker uploaded variants for this exact URL.
        var meta = v.srcMeta;
        if (meta && meta.src === v.src && meta.variants && meta.variants.length > 1) {
          var srcset = meta.variants.map(function (x) { return escAttr(x.url) + ' ' + x.w + 'w'; }).join(', ');
          attrs += ' srcset="' + srcset + '" sizes="(max-width: 760px) 100vw, 720px"';
          if (meta.width && meta.height) attrs += ' width="' + meta.width + '" height="' + meta.height + '"';
        }
        var html = '<figure><img ' + attrs + '>' + (v.caption ? '<figcaption>' + escHtml(v.caption) + '</figcaption>' : '') + '</figure>';
        var old = figure || img;
        if (old && old.parentNode) {
          var box = document.createElement('div'); box.innerHTML = html;
          old.parentNode.replaceChild(box.firstChild, old); ed.focus(); saveSel(); sync();
        } else { insertHtml(html); }
      }, target ? { okLabel: 'Save' } : { mark: 'caret' });
    }

    // emoticon picker: search + category filter over /admin/emoticons/list.json
    // (fetched once per page — loadEmoticons). Click inserts an inline
    // <img class="rt-emoticon"> at the saved cursor; when `existing` is an
    // emoticon already in the editor (clicked), picking replaces it in place.
    function doEmoticon(existing) {
      saveSel(); closeDlg();
      if (!existing) placeMarker(true); // bookmark the caret before the search box takes focus
      dlg = document.createElement('div'); dlg.className = 'rt-dlg';

      var bar = document.createElement('div'); bar.className = 'rt-emo-bar';
      var search = document.createElement('input'); search.type = 'text'; search.placeholder = 'Search emoticons…';
      var catSel = document.createElement('select');
      var allOpt = document.createElement('option'); allOpt.value = ''; allOpt.textContent = 'All categories';
      catSel.appendChild(allOpt);
      bar.appendChild(search); bar.appendChild(catSel);

      var grid = document.createElement('div'); grid.className = 'rt-emo-grid';
      var hint = document.createElement('p'); hint.className = 'rt-dlg-hint'; hint.textContent = 'Loading emoticons…';

      var act = document.createElement('div'); act.className = 'rt-dlg-actions';
      var can = document.createElement('button'); can.type = 'button'; can.className = 'rt-dlg-can'; can.textContent = 'Cancel';
      can.addEventListener('click', function () { closeDlg(); clearMarker(true); sync(); restoreSel(); });
      act.appendChild(can);

      dlg.appendChild(bar); dlg.appendChild(hint); dlg.appendChild(grid); dlg.appendChild(act);
      dlg.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDlg(); clearMarker(true); sync(); restoreSel(); }
      });
      wrap.appendChild(dlg);
      search.focus();

      var all = [];
      function pick(it) {
        closeDlg();
        if (existing && existing.parentNode) {
          existing.setAttribute('src', it.url);
          existing.setAttribute('alt', ':' + it.slug + ':');
          ed.focus(); saveSel(); sync();
        } else {
          insertHtml('<img src="' + escAttr(it.url) + '" alt=":' + escAttr(it.slug) + ':" class="rt-emoticon">');
        }
      }
      function paint() {
        grid.innerHTML = '';
        var q = search.value.trim().toLowerCase();
        var cat = catSel.value;
        var list = all.filter(function (it) {
          if (cat && it.category !== cat) return false;
          if (q && String(it.slug).toLowerCase().indexOf(q) < 0) return false;
          return true;
        });
        hint.textContent = list.length ? '' : (all.length ? 'No emoticons match.' : 'No emoticons yet — add some under Design → Emoticons.');
        hint.style.display = list.length ? 'none' : '';
        list.forEach(function (it) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'rt-emo-btn';
          b.title = ':' + it.slug + ':';
          var im = document.createElement('img'); im.src = it.url; im.alt = ':' + it.slug + ':'; im.loading = 'lazy';
          b.appendChild(im);
          b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the editor selection
          b.addEventListener('click', function (e) { e.preventDefault(); pick(it); });
          grid.appendChild(b);
        });
      }
      search.addEventListener('input', paint);
      catSel.addEventListener('change', paint);

      loadEmoticons(emoEndpoint).then(function (d) {
        if (!dlg || !dlg.contains(grid)) return; // dialog was closed meanwhile
        all = d.emoticons;
        d.categories.forEach(function (c) {
          var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o);
        });
        paint();
      }, function () {
        if (!dlg || !dlg.contains(grid)) return;
        hint.textContent = 'Could not load the emoticon list — check your connection and try again.';
      });
    }

    // ---- callouts (styled asides) ----
    // Stored markup (renders publicly with no JS — icon SVG is inline):
    //   <div class="rt-callout rt-callout-<type>">
    //     <span class="rt-callout-icon" aria-hidden="true">SVG | emoticon img</span>
    //     <div class="rt-callout-body">…rich HTML…</div></div>
    var CO_TYPES = [['success', 'Success'], ['info', 'Info'], ['warning', 'Warning'], ['error', 'Error'], ['other', 'Other (emoticon icon)']];

    function calloutType(el) {
      var m = String(el.className || '').match(/rt-callout-(success|info|warning|error|other)/);
      return m ? m[1] : 'info';
    }

    // Body HTML for a callout: mini-editor markup through the same clean() the
    // main editor uses; nested callouts are unwrapped to their body content and
    // any stray contenteditable attributes dropped.
    function tidyCalloutBody(html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = String(html == null ? '' : html);
      var nested;
      while ((nested = tmp.querySelector('.rt-callout'))) {
        var nb = nested.querySelector('.rt-callout-body');
        var np = nested.parentNode;
        if (nb) { while (nb.firstChild) np.insertBefore(nb.firstChild, nested); }
        np.removeChild(nested);
      }
      Array.prototype.slice.call(tmp.querySelectorAll('[contenteditable]')).forEach(function (el) { el.removeAttribute('contenteditable'); });
      return clean(tmp.innerHTML);
    }

    function calloutHtml(type, emo, bodyHtml) {
      var icon = type === 'other' && emo
        ? '<img src="' + escAttr(emo.url) + '" alt=":' + escAttr(emo.slug) + ':" class="rt-emoticon">'
        : (CALLOUT_ICONS[type] || CALLOUT_ICONS.info);
      return '<div class="rt-callout rt-callout-' + type + '">'
        + '<span class="rt-callout-icon" aria-hidden="true">' + icon + '</span>'
        + '<div class="rt-callout-body">' + (bodyHtml || '<p></p>') + '</div>'
        + '</div>';
    }

    // Insert el as a top-level block after the block holding the saved cursor
    // (replacing that block when it's an empty paragraph), then park the caret
    // in the block after it so typing continues below — execCommand insertHTML
    // would split the current paragraph around a <div>, so this is by hand.
    function insertBlockEl(el) {
      var node = savedRange ? savedRange.startContainer : null;
      var blk = null;
      while (node && node !== ed) { if (node.parentNode === ed) { blk = node; break; } node = node.parentNode; }
      if (blk) ed.insertBefore(el, blk.nextSibling); else ed.appendChild(el);
      if (blk && blk.nodeType === 1 && blk.tagName === 'P' && !blk.textContent.replace(/\s/g, '') && !blk.querySelector('img, a.rt-anchor')) ed.removeChild(blk);
      var after = el.nextSibling;
      if (!after) { after = document.createElement('p'); after.innerHTML = '<br>'; ed.appendChild(after); }
      ed.focus();
      var r = document.createRange(); r.setStart(after, 0); r.collapse(true);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      savedRange = r;
      saveSel(); sync();
    }

    // callout dialog: style select, an emoticon strip (for "Other"), and a mini
    // rich-text editor for the body. `existing` = a clicked .rt-callout to edit
    // in place (Save / Delete); without it a new callout is inserted.
    function doCallout(existing) {
      saveSel(); closeDlg();
      dlg = document.createElement('div'); dlg.className = 'rt-dlg';

      var row = document.createElement('div'); row.className = 'rt-dlg-row';
      var lab = document.createElement('span'); lab.textContent = 'Style'; row.appendChild(lab);
      var typeSel = document.createElement('select');
      CO_TYPES.forEach(function (t) { var o = document.createElement('option'); o.value = t[0]; o.textContent = t[1]; typeSel.appendChild(o); });
      row.appendChild(typeSel);

      // Emoticon strip — shown for "Other"; reuses the shared emoticon cache.
      var emoWrap = document.createElement('div'); emoWrap.className = 'rt-co-emo';
      var emoHint = document.createElement('p'); emoHint.className = 'rt-dlg-hint'; emoHint.textContent = 'Pick an emoticon for the icon:';
      var grid = document.createElement('div'); grid.className = 'rt-emo-grid';
      emoWrap.appendChild(emoHint); emoWrap.appendChild(grid);

      // Mini rich-text editor for the callout body, with its own compact
      // toolbar. Its selection is tracked separately (miniRange) so these
      // buttons never act on the main editor.
      var miniBar = document.createElement('div'); miniBar.className = 'rt-co-bar';
      var mini = document.createElement('div'); mini.className = 'rt-co-mini'; mini.setAttribute('contenteditable', 'true');
      var miniRange = null;
      var linkRowOpen = false; // freeze miniSave while the link URL input has focus
      // Freeze a CLONE (not the live range) so a later selection change can't
      // mutate what we saved. While the link row is open we stop updating
      // miniRange: on touch, tapping the URL field bounces a collapsed caret
      // back into the mini editor (a selectionchange) that would otherwise
      // clobber the selection the Apply is meant to act on.
      function miniSave() { if (linkRowOpen) return; var s = window.getSelection(); if (s && s.rangeCount && mini.contains(s.anchorNode)) miniRange = s.getRangeAt(0).cloneRange(); }
      function miniExec(cmd, val) {
        mini.focus();
        if (miniRange) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(miniRange); }
        try { document.execCommand(cmd, false, val == null ? null : val); } catch (e) { /* unsupported command */ }
        miniSave();
      }
      mini.addEventListener('keyup', miniSave);
      mini.addEventListener('mouseup', miniSave);
      mini.addEventListener('focus', miniSave);
      // Touch: native selection handles fire only selectionchange. Guard to the
      // mini editor so dialog inputs / the page never overwrite miniRange.
      function miniSelChange() { var s = window.getSelection(); if (s && s.anchorNode && mini.contains(s.anchorNode)) miniSave(); }
      document.addEventListener('selectionchange', miniSelChange);
      // Grab the selection the instant a mini toolbar button is pressed, in the
      // capture phase — before the tap can move or collapse it.
      ['pointerdown', 'mousedown', 'touchstart'].forEach(function (evt) {
        miniBar.addEventListener(evt, miniSave, true);
      });
      // Detach the document listener when this dialog closes (each callout open
      // registers its own). The guard already no-ops once mini leaves the DOM;
      // this stops them accumulating over a session.
      function closeCallout() { document.removeEventListener('selectionchange', miniSelChange); closeDlg(); }
      function miniBtn(label, title, fn, style) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; if (style) b.setAttribute('style', style);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the mini selection
        b.addEventListener('click', function (e) { e.preventDefault(); fn(); });
        miniBar.appendChild(b); return b;
      }
      var miniFmt = document.createElement('select'); miniFmt.title = 'Text style';
      [['p', 'Paragraph'], ['h3', 'Heading 3'], ['h4', 'Heading 4']].forEach(function (o) {
        var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; miniFmt.appendChild(op);
      });
      miniFmt.addEventListener('mousedown', miniSave);
      miniFmt.addEventListener('change', function () { miniExec('formatBlock', '<' + miniFmt.value + '>'); });
      miniBar.appendChild(miniFmt);
      miniBtn('B', 'Bold', function () { miniExec('bold'); }, 'font-weight:700');
      miniBtn('I', 'Italic', function () { miniExec('italic'); }, 'font-style:italic');
      miniBtn('• List', 'Bulleted list', function () { miniExec('insertUnorderedList'); });
      miniBtn('1. List', 'Numbered list', function () { miniExec('insertOrderedList'); });

      // Link support: an inline URL row (a nested rt-dlg would close this one).
      // Selected text → wrap; caret inside a link → edit/remove; no selection →
      // insert the URL as its own link text.
      var linkRow = document.createElement('div'); linkRow.className = 'rt-co-linkrow'; linkRow.hidden = true;
      var linkInp = document.createElement('input'); linkInp.type = 'text'; linkInp.placeholder = 'https://… or /page';
      var linkApply = document.createElement('button'); linkApply.type = 'button'; linkApply.className = 'rt-dlg-ins'; linkApply.textContent = 'Apply';
      var linkRemove = document.createElement('button'); linkRemove.type = 'button'; linkRemove.className = 'rt-dlg-rem'; linkRemove.textContent = 'Remove';
      var linkCancel = document.createElement('button'); linkCancel.type = 'button'; linkCancel.className = 'rt-dlg-can'; linkCancel.textContent = 'Cancel';
      linkRow.appendChild(linkInp); linkRow.appendChild(linkApply); linkRow.appendChild(linkRemove); linkRow.appendChild(linkCancel);

      function miniLinkAt() {
        if (!miniRange) return null;
        var n = miniRange.startContainer;
        while (n && n !== mini) { if (n.nodeType === 1 && n.tagName === 'A') return n; n = n.parentNode; }
        return null;
      }
      function hideLinkRow() { linkRow.hidden = true; linkRowOpen = false; }
      miniBtn('Link', 'Insert link', function () {
        miniSave(); // freeze the selection before opening the row
        var a = miniLinkAt();
        linkInp.value = a ? (a.getAttribute('href') || '') : '';
        linkRemove.hidden = !a;
        linkRow.hidden = false;
        linkRowOpen = true; // freeze miniSave: the URL input focus mustn't clobber miniRange
        linkInp.focus();
      });
      // Apply via DIRECT DOM ops on the frozen miniRange — its nodes are
      // unchanged while the link row is open, so we don't rely on focus/
      // selection restore (which fails on touch after the input took focus).
      linkApply.addEventListener('click', function () {
        var url = linkInp.value.trim();
        if (!url) { hideLinkRow(); mini.focus(); miniSave(); return; }
        var a = miniLinkAt();
        if (a) {
          a.setAttribute('href', url);
        } else if (miniRange && !miniRange.collapsed) {
          var link = document.createElement('a'); link.setAttribute('href', url);
          try { miniRange.surroundContents(link); }
          catch (e) { link.appendChild(miniRange.extractContents()); miniRange.insertNode(link); }
        } else if (miniRange) {
          var link2 = document.createElement('a'); link2.setAttribute('href', url); link2.textContent = url;
          miniRange.insertNode(link2);
        } else {
          // No frozen range at all — append to the mini body as a fallback.
          var link3 = document.createElement('a'); link3.setAttribute('href', url); link3.textContent = url;
          mini.appendChild(link3);
        }
        hideLinkRow();
        mini.focus(); miniSave();
      });
      linkInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); linkApply.click(); } });
      linkRemove.addEventListener('click', function () {
        var a = miniLinkAt();
        if (a && a.parentNode) {
          var p = a.parentNode;
          while (a.firstChild) p.insertBefore(a.firstChild, a);
          p.removeChild(a); if (p.normalize) p.normalize();
        }
        hideLinkRow(); mini.focus(); miniSave();
      });
      linkCancel.addEventListener('click', function () { hideLinkRow(); mini.focus(); });

      var act = document.createElement('div'); act.className = 'rt-dlg-actions';
      var ins = document.createElement('button'); ins.type = 'button'; ins.className = 'rt-dlg-ins'; ins.textContent = existing ? 'Save' : 'Insert';
      var can = document.createElement('button'); can.type = 'button'; can.className = 'rt-dlg-can'; can.textContent = 'Cancel';
      act.appendChild(ins); act.appendChild(can);

      var selEmo = null;      // {url, slug} chosen in the strip (required for Other)
      var emoLoaded = false;
      function updateIns() { ins.disabled = typeSel.value === 'other' && !selEmo; }
      function paintEmo(list) {
        grid.innerHTML = '';
        list.forEach(function (it) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'rt-emo-btn';
          if (selEmo && selEmo.url === it.url) b.classList.add('rt-emo-sel');
          b.title = ':' + it.slug + ':';
          var im = document.createElement('img'); im.src = it.url; im.alt = ':' + it.slug + ':'; im.loading = 'lazy';
          b.appendChild(im);
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function (e) {
            e.preventDefault();
            selEmo = it;
            Array.prototype.slice.call(grid.children).forEach(function (c) { c.classList.remove('rt-emo-sel'); });
            b.classList.add('rt-emo-sel');
            updateIns();
          });
          grid.appendChild(b);
        });
      }
      function loadEmoStrip() {
        if (emoLoaded) return;
        emoLoaded = true;
        emoHint.textContent = 'Loading emoticons…';
        loadEmoticons(emoEndpoint).then(function (d) {
          if (!dlg || !dlg.contains(grid)) return; // dialog was closed meanwhile
          emoHint.textContent = d.emoticons.length ? 'Pick an emoticon for the icon:' : 'No emoticons yet — add some under Design → Emoticons.';
          paintEmo(d.emoticons);
        }, function () {
          if (!dlg || !dlg.contains(grid)) return;
          emoLoaded = false; // retry when reselected
          emoHint.textContent = 'Could not load the emoticon list — check your connection and try again.';
        });
      }
      function updateEmoVis() {
        emoWrap.style.display = typeSel.value === 'other' ? '' : 'none';
        if (typeSel.value === 'other') loadEmoStrip();
        updateIns();
      }
      typeSel.addEventListener('change', updateEmoVis);

      if (existing) {
        typeSel.value = calloutType(existing);
        var bodyEl = existing.querySelector('.rt-callout-body');
        mini.innerHTML = bodyEl ? bodyEl.innerHTML : '';
        var iconImg = existing.querySelector('.rt-callout-icon img');
        if (iconImg) selEmo = { url: iconImg.getAttribute('src') || '', slug: String(iconImg.getAttribute('alt') || '').replace(/^:+|:+$/g, '') };
      }
      if (!mini.firstChild) mini.innerHTML = '<p><br></p>';

      ins.addEventListener('click', function () {
        if (typeSel.value === 'other' && !selEmo) return;
        var html = calloutHtml(typeSel.value, selEmo, tidyCalloutBody(mini.innerHTML));
        closeCallout();
        var box = document.createElement('div'); box.innerHTML = html;
        var el = box.firstChild;
        el.setAttribute('contenteditable', 'false'); // atomic in the editor
        if (existing && existing.parentNode) {
          existing.parentNode.replaceChild(el, existing);
          ed.focus(); saveSel(); sync();
        } else {
          insertBlockEl(el);
        }
      });
      can.addEventListener('click', function () { closeCallout(); restoreSel(); });
      if (existing) {
        var rem = document.createElement('button'); rem.type = 'button'; rem.className = 'rt-dlg-rem'; rem.textContent = 'Delete callout';
        rem.addEventListener('click', function () {
          closeCallout();
          if (existing.parentNode) existing.parentNode.removeChild(existing);
          ed.focus(); saveSel(); sync();
        });
        act.appendChild(rem);
      }

      dlg.appendChild(row); dlg.appendChild(emoWrap); dlg.appendChild(miniBar); dlg.appendChild(linkRow); dlg.appendChild(mini); dlg.appendChild(act);
      dlg.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCallout(); restoreSel(); }
      });
      wrap.appendChild(dlg);
      updateEmoVis();
      mini.focus(); miniSave();
    }

    // Gallery builder: a layout choice + a caption sheet of the chosen images
    // (alt + optional caption, reorder, remove). `existing` = a clicked gallery
    // to edit in place. Images are added from the media library (multi-select).
    function isVideoUrl(u) { return /\.(mp4|webm|mov|m4v|ogg)$/i.test(String(u || '')); }

    function galItemHtml(it) {
      var thumb = it.thumb || it.src;
      var sizes = it.sizes || '(max-width: 600px) 90vw, 320px';
      var img = '<img class="gal-thumb" src="' + escAttr(thumb) + '"'
        + (it.srcset ? ' srcset="' + escAttr(it.srcset) + '" sizes="' + escAttr(sizes) + '"' : '')
        + ' alt="' + escAttr(it.alt || '') + '" loading="lazy">';
      var cap = it.caption ? '<div class="gal-cap" hidden>' + escHtml(it.caption) + '</div>' : '';
      var media = it.media === 'video' ? 'video' : 'image';
      return '<a class="gal-item" href="' + escAttr(it.src) + '" data-gal-item data-media="' + media + '"'
        + ' data-src="' + escAttr(it.src) + '" data-cover="' + escAttr(it.cover || '') + '" data-alt="' + escAttr(it.alt || '') + '"'
        + ' aria-label="' + escAttr(it.alt || (media === 'video' ? 'Play video' : 'View image')) + '">'
        + img + (media === 'video' ? '<span class="gal-play" aria-hidden="true">▶</span>' : '') + cap + '</a>';
    }
    function galleryHtml(layout, items) {
      var lay = layout === 'carousel' ? 'carousel' : 'grid';
      return '<div class="gallery gallery-' + lay + '" data-gallery data-layout="' + lay + '">'
        + '<button type="button" class="gal-nav gal-prev" aria-label="Scroll back">‹</button>'
        + '<div class="gal-track" data-gal-track>' + items.map(galItemHtml).join('') + '</div>'
        + '<button type="button" class="gal-nav gal-next" aria-label="Scroll forward">›</button>'
        + '</div>';
    }

    function doGallery(existing) {
      saveSel(); closeDlg();
      var layout = galleryDefault;
      var items = [];
      if (existing) {
        layout = (/gallery-carousel/.test(existing.className) || existing.getAttribute('data-layout') === 'carousel') ? 'carousel' : 'grid';
        Array.prototype.slice.call(existing.querySelectorAll('.gal-item')).forEach(function (a) {
          var img = a.querySelector('img'); var cap = a.querySelector('.gal-cap');
          items.push({
            src: a.getAttribute('data-src') || (img && img.getAttribute('src')) || '',
            thumb: img ? img.getAttribute('src') : '',
            srcset: img ? (img.getAttribute('srcset') || '') : '',
            sizes: img ? (img.getAttribute('sizes') || '') : '',
            alt: a.getAttribute('data-alt') || '',
            caption: cap ? cap.textContent : '',
            media: a.getAttribute('data-media') === 'video' ? 'video' : 'image',
            cover: a.getAttribute('data-cover') || '',
          });
        });
      }

      dlg = document.createElement('div'); dlg.className = 'rt-dlg rt-gal-dlg';
      var title = document.createElement('p'); title.className = 'rt-dlg-hint';
      title.textContent = existing ? 'Edit gallery' : 'New gallery';
      dlg.appendChild(title);

      var lrow = document.createElement('div'); lrow.className = 'rt-dlg-row';
      var llab = document.createElement('span'); llab.textContent = 'Layout'; lrow.appendChild(llab);
      var laySel = document.createElement('select');
      [['grid', 'Grid'], ['carousel', 'Carousel']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; laySel.appendChild(op); });
      laySel.value = layout; lrow.appendChild(laySel);
      dlg.appendChild(lrow);

      var listEl = document.createElement('div'); listEl.className = 'rt-gal-list';
      dlg.appendChild(listEl);

      function render() {
        listEl.innerHTML = '';
        if (!items.length) {
          var empty = document.createElement('p'); empty.className = 'rt-dlg-hint'; empty.textContent = 'No images yet — click “Add images”.';
          listEl.appendChild(empty); return;
        }
        items.forEach(function (it, i) {
          var rowEl = document.createElement('div'); rowEl.className = 'rt-gal-item';
          var th = document.createElement('img'); th.className = 'rt-gal-th'; th.src = it.thumb || it.src; th.alt = ''; rowEl.appendChild(th);
          var fields = document.createElement('div'); fields.className = 'rt-gal-fields';
          var altIn = document.createElement('input'); altIn.type = 'text'; altIn.placeholder = 'Alt text (describe the photo)'; altIn.value = it.alt || '';
          altIn.addEventListener('input', function () { it.alt = altIn.value; });
          var capIn = document.createElement('input'); capIn.type = 'text'; capIn.placeholder = 'Caption (optional)'; capIn.value = it.caption || '';
          capIn.addEventListener('input', function () { it.caption = capIn.value; });
          fields.appendChild(altIn); fields.appendChild(capIn); rowEl.appendChild(fields);
          var ctrls = document.createElement('div'); ctrls.className = 'rt-gal-ctrls';
          function ctrlBtn(lbl, ttl, fn) { var b = document.createElement('button'); b.type = 'button'; b.textContent = lbl; b.title = ttl; b.addEventListener('click', function (e) { e.preventDefault(); fn(); }); return b; }
          var up = ctrlBtn('↑', 'Move up', function () { var t = items[i - 1]; items[i - 1] = items[i]; items[i] = t; render(); });
          var dn = ctrlBtn('↓', 'Move down', function () { var t = items[i + 1]; items[i + 1] = items[i]; items[i] = t; render(); });
          var rm = ctrlBtn('✕', 'Remove', function () { items.splice(i, 1); render(); });
          up.disabled = i === 0; dn.disabled = i === items.length - 1;
          ctrls.appendChild(up); ctrls.appendChild(dn); ctrls.appendChild(rm); rowEl.appendChild(ctrls);
          listEl.appendChild(rowEl);
        });
      }
      render();

      var addRow = document.createElement('div'); addRow.className = 'rt-dlg-row';
      var addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'btn btn-secondary btn-small'; addBtn.textContent = 'Add images';
      addBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!window.MEDIA) return;
        window.MEDIA.open(function (list) {
          (list || []).forEach(function (p) {
            var meta = p.meta;
            var src = (meta && meta.src) || p.url;
            var srcset = (meta && meta.variants && meta.variants.length > 1)
              ? meta.variants.map(function (v) { return v.url + ' ' + v.w + 'w'; }).join(', ') : '';
            items.push({ src: src, thumb: src, srcset: srcset, sizes: '', alt: '', caption: '', media: isVideoUrl(p.url) ? 'video' : 'image', cover: '' });
          });
          render();
        }, { multiple: true });
      });
      addRow.appendChild(addBtn); dlg.appendChild(addRow);

      var act = document.createElement('div'); act.className = 'rt-dlg-actions';
      var ins = document.createElement('button'); ins.type = 'button'; ins.className = 'btn'; ins.textContent = existing ? 'Save gallery' : 'Insert gallery';
      var can = document.createElement('button'); can.type = 'button'; can.className = 'btn btn-secondary'; can.textContent = 'Cancel';
      act.appendChild(ins); act.appendChild(can);
      if (existing) {
        var rem = document.createElement('button'); rem.type = 'button'; rem.className = 'rt-dlg-rem'; rem.textContent = 'Delete gallery';
        rem.addEventListener('click', function () { closeDlg(); if (existing.parentNode) existing.parentNode.removeChild(existing); ed.focus(); saveSel(); sync(); });
        act.appendChild(rem);
      }
      dlg.appendChild(act);

      ins.addEventListener('click', function () {
        if (!items.length) return;
        var html = galleryHtml(laySel.value, items);
        closeDlg();
        var box = document.createElement('div'); box.innerHTML = html;
        var el = box.firstChild;
        el.setAttribute('contenteditable', 'false');
        if (existing && existing.parentNode) { existing.parentNode.replaceChild(el, existing); ed.focus(); saveSel(); sync(); }
        else insertBlockEl(el);
      });
      can.addEventListener('click', function () { closeDlg(); restoreSel(); });
      dlg.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDlg(); restoreSel(); } });
      wrap.appendChild(dlg);
    }

    // Paste choice dialog: the clipboard looked like Markdown and/or carried
    // rich formatting — let the author pick the interpretation before anything
    // is inserted. richHtml is already sanitised; text is the raw plain text.
    function doPasteChoice(richHtml, isRich, text, isMd) {
      closeDlg();
      // Bookmark the paste point (wrapping: confirming replaces any selection,
      // matching normal paste). Inserts go via insertHtml — the marker path that
      // survives a dialog button stealing focus on touch, not execCommand.
      placeMarker(false);
      dlg = document.createElement('div'); dlg.className = 'rt-dlg';
      var hint = document.createElement('p'); hint.className = 'rt-dlg-hint';
      hint.textContent = isRich && isMd
        ? 'This paste carries formatting and looks like Markdown — choose how to insert it. Markdown converts **bold**, # headings, lists, links, etc.; headings become H2–H4.'
        : isMd
          ? 'This paste looks like Markdown. Convert **bold**, # headings, lists, links, etc. (headings become H2–H4), or insert the text as-is?'
          : (text
              ? 'This paste carries formatting. Keep it (cleaned up — headings become H2–H4), or insert plain text?'
              : 'This paste carries formatting. Keep it, cleaned up? (Headings become H2–H4.)');
      var act = document.createElement('div'); act.className = 'rt-dlg-actions';
      // Cancel and every "nothing to insert" branch unwind the bookmark the same way.
      function cancel() { clearMarker(true); sync(); restoreSel(); }
      function mk(cls, label, fn) {
        var b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label;
        b.addEventListener('click', function () { closeDlg(); fn(); });
        act.appendChild(b);
      }
      if (isRich) mk('rt-dlg-ins', 'Keep formatting', function () { richHtml ? insertHtml(richHtml) : cancel(); });
      if (isMd) mk('rt-dlg-ins', 'Convert Markdown', function () { var h = mdToHtml(text); h ? insertHtml(h) : cancel(); });
      // Only offer plain text when the clipboard actually carried some.
      if (text) mk('rt-dlg-can', 'Plain text', function () { var h = textToBlocks(text); h ? insertHtml(h) : cancel(); });
      mk('rt-dlg-can', 'Cancel', cancel);
      dlg.appendChild(hint); dlg.appendChild(act);
      wrap.appendChild(dlg);
    }

    function curBlock() { var b = ''; try { b = document.queryCommandValue('formatBlock'); } catch (e) { /* not supported */ } return String(b || '').toLowerCase(); }

    // Blockquote toggles: quote the current block, or turn a quote back into a <p>.
    function doQuote() {
      restoreSel();
      var inQuote = curBlock() === 'blockquote' || inEd(selNode(), function (el) { return el.tagName === 'BLOCKQUOTE'; });
      exec('formatBlock', inQuote ? '<p>' : '<blockquote>');
    }

    // Inline code (monospace). No execCommand for it, so toggle by hand: unwrap if
    // the selection sits in a <code>, else wrap the selected text (or drop in an
    // empty <code> with the caret inside when there's no selection).
    function doCode() {
      restoreSel();
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) { ed.focus(); return; }
      var existing = inEd(sel.anchorNode, function (el) { return el.tagName === 'CODE'; });
      if (existing) {
        var p = existing.parentNode;
        while (existing.firstChild) p.insertBefore(existing.firstChild, existing);
        p.removeChild(existing); p.normalize();
      } else {
        var range = sel.getRangeAt(0);
        var code = document.createElement('code');
        if (range.collapsed) {
          range.insertNode(code);
          var r = document.createRange(); r.selectNodeContents(code); r.collapse(true);
          sel.removeAllRanges(); sel.addRange(r);
        } else {
          try { range.surroundContents(code); }
          catch (e) { code.appendChild(range.extractContents()); range.insertNode(code); }
          var r2 = document.createRange(); r2.selectNodeContents(code);
          sel.removeAllRanges(); sel.addRange(r2);
        }
      }
      ed.focus(); saveSel(); sync();
    }

    // ---- toolbar ----
    function mkBtn(label, title, onClick, style) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (title) b.title = title; if (style) b.setAttribute('style', style);
      b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the editor selection
      b.addEventListener('click', function (e) { e.preventDefault(); onClick(b); });
      bar.appendChild(b); return b;
    }
    function mkIcon(name, title, onClick) { var b = mkBtn('', title, onClick); b.className = 'rt-ico'; b.innerHTML = ICONS[name] || ''; return b; }
    function sep() { var s = document.createElement('span'); s.className = 'rt-sep'; bar.appendChild(s); }

    // Reduced comment toolbar: the small vocabulary allowed by the server-side
    // comment sanitiser (strong/em, ul/ol/li, blockquote, emoticon). No text
    // style/size, links, callouts, images, alignment, code, hr, etc.
    if (mode === 'comment') {
      mkBtn('B', 'Bold', function () { exec('bold'); }, 'font-weight:700');
      mkBtn('I', 'Italic', function () { exec('italic'); }, 'font-style:italic');
      sep();
      mkBtn('• List', 'Bulleted list', function () { exec('insertUnorderedList'); });
      mkBtn('1. List', 'Numbered list', function () { exec('insertOrderedList'); });
      mkBtn('❝', 'Blockquote', doQuote);
      sep();
      mkIcon('emoticon', 'Insert emoticon', function () { doEmoticon(); });
      return;
    }

    var fmt = document.createElement('select'); fmt.title = 'Text style';
    [['p', 'Paragraph'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; fmt.appendChild(op);
    });
    function updateFmt() { var b = curBlock(); fmt.value = (b === 'h2' || b === 'h3' || b === 'h4') ? b : 'p'; }
    fmt.addEventListener('mousedown', saveSel);
    fmt.addEventListener('change', function () { exec('formatBlock', '<' + fmt.value + '>'); updateFmt(); });

    // Size select: makes the current paragraph(s) / list item(s) larger or smaller.
    var sizeSel = document.createElement('select'); sizeSel.title = 'Text size (paragraphs & lists)';
    [['', 'Normal size'], ['rt-lg', 'Large'], ['rt-sm', 'Small']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sizeSel.appendChild(op);
    });
    function updateSize() { var b = blockOf(window.getSelection().anchorNode); sizeSel.value = b && b.classList.contains('rt-lg') ? 'rt-lg' : (b && b.classList.contains('rt-sm') ? 'rt-sm' : ''); }
    sizeSel.addEventListener('mousedown', saveSel);
    sizeSel.addEventListener('change', function () { applySize(sizeSel.value); updateSize(); });

    document.addEventListener('selectionchange', function () { var s = window.getSelection(); if (s && s.rangeCount && ed.contains(s.anchorNode)) { updateFmt(); updateSize(); } });
    bar.appendChild(fmt); bar.appendChild(sizeSel); sep();

    mkBtn('B', 'Bold', function () { exec('bold'); }, 'font-weight:700');
    mkBtn('I', 'Italic', function () { exec('italic'); }, 'font-style:italic');
    mkBtn('x²', 'Superscript', function () { exec('superscript'); });
    mkBtn('x₂', 'Subscript', function () { exec('subscript'); });
    mkIcon('link', 'Insert link', function () { doLink(); }); // no arg → insert/derive
    mkIcon('anchor', 'Insert anchor (a named #target you can link to)', function () { doAnchor(); });
    mkIcon('emoticon', 'Insert emoticon', function () { doEmoticon(); });
    mkIcon('callout', 'Insert callout', function () { doCallout(); });
    sep();
    mkBtn('• List', 'Bulleted list', function () { exec('insertUnorderedList'); });
    mkBtn('1. List', 'Numbered list', function () { exec('insertOrderedList'); });
    mkIcon('outdent', 'Outdent', function () { exec('outdent'); });
    mkIcon('indent', 'Indent', function () { exec('indent'); });
    sep();
    mkIcon('alignLeft', 'Align left', function () { exec('justifyLeft'); });
    mkIcon('alignCenter', 'Align centre', function () { exec('justifyCenter'); });
    mkIcon('alignRight', 'Align right', function () { exec('justifyRight'); });
    sep();
    mkBtn('❝', 'Blockquote', doQuote);
    mkIcon('code', 'Inline code (monospace)', doCode);
    mkIcon('image', 'Insert image (media library or URL)', function () { doImage(); });
    if (galleryEnabled) mkBtn('▦', 'Insert an image gallery', function () { doGallery(); }, 'font-size:1.05rem');
    mkBtn('—', 'Horizontal rule', function () { exec('insertHorizontalRule'); });
    sep();
    mkBtn('↶', 'Undo', function () { exec('undo'); });

    var src = false;
    var tg = mkBtn('HTML', 'Edit HTML source', function () {
      // Toggling source rebuilds the editor without the marker; unwind any open
      // dialog + bookmark first so insMarker isn't left detached (same as paste).
      if (dlg) { closeDlg(); clearMarker(true); }
      src = !src;
      if (src) { ta.value = clean(ed.innerHTML); ta.style.display = 'block'; ed.style.display = 'none'; tg.classList.add('rt-on'); }
      else { ed.innerHTML = ta.value; ensureBlocks(ed); lockCallouts(ed); lockGalleries(ed); ta.style.display = 'none'; ed.style.display = 'block'; tg.classList.remove('rt-on'); sync(); }
    });
  }

  window.WYSIWYG = {
    upgrade: upgrade,
    upgradeAll: function (scope) { (scope || document).querySelectorAll('textarea[data-richtext]:not([data-rt-done])').forEach(upgrade); },
    sanitizeRich: sanitizeRich, // exposed for reuse / tests
    mdToHtml: mdToHtml,
    clean: clean,
    textToBlocks: textToBlocks,
    ensureBlocks: ensureBlocks,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { window.WYSIWYG.upgradeAll(document); });
  else window.WYSIWYG.upgradeAll(document);
})();
