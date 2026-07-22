// Public media serving: GET /media/<key> streams objects straight from the R2
// bucket (env.MEDIA). R2 keys mirror the URL path — an object stored at
// "media/202607/1719900000000-photo.jpg" is served at that same path with a
// leading slash.
//
// Caching: a file can be REPLACED in place (admin media library) — same key and
// URL, new bytes — so a URL is no longer guaranteed immutable. We therefore
// cache with a short max-age and require revalidation: the ETag (R2 object
// hash) changes when a file is replaced, and a matching If-None-Match returns a
// bodyless 304, so unchanged files stay cheap while replacements propagate
// within the freshness window (immediately on a hard refresh).
//
// Also exports the small key/content-type helpers shared by the admin media
// and people routes (which upload into the same bucket).

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', json: 'application/json',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  zip: 'application/zip',
};

// Content type from the file extension — fallback for objects stored without
// httpMetadata (e.g. uploaded outside the CMS).
export function contentTypeForKey(key) {
  const ext = String(key || '').split('.').pop().toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

// True if the object should render as an <img> thumbnail in admin UIs.
export function isImageKey(key, contentType) {
  if (/^image\//.test(contentType || '')) return true;
  return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(String(key || ''));
}

// Short uppercase label for non-image tiles ("PDF", "MP4", …).
export function fileTypeLabel(key) {
  return (String(key || '').split('.').pop() || 'FILE').toUpperCase().slice(0, 5);
}

// Build a unique, URL-safe object key: media/<folder>/<timestamp>-<sanitised
// filename>. The timestamp guarantees uniqueness, so uploads never clobber
// each other and served URLs can be cached forever.
export function makeMediaKey(folder, filename) {
  const s = String(filename || 'file');
  const dot = s.lastIndexOf('.');
  const ext = dot > -1 ? s.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) : '';
  const base = (dot > -1 ? s.slice(0, dot) : s).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  const dir = String(folder || 'misc').toLowerCase().replace(/[^a-z0-9/-]/g, '') || 'misc';
  return `media/${dir}/${Date.now()}-${base}${ext ? '.' + ext : ''}`;
}

// Does an If-None-Match header match the object's (unquoted) ETag? Handles the
// "*" wildcard, comma-separated lists and weak (W/) validators.
function etagMatches(ifNoneMatch, etag) {
  return String(ifNoneMatch).split(',').some((tok) => {
    const t = tok.trim();
    if (t === '*') return true;
    return t.replace(/^W\//, '').replace(/^"|"$/g, '') === etag;
  });
}

// GET /media/<key> → Response, or null (unknown key / not a media path) so the
// caller can fall through to its 404.
export async function handleMediaFile(request, env, url) {
  if (!env.MEDIA) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (!url.pathname.startsWith('/media/')) return null;

  let key;
  try { key = decodeURIComponent(url.pathname.slice(1)); } catch { return null; }
  // Reject traversal or sneaky keys: only plain nested keys under media/ are
  // ever written, so anything else is hostile or a typo.
  if (!key.startsWith('media/') || key.includes('..') || key.includes('\\') || key.includes('//') || key.includes('\0')) {
    return null;
  }

  // Conditional GET: if the client already has this exact version, answer with
  // a bodyless 304 and never read the object body from R2. We compare ETags
  // ourselves via a cheap head() (R2's onlyIf rejects quoted/weak/list
  // validators). A replaced file has a new ETag, so the match fails and the
  // full object (new bytes) is returned below.
  const inm = request.headers.get('If-None-Match');
  if (inm) {
    const head = await env.MEDIA.head(key);
    if (!head) return null;
    if (etagMatches(inm, head.etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: head.httpEtag, 'Cache-Control': 'public, max-age=60, must-revalidate' },
      });
    }
  }

  const obj = await env.MEDIA.get(key);
  if (!obj) return null;

  const headers = new Headers();
  obj.writeHttpMetadata(headers); // stored contentType (set at upload time)
  if (!headers.get('Content-Type')) headers.set('Content-Type', contentTypeForKey(key));
  headers.set('ETag', obj.httpEtag);
  // Short freshness window + revalidation so replace-in-place propagates. The
  // 304 path above keeps repeat views cheap despite the low max-age.
  headers.set('Cache-Control', 'public, max-age=60, must-revalidate');
  headers.set('X-Content-Type-Options', 'nosniff'); // never sniff a file into something executable
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}
