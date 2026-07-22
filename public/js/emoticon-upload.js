// DragonslairCMS emoticon upload transform (admin Emoticons page). Intercepts
// the [data-emoticon-upload] form: decodes the chosen file in the browser,
// draws it onto a 200×200 canvas — scaled to CONTAIN and centred, transparent
// padding, never cropped — and POSTs the resulting PNG as multipart FormData
// (file named <slug>.png, json=1) to /admin/emoticons/upload. The server only
// ever sees ready-made 200×200 PNGs; Workers have no image codecs.
// Without this script the form posts the raw file and the server politely
// rejects anything that isn't already a 200×200 PNG.
(function () {
  'use strict';

  var SIZE = 200;

  function showMsg(box, text) {
    if (!box) { window.alert(text); return; }
    box.textContent = text;
    box.hidden = false;
  }

  // Decode a File to something drawImage accepts. createImageBitmap where
  // available; <img> + object URL as the fallback. Rejects on undecodable files.
  function decode(file) {
    if (window.createImageBitmap) return window.createImageBitmap(file);
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  // source (ImageBitmap | HTMLImageElement) → 200×200 contain-fitted PNG Blob.
  function toPngBlob(source) {
    var w = source.width || source.naturalWidth;
    var h = source.height || source.naturalHeight;
    if (!w || !h) return Promise.reject(new Error('empty image'));
    var canvas = document.createElement('canvas');
    canvas.width = SIZE; canvas.height = SIZE;
    var ctx = canvas.getContext('2d');
    var scale = Math.min(SIZE / w, SIZE / h);          // contain — never crop
    var dw = w * scale, dh = h * scale;
    ctx.drawImage(source, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh); // centred
    if (source.close) source.close();
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('PNG encode failed')); }, 'image/png');
    });
  }

  function init() {
    var form = document.querySelector('form[data-emoticon-upload]');
    if (!form) return;
    var msg = document.querySelector('[data-emo-upload-msg]');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (msg) msg.hidden = true;

      var fileInput = form.querySelector('input[name=file]');
      var file = fileInput && fileInput.files && fileInput.files[0];
      var slug = (form.querySelector('input[name=slug]') || {}).value || '';
      slug = slug.trim();
      if (!file) { showMsg(msg, 'Choose an image to upload.'); return; }
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
        showMsg(msg, 'Slugs are lowercase letters, digits and single hyphens — e.g. dragon-tail.');
        return;
      }

      var button = form.querySelector('button[type=submit]');
      if (button) { button.disabled = true; button.textContent = 'Converting…'; }
      function done() { if (button) { button.disabled = false; button.textContent = 'Upload'; } }

      decode(file)
        .then(toPngBlob)
        .then(function (blob) {
          var fd = new FormData();
          fd.append('file', new File([blob], slug + '.png', { type: 'image/png' }));
          fd.append('slug', slug);
          fd.append('category', (form.querySelector('select[name=category]') || {}).value || '');
          fd.append('new_category', (form.querySelector('input[name=new_category]') || {}).value || '');
          fd.append('json', '1');
          if (button) button.textContent = 'Uploading…';
          return fetch(form.getAttribute('action') || '/admin/emoticons/upload', {
            method: 'POST', body: fd, credentials: 'same-origin',
          });
        })
        .then(function (r) { return r.json().catch(function () { return { error: 'Unexpected server reply (HTTP ' + r.status + ').' }; }); })
        .then(function (d) {
          if (d && d.ok) { window.location.href = d.redirect || '/admin/emoticons'; return; }
          done(); showMsg(msg, (d && d.error) || 'Upload failed — please try again.');
        })
        .catch(function () {
          done();
          showMsg(msg, 'That file could not be read as an image — try a PNG, JPEG, GIF or WebP.');
        });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
