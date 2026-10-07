/* ============================================================================================
 * visualViewer.js — Zoom / kéo (pan) / reset cho ảnh SVG trong lightbox có sẵn (.visual-svg-lightbox-img)
 * ============================================================================================
 * Không sửa app.js: quan sát DOM, khi lightbox SVG xuất hiện thì gắn điều khiển vào ảnh.
 * Điều khiển: nút + / − / ⟲ (Reset), bánh xe chuột (Ctrl/⌘ hoặc cuộn trực tiếp), kéo chuột/ngón tay (Pointer Events),
 * chụm hai ngón (pinch), bàn phím: + − 0 và phím mũi tên. Có aria-label, tôn trọng prefers-reduced-motion.
 * Chỉ biến đổi bằng CSS transform trên <img> => SVG vẫn render sắc nét (vector), không đụng nội dung SVG.
 * ============================================================================================ */
(function () {
  'use strict';
  if (window.__tgVisualViewer) return;
  window.__tgVisualViewer = true;

  var MIN = 1, MAX = 8, STEP = 1.25;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function label(key, fb) { try { var s = typeof window.t === 'function' ? window.t(key) : null; return s && s !== key ? s : fb; } catch (e) { return fb; } }

  // ---- Bật/tắt lưới & trục: ảnh nằm trong <img src="data:image/svg+xml..."> nên không chỉnh DOM bên trong được. Giải mã SVG,
  // ẩn nhóm có id layer-grid / layer-axes (do server sinh), rồi gán lại src. SVG đã được server kiểm allowlist; ta chỉ thêm
  // thuộc tính display="none" vào phần tử có sẵn, không chèn nội dung mới.
  function decodeSvgDataUrl(src) {
    if (!/^data:image\/svg\+xml/i.test(src || '')) return null;
    var comma = src.indexOf(','); if (comma < 0) return null;
    var meta = src.slice(0, comma); var data = src.slice(comma + 1);
    try {
      if (/;base64/i.test(meta)) { var bin = atob(data); var u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new TextDecoder('utf-8').decode(u8); }
      return decodeURIComponent(data);
    } catch (e) { return null; }
  }
  function encodeSvgDataUrl(text) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text); }
  /** Trả về chuỗi SVG đã ẩn các lớp trong `hide` (mảng id), hoặc null nếu không phân tích được. */
  function withLayersHidden(text, hide) {
    try {
      var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (doc.querySelector('parsererror')) return null;
      hide.forEach(function (id) { var el = doc.querySelector('[id="' + id + '"]'); if (el) el.setAttribute('display', 'none'); });
      return new XMLSerializer().serializeToString(doc.documentElement);
    } catch (e) { return null; }
  }

  /** Logic thuần (test được): giới hạn dịch chuyển sao cho ảnh phóng to luôn còn phủ khung nhìn. */
  function clampPan(pan, scale, box) {
    var maxX = Math.max(0, (box.w * scale - box.w) / 2);
    var maxY = Math.max(0, (box.h * scale - box.h) / 2);
    return { x: clamp(pan.x, -maxX, maxX), y: clamp(pan.y, -maxY, maxY) };
  }
  /** Zoom quanh điểm (cx, cy) tính từ TÂM khung: giữ nguyên điểm dưới con trỏ. */
  function zoomAt(state, factor, cx, cy, box) {
    var next = clamp(state.scale * factor, MIN, MAX);
    var k = next / state.scale;
    var pan = { x: cx - (cx - state.x) * k, y: cy - (cy - state.y) * k };
    if (next === MIN) pan = { x: 0, y: 0 };
    var c = clampPan(pan, next, box);
    return { scale: next, x: c.x, y: c.y };
  }

  function attach(box) {
    var img = box.querySelector('.visual-svg-lightbox-img');
    if (!img || img.__tgZoom) return;
    img.__tgZoom = true;

    var inner = img.parentNode;
    var stage = document.createElement('div');
    stage.className = 'tg-zoom-stage';
    stage.setAttribute('role', 'group');
    stage.setAttribute('aria-label', label('viewer.stage', 'Vùng xem hình: dùng + − 0 và phím mũi tên để phóng to, thu nhỏ, di chuyển'));
    stage.tabIndex = 0;
    inner.insertBefore(stage, img);
    stage.appendChild(img);

    var st = { scale: 1, x: 0, y: 0 };
    var pointers = new Map();
    var dragStart = null; var pinchStart = null;

    function dims() { var r = stage.getBoundingClientRect(); return { w: r.width || 1, h: r.height || 1, left: r.left, top: r.top }; }
    function apply() {
      img.style.transform = 'translate(' + st.x + 'px,' + st.y + 'px) scale(' + st.scale + ')';
      img.style.cursor = st.scale > 1 ? (dragStart ? 'grabbing' : 'grab') : 'zoom-in';
      lvl.textContent = Math.round(st.scale * 100) + '%';
      btnOut.disabled = st.scale <= MIN; btnReset.disabled = st.scale === 1 && st.x === 0 && st.y === 0; btnIn.disabled = st.scale >= MAX;
    }
    function zoom(factor, clientX, clientY) {
      var d = dims();
      var cx = (clientX === undefined ? d.left + d.w / 2 : clientX) - (d.left + d.w / 2);
      var cy = (clientY === undefined ? d.top + d.h / 2 : clientY) - (d.top + d.h / 2);
      st = zoomAt(st, factor, cx, cy, d); apply();
    }
    function reset() { st = { scale: 1, x: 0, y: 0 }; apply(); }
    function pan(dx, dy) { var c = clampPan({ x: st.x + dx, y: st.y + dy }, st.scale, dims()); st.x = c.x; st.y = c.y; apply(); }

    var bar = document.createElement('div'); bar.className = 'tg-zoom-bar';
    function mk(txt, aria, fn) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'visual-btn tg-zoom-btn'; b.textContent = txt;
      b.setAttribute('aria-label', aria); b.addEventListener('click', fn); bar.appendChild(b); return b;
    }
    var btnOut = mk('−', label('viewer.out', 'Thu nhỏ'), function () { zoom(1 / STEP); });
    var lvl = document.createElement('span'); lvl.className = 'tg-zoom-level'; lvl.setAttribute('aria-live', 'polite'); bar.appendChild(lvl);
    var btnIn = mk('+', label('viewer.in', 'Phóng to'), function () { zoom(STEP); });
    var btnReset = mk('⟲', label('viewer.reset', 'Đặt lại khung nhìn'), reset);

    // Nút Lưới / Trục (chỉ hiện khi SVG có các lớp tương ứng — miền nghiệm do server sinh)
    var svgText = decodeSvgDataUrl(img.getAttribute('src'));
    if (svgText && /id="layer-(grid|axes)"/.test(svgText)) {
      var hidden = { 'layer-grid': false, 'layer-axes': false };
      var refresh = function () {
        var list = Object.keys(hidden).filter(function (k) { return hidden[k]; });
        var out = list.length ? withLayersHidden(svgText, list) : svgText;
        if (out) img.src = encodeSvgDataUrl(out);
      };
      [['layer-grid', 'viewer.grid', 'Lưới'], ['layer-axes', 'viewer.axes', 'Trục']].forEach(function (cfg) {
        if (svgText.indexOf('id="' + cfg[0] + '"') < 0) return;
        var b = document.createElement('button'); b.type = 'button'; b.className = 'visual-btn tg-zoom-btn tg-layer-btn';
        b.textContent = label(cfg[1], cfg[2]); b.setAttribute('aria-pressed', 'true'); b.setAttribute('data-layer', cfg[0]);
        b.addEventListener('click', function () {
          hidden[cfg[0]] = !hidden[cfg[0]]; b.setAttribute('aria-pressed', String(!hidden[cfg[0]])); refresh();
        });
        bar.appendChild(b);
      });
    }
    var innerBar = inner.querySelector('.visual-lightbox-bar');
    if (innerBar) innerBar.insertBefore(bar, innerBar.firstChild); else inner.appendChild(bar);

    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoom(e.deltaY < 0 ? STEP : 1 / STEP, e.clientX, e.clientY);
    }, { passive: false });
    stage.addEventListener('dblclick', function (e) { if (st.scale > 1) reset(); else zoom(2.5, e.clientX, e.clientY); });

    stage.addEventListener('pointerdown', function (e) {
      try { stage.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) dragStart = { x: e.clientX, y: e.clientY, px: st.x, py: st.y };
      if (pointers.size === 2) {
        var p = Array.from(pointers.values());
        pinchStart = { dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, scale: st.scale };
        dragStart = null;
      }
      apply();
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchStart) {
        var p = Array.from(pointers.values());
        var dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
        var target = clamp(pinchStart.scale * (dist / pinchStart.dist), MIN, MAX);
        zoom(target / st.scale, (p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
      } else if (dragStart && st.scale > 1) {
        var c = clampPan({ x: dragStart.px + (e.clientX - dragStart.x), y: dragStart.py + (e.clientY - dragStart.y) }, st.scale, dims());
        st.x = c.x; st.y = c.y; apply();
      }
    });
    function end(e) { pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = null; if (pointers.size === 0) dragStart = null; apply(); }
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);

    stage.addEventListener('keydown', function (e) {
      var k = e.key; var handled = true;
      if (k === '+' || k === '=') zoom(STEP);
      else if (k === '-' || k === '_') zoom(1 / STEP);
      else if (k === '0') reset();
      else if (k === 'ArrowLeft') pan(40, 0); else if (k === 'ArrowRight') pan(-40, 0);
      else if (k === 'ArrowUp') pan(0, 40); else if (k === 'ArrowDown') pan(0, -40);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });

    apply();
  }

  function css() {
    if (document.getElementById('tgZoomCss')) return;
    var s = document.createElement('style'); s.id = 'tgZoomCss';
    s.textContent = [
      '.tg-zoom-stage{position:relative;overflow:hidden;touch-action:none;max-width:100%;border-radius:8px;outline-offset:2px}',
      '.tg-zoom-stage:focus-visible{outline:3px solid var(--tg-primary,#2563eb)}',
      '.tg-zoom-stage>img{display:block;max-width:100%;transform-origin:center center;will-change:transform;user-select:none;-webkit-user-drag:none;transition:transform .12s ease-out}',
      '@media (prefers-reduced-motion:reduce){.tg-zoom-stage>img{transition:none}}',
      '.tg-zoom-bar{display:inline-flex;align-items:center;gap:6px;margin-right:auto}',
      '.tg-zoom-btn{min-width:44px;min-height:44px;font-size:18px;line-height:1}',
      '.tg-zoom-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.tg-layer-btn{min-width:auto;padding:0 12px;font-size:13px;font-weight:600}.tg-layer-btn[aria-pressed="false"]{opacity:.55;text-decoration:line-through}',
      '.tg-zoom-level{min-width:3.5em;text-align:center;font:600 13px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function scan(root) {
    var boxes = (root.nodeType === 1 && root.matches && root.matches('.visual-lightbox')) ? [root] : (root.querySelectorAll ? root.querySelectorAll('.visual-lightbox') : []);
    Array.prototype.forEach.call(boxes, attach);
  }

  function init() {
    css();
    var mo = new MutationObserver(function (muts) {
      muts.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) scan(n); }); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    scan(document);
  }

  window.TGVisualViewer = { _clampPan: clampPan, _zoomAt: zoomAt, _decode: decodeSvgDataUrl, _hide: withLayersHidden, MIN: MIN, MAX: MAX };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
