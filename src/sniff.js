// What an uploaded file really is, decided only by its own bytes. The type the
// browser sends, the file name and its extension are all ignored: a file named
// photo.png that is really HTML is HTML.
//
// Returns { type, ext, kind } where kind is image | video | pdf | svg | html |
// heic | other. Full signatures, not first-byte guesses.

const ascii = (b, start, end) => String.fromCharCode(...b.subarray(start, end));
const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);

// ISO base media files (MP4, MOV, AVIF, HEIC) carry 'ftyp' at offset 4, then a
// major brand and a list of compatible brands.
function ftypBrands(b) {
  if (b.length < 12 || ascii(b, 4, 8) !== 'ftyp') return null;
  const size = Math.min(b.length, (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0 || 32, 64);
  const brands = [ascii(b, 8, 12)];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(b, i, i + 4));
  return brands;
}

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

// The leading text of a file, for the two text formats, with any byte-order
// mark and leading whitespace removed and lower-cased.
function leadText(b) {
  let s = ascii(b, 0, Math.min(b.length, 1024));
  if (s.startsWith('ï»¿')) s = s.slice(3);
  return s.replace(/^\s+/, '').toLowerCase();
}

export function sniffType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { type: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: 'image/png', ext: 'png', kind: 'image' };
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return { type: 'image/gif', ext: 'gif', kind: 'image' };
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp', kind: 'image' };
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { type: 'video/webm', ext: 'webm', kind: 'video' };
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return { type: 'application/pdf', ext: 'pdf', kind: 'pdf' };

  const brands = ftypBrands(b);
  if (brands) {
    if (brands.some((x) => x === 'avif' || x === 'avis')) return { type: 'image/avif', ext: 'avif', kind: 'image' };
    if (brands.some((x) => HEIC_BRANDS.includes(x))) return { type: 'image/heic', ext: 'heic', kind: 'heic' };
    if (brands[0] === 'qt  ') return { type: 'video/quicktime', ext: 'mov', kind: 'video' };
    return { type: 'video/mp4', ext: 'mp4', kind: 'video' };
  }

  const text = leadText(b);
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) {
    return { type: 'image/svg+xml', ext: 'svg', kind: 'svg' };
  }
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || (text.startsWith('<!--') && text.includes('<html'))) {
    return { type: 'text/html; charset=utf-8', ext: 'html', kind: 'html' };
  }
  return { type: 'application/octet-stream', ext: '', kind: 'other' };
}

// What each upload purpose accepts, and how big. SVG and HTML are documents
// that can carry script, so only admins may upload them, and they are always
// served sandboxed. Anything unrecognised is an attachment: always served as a
// download, never inline.
export const MB = 1024 * 1024;
export const UPLOAD_CAPS = { image: 8 * MB, video: 50 * MB, pdf: 25 * MB, svg: 2 * MB, html: 2 * MB, other: 25 * MB };
// The most any upload request may carry, checked before the body is read.
export const MAX_UPLOAD_REQUEST = 51 * MB;

// Why this file can't be stored for this purpose, or null.
//   purpose 'library' — the media library, and Replace
//   purpose 'photo'   — a person's photo (images only)
export function uploadError(sniffed, size, { purpose, isAdmin }) {
  const { kind } = sniffed;
  if (kind === 'heic') return 'HEIC photos (the iPhone default) can\'t be used on the web. Export the photo as a JPEG first: on an iPhone, Settings › Camera › Formats › Most Compatible, or share it to Files as JPEG.';
  if (purpose === 'photo' && kind !== 'image') return 'A photo needs to be a JPEG, PNG, WebP, GIF or AVIF image.';
  if ((kind === 'svg' || kind === 'html') && !isAdmin) return 'Only an admin can upload SVG or HTML files, because they can contain script.';
  const cap = UPLOAD_CAPS[kind];
  if (size > cap) return `That file is ${(size / MB).toFixed(1)} MB. The limit for this kind of file is ${cap / MB} MB.`;
  return null;
}

// Whether a stored type may be shown in the page (an <img>, <video>, an
// iframe for PDF or HTML, a web font) rather than served as a download.
export function servedInline(contentType) {
  const t = String(contentType || '').toLowerCase();
  return t.startsWith('image/') || t.startsWith('video/') || t.startsWith('font/')
    || t.startsWith('application/pdf') || t.startsWith('text/html');
}

// The upload checks, in the order the standard gives them: Content-Length
// before the body is read (a request without one is refused), then the file's
// size, then its bytes and what they really are. Returns { file, bytes,
// sniffed, form } or { error, status }.
export async function readUpload(request, { purpose, isAdmin, field = 'file' }) {
  const declared = Number(request.headers.get('Content-Length'));
  if (!declared) return { error: 'The upload arrived without a size, so it was refused. Please try again.', status: 411 };
  if (declared > MAX_UPLOAD_REQUEST) return { error: `That upload is too large. The biggest file allowed is ${MAX_UPLOAD_REQUEST / MB - 1} MB.`, status: 413 };
  let form;
  try { form = await request.formData(); } catch { return { error: "The upload couldn't be read. Please try again.", status: 400 }; }
  const file = form.get(field);
  if (!file || typeof file === 'string' || !file.size) return { error: 'Choose a file to upload.', status: 400, form };
  if (file.size > MAX_UPLOAD_REQUEST) return { error: 'That file is too large.', status: 413, form };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffType(bytes);
  const error = uploadError(sniffed, bytes.length, { purpose, isAdmin });
  if (error) return { error, status: 415, form };
  return { file, bytes, sniffed, form };
}

// The file name to build a key from: the sniffed extension replaces whatever
// the uploader's file name said, so a key never claims to be something else.
export function nameWithSniffedExt(filename, sniffed) {
  const name = String(filename || 'file');
  if (!sniffed.ext) return name;
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name) + '.' + sniffed.ext;
}
