'use strict';

// ============================================================================================
// ĐẠI SỐ TẬP KHOẢNG TRÊN ℝ — giải CHÍNH XÁC bất phương trình một biến (bậc ≤ 2, có |...|, có "hoặc")
// ============================================================================================
// Tập = danh sách khoảng rời nhau, đã sắp xếp: { lo, hi, loI, hiI } (lo/hi có thể ±Infinity; đầu vô cực luôn mở).

const { toPoly, collectAbs, ParseError } = require('./ineqExpr');

const EPS = 1e-9;
const FULL = () => [{ lo: -Infinity, hi: Infinity, loI: false, hiI: false }];
const EMPTY = () => [];

// Làm tròn nghiệm: sát số nguyên (1e-9) thì lấy số nguyên; còn lại giữ 12 chữ số thập phân. KHÔNG làm tròn thô hơn,
// nếu không sẽ phá nhận dạng phân số (−2/3) ở fracStr. 12 chữ số đủ để các nghiệm bằng nhau về mặt toán học
// (tính theo hai đường khác nhau) trùng khít khi so sánh/hợp nhất khoảng.
const snap = (v) => { const r = Math.round(v); return Math.abs(v - r) < 1e-9 ? r : Math.round(v * 1e12) / 1e12; };

function isEmptyInterval(i) {
  if (i.lo > i.hi) return true;
  if (i.lo === i.hi) return !(i.loI && i.hiI);
  return false;
}

function normalize(list) {
  const items = list.filter((i) => !isEmptyInterval(i)).map((i) => ({ ...i })).sort((a, b) => (a.lo - b.lo) || (b.loI - a.loI) || 0);
  const out = [];
  for (const it of items) {
    const cur = out[out.length - 1];
    if (cur && (it.lo < cur.hi || (it.lo === cur.hi && (cur.hiI || it.loI)))) {
      if (it.hi > cur.hi) { cur.hi = it.hi; cur.hiI = it.hiI; } else if (it.hi === cur.hi) cur.hiI = cur.hiI || it.hiI;
    } else out.push(it);
  }
  return out;
}

function union(A, B) { return normalize([...A, ...B]); }

function intersect(A, B) {
  const out = [];
  for (const a of A) for (const b of B) {
    let lo; let loI; let hi; let hiI;
    if (a.lo > b.lo) { lo = a.lo; loI = a.loI; } else if (a.lo < b.lo) { lo = b.lo; loI = b.loI; } else { lo = a.lo; loI = a.loI && b.loI; }
    if (a.hi < b.hi) { hi = a.hi; hiI = a.hiI; } else if (a.hi > b.hi) { hi = b.hi; hiI = b.hiI; } else { hi = a.hi; hiI = a.hiI && b.hiI; }
    const it = { lo, hi, loI, hiI };
    if (!isEmptyInterval(it)) out.push(it);
  }
  return normalize(out);
}

// ---------------- nghiệm thực của đa thức bậc ≤ 2 ----------------
function realRoots(c) {
  if (c.length === 2) return [snap(-c[0] / c[1])];
  if (c.length === 3) {
    const [c0, c1, c2] = c;
    const D = c1 * c1 - 4 * c2 * c0;
    const tol = 1e-12 * (c1 * c1 + Math.abs(4 * c2 * c0));
    if (D < -tol) return [];
    if (Math.abs(D) <= tol) return [snap(-c1 / (2 * c2))];
    const s = Math.sqrt(D);
    // công thức ổn định số (tránh triệt tiêu khi c1² >> 4ac)
    const q = -0.5 * (c1 + Math.sign(c1 || 1) * s);
    const r1 = q / c2; const r2 = c0 / q;
    return [snap(Math.min(r1, r2)), snap(Math.max(r1, r2))];
  }
  return [];
}
const evalPoly = (c, x) => c.reduceRight((acc, v) => acc * x + v, 0);

/** { P(x) op 0 } với P là đa thức [c0,c1,c2]. */
function polySet(coef, op) {
  const c = coef.slice(); while (c.length > 1 && Math.abs(c[c.length - 1]) < 1e-12) c.pop();
  if (c.length === 1) {
    const v = c[0];
    const truth = { lt: v < -1e-12, le: v <= 1e-12, gt: v > 1e-12, ge: v >= -1e-12, ne: Math.abs(v) > 1e-12 }[op];
    return truth ? FULL() : EMPTY();
  }
  const roots = [...new Set(realRoots(c))].sort((a, b) => a - b);
  const bounds = [-Infinity, ...roots, Infinity];
  const regions = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const a = bounds[i]; const b = bounds[i + 1];
    // Điểm mẫu để xét dấu. Không có nghiệm thực: bounds = [-∞, ∞] => lấy 0 (b - 1 sẽ là ∞ => sai dấu).
    let sample;
    if (a === -Infinity && b === Infinity) sample = 0;
    else if (a === -Infinity) sample = b - 1;
    else if (b === Infinity) sample = a + 1;
    else sample = (a + b) / 2;
    const s = Math.sign(evalPoly(c, sample));
    const want = (op === 'lt' || op === 'le') ? s < 0 : ((op === 'gt' || op === 'ge') ? s > 0 : true);
    if (want) regions.push({ lo: a, hi: b, loI: false, hiI: false });
  }
  if (op === 'le' || op === 'ge') roots.forEach((r) => regions.push({ lo: r, hi: r, loI: true, hiI: true }));
  return normalize(regions);
}

/**
 * Tập nghiệm của  lhs op rhs  theo biến v. Trị tuyệt đối được tách trường hợp: với mỗi tổ hợp dấu s_i của |u_i|,
 * lấy giao của (s_i·u_i ≥ 0) với bất phương trình đã bỏ dấu |.|, rồi hợp các trường hợp.
 * Ném ParseError nếu không giải được (bậc > 2 sau khi bỏ |.|, quá nhiều |.|).
 */
function atomSet(lhs, rhs, op, v) {
  const diff = { t: 'sub', a: lhs, b: rhs, deg: Math.max(lhs.deg, rhs.deg) };
  const abs = collectAbs(diff);
  if (abs.length > 2) throw new ParseError('too_many_abs');
  const combos = 2 ** abs.length;
  let total = EMPTY();
  for (let m = 0; m < combos; m += 1) {
    const signs = new Map(abs.map((n, i) => [n, (m >> i) & 1 ? -1 : 1]));
    let part = polySet(toPoly(diff, v, signs), op);
    for (const n of abs) {
      const cond = toPoly(n.a, v, signs); // đã gồm dấu của các abs lồng trong u
      const s = signs.get(n);
      part = intersect(part, polySet(cond.map((k) => k * s), 'ge'));
    }
    total = union(total, part);
  }
  return total;
}

module.exports = { FULL, EMPTY, normalize, union, intersect, polySet, atomSet, realRoots, snap, EPS };
