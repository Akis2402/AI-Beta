'use strict';

// ============================================================================================
// svgKit — nền tảng dựng SVG TẤT ĐỊNH (deterministic) cho Hybrid Visual Engine.
// ============================================================================================
// Nguyên tắc (Master prompt XLII — SVG SECURITY):
//   1. Mọi chuỗi đi vào SVG đều qua esc(); mọi số đi vào SVG đều qua num() (không NaN/Infinity).
//   2. KHÔNG có <script>, <style>, <foreignObject>, <image>, <use>, href, on*=, javascript:, URL ngoài.
//   3. validateSvg() là lớp phòng thủ thứ 2: dù renderer có lỗi, một SVG vi phạm allowlist KHÔNG BAO GIỜ
//      rời khỏi server (assertSafeSvg ném lỗi -> pipeline bỏ hình, text answer vẫn nguyên vẹn).
//   4. Client chỉ hiển thị qua <img src="data:image/svg+xml,..."> — ngữ cảnh <img> không thực thi script.
// Hệ toạ độ: mỗi renderer làm việc ở toạ độ "thế giới" (y hướng lên) rồi đi qua View để ra pixel.

const crypto = require('crypto');

const INK = '#1f2937';
const MUTED = '#6b7280';
const GRID = '#e5e7eb';
const PAPER = '#ffffff';
const BLUE = '#2563eb';
const RED = '#dc2626';
const GREEN = '#16a34a';
const ORANGE = '#ea580c';
const PURPLE = '#7c3aed';
const TEAL = '#0f766e';
const FILL = '#eff6ff';
const FONT = 'Arial, Helvetica, sans-serif';

const COLORS = { INK, MUTED, GRID, PAPER, BLUE, RED, GREEN, ORANGE, PURPLE, TEAL, FILL };

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape mọi ký tự có nghĩa trong XML/HTML; loại ký tự điều khiển (XML 1.0 không cho phép). */
function esc(s) {
  return String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (c) => HTML_ESC[c]);
}

/** Số hữu hạn -> chuỗi gọn. Ném RangeError khi NaN/Infinity: KHÔNG BAO GIỜ vẽ số hỏng. */
function num(v, d = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new RangeError('non_finite_coordinate');
  const p = 10 ** d;
  const r = Math.round(x * p) / p;
  return String(Object.is(r, -0) ? 0 : r);
}

/** Định dạng số cho NHÃN hiển thị (bỏ đuôi 0, dùng dấu phẩy thập phân kiểu Việt). */
function fmt(v, d = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) return '?';
  const r = Math.round(x * 10 ** d) / 10 ** d;
  return String(Object.is(r, -0) ? 0 : r).replace('.', ',');
}

function attrs(obj) {
  if (!obj) return '';
  return Object.keys(obj).filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== false).map((k) => {
    const v = obj[k];
    return ` ${k}="${typeof v === 'number' ? num(v, 3) : esc(v)}"`;
  }).join('');
}

function el(tag, a, inner) {
  const body = inner == null ? '' : (Array.isArray(inner) ? inner.join('') : String(inner));
  return body === '' ? `<${tag}${attrs(a)}/>` : `<${tag}${attrs(a)}>${body}</${tag}>`;
}

// ---------- Primitive ----------
function line(x1, y1, x2, y2, o = {}) {
  return el('line', {
    x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2),
    stroke: o.stroke || INK, 'stroke-width': o.w || 1.6,
    'stroke-dasharray': o.dash || undefined, 'stroke-linecap': 'round',
    'marker-end': o.arrow ? `url(#ah-${o.arrow.replace('#', '')})` : undefined
  });
}
function circle(cx, cy, r, o = {}) {
  return el('circle', {
    cx: num(cx), cy: num(cy), r: num(r),
    fill: o.fill || 'none', stroke: o.stroke === undefined ? INK : o.stroke, 'stroke-width': o.w || 1.6,
    'stroke-dasharray': o.dash || undefined
  });
}
function rect(x, y, w, h, o = {}) {
  return el('rect', {
    x: num(x), y: num(y), width: num(w), height: num(h), rx: o.rx || undefined,
    fill: o.fill || 'none', stroke: o.stroke === undefined ? INK : o.stroke, 'stroke-width': o.w || 1.6,
    transform: o.transform || undefined
  });
}
function polygon(pts, o = {}) {
  return el('polygon', {
    points: pts.map((p) => `${num(p[0])},${num(p[1])}`).join(' '),
    fill: o.fill || 'none', stroke: o.stroke || INK, 'stroke-width': o.w || 1.8, 'stroke-linejoin': 'round'
  });
}
function polyline(pts, o = {}) {
  return el('polyline', {
    points: pts.map((p) => `${num(p[0])},${num(p[1])}`).join(' '),
    fill: 'none', stroke: o.stroke || INK, 'stroke-width': o.w || 1.8,
    'stroke-dasharray': o.dash || undefined, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
  });
}
function path(d, o = {}) {
  return el('path', {
    d, fill: o.fill || 'none', stroke: o.stroke === undefined ? INK : o.stroke, 'stroke-width': o.w || 1.6,
    'stroke-dasharray': o.dash || undefined, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'marker-end': o.arrow ? `url(#ah-${o.arrow.replace('#', '')})` : undefined
  });
}
/** Nhãn văn bản. o.anchor: start|middle|end; o.size; o.bold; o.italic; o.color. */
function text(x, y, str, o = {}) {
  return el('text', {
    x: num(x), y: num(y), 'text-anchor': o.anchor || 'middle', 'font-size': o.size || 14,
    'font-family': FONT, 'font-weight': o.bold ? 700 : undefined,
    'font-style': o.italic ? 'italic' : undefined, fill: o.color || INK,
    transform: o.rotate ? `rotate(${num(o.rotate)} ${num(x)} ${num(y)})` : undefined
  }, esc(str));
}
/** Nhãn có chỉ số dưới/trên: sub('F', 'ms') => F_ms. */
function textSub(x, y, base, sub, o = {}) {
  const size = o.size || 14;
  return el('text', {
    x: num(x), y: num(y), 'text-anchor': o.anchor || 'middle', 'font-size': size,
    'font-family': FONT, 'font-weight': o.bold ? 700 : undefined, 'font-style': o.italic ? 'italic' : undefined,
    fill: o.color || INK
  }, esc(base) + el('tspan', { 'font-size': Math.round(size * 0.72), dy: Math.round(size * 0.28) }, esc(sub)));
}

// ---------- Mũi tên (marker theo màu) ----------
const usedMarkers = new Set();
function markerId(color) { return String(color).replace('#', ''); }
/** Trả stroke color + đăng ký marker; dùng cùng defsFor(). */
function arrowColor(color) { usedMarkers.add(color); return color; }
function defsFor(colors) {
  const list = [...new Set(colors)];
  if (!list.length) return '';
  return el('defs', null, list.map((c) => el('marker', {
    id: `ah-${markerId(c)}`, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse'
  }, el('path', { d: 'M0,0 L10,5 L0,10 z', fill: c }))));
}

/** Mũi tên có đầu: trả {svg, color}. Gọi ctx.arrow() thay vì hàm này trực tiếp trong renderer. */
class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h; this.parts = []; this.colors = new Set(); this.title = ''; this.desc = '';
  }
  add(s) { if (s) this.parts.push(s); return this; }
  arrow(x1, y1, x2, y2, o = {}) {
    const color = o.stroke || INK;
    this.colors.add(color);
    this.parts.push(el('line', {
      x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2), stroke: color, 'stroke-width': o.w || 2.2,
      'stroke-dasharray': o.dash || undefined, 'stroke-linecap': 'round', 'marker-end': `url(#ah-${markerId(color)})`
    }));
    return this;
  }
  curveArrow(d, o = {}) {
    const color = o.stroke || INK;
    this.colors.add(color);
    this.parts.push(el('path', {
      d, fill: 'none', stroke: color, 'stroke-width': o.w || 1.8, 'stroke-linecap': 'round', 'marker-end': `url(#ah-${markerId(color)})`
    }));
    return this;
  }
  toSvg() {
    const inner = [
      el('rect', { x: 0, y: 0, width: num(this.w), height: num(this.h), fill: PAPER, rx: 10 }),
      defsFor([...this.colors]),
      ...this.parts
    ].join('');
    const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(this.w)} ${num(this.h)}" width="${num(this.w)}" height="${num(this.h)}" role="img" aria-label="${esc(this.title)}">`;
    const t = this.title ? el('title', null, esc(this.title)) : '';
    const d = this.desc ? el('desc', null, esc(this.desc)) : '';
    return `${head}${t}${d}${inner}</svg>`;
  }
}

// ---------- View: toạ độ thế giới (y lên) -> pixel (y xuống) ----------
function makeView(points, { w, h, pad = 46, keepAspect = true, minScale = 0, maxScale = Infinity } = {}) {
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-9); const spanY = Math.max(maxY - minY, 1e-9);
  const availW = w - 2 * pad; const availH = h - 2 * pad;
  let sx = availW / spanX; let sy = availH / spanY;
  if (keepAspect) { sx = Math.min(sx, sy); sy = sx; }
  sx = Math.min(Math.max(sx, minScale), maxScale); sy = keepAspect ? sx : Math.min(Math.max(sy, minScale), maxScale);
  const offX = pad + (availW - spanX * sx) / 2; const offY = pad + (availH - spanY * sy) / 2;
  return {
    sx, sy, minX, minY, maxX, maxY,
    X: (x) => offX + (x - minX) * sx,
    Y: (y) => h - (offY + (y - minY) * sy),
    P: (p) => [offX + (p[0] - minX) * sx, h - (offY + (p[1] - minY) * sy)],
    len: (l) => l * sx
  };
}

// ---------- Hình học phẳng dùng chung ----------
const D2R = Math.PI / 180;
function rad(deg) { return deg * D2R; }
function deg(r) { return r / D2R; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function mul(a, k) { return [a[0] * k, a[1] * k]; }
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function unit(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function angleBetween(a, b) { return deg(Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))))); }

/** Cung tròn góc (pixel space) từ hướng u đến hướng v (vector đơn vị pixel), bán kính r, quanh c. */
function arcPath(c, u, v, r) {
  const a0 = Math.atan2(u[1], u[0]); let a1 = Math.atan2(v[1], v[0]);
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  a1 = a0 + d;
  const p0 = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)];
  const p1 = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)];
  const large = Math.abs(d) > Math.PI ? 1 : 0; const sweep = d > 0 ? 1 : 0;
  return `M${num(p0[0])},${num(p0[1])} A${num(r)},${num(r)} 0 ${large} ${sweep} ${num(p1[0])},${num(p1[1])}`;
}

/** Ký hiệu góc vuông (pixel space) tại đỉnh v, hai cạnh hướng u1,u2. */
function rightAngleMark(v, u1, u2, size = 11) {
  const a = [v[0] + u1[0] * size, v[1] + u1[1] * size];
  const b = [v[0] + (u1[0] + u2[0]) * size, v[1] + (u1[1] + u2[1]) * size];
  const c = [v[0] + u2[0] * size, v[1] + u2[1] * size];
  return polyline([a, b, c], { w: 1.4 });
}

// ---------- Validate / sanitize SVG (lớp phòng thủ thứ 2) ----------
const ALLOWED_TAGS = new Set(['svg', 'g', 'defs', 'marker', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'text', 'tspan', 'title', 'desc']);
const ALLOWED_ATTRS = new Set([
  'xmlns', 'viewbox', 'width', 'height', 'role', 'aria-label', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'opacity',
  'transform', 'text-anchor', 'font-size', 'font-family', 'font-weight', 'font-style', 'dy', 'dx', 'id',
  'marker-end', 'marker-start', 'refx', 'refy', 'markerwidth', 'markerheight', 'orient', 'markerunits'
]);
const MAX_SVG_BYTES = 90 * 1024;

/**
 * validateSvg() — kiểm tra SVG theo ALLOWLIST. Không sửa, chỉ báo lỗi.
 * @returns {{ok:boolean, errors:string[], bytes:number}}
 */
function validateSvg(svg) {
  const errors = [];
  if (typeof svg !== 'string' || !svg.trim()) return { ok: false, errors: ['empty'], bytes: 0 };
  const bytes = Buffer.byteLength(svg, 'utf8');
  if (bytes > MAX_SVG_BYTES) errors.push('too_large');
  if (!/^<svg[\s>]/.test(svg.trim()) || !/<\/svg>\s*$/.test(svg)) errors.push('not_single_svg_root');
  const hard = [
    [/<!\s*(doctype|entity|\[cdata)/i, 'doctype_or_entity'], [/<\?/, 'processing_instruction'],
    [/<\s*script/i, 'script'], [/<\s*style/i, 'style'], [/<\s*foreignobject/i, 'foreignObject'],
    [/<\s*image/i, 'image'], [/<\s*use[\s>/]/i, 'use'], [/<\s*iframe/i, 'iframe'], [/<\s*a[\s>]/i, 'anchor'],
    [/javascript\s*:/i, 'javascript_uri'], [/vbscript\s*:/i, 'vbscript_uri'], [/\bdata\s*:/i, 'data_uri'],
    [/\son[a-z]+\s*=/i, 'event_handler'], [/@import/i, 'css_import'], [/expression\s*\(/i, 'css_expression'],
    [/(?:xlink:)?href\s*=/i, 'href']
  ];
  hard.forEach(([re, name]) => { if (re.test(svg)) errors.push(name); });

  const tagRe = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>/g;
  let m; let consumed = 0; let stray = svg;
  while ((m = tagRe.exec(svg))) {
    consumed += m[0].length;
    const tag = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) { errors.push(`tag:${tag}`); continue; }
    if (m[1]) continue;
    const attrRe = /\s+([^\s=>/]+)(?:\s*=\s*"([^"]*)")?/g; let a;
    while ((a = attrRe.exec(m[3]))) {
      const name = a[1].toLowerCase(); const val = a[2] == null ? '' : a[2];
      if (!ALLOWED_ATTRS.has(name)) { errors.push(`attr:${name}`); continue; }
      if (name === 'xmlns' && val !== 'http://www.w3.org/2000/svg') errors.push('xmlns_value');
      if (/url\s*\(/i.test(val) && !/^url\(#[A-Za-z0-9_-]+\)$/.test(val.trim())) errors.push('external_url_ref');
      if (name !== 'xmlns' && /https?:|\/\//i.test(val)) errors.push('remote_ref');
      if (/[<>]/.test(val)) errors.push('raw_angle_in_attr');
    }
  }
  // Mọi '<' phải thuộc một thẻ hợp lệ đã khớp.
  const lt = (svg.match(/</g) || []).length;
  const matchedTags = (svg.match(/<\s*\/?\s*[A-Za-z][\w:.-]*/g) || []).length;
  if (lt !== matchedTags) errors.push('malformed_markup');
  stray = null; void stray; void consumed;
  return { ok: errors.length === 0, errors: [...new Set(errors)], bytes };
}

function assertSafeSvg(svg) {
  const v = validateSvg(svg);
  if (!v.ok) { const e = new Error(`unsafe_svg:${v.errors.join(',')}`); e.code = 'unsafe_svg'; e.errors = v.errors; throw e; }
  return svg;
}

/** Hash ổn định cho spec có cấu trúc (khoá cache SVG). Sắp xếp key để thứ tự không ảnh hưởng. */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
function specHash(spec, version = 'svg-v1') {
  return crypto.createHash('sha256').update(`${version}|${stableStringify(spec)}`).digest('hex').slice(0, 32);
}

module.exports = {
  COLORS, FONT, esc, num, fmt, attrs, el, line, circle, rect, polygon, polyline, path, text, textSub,
  Canvas, makeView, arrowColor, defsFor,
  rad, deg, sub, add, mul, dist, unit, dot, angleBetween, arcPath, rightAngleMark,
  validateSvg, assertSafeSvg, stableStringify, specHash, MAX_SVG_BYTES, ALLOWED_TAGS
};
