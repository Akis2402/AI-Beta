'use strict';
/* =====================================================================================
   uiMotion.js — lớp chuyển động UI dùng chung cho mọi trang HTML (GSAP). Chỉ là LỚP NÂNG CẤP:
   - Không có GSAP / người dùng bật "giảm chuyển động" -> không làm gì cả, trang vẫn dùng CSS như cũ.
   - Không đụng hệ reveal `.rv` có sẵn (CSS + IntersectionObserver). Chỉ tween biến CSS --mx/--my/--ps/--py,
     được motion.css gắn vào thuộc tính riêng `translate` / `scale` => không xung đột với `transform` của CSS cũ.
   Hiệu ứng: (1) nhấn nút co nhẹ  (2) CTA lớn "hút" theo con trỏ  (3) mascot hero trôi theo cuộn trang
             (4) thẻ đăng nhập trượt vào   (5) mascot hero bật vào cảnh.
   Tên selector nằm hết ở CFG bên dưới để dễ chỉnh/tắt từng hiệu ứng.
   ===================================================================================== */
(function (root) {
  if (root.UiMotion) return;
  var CFG = {
    press: '.btn, .chip, .iconbtn, .tool-btn, .sbtab, .linkbtn, .lang-btn',
    magnetic: '.btn-lg',
    heroParallax: '.hero-akis',
    enter: [{ sel: '.auth-card', y: 18 }],
    magnetPx: 7
  };
  var gs = root.gsap;
  var mq = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var on = !!gs && !(mq && mq.matches);
  var doc = document;

  function closest(t, sel) { return t && t.closest ? t.closest(sel) : null; }
  function setVar(el, name, val, dur) { gs.to(el, { [name]: val, duration: dur, ease: 'power3.out', overwrite: 'auto' }); }

  function pressFeedback() {
    var cur = null;
    doc.addEventListener('pointerdown', function (e) {
      var el = closest(e.target, CFG.press);
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      cur = el; setVar(el, '--ps', 0.965, 0.12);
    }, { passive: true });
    function release() { if (cur) { setVar(cur, '--ps', 1, 0.35); cur = null; } }
    doc.addEventListener('pointerup', release, { passive: true });
    doc.addEventListener('pointercancel', release, { passive: true });
    doc.addEventListener('pointerleave', release, { passive: true });
  }

  function magnetic() {
    [].forEach.call(doc.querySelectorAll(CFG.magnetic), function (el) {
      el.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return;
        var r = el.getBoundingClientRect();
        var nx = ((e.clientX - r.left) / r.width - 0.5) * 2, ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
        setVar(el, '--mx', (nx * CFG.magnetPx).toFixed(2) + 'px', 0.3); setVar(el, '--my', (ny * CFG.magnetPx * 0.7).toFixed(2) + 'px', 0.3);
      }, { passive: true });
      el.addEventListener('pointerleave', function () { setVar(el, '--mx', '0px', 0.5); setVar(el, '--my', '0px', 0.5); }, { passive: true });
    });
  }

  function heroParallax() {
    var el = doc.querySelector(CFG.heroParallax); if (!el) return;
    var set = gs.quickSetter(el, '--py', 'px'), raf = 0;
    function upd() { raf = 0; set(Math.min(root.scrollY, 700) * 0.1); }
    root.addEventListener('scroll', function () { if (!raf) raf = root.requestAnimationFrame(upd); }, { passive: true });
  }

  function enter() {
    CFG.enter.forEach(function (c) {
      var el = doc.querySelector(c.sel); if (!el) return;
      gs.fromTo(el, { opacity: 0, '--py': c.y + 'px' }, { opacity: 1, '--py': '0px', duration: 0.7, ease: 'power3.out', delay: 0.1, clearProps: 'opacity' });
    });
    var hero = doc.querySelector(CFG.heroParallax);
    if (hero) gs.from(hero, { opacity: 0, scale: 0.9, duration: 0.8, ease: 'back.out(1.5)', clearProps: 'opacity,scale' });
  }

  function init() {
    if (!on) return;
    doc.documentElement.classList.add('mo');
    pressFeedback(); magnetic(); heroParallax(); enter();
  }
  root.UiMotion = { init: init, enabled: function () { return on; } };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
