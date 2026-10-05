'use strict';

// ============================================================================================
// INEQUALITY — bất phương trình 1 ẩn (trục số) & hệ bất phương trình 2 ẩn (miền nghiệm)
// ============================================================================================
// Đề bài (văn bản) -> parse đại số TUYẾN TÍNH -> VALIDATE toán học -> SVG tất định.
//   0 token, 0 mạng. KHÔNG nhờ LLM vẽ. Nguyên tắc: thà "không tất định" (rơi xuống nhánh khác) còn hơn vẽ SAI.
//
// Hỗ trợ  : ax+by+c  {<,≤,>,≥}  dx+ey+f  (ẩn x,y; hệ số số thực/phân số; ngoặc; nhân ngầm "2x"; "x, y ≥ 0");
//           chuỗi "−1 < x ≤ 3"; "0 ≤ x+y ≤ 4"; ≠ (CHỈ 1 ẩn); điểm kiểm tra "M(1; 2)" (CHỈ 2 ẩn).
// KHÔNG   : phi tuyến (x², |x|, √, xy, 1/x...), "hoặc"/hợp, phương trình "=", >2 ẩn, ẩn khác x/y.
//           Gặp bất kỳ biểu thức có ẩn mà KHÔNG parse được -> trả null cho CẢ đề (không vẽ thiếu ràng buộc).
// Mâu thuẫn: tập nghiệm rỗng / miền không có diện tích -> {error} để UI báo thẳng, không vẽ hình gây hiểu lầm.

const K = require('./svgKit');

const EPS = 1e-9;
const MAX_ABS = 1e6;
const MAX_CONSTRAINTS = 8;

const KEYWORD_RE = /bất\s*phương\s*trình|bpt\b|miền\s*nghiệm|tập\s*nghiệm|trục\s*số|nửa\s*mặt\s*phẳng|hệ\s*bất|biểu\s*diễn\s*(?:hình\s*học\s*)?(?:tập|miền)|inequalit/i;
const NONLINEAR_RE = /[²³^√|]|\b(?:sin|cos|tan|cot|log|ln|exp)\b|\bhoặc\b|\bor\b/i;

// ---------------------------------------------------------------- chuẩn hoá văn bản
function normalizeText(raw) {
  let s = String(raw == null ? '' : raw).normalize('NFC');
  s = s.replace(/\$/g, ' ')
    .replace(/\\leqslant|\\leq|\\le\b/g, '≤').replace(/\\geqslant|\\geq|\\ge\b/g, '≥').replace(/\\neq|\\ne\b/g, '≠')
    .replace(/\\cdot|\\times/g, '*').replace(/\\left|\\right/g, '').replace(/\\[,;!: ]/g, ' ')
    .replace(/[−–—]/g, '-').replace(/[×·]/g, '*')
    .replace(/<=|=</g, '≤').replace(/>=|=>/g, '≥').replace(/!=|<>/g, '≠')
    .replace(/(\d),(\d)/g, '$1.$2'); // dấu phẩy thập phân kiểu Việt: 0,5 -> 0.5
  // "x, y ≥ 0" / "x; y > 0"  ->  "x ≥ 0 ; y ≥ 0"
  s = s.replace(/(^|[^\p{L}\d])([xy])\s*[,;]\s*([xy])\s*(≤|≥|<|>)\s*(-?\d+(?:\.\d+)?)/giu, (m, pre, a, b, op, n) => `${pre}${a} ${op} ${n} ; ${b} ${op} ${n}`);
  return s;
}

/** Tách điểm kiểm tra "M(1; 2)" ra khỏi văn bản (để dấu ; , không làm vỡ phân đoạn). */
function extractPoints(s) {
  const pts = [];
  const re = /(^|[^\p{L}\d])([A-Z][A-Za-z0-9']{0,2})\s*\(\s*(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)\s*\)/gu;
  const rest = s.replace(re, (m, pre, name, x, y) => {
    if (pts.length < 6) pts.push({ name, x: Number(x), y: Number(y) });
    return `${pre} `;
  });
  return { text: rest, points: pts };
}

// ---------------------------------------------------------------- parser đại số tuyến tính
// Dạng tuyến tính: {x, y, c}. Trả về null nếu không tuyến tính / sai cú pháp.
const lin = (x, y, c) => ({ x, y, c });
const isConst = (f) => Math.abs(f.x) < EPS && Math.abs(f.y) < EPS;
const addL = (a, b) => lin(a.x + b.x, a.y + b.y, a.c + b.c);
const subL = (a, b) => lin(a.x - b.x, a.y - b.y, a.c - b.c);
const scaleL = (a, k) => lin(a.x * k, a.y * k, a.c * k);

function tokenize(src) {
  const toks = []; let i = 0; let space = false;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { space = true; i += 1; continue; }
    if (/\d/.test(ch)) {
      let j = i; while (j < src.length && /[\d]/.test(src[j])) j += 1;
      if (src[j] === '.' && /\d/.test(src[j + 1] || '')) { j += 1; while (j < src.length && /\d/.test(src[j])) j += 1; }
      toks.push({ t: 'num', v: Number(src.slice(i, j)), space }); i = j; space = false; continue;
    }
    if (/[xyXY]/.test(ch)) { toks.push({ t: 'var', v: ch.toLowerCase(), space }); i += 1; space = false; continue; }
    if ('+-*/()'.includes(ch)) { toks.push({ t: ch, space }); i += 1; space = false; continue; }
    return null; // ký tự lạ => không parse
  }
  return toks;
}

function parseLinear(src) {
  const toks = tokenize(String(src).trim());
  if (!toks || !toks.length) return null;
  let p = 0;
  const peek = () => toks[p];
  function expr() {
    let left = term(); if (!left) return null;
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p].t; p += 1;
      const right = term(); if (!right) return null;
      left = op === '+' ? addL(left, right) : subL(left, right);
    }
    return left;
  }
  function term() {
    let left = factor(); if (!left) return null;
    for (;;) {
      const nx = peek(); if (!nx) break;
      let op = null;
      if (nx.t === '*' || nx.t === '/') { op = nx.t; p += 1; }
      else if ((nx.t === 'var' || nx.t === '(') && !nx.space) op = 'imp'; // "2x", "3(x+1)"
      else if (nx.t === 'num' && false) op = 'imp';
      else break;
      const right = op === 'imp' ? atom() : factor(); if (!right) return null;
      if (op === '/') {
        if (!isConst(right) || Math.abs(right.c) < EPS) return null;
        left = scaleL(left, 1 / right.c);
      } else if (isConst(left)) left = scaleL(right, left.c);
      else if (isConst(right)) left = scaleL(left, right.c);
      else return null; // tích hai biểu thức chứa ẩn => phi tuyến (xy, x(x+1)...)
    }
    return left;
  }
  function factor() {
    const nx = peek(); if (!nx) return null;
    if (nx.t === '+') { p += 1; return factor(); }
    if (nx.t === '-') { p += 1; const f = factor(); return f ? scaleL(f, -1) : null; }
    return atom();
  }
  function atom() {
    const nx = peek(); if (!nx) return null;
    if (nx.t === 'num') { p += 1; return lin(0, 0, nx.v); }
    if (nx.t === 'var') { p += 1; return nx.v === 'x' ? lin(1, 0, 0) : lin(0, 1, 0); }
    if (nx.t === '(') {
      p += 1; const e = expr();
      if (!e || !peek() || peek().t !== ')') return null;
      p += 1; return e;
    }
    return null;
  }
  const r = expr();
  if (!r || p !== toks.length) return null;
  if (![r.x, r.y, r.c].every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_ABS)) return null;
  return r;
}

function balanceParens(s) {
  let t = s.trim();
  for (let guard = 0; guard < 6; guard += 1) {
    let depth = 0; let minDepth = 0;
    for (const ch of t) { if (ch === '(') depth += 1; else if (ch === ')') { depth -= 1; minDepth = Math.min(minDepth, depth); } }
    if (depth === 0 && minDepth === 0) return t;
    if (minDepth < 0 && t.endsWith(')')) t = t.slice(0, -1).trim();
    else if (depth > 0 && t.startsWith('(')) t = t.slice(1).trim();
    else if (minDepth < 0 && t.startsWith(')')) t = t.slice(1).trim();
    else if (depth > 0 && t.endsWith('(')) t = t.slice(0, -1).trim();
    else return null;
  }
  return null;
}

// ---------------------------------------------------------------- trích bất phương trình từ văn bản
const OPS = { '<': 'lt', '≤': 'le', '>': 'gt', '≥': 'ge', '≠': 'ne' };
const OP_SYM = { lt: '<', le: '≤', gt: '>', ge: '≥', ne: '≠' };

/**
 * @returns {null | {error:string, detail:string} | {kind:'number_line'|'region', ineqs:Array, points:Array, variable?:string}}
 */
function extractInequality(text) {
  const raw = String(text || '');
  if (raw.length > 4000) return null;
  if (!KEYWORD_RE.test(raw)) return null; // cổng từ khoá: KHÔNG nuốt đề hình học/vật lí có dấu < >
  if (NONLINEAR_RE.test(raw)) return null;

  const norm = normalizeText(raw);
  const { text: body, points } = extractPoints(norm);

  const segRe = /(?<![\p{L}\d])[0-9xXyY+\-*/.()\s<>≤≥≠=]+/gu;
  const segs = body.match(segRe) || [];
  const constraints = [];
  let sawRelation = false;

  for (let seg of segs) {
    if (!/[<>≤≥≠=]/.test(seg)) continue;
    seg = seg.replace(/[\s.]+$/, '').replace(/^[\s.]+/, '');
    if (!/[xyXY]/.test(seg)) continue; // so sánh số thuần (3 < 5) hoặc mũi tên "->": bỏ qua
    sawRelation = true;
    if (/(?:^|[^<>≤≥≠])=(?!=)/.test(seg)) return null; // có phương trình "=": không tất định
    const bal = balanceParens(seg); if (bal === null) return null;
    seg = bal;
    const parts = seg.split(/(≤|≥|≠|<|>)/).map((s) => s.trim());
    const ops = []; const exprs = [];
    for (let i = 0; i < parts.length; i += 1) { if (i % 2 === 0) exprs.push(parts[i]); else ops.push(OPS[parts[i]]); }
    if (!ops.length || exprs.some((e) => !e)) return null;
    if (ops.length > 1) {
      const fam = (o) => (o === 'lt' || o === 'le' ? 'asc' : (o === 'gt' || o === 'ge' ? 'desc' : 'bad'));
      const f0 = fam(ops[0]);
      if (f0 === 'bad' || ops.some((o) => fam(o) !== f0) || ops.length > 2) return null;
    }
    const forms = exprs.map(parseLinear);
    if (forms.some((f) => !f)) return null;
    for (let i = 0; i < ops.length; i += 1) {
      const d = subL(forms[i], forms[i + 1]); // (L - R) op 0
      constraints.push({ A: d.x, B: d.y, C: d.c, op: ops[i], label: `${exprs[i]} ${OP_SYM[ops[i]]} ${exprs[i + 1]}`.replace(/\s+/g, ' ').slice(0, 44), chainLabel: ops.length > 1 ? exprs.map((e, k) => (k < ops.length ? `${e} ${OP_SYM[ops[k]]}` : e)).join(' ').replace(/\s+/g, ' ').slice(0, 44) : undefined });
    }
  }
  if (!sawRelation || !constraints.length) return null;
  if (constraints.length > MAX_CONSTRAINTS) return null;

  const usesX = constraints.some((c) => Math.abs(c.A) > EPS);
  const usesY = constraints.some((c) => Math.abs(c.B) > EPS);
  if (usesX && usesY) {
    if (constraints.some((c) => c.op === 'ne')) return null; // ≠ trong mặt phẳng: không dựng
    return { kind: 'region', ineqs: constraints, points };
  }
  const variable = usesY && !usesX ? 'y' : 'x';
  const one = constraints.map((c) => ({ A: variable === 'x' ? c.A : c.B, C: c.C, op: c.op, label: c.chainLabel || c.label }));
  return { kind: 'number_line', variable, ineqs: one, points: [] };
}

// ---------------------------------------------------------------- tiện ích hiển thị
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
const isStrict = (op) => op === 'lt' || op === 'gt';
// Ký hiệu toán (∪, ≠, ≤...) không có trong mọi font: khai báo chuỗi font dự phòng để trình duyệt/rasterizer không hiện ô vuông.
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
const PALETTE = [K.COLORS.RED, K.COLORS.GREEN, K.COLORS.ORANGE, K.COLORS.PURPLE, K.COLORS.TEAL, '#be185d', '#4d7c0f', '#1d4ed8'];

// ---------------------------------------------------------------- 1 ẩn: giải đại số + vẽ trục số
function solveInterval(spec) {
  let lo = -Infinity; let loIncl = false; let hi = Infinity; let hiIncl = false;
  const excl = [];
  for (const c of spec.ineqs) {
    if (Math.abs(c.A) < EPS) { // 0·x + C op 0  -> hằng
      const v = c.C;
      const truth = { lt: v < -EPS, le: v < EPS, gt: v > EPS, ge: v > -EPS, ne: Math.abs(v) > EPS }[c.op];
      if (!truth) return { empty: true, reason: 'constant_false' };
      continue;
    }
    // A x + C op 0  ->  x op' (-C/A), đảo chiều khi A < 0
    const b = -c.C / c.A;
    let op = c.op;
    if (c.A < 0) op = { lt: 'gt', le: 'ge', gt: 'lt', ge: 'le', ne: 'ne' }[op];
    if (op === 'ne') { excl.push(b); continue; }
    if (op === 'lt' || op === 'le') {
      const incl = op === 'le';
      if (b < hi - EPS) { hi = b; hiIncl = incl; } else if (Math.abs(b - hi) <= EPS) hiIncl = hiIncl && incl;
    } else {
      const incl = op === 'ge';
      if (b > lo + EPS) { lo = b; loIncl = incl; } else if (Math.abs(b - lo) <= EPS) loIncl = loIncl && incl;
    }
  }
  if (lo > hi + EPS) return { empty: true, reason: 'lo_gt_hi' };
  if (Math.abs(lo - hi) <= EPS && Number.isFinite(lo) && !(loIncl && hiIncl)) return { empty: true, reason: 'open_point' };
  const ex = [...new Set(excl.map((e) => Math.round(e * 1e9) / 1e9))].filter((e) => (e > lo + EPS || (Math.abs(e - lo) <= EPS && loIncl)) && (e < hi - EPS || (Math.abs(e - hi) <= EPS && hiIncl))).sort((a, b) => a - b);
  // điểm biên bị loại bởi ≠ -> biên trở thành mở
  if (Number.isFinite(lo) && ex.some((e) => Math.abs(e - lo) <= EPS)) loIncl = false;
  if (Number.isFinite(hi) && ex.some((e) => Math.abs(e - hi) <= EPS)) hiIncl = false;
  const inner = ex.filter((e) => e > lo + EPS && e < hi - EPS);
  if (Math.abs(lo - hi) <= EPS && Number.isFinite(lo) && ex.length) return { empty: true, reason: 'point_excluded' };
  return { empty: false, lo, loIncl, hi, hiIncl, excl: inner };
}

function intervalNotation(r, v) {
  if (!Number.isFinite(r.lo) && !Number.isFinite(r.hi) && !r.excl.length) return 'ℝ';
  if (Number.isFinite(r.lo) && Math.abs(r.lo - r.hi) <= EPS) return `{${fracStr(r.lo)}}`;
  const pts = [r.lo, ...r.excl, r.hi];
  const flags = [r.loIncl, ...r.excl.map(() => false), r.hiIncl];
  const pieces = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]; const b = pts[i + 1];
    const left = i === 0 ? (Number.isFinite(a) ? (flags[0] ? '[' : '(') : '(') : '(';
    const right = i === pts.length - 2 ? (Number.isFinite(b) ? (flags[flags.length - 1] ? ']' : ')') : ')') : ')';
    pieces.push(`${left}${Number.isFinite(a) ? fracStr(a) : '−∞'}; ${Number.isFinite(b) ? fracStr(b) : '+∞'}${right}`);
  }
  void v;
  return pieces.join(' ∪ ');
}

function validateInequality(spec) {
  if (spec.kind === 'number_line') {
    const r = solveInterval(spec);
    if (r.empty) return { code: 'inequality_contradiction:empty_solution', detail: r.reason === 'constant_false' ? 'có bất phương trình luôn sai (vô nghiệm)' : 'các điều kiện mâu thuẫn nhau nên tập nghiệm rỗng' };
    return null;
  }
  const poly = regionPolygon(spec).poly;
  if (!poly || polyArea(poly) <= 1e-9 * Math.max(1, frameArea(spec))) {
    return { code: 'inequality_contradiction:empty_region', detail: 'hệ bất phương trình vô nghiệm (miền nghiệm rỗng hoặc chỉ là một đoạn/điểm)' };
  }
  return null;
}

function renderNumberLine(spec) {
  const r = solveInterval(spec);
  if (r.empty) { const e = new Error('inequality_empty'); e.code = 'inequality_contradiction:empty_solution'; throw e; }
  const v = spec.variable || 'x';
  const W = 640; const axisY = 96; const left = 36; const right = W - 36;
  const finiteMarks = [0, r.lo, r.hi, ...r.excl].filter(Number.isFinite);
  let mn = Math.min(...finiteMarks); let mx = Math.max(...finiteMarks);
  if (mx - mn < EPS) { mn -= 3; mx += 3; }
  const pad = Math.max((mx - mn) * 0.3, 1);
  mn -= pad; mx += pad;
  const step = niceStep((mx - mn) / 9);
  const sx = (right - left) / (mx - mn);
  const X = (val) => left + (val - mn) * sx;
  const c = new K.Canvas(W, 150 + 22 * (1 + new Set(spec.ineqs.map((q) => q.label)).size));
  const BLUE = K.COLORS.BLUE;

  // vùng nghiệm (thanh dày) — vẽ trước để trục & chấm nằm trên
  const x0 = Number.isFinite(r.lo) ? X(r.lo) : left - 8; const x1 = Number.isFinite(r.hi) ? X(r.hi) : right + 8;
  if (x1 - x0 > 0.5) c.add(K.el('rect', { x: K.num(x0), y: axisY - 9, width: K.num(x1 - x0), height: 18, fill: BLUE, 'fill-opacity': 0.28 }));
  c.arrow(left - 14, axisY, right + 14, axisY, { stroke: K.COLORS.INK, w: 2 });
  c.add(K.text(right + 12, axisY + 22, v, { size: 15, italic: true }));
  for (let t = Math.ceil(mn / step) * step; t <= mx + EPS; t += step) {
    const tv = Math.abs(t) < 1e-9 ? 0 : Math.round(t * 1e9) / 1e9;
    c.add(K.line(X(tv), axisY - 5, X(tv), axisY + 5, { w: 1.4 }));
    c.add(K.text(X(tv), axisY + 22, fracStr(tv), { size: 12, color: K.COLORS.MUTED }));
  }
  // mũi tên "kéo dài vô cực" cho phía không chặn
  if (!Number.isFinite(r.hi)) c.arrow(X(r.lo) + (Number.isFinite(r.lo) ? 6 : 0), axisY - 22, right + 6, axisY - 22, { stroke: BLUE, w: 2.4 });
  if (!Number.isFinite(r.lo)) c.arrow(X(r.hi) - (Number.isFinite(r.hi) ? 6 : 0), axisY - 22, left - 6, axisY - 22, { stroke: BLUE, w: 2.4 });
  const dot = (val, incl) => c.add(K.circle(X(val), axisY, 6.5, { fill: incl ? BLUE : K.COLORS.PAPER, stroke: BLUE, w: 2.4 }));
  const mark = (val, incl) => { dot(val, incl); c.add(K.text(X(val), axisY - 16, fracStr(val), { size: 13, bold: true, color: BLUE })); };
  if (Number.isFinite(r.lo)) mark(r.lo, r.loIncl);
  if (Number.isFinite(r.hi) && Math.abs(r.hi - r.lo) > EPS) mark(r.hi, r.hiIncl);
  r.excl.forEach((e) => { dot(e, false); c.add(K.text(X(e), axisY - 16, `${v}≠${fracStr(e)}`, { size: 12, bold: true, color: K.COLORS.RED })); });

  const notation = intervalNotation(r, v);
  // Dòng tiêu đề. Ký hiệu hợp "∪" KHÔNG có trong mọi font (hiện ô vuông) -> vẽ bằng path, chia đoạn quanh nó.
  const headParts = `Tập nghiệm: S = ${notation}`.split(' ∪ ');
  if (headParts.length === 1) {
    c.add(symText(W / 2, 40, headParts[0], { size: 17, bold: true }));
  } else {
    const cw = 17 * 0.56; const gap = 26;
    const widths = headParts.map((p) => p.length * cw);
    let cx0 = (W - (widths.reduce((s, w) => s + w, 0) + gap * (headParts.length - 1))) / 2;
    headParts.forEach((p, i) => {
      c.add(symText(cx0, 40, p, { size: 17, bold: true, anchor: 'start' }));
      cx0 += widths[i];
      if (i < headParts.length - 1) {
        const ux = cx0 + gap / 2;
        c.add(K.path(`M${K.num(ux - 6)},30 L${K.num(ux - 6)},38 A6,6 0 0 0 ${K.num(ux + 6)},38 L${K.num(ux + 6)},30`, { stroke: K.COLORS.INK, w: 2 }));
        cx0 += gap;
      }
    });
  }
  let y = 150;
  const seen = new Set();
  spec.ineqs.forEach((q) => { if (seen.has(q.label)) return; seen.add(q.label); c.add(symText(left, y, `• ${q.label}`, { size: 13, anchor: 'start', color: K.COLORS.MUTED })); y += 22; });
  c.add(K.text(left, y, '○ không lấy biên (< hoặc >)   ● lấy biên (≤ hoặc ≥)   phần tô xanh: tập nghiệm', { size: 12, anchor: 'start', color: K.COLORS.MUTED }));

  c.title = `Biểu diễn tập nghiệm trên trục số: S = ${notation}`;
  c.desc = `Tập nghiệm của ${spec.ineqs.length > 1 ? 'hệ bất phương trình' : 'bất phương trình'} theo biến ${v} là S = ${notation}. Chấm đặc nghĩa là lấy giá trị biên, chấm rỗng nghĩa là không lấy.`;
  return { svg: c.toSvg(), title: c.title, desc: c.desc };
}

// ---------------------------------------------------------------- 2 ẩn: miền nghiệm
function halfPlaneKeep(c) { return c.op === 'gt' || c.op === 'ge' ? 1 : -1; } // (A x + B y + C) op 0: giữ phía >0 với >,≥ ; phía <0 với <,≤

function intersections(spec) {
  const out = []; const q = spec.ineqs;
  for (let i = 0; i < q.length; i += 1) for (let j = i + 1; j < q.length; j += 1) {
    const det = q[i].A * q[j].B - q[j].A * q[i].B;
    if (Math.abs(det) < EPS) continue;
    out.push({ x: (q[i].B * q[j].C - q[j].B * q[i].C) / det, y: (q[i].C * q[j].A - q[j].C * q[i].A) / det, i, j });
  }
  return out;
}

function viewBounds(spec) {
  const pts = [[0, 0]];
  spec.ineqs.forEach((c) => { if (Math.abs(c.A) > EPS) pts.push([-c.C / c.A, 0]); if (Math.abs(c.B) > EPS) pts.push([0, -c.C / c.B]); });
  intersections(spec).forEach((p) => pts.push([p.x, p.y]));
  (spec.points || []).forEach((p) => pts.push([p.x, p.y]));
  let minX = Math.min(...pts.map((p) => p[0])); let maxX = Math.max(...pts.map((p) => p[0]));
  let minY = Math.min(...pts.map((p) => p[1])); let maxY = Math.max(...pts.map((p) => p[1]));
  if (maxX - minX < 4) { const m = (minX + maxX) / 2; minX = m - 2; maxX = m + 2; }
  if (maxY - minY < 4) { const m = (minY + maxY) / 2; minY = m - 2; maxY = m + 2; }
  const px = Math.max((maxX - minX) * 0.22, 0.8); const py = Math.max((maxY - minY) * 0.22, 0.8);
  return { minX: minX - px, maxX: maxX + px, minY: minY - py, maxY: maxY + py };
}

const PLOT_W = 640; const PLOT_H = 440; const PAD = 30;
function makePlotView(spec) {
  const b = viewBounds(spec);
  const view = K.makeView([[b.minX, b.minY], [b.maxX, b.maxY]], { w: PLOT_W, h: PLOT_H, pad: PAD, keepAspect: true });
  const inv = {
    x: (px) => view.minX + (px - view.X(view.minX)) / view.sx,
    y: (py) => view.minY + (view.Y(view.minY) - py) / view.sx
  };
  const m = 8; // lề trong khung
  const frame = { L: inv.x(m), R: inv.x(PLOT_W - m), B: inv.y(PLOT_H - m), T: inv.y(m) };
  return { view, frame };
}
function frameArea(spec) { const { frame: f } = makePlotView(spec); return (f.R - f.L) * (f.T - f.B); }

function clipPolygon(poly, c) {
  const s = halfPlaneKeep(c); const f = (p) => s * (c.A * p[0] + c.B * p[1] + c.C);
  const out = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]; const b = poly[(i + 1) % poly.length];
    const fa = f(a); const fb = f(b);
    if (fa >= -EPS) out.push(a);
    if ((fa > EPS && fb < -EPS) || (fa < -EPS && fb > EPS)) {
      const t = fa / (fa - fb); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}
function polyArea(poly) { let s = 0; for (let i = 0; i < poly.length; i += 1) { const a = poly[i]; const b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }

function regionPolygon(spec) {
  const { view, frame: f } = makePlotView(spec);
  let poly = [[f.L, f.B], [f.R, f.B], [f.R, f.T], [f.L, f.T]];
  for (const c of spec.ineqs) { poly = clipPolygon(poly, c); if (poly.length < 3) return { poly: null, view, frame: f }; }
  return { poly, view, frame: f };
}

function clipLineToFrame(c, f) {
  const pts = [];
  const push = (x, y) => { if (x >= f.L - 1e-7 && x <= f.R + 1e-7 && y >= f.B - 1e-7 && y <= f.T + 1e-7) pts.push([x, y]); };
  if (Math.abs(c.B) > EPS) { push(f.L, -(c.A * f.L + c.C) / c.B); push(f.R, -(c.A * f.R + c.C) / c.B); }
  if (Math.abs(c.A) > EPS) { push(-(c.B * f.B + c.C) / c.A, f.B); push(-(c.B * f.T + c.C) / c.A, f.T); }
  if (pts.length < 2) return null;
  let best = null; let bd = -1;
  for (let i = 0; i < pts.length; i += 1) for (let j = i + 1; j < pts.length; j += 1) {
    const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]); if (d > bd) { bd = d; best = [pts[i], pts[j]]; }
  }
  return bd > 1e-9 ? best : null;
}

function satisfies(spec, x, y) {
  let strictlyOk = true; let closedOk = true;
  for (const c of spec.ineqs) {
    const v = halfPlaneKeep(c) * (c.A * x + c.B * y + c.C);
    if (v < -1e-7) { closedOk = false; strictlyOk = false; } else if (isStrict(c.op) && v <= 1e-7) strictlyOk = false;
  }
  return { closed: closedOk, strict: strictlyOk };
}

function renderRegion(spec) {
  const { poly, view, frame: f } = regionPolygon(spec);
  if (!poly || polyArea(poly) <= 1e-9 * Math.max(1, (f.R - f.L) * (f.T - f.B))) {
    const e = new Error('inequality_empty_region'); e.code = 'inequality_contradiction:empty_region'; throw e;
  }
  const n = spec.ineqs.length;
  const H = PLOT_H + 24 * (n + 2) + 10;
  const c = new K.Canvas(PLOT_W, H);
  const P = (x, y) => view.P([x, y]);
  const INK = K.COLORS.INK; const GRID = K.COLORS.GRID; const BLUE = K.COLORS.BLUE;

  // lưới + nhãn trục
  const step = niceStep((f.R - f.L) / 9);
  const ticks = [];
  for (let t = Math.ceil(f.L / step) * step; t <= f.R + EPS; t += step) ticks.push(Math.round(t * 1e9) / 1e9);
  const ticksY = [];
  for (let t = Math.ceil(f.B / step) * step; t <= f.T + EPS; t += step) ticksY.push(Math.round(t * 1e9) / 1e9);
  ticks.forEach((t) => { const [px] = P(t, 0); c.add(K.line(px, P(0, f.B)[1], px, P(0, f.T)[1], { stroke: GRID, w: 1 })); });
  ticksY.forEach((t) => { const [, py] = P(0, t); c.add(K.line(P(f.L, 0)[0], py, P(f.R, 0)[0], py, { stroke: GRID, w: 1 })); });

  // miền nghiệm (tô)
  c.add(K.el('polygon', { points: poly.map((p) => P(p[0], p[1]).map((v) => K.num(v)).join(',')).join(' '), fill: BLUE, 'fill-opacity': 0.26, stroke: 'none' }));

  // trục Ox, Oy (tại gốc) — vẽ TRƯỚC biên để đường biên (vd x ≥ 0, y > 0 trùng trục) không bị trục che mất màu/nét đứt
  const [ox, oy] = P(0, 0);
  c.arrow(P(f.L, 0)[0], oy, P(f.R, 0)[0], oy, { stroke: INK, w: 1.6 });
  c.arrow(ox, P(0, f.B)[1], ox, P(0, f.T)[1], { stroke: INK, w: 1.6 });

  // biên (đứt nét nếu bất đẳng thức chặt)
  spec.ineqs.forEach((q, i) => {
    const seg = clipLineToFrame(q, f); if (!seg) return;
    const [a, b] = [P(seg[0][0], seg[0][1]), P(seg[1][0], seg[1][1])];
    c.add(K.line(a[0], a[1], b[0], b[1], { stroke: PALETTE[i % PALETTE.length], w: 2.6, dash: isStrict(q.op) ? '7 5' : undefined }));
    const fr = 0.9 - 0.17 * (i % 4); // mỗi đường một vị trí nhãn khác nhau để không chồng nhau
    const mx = a[0] + (b[0] - a[0]) * fr; const my = a[1] + (b[1] - a[1]) * fr;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const nx = -(b[1] - a[1]) / len; const ny = (b[0] - a[0]) / len;
    haloText(c, Math.min(PLOT_W - 14, Math.max(14, mx + nx * 13)), Math.min(PLOT_H - 6, Math.max(16, my + ny * 13)), `d${i + 1}`, { size: 13, bold: true, color: PALETTE[i % PALETTE.length] });
  });
  c.add(K.text(P(f.R, 0)[0] - 8, oy - 8, 'x', { size: 15, italic: true }));
  c.add(K.text(ox + 12, P(0, f.T)[1] + 12, 'y', { size: 15, italic: true }));
  ticks.filter((t) => Math.abs(t) > EPS).slice(0, 16).forEach((t) => haloText(c, P(t, 0)[0], oy + 15, fracStr(t), { size: 11, color: K.COLORS.MUTED }));
  ticksY.filter((t) => Math.abs(t) > EPS).slice(0, 16).forEach((t) => haloText(c, ox - 6, P(0, t)[1] + 4, fracStr(t), { size: 11, color: K.COLORS.MUTED, anchor: 'end' }));

  // đỉnh của miền (giao điểm thật sự thuộc miền đóng)
  const verts = [];
  intersections(spec).forEach((p) => {
    const s = satisfies(spec, p.x, p.y);
    if (s.closed && !verts.some((v) => Math.hypot(v.x - p.x, v.y - p.y) < 1e-7)) verts.push({ x: p.x, y: p.y, filled: s.strict || spec.ineqs.every((q) => !isStrict(q.op)) });
  });
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length; const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  const originIsVertex = verts.some((v) => Math.abs(v.x) < 1e-7 && Math.abs(v.y) < 1e-7);
  if (!originIsVertex) c.add(K.text(ox - 9, oy + 15, 'O', { size: 13 }));
  verts.slice(0, 8).forEach((v) => {
    const [px, py] = P(v.x, v.y);
    c.add(K.circle(px, py, 4.8, { fill: v.filled ? INK : K.COLORS.PAPER, stroke: INK, w: 1.8 }));
    const [qx, qy] = P(cx, cy); const dx = px - qx; const dy = py - qy;
    // nhãn đặt VỀ PHÍA XA tâm miền, neo theo hướng (không chồng lên chấm)
    const right = dx >= 0; const below = dy >= 0;
    const tx = Math.min(PLOT_W - 6, Math.max(6, px + (right ? 9 : -9)));
    const ty = Math.min(PLOT_H - 6, Math.max(16, py + (below ? 18 : -9)));
    haloText(c, tx, ty, `(${fracStr(v.x)}; ${fracStr(v.y)})`, { size: 12, bold: true, anchor: right ? 'start' : 'end' });
  });

  // điểm kiểm tra do đề cho
  const ptNotes = [];
  (spec.points || []).forEach((pt) => {
    const s = satisfies(spec, pt.x, pt.y); const inside = s.closed;
    const [px, py] = P(pt.x, pt.y); const col = inside ? K.COLORS.GREEN : K.COLORS.RED;
    c.add(K.circle(px, py, 5, { fill: col, stroke: INK, w: 1.2 }));
    c.add(K.text(px + 9, py - 8, `${pt.name}(${fracStr(pt.x)}; ${fracStr(pt.y)})`, { size: 12, bold: true, anchor: 'start', color: col }));
    ptNotes.push(`${pt.name}(${fracStr(pt.x)}; ${fracStr(pt.y)}) ${inside ? (s.strict ? 'thuộc' : 'nằm trên biên của') : 'không thuộc'} miền nghiệm`);
  });

  const unbounded = poly.some((p) => Math.abs(p[0] - f.L) < 1e-6 || Math.abs(p[0] - f.R) < 1e-6 || Math.abs(p[1] - f.B) < 1e-6 || Math.abs(p[1] - f.T) < 1e-6);

  // chú giải
  let ly = PLOT_H + 18;
  spec.ineqs.forEach((q, i) => {
    const col = PALETTE[i % PALETTE.length];
    c.add(K.line(18, ly - 4, 52, ly - 4, { stroke: col, w: 2.6, dash: isStrict(q.op) ? '7 5' : undefined }));
    c.add(K.text(60, ly, `d${i + 1}: ${q.label}${isStrict(q.op) ? '  (nét đứt: không lấy biên)' : ''}`, { size: 13, anchor: 'start' }));
    ly += 24;
  });
  c.add(K.el('rect', { x: 18, y: ly - 14, width: 34, height: 14, fill: BLUE, 'fill-opacity': 0.26, stroke: BLUE, 'stroke-width': 1 }));
  c.add(K.text(60, ly - 2, `Miền nghiệm (phần tô màu)${unbounded ? ' — không bị chặn' : ''}`, { size: 13, anchor: 'start', bold: true }));

  c.title = 'Miền nghiệm của hệ bất phương trình';
  c.desc = `Miền nghiệm của hệ ${n} bất phương trình ${spec.ineqs.map((q, i) => `d${i + 1}: ${q.label}`).join('; ')} là phần tô màu${unbounded ? ' (không bị chặn)' : ''}.` +
    `${verts.length ? ` Các đỉnh: ${verts.slice(0, 8).map((v) => `(${fracStr(v.x)}; ${fracStr(v.y)})`).join(', ')}.` : ''}${ptNotes.length ? ` ${ptNotes.join('. ')}.` : ''}`;
  return { svg: c.toSvg(), title: c.title, desc: c.desc, vertices: verts.map((v) => [v.x, v.y]), unbounded };
}

/** Điểm vào renderer. Ném lỗi có `.code` bắt đầu bằng 'inequality_contradiction:' khi vô nghiệm. */
function renderInequality(spec) {
  return spec.kind === 'number_line' ? renderNumberLine(spec) : renderRegion(spec);
}

module.exports = {
  extractInequality, renderInequality, validateInequality,
  _test: { parseLinear, normalizeText, solveInterval, intervalNotation, fracStr, regionPolygon, clipPolygon, polyArea, KEYWORD_RE }
};
