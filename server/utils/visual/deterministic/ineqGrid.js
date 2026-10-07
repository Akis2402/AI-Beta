'use strict';

// ============================================================================================
// MIỀN NGHIỆM CONG (parabol, đường tròn, elip, hypebol, |...|) — vẽ bằng lưới điểm + marching squares
// ============================================================================================
// Mỗi ràng buộc là  g(x,y) = lhs - rhs  với dấu s:  miền = { s·g ≥ 0 } (chặt/không chặt chỉ khác nét vẽ biên).
// Không dùng nghiệm giải tích: kiểm tra từng ô lưới -> tô theo dải ngang (ghép dải liên tiếp giống nhau);
// biên vẽ bằng marching squares nội suy tuyến tính rồi NỐI thành polyline (để nét đứt hoạt động).
// An toàn: nếu không tìm thấy điểm nào thoả hệ ở mọi tỉ lệ khung nhìn -> KHÔNG kết luận "vô nghiệm"
// (lưới thô có thể bỏ sót miền rất nhỏ/rất xa) mà trả null để bộ gọi rơi về nhánh khác, không vẽ sai.

const { compile } = require('./ineqExpr');
const C = require('./ineqCommon');

const { K, PLOT_W, PLOT_H, PALETTE, isStrict, fracStr, symText, haloText, makePlotView, buildGridAndAxes } = C;

const WINDOWS = [4, 8, 16, 32, 64, 128, 512];
const SCAN_N = 96;

function build(spec) {
  return spec.atoms.map((a) => {
    const fl = compile(a.lhs); const fr = compile(a.rhs);
    return { g: (x, y) => fl(x, y) - fr(x, y), s: (a.op === 'gt' || a.op === 'ge') ? 1 : -1, op: a.op, label: a.label };
  });
}
const insideFn = (cs) => (x, y) => {
  for (let i = 0; i < cs.length; i += 1) { const v = cs[i].s * cs[i].g(x, y); if (!(v >= 0)) return false; } // NaN => ngoài
  return true;
};

function scan(inside, cx, cy, L, n) {
  let count = 0; let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let touches = false;
  const h = (2 * L) / n;
  for (let j = 0; j < n; j += 1) {
    const y = cy - L + (j + 0.5) * h;
    for (let i = 0; i < n; i += 1) {
      const x = cx - L + (i + 0.5) * h;
      if (inside(x, y)) {
        count += 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (i === 0 || j === 0 || i === n - 1 || j === n - 1) touches = true;
      }
    }
  }
  return { count, minX: minX - h / 2, maxX: maxX + h / 2, minY: minY - h / 2, maxY: maxY + h / 2, touches, h };
}

/** Giao điểm của đường g=0 với hai trục trong [-L, L] (dò đổi dấu + chia đôi) — để chọn khung nhìn cho miền không bị chặn. */
function axisIntercepts(cs, L) {
  const pts = [];
  const bis = (f, a, b) => { let fa = f(a); for (let k = 0; k < 50; k += 1) { const m = (a + b) / 2; const fm = f(m); if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m; } return (a + b) / 2; };
  cs.forEach((c) => {
    const n = 400;
    for (const axis of ['x', 'y']) {
      const f = axis === 'x' ? (t) => c.g(t, 0) : (t) => c.g(0, t);
      let prev = f(-L);
      for (let i = 1; i <= n; i += 1) {
        const t = -L + (2 * L * i) / n; const cur = f(t);
        if (Number.isFinite(prev) && Number.isFinite(cur) && prev !== 0 && ((prev < 0) !== (cur < 0))) {
          const r = bis(f, -L + (2 * L * (i - 1)) / n, t);
          pts.push(axis === 'x' ? [r, 0] : [0, r]);
        }
        prev = cur;
      }
    }
  });
  return pts;
}

/** Chọn khung nhìn. Trả {bounds, unbounded} hoặc null nếu không tìm thấy miền (không dám kết luận). */
function chooseView(spec) {
  const cs = build(spec); const inside = insideFn(cs);
  let firstTouching = null;
  for (const L of WINDOWS) {
    const s = scan(inside, 0, 0, L, SCAN_N);
    if (s.count === 0) continue;
    if (!s.touches) {
      // Miền bị chặn trong cửa sổ L -> quét lại mịn hơn quanh bbox để lấy biên chính xác hơn.
      const w = Math.max(s.maxX - s.minX, s.maxY - s.minY);
      const cx = (s.minX + s.maxX) / 2; const cy = (s.minY + s.maxY) / 2;
      const f = scan(inside, cx, cy, w * 0.6 + s.h, 160);
      const b = f.count ? f : s;
      return { bounds: padBounds({ minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY }, spec.points, 0.22, true), unbounded: false };
    }
    if (!firstTouching) firstTouching = L;
  }
  if (!firstTouching) return null;
  // Không bao giờ đóng lại trong cửa sổ <= 512 => coi là không bị chặn. Khung nhìn: gốc, giao điểm trục, điểm kiểm tra.
  const L0 = Math.min(firstTouching * 2, 512);
  const key = [[0, 0], ...axisIntercepts(cs, L0), ...(spec.points || []).map((p) => [p.x, p.y])];
  const b = {
    minX: Math.min(...key.map((p) => p[0])), maxX: Math.max(...key.map((p) => p[0])),
    minY: Math.min(...key.map((p) => p[1])), maxY: Math.max(...key.map((p) => p[1]))
  };
  return { bounds: padBounds(b, [], 0.35, false), unbounded: true };
}

function padBounds(b, pts, frac, includeOrigin) {
  let { minX, maxX, minY, maxY } = b;
  (pts || []).forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
  if (includeOrigin) { minX = Math.min(minX, 0); maxX = Math.max(maxX, 0); minY = Math.min(minY, 0); maxY = Math.max(maxY, 0); }
  if (maxX - minX < 4) { const m = (minX + maxX) / 2; minX = m - 2; maxX = m + 2; }
  if (maxY - minY < 4) { const m = (minY + maxY) / 2; minY = m - 2; maxY = m + 2; }
  const px = (maxX - minX) * frac; const py = (maxY - minY) * frac;
  return { minX: minX - px, maxX: maxX + px, minY: minY - py, maxY: maxY + py };
}

// ---------------- marching squares + nối polyline ----------------
function contourPolylines(g, x0, y0, step, nx, ny, toPx) {
  // đỉnh lưới (i,j) -> giá trị; ô (i,j) có 4 đỉnh (i,j),(i+1,j),(i+1,j+1),(i,j+1)
  const val = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j += 1) for (let i = 0; i <= nx; i += 1) val[j * (nx + 1) + i] = g(x0 + i * step, y0 + j * step);
  const V = (i, j) => val[j * (nx + 1) + i];
  const pos = (v) => v >= 0;
  const segs = []; // [keyA, keyB]
  const pt = new Map(); // key -> [px,py]
  const edgePoint = (kind, i, j) => { // kind 'h': cạnh (i,j)-(i+1,j) ; 'v': (i,j)-(i,j+1)
    const key = `${kind}${i},${j}`;
    if (pt.has(key)) return key;
    const [ai, aj, bi, bj] = kind === 'h' ? [i, j, i + 1, j] : [i, j, i, j + 1];
    const fa = V(ai, aj); const fb = V(bi, bj);
    const t = fa / (fa - fb);
    pt.set(key, toPx(x0 + (ai + t * (bi - ai)) * step, y0 + (aj + t * (bj - aj)) * step));
    return key;
  };
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const a = V(i, j); const b = V(i + 1, j); const c = V(i + 1, j + 1); const d = V(i, j + 1);
      if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
      const code = (pos(a) ? 1 : 0) | (pos(b) ? 2 : 0) | (pos(c) ? 4 : 0) | (pos(d) ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const B = () => edgePoint('h', i, j); const R = () => edgePoint('v', i + 1, j);
      const T = () => edgePoint('h', i, j + 1); const Lf = () => edgePoint('v', i, j);
      const push = (p, q) => segs.push([p(), q()]);
      switch (code) {
        case 1: case 14: push(Lf, B); break;
        case 2: case 13: push(B, R); break;
        case 3: case 12: push(Lf, R); break;
        case 4: case 11: push(R, T); break;
        case 6: case 9: push(B, T); break;
        case 7: case 8: push(Lf, T); break;
        case 5: case 10: { // yên ngựa: dùng giá trị trung tâm để chọn cách nối
          const centerPos = (a + b + c + d) / 4 >= 0;
          if ((code === 5) === centerPos) { push(Lf, T); push(B, R); } else { push(Lf, B); push(R, T); }
          break;
        }
        default: break;
      }
    }
  }
  // nối các đoạn thành polyline theo khoá điểm cạnh
  const adj = new Map();
  segs.forEach(([p, q], idx) => { (adj.get(p) || adj.set(p, []).get(p)).push(idx); (adj.get(q) || adj.set(q, []).get(q)).push(idx); });
  const used = new Uint8Array(segs.length);
  const lines = [];
  const walk = (startKey) => {
    const line = [startKey]; let cur = startKey;
    for (;;) {
      const nextIdx = (adj.get(cur) || []).find((k) => !used[k]);
      if (nextIdx === undefined) break;
      used[nextIdx] = 1;
      const [p, q] = segs[nextIdx]; cur = p === cur ? q : p; line.push(cur);
    }
    return line;
  };
  for (const [key, list] of adj) if (list.length === 1 && !used[list[0]]) lines.push(walk(key)); // đường hở trước
  for (const [key, list] of adj) if (list.some((k) => !used[k])) lines.push(walk(key));          // rồi các vòng kín
  return lines.map((l) => l.map((k) => pt.get(k)));
}

const fmt = (v) => (Math.round(v * 10) / 10).toString();
const pathOf = (lines) => lines.map((l) => `M${l.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(' L')}`).join(' ');

/** Tô miền bằng các dải ngang (ghép dải liền kề giống hệt nhau). */
function fillRects(inside, inv, cell, W, H) {
  const rows = [];
  for (let py = 0; py < H; py += cell) {
    const y = inv.y(py + cell / 2); const spans = []; let start = -1;
    for (let px = 0; px < W; px += cell) {
      const ok = inside(inv.x(px + cell / 2), y);
      if (ok && start < 0) start = px;
      if (!ok && start >= 0) { spans.push([start, px]); start = -1; }
    }
    if (start >= 0) spans.push([start, W]);
    rows.push({ py, key: spans.map((s) => s.join('-')).join('|'), spans });
  }
  const out = []; let i = 0;
  while (i < rows.length) {
    let j = i + 1; while (j < rows.length && rows[j].key === rows[i].key) j += 1;
    const y0 = rows[i].py; const h = Math.min(H, rows[j - 1].py + cell) - y0;
    rows[i].spans.forEach(([a, b]) => out.push(`M${a},${y0} h${b - a} v${h} h${a - b} z`));
    i = j;
  }
  return out.join(' ');
}

/** @returns {{svg:string,title:string,desc:string,unbounded:boolean}} — ném lỗi nếu SVG vượt giới hạn dù đã thô hoá. */
function renderCurvedRegion(spec) {
  const cs = build(spec); const inside = insideFn(cs);
  const b = spec.view;
  const { view, frame: f, inv } = makePlotView(b);
  const n = cs.length;
  const H = PLOT_H + 24 * (n + 2) + 10;
  const INK = K.COLORS.INK; const BLUE = K.COLORS.BLUE;

  let svg = null;
  for (const cell of [2, 3, 4, 6]) {
    const c = new K.Canvas(PLOT_W, H);
    const { grid, ox, oy, ticksX, ticksY, P } = buildGridAndAxes(view, f);
    c.add(K.el('g', { id: 'layer-grid' }, grid));
    const d = fillRects(inside, inv, cell, PLOT_W, PLOT_H);
    if (d) c.add(K.el('path', { d, fill: BLUE, 'fill-opacity': 0.26, stroke: 'none' }));

    // trục (nhóm riêng để giao diện bật/tắt) — vẽ TRƯỚC biên để biên trùng trục không bị che
    let axes = '';
    axes += K.line(P(f.L, 0)[0], oy, P(f.R, 0)[0], oy, { stroke: INK, w: 1.6 });
    axes += K.line(ox, P(0, f.B)[1], ox, P(0, f.T)[1], { stroke: INK, w: 1.6 });
    c.add(K.el('g', { id: 'layer-axes' }, axes));

    // biên: marching squares trên lưới pixel bước 3, đổi về toạ độ pixel
    const step = 3; const nx = Math.ceil(PLOT_W / step); const ny = Math.ceil(PLOT_H / step);
    cs.forEach((q, i) => {
      const lines = contourPolylines((px, py) => q.g(inv.x(px), inv.y(py)), 0, 0, step, nx, ny, (px, py) => [px, py]);
      const dd = pathOf(lines);
      if (dd) c.add(K.el('path', { d: dd, fill: 'none', stroke: PALETTE[i % PALETTE.length], 'stroke-width': 2.6, 'stroke-dasharray': isStrict(q.op) ? '7 5' : undefined, 'stroke-linejoin': 'round' }));
    });

    c.add(K.text(P(f.R, 0)[0] - 8, oy - 8, 'x', { size: 15, italic: true }));
    c.add(K.text(ox + 12, P(0, f.T)[1] + 12, 'y', { size: 15, italic: true }));
    const tx = ticksX.filter((t) => Math.abs(t) > 1e-9).slice(0, 16); const ty = ticksY.filter((t) => Math.abs(t) > 1e-9).slice(0, 16);
    tx.forEach((t) => haloText(c, P(t, 0)[0], oy + 15, fracStr(t), { size: 11, color: K.COLORS.MUTED }));
    ty.forEach((t) => haloText(c, ox - 6, P(0, t)[1] + 4, fracStr(t), { size: 11, color: K.COLORS.MUTED, anchor: 'end' }));
    c.add(K.text(ox - 9, oy + 15, 'O', { size: 13 }));

    const ptNotes = [];
    (spec.points || []).forEach((pt) => {
      const ok = inside(pt.x, pt.y); const [px, py] = P(pt.x, pt.y); const col = ok ? K.COLORS.GREEN : K.COLORS.RED;
      c.add(K.circle(px, py, 5, { fill: col, stroke: INK, w: 1.2 }));
      c.add(K.text(px + 9, py - 8, `${pt.name}(${fracStr(pt.x)}; ${fracStr(pt.y)})`, { size: 12, bold: true, anchor: 'start', color: col }));
      ptNotes.push(`${pt.name}(${fracStr(pt.x)}; ${fracStr(pt.y)}) ${ok ? 'thuộc' : 'không thuộc'} miền nghiệm`);
    });

    let ly = PLOT_H + 18;
    cs.forEach((q, i) => {
      const col = PALETTE[i % PALETTE.length];
      c.add(K.line(18, ly - 4, 52, ly - 4, { stroke: col, w: 2.6, dash: isStrict(q.op) ? '7 5' : undefined }));
      c.add(symText(60, ly, `d${i + 1}: ${q.label}${isStrict(q.op) ? '  (nét đứt: không lấy biên)' : ''}`, { size: 13, anchor: 'start' }));
      ly += 24;
    });
    c.add(K.el('rect', { x: 18, y: ly - 14, width: 34, height: 14, fill: BLUE, 'fill-opacity': 0.26, stroke: BLUE, 'stroke-width': 1 }));
    c.add(K.text(60, ly - 2, `Miền nghiệm (phần tô màu)${spec.unbounded ? ' — không bị chặn' : ''}`, { size: 13, anchor: 'start', bold: true }));

    c.title = 'Miền nghiệm của hệ bất phương trình';
    c.desc = `Miền nghiệm của hệ ${n} bất phương trình ${cs.map((q, i) => `d${i + 1}: ${q.label}`).join('; ')} là phần tô màu${spec.unbounded ? ' (không bị chặn)' : ''}.${ptNotes.length ? ` ${ptNotes.join('. ')}.` : ''}`;
    const out = c.toSvg();
    if (Buffer.byteLength(out, 'utf8') <= K.MAX_SVG_BYTES - 4096) { svg = { svg: out, title: c.title, desc: c.desc }; break; }
  }
  if (!svg) { const e = new Error('curved_region_too_large'); e.code = 'inequality_render_too_large'; throw e; }
  return { ...svg, unbounded: !!spec.unbounded };
}

module.exports = { chooseView, renderCurvedRegion, contourPolylines, build, insideFn };
