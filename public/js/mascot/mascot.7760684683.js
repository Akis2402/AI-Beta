'use strict';

/* =====================================================================================
   mascot.js — Akis, linh vật của Trợ Giải (VECTOR, có rig, không còn ảnh raster/khung nền).
   Ba lớp tách biệt, dễ quản lý:   akisRig.js (hình)  ·  akisPoses.js (tư thế theo tính năng)  ·  akisMotion.js (GSAP)
   File này chỉ là lớp tương thích API cũ để landing.js / mascotCompanion.js / auth không phải đổi:
     const m = AkisMascot.create({ size, state, variant:'full'|'body', track });
     m.el · m.setState(s) · m.setProp(p) · m.lookAt(nx,ny) · m.setProgress(0..1) · m.destroy()
     AkisMascot.createBubble() -> { el, say(text, ms), hide() }
   0 token AI, 0 request mạng. Có GSAP -> chuyển động đầy đủ; không có / reduced-motion -> chỉ đổi tư thế tĩnh.
   ===================================================================================== */
(function (root) {
  if (root.AkisMascot) return;

  var LEGACY = ['idle', 'wave', 'look', 'peek', 'type-email', 'hide-eyes', 'working', 'success', 'error',
    'sleepy', 'point-left', 'point-right', 'hold-card', 'spin-3d', 'celebrate'];
  var FEATURES = ['hint', 'solution', 'sources', 'visual', 'flashcard', 'formula', 'notes', 'history', 'voice', 'trust', 'tools'];
  var STATES = LEGACY.concat(FEATURES);
  var PROPS = ['none', 'card', 'pencil', 'mail', 'shield'];
  var NOTRACK = { 'point-left': 1, 'point-right': 1, 'hide-eyes': 1, sleepy: 1, peek: 1, 'spin-3d': 1 };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function div(cls) { var d = document.createElement('div'); d.className = cls; return d; }

  function create(opts) {
    opts = opts || {};
    var full = opts.variant !== 'body';
    var box = div('ak' + (full ? '' : ' ak-body-only'));
    box.setAttribute('aria-hidden', 'true');
    box.setAttribute('data-state', 'idle');
    box.setAttribute('data-prop', 'none');
    var actor = div('ak-actor'), fx = div('ak-fx');
    actor.appendChild(fx); box.appendChild(actor);
    var size = opts.size || 240;
    box.style.width = typeof size === 'number' ? size + 'px' : String(size);

    var state = 'idle', prop = 'none', raf = 0, destroyed = false, pointerOn = false, pend = null;
    var svg = null, motion = null;
    if (root.AkisRig && root.AkisMotion) {
      svg = root.AkisRig.mount(fx, { variant: full ? 'full' : 'body' });
      motion = root.AkisMotion.attach(svg, { pose: 'idle' });
    }

    function setState(next) {
      if (destroyed) return state;
      state = STATES.indexOf(next) < 0 ? 'idle' : next;
      box.setAttribute('data-state', state);
      if (motion) motion.setPose(state);
      return state;
    }
    function setProp(name) { prop = PROPS.indexOf(name) < 0 ? 'none' : name; box.setAttribute('data-prop', prop); }
    function lookAt(nx, ny) {
      var x = clamp(+nx || 0, -1, 1), y = clamp(+ny || 0, -1, 1);
      box.style.setProperty('--look-x', x.toFixed(3)); box.style.setProperty('--look-y', y.toFixed(3));
      if (motion) motion.lookAt(x, y);
    }
    function setProgress(p) { box.style.setProperty('--p', clamp(+p || 0, 0, 1).toFixed(4)); }
    function lookAtPoint(x, y) {
      var r = box.getBoundingClientRect();
      if (!r.width) return;
      lookAt((x - (r.left + r.width / 2)) / 320, (y - (r.top + r.height * 0.55)) / 260);
    }
    function onMove(e) {
      pend = e; if (raf) return;
      raf = root.requestAnimationFrame(function () {
        raf = 0; if (!pend || destroyed) return;
        if (!NOTRACK[state]) lookAtPoint(pend.clientX, pend.clientY);
        pend = null;
      });
    }
    function trackPointer(on) {
      if (on && !pointerOn) { root.addEventListener('pointermove', onMove, { passive: true }); pointerOn = true; }
      if (!on && pointerOn) { root.removeEventListener('pointermove', onMove); pointerOn = false; }
    }
    if (opts.track) trackPointer(true);
    setState(opts.state || 'idle');
    if (opts.prop) setProp(opts.prop);

    return {
      el: box, setState: setState, getState: function () { return state; }, setProp: setProp, lookAt: lookAt,
      lookAtPoint: lookAtPoint, setProgress: setProgress, trackPointer: trackPointer, motion: motion,
      destroy: function () { destroyed = true; trackPointer(false); if (motion) motion.destroy(); if (box.parentNode) box.parentNode.removeChild(box); }
    };
  }

  /** Bong bóng thoại: văn bản THẬT nằm trong vùng aria-live (linh vật thì aria-hidden). */
  function createBubble() {
    var box = document.createElement('div');
    box.className = 'ak-bubble';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    var t = document.createElement('span');
    t.className = 'ak-bubble-t';
    box.appendChild(t);
    var timer = null;
    var api = {
      el: box,
      say: function (text, ms) {
        clearTimeout(timer);
        t.textContent = text || '';
        box.classList.toggle('is-on', !!text);
        if (text && ms) timer = setTimeout(function () { api.hide(); }, ms);
      },
      hide: function () { clearTimeout(timer); box.classList.remove('is-on'); }
    };
    return api;
  }

  root.AkisMascot = { create: create, createBubble: createBubble, STATES: STATES, PROPS: PROPS, FEATURES: FEATURES };
  root.createMascot = create;
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AkisMascot;
})(typeof window !== 'undefined' ? window : globalThis);
