'use strict';

// ============================================================================================
// INEQUALITY — bất phương trình 1 ẩn (trục số) & hệ bất phương trình 2 ẩn (miền nghiệm)
// ============================================================================================
// Đề bài (văn bản) -> parse an toàn -> VALIDATE toán học -> SVG tất định. 0 token, 0 mạng. KHÔNG nhờ LLM vẽ.
// Nguyên tắc: thà "không tất định" (rơi xuống nhánh khác) còn hơn vẽ SAI.
//
// 1 ẩn (x hoặc y)  : bậc ≤ 2, có |...|, có "hoặc" (hợp), chuỗi "−1 < x ≤ 3", ≠  -> giải CHÍNH XÁC bằng đại số tập khoảng.
// 2 ẩn, tuyến tính : hệ ≤ 8 bất phương trình -> đa giác chính xác + đỉnh.
// 2 ẩn, cong       : parabol/đường tròn/elip/hypebol/|...| (bậc ≤ 2) -> lưới điểm + marching squares (ineqGrid.js).
// KHÔNG            : phương trình "=", hàm lượng giác/log/căn, mũ ≠ 2, >2 ẩn, ẩn khác x/y, "hoặc" giữa các điều kiện 2 ẩn,
//                    ≠ trong mặt phẳng. Gặp bất kỳ biểu thức có ẩn mà KHÔNG parse được -> null cho CẢ đề (không vẽ thiếu ràng buộc).
// Mâu thuẫn: tập nghiệm rỗng / miền không có diện tích -> {error} để UI báo thẳng, không vẽ hình gây hiểu lầm.

const C = require('./ineqCommon');
const X = require('./ineqExpr');
const SET = require('./ineqSet');
const GRID = require('./ineqGrid');

const { K, EPS, PLOT_W, PLOT_H, PALETTE, isStrict, OP_SYM, fracStr, niceStep, symText, haloText, makePlotView, buildGridAndAxes } = C;

const MAX_ABS = 1e6;
const MAX_CONSTRAINTS = 8;

const KEYWORD_RE = /bất\s*phương\s*trình|bpt\b|miền\s*nghiệm|tập\s*nghiệm|trục\s*số|nửa\s*mặt\s*phẳng|hệ\s*bất|biểu\s*diễn\s*(?:hình\s*học\s*)?(?:tập|miền)|inequalit/i;
// Hàm siêu việt, căn, luỹ thừa ≠ 2: không hỗ trợ. (|...|, ², ^2 và "hoặc" ĐƯỢC hỗ trợ.)
const UNSUPPORTED_RE = /[³⁴√∛]|\b(?:sin|cos|tan|cot|log|ln|exp|sqrt)\b|\^\s*(?!2(?!\d))\S/i;

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

const OPS = { '<': 'lt', '≤': 'le', '>': 'gt', '≥': 'ge', '≠': 'ne' };

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

// ---------------------------------------------------------------- trích các "nguyên tử" bất đẳng thức
const SEG_RE = /(?<![\p{L}\d])[0-9xXyY+\-*/.()\s<>≤≥≠=^²|]+/gu;

/** Trả về mảng nguyên tử của MỘT đoạn văn bản, hoặc null nếu có đoạn chứa quan hệ mà không parse được. */
function atomsOfText(text) {
  const atoms = [];
  const segs = text.match(SEG_RE) || [];
  for (let seg of segs) {
    if (!/[<>≤≥≠=]/.test(seg)) continue;
    seg = seg.replace(/[\s.]+$/, '').replace(/^[\s.]+/, '');
    if (!/[xyXY]/.test(seg)) continue; // so sánh số thuần (3 < 5) hoặc mũi tên "->": bỏ qua
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
    const parsed = exprs.map((e) => X.parse(e));
    if (parsed.some((q) => !q)) return null;
    const chainLabel = ops.length > 1 ? exprs.map((e, k) => (k < ops.length ? `${e} ${OP_SYM[ops[k]]}` : e)).join(' ').replace(/\s+/g, ' ').slice(0, 44) : undefined;
    for (let i = 0; i < ops.length; i += 1) {
      atoms.push({
        lhs: parsed[i].node, rhs: parsed[i + 1].node, op: ops[i],
        label: `${exprs[i]} ${OP_SYM[ops[i]]} ${exprs[i + 1]}`.replace(/\s+/g, ' ').slice(0, 44),
        chainLabel,
        vars: [...new Set([...parsed[i].vars, ...parsed[i + 1].vars])],
        deg: Math.max(parsed[i].deg, parsed[i + 1].deg), hasAbs: parsed[i].hasAbs || parsed[i + 1].hasAbs
      });
    }
  }
  return atoms;
}

const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);

/**
 * @returns {null | {kind:'number_line', variable:string, labels:string[], intervals:Array}
 *               | {kind:'region', ineqs:Array, points:Array}
 *               | {kind:'region_curved', atoms:Array, points:Array, view:object, unbounded:boolean}}
 */
function extractInequality(text) {
  const raw = String(text || '');
  if (raw.length > 4000) return null;
  if (!KEYWORD_RE.test(raw)) return null; // cổng từ khoá: KHÔNG nuốt đề hình học/vật lí có dấu < >
  if (UNSUPPORTED_RE.test(raw)) return null;

  const norm = normalizeText(raw);
  const { text: body, points } = extractPoints(norm);

  const partTexts = body.split(/(?<![\p{L}\d])(?:hoặc|or)(?![\p{L}\d])/giu);
  const parts = [];
  for (const pt of partTexts) {
    const a = atomsOfText(pt);
    if (a === null) return null;
    if (a.length) parts.push(a);
  }
  const atoms = parts.flat();
  if (!atoms.length || atoms.length > MAX_CONSTRAINTS) return null;

  const vars = [...new Set(atoms.flatMap((a) => a.vars))];
  if (!vars.length || vars.some((v) => v !== 'x' && v !== 'y')) return null;

  // ----- 1 ẩn: đại số tập khoảng -----
  if (vars.length === 1) {
    const v = vars[0];
    let total = SET.EMPTY();
    try {
      for (const part of parts) {
        let s = SET.FULL();
        for (const a of part) s = SET.intersect(s, SET.atomSet(a.lhs, a.rhs, a.op, v));
        total = SET.union(total, s);
      }
    } catch (e) {
      if (e instanceof X.ParseError) return null;
      throw e;
    }
    const seen = new Set();
    const labels = [];
    atoms.forEach((a) => { const l = a.chainLabel || a.label; if (!seen.has(l)) { seen.add(l); labels.push(l); } });
    return {
      kind: 'number_line', variable: v, labels, hoac: parts.length > 1,
      intervals: total.map((i) => ({ lo: finiteOrNull(i.lo), hi: finiteOrNull(i.hi), loI: i.loI, hiI: i.hiI }))
    };
  }

  // ----- 2 ẩn -----
  if (parts.length > 1) return null; // "hoặc" giữa các điều kiện trong mặt phẳng: không hỗ trợ
  if (atoms.some((a) => a.op === 'ne')) return null; // ≠ trong mặt phẳng: không dựng

  if (atoms.every((a) => a.deg <= 1 && !a.hasAbs)) {
    const ineqs = [];
    for (const a of atoms) {
      const f = X.compile({ t: 'sub', a: a.lhs, b: a.rhs, deg: 1 });
      const c0 = f(0, 0); const A = f(1, 0) - c0; const B = f(0, 1) - c0;
      if (![A, B, c0].every((n) => Number.isFinite(n) && Math.abs(n) <= MAX_ABS)) return null;
      ineqs.push({ A, B, C: c0, op: a.op, label: a.label });
    }
    return { kind: 'region', ineqs, points };
  }

  const spec = { kind: 'region_curved', atoms: atoms.map((a) => ({ lhs: a.lhs, rhs: a.rhs, op: a.op, label: a.label })), points };
  const v = GRID.chooseView(spec);
  if (!v) return null; // không tìm thấy miền ở mọi tỉ lệ: KHÔNG kết luận vô nghiệm, KHÔNG vẽ
  spec.view = v.bounds; spec.unbounded = v.unbounded;
  return spec;
}

// ---------------------------------------------------------------- 1 ẩn: ký hiệu + vẽ trục số
function intervalNotation(intervals) {
  if (!intervals.length) return '∅';
  if (intervals.length === 1 && intervals[0].lo === null && intervals[0].hi === null) return 'ℝ';
  return intervals.map((i) => {
    if (i.lo !== null && i.lo === i.hi) return `{${fracStr(i.lo)}}`;
    const l = i.lo === null ? '(' : (i.loI ? '[' : '(');
    const r = i.hi === null ? ')' : (i.hiI ? ']' : ')');
    return `${l}${i.lo === null ? '−∞' : fracStr(i.lo)}; ${i.hi === null ? '+∞' : fracStr(i.hi)}${r}`;
  }).join(' ∪ ');
}

function validateInequality(spec) {
  if (spec.kind === 'number_line') {
    if (!spec.intervals.length) return { code: 'inequality_contradiction:empty_solution', detail: 'các điều kiện mâu thuẫn nhau nên tập nghiệm rỗng' };
    return null;
  }
  if (spec.kind === 'region_curved') return null;
  const poly = regionPolygon(spec).poly;
  if (!poly || polyArea(poly) <= 1e-9 * Math.max(1, frameArea(spec))) {
    return { code: 'inequality_contradiction:empty_region', detail: 'hệ bất phương trình vô nghiệm (miền nghiệm rỗng hoặc chỉ là một đoạn/điểm)' };
  }
  return null;
}

function renderNumberLine(spec) {
  const iv = spec.intervals;
  if (!iv.length) { const e = new Error('inequality_empty'); e.code = 'inequality_contradiction:empty_solution'; throw e; }
  const v = spec.variable || 'x';
  const W = 640; const axisY = 96; const left = 36; const right = W - 36;
  const finite = [0];
  iv.forEach((i) => { if (i.lo !== null) finite.push(i.lo); if (i.hi !== null) finite.push(i.hi); });
  let mn = Math.min(...finite); let mx = Math.max(...finite);
  if (mx - mn < EPS) { mn -= 3; mx += 3; }
  const pad = Math.max((mx - mn) * 0.3, 1);
  mn -= pad; mx += pad;
  const step = niceStep((mx - mn) / 9);
  const sx = (right - left) / (mx - mn);
  const X_ = (val) => left + (val - mn) * sx;
  const legend = spec.labels || [];
  const c = new K.Canvas(W, 150 + 22 * (1 + legend.length));
  const BLUE = K.COLORS.BLUE;

  // vùng nghiệm (thanh dày) — vẽ trước để trục & chấm nằm trên
  iv.forEach((i) => {
    if (i.lo !== null && i.lo === i.hi) return; // điểm đơn lẻ: chỉ vẽ chấm
    const x0 = i.lo === null ? left - 8 : X_(i.lo); const x1 = i.hi === null ? right + 8 : X_(i.hi);
    if (x1 - x0 > 0.5) c.add(K.el('rect', { x: K.num(x0), y: axisY - 9, width: K.num(x1 - x0), height: 18, fill: BLUE, 'fill-opacity': 0.28 }));
  });
  c.arrow(left - 14, axisY, right + 14, axisY, { stroke: K.COLORS.INK, w: 2 });
  c.add(K.text(right + 12, axisY + 22, v, { size: 15, italic: true }));
  for (let t = Math.ceil(mn / step) * step; t <= mx + EPS; t += step) {
    const tv = Math.abs(t) < 1e-9 ? 0 : Math.round(t * 1e9) / 1e9;
    c.add(K.line(X_(tv), axisY - 5, X_(tv), axisY + 5, { w: 1.4 }));
    c.add(K.text(X_(tv), axisY + 22, fracStr(tv), { size: 12, color: K.COLORS.MUTED }));
  }
  // mũi tên "kéo dài vô cực" cho các khoảng không bị chặn
  iv.forEach((i) => {
    if (i.hi === null) c.arrow(X_(i.lo === null ? mn : i.lo) + (i.lo === null ? 0 : 6), axisY - 22, right + 6, axisY - 22, { stroke: BLUE, w: 2.4 });
    if (i.lo === null) c.arrow(X_(i.hi === null ? mx : i.hi) - (i.hi === null ? 0 : 6), axisY - 22, left - 6, axisY - 22, { stroke: BLUE, w: 2.4 });
  });
  // chấm đầu mút: gộp theo toạ độ; đặc nếu có khoảng nào lấy giá trị đó
  const dots = new Map();
  const touch = (val, incl) => { const k = Math.round(val * 1e9) / 1e9; dots.set(k, (dots.get(k) || false) || incl); };
  iv.forEach((i) => {
    if (i.lo !== null) touch(i.lo, i.loI);
    if (i.hi !== null) touch(i.hi, i.hiI);
  });
  [...dots.entries()].sort((a, b) => a[0] - b[0]).forEach(([val, incl]) => {
    c.add(K.circle(X_(val), axisY, 6.5, { fill: incl ? BLUE : K.COLORS.PAPER, stroke: BLUE, w: 2.4 }));
    c.add(K.text(X_(val), axisY - 16, fracStr(val), { size: 13, bold: true, color: BLUE }));
  });

  const notation = intervalNotation(iv);
  // Ký hiệu hợp "∪" KHÔNG có trong mọi font (hiện ô vuông) -> vẽ bằng path, chia đoạn quanh nó.
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
  legend.forEach((l) => { c.add(symText(left, y, `• ${l}`, { size: 13, anchor: 'start', color: K.COLORS.MUTED })); y += 22; });
  c.add(K.text(left, y, '○ không lấy biên (< hoặc >)   ● lấy biên (≤ hoặc ≥)   phần tô xanh: tập nghiệm', { size: 12, anchor: 'start', color: K.COLORS.MUTED }));

  c.title = `Biểu diễn tập nghiệm trên trục số: S = ${notation}`;
  c.desc = `Tập nghiệm của ${spec.hoac ? 'bất phương trình (hợp các trường hợp)' : (legend.length > 1 ? 'hệ bất phương trình' : 'bất phương trình')} theo biến ${v} là S = ${notation}. Chấm đặc nghĩa là lấy giá trị biên, chấm rỗng nghĩa là không lấy.`;
  return { svg: c.toSvg(), title: c.title, desc: c.desc };
}

// ---------------------------------------------------------------- 2 ẩn tuyến tính: miền nghiệm chính xác
const halfPlaneKeep = (c) => (c.op === 'gt' || c.op === 'ge' ? 1 : -1); // (A x + B y + C) op 0

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
const makeSpecView = (spec) => makePlotView(viewBounds(spec));
function frameArea(spec) { const { frame: f } = makeSpecView(spec); return (f.R - f.L) * (f.T - f.B); }

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
  const { view, frame: f } = makeSpecView(spec);
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
  const INK = K.COLORS.INK; const BLUE = K.COLORS.BLUE;

  const { grid, ox, oy, ticksX, ticksY } = buildGridAndAxes(view, f);
  c.add(K.el('g', { id: 'layer-grid' }, grid));

  // miền nghiệm (tô)
  c.add(K.el('polygon', { points: poly.map((p) => P(p[0], p[1]).map((v) => K.num(v)).join(',')).join(' '), fill: BLUE, 'fill-opacity': 0.26, stroke: 'none' }));

  // trục Ox, Oy (nhóm riêng để giao diện bật/tắt) — vẽ TRƯỚC biên để đường biên trùng trục không bị che
  let axes = '';
  axes += K.line(P(f.L, 0)[0], oy, P(f.R, 0)[0], oy, { stroke: INK, w: 1.6 });
  axes += K.line(ox, P(0, f.B)[1], ox, P(0, f.T)[1], { stroke: INK, w: 1.6 });
  c.add(K.el('g', { id: 'layer-axes' }, axes));

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
  ticksX.filter((t) => Math.abs(t) > EPS).slice(0, 16).forEach((t) => haloText(c, P(t, 0)[0], oy + 15, fracStr(t), { size: 11, color: K.COLORS.MUTED }));
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
    c.add(symText(60, ly, `d${i + 1}: ${q.label}${isStrict(q.op) ? '  (nét đứt: không lấy biên)' : ''}`, { size: 13, anchor: 'start' }));
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
  if (spec.kind === 'number_line') return renderNumberLine(spec);
  if (spec.kind === 'region_curved') return GRID.renderCurvedRegion(spec);
  return renderRegion(spec);
}

module.exports = {
  extractInequality, renderInequality, validateInequality,
  _test: { normalizeText, fracStr, intervalNotation, regionPolygon, clipPolygon, polyArea, KEYWORD_RE, UNSUPPORTED_RE }
};
