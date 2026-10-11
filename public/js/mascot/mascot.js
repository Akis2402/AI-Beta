'use strict';

/* =====================================================================================
   mascot.js — Akis, linh vật của Trợ Giải.

   DÙNG ĐÚNG ẢNH GỐC do bạn cung cấp (public/js/mascot/akisImage.js chứa chính ảnh đó: chỉ cắt khung và
   thu nhỏ, KHÔNG vẽ lại, KHÔNG dùng AI sinh ảnh). Mọi "biểu cảm" chỉ là chuyển động của chính tấm ảnh
   (dịch, nghiêng, nảy, phát sáng) bằng CSS transform/filter — không thêm nét vẽ nào vào ảnh.
   - 0 token AI, 0 request mạng (ảnh nhúng sẵn dạng data URI; thiếu thì dự phòng /favicon.svg, cũng là ảnh này).
   - Trạng thái: idle, wave, look, peek, type-email, hide-eyes, working, success, error,
                 sleepy, point-left, point-right, hold-card, spin-3d, celebrate.
   - setProp() được giữ để tương thích API; với ảnh đơn nó không đổi hình (không vẽ thêm đồ vật).
   API:  const m = AkisMascot.create({ size, state, variant:'full'|'body', track });
         m.el · m.setState(s) · m.setProp(p) · m.lookAt(nx,ny) · m.setProgress(0..1) · m.destroy()
         AkisMascot.createBubble() -> { el, say(text, ms), hide() }
   ===================================================================================== */
(function (root) {
  if (root.AkisMascot) return;

  var STATES = ['idle', 'wave', 'look', 'peek', 'type-email', 'hide-eyes', 'working', 'success', 'error',
    'sleepy', 'point-left', 'point-right', 'hold-card', 'spin-3d', 'celebrate'];
  var PROPS = ['none', 'card', 'pencil', 'mail', 'shield'];

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
    var img = new Image();
    img.className = 'ak-img';
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    var dim = root.AKIS_IMG_SIZE || [560, 410];
    img.width = dim[0]; img.height = dim[1];
    img.src = root.AKIS_IMG || '/favicon.svg';
    fx.appendChild(img); actor.appendChild(fx); box.appendChild(actor);
    var size = opts.size || 240;
    box.style.width = typeof size === 'number' ? size + 'px' : String(size);

    var state = 'idle', prop = 'none', raf = 0, destroyed = false, pointerOn = false, pend = null;

    function setState(next) {
      if (destroyed) return state;
      state = STATES.indexOf(next) < 0 ? 'idle' : next;
      box.setAttribute('data-state', state);
      return state;
    }
    function setProp(name) { prop = PROPS.indexOf(name) < 0 ? 'none' : name; box.setAttribute('data-prop', prop); }
    function lookAt(nx, ny) {
      box.style.setProperty('--look-x', clamp(+nx || 0, -1, 1).toFixed(3));
      box.style.setProperty('--look-y', clamp(+ny || 0, -1, 1).toFixed(3));
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
        if (state === 'idle' || state === 'look' || state === 'wave' || state === 'working') lookAtPoint(pend.clientX, pend.clientY);
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
      lookAtPoint: lookAtPoint, setProgress: setProgress, trackPointer: trackPointer,
      destroy: function () { destroyed = true; trackPointer(false); if (box.parentNode) box.parentNode.removeChild(box); }
    };
  }

  /** Bong bóng thoại: văn bản THẬT nằm trong vùng aria-live (ảnh linh vật thì aria-hidden). */
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

  root.AkisMascot = { create: create, createBubble: createBubble, STATES: STATES, PROPS: PROPS };
  root.createMascot = create;
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AkisMascot;
})(typeof window !== 'undefined' ? window : globalThis);
