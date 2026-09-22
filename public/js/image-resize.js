// Client-side image downscaling + WebP re-encoding, shared by the media picker
// and the media-library upload form. Big phone photos are shrunk to web sizes
// BEFORE they reach R2 — smaller uploads (hotel wifi), smaller storage, smaller
// egress. Mirrors the canvas approach in emoticon-upload.js. Exposes
// window.IMG_RESIZE. SVGs and non-images are left untouched.
(function () {
  if (window.IMG_RESIZE) return;

  var MAX_WIDTH = 2048;             // never store anything wider than this
  var WIDTHS = [512, 1024, 2048];  // responsive variants (kept only if < source)
  var QUALITY = 0.82;

  function isImage(file) {
    var t = (file && file.type) || '';
    return /^image\//.test(t) && !/svg/i.test(t); // SVGs are vector — don't raster them
  }

  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }
  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  // Draw `source` to a w×h canvas and encode to WebP (JPEG fallback if the
  // browser can't produce WebP). Resolves { blob, type, ext } or null.
  function encode(source, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        if (blob) return resolve({ blob: blob, type: 'image/webp', ext: 'webp' });
        canvas.toBlob(function (jpg) {
          resolve(jpg ? { blob: jpg, type: 'image/jpeg', ext: 'jpg' } : null);
        }, 'image/jpeg', QUALITY);
      }, 'image/webp', QUALITY);
    });
  }

  // toVariants(file, { single }) → { variants: [{ w, h, blob, type, ext }], width, height }.
  // Variants are each target width <= the source width, plus the source width
  // capped at MAX_WIDTH, largest last. `single: true` produces only the capped
  // width (for the library upload, which doesn't need a srcset set).
  function toVariants(file, opts) {
    opts = opts || {};
    return decode(file).then(function (src) {
      var sw = src.width || src.naturalWidth;
      var sh = src.height || src.naturalHeight;
      var cap = Math.min(sw, MAX_WIDTH);
      var targets;
      if (opts.single) {
        targets = [cap];
      } else {
        targets = WIDTHS.filter(function (w) { return w < cap; });
        targets.push(cap);
        targets = targets.filter(function (w, i, a) { return a.indexOf(w) === i; }).sort(function (a, b) { return a - b; });
      }
      var out = [];
      var chain = Promise.resolve();
      targets.forEach(function (w) {
        var h = Math.round(w * sh / sw);
        chain = chain.then(function () {
          return encode(src, w, h).then(function (enc) { if (enc) out.push({ w: w, h: h, blob: enc.blob, type: enc.type, ext: enc.ext }); });
        });
      });
      return chain.then(function () {
        if (src.close) src.close();
        return { variants: out, width: cap, height: Math.round(cap * sh / sw) };
      });
    });
  }

  window.IMG_RESIZE = { isImage: isImage, toVariants: toVariants, MAX_WIDTH: MAX_WIDTH, WIDTHS: WIDTHS };
})();
