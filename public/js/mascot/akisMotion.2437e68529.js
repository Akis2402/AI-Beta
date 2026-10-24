'use strict';
/* =====================================================================================
   akisMotion.js — ENGINE chuyển động của Akis (GSAP). Tách riêng khỏi hình (akisRig.js) và dữ liệu (akisPoses.js).
   - Có GSAP: tween mượt, vòng lặp theo từng tính năng, nhìn theo con trỏ, ambient (trôi, chớp mắt, lấp lánh).
   - Không có GSAP / prefers-reduced-motion: vẫn đổi đúng tư thế (tĩnh), không vòng lặp. Trang không bao giờ hỏng.
   API:  const m = AkisMotion.attach(svgEl); m.setPose(name) · m.getPose() · m.lookAt(nx,ny) · m.pause() · m.resume() · m.destroy()
   ===================================================================================== */
(function (root) {
  if (root.AkisMotion) return;
  var POSES = function () { return root.AKIS_POSES || { idle: { eyes: 'open', mouth: 'smile', props: [], loop: 'idle' } }; };
  var PARTS = ['mascot-root', 'body-hood', 'face', 'eye-left', 'eye-wink', 'eye-right', 'mouth', 'swirl', 'book', 'note-paper',
    'burst-rays', 'bulb', 'bulb-glow', 'bulb-rays', 'sparkle-left', 'sparkle-bottom', 'note-motion-lines', 'bulb-motion-line'];
  var ALL_EYES = ['eye-left', 'eye-wink', 'eye-right', 'eyes-happy', 'eyes-closed'];
  var EYE_SETS = { open: ['eye-left', 'eye-wink'], both: ['eye-left', 'eye-right'], happy: ['eyes-happy'], closed: ['eyes-closed'], hidden: [] };
  var MOUTHS = { smile: 'mouth', open: 'mouth-open', o: 'mouth-o', flat: 'mouth-flat', sad: 'mouth-sad', grin: 'mouth-grin' };
  var ALL_PROPS = ['glasses', 'sweat', 'blush', 'solution-scribbles', 'prop-pencil', 'prop-magnifier', 'prop-cite', 'prop-graph', 'prop-cube', 'prop-flashcard',
    'prop-formula', 'prop-note', 'prop-clock', 'prop-mic', 'prop-shield', 'prop-lock', 'prop-meter', 'prop-mail', 'prop-dots', 'prop-zzz',
    'prop-question', 'prop-exclaim', 'prop-check', 'prop-hearts', 'prop-confetti', 'hand-left', 'hand-right'];
  var reduceMQ = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)');
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function attach(svg, opts) {
    opts = opts || {};
    var gs = root.gsap;
    var reduce = !!(reduceMQ && reduceMQ.matches) || opts.reduced === true;
    var live = !!gs && !reduce;              // có chuyển động
    var el = {}, cache = {};
    function $(k) { return cache[k] || (cache[k] = svg.querySelector('[data-k="' + k + '"]')); }
    function $$(sel, k) { var p = $(k); return p ? [].slice.call(p.querySelectorAll(sel)) : []; }
    PARTS.concat(ALL_EYES, ALL_PROPS, Object.keys(MOUTHS).map(function (m) { return MOUTHS[m]; })).forEach(function (k) { el[k] = $(k); });

    var pose = null, poseName = '', tweens = [], ambient = {}, cycleTimer = 0, destroyed = false;
    var lookState = { x: 0, y: 0 };

    // ---------- tiện ích hiển thị (có / không GSAP)
    function setStatic(node, v) {
      if (!node) return;
      var s = node.style; s.transformBox = 'fill-box'; s.transformOrigin = '50% 50%';
      var x = v.x || 0, y = v.y || 0, r = v.rotation || 0, sx = v.scaleX != null ? v.scaleX : (v.scale != null ? v.scale : 1), sy = v.scaleY != null ? v.scaleY : (v.scale != null ? v.scale : 1);
      s.transform = 'translate(' + x + 'px,' + y + 'px) rotate(' + r + 'deg) scale(' + sx + ',' + sy + ')';
      if (v.opacity != null) s.opacity = v.opacity;
    }
    function vis(k, on, enter) {
      var n = el[k] || $(k); if (!n) return;
      if (!live) { n.style.opacity = on ? 1 : 0; return; }
      if (on) {
        if (enter) gs.fromTo(n, { opacity: 0, scale: 0.7, transformOrigin: '50% 50%' }, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(1.9)', overwrite: 'auto' });
        else gs.to(n, { opacity: 1, duration: 0.2, overwrite: 'auto' });
      } else gs.to(n, { opacity: 0, scale: enter ? 0.85 : 1, duration: 0.2, overwrite: 'auto' });
    }
    // tween do loop tạo ra -> được theo dõi để dọn khi đổi pose
    var T = {
      to: function (t, v) { if (!live || !t) return null; var tw = gs.to(t, v); tweens.push(tw); return tw; },
      fromTo: function (t, a, b) { if (!live || !t) return null; var tw = gs.fromTo(t, a, b); tweens.push(tw); return tw; },
      set: function (t, v) { if (live && t) gs.set(t, v); else if (t) setStatic(t, v); },
      tl: function (v) { var tl = gs.timeline(v || {}); tweens.push(tl); return tl; }
    };
    function killLoop() {
      tweens.forEach(function (t) { try { t.kill(); } catch (e) { /* noop */ } }); tweens = [];
      clearInterval(cycleTimer); cycleTimer = 0;
    }

    // ---------- AMBIENT: luôn chạy dưới nền (trôi, chớp mắt, lấp lánh, bóng đèn)
    function startAmbient() {
      if (!live) return;
      var A = ambient;
      A.float = gs.to(el['mascot-root'], { y: -6, duration: 1.9, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      A.swirl = gs.to(el['swirl'], { rotation: -4, svgOrigin: '586 540', duration: 4.5, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      A.paper = gs.to(el['note-paper'], { rotation: -2.5, yPercent: -3, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      A.bulb = gs.to(el['bulb-glow'], { opacity: 0.55, scale: 1.1, duration: 1.4, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      A.brays = gs.to(el['bulb-rays'], { opacity: 0.72, duration: 1.2, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 0.4 });
      A.burst = gs.to(el['burst-rays'], { opacity: 0.78, duration: 1.05, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      A.spL = gs.to(el['sparkle-left'], { opacity: 0.55, scale: 1.12, duration: 1.3, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      A.spB = gs.to(el['sparkle-bottom'], { opacity: 0.55, scale: 1.12, duration: 1.55, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 0.9 });
      (function blink() {
        if (destroyed) return;
        A.blink = gs.timeline({ delay: rnd(2.2, 5), onComplete: blink })
          .to([el['eye-left'], el['eye-right']], { scaleY: 0.1, duration: 0.07, ease: 'power2.in', transformOrigin: '50% 50%' })
          .to([el['eye-left'], el['eye-right']], { scaleY: 1, duration: 0.12, ease: 'power2.out' });
      })();
    }
    function ambientFor(name, on) { var a = ambient[name]; if (a) { on ? a.resume() : a.pause(); } }
    var OFF = { wave: ['swirl'], think: ['swirl', 'bulb'], cheer: ['float'], joy: ['float'], spin: ['float'], shake: ['float'] };

    // ---------- VÒNG LẶP theo từng pose / tính năng
    var LOOPS = {
      idle: function () {},
      wave: function () {
        T.to(el['swirl'], { rotation: -16, svgOrigin: '586 540', duration: 0.35, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.to(el['mascot-root'], { rotation: 2.5, duration: 0.6, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      },
      read: function () {      // HƯỚNG GIẢI — đeo kính, đọc sách, bóng đèn "à ha"
        var eyes = [el['eye-left'], el['eye-right']];
        T.set(eyes, { y: 6 });
        T.to(eyes, { x: 7, duration: 0.9, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.to(el['book'], { rotation: -1.6, duration: 1.4, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.to(el['prop-question'], { y: -8, duration: 0.9, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.tl({ repeat: -1, repeatDelay: 2.6 }).to(el['bulb-glow'], { scale: 1.8, opacity: 1, duration: 0.22 }).to(el['bulb-glow'], { scale: 1.1, opacity: 0.8, duration: 0.5 });
      },
      write: function () {     // LỜI GIẢI CHI TIẾT — cầm bút viết từng bước
        var p = el['prop-pencil'], sc = $('solution-scribbles');
        var path = sc && sc.querySelector('path');
        T.set(el['eye-left'], { x: -4, y: 5 }); T.set(el['eye-wink'], { x: -4, y: 5 });
        if (path) { T.set(path, { strokeDashoffset: 1 }); T.tl({ repeat: -1, repeatDelay: 0.7 }).to(path, { strokeDashoffset: 0, duration: 2.6, ease: 'none' }).to(path, { opacity: 0.0, duration: 0.3 }).set(path, { opacity: 1 }); }
        var tl = T.tl({ repeat: -1 });
        [[10, -4], [24, 0], [38, -4], [26, 6], [14, 18], [28, 20], [42, 18], [28, 30], [12, 36], [0, 0]].forEach(function (pt) { tl.to(p, { x: pt[0], y: pt[1], duration: 0.26, ease: 'sine.inOut' }); });
        T.to(el['note-paper'], { x: 3, duration: 0.12, yoyo: true, repeat: -1, ease: 'none' });
      },
      scan: function () {      // TÀI LIỆU — kính lúp rà từng dòng, huy hiệu trích nguồn nảy lên
        var m = el['prop-magnifier'], eyes = [el['eye-left'], el['eye-right']];
        T.to(m, { x: 30, y: 14, rotation: 8, duration: 1.3, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.to(eyes, { x: -6, y: 4, duration: 1.3, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.tl({ repeat: -1, repeatDelay: 1.4 }).fromTo(el['prop-cite'], { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: 'back.out(2.4)' }).to(el['prop-cite'], { y: -10, duration: 0.6, yoyo: true, repeat: 1 });
      },
      plot: function () {      // HÌNH MINH HỌA — đồ thị tự vẽ, khối 3D xoay
        var curve = $('graph-curve'), dot = $('graph-dot'), prox = { t: 0 };
        T.set([el['eye-left'], el['eye-right']], { x: 6, y: -3 });
        T.set(curve, { strokeDashoffset: 1 });
        var P0 = [-42, -30], C = [-4, 96], P2 = [38, -30];
        function upd() { var t = prox.t, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t; if (dot) { dot.setAttribute('cx', a * P0[0] + b * C[0] + c * P2[0]); dot.setAttribute('cy', a * P0[1] + b * C[1] + c * P2[1]); } }
        T.tl({ repeat: -1, repeatDelay: 0.8 }).set(prox, { t: 0 }).to(curve, { strokeDashoffset: 0, duration: 1.8, ease: 'power1.inOut' }, 0).to(prox, { t: 1, duration: 1.8, ease: 'power1.inOut', onUpdate: upd }, 0);
        T.to(el['prop-cube'], { scaleX: -1, duration: 1.5, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      },
      flip: function () {      // ÔN TẬP — flashcard lật
        var c = el['prop-flashcard'], f = $('fc-front'), b = $('fc-back');
        T.set(f, { opacity: 1 }); T.set(b, { opacity: 0 });
        var tl = T.tl({ repeat: -1 });
        tl.to({}, { duration: 1.3 }).to(c, { scaleX: 0, duration: 0.2, ease: 'power2.in' }).set(f, { opacity: 0 }).set(b, { opacity: 1 }).to(c, { scaleX: 1, duration: 0.25, ease: 'back.out(2)' })
          .to({}, { duration: 1.3 }).to(c, { scaleX: 0, duration: 0.2, ease: 'power2.in' }).set(f, { opacity: 1 }).set(b, { opacity: 0 }).to(c, { scaleX: 1, duration: 0.25, ease: 'back.out(2)' });
      },
      glyphs: function () {    // CÔNG THỨC — ký hiệu toán bay lơ lửng
        ['fx-1', 'fx-2', 'fx-3', 'fx-4'].forEach(function (k, i) { var n = $(k); T.to(n, { y: -9, rotation: i % 2 ? 6 : -6, duration: 1.1 + i * 0.15, yoyo: true, repeat: -1, ease: 'sine.inOut', delay: i * 0.18 }); });
        T.set([el['eye-left'], el['eye-right']], { y: -3 });
      },
      sticky: function () {    // GHI CHÚ — giấy nhớ, bút ghi nhanh
        T.to(el['prop-note'], { rotation: 3, duration: 1.2, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        var tl = T.tl({ repeat: -1 }), p = el['prop-pencil'];
        [[6, -3], [18, 1], [4, 10], [20, 13], [0, 0]].forEach(function (pt) { tl.to(p, { x: pt[0], y: pt[1], duration: 0.24, ease: 'sine.inOut' }); });
        T.set([el['eye-left'], el['eye-wink']], { x: -4, y: 4 });
      },
      rewind: function () {    // LỊCH SỬ — kim đồng hồ quay ngược
        T.to($('clock-min'), { rotation: -360, svgOrigin: '905 520', duration: 1.6, ease: 'none', repeat: -1 });
        T.to($('clock-hr'), { rotation: -360, svgOrigin: '905 520', duration: 9.6, ease: 'none', repeat: -1 });
        T.set([el['eye-left'], el['eye-right']], { x: 6, y: -2 });
      },
      talk: function () {      // GIỌNG NÓI — mic phát sóng, miệng mở khép
        var w = $$('path', 'mic-waves');
        T.tl({ repeat: -1 }).fromTo(w, { opacity: 0.15 }, { opacity: 1, duration: 0.25, stagger: 0.16 }).to(w, { opacity: 0.15, duration: 0.3 });
        T.to(el['mouth-open'], { scaleY: 0.5, transformOrigin: '50% 0%', duration: 0.17, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.to(el['prop-mic'], { rotation: -5, duration: 0.6, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      },
      guard: function () {     // MINH BẠCH — khiên, khoá, thanh hạn mức
        T.to(el['prop-shield'], { scale: 1.09, duration: 0.9, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.to(el['prop-lock'], { y: -6, duration: 0.8, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        var mf = $('meter-fill'); if (mf) T.fromTo(mf, { attr: { width: 20 } }, { attr: { width: 128 }, duration: 2.4, ease: 'power1.inOut', yoyo: true, repeat: -1 });
      },
      think: function () {     // ĐANG XỬ LÝ — chấm nhảy, vòng xoáy quay
        var d = $$('circle', 'prop-dots');
        T.to(d, { y: -14, duration: 0.35, yoyo: true, repeat: -1, stagger: 0.12, ease: 'sine.inOut' });
        T.to(el['swirl'], { rotation: 360, svgOrigin: '586 540', duration: 2.2, repeat: -1, ease: 'none' });
        T.set([el['eye-left'], el['eye-right']], { x: 6, y: -6 });
        T.to(el['prop-question'], { rotation: 8, duration: 0.7, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.to(el['bulb-glow'], { opacity: 1, scale: 1.4, duration: 0.3, yoyo: true, repeat: -1, ease: 'steps(2)' });
      },
      sleep: function () {
        var z = $$('text', 'prop-zzz');
        T.fromTo(z, { y: 0, opacity: 0 }, { y: -22, opacity: 1, duration: 1.4, repeat: -1, stagger: 0.45, ease: 'sine.out', yoyo: false });
        T.to(el['face'], { y: 5, duration: 2.4, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      },
      cheer: function () {
        var r = el['mascot-root'];
        T.to(r, { yPercent: -6, scaleY: 1.03, duration: 0.3, yoyo: true, repeat: -1, ease: 'power2.out', transformOrigin: '50% 100%' });
        $$('.cf', 'prop-confetti').forEach(function (n, i) { T.fromTo(n, { x: 0, y: 0, opacity: 1, rotation: 0 }, { x: rnd(-60, 60), y: rnd(60, 150), rotation: rnd(-260, 260), opacity: 0, duration: rnd(1, 1.6), repeat: -1, delay: i * 0.12, ease: 'power1.in' }); });
      },
      joy: function () {
        var r = el['mascot-root'];
        T.tl({ repeat: -1, repeatDelay: 1.2 }).to(r, { yPercent: -7, duration: 0.25, ease: 'power2.out', transformOrigin: '50% 100%' }).to(r, { yPercent: 0, duration: 0.35, ease: 'bounce.out' });
        T.fromTo(el['prop-check'], { scale: 0 }, { scale: 1, duration: 0.5, ease: 'back.out(2.6)' });
        $$('path', 'prop-hearts').forEach(function (n, i) { T.fromTo(n, { y: 0, opacity: 1 }, { y: -50, opacity: 0, duration: 1.5, repeat: -1, delay: i * 0.4, ease: 'sine.out' }); });
      },
      shake: function () {
        var tl = T.tl({ repeat: -1, repeatDelay: 1.6 }), r = el['mascot-root'];
        [-12, 10, -7, 5, 0].forEach(function (x) { tl.to(r, { x: x, duration: 0.07 }); });
        T.fromTo(el['sweat'], { y: 0, opacity: 1 }, { y: 20, opacity: 0.2, duration: 1.1, repeat: -1, ease: 'sine.in' });
        T.fromTo(el['prop-exclaim'], { scale: 0.4 }, { scale: 1, duration: 0.4, ease: 'back.out(3)' });
      },
      nod: function () {
        T.to(el['face'], { y: 5, duration: 0.8, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.to(el['prop-mail'], { rotation: -3, y: -4, duration: 0.8, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      },
      peek: function () { T.to([el['eye-left'], el['eye-right']], { x: 6, duration: 1.2, yoyo: true, repeat: -1, ease: 'sine.inOut' }); },
      // Hai tay mitten trượt từ dưới lên che mắt (đã vẽ sẵn đúng vị trí che trong rig); sau đó chỉ nhún nhẹ.
      // Không GSAP/reduced-motion: engine chỉ bật opacity (xem vis()) => tay hiện đúng vị trí che, không chuyển động.
      hide: function () {
        var l = el['hand-left'], r = el['hand-right'];
        T.fromTo(l, { y: 110, x: -26, rotation: -18 }, { y: 0, x: 0, rotation: 0, duration: 0.5, ease: 'back.out(1.5)' });
        T.fromTo(r, { y: 110, x: 26, rotation: 18 }, { y: 0, x: 0, rotation: 0, duration: 0.5, delay: 0.06, ease: 'back.out(1.5)' });
        T.to(l, { y: -3, rotation: -2, duration: 0.9, delay: 0.6, yoyo: true, repeat: -1, ease: 'sine.inOut' });
        T.to(r, { y: -3, rotation: 2, duration: 0.9, delay: 0.66, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      },
      point: function () { T.to(el['burst-rays'], { opacity: 1, duration: 0.4, yoyo: true, repeat: -1 }); },
      spin: function () {
        T.to(el['mascot-root'], { scaleX: -1, duration: 1.5, ease: 'sine.inOut', yoyo: true, repeat: -1, repeatDelay: 0.7, transformOrigin: '50% 50%' });
        T.to(el['prop-cube'], { rotation: 12, duration: 1.2, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      }
    };

    // ---------- áp pose
    function applyPose(name, instant) {
      var defs = POSES(); var p = defs[name] || defs.idle; if (!defs[name]) name = 'idle';
      if (pose === p && name === poseName) return;
      killLoop(); clearInterval(cycleTimer); cycleTimer = 0;
      pose = p; poseName = name;
      applyDef(p, instant);
      if (live) {
        if (p.cycle) {
          var i = 0, seq = p.cycle, defs2 = POSES();
          var step = function () { var nm = seq[i % seq.length]; i++; killLoop2(); applyDef(defs2[nm], false); if (LOOPS[defs2[nm].loop]) LOOPS[defs2[nm].loop](); };
          step(); cycleTimer = setInterval(step, 2600);
        } else if (LOOPS[p.loop]) LOOPS[p.loop]();
      }
    }
    function killLoop2() { tweens.forEach(function (t) { try { t.kill(); } catch (e) { /* noop */ } }); tweens = []; }
    function applyDef(p, instant) {
      var parts = p.parts || {}, hide = p.hide || [];
      // 1) trả bộ phận về mặc định, trừ phần pose này dời
      PARTS.forEach(function (k) {
        var n = el[k]; if (!n) return;
        var v = {};
        var rest = { x: 0, y: 0, rotation: 0, scale: 1, scaleX: 1, scaleY: 1 };
        for (var r in rest) v[r] = rest[r];
        if (k === 'mascot-root') { v.xPercent = 0; v.yPercent = 0; }
        var tgt = parts[k]; for (var q in tgt) v[q] = tgt[q];
        if (hide.indexOf(k) >= 0) { v.opacity = 0; v.scale = 0.6; }
        else if (!(tgt && tgt.opacity != null)) { v.opacity = (k === 'bulb-glow' || k === 'bulb-rays' || k === 'burst-rays' || k === 'sparkle-left' || k === 'sparkle-bottom') ? undefined : 1; }
        if (v.opacity === undefined) delete v.opacity;
        // phần đang do ambient điều khiển thì không đè rotation/y của ambient
        var amb = { 'mascot-root': ['y'], swirl: ['rotation'], 'note-paper': ['rotation', 'yPercent'], 'bulb-glow': ['scale', 'scaleX', 'scaleY', 'opacity'],
          'bulb-rays': ['opacity'], 'burst-rays': ['opacity'], 'sparkle-left': ['scale', 'scaleX', 'scaleY', 'opacity'], 'sparkle-bottom': ['scale', 'scaleX', 'scaleY', 'opacity'] }[k];
        if (amb && live) amb.forEach(function (a) { delete v[a]; });
        if (live) { gs.to(n, Object.assign({}, v, { duration: instant ? 0 : 0.45, ease: 'power3.out', overwrite: 'auto', transformOrigin: k === 'mascot-root' ? '50% 100%' : '50% 50%' })); }
        else setStatic(n, v);
      });
      // 2) biểu cảm
      var eyeOn = EYE_SETS[p.eyes] || EYE_SETS.open;
      ALL_EYES.forEach(function (k) { vis(k, eyeOn.indexOf(k) >= 0); if (live) gs.to(el[k], { x: 0, y: 0, duration: 0.2, overwrite: 'auto' }); });
      var mOn = MOUTHS[p.mouth] || 'mouth';
      Object.keys(MOUTHS).forEach(function (m) { vis(MOUTHS[m], MOUTHS[m] === mOn); if (live) gs.set(el[MOUTHS[m]], { scaleY: 1 }); });
      // 3) đạo cụ
      var on = p.props || [];
      ALL_PROPS.forEach(function (k) {
        var n = el[k]; if (!n) return;
        var should = on.indexOf(k) >= 0;
        if (live) gs.killTweensOf(n);
        if (live) gs.set(n, { x: 0, y: 0, rotation: 0, scale: 1, scaleX: 1, scaleY: 1 });
        vis(k, should, true);
      });
      // 4) ambient: tạm dừng phần mà vòng lặp này tự điều khiển
      Object.keys(ambient).forEach(function (a) { ambientFor(a, true); });
      (OFF[p.loop] || []).forEach(function (a) { ambientFor(a, false); });
      ['swirl'].forEach(function (a) { if (parts.swirl) ambientFor(a, false); });
      // 5) hướng nhìn cố định (point-left/right)
      if (p.look && live) { lookApply(p.look[0], p.look[1]); }
    }

    // ---------- nhìn theo con trỏ / hướng
    var qx, qy;
    if (live) { qx = gs.quickTo(el['face'], 'x', { duration: 0.5, ease: 'power3.out' }); qy = gs.quickTo(el['face'], 'y', { duration: 0.5, ease: 'power3.out' }); }
    function lookApply(nx, ny) {
      lookState.x = nx; lookState.y = ny;
      if (live && qx) { qx(nx * 6); qy(ny * 5); }
      else if (el['face']) setStatic(el['face'], { x: nx * 6, y: ny * 5 });
    }

    // ---------- khởi tạo
    startAmbient();
    var firstPose = opts.pose || 'idle';
    applyPose(firstPose, true);
    return {
      setPose: function (n) { if (!destroyed) applyPose(n); }, getPose: function () { return poseName; },
      lookAt: function (nx, ny) { if (!destroyed) lookApply(Math.max(-1, Math.min(1, nx || 0)), Math.max(-1, Math.min(1, ny || 0))); },
      pause: function () { if (live) { Object.keys(ambient).forEach(function (a) { ambient[a].pause(); }); tweens.forEach(function (t) { t.pause(); }); } },
      resume: function () { if (live) { Object.keys(ambient).forEach(function (a) { ambient[a].resume(); }); tweens.forEach(function (t) { t.resume(); }); } },
      isLive: function () { return live; },
      destroy: function () { destroyed = true; killLoop(); if (live) { Object.keys(ambient).forEach(function (a) { ambient[a].kill(); }); gs.killTweensOf(svg.querySelectorAll('*')); } }
    };
  }
  root.AkisMotion = { attach: attach };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AkisMotion;
})(typeof window !== 'undefined' ? window : globalThis);
