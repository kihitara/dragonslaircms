// DragonslairCMS — dependency-free colour picker for admin colour fields.
// The native <input type="color"> is unusable on iOS (its HSB sliders reset to
// zero), so this replaces it: attach to any <input type="text" class="color-field">
// and a swatch button appears before the field; clicking it opens an inline
// popover with a saturation/value square, a hue slider and a hex input — all
// initialised from the field's CURRENT value. Dragging (pointer events, mouse
// and touch alike) live-updates the field, its swatch and the popover hex.
// Manual typing in the field still works (#rrggbb) and repaints the swatch.
// Closes on outside pointerdown or Escape. Pure DOM + CSS gradients, no canvas.
(function () {
  'use strict';
  if (window.COLOR_PICKER) return;

  var HEX6 = /^#[0-9a-fA-F]{6}$/;

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  function hexToRgb(hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }
  function rgbToHex(r, g, b) {
    function h(x) { x = Math.max(0, Math.min(255, Math.round(x))); return (x < 16 ? '0' : '') + x.toString(16); }
    return ('#' + h(r) + h(g) + h(b)).toUpperCase();
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h: h, s: max ? d / max : 0, v: max };
  }
  function hsvToRgb(h, s, v) {
    var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }

  // One popover at a time. `silent` marks our own field writes so the field's
  // input listener doesn't feed the value straight back into the picker
  // (hex→HSV loses the hue for greys, which would snap sliders mid-drag).
  var open = null; // { pop, btn, input, silent, setHex }

  function closePop() { if (open) { open.pop.remove(); open = null; } }

  document.addEventListener('pointerdown', function (e) {
    if (open && !open.pop.contains(e.target) && !open.btn.contains(e.target)) closePop();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });

  function attach(input) {
    if (!input || input.getAttribute('data-cp-done')) return;
    input.setAttribute('data-cp-done', '1');

    var wrap = document.createElement('span'); wrap.className = 'cp-wrap';
    input.parentNode.insertBefore(wrap, input);
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'cp-swatch'; btn.title = 'Pick a colour';
    btn.setAttribute('aria-label', 'Open colour picker');
    wrap.appendChild(btn); wrap.appendChild(input);

    function paintSwatch() {
      var v = input.value.trim();
      btn.style.background = v || 'transparent'; // any CSS colour previews; junk = transparent
      btn.classList.toggle('cp-swatch-empty', !v);
    }
    paintSwatch();

    input.addEventListener('input', function () {
      paintSwatch();
      var v = input.value.trim();
      if (open && open.input === input && !open.silent && HEX6.test(v)) open.setHex(v);
    });

    btn.addEventListener('click', function () {
      if (open && open.input === input) { closePop(); return; } // toggle
      openPicker(wrap, btn, input, paintSwatch);
    });
  }

  function openPicker(wrap, btn, input, paintSwatch) {
    closePop();
    var pop = document.createElement('div'); pop.className = 'cp-pop';
    pop.innerHTML =
      '<div class="cp-sv"><div class="cp-thumb"></div></div>' +
      '<div class="cp-hue"><div class="cp-hue-thumb"></div></div>' +
      '<div class="cp-hex-row"><span>Hex</span><input type="text" spellcheck="false" maxlength="7" aria-label="Hex colour"></div>';
    wrap.appendChild(pop);

    var sv = pop.querySelector('.cp-sv');
    var svThumb = pop.querySelector('.cp-thumb');
    var hueBar = pop.querySelector('.cp-hue');
    var hueThumb = pop.querySelector('.cp-hue-thumb');
    var hexInput = pop.querySelector('.cp-hex-row input');

    // Initialise from the field's current value — the whole point.
    var seed = input.value.trim();
    if (!HEX6.test(seed)) seed = '#888888';
    var rgb0 = hexToRgb(seed);
    var hsv = rgbToHsv(rgb0.r, rgb0.g, rgb0.b);

    function currentHex() { var c = hsvToRgb(hsv.h, hsv.s, hsv.v); return rgbToHex(c.r, c.g, c.b); }

    function render() {
      var hue = 'hsl(' + Math.round(hsv.h) + ',100%,50%)';
      sv.style.background = 'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ' + hue + ')';
      svThumb.style.left = (hsv.s * 100) + '%';
      svThumb.style.top = ((1 - hsv.v) * 100) + '%';
      svThumb.style.background = currentHex();
      hueThumb.style.left = (hsv.h / 360 * 100) + '%';
    }

    // hsv → field (with input event for other listeners) + swatch + hex box.
    function push() {
      var hex = currentHex();
      state.silent = true;
      input.value = hex;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      state.silent = false;
      hexInput.value = hex;
      paintSwatch();
      render();
    }

    function setHex(hex) { // field was typed into while the popover is open
      var c = hexToRgb(hex);
      hsv = rgbToHsv(c.r, c.g, c.b);
      hexInput.value = hex.toUpperCase();
      render();
    }

    var state = { pop: pop, btn: btn, input: input, silent: false, setHex: setHex };
    hexInput.value = seed.toUpperCase();
    render();
    open = state;

    // Keep the popover on-screen (right edge on narrow viewports; flip above
    // the field when there's no room below).
    var r = pop.getBoundingClientRect();
    var shift = 0;
    if (r.right > window.innerWidth - 8) shift = (window.innerWidth - 8) - r.right;
    if (r.left + shift < 8) shift = 8 - r.left;
    if (shift) pop.style.left = shift + 'px';
    if (r.bottom > window.innerHeight - 8 && r.top - r.height - 12 > 0) {
      pop.style.top = 'auto'; pop.style.bottom = 'calc(100% + 6px)';
    }

    // Shared drag wiring: pointer capture keeps the drag alive when the
    // pointer (mouse or finger) leaves the element mid-drag.
    function dragify(el, onMove) {
      el.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* stale pointer id */ }
        onMove(e);
        function move(ev) { onMove(ev); }
        function up() {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        }
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    }

    dragify(sv, function (e) {
      var b = sv.getBoundingClientRect();
      hsv.s = clamp01((e.clientX - b.left) / b.width);
      hsv.v = 1 - clamp01((e.clientY - b.top) / b.height);
      push();
    });
    dragify(hueBar, function (e) {
      var b = hueBar.getBoundingClientRect();
      hsv.h = clamp01((e.clientX - b.left) / b.width) * 359.99;
      push();
    });

    hexInput.addEventListener('input', function () {
      var v = hexInput.value.trim();
      if (v && v[0] !== '#') v = '#' + v;
      if (!HEX6.test(v)) return; // keep typing; only valid #rrggbb applies
      var c = hexToRgb(v);
      hsv = rgbToHsv(c.r, c.g, c.b);
      state.silent = true;
      input.value = v.toUpperCase();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      state.silent = false;
      paintSwatch();
      render();
    });
    hexInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); closePop(); } });

    hexInput.focus();
    hexInput.select();
  }

  function upgradeAll(scope) {
    (scope || document).querySelectorAll('input.color-field').forEach(attach);
  }

  window.COLOR_PICKER = { attach: attach, upgradeAll: upgradeAll };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { upgradeAll(document); });
  else upgradeAll(document);
})();
