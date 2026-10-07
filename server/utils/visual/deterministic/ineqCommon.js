'use strict';

// Tiện ích dùng chung cho các bộ vẽ bất phương trình (trục số, miền nghiệm thẳng, miền nghiệm cong).

const K = require('./svgKit');

const EPS = 1e-9;
const PLOT_W = 640;
const PLOT_H = 440;
const PAD = 30;

const isStrict = (op) => op === 'lt' || op === 'gt';
const OP_SYM = { lt: '<', le: '≤', gt: '>', ge: '≥', ne: '≠' };
const PALETTE = [K.COLORS.RED, K.COLORS.GREEN, K.COLORS.ORANGE, K.COLORS.PURPLE, K.COLORS.TEAL, '#be185d', '#4d7c0f', '#1d4ed8'];

function fracStr(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) < 5e-10) return '0';
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (Math.abs(a - Math.round(a)) < 1e-9) return sign + String(Math.round(a));
  for (let d = 2; d <= 12; d += 1) {
    const n = a * d;
    if (Math.abs(n - Math.round(n)) < 1e-9) return `${sign}${Math.round(n)}/${d}`;
  }
  return sign + String(Math.round(a * 1000) / 1000);
}

function niceStep(rough) {
  if (!(rough > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(rough)); const m = rough / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

// Ký hiệu toán (∪, ≠, ≤...) không có trong mọi font: khai báo chuỗi font dự phòng để không hiện ô vuông.
const SYMBOL_FONT = "Arial, 'Segoe UI Symbol', 'DejaVu Sans', 'Noto Sans Math', sans-serif";
function symText(x, y, str, o = {}) {
  return K.el('text', {
    x: K.num(x), y: K.num(y), 'text-anchor': o.anchor || 'middle', 'font-size': o.size || 14, 'font-family': SYMBOL_FONT,
    'font-weight': o.bold ? 700 : undefined, fill: o.color || K.COLORS.INK
  }, K.esc(str));
}

/** Nhãn có nền trắng mờ (halo) để không bị nét kẻ/trục che. Ước lượng độ rộng ~0.58×size mỗi ký tự. */
function haloText(c, x, y, str, o = {}) {
  const size = o.size || 12; const w = String(str).length * size * 0.58 + 6; const h = size + 4;
  const anchor = o.anchor || 'middle';
  const x0 = anchor === 'start' ? x - 3 : (anchor === 'end' ? x - w + 3 : x - w / 2);
  c.add(K.el('rect', { x: K.num(x0), y: K.num(y - size + 1), width: K.num(w), height: K.num(h), fill: K.COLORS.PAPER, 'fill-opacity': 0.82, stroke: 'none' }));
  c.add(symText(x, y, str, { ...o, size }));
}

/**
 * Khung nhìn từ vùng thế giới {minX,maxX,minY,maxY}. Giữ tỉ lệ 1:1. Trả {view, frame, inv}:
 *  frame = vùng thế giới thực sự hiển thị (trừ lề 8px); inv = đổi pixel -> toạ độ thế giới.
 */
function makePlotView(b) {
  const view = K.makeView([[b.minX, b.minY], [b.maxX, b.maxY]], { w: PLOT_W, h: PLOT_H, pad: PAD, keepAspect: true });
  const inv = {
    x: (px) => view.minX + (px - view.X(view.minX)) / view.sx,
    y: (py) => view.minY + (view.Y(view.minY) - py) / view.sx
  };
  const m = 8;
  const frame = { L: inv.x(m), R: inv.x(PLOT_W - m), B: inv.y(PLOT_H - m), T: inv.y(m) };
  return { view, frame, inv };
}

/**
 * Lưới + trục toạ độ + nhãn số, gom thành 2 nhóm có id (layer-grid, layer-axes) để giao diện có thể bật/tắt.
 * Trả về { grid: chuỗi SVG, axes: chuỗi SVG, ox, oy }.
 */
function buildGridAndAxes(view, f) {
  const P = (x, y) => view.P([x, y]);
  const INK = K.COLORS.INK; const GRID = K.COLORS.GRID;
  const step = niceStep((f.R - f.L) / 9);
  const ticksX = []; const ticksY = [];
  for (let t = Math.ceil(f.L / step) * step; t <= f.R + EPS; t += step) ticksX.push(Math.round(t * 1e9) / 1e9);
  for (let t = Math.ceil(f.B / step) * step; t <= f.T + EPS; t += step) ticksY.push(Math.round(t * 1e9) / 1e9);
  let grid = '';
  ticksX.forEach((t) => { const [px] = P(t, 0); grid += K.line(px, P(0, f.B)[1], px, P(0, f.T)[1], { stroke: GRID, w: 1 }); });
  ticksY.forEach((t) => { const [, py] = P(0, t); grid += K.line(P(f.L, 0)[0], py, P(f.R, 0)[0], py, { stroke: GRID, w: 1 }); });
  const [ox, oy] = P(0, 0);
  return { grid, ox, oy, ticksX, ticksY, P, INK };
}

module.exports = { K, EPS, PLOT_W, PLOT_H, PAD, isStrict, OP_SYM, PALETTE, fracStr, niceStep, symText, haloText, makePlotView, buildGridAndAxes, SYMBOL_FONT };
