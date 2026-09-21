'use strict';

// ============================================================================================
// TOÁN / HÌNH HỌC — trích dữ kiện -> dựng toạ độ từ dữ kiện toán học -> SVG tất định.
// Không random: cùng dữ kiện luôn ra cùng toạ độ. Dữ kiện mâu thuẫn -> {ok:false} (không vẽ bừa).
// ============================================================================================

const K = require('./svgKit');
const U = require('./factUtils');

const { Canvas, makeView, rad, deg, sub, add, mul, dist, unit, angleBetween, arcPath, rightAngleMark, COLORS } = K;
const W = 560; const H = 400;

// ---------------------------------------------------------------- Triangle solving
function placeTriangle(a, b, c) {
  // N1=(0,0), N2=(c,0), N3 theo b=|N1N3|, a=|N2N3|
  const x = (b * b + c * c - a * a) / (2 * c);
  const y2 = b * b - x * x;
  if (y2 <= 1e-9) return null;
  return [[0, 0], [c, 0], [x, Math.sqrt(y2)]];
}
function triangleValid(a, b, c) { return a > 0 && b > 0 && c > 0 && a + b > c + 1e-9 && a + c > b + 1e-9 && b + c > a + 1e-9; }
const near = (x, y, tol = 0.02) => Math.abs(x - y) <= tol * Math.max(1, Math.abs(x), Math.abs(y));

/**
 * solveTriangle() — từ dữ kiện (cạnh/góc/loại) suy ra 3 cạnh + 3 góc. Không đủ dữ kiện -> hình mẫu cố định
 * (không nhãn số). Mâu thuẫn -> throw Error('geometry_contradiction:...').
 * names = [N1,N2,N3]; cạnh đối diện N1 là N2N3, v.v.
 */
function solveTriangle({ names, sides, angles, variant, apex }) {
  const [N1, N2, N3] = names;
  const key = (p, q) => U.sortPair(p, q);
  const sN1 = key(N2, N3); const sN2 = key(N1, N3); const sN3 = key(N1, N2); // cạnh đối N1,N2,N3
  const oppSide = { [N1]: sN1, [N2]: sN2, [N3]: sN3 };
  const S = {}; const A = {};
  [sN1, sN2, sN3].forEach((k) => { if (sides[k] != null) S[k] = sides[k]; });
  names.forEach((n) => { if (angles[n] != null) A[n] = angles[n]; });
  const derived = { sides: new Set(), angles: new Set() };

  const adj = (v) => names.filter((n) => n !== v).map((n) => key(v, n));
  const other = (v) => names.filter((n) => n !== v);

  if (variant === 'equilateral') {
    const given = Object.values(S)[0];
    const s = given != null ? given : 1;
    Object.values(S).forEach((val) => { if (!near(val, s)) throw new Error('geometry_contradiction:equilateral_sides_differ'); });
    [sN1, sN2, sN3].forEach((k) => { if (S[k] == null) derived.sides.add(k); S[k] = s; });
    names.forEach((n) => { if (A[n] != null && !near(A[n], 60, 0.01)) throw new Error('geometry_contradiction:equilateral_angle_not_60'); A[n] = 60; derived.angles.add(n); });
    return finish(S, A, derived, given == null);
  }
  if (variant === 'right') {
    const R = apex; // đỉnh vuông
    const [P, Q] = other(R);
    const kl1 = key(R, P); const kl2 = key(R, Q); const kh = oppSide[R];
    A[R] = 90;
    if (S[kl1] != null && S[kl2] != null) {
      const h = Math.hypot(S[kl1], S[kl2]);
      if (S[kh] != null && !near(S[kh], h)) throw new Error('geometry_contradiction:pythagoras');
      if (S[kh] == null) { S[kh] = h; derived.sides.add(kh); }
    } else if (S[kh] != null && (S[kl1] != null || S[kl2] != null)) {
      const known = S[kl1] != null ? kl1 : kl2; const miss = known === kl1 ? kl2 : kl1;
      if (S[known] >= S[kh] - 1e-9) throw new Error('geometry_contradiction:leg_not_shorter_than_hypotenuse');
      S[miss] = Math.sqrt(S[kh] ** 2 - S[known] ** 2); derived.sides.add(miss);
    } else {
      // một cạnh + một góc nhọn
      const accP = A[P]; const accQ = A[Q];
      const ac = accP != null ? { v: P, deg: accP } : (accQ != null ? { v: Q, deg: accQ } : null);
      const knownSide = [kl1, kl2, kh].find((k) => S[k] != null);
      if (ac && knownSide) {
        if (ac.deg <= 0 || ac.deg >= 90) throw new Error('geometry_contradiction:acute_angle_out_of_range');
        const t = rad(ac.deg); const v = ac.v; const w = v === P ? Q : P;
        const legAdj = key(R, v); const legOpp = key(R, w); // cạnh kề v (R-v), đối v (R-w)
        let hyp;
        if (knownSide === kh) hyp = S[kh];
        else if (knownSide === legAdj) hyp = S[legAdj] / Math.cos(t);
        else hyp = S[legOpp] / Math.sin(t);
        S[kh] = hyp; S[legAdj] = hyp * Math.cos(t); S[legOpp] = hyp * Math.sin(t);
        [kh, legAdj, legOpp].forEach((k) => { if (sides[k] == null) derived.sides.add(k); });
      }
    }
    const [L1, L2, Hh] = [S[kl1], S[kl2], S[kh]];
    if (L1 != null && L2 != null && Hh != null) {
      A[P] = deg(Math.atan2(S[key(R, Q)], S[key(R, P)])); A[Q] = 90 - A[P];
      if (angles[P] != null && !near(angles[P], A[P], 0.03)) throw new Error('geometry_contradiction:right_triangle_angle');
      if (angles[Q] != null && !near(angles[Q], A[Q], 0.03)) throw new Error('geometry_contradiction:right_triangle_angle');
      derived.angles.add(P); derived.angles.add(Q); derived.angles.add(R);
      if (angles[R] != null && !near(angles[R], 90, 0.001)) throw new Error('geometry_contradiction:right_angle_not_90');
      return finish(S, A, derived, false, R);
    }
    // Chỉ biết "vuông tại R": hình mẫu 3-4-5 không nhãn số.
    return finish({ [kl1]: 3, [kl2]: 4, [kh]: 5 }, { [R]: 90 }, { sides: new Set([kl1, kl2, kh]), angles: new Set([R]) }, true, R);
  }
  if (variant === 'isosceles') {
    const X = apex || N1; const [P, Q] = other(X);
    const kl1 = key(X, P); const kl2 = key(X, Q); const kb = oppSide[X];
    if (S[kl1] != null && S[kl2] != null && !near(S[kl1], S[kl2])) throw new Error('geometry_contradiction:isosceles_legs_differ');
    const leg = S[kl1] != null ? S[kl1] : S[kl2];
    let a; let base = S[kb]; let L = leg;
    if (A[X] != null) a = A[X];
    else if (A[P] != null || A[Q] != null) a = 180 - 2 * (A[P] != null ? A[P] : A[Q]);
    if (L != null && base != null) {
      if (base >= 2 * L - 1e-9) throw new Error('geometry_contradiction:isosceles_base_too_long');
      a = deg(2 * Math.asin(base / (2 * L)));
    } else if (L != null && a != null) { base = 2 * L * Math.sin(rad(a / 2)); } else if (base != null && a != null) { L = base / (2 * Math.sin(rad(a / 2))); }
    if (a == null && L != null && base == null) { a = 50; base = 2 * L * Math.sin(rad(a / 2)); derived.angles.add('__unlabeled'); }
    if (L == null || base == null || a == null || a <= 0 || a >= 180) {
      // hình mẫu
      L = 5; base = 6; a = deg(2 * Math.asin(base / (2 * L)));
      return finish({ [kl1]: L, [kl2]: L, [kb]: base }, { [X]: a, [P]: (180 - a) / 2, [Q]: (180 - a) / 2 }, { sides: new Set([kl1, kl2, kb]), angles: new Set([X, P, Q]) }, true);
    }
    [kl1, kl2].forEach((k) => { if (sides[k] == null) derived.sides.add(k); S[k] = L; });
    if (sides[kb] == null) derived.sides.add(kb); S[kb] = base;
    const bA = (180 - a) / 2;
    [[X, a], [P, bA], [Q, bA]].forEach(([n, v]) => { if (angles[n] != null && !near(angles[n], v, 0.03)) throw new Error('geometry_contradiction:isosceles_angle'); A[n] = v; derived.angles.add(n); });
    return finish(S, A, derived, false);
  }

  // ---- tam giác thường ----
  let knownS = Object.keys(S); let knownA = Object.keys(A);
  if (knownS.length === 3) {
    if (!triangleValid(S[sN1], S[sN2], S[sN3])) throw new Error('geometry_contradiction:triangle_inequality');
  } else if (knownS.length === 2 && knownA.length >= 1) {
    const [k1, k2] = knownS;
    const shared = names.find((n) => adj(n).includes(k1) && adj(n).includes(k2)); // đỉnh chung của 2 cạnh
    const third = [sN1, sN2, sN3].find((k) => !knownS.includes(k));
    if (A[shared] != null) { // SAS
      if (A[shared] <= 0 || A[shared] >= 180) throw new Error('geometry_contradiction:angle_range');
      S[third] = Math.sqrt(S[k1] ** 2 + S[k2] ** 2 - 2 * S[k1] * S[k2] * Math.cos(rad(A[shared])));
      derived.sides.add(third);
    } else { // SSA: góc đối với một trong hai cạnh đã cho
      const v = knownA[0]; const opp = oppSide[v]; const other2 = knownS.find((k) => k !== opp);
      if (!knownS.includes(opp)) throw new Error('geometry_insufficient:angle_not_related');
      const sinX = S[other2] * Math.sin(rad(A[v])) / S[opp];
      if (sinX > 1 + 1e-9) throw new Error('geometry_contradiction:ssa_no_solution');
      const ang = deg(Math.asin(Math.min(1, sinX)));
      const vOther = names.find((n) => oppSide[n] === other2);
      const vThird = names.find((n) => n !== v && n !== vOther);
      A[vOther] = ang; A[vThird] = 180 - A[v] - ang;
      if (A[vThird] <= 0) throw new Error('geometry_contradiction:ssa_angle_sum');
      S[third] = S[opp] * Math.sin(rad(A[vThird])) / Math.sin(rad(A[v]));
      derived.sides.add(third); derived.angles.add(vOther); derived.angles.add(vThird);
    }
  } else if (knownS.length >= 1 && knownA.length >= 2) { // ASA/AAS
    const a3 = names.find((n) => A[n] == null);
    const angs = { ...A };
    if (a3) { angs[a3] = 180 - Object.values(A).reduce((s, x) => s + x, 0); derived.angles.add(a3); }
    if (Object.values(angs).some((x) => !(x > 0 && x < 180))) throw new Error('geometry_contradiction:angle_sum');
    const k0 = knownS[0]; const v0 = names.find((n) => oppSide[n] === k0);
    const ratio = S[k0] / Math.sin(rad(angs[v0]));
    names.forEach((n) => { const k = oppSide[n]; if (S[k] == null) { S[k] = ratio * Math.sin(rad(angs[n])); derived.sides.add(k); } });
    names.forEach((n) => { A[n] = angs[n]; });
  } else {
    // không đủ dữ kiện: hình mẫu cố định, không nhãn số
    return finish({ [sN1]: 4.6, [sN2]: 4.2, [sN3]: 5.4 }, {}, { sides: new Set([sN1, sN2, sN3]), angles: new Set() }, true);
  }
  if (Object.keys(S).length === 3) {
    names.forEach((n) => {
      const [p, q] = other(n);
      const cosv = (S[key(n, p)] ** 2 + S[key(n, q)] ** 2 - S[oppSide[n]] ** 2) / (2 * S[key(n, p)] * S[key(n, q)]);
      const v = deg(Math.acos(Math.max(-1, Math.min(1, cosv))));
      if (angles[n] != null && !near(angles[n], v, 0.03)) throw new Error('geometry_contradiction:angle_vs_sides');
      if (A[n] == null) derived.angles.add(n);
      A[n] = v;
    });
  }
  return finish(S, A, derived, false);

  function finish(Sx, Ax, dv, unlabeled, right) {
    return { sides: Sx, angles: Ax, derived: dv, unlabeled, rightAt: right || null };
  }
}

// ---------------------------------------------------------------- Extraction
function extractGeometry(original, opts = {}) {
  const f = U.fold(original); const lower = f.toLowerCase();
  const wantsCoords = /\boxy\b|he truc toa do|mat phang toa do|toa do|vecto|vector|do thi ham so|giao diem cua/.test(lower)
    || (U.extractPoints(f).length > 0 && /oxy|toa do/.test(lower))
    || (/\by\s*=/.test(f) && /giao diem|do thi|duong thang|parabol/.test(lower));
  if (wantsCoords) { const r = extractCoordinate(f, lower); if (r) return r; }
  const tri = /tam giac|triangle/.test(lower) ? extractTriangle(f, lower) : null;
  if (tri) return tri;
  const quad = extractQuad(f, lower); if (quad) return quad;
  const circ = extractCircle(f, lower); if (circ) return circ;
  const ang = extractAngle(f, lower); if (ang) return ang;
  const rel = extractRelation(f, lower); if (rel) return rel;
  return null;
}

/**
 * Đối chiếu MỌI độ dài "XY = số" trong đề với hình đã dựng. Nếu đề cho độ dài mà hình — dựng từ các dữ kiện
 * KHÁC — cho số khác thì đó là mâu thuẫn: KHÔNG vẽ (tránh âm thầm bỏ qua một dữ kiện của người dùng).
 * Chỉ kiểm những đoạn có CẢ HAI đầu mút đã xác định trong hình; đoạn lạ thì bỏ qua (không thể kiểm).
 */
function verifyLengths(text, pts) {
  const L = U.extractLengths(text);
  for (const key of Object.keys(L)) {
    const [p, q2] = key.split('');
    if (!pts[p] || !pts[q2]) continue;
    const d = Math.hypot(pts[p][0] - pts[q2][0], pts[p][1] - pts[q2][1]);
    if (Math.abs(d - L[key]) > Math.max(0.03 * Math.max(d, L[key]), 0.02)) {
      return { key, given: L[key], actual: d };
    }
  }
  return null;
}
const lengthMismatch = (m, kind) => ({
  error: 'geometry_contradiction:length_mismatch', kind,
  detail: `đề cho ${m.key} = ${K.fmt(m.given, 2)}, nhưng từ các dữ kiện còn lại của hình thì ${m.key} = ${K.fmt(m.actual, 2)}`
});
function footPoint(c, coords, names) {
  const others = names.filter((n) => n !== c.from); const A = coords[c.from]; const B = coords[others[0]]; const C = coords[others[1]];
  if (!A || !B || !C) return null;
  if (c.type === 'median') return [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2];
  if (c.type === 'bisector') { const ab = Math.hypot(A[0] - B[0], A[1] - B[1]); const ac = Math.hypot(A[0] - C[0], A[1] - C[1]); const t = ab / (ab + ac); return [B[0] + (C[0] - B[0]) * t, B[1] + (C[1] - B[1]) * t]; }
  const dx = C[0] - B[0]; const dy = C[1] - B[1]; const t = ((A[0] - B[0]) * dx + (A[1] - B[1]) * dy) / (dx * dx + dy * dy);
  return [B[0] + dx * t, B[1] + dy * t];
}

function extractTriangle(f, lower) {
  const m = /(?:tam giac|triangle)(?:\s+(?:deu|can|vuong|thuong|nhon|tu|equilateral|isosceles|right))*\s+([A-Z]{3})\b/.exec(f);
  if (!m) return null;
  const names = m[1].split('');
  if (new Set(names).size !== 3) return null;
  const ctx = f.slice(m.index);
  const sides = U.extractLengths(ctx);
  const validKeys = new Set([U.sortPair(names[0], names[1]), U.sortPair(names[0], names[2]), U.sortPair(names[1], names[2])]);
  Object.keys(sides).forEach((k) => { if (!validKeys.has(k)) delete sides[k]; });
  // a, b, c theo quy ước cạnh đối diện đỉnh
  const abc = { a: U.sortPair(names[1], names[2]), b: U.sortPair(names[0], names[2]), c: U.sortPair(names[0], names[1]) };
  const re = new RegExp(`\\b([abc])\\s*=\\s*${U.NUM_SRC}`, 'g'); let mm;
  while ((mm = re.exec(ctx))) { const v = U.toNum(mm[2]); if (v != null && sides[abc[mm[1]]] == null) sides[abc[mm[1]]] = v; }
  const angles = U.extractAngles(ctx);
  Object.keys(angles).forEach((k) => { if (!names.includes(k)) delete angles[k]; });
  // "tam giác đều ABC cạnh 6" — độ dài cạnh không kèm tên cạnh (chỉ hợp lệ cho tam giác đều).
  const bare = new RegExp(`\\bcanh\\s*(?:=|bang|la|dai)?\\s*${U.NUM_SRC}`).exec(ctx);
  let variant = 'general'; let apex = null;
  let vm = /vuong\s+(?:tai|o)\s+([A-Z])\b/.exec(ctx);
  if (vm && names.includes(vm[1])) { variant = 'right'; apex = vm[1]; }
  if (variant === 'general' && /\bvuong\b|right[- ]angled|right triangle/.test(ctx.toLowerCase())) { variant = 'right'; apex = names[0]; }
  if (variant === 'general') {
    vm = /can\s+(?:tai|o)\s+([A-Z])\b/.exec(ctx);
    if (vm && names.includes(vm[1])) { variant = 'isosceles'; apex = vm[1]; }
    else if (/\bcan\b|isosceles/i.test(ctx)) { variant = 'isosceles'; apex = names[0]; }
  }
  if (/\bdeu\b|equilateral/i.test(ctx)) {
    variant = 'equilateral'; apex = null;
    if (bare && !Object.keys(sides).length) sides[abc.c] = U.toNum(bare[1]);
  }
  let sol;
  try { sol = solveTriangle({ names, sides, angles, variant, apex }); } catch (e) {
    // Thiếu dữ kiện KHÔNG phải mâu thuẫn: rơi về hình mẫu không nhãn số (đã cố định, không random).
    if (/^geometry_insufficient/.test(e.message)) { try { sol = solveTriangle({ names, sides: {}, angles: {}, variant, apex }); } catch (e2) { return { error: e2.message, kind: 'triangle' }; } }
    else return { error: e.message.replace(/^Error:\s*/, ''), kind: 'triangle' };
  }
  // đưa đỉnh "đặc biệt" về góc dưới-trái: right: R đầu; isosceles: cạnh đáy nằm ngang
  const S = sol.sides;
  const key = U.sortPair;
  const order = variant === 'right' ? [apex, ...names.filter((n) => n !== apex)] : (variant === 'isosceles' ? names.filter((n) => n !== apex).concat([apex]) : names.slice());
  const [o1, o2, o3] = order;
  const pts = placeTriangle(S[key(o2, o3)], S[key(o1, o3)], S[key(o1, o2)]);
  if (!pts) return { error: 'geometry_contradiction:degenerate_triangle', kind: 'triangle' };
  const coords = { [o1]: pts[0], [o2]: pts[1], [o3]: pts[2] };
  const cons = [];
  const cre = /(duong cao|trung tuyen|phan giac)\s+([A-Z])([A-Z])\b/g; let cm;
  while ((cm = cre.exec(ctx))) {
    const type = cm[1] === 'duong cao' ? 'altitude' : (cm[1] === 'trung tuyen' ? 'median' : 'bisector');
    if (names.includes(cm[2]) && !names.includes(cm[3])) cons.push({ type, from: cm[2], foot: cm[3] });
  }
  if (!sol.unlabeled) {
    const pts = { ...coords };
    cons.forEach((c) => { const ft = footPoint(c, coords, names); if (ft) pts[c.foot] = ft; });
    const bad = verifyLengths(ctx, pts);
    if (bad) return lengthMismatch(bad, 'triangle');
  }
  const circum = /duong tron ngoai tiep|noi tiep\s+(?:trong\s+)?(?:duong tron|\(O\))|circumscribed|circumcircle/i.test(ctx);
  const incircle = /duong tron noi tiep\s+(?:tam giac|tg)|incircle|inscribed circle/i.test(ctx) && !circum;
  return {
    shape: 'triangle', variant, names, apex, coords, sides: pickSides(S, sol.derived.sides, sides), angles: pickAngles(sol.angles, sol.derived.angles, angles),
    rightAt: sol.rightAt, unlabeled: sol.unlabeled, constructions: cons, circum, incircle, order
  };
}
function pickSides(S, derivedSet, given) {
  const out = {};
  Object.keys(S).forEach((k) => { out[k] = { value: Number(S[k].toFixed(4)), derived: derivedSet.has(k) && given[k] == null }; });
  return out;
}
function pickAngles(A, derivedSet, given) {
  const out = {};
  Object.keys(A).forEach((k) => { if (k.startsWith('__')) return; out[k] = { value: Number(A[k].toFixed(3)), derived: derivedSet.has(k) && given[k] == null }; });
  return out;
}

function extractQuad(f, lower) {
  const kinds = [
    ['square', /hinh vuong|square/], ['rectangle', /hinh chu nhat|rectangle/], ['rhombus', /hinh thoi|rhombus/],
    ['parallelogram', /hinh binh hanh|parallelogram/], ['trapezoid', /hinh thang|trapezoid|trapezium/]
  ];
  const hit = kinds.find(([, re]) => re.test(lower));
  if (!hit) return null;
  const kw = hit[1].exec(lower);
  const nm = /\b([A-Z]{4})\b/.exec(f.slice(kw.index));
  if (!nm) return null;
  const names = nm[1].split('');
  if (new Set(names).size !== 4) return null;
  const [A, B, C, D] = names;
  const L = U.extractLengths(f.slice(kw.index));
  const bareSide = new RegExp(`\\bcanh\\s*(?:=|bang|la|dai)?\\s*${U.NUM_SRC}`).exec(f.slice(kw.index));
  if (bareSide && (hit[0] === 'square' || hit[0] === 'rhombus') && ![[A, B], [B, C], [C, D], [A, D]].some(([p1, q1]) => L[U.sortPair(p1, q1)] != null)) L[U.sortPair(names[0], names[1])] = U.toNum(bareSide[1]);
  const g = (p, q) => L[U.sortPair(p, q)];
  const angs = U.extractAngles(f.slice(kw.index));
  const kind = hit[0];
  let coords; const sides = {}; const angles = {}; let marks = {}; let determined = false;
  const setSide = (p, q, v, derived) => { if (v != null) sides[U.sortPair(p, q)] = { value: Number(v.toFixed(4)), derived: !!derived }; };
  try {
    if (kind === 'square') {
      const s = g(A, B) ?? g(B, C) ?? g(C, D) ?? g(A, D); const has = s != null; const v = has ? s : 3.2; determined = has;
      coords = { [A]: [0, 0], [B]: [v, 0], [C]: [v, v], [D]: [0, v] };
      if (has) [[A, B], [B, C], [C, D], [D, A]].forEach(([p, q]) => setSide(p, q, v, !(g(p, q) != null)));
      [A, B, C, D].forEach((n) => { angles[n] = { value: 90, derived: true, right: true }; });
    } else if (kind === 'rectangle') {
      const w = g(A, B) ?? g(C, D); const h = g(A, D) ?? g(B, C);
      const vw = w ?? 4.4; const vh = h ?? 2.8; determined = w != null && h != null;
      coords = { [A]: [0, 0], [B]: [vw, 0], [C]: [vw, vh], [D]: [0, vh] };
      if (w != null) { setSide(A, B, w); setSide(C, D, w, g(C, D) == null); }
      if (h != null) { setSide(A, D, h); setSide(B, C, h, g(B, C) == null); }
      [A, B, C, D].forEach((n) => { angles[n] = { value: 90, derived: true, right: true }; });
    } else if (kind === 'parallelogram' || kind === 'rhombus') {
      const a = g(A, B) ?? g(C, D); const b = kind === 'rhombus' ? a : (g(A, D) ?? g(B, C));
      const ang = angs[A] ?? (angs[C]) ?? (angs[B] != null ? 180 - angs[B] : null) ?? (angs[D] != null ? 180 - angs[D] : null);
      const va = a ?? (kind === 'rhombus' ? (g(A, D) ?? g(B, C) ?? 3.6) : 4.4); const vb = kind === 'rhombus' ? va : (b ?? 2.8);
      if (ang != null && !(ang > 0 && ang < 180)) throw new Error('geometry_contradiction:angle_range');
      const vang = ang ?? 60; const t = rad(vang);
      coords = { [A]: [0, 0], [B]: [va, 0], [D]: [vb * Math.cos(t), vb * Math.sin(t)] };
      coords[C] = add(coords[B], coords[D]);
      if (a != null || kind === 'rhombus') { const val = kind === 'rhombus' ? va : a; if (val != null && (a != null || g(A, D) != null || g(B, C) != null)) { [[A, B], [C, D]].forEach(([p, q]) => setSide(p, q, val, g(p, q) == null)); if (kind === 'rhombus') [[A, D], [B, C]].forEach(([p, q]) => setSide(p, q, val, g(p, q) == null)); } }
      if (kind === 'parallelogram' && b != null) [[A, D], [B, C]].forEach(([p, q]) => setSide(p, q, b, g(p, q) == null));
      if (ang != null) { angles[A] = { value: vang, derived: angs[A] == null }; angles[C] = { value: vang, derived: true }; angles[B] = { value: 180 - vang, derived: true }; angles[D] = { value: 180 - vang, derived: true }; }
    } else { // trapezoid, AB // CD
      const ab = g(A, B); const cd = g(C, D); const h = /chieu cao\s*(?:=|bang|la)?\s*(\d+(?:[.,]\d+)?)/.exec(f) ? U.toNum(/chieu cao\s*(?:=|bang|la)?\s*(\d+(?:[.,]\d+)?)/.exec(f)[1]) : null;
      const va = ab ?? 5.2; const vc = cd ?? 3.0; const vh = h ?? 2.6;
      const isoceles = /\bcan\b|isosceles/.test(lower); const rightT = /\bvuong\b|right/.test(lower);
      let dx; if (rightT) dx = 0; else if (isoceles) dx = (va - vc) / 2; else dx = 0.6;
      // bottom = AB, top = DC (D phía trên A, C phía trên B)
      coords = { [A]: [0, 0], [B]: [va, 0], [D]: [dx, vh], [C]: [dx + vc, vh] };
      if (ab != null) setSide(A, B, ab); if (cd != null) setSide(C, D, cd);
      if (h != null) marks.height = h;
      if (rightT) { angles[A] = { value: 90, derived: true, right: true }; angles[D] = { value: 90, derived: true, right: true }; }
      marks.parallel = [[A, B], [D, C]];
    }
  } catch (e) { return { error: e.message, kind }; }
  if (determined) { const bad = verifyLengths(f.slice(kw.index), coords); if (bad) return lengthMismatch(bad, kind); }
  const diagonals = /duong cheo|diagonal/.test(lower);
  const center = diagonals || /\btam\s+O\b|giao diem.*\bO\b/.test(f) ? /\bO\b/.test(f) || diagonals : false;
  return { shape: kind, names, coords, sides, angles, diagonals, center, marks };
}

function extractCircle(f, lower) {
  if (!/duong tron|circle|\(\s*[A-Z]\s*;\s*\d/.test(lower + ' ' + f)) return null;
  const cm = /(?:tam|center)\s+([A-Z])\b/.exec(f) || /\(\s*([A-Z])\s*[;,]\s*[A-Za-z]?\s*=?\s*\d/.exec(f);
  const center = cm ? cm[1] : 'O';
  let R = null;
  const rm = /(?:ban kinh|radius)\s*(?:R\s*)?(?:=|bang|la)?\s*(\d+(?:[.,]\d+)?)/i.exec(f) || /\bR\s*=\s*(\d+(?:[.,]\d+)?)/.exec(f) || /\(\s*[A-Z]\s*[;,]\s*(\d+(?:[.,]\d+)?)\s*(?:cm|m)?\s*\)/.exec(f);
  if (rm) R = U.toNum(rm[1]);
  const dm = /duong kinh\s+(?:([A-Z])([A-Z])\b|(?:=|bang|la)?\s*(\d+(?:[.,]\d+)?))/i.exec(f);
  let diameter = null; let diaNum = null;
  if (dm) { if (dm[1]) diameter = [dm[1], dm[2]]; else if (dm[3]) diaNum = U.toNum(dm[3]); }
  if (R == null && diaNum != null) R = diaNum / 2;
  if (R != null && !(R > 0)) return { error: 'geometry_contradiction:radius_not_positive', kind: 'circle' };
  const chordM = /\bday\s+([A-Z])([A-Z])\b/.exec(f); const tanM = /tiep tuyen\s+(?:tai\s+)?([A-Z])(?:\s*([A-Z])?)?\b/.exec(f);
  const arcM = /\bcung\s+([A-Z])([A-Z])\b/.exec(f);
  const pts = []; const push = (n) => { if (n && n !== center && !pts.includes(n)) pts.push(n); };
  if (diameter) diameter.forEach(push);
  if (chordM) { push(chordM[1]); push(chordM[2]); }
  if (arcM) { push(arcM[1]); push(arcM[2]); }
  let tangentAt = null;
  if (tanM) { tangentAt = tanM[1]; push(tangentAt); }
  const radiusPt = /ban kinh\s+([A-Z])([A-Z])\b/i.exec(f);
  let radiusTo = 'A';
  if (radiusPt) { radiusTo = radiusPt[1] === center ? radiusPt[2] : radiusPt[1]; push(radiusTo); }
  return { shape: 'circle', center, radius: R, points: pts, diameter, chord: chordM ? [chordM[1], chordM[2]] : null, arc: arcM ? [arcM[1], arcM[2]] : null, tangentAt, radiusTo };
}

function extractAngle(f, lower) {
  if (!/\bgoc\b|angle|∠/.test(lower)) return null;
  const m = /(?:goc|∠)\s*([xyztu])\s*O\s*([xyztu])\s*(?:=|bang|la)?\s*(\d+(?:[.,]\d+)?)/i.exec(f);
  let val = null; let rays = ['x', 'y']; let vertex = 'O';
  if (m) { rays = [m[1].toLowerCase(), m[2].toLowerCase()]; val = U.toNum(m[3]); }
  else {
    const m2 = /(?:goc|∠)\s*(?:vuong|nhon|tu|bet)?\s*([A-Z]{3})?\s*(?:=|bang|la)?\s*(\d+(?:[.,]\d+)?)\s*(?:°|do\b|deg)/i.exec(f) || /(\d+(?:[.,]\d+)?)\s*(?:°|độ)/.exec(f);
    if (m2) val = U.toNum(m2[m2.length - 1]);
    if (val == null && /goc vuong|right angle/.test(lower)) val = 90;
    const nm = /(?:goc|∠)\s*([A-Z])([A-Z])([A-Z])\b/.exec(f);
    if (nm) { vertex = nm[2]; rays = [nm[1], nm[3]]; }
  }
  if (val == null) return null;
  if (!(val > 0 && val < 360)) return { error: 'geometry_contradiction:angle_range', kind: 'angle' };
  return { shape: 'angle', value: val, vertex, rays };
}

function extractRelation(f, lower) {
  const perp = /vuong goc|perpendicular|⊥/.test(lower); const par = /song song|parallel|\/\//.test(lower);
  if (!perp && !par) return null;
  const nm = /\b([A-Za-z]\d?)\s*(?:⊥|vuong goc voi|\/\/|song song voi)\s*([A-Za-z]\d?)\b/.exec(f) || /(?:duong thang|line)\s+([a-z]\d?)\s+(?:va|and)\s+([a-z]\d?)/i.exec(f);
  const names = nm ? [nm[1], nm[2]] : ['d1', 'd2'];
  return { shape: 'relation', relation: perp && !par ? 'perpendicular' : (par && !perp ? 'parallel' : (lower.indexOf('vuong goc') < lower.indexOf('song song') ? 'perpendicular' : 'parallel')), names };
}

// ---- Oxy ----
function parseLine(str) {
  // y = ax + b (a có thể rỗng/+/-). Trả {a,b} hoặc {vertical:x}. Bỏ qua khoảng trắng.
  const s = str.replace(/\s+/g, '').replace(/,/g, '.').replace(/−/g, '-');
  let m = /^y=([+-]?\d*\.?\d*)x([+-]\d+\.?\d*)?$/.exec(s);
  if (m) { const a = m[1] === '' || m[1] === '+' ? 1 : (m[1] === '-' ? -1 : Number(m[1])); const b = m[2] ? Number(m[2]) : 0; if (Number.isFinite(a) && Number.isFinite(b)) return { a, b }; }
  m = /^y=([+-]?\d+\.?\d*)$/.exec(s);
  if (m) return { a: 0, b: Number(m[1]) };
  m = /^x=([+-]?\d+\.?\d*)$/.exec(s);
  if (m) return { vertical: Number(m[1]) };
  return null;
}
function parseQuadratic(str) {
  const s = str.replace(/\s+/g, '').replace(/,/g, '.').replace(/x²/g, 'x^2').replace(/−/g, '-');
  const m = /^y=([+-]?\d*\.?\d*)x\^2(?:([+-]\d*\.?\d*)x)?(?:([+-]\d+\.?\d*))?$/.exec(s);
  if (!m) return null;
  const co = (t) => (t === '' || t === '+' ? 1 : (t === '-' ? -1 : Number(t)));
  const a = co(m[1]); const b = m[2] === undefined ? 0 : co(m[2]); const c = m[3] === undefined ? 0 : Number(m[3]);
  if (![a, b, c].every(Number.isFinite) || a === 0) return null;
  return { a, b, c };
}
function extractCoordinate(f, lower) {
  const points = U.extractPoints(f);
  const lines = []; const quads = [];
  const re = /(?:[a-z]\d?\s*[:,]?\s*)?(y\s*=\s*[^,;\n]+?)(?=\s*(?:,|;|\n|va\b|and\b|\.\s|$|\)|\bvoi\b|\bcat\b|\bgiao\b|\btim\b))/gi;
  let m;
  while ((m = re.exec(f))) {
    const raw = m[1].replace(/\.\s*$/, '').trim();
    const q = parseQuadratic(raw); if (q) { quads.push({ ...q, raw }); continue; }
    const l = parseLine(raw); if (l) lines.push({ ...l, raw });
  }
  const vectors = [];
  const vre = /(?:vecto|vector|vec)\s+([A-Z])([A-Z])\b/gi;
  while ((m = vre.exec(f))) { const p = points.find((q) => q.name === m[1]); const q = points.find((r) => r.name === m[2]); if (p && q) vectors.push({ name: m[1] + m[2], from: [p.x, p.y], to: [q.x, q.y] }); }
  const vre2 = /(?:vecto|vector|vec)\s+([a-z])\s*(?:=)?\s*\(\s*([+-]?\d+(?:[.,]\d+)?)\s*[;,]\s*([+-]?\d+(?:[.,]\d+)?)\s*\)/gi;
  while ((m = vre2.exec(f))) vectors.push({ name: m[1], from: [0, 0], to: [U.toNum(m[2]), U.toNum(m[3])] });
  if (!points.length && !lines.length && !quads.length && !vectors.length) {
    // Chỉ "hệ trục Oxy": vẽ trục trống có nhãn.
    if (/\boxy\b|he truc toa do/.test(lower)) return { shape: 'oxy', points: [], lines: [], quads: [], vectors: [], intersections: [], sum: null };
    return null;
  }
  const inter = [];
  if (/giao diem|intersection|cat nhau/.test(lower) && lines.length >= 2) {
    const [l1, l2] = lines;
    if (l1.vertical !== undefined || l2.vertical !== undefined) {
      const v = l1.vertical !== undefined ? l1 : l2; const o = v === l1 ? l2 : l1;
      if (o.vertical === undefined) inter.push({ x: v.vertical, y: o.a * v.vertical + o.b });
    } else if (Math.abs(l1.a - l2.a) > 1e-12) {
      const x = (l2.b - l1.b) / (l1.a - l2.a); inter.push({ x, y: l1.a * x + l1.b });
    }
  }
  if (/giao diem/.test(lower) && quads.length && lines.length) {
    const q = quads[0]; const l = lines[0];
    if (l.vertical === undefined) {
      const A2 = q.a; const B2 = q.b - l.a; const C2 = q.c - l.b; const dl = B2 * B2 - 4 * A2 * C2;
      if (dl >= 0) [(-B2 + Math.sqrt(dl)) / (2 * A2), (-B2 - Math.sqrt(dl)) / (2 * A2)].forEach((x, i, arr) => { if (i === 0 || Math.abs(x - arr[0]) > 1e-9) inter.push({ x, y: l.a * x + l.b }); });
    }
  }
  const sum = /tong|sum/.test(lower) && vectors.length === 2 ? { from: vectors[0].from, to: [vectors[0].to[0] - vectors[0].from[0] + vectors[1].to[0] - vectors[1].from[0] + vectors[0].from[0], vectors[0].to[1] - vectors[0].from[1] + vectors[1].to[1] - vectors[1].from[1] + vectors[0].from[1]] } : null;
  // segment giữa 2 điểm nếu nói "đoạn AB"/"đường thẳng AB"
  const segs = []; const sre = /(?:doan|duong thang|segment)\s+([A-Z])([A-Z])\b/g;
  while ((m = sre.exec(f))) { const p = points.find((q) => q.name === m[1]); const q = points.find((r) => r.name === m[2]); if (p && q) segs.push([p.name, q.name]); }
  return { shape: 'oxy', points, lines, quads, vectors, intersections: inter, sum, segments: segs };
}

// ---------------------------------------------------------------- Rendering
function centroid(pts) { return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]; }
function vertexLabel(cv, pxPt, cen, name, off = 16) {
  const d = unit(sub(pxPt, cen));
  cv.add(K.text(pxPt[0] + d[0] * off, pxPt[1] + d[1] * off + 5, name, { bold: true, size: 16, italic: false }));
}
function sideLabel(cv, p1, p2, cen, label, color) {
  const mid = mul(add(p1, p2), 0.5); let n = unit([-(p2[1] - p1[1]), p2[0] - p1[0]]);
  if ((mid[0] + n[0] - cen[0]) ** 2 + (mid[1] + n[1] - cen[1]) ** 2 < (mid[0] - cen[0]) ** 2 + (mid[1] - cen[1]) ** 2) n = mul(n, -1);
  cv.add(K.text(mid[0] + n[0] * 16, mid[1] + n[1] * 16 + 4, label, { size: 13, color: color || COLORS.INK }));
}
function dot(cv, p, r = 3.2) { cv.add(K.circle(p[0], p[1], r, { fill: COLORS.INK, stroke: COLORS.INK, w: 1 })); }
function cmLabel(v) { return K.fmt(v, 2); }

function renderTriangle(spec) {
  const cv = new Canvas(W, H);
  const names = spec.names; const world = names.map((n) => spec.coords[n]);
  const extra = [];
  const circ = spec.circum ? circumcircle(world) : null;
  const inc = spec.incircle ? incircle(world) : null;
  if (circ) extra.push([circ.c[0] - circ.r, circ.c[1] - circ.r], [circ.c[0] + circ.r, circ.c[1] + circ.r]);
  const view = makeView([...world, ...extra], { w: W, h: H, pad: 56 });
  const P = {}; names.forEach((n) => { P[n] = view.P(spec.coords[n]); });
  const cen = centroid(names.map((n) => P[n]));
  cv.title = `Tam giác ${names.join('')}`;
  cv.desc = describeTriangle(spec);
  if (circ) { const c = view.P(circ.c); cv.add(K.circle(c[0], c[1], view.len(circ.r), { stroke: COLORS.PURPLE, w: 1.4, dash: '5 4' })); dot(cv, c, 2.6); cv.add(K.text(c[0] + 10, c[1] - 6, 'O', { size: 14, bold: true, color: COLORS.PURPLE })); }
  if (inc) { const c = view.P(inc.c); cv.add(K.circle(c[0], c[1], view.len(inc.r), { stroke: COLORS.GREEN, w: 1.4, dash: '5 4' })); dot(cv, c, 2.6); cv.add(K.text(c[0] + 8, c[1] - 6, 'I', { size: 14, bold: true, color: COLORS.GREEN })); }
  cv.add(K.polygon(names.map((n) => P[n]), { fill: COLORS.FILL, stroke: COLORS.INK, w: 2 }));
  // Dựng thêm
  const oppOf = (v) => names.filter((n) => n !== v);
  spec.constructions.forEach((c) => {
    const [Pn, Qn] = oppOf(c.from); const p = spec.coords[Pn]; const q = spec.coords[Qn]; const x = spec.coords[c.from];
    let foot;
    if (c.type === 'altitude') { const d = unit(sub(q, p)); const t = (sub(x, p)[0] * d[0] + sub(x, p)[1] * d[1]); foot = add(p, mul(d, t)); }
    else if (c.type === 'median') foot = mul(add(p, q), 0.5);
    else { const xp = dist(x, p); const xq = dist(x, q); foot = mul(add(mul(p, xq), mul(q, xp)), 1 / (xp + xq)); }
    const fp = view.P(foot); const xp = P[c.from];
    cv.add(K.line(xp[0], xp[1], fp[0], fp[1], { stroke: COLORS.RED, w: 1.8, dash: c.type === 'altitude' ? '6 4' : undefined }));
    dot(cv, fp, 3);
    vertexLabel(cv, fp, cen, c.foot, 14);
    if (c.type === 'altitude') {
      const dirSide = unit(sub(P[Pn], P[Qn])); const dirUp = unit(sub(xp, fp));
      const toward = Math.abs(K.dot(dirSide, unit(sub(P[Pn], fp)))) > 0.5 ? unit(sub(P[Pn], fp)) : unit(sub(P[Qn], fp));
      cv.add(rightAngleMark(fp, toward, dirUp, 10));
    }
    if (c.type === 'median') {
      [[p, foot], [foot, q]].forEach(([s1, s2]) => { const a = view.P(s1); const b = view.P(s2); const mid = mul(add(a, b), 0.5); const d = unit(sub(b, a)); const nn = [-d[1], d[0]]; cv.add(K.line(mid[0] - nn[0] * 6 - d[0] * 0, mid[1] - nn[1] * 6, mid[0] + nn[0] * 6, mid[1] + nn[1] * 6, { w: 1.6 })); });
    }
    if (c.type === 'bisector') {
      const u1 = unit(sub(P[Pn], xp)); const u2 = unit(sub(fp, xp)); const u3 = unit(sub(P[Qn], xp));
      cv.add(K.path(arcPath(xp, u1, u2, 26), { stroke: COLORS.RED, w: 1.4 })); cv.add(K.path(arcPath(xp, u2, u3, 30), { stroke: COLORS.RED, w: 1.4 }));
    }
  });
  // Ký hiệu góc vuông tại đỉnh vuông
  if (spec.rightAt) {
    const R = spec.rightAt; const [a, b] = oppOf(R);
    cv.add(rightAngleMark(P[R], unit(sub(P[a], P[R])), unit(sub(P[b], P[R])), 13));
  }
  // Cung góc + số đo (chỉ khi có số thật, không phải hình mẫu)
  if (!spec.unlabeled) {
    names.forEach((n) => {
      const a = spec.angles[n]; if (!a || n === spec.rightAt) return;
      const showDerived = false; if (a.derived && !showDerived && Object.values(spec.angles).some((x) => !x.derived)) return;
      const [p, q] = oppOf(n); const u = unit(sub(P[p], P[n])); const v = unit(sub(P[q], P[n]));
      cv.add(K.path(arcPath(P[n], u, v, 26), { stroke: COLORS.ORANGE, w: 1.6 }));
      const bis = unit(add(u, v)); cv.add(K.text(P[n][0] + bis[0] * 44, P[n][1] + bis[1] * 44 + 4, `${cmLabel(a.value)}°`, { size: 12, color: COLORS.ORANGE }));
    });
    Object.keys(spec.sides).forEach((k) => {
      const s = spec.sides[k]; const p1 = P[k[0]]; const p2 = P[k[1]]; if (!p1 || !p2) return;
      sideLabel(cv, p1, p2, cen, `${cmLabel(s.value)}`, s.derived ? COLORS.MUTED : COLORS.BLUE);
    });
  }
  names.forEach((n) => { dot(cv, P[n]); vertexLabel(cv, P[n], cen, n, 18); });
  if (spec.variant === 'isosceles' && !spec.unlabeledMarks) { // dấu hai cạnh bằng nhau
    const X = spec.apex; oppOf(X).forEach((n) => { const a = P[X]; const b = P[n]; const mid = mul(add(a, b), 0.5); const d = unit(sub(b, a)); const nn = [-d[1], d[0]]; cv.add(K.line(mid[0] - nn[0] * 6, mid[1] - nn[1] * 6, mid[0] + nn[0] * 6, mid[1] + nn[1] * 6, { w: 1.6 })); });
  }
  if (spec.variant === 'equilateral') { for (let i = 0; i < 3; i++) { const a = P[names[i]]; const b = P[names[(i + 1) % 3]]; const mid = mul(add(a, b), 0.5); const d = unit(sub(b, a)); const nn = [-d[1], d[0]]; cv.add(K.line(mid[0] - nn[0] * 6, mid[1] - nn[1] * 6, mid[0] + nn[0] * 6, mid[1] + nn[1] * 6, { w: 1.6 })); } }
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}
function describeTriangle(spec) {
  const parts = [`Tam giác ${spec.names.join('')}`];
  if (spec.variant === 'right') parts.push(`vuông tại ${spec.rightAt}`);
  if (spec.variant === 'isosceles') parts.push(`cân tại ${spec.apex}`);
  if (spec.variant === 'equilateral') parts.push('đều');
  if (!spec.unlabeled) Object.keys(spec.sides).forEach((k) => parts.push(`${k} = ${cmLabel(spec.sides[k].value)}`));
  return parts.join(', ');
}
function circumcircle([A, B, C]) {
  const d = 2 * (A[0] * (B[1] - C[1]) + B[0] * (C[1] - A[1]) + C[0] * (A[1] - B[1]));
  const ux = ((A[0] ** 2 + A[1] ** 2) * (B[1] - C[1]) + (B[0] ** 2 + B[1] ** 2) * (C[1] - A[1]) + (C[0] ** 2 + C[1] ** 2) * (A[1] - B[1])) / d;
  const uy = ((A[0] ** 2 + A[1] ** 2) * (C[0] - B[0]) + (B[0] ** 2 + B[1] ** 2) * (A[0] - C[0]) + (C[0] ** 2 + C[1] ** 2) * (B[0] - A[0])) / d;
  return { c: [ux, uy], r: Math.hypot(A[0] - ux, A[1] - uy) };
}
function incircle([A, B, C]) {
  const a = dist(B, C); const b = dist(A, C); const c = dist(A, B); const p = a + b + c;
  const cx = (a * A[0] + b * B[0] + c * C[0]) / p; const cy = (a * A[1] + b * B[1] + c * C[1]) / p;
  const s = p / 2; const area = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
  return { c: [cx, cy], r: area / s };
}

function renderQuad(spec) {
  const cv = new Canvas(W, H);
  const names = spec.names; const world = names.map((n) => spec.coords[n]);
  const view = makeView(world, { w: W, h: H, pad: 64 });
  const P = {}; names.forEach((n) => { P[n] = view.P(spec.coords[n]); });
  const cen = centroid(names.map((n) => P[n]));
  const labelVN = { square: 'Hình vuông', rectangle: 'Hình chữ nhật', rhombus: 'Hình thoi', parallelogram: 'Hình bình hành', trapezoid: 'Hình thang' }[spec.shape];
  cv.title = `${labelVN} ${names.join('')}`; cv.desc = cv.title;
  cv.add(K.polygon(names.map((n) => P[n]), { fill: COLORS.FILL, stroke: COLORS.INK, w: 2 }));
  if (spec.diagonals) {
    const [A, B, C, D] = names; cv.add(K.line(P[A][0], P[A][1], P[C][0], P[C][1], { stroke: COLORS.RED, w: 1.6, dash: '6 4' })); cv.add(K.line(P[B][0], P[B][1], P[D][0], P[D][1], { stroke: COLORS.RED, w: 1.6, dash: '6 4' }));
    const o = mul(add(P[A], P[C]), 0.5); dot(cv, o, 3); cv.add(K.text(o[0] + 10, o[1] - 6, 'O', { bold: true, size: 15 }));
  }
  Object.keys(spec.angles).forEach((n) => {
    const a = spec.angles[n]; const i = names.indexOf(n); if (i < 0) return;
    const prev = P[names[(i + 3) % 4]]; const next = P[names[(i + 1) % 4]]; const u = unit(sub(prev, P[n])); const v = unit(sub(next, P[n]));
    if (a.right) cv.add(rightAngleMark(P[n], u, v, 12));
    else if (!a.derived || spec.shape === 'parallelogram' || spec.shape === 'rhombus') {
      cv.add(K.path(arcPath(P[n], u, v, 24), { stroke: COLORS.ORANGE, w: 1.6 }));
      const bis = unit(add(u, v)); cv.add(K.text(P[n][0] + bis[0] * 42, P[n][1] + bis[1] * 42 + 4, `${cmLabel(a.value)}°`, { size: 12, color: COLORS.ORANGE }));
    }
  });
  Object.keys(spec.sides).forEach((k) => { const s = spec.sides[k]; if (P[k[0]] && P[k[1]]) sideLabel(cv, P[k[0]], P[k[1]], cen, cmLabel(s.value), s.derived ? COLORS.MUTED : COLORS.BLUE); });
  if (spec.marks && spec.marks.parallel) spec.marks.parallel.forEach(([p, q]) => { const a = P[p]; const b = P[q]; const mid = mul(add(a, b), 0.5); const d = unit(sub(b, a)); cv.add(K.path(`M${K.num(mid[0] - d[0] * 5 - d[1] * 5)},${K.num(mid[1] - d[1] * 5 + d[0] * 5)} L${K.num(mid[0] + d[0] * 5)},${K.num(mid[1] + d[1] * 5)} L${K.num(mid[0] - d[0] * 5 + d[1] * 5)},${K.num(mid[1] - d[1] * 5 - d[0] * 5)}`, { w: 1.4 })); });
  if (spec.marks && spec.marks.height != null && spec.shape === 'trapezoid') {
    const [A, B, C, D] = names; const foot = [spec.coords[D][0], 0]; const f = view.P(foot); const d = P[D]; cv.add(K.line(d[0], d[1], f[0], f[1], { stroke: COLORS.RED, w: 1.6, dash: '5 4' })); cv.add(K.text(d[0] - 14, (d[1] + f[1]) / 2, `h=${cmLabel(spec.marks.height)}`, { size: 12, color: COLORS.RED, anchor: 'end' })); void A; void B; void C;
  }
  names.forEach((n) => { dot(cv, P[n]); vertexLabel(cv, P[n], cen, n, 18); });
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function renderCircle(spec) {
  const cv = new Canvas(W, H);
  const R = spec.radius != null ? spec.radius : 1;
  const world = [[-R, -R], [R, R]];
  const view = makeView(world, { w: W, h: H, pad: 76 });
  const O = view.P([0, 0]); const r = view.len(R);
  cv.title = `Đường tròn tâm ${spec.center}${spec.radius != null ? `, bán kính ${cmLabel(R)}` : ''}`; cv.desc = cv.title;
  cv.add(K.circle(O[0], O[1], r, { fill: COLORS.FILL, stroke: COLORS.INK, w: 2 }));
  dot(cv, O, 3.4); cv.add(K.text(O[0] - 14, O[1] + 18, spec.center, { bold: true, size: 16 }));
  const defaultAngles = { A: 35, B: 150, C: 255, D: 320, M: 90, N: 210, T: 20, P: 70, Q: 300 };
  const pos = {}; let auto = 30;
  const angOf = (n) => { if (defaultAngles[n] != null) return defaultAngles[n]; auto += 75; return auto; };
  if (spec.diameter) { pos[spec.diameter[0]] = 160; pos[spec.diameter[1]] = 340; }
  spec.points.forEach((n) => { if (pos[n] == null) pos[n] = angOf(n); });
  const px = (n) => { const t = rad(pos[n]); return [O[0] + r * Math.cos(t), O[1] - r * Math.sin(t)]; };
  if (spec.diameter) { const a = px(spec.diameter[0]); const b = px(spec.diameter[1]); cv.add(K.line(a[0], a[1], b[0], b[1], { w: 2 })); }
  if (spec.chord) { const a = px(spec.chord[0]); const b = px(spec.chord[1]); cv.add(K.line(a[0], a[1], b[0], b[1], { w: 2 })); }
  if (spec.arc) { const a = pos[spec.arc[0]]; const b = pos[spec.arc[1]]; const p0 = px(spec.arc[0]); const p1 = px(spec.arc[1]); const sweep = ((b - a) % 360 + 360) % 360; cv.add(K.path(`M${K.num(p0[0])},${K.num(p0[1])} A${K.num(r)},${K.num(r)} 0 ${sweep > 180 ? 1 : 0} 0 ${K.num(p1[0])},${K.num(p1[1])}`, { stroke: COLORS.RED, w: 3 })); }
  if (spec.radius != null || spec.radiusTo) {
    const tgt = spec.tangentAt || (spec.radiusTo && spec.points.includes(spec.radiusTo) ? spec.radiusTo : null);
    let q; if (tgt) q = px(tgt); else { pos.__r = 35; q = px('__r'); }
    cv.add(K.line(O[0], O[1], q[0], q[1], { stroke: COLORS.BLUE, w: 1.8 }));
    if (spec.radius != null) { const mid = mul(add(O, q), 0.5); const d = unit(sub(q, O)); cv.add(K.text(mid[0] - d[1] * 14, mid[1] + d[0] * 14 + 4, `R=${cmLabel(R)}`, { size: 13, color: COLORS.BLUE })); }
    if (!tgt) { dot(cv, q, 3); }
  }
  if (spec.tangentAt) {
    const q = px(spec.tangentAt); const radial = unit(sub(q, O)); const tan = [-radial[1], radial[0]];
    cv.add(K.line(q[0] - tan[0] * 110, q[1] - tan[1] * 110, q[0] + tan[0] * 110, q[1] + tan[1] * 110, { stroke: COLORS.RED, w: 2 }));
    cv.add(rightAngleMark(q, mul(radial, -1), tan, 11));
    cv.add(K.text(q[0] + tan[0] * 122, q[1] + tan[1] * 122 + 4, 't', { italic: true, size: 14, color: COLORS.RED }));
  }
  spec.points.forEach((n) => { const p = px(n); dot(cv, p); const d = unit(sub(p, O)); cv.add(K.text(p[0] + d[0] * 16, p[1] + d[1] * 16 + 5, n, { bold: true, size: 16 })); });
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function renderAngle(spec) {
  const cv = new Canvas(W, 360);
  const val = spec.value; const t = rad(Math.min(val, 359.9));
  const view = makeView([[0, 0], [1, 0], [Math.cos(t), Math.sin(t)]], { w: W, h: 360, pad: 64 });
  const O = view.P([0, 0]); const p1 = view.P([1, 0]); const p2 = view.P([Math.cos(t), Math.sin(t)]);
  cv.title = `Góc ${spec.rays[0]}${spec.vertex}${spec.rays[1]} = ${cmLabel(val)}°`; cv.desc = cv.title;
  cv.arrow(O[0], O[1], p1[0], p1[1], { stroke: COLORS.INK, w: 2.2 }); cv.arrow(O[0], O[1], p2[0], p2[1], { stroke: COLORS.INK, w: 2.2 });
  const u = [1, 0]; const v = unit([p2[0] - O[0], p2[1] - O[1]]);
  if (Math.abs(val - 90) < 1e-9) cv.add(rightAngleMark(O, u, v, 20));
  else cv.add(K.path(arcPath(O, u, v, 44), { stroke: COLORS.ORANGE, w: 2 }));
  const half = rad(val / 2); cv.add(K.text(O[0] + 78 * Math.cos(half), O[1] - 78 * Math.sin(half) + 5, `${cmLabel(val)}°`, { size: 15, color: COLORS.ORANGE, bold: true }));
  dot(cv, O, 3.4); cv.add(K.text(O[0] - 14, O[1] + 20, spec.vertex, { bold: true, size: 16 }));
  cv.add(K.text(p1[0] + 6, p1[1] + 20, spec.rays[0], { italic: true, size: 15, anchor: 'start' }));
  const dv = unit(sub(p2, O)); cv.add(K.text(p2[0] + dv[0] * 16, p2[1] + dv[1] * 16 + 4, spec.rays[1], { italic: true, size: 15 }));
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function renderRelation(spec) {
  const cv = new Canvas(W, 340); const [n1, n2] = spec.names;
  cv.title = spec.relation === 'perpendicular' ? `${n1} vuông góc ${n2}` : `${n1} song song ${n2}`; cv.desc = cv.title;
  if (spec.relation === 'perpendicular') {
    const c = [280, 180];
    cv.add(K.line(90, 180, 470, 180, { w: 2.2 })); cv.add(K.line(280, 40, 280, 320, { w: 2.2 }));
    cv.add(rightAngleMark(c, [1, 0], [0, -1], 16));
    cv.add(K.text(482, 176, n1, { italic: true, size: 16, anchor: 'start' })); cv.add(K.text(290, 34, n2, { italic: true, size: 16, anchor: 'start' }));
    dot(cv, c, 3.4);
  } else {
    cv.add(K.line(90, 110, 470, 110, { w: 2.2 })); cv.add(K.line(90, 230, 470, 230, { w: 2.2 }));
    [110, 230].forEach((y) => { cv.add(K.path(`M270,${y - 7} L280,${y} L270,${y + 7}`, { w: 1.6 })); cv.add(K.path(`M282,${y - 7} L292,${y} L282,${y + 7}`, { w: 1.6 })); });
    cv.add(K.text(482, 114, n1, { italic: true, size: 16, anchor: 'start' })); cv.add(K.text(482, 234, n2, { italic: true, size: 16, anchor: 'start' }));
  }
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function niceStep(span) {
  const raw = span / 8; const mag = 10 ** Math.floor(Math.log10(raw)); const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
function renderOxy(spec) {
  const cw = 560; const ch = 440; const cv = new Canvas(cw, ch);
  const pts = [[0, 0]];
  spec.points.forEach((p) => pts.push([p.x, p.y])); spec.vectors.forEach((v) => { pts.push(v.from, v.to); }); spec.intersections.forEach((p) => pts.push([p.x, p.y]));
  if (spec.sum) pts.push(spec.sum.to);
  spec.lines.forEach((l) => { if (l.vertical !== undefined) pts.push([l.vertical, 0]); else pts.push([0, l.b]); });
  spec.quads.forEach((q) => { const vx = -q.b / (2 * q.a); pts.push([vx, q.a * vx * vx + q.b * vx + q.c], [0, q.c]); });
  let minX = Math.min(...pts.map((p) => p[0])); let maxX = Math.max(...pts.map((p) => p[0]));
  let minY = Math.min(...pts.map((p) => p[1])); let maxY = Math.max(...pts.map((p) => p[1]));
  if (spec.lines.length || spec.quads.length) { minX = Math.min(minX, -3); maxX = Math.max(maxX, 3); }
  const padX = Math.max((maxX - minX) * 0.15, 1); const padY = Math.max((maxY - minY) * 0.15, 1);
  minX = Math.min(minX - padX, -1); maxX = Math.max(maxX + padX, 1); minY = Math.min(minY - padY, -1); maxY = Math.max(maxY + padY, 1);
  const view = makeView([[minX, minY], [maxX, maxY]], { w: cw, h: ch, pad: 34, keepAspect: false });
  const step = niceStep(Math.max(maxX - minX, maxY - minY));
  cv.title = 'Hệ trục toạ độ Oxy'; cv.desc = 'Hệ trục toạ độ Oxy';
  for (let x = Math.ceil(minX / step) * step; x <= maxX + 1e-9; x += step) { const X = view.X(x); cv.add(K.line(X, 34, X, ch - 34, { stroke: COLORS.GRID, w: 1 })); if (Math.abs(x) > 1e-9) cv.add(K.text(X, view.Y(0) + 15, K.fmt(x, 3), { size: 11, color: COLORS.MUTED })); }
  for (let y = Math.ceil(minY / step) * step; y <= maxY + 1e-9; y += step) { const Y = view.Y(y); cv.add(K.line(34, Y, cw - 34, Y, { stroke: COLORS.GRID, w: 1 })); if (Math.abs(y) > 1e-9) cv.add(K.text(view.X(0) - 8, Y + 4, K.fmt(y, 3), { size: 11, color: COLORS.MUTED, anchor: 'end' })); }
  const ox = view.X(0); const oy = view.Y(0);
  cv.arrow(34, oy, cw - 24, oy, { stroke: COLORS.INK, w: 1.8 }); cv.arrow(ox, ch - 34, ox, 22, { stroke: COLORS.INK, w: 1.8 });
  cv.add(K.text(cw - 20, oy - 8, 'x', { italic: true, size: 15 })); cv.add(K.text(ox + 12, 24, 'y', { italic: true, size: 15 })); cv.add(K.text(ox - 10, oy + 16, 'O', { size: 13, bold: true }));
  // Cắt đường thẳng y = ax + b theo HỘP nhìn (không kẹp từng đầu mút — kẹp sẽ làm lệch độ dốc).
  const clipLine = (a, b) => {
    let xa = minX; let xb = maxX;
    if (Math.abs(a) > 1e-12) {
      const x1 = (minY - b) / a; const x2 = (maxY - b) / a;
      xa = Math.max(xa, Math.min(x1, x2)); xb = Math.min(xb, Math.max(x1, x2));
    } else if (b < minY || b > maxY) return null;
    if (xa > xb) return null;
    return [[view.X(xa), view.Y(a * xa + b)], [view.X(xb), view.Y(a * xb + b)]];
  };
  const palette = [COLORS.BLUE, COLORS.RED, COLORS.GREEN, COLORS.PURPLE];
  spec.lines.forEach((l, i) => {
    const col = palette[i % palette.length];
    if (l.vertical !== undefined) { const X = view.X(l.vertical); cv.add(K.line(X, 34, X, ch - 34, { stroke: col, w: 2 })); cv.add(K.text(X + 6, 48, `x = ${K.fmt(l.vertical)}`, { size: 12, color: col, anchor: 'start' })); return; }
    const seg = clipLine(l.a, l.b); if (!seg) return;
    const [p, q] = seg;
    cv.add(K.line(p[0], p[1], q[0], q[1], { stroke: col, w: 2 }));
    const right = p[0] > q[0] ? p : q;
    cv.add(K.text(right[0] - 6, Math.max(46, Math.min(ch - 40, right[1] + (l.a >= 0 ? 16 : -10))), l.raw.replace(/\s+/g, ' '), { size: 12, color: col, anchor: 'end' }));
  });
  spec.quads.forEach((q, i) => {
    const col = palette[(spec.lines.length + i) % palette.length]; const ptsQ = [];
    for (let k = 0; k <= 160; k++) { const x = minX + (maxX - minX) * k / 160; const y = q.a * x * x + q.b * x + q.c; if (y >= minY - 0.5 && y <= maxY + 0.5) ptsQ.push([view.X(x), view.Y(y)]); }
    if (ptsQ.length > 1) cv.add(K.polyline(ptsQ, { stroke: col, w: 2.2 }));
    const vx = -q.b / (2 * q.a); const vy = q.a * vx * vx + q.b * vx + q.c; const V = [view.X(vx), view.Y(vy)];
    dot(cv, V, 3.4); cv.add(K.text(V[0] + 8, V[1] + (q.a > 0 ? 16 : -8), `(${K.fmt(vx)}; ${K.fmt(vy)})`, { size: 12, color: col, anchor: 'start' }));
  });
  spec.vectors.forEach((v, i) => {
    const col = i % 2 ? COLORS.ORANGE : COLORS.GREEN;
    cv.arrow(view.X(v.from[0]), view.Y(v.from[1]), view.X(v.to[0]), view.Y(v.to[1]), { stroke: col, w: 2.4 });
    const mx = (view.X(v.from[0]) + view.X(v.to[0])) / 2; const my = (view.Y(v.from[1]) + view.Y(v.to[1])) / 2;
    cv.add(K.text(mx + 10, my - 8, `${v.name.length === 1 ? v.name : `${v.name[0]}${v.name[1]}`}`, { italic: true, size: 14, color: col }));
  });
  if (spec.sum) { cv.arrow(view.X(spec.sum.from[0]), view.Y(spec.sum.from[1]), view.X(spec.sum.to[0]), view.Y(spec.sum.to[1]), { stroke: COLORS.PURPLE, w: 2.6 }); }
  spec.points.forEach((p) => { const X = view.X(p.x); const Y = view.Y(p.y); dot(cv, [X, Y], 3.6); cv.add(K.text(X + 10, Y - 8, `${p.name}(${K.fmt(p.x)}; ${K.fmt(p.y)})`, { bold: true, size: 13, anchor: 'start' })); });
  (spec.segments || []).forEach(([a, b]) => { const p = spec.points.find((z) => z.name === a); const q = spec.points.find((z) => z.name === b); if (p && q) cv.add(K.line(view.X(p.x), view.Y(p.y), view.X(q.x), view.Y(q.y), { stroke: COLORS.INK, w: 1.8 })); });
  spec.intersections.forEach((p, i) => { const X = view.X(p.x); const Y = view.Y(p.y); cv.add(K.circle(X, Y, 5.5, { fill: '#fff', stroke: COLORS.RED, w: 2 })); cv.add(K.text(X + 10, Y + 18, `${i ? 'N' : 'M'}(${K.fmt(p.x)}; ${K.fmt(p.y)})`, { bold: true, size: 13, color: COLORS.RED, anchor: 'start' })); });
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function renderGeometry(spec) {
  switch (spec.shape) {
    case 'triangle': return renderTriangle(spec);
    case 'square': case 'rectangle': case 'rhombus': case 'parallelogram': case 'trapezoid': return renderQuad(spec);
    case 'circle': return renderCircle(spec);
    case 'angle': return renderAngle(spec);
    case 'relation': return renderRelation(spec);
    case 'oxy': return renderOxy(spec);
    default: throw new Error(`unknown_geometry_shape:${spec.shape}`);
  }
}

module.exports = { extractGeometry, renderGeometry, solveTriangle, parseLine, parseQuadratic, circumcircle, incircle };
