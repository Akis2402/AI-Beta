'use strict';

// ============================================================================================
// VẬT LÝ — sơ đồ lực, mặt phẳng nghiêng, ném xiên, ròng rọc, mạch điện, quang học, đồ thị.
// Mọi con số hiển thị hoặc là dữ kiện của đề, hoặc suy ra bằng công thức vật lý (ghi rõ g đã dùng).
// Thiếu dữ kiện -> vẽ theo KÝ HIỆU (P, N, Fms...) chứ không bịa số.
// ============================================================================================

const K = require('./svgKit');
const U = require('./factUtils');

const { Canvas, makeView, rad, deg, COLORS } = K;
const W = 560; const H = 400;
const G_DEFAULT = 10;

function q(f, symbolRe, unitRe) { return U.findQuantity(f, symbolRe, unitRe); }
function getG(f) { const g = q(f, '\\bg', 'm/s\\^?2|m/s²|m\\.s-2'); return g != null ? { g, given: true } : { g: G_DEFAULT, given: false }; }
const f1 = (v) => K.fmt(v, 2);

// ---------------------------------------------------------------- Detection + extraction
function detectPhysicsKind(lower, f) {
  if (/\bs\s*[-–]\s*t\b|\bx\s*[-–]\s*t\b|\bv\s*[-–]\s*t\b|\ba\s*[-–]\s*t\b|\bu\s*[-–]\s*i\b|\bp\s*[-–]\s*t\b|do thi\s+(?:toa do|van toc|gia toc|quang duong|cong suat|hieu dien the|cuong do dong dien|u\b|i\b|v\b)|graph of (?:velocity|position|acceleration)/.test(lower) && /(do thi|graph)/.test(lower)) return 'graph';
  if (/rong roc|pulley|atwood/.test(lower)) return 'pulley';
  if (/nem xien|nem ngang|nem len|chuyen dong nem|projectile|quy dao parabol|vat bi nem/.test(lower)) return 'projectile';
  if (/mat phang nghieng|mat nghieng|inclined plane|truot xuong|truot tren mat/.test(lower)) return 'incline';
  if (/thau kinh|guong (?:cau|phang|lom|loi)|guong|khuc xa|tia toi|tia phan xa|lens|mirror|refraction|anh cua vat|anh ao|anh thuc|tieu cu/.test(lower)) return 'optics';
  if (/mach dien|so do mach|circuit|dien tro.*(?:noi tiep|song song)|(?:noi tiep|song song).*dien tro|bong den.*(?:noi tiep|song song)/.test(lower)) return 'circuit';
  if (/luc tac dung|phan tich luc|bieu dien luc|ve luc|cac luc|force diagram|free[- ]body|luc ma sat|phan luc|luc keo|luc cang|trong luc/.test(lower)) return 'forces';
  void f; return null;
}

function extractPhysics(original) {
  const f = U.fold(original); const lower = f.toLowerCase();
  const kind = detectPhysicsKind(lower, f);
  if (!kind) return null;
  const { g, given: gGiven } = getG(f);
  const m = q(f, 'khoi luong|\\bm', 'kg') ?? q(f, 'vat', 'kg');
  const mAll = []; const mre = /(\d+(?:[.,]\d+)?)\s*kg/gi; let mm;
  while ((mm = mre.exec(f))) mAll.push(U.toNum(mm[1]));
  const Fv = q(f, 'luc keo|luc day|\\bF', 'N\\b') ?? null;
  const mu = q(f, 'he so ma sat(?:\\s+truot|\\s+nghi)?|μ|\\bmu\\b', '') ?? (() => { const r = /(?:he so ma sat|μ|\bmu\b)[^\d]{0,20}(\d+(?:[.,]\d+)?)/i.exec(f); return r ? U.toNum(r[1]) : null; })();
  const fricMention = /ma sat|friction/.test(lower);
  const base = { kind, g, gGiven, m, mAll, F: Fv, mu, fricMention };
  let spec;
  switch (kind) {
    case 'forces': spec = forcesFacts(base, f, lower); break;
    case 'incline': spec = inclineFacts(base, f, lower); break;
    case 'projectile': spec = projectileFacts(base, f, lower); break;
    case 'pulley': spec = { ...base, m1: mAll[0] ?? null, m2: mAll[1] ?? null }; break;
    case 'circuit': spec = circuitFacts(base, f, lower); break;
    case 'optics': spec = opticsFacts(base, f, lower); break;
    case 'graph': spec = graphFacts(base, f, lower); break;
    default: spec = null;
  }
  if (spec) {
    const bad = verifyClaims(spec, f);
    if (bad) return { error: `physics_contradiction:${bad.code}`, detail: bad.detail, kind };
  }
  return spec;
}

/**
 * Đối chiếu các đại lượng đề bài NÓI RÕ (N = …, P = …, Fms = …, L = …, I = …, R_td = …) với giá trị TÍNH được từ
 * các dữ kiện còn lại. Lệch quá 5% -> mâu thuẫn -> không vẽ (thay vì vẽ số của engine và âm thầm bỏ số của đề).
 * Chỉ kiểm khi engine THẬT SỰ tính được đại lượng đó (đủ dữ kiện); thiếu thì bỏ qua.
 */
const claimNear = (a, b) => Math.abs(a - b) <= Math.max(0.05 * Math.max(Math.abs(a), Math.abs(b)), 0.05);
function claim(f, re) { const m = re.exec(f); return m ? U.toNum(m[1]) : null; }
function verifyClaims(s, f) {
  const NUMR = '(\\d+(?:[.,]\\d+)?)';
  const bad = (code, detail) => ({ code, detail });
  if (s.kind === 'forces' && s.scene === 'flat' && s.m != null && s.pullAngle == null) {
    const P = s.m * s.g;
    const cN = claim(f, new RegExp(`(?<![A-Za-z])N\\s*=\\s*${NUMR}\\s*N\\b`));
    if (cN != null && !claimNear(cN, P)) return bad('normal_force', `đề cho N = ${K.fmt(cN, 2)} N, nhưng vật đứng yên trên mặt phẳng ngang nên N = P = m·g = ${K.fmt(P, 2)} N (lấy g = ${s.g} m/s²)`);
    const cP = claim(f, new RegExp(`(?<![A-Za-z])P\\s*=\\s*${NUMR}\\s*N\\b`));
    if (cP != null && !claimNear(cP, P)) return bad('weight', `đề cho P = ${K.fmt(cP, 2)} N, nhưng P = m·g = ${K.fmt(P, 2)} N (m = ${K.fmt(s.m, 2)} kg, g = ${s.g} m/s²)`);
    if (s.mu != null && s.F != null) {
      const fmax = s.mu * P; const Fms = s.F > fmax + 1e-9 ? fmax : s.F;
      const cF = claim(f, new RegExp(`\\bFms\\s*=\\s*${NUMR}\\s*N\\b`, 'i'));
      if (cF != null && !claimNear(cF, Fms)) return bad('friction', `đề cho Fms = ${K.fmt(cF, 2)} N, nhưng từ μ = ${s.mu}, N = ${K.fmt(P, 2)} N và F = ${K.fmt(s.F, 2)} N thì Fms = ${K.fmt(Fms, 2)} N`);
    }
  }
  if (s.kind === 'projectile' && s.v0 > 0 && s.alpha != null) {
    const r = projectileSolve(s);
    const cL = r ? claim(f, new RegExp(`(?<![A-Za-z])L\\s*=\\s*${NUMR}\\s*m\\b`)) : null;
    if (cL != null && !claimNear(cL, r.L)) return bad('range', `đề cho tầm xa L = ${K.fmt(cL, 2)} m, nhưng với v0 = ${K.fmt(s.v0, 2)} m/s, α = ${s.alpha}°, g = ${s.g} m/s² thì L = ${K.fmt(r.L, 2)} m`);
  }
  if (s.kind === 'circuit' && s.items.length && s.items.every((i) => i.value != null && i.value > 0)) {
    const vals = s.items.map((i) => i.value);
    const Rt = s.topology === 'series' ? vals.reduce((a, b) => a + b, 0) : 1 / vals.reduce((a, b) => a + 1 / b, 0);
    const cR = claim(f, new RegExp(`\\bR_?td\\s*=\\s*${NUMR}`, 'i'));
    if (cR != null && !claimNear(cR, Rt)) return bad('equivalent_resistance', `đề cho R_tđ = ${K.fmt(cR, 2)} Ω, nhưng từ các điện trở đã cho R_tđ = ${K.fmt(Rt, 2)} Ω`);
    if (s.E != null) {
      const I = s.E / Rt; const cI = claim(f, new RegExp(`(?<![A-Za-z])I\\s*=\\s*${NUMR}\\s*A\\b`));
      if (cI != null && !claimNear(cI, I)) return bad('current', `đề cho I = ${K.fmt(cI, 2)} A, nhưng I = E/R_tđ = ${K.fmt(s.E, 2)}/${K.fmt(Rt, 2)} = ${K.fmt(I, 2)} A`);
    }
  }
  return null;
}

function angleOf(f) {
  const r = /(?:goc nghieng|nghieng(?: mot)? goc|α|alpha|goc)\s*(?:=|la|bang)?\s*(\d+(?:[.,]\d+)?)\s*(?:°|do\b|deg)/i.exec(f) || /(\d+(?:[.,]\d+)?)\s*(?:°|độ)/.exec(f);
  return r ? U.toNum(r[1]) : null;
}
function forcesFacts(b, f, lower) {
  const hanging = /treo|day cang|luc cang|day treo/.test(lower);
  const angle = angleOf(f);
  return { ...b, scene: hanging ? 'hanging' : 'flat', pullAngle: /keo.*(?:hop|tao) (?:mot )?goc|goc.*so voi phuong ngang/.test(lower) ? angle : null };
}
function inclineFacts(b, f) {
  return { ...b, alpha: angleOf(f) };
}
function projectileFacts(b, f, lower) {
  const v0 = q(f, 'v0|van toc ban dau|van toc nem|van toc', 'm/s');
  const ang = angleOf(f);
  const h0 = q(f, 'do cao|h0|\\bh', 'm\\b');
  const horizontal = /nem ngang|horizontal/.test(lower);
  return { ...b, v0, alpha: horizontal ? 0 : ang, h0: h0 ?? 0, horizontal };
}
function circuitFacts(b, f, lower) {
  const parallel = /song song|parallel/.test(lower) && !/noi tiep.*song song|hon hop/.test(lower);
  const series = !parallel;
  const E = q(f, 'hieu dien the|nguon|\\bE\\b|\\bU\\b|suat dien dong', 'V\\b') ?? (() => { const r = /(\d+(?:[.,]\d+)?)\s*V\b/.exec(f); return r ? U.toNum(r[1]) : null; })();
  const items = [];
  const rre = /\b(R\d?)\s*=\s*(\d+(?:[.,]\d+)?)\s*(?:Ω|ohm|om|Ohm)?/g; let m;
  while ((m = rre.exec(f))) if (!items.find((x) => x.name === m[1])) items.push({ type: 'resistor', name: m[1], value: U.toNum(m[2]) });
  if (!items.length) {
    const cnt = (word) => { const r = new RegExp(`(?:(\\d+)|\\b(mot|hai|ba|bon))\\s*(?:${word})`).exec(lower); if (!r) return 0; return r[1] ? Number(r[1]) : ({ mot: 1, hai: 2, ba: 3, bon: 4 })[r[2]]; };
    const nr = Math.min(cnt('dien tro'), 4); const nl = Math.min(cnt('bong den|den\\b'), 4);
    for (let i = 1; i <= nr; i++) items.push({ type: 'resistor', name: `R${i}`, value: null });
    for (let i = 1; i <= nl; i++) items.push({ type: 'lamp', name: `Đ${i}`, value: null });
  }
  if (!items.length) { items.push({ type: 'resistor', name: 'R1', value: null }, { type: 'resistor', name: 'R2', value: null }); }
  return {
    ...b, topology: series ? 'series' : 'parallel', E, items: items.slice(0, 4),
    ammeter: /ampe|am pe|ampere|ammeter/.test(lower), voltmeter: /von ke|volt ?meter|voltmeter/.test(lower),
    switchOn: /cong tac/.test(lower), switchClosed: /dong (?:cong tac)|cong tac dong|closed/.test(lower), capacitor: /tu dien|capacitor/.test(lower)
  };
}
function opticsFacts(b, f, lower) {
  let device = null;
  if (/guong phang|plane mirror/.test(lower)) device = 'plane_mirror';
  else if (/guong cau lom|guong lom|concave mirror/.test(lower)) device = 'concave_mirror';
  else if (/guong cau loi|guong loi|convex mirror/.test(lower)) device = 'convex_mirror';
  else if (/thau kinh phan ki|thau kinh rieng|diverging/.test(lower)) device = 'diverging_lens';
  else if (/thau kinh hoi tu|thau kinh|converging|lens/.test(lower)) device = 'converging_lens';
  else if (/khuc xa|refraction/.test(lower)) device = 'refraction';
  else if (/phan xa|reflection|tia toi/.test(lower)) device = 'plane_mirror';
  if (!device) return null;
  const fl = q(f, 'tieu cu|\\bf', 'cm|m\\b');
  const d = q(f, 'vat cach[^\\d]{0,25}|khoang cach vat|\\bd\\b|\\bOA\\b', 'cm|m\\b') ?? (() => { const r = /cach\s+(?:thau kinh|guong)(?:\s+(?:hoi tu|phan ki|cau loi|cau lom|phang|loi|lom))*\s*(?:\S+\s+)?(\d+(?:[.,]\d+)?)\s*cm/.exec(f); return r ? U.toNum(r[1]) : null; })();
  const h = q(f, 'cao|\\bh\\b|\\bAB\\b', 'cm|m\\b');
  const i = (() => { const r = /(?:goc toi|\bi\b)\s*(?:=|la|bang)?\s*(\d+(?:[.,]\d+)?)\s*(?:°|do\b)?/i.exec(f); return r ? U.toNum(r[1]) : null; })();
  const idx = { 'khong khi': 1.0, nuoc: 1.33, 'thuy tinh': 1.5, 'kim cuong': 2.42 };
  let n1 = q(f, 'n1', ''); let n2 = q(f, 'n2', '');
  const rn = (re) => { const r = re.exec(f); return r ? U.toNum(r[1]) : null; };
  n1 = n1 ?? rn(/n1\s*=\s*(\d+(?:[.,]\d+)?)/); n2 = n2 ?? rn(/n2\s*=\s*(\d+(?:[.,]\d+)?)/);
  if (n1 == null || n2 == null) { const media = Object.keys(idx).filter((k) => lower.includes(k)); if (media.length >= 2) { n1 = idx[media[0]]; n2 = idx[media[1]]; } else if (media.length === 1 && device === 'refraction') { n1 = 1.0; n2 = idx[media[0]]; } }
  return { ...b, device, focal: fl, dist: d, objH: h, incidence: i, n1, n2 };
}
function graphFacts(b, f, lower) {
  const t = /\bu\s*[-–]\s*i\b|hieu dien the.*cuong do|cuong do.*hieu dien the/.test(lower) ? 'U-I'
    : /\bp\s*[-–]\s*t\b|cong suat.*thoi gian/.test(lower) ? 'P-t'
      : /\ba\s*[-–]\s*t\b|gia toc.*thoi gian/.test(lower) ? 'a-t'
        : /\bs\s*[-–]\s*t\b|toa do.*thoi gian|quang duong.*thoi gian|x\s*[-–]\s*t/.test(lower) ? 's-t'
          : /\bv\s*[-–]\s*t\b|van toc.*thoi gian/.test(lower) ? 'v-t' : null;
  if (!t) return null;
  const v0 = q(f, 'v0|van toc ban dau', 'm/s'); const v = q(f, '\\bv\\b|van toc', 'm/s');
  const a = q(f, '\\ba\\b|gia toc', 'm/s\\^?2|m/s²'); const x0 = q(f, 'x0|toa do ban dau', 'm\\b');
  const R = q(f, '\\bR\\b|dien tro', 'Ω|ohm|om'); const P = q(f, '\\bP\\b|cong suat', 'W\\b');
  const T = q(f, 'thoi gian|\\bt\\b|trong', 's\\b|giay');
  return { ...b, graph: t, v0, v, a, x0, R, P, T };
}

// ---------------------------------------------------------------- Rendering helpers
function forceArrow(cv, o, from, to, color, label, sub, value, side = 1) {
  cv.arrow(from[0], from[1], to[0], to[1], { stroke: color, w: 2.6 });
  const d = K.unit(K.sub(to, from)); const nrm = [-d[1] * side, d[0] * side];
  const lx = to[0] + d[0] * 14 + nrm[0] * 10; const ly = to[1] + d[1] * 14 + nrm[1] * 10 + 4;
  const txt = value != null ? ` = ${f1(value)} N` : '';
  cv.add(K.textSub(lx, ly, `${label}⃗`.replace('⃗', '') , sub, { bold: true, size: 15, color, anchor: d[0] > 0.3 ? 'start' : (d[0] < -0.3 ? 'end' : 'middle') }));
  if (txt) cv.add(K.text(lx + (d[0] > 0.3 ? 22 : d[0] < -0.3 ? -22 : 0), ly + 15, txt.trim(), { size: 12, color, anchor: d[0] > 0.3 ? 'start' : (d[0] < -0.3 ? 'end' : 'middle') }));
  void o;
}
function vecMark(cv, from, to) { void cv; void from; void to; }
function ground(cv, x1, x2, y, hatch = true) {
  cv.add(K.line(x1, y, x2, y, { w: 2.4 }));
  if (hatch) for (let x = x1 + 6; x < x2 - 4; x += 14) cv.add(K.line(x, y, x - 8, y + 9, { stroke: COLORS.MUTED, w: 1.2 }));
}
function notesPanel(cv, lines, y0) {
  lines.forEach((t, i) => cv.add(K.text(24, y0 + i * 19, t, { size: 13, color: COLORS.MUTED, anchor: 'start' })));
}

function renderForces(s) {
  const cv = new Canvas(W, H); cv.title = 'Sơ đồ lực tác dụng lên vật'; cv.desc = cv.title;
  const gy = 290; ground(cv, 40, 520, gy);
  const bw = 96; const bh = 64; const bx = 232; const by = gy - bh;
  const C = [bx + bw / 2, by + bh / 2];
  cv.add(K.rect(bx, by, bw, bh, { fill: COLORS.FILL, stroke: COLORS.INK, w: 2.2 }));
  cv.add(K.text(bx + 8, by + bh - 8, s.m != null ? `m = ${f1(s.m)} kg` : 'm', { size: 13, anchor: 'start' }));
  cv.add(K.circle(C[0], C[1], 3.2, { fill: COLORS.INK, stroke: COLORS.INK, w: 1 }));
  const numeric = s.m != null; const P = numeric ? s.m * s.g : null;
  const Lp = 92;
  const scale = (val) => (numeric && val != null ? Math.max(0.3, Math.min(1.5, val / P)) * Lp : Lp * 0.7);
  if (s.scene === 'hanging') {
    cv.add(K.line(C[0], by, C[0], 60, { w: 2 })); cv.add(K.line(190, 60, 370, 60, { w: 3 }));
    cv.arrow(C[0], C[1], C[0], C[1] - Lp, { stroke: COLORS.GREEN, w: 2.6 }); cv.add(K.textSub(C[0] + 16, C[1] - Lp + 6, 'T', '', { bold: true, size: 15, color: COLORS.GREEN, anchor: 'start' }));
    cv.arrow(C[0], C[1], C[0], C[1] + Lp * 0.9, { stroke: COLORS.RED, w: 2.6 }); cv.add(K.text(C[0] + 16, C[1] + Lp * 0.9 + 6, 'P', { bold: true, size: 15, color: COLORS.RED, anchor: 'start' }));
    if (P != null) cv.add(K.text(C[0] + 34, C[1] + Lp * 0.9 + 6, `= ${f1(P)} N`, { size: 12, color: COLORS.RED, anchor: 'start' }));
    cv.title = 'Vật treo: trọng lực và lực căng dây';
  } else {
    let Fms = null; let Fapp = s.F; let a = null; let sliding = null;
    if (numeric && s.mu != null) { const N = P; const fmax = s.mu * N; if (Fapp != null) { sliding = Fapp > fmax + 1e-9; Fms = sliding ? fmax : Fapp; a = sliding ? (Fapp - fmax) / s.m : 0; } else { Fms = null; } }
    // P và N
    cv.arrow(C[0], C[1], C[0], C[1] + scale(P), { stroke: COLORS.RED, w: 2.6 }); cv.add(K.text(C[0] + 14, C[1] + scale(P) + 4, 'P', { bold: true, size: 15, color: COLORS.RED, anchor: 'start' }));
    cv.arrow(C[0], C[1], C[0], C[1] - scale(P), { stroke: COLORS.GREEN, w: 2.6 }); cv.add(K.text(C[0] + 14, C[1] - scale(P) + 4, 'N', { bold: true, size: 15, color: COLORS.GREEN, anchor: 'start' }));
    if (numeric) { cv.add(K.text(C[0] + 30, C[1] + scale(P) + 4, `= ${f1(P)} N`, { size: 12, color: COLORS.RED, anchor: 'start' })); cv.add(K.text(C[0] + 30, C[1] - scale(P) + 4, `= ${f1(P)} N`, { size: 12, color: COLORS.GREEN, anchor: 'start' })); }
    if (Fapp != null || /luc keo|luc day/.test('') || s.F === null && /keo|day|F\b/.test('')) { /* handled below */ }
    const showF = Fapp != null || s.hasPull;
    if (showF || true) {
      const lenF = scale(Fapp); const ang = s.pullAngle != null ? rad(s.pullAngle) : 0;
      const to = [C[0] + lenF * Math.cos(ang) + 40, C[1] - lenF * Math.sin(ang)];
      if (Fapp != null || s.pullAngle != null) {
        cv.arrow(C[0] + bw / 2, C[1] - (s.pullAngle ? 0 : 0), C[0] + bw / 2 + lenF * Math.cos(ang), C[1] - lenF * Math.sin(ang), { stroke: COLORS.BLUE, w: 2.6 });
        cv.add(K.text(C[0] + bw / 2 + lenF * Math.cos(ang) + 8, C[1] - lenF * Math.sin(ang) - 8, 'F', { bold: true, size: 15, color: COLORS.BLUE, anchor: 'start' }));
        if (Fapp != null) cv.add(K.text(C[0] + bw / 2 + lenF * Math.cos(ang) + 24, C[1] - lenF * Math.sin(ang) - 8, `= ${f1(Fapp)} N`, { size: 12, color: COLORS.BLUE, anchor: 'start' }));
      }
      void to;
    }
    if (s.fricMention || s.mu != null) {
      const lenM = Fms != null ? scale(Fms) : Lp * 0.55;
      cv.arrow(C[0] - bw / 2, C[1], C[0] - bw / 2 - lenM, C[1], { stroke: COLORS.ORANGE, w: 2.6 });
      cv.add(K.textSub(C[0] - bw / 2 - lenM - 6, C[1] - 12, 'F', 'ms', { bold: true, size: 15, color: COLORS.ORANGE, anchor: 'end' }));
      if (Fms != null) cv.add(K.text(C[0] - bw / 2 - lenM - 6, C[1] + 8, `= ${f1(Fms)} N`, { size: 12, color: COLORS.ORANGE, anchor: 'end' }));
    }
    const notes = [];
    if (numeric) notes.push(`P = m·g = ${f1(s.m)}·${f1(s.g)} = ${f1(P)} N${s.gGiven ? '' : ' (lấy g = 10 m/s²)'}; vật cân bằng theo phương thẳng đứng nên N = P`);
    if (a != null) notes.push(sliding ? `Fms = μ·N = ${f1(Fms)} N; a = (F − Fms)/m = ${f1(a)} m/s²` : `F ≤ μN nên vật đứng yên, Fms = F = ${f1(Fms)} N`);
    if (notes.length) notesPanel(cv, notes, 336);
  }
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function renderIncline(s) {
  const cv = new Canvas(W, H); cv.title = 'Vật trên mặt phẳng nghiêng'; cv.desc = cv.title;
  const alpha = s.alpha != null ? s.alpha : 30;
  if (!(alpha > 0 && alpha < 89)) return null;
  const t = rad(alpha); const baseLen = 400; const x0 = 60; const yb = 330;
  const top = [x0, yb - Math.tan(t) * baseLen]; const bl = [x0, yb]; const br = [x0 + baseLen, yb];
  // Mặt nghiêng đi từ trên-trái xuống dưới-phải. Toạ độ dọc mặt: gốc tại đỉnh, hướng xuống mặt phẳng.
  const dirDown = K.unit([br[0] - top[0], br[1] - top[1]]); const nrm = [-dirDown[1] * -1, dirDown[0] * -1]; // pháp tuyến hướng ra ngoài (lên-phải)
  const out = K.unit([Math.sin(t), -Math.cos(t)]);
  void nrm;
  cv.add(K.polygon([top, bl, br], { fill: '#f9fafb', stroke: COLORS.INK, w: 2.2 }));
  const base = K.add(top, K.mul(dirDown, 190));
  const bs = 60; const centerBlock = K.add(base, K.mul(out, bs / 2));
  // khối vuông xoay theo mặt phẳng
  const ux = K.mul(dirDown, bs / 2); const uy = K.mul(out, bs / 2);
  const corners = [K.add(K.add(centerBlock, K.mul(ux, -1)), K.mul(uy, -1)), K.add(K.add(centerBlock, ux), K.mul(uy, -1)), K.add(K.add(centerBlock, ux), uy), K.add(K.add(centerBlock, K.mul(ux, -1)), uy)];
  cv.add(K.polygon(corners, { fill: COLORS.FILL, stroke: COLORS.INK, w: 2.2 }));
  cv.add(K.circle(centerBlock[0], centerBlock[1], 3.2, { fill: COLORS.INK, stroke: COLORS.INK, w: 1 }));
  const numeric = s.m != null && s.alpha != null; const P = numeric ? s.m * s.g : null;
  const L = 100;
  // P
  cv.arrow(centerBlock[0], centerBlock[1], centerBlock[0], centerBlock[1] + L, { stroke: COLORS.RED, w: 2.6 });
  cv.add(K.text(centerBlock[0] + 12, centerBlock[1] + L + 6, 'P', { bold: true, size: 15, color: COLORS.RED, anchor: 'start' }));
  // Px, Py (nét đứt)
  const Px = K.mul(dirDown, L * Math.sin(t)); const Py = K.mul(out, -L * Math.cos(t));
  cv.arrow(centerBlock[0], centerBlock[1], centerBlock[0] + Px[0], centerBlock[1] + Px[1], { stroke: COLORS.PURPLE, w: 2, dash: '6 4' });
  cv.arrow(centerBlock[0], centerBlock[1], centerBlock[0] + Py[0], centerBlock[1] + Py[1], { stroke: COLORS.PURPLE, w: 2, dash: '6 4' });
  cv.add(K.textSub(centerBlock[0] + Px[0] + 8, centerBlock[1] + Px[1] + 16, 'P', 'x', { size: 13, color: COLORS.PURPLE, anchor: 'start' }));
  cv.add(K.textSub(centerBlock[0] + Py[0] + 12, centerBlock[1] + Py[1] + 12, 'P', 'y', { size: 13, color: COLORS.PURPLE, anchor: 'start' }));
  // N
  const Nl = L * Math.cos(t);
  cv.arrow(centerBlock[0], centerBlock[1], centerBlock[0] + out[0] * Nl, centerBlock[1] + out[1] * Nl, { stroke: COLORS.GREEN, w: 2.6 });
  cv.add(K.text(centerBlock[0] + out[0] * Nl - 12, centerBlock[1] + out[1] * Nl - 6, 'N', { bold: true, size: 15, color: COLORS.GREEN, anchor: 'end' }));
  // Fms (ngược chiều chuyển động dọc mặt nghiêng, hướng lên)
  let Fms = null; let sliding = null; let a = null;
  if (numeric && s.mu != null) { const N = P * Math.cos(t); const px = P * Math.sin(t); sliding = s.mu * N < px - 1e-9; Fms = sliding ? s.mu * N : px; a = sliding ? (px - s.mu * N) / s.m : 0; }
  if (s.fricMention || s.mu != null) {
    const Lf = Fms != null && P != null ? Math.max(30, Math.min(110, Fms / (P * Math.sin(t)) * L * Math.sin(t))) : L * Math.sin(t) * 0.7;
    cv.arrow(centerBlock[0], centerBlock[1], centerBlock[0] - dirDown[0] * Lf, centerBlock[1] - dirDown[1] * Lf, { stroke: COLORS.ORANGE, w: 2.6 });
    cv.add(K.textSub(centerBlock[0] - dirDown[0] * Lf - 8, centerBlock[1] - dirDown[1] * Lf - 10, 'F', 'ms', { bold: true, size: 15, color: COLORS.ORANGE, anchor: 'end' }));
  }
  if (sliding) { const La = 50; const s0 = K.add(centerBlock, K.mul(out, 45)); cv.arrow(s0[0], s0[1], s0[0] + dirDown[0] * La, s0[1] + dirDown[1] * La, { stroke: COLORS.TEAL, w: 2.2 }); cv.add(K.text(s0[0] + dirDown[0] * La + 6, s0[1] + dirDown[1] * La + 2, 'a', { italic: true, size: 14, color: COLORS.TEAL, anchor: 'start' })); }
  // Góc α ở chân dốc
  const ang = K.unit([top[0] - br[0], top[1] - br[1]]);
  cv.add(K.path(K.arcPath(br, [-1, 0], ang, 46), { stroke: COLORS.ORANGE, w: 1.8 }));
  cv.add(K.text(br[0] - 66, br[1] - 8, s.alpha != null ? `α = ${f1(alpha)}°` : 'α', { size: 14, color: COLORS.ORANGE }));
  ground(cv, 30, 500, yb, true);
  const notes = [];
  if (numeric) {
    notes.push(`P = m·g = ${f1(s.m)}·${f1(s.g)} = ${f1(P)} N${s.gGiven ? '' : ' (lấy g = 10 m/s²)'}; Px = P·sinα = ${f1(P * Math.sin(t))} N; Py = P·cosα = N = ${f1(P * Math.cos(t))} N`);
    if (Fms != null) notes.push(sliding ? `Vật trượt: Fms = μ·N = ${f1(Fms)} N; a = ${f1(a)} m/s²` : `μ ≥ tanα: vật đứng yên, Fms = Px = ${f1(Fms)} N`);
  }
  if (notes.length) notesPanel(cv, notes, 372);
  void top;
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function projectileSolve(s) {
  const v0 = s.v0; const g = s.g; const a = rad(s.alpha); const h0 = s.h0 || 0;
  if (!(v0 > 0)) return null;
  const vx = v0 * Math.cos(a); const vy = v0 * Math.sin(a);
  const disc = vy * vy + 2 * g * h0; const T = (vy + Math.sqrt(disc)) / g; const L = vx * T;
  const tH = vy > 0 ? vy / g : 0; const Hmax = h0 + (vy > 0 ? vy * vy / (2 * g) : 0);
  return { vx, vy, T, L, tH, Hmax };
}
function renderProjectile(s) {
  const cv = new Canvas(W, H); cv.title = 'Chuyển động ném'; cv.desc = cv.title;
  const alpha = s.alpha != null ? s.alpha : (s.horizontal ? 0 : 45);
  const numeric = s.v0 != null;
  const sol = projectileSolve({ v0: s.v0 != null ? s.v0 : 20, alpha, g: s.g, h0: s.h0 });
  if (!sol) return null;
  const pts = []; const n = 90;
  for (let i = 0; i <= n; i++) { const t = sol.T * i / n; pts.push([sol.vx * t, (s.h0 || 0) + sol.vy * t - 0.5 * s.g * t * t]); }
  const view = makeView([[0, 0], [sol.L * 1.06, Math.max(sol.Hmax, 0.1) * 1.32]], { w: W, h: 320, pad: 44, keepAspect: sol.L / Math.max(sol.Hmax, 0.1) < 12 });
  const P = pts.map((p) => view.P(p));
  ground(cv, 30, 530, view.Y(0), true);
  cv.add(K.polyline(P, { stroke: COLORS.BLUE, w: 2.6 }));
  const L0 = view.P([0, s.h0 || 0]);
  cv.add(K.circle(L0[0], L0[1], 5, { fill: COLORS.RED, stroke: COLORS.RED }));
  const va = alpha === 0 ? [1, 0] : [Math.cos(rad(alpha)), -Math.sin(rad(alpha))];
  cv.arrow(L0[0], L0[1], L0[0] + va[0] * 70, L0[1] + va[1] * 70, { stroke: COLORS.RED, w: 2.6 });
  cv.add(K.textSub(L0[0] + va[0] * 70 + 8, L0[1] + va[1] * 70 - 6, 'v', '0', { italic: true, bold: true, size: 15, color: COLORS.RED, anchor: 'start' }));
  if (alpha > 0) { cv.add(K.path(K.arcPath(L0, [1, 0], K.unit([va[0], va[1]]), 34), { stroke: COLORS.ORANGE, w: 1.6 })); cv.add(K.text(L0[0] + 46, L0[1] - 10, s.alpha != null ? `α = ${f1(alpha)}°` : 'α', { size: 13, color: COLORS.ORANGE, anchor: 'start' })); }
  // Đỉnh + tầm xa
  if (sol.vy > 0) {
    const top = view.P([sol.vx * sol.tH, sol.Hmax]); const gy = view.Y(0);
    cv.add(K.line(top[0], top[1], top[0], gy, { stroke: COLORS.MUTED, w: 1.3, dash: '5 4' })); cv.add(K.circle(top[0], top[1], 3.6, { fill: COLORS.INK, stroke: COLORS.INK }));
    cv.add(K.text(top[0] + 8, (top[1] + gy) / 2, numeric ? `H = ${f1(sol.Hmax)} m` : 'H', { size: 13, color: COLORS.MUTED, anchor: 'start' }));
  }
  const end = view.P([sol.L, 0]); const gy = view.Y(0);
  cv.arrow(L0[0], gy + 26, end[0], gy + 26, { stroke: COLORS.TEAL, w: 1.8 }); cv.arrow(end[0], gy + 26, L0[0], gy + 26, { stroke: COLORS.TEAL, w: 1.8 });
  cv.add(K.text((L0[0] + end[0]) / 2, gy + 44, numeric ? `L = ${f1(sol.L)} m` : 'L', { size: 14, color: COLORS.TEAL }));
  cv.add(K.circle(end[0], end[1], 4, { fill: '#fff', stroke: COLORS.BLUE, w: 2 }));
  if (numeric) notesPanel(cv, [`v0x = v0·cosα = ${f1(sol.vx)} m/s; v0y = v0·sinα = ${f1(sol.vy)} m/s; t = ${f1(sol.T)} s${s.gGiven ? '' : ' (lấy g = 10 m/s²)'}`], 384);
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function renderPulley(s) {
  const cv = new Canvas(W, H); cv.title = 'Hệ hai vật qua ròng rọc'; cv.desc = cv.title;
  const cx = 280; const cy = 90; const R = 30;
  cv.add(K.line(cx, 20, cx, cy - R, { w: 3 })); cv.add(K.line(cx - 60, 20, cx + 60, 20, { w: 3 }));
  cv.add(K.circle(cx, cy, R, { fill: COLORS.FILL, stroke: COLORS.INK, w: 2.4 })); cv.add(K.circle(cx, cy, 3.5, { fill: COLORS.INK, stroke: COLORS.INK }));
  const numeric = s.m1 != null && s.m2 != null;
  let a = null; let T = null; let left = 'm1'; const y1 = numeric && s.m1 > s.m2 ? 250 : (numeric && s.m1 < s.m2 ? 190 : 220);
  const y2 = numeric && s.m1 > s.m2 ? 190 : (numeric && s.m1 < s.m2 ? 250 : 220);
  if (numeric) { a = Math.abs(s.m1 - s.m2) * s.g / (s.m1 + s.m2); T = 2 * s.m1 * s.m2 * s.g / (s.m1 + s.m2); }
  const xl = cx - R; const xr = cx + R;
  cv.add(K.line(xl, cy, xl, y1, { w: 1.8 })); cv.add(K.line(xr, cy, xr, y2, { w: 1.8 }));
  cv.add(K.rect(xl - 30, y1, 60, 46, { fill: '#fef3c7', stroke: COLORS.INK, w: 2.2 })); cv.add(K.rect(xr - 30, y2, 60, 46, { fill: '#dcfce7', stroke: COLORS.INK, w: 2.2 }));
  cv.add(K.textSub(xl, y1 + 29, 'm', '1', { size: 15, bold: true })); cv.add(K.textSub(xr, y2 + 29, 'm', '2', { size: 15, bold: true }));
  if (numeric) { cv.add(K.text(xl, y1 + 64, `${f1(s.m1)} kg`, { size: 12, color: COLORS.MUTED })); cv.add(K.text(xr, y2 + 64, `${f1(s.m2)} kg`, { size: 12, color: COLORS.MUTED })); }
  const arrows = [[xl, y1, COLORS.RED, 'P', '1'], [xr, y2, COLORS.RED, 'P', '2']];
  arrows.forEach(([x, y, c, l, sb]) => { cv.arrow(x, y + 23, x, y + 23 + 62, { stroke: c, w: 2.4 }); cv.add(K.textSub(x + 12, y + 23 + 66, l, sb, { bold: true, size: 14, color: c, anchor: 'start' })); });
  [[xl, y1, '1'], [xr, y2, '2']].forEach(([x, y, sb]) => { cv.arrow(x + (sb === '1' ? -20 : 20), y, x + (sb === '1' ? -20 : 20), y - 56, { stroke: COLORS.GREEN, w: 2.4 }); cv.add(K.textSub(x + (sb === '1' ? -30 : 30), y - 50, 'T', sb, { bold: true, size: 14, color: COLORS.GREEN, anchor: sb === '1' ? 'end' : 'start' })); });
  if (numeric && a > 0) {
    const down = s.m1 > s.m2 ? xl : xr; const up = s.m1 > s.m2 ? xr : xl; const yd = s.m1 > s.m2 ? y1 : y2; const yu = s.m1 > s.m2 ? y2 : y1;
    cv.arrow(down + (down < cx ? -62 : 62), yd + 10, down + (down < cx ? -62 : 62), yd + 60, { stroke: COLORS.TEAL, w: 2.2 }); cv.add(K.text(down + (down < cx ? -70 : 70), yd + 40, 'a', { italic: true, size: 14, color: COLORS.TEAL, anchor: down < cx ? 'end' : 'start' }));
    cv.arrow(up + (up < cx ? -62 : 62), yu + 60, up + (up < cx ? -62 : 62), yu + 10, { stroke: COLORS.TEAL, w: 2.2 }); void left;
    notesPanel(cv, [`a = |m1 − m2|·g/(m1 + m2) = ${f1(a)} m/s²; T = 2·m1·m2·g/(m1 + m2) = ${f1(T)} N${s.gGiven ? '' : ' (lấy g = 10 m/s²)'}`], 372);
  }
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

// ---------------------------------------------------------------- Circuits
function elem(cv, type, cx, cy, vertical, label, sub) {
  const col = COLORS.INK;
  const lab = (dx, dy) => { if (label) cv.add(sub ? K.textSub(cx + dx, cy + dy, label, sub, { size: 13 }) : K.text(cx + dx, cy + dy, label, { size: 13 })); };
  if (type === 'resistor') {
    if (vertical) { cv.add(K.rect(cx - 10, cy - 24, 20, 48, { fill: '#fff', stroke: col, w: 2 })); lab(28, 4); } else { cv.add(K.rect(cx - 26, cy - 10, 52, 20, { fill: '#fff', stroke: col, w: 2 })); lab(0, 32); }
  } else if (type === 'lamp') {
    cv.add(K.circle(cx, cy, 16, { fill: '#fff', stroke: col, w: 2 })); cv.add(K.line(cx - 11, cy - 11, cx + 11, cy + 11, { w: 1.6 })); cv.add(K.line(cx - 11, cy + 11, cx + 11, cy - 11, { w: 1.6 })); lab(vertical ? 30 : 0, vertical ? 4 : -24);
  } else if (type === 'ammeter' || type === 'voltmeter') {
    cv.add(K.circle(cx, cy, 15, { fill: '#fff', stroke: COLORS.RED, w: 2 })); cv.add(K.text(cx, cy + 5, type === 'ammeter' ? 'A' : 'V', { bold: true, size: 15, color: COLORS.RED }));
  } else if (type === 'switch') {
    if (vertical) { cv.add(K.circle(cx, cy - 16, 3, { fill: col, stroke: col, w: 1 })); cv.add(K.circle(cx, cy + 16, 3, { fill: col, stroke: col, w: 1 })); cv.add(K.line(cx, cy + 16, cx + 14, cy - 12, { w: 2 })); } else { cv.add(K.circle(cx - 18, cy, 3, { fill: col, stroke: col, w: 1 })); cv.add(K.circle(cx + 18, cy, 3, { fill: col, stroke: col, w: 1 })); cv.add(K.line(cx - 18, cy, cx + 14, cy - 14, { w: 2 })); }
  } else if (type === 'capacitor') {
    if (vertical) { cv.add(K.line(cx - 16, cy - 5, cx + 16, cy - 5, { w: 2.6 })); cv.add(K.line(cx - 16, cy + 5, cx + 16, cy + 5, { w: 2.6 })); lab(30, 4); } else { cv.add(K.line(cx - 5, cy - 16, cx - 5, cy + 16, { w: 2.6 })); cv.add(K.line(cx + 5, cy - 16, cx + 5, cy + 16, { w: 2.6 })); lab(0, -24); }
  } else if (type === 'battery') {
    cv.add(K.line(cx - 16, cy - 6, cx + 16, cy - 6, { w: 3 })); cv.add(K.line(cx - 9, cy + 6, cx + 9, cy + 6, { w: 3 }));
    cv.add(K.text(cx + 26, cy - 2, '+', { size: 14, bold: true })); cv.add(K.text(cx + 26, cy + 14, '−', { size: 14, bold: true })); if (label) cv.add(K.text(cx - 26, cy + 4, label, { size: 14, anchor: 'end', italic: true }));
  }
}
function wire(cv, pts) { cv.add(K.polyline(pts, { stroke: COLORS.INK, w: 2 })); }
function junction(cv, x, y) { cv.add(K.circle(x, y, 3.4, { fill: COLORS.INK, stroke: COLORS.INK, w: 1 })); }

function renderCircuit(s) {
  const cv = new Canvas(W, H); cv.title = s.topology === 'series' ? 'Mạch điện mắc nối tiếp' : 'Mạch điện mắc song song'; cv.desc = cv.title;
  const items = s.items; const vals = items.map((i) => i.value); const allVals = vals.every((v) => v != null && v > 0);
  const left = 90; const right = 470; const top = 90; const bot = 270;
  const showLabel = (it) => (it.value != null ? `${it.name}=${f1(it.value)}Ω` : it.name);
  const notes = [];
  if (s.topology === 'series') {
    const top2 = 110; const bot2 = 270;
    wire(cv, [[left, top2], [left, bot2]]); // trái: nguồn ở đây
    cv.add(K.rect(left - 4, 168, 8, 44, { fill: '#fff', stroke: '#fff', w: 0 }));
    elem(cv, 'battery', left, 190, true, s.E != null ? `E=${f1(s.E)}V` : 'E');
    // nguồn dọc: vẽ bản cực ngang (như ký hiệu chuẩn) -> dùng elem battery (ngang) đặt giữa dây dọc
    wire(cv, [[left, top2], [right, top2], [right, bot2], [left, bot2]]);
    const slots = [];
    if (s.switchOn) slots.push({ type: 'switch' });
    if (s.ammeter) slots.push({ type: 'ammeter' });
    items.forEach((it) => slots.push({ type: it.type, it }));
    if (s.capacitor) slots.push({ type: 'capacitor' });
    const span = right - left - 60; const step = span / slots.length;
    slots.forEach((sl, i) => {
      const cx = left + 30 + step * (i + 0.5);
      cv.add(K.rect(cx - 30, top2 - 8, 60, 16, { fill: '#fff', stroke: '#fff', w: 0 }));
      elem(cv, sl.type, cx, top2, false, sl.it ? showLabel(sl.it) : (sl.type === 'capacitor' ? 'C' : ''), null);
      sl.cx = cx;
    });
    if (s.voltmeter) {
      const target = slots.find((sl) => sl.it) || slots[0];
      const vx = target.cx; const vy = top2 - 64;
      wire(cv, [[vx - 26, top2], [vx - 26, vy], [vx - 15, vy]]); wire(cv, [[vx + 26, top2], [vx + 26, vy], [vx + 15, vy]]); junction(cv, vx - 26, top2); junction(cv, vx + 26, top2);
      elem(cv, 'voltmeter', vx, vy, false, '', null);
    }
    if (allVals) {
      const Rt = vals.reduce((a, b) => a + b, 0); notes.push(`R_tđ = ${items.map((i) => i.name).join(' + ')} = ${f1(Rt)} Ω`);
      if (s.E != null) { const I = s.E / Rt; notes.push(`I = E/R_tđ = ${f1(I)} A (cường độ như nhau ở mọi phần tử); ${items.map((i) => `U${i.name.replace(/^R/, '')} = ${f1(I * i.value)} V`).join('; ')}`); }
    }
  } else {
    const busTop = 120; const busBot = 290; const bx = 250; const n = items.length + (s.capacitor ? 1 : 0);
    wire(cv, [[left, busTop - 30], [left, 320], [right, 320]]);
    elem(cv, 'battery', left, 200, true, s.E != null ? `E=${f1(s.E)}V` : 'E');
    cv.add(K.rect(left - 20, 180, 40, 40, { fill: '#fff', stroke: '#fff', w: 0 })); elem(cv, 'battery', left, 200, true, s.E != null ? `E=${f1(s.E)}V` : 'E');
    // dây chính phía trên: nguồn -> [switch] -> [ampe] -> nút
    const mainEls = []; if (s.switchOn) mainEls.push('switch'); if (s.ammeter) mainEls.push('ammeter');
    wire(cv, [[left, busTop - 30], [bx, busTop - 30]]);
    mainEls.forEach((tp, i) => { const cx = left + 60 + i * 70; cv.add(K.rect(cx - 28, busTop - 40, 56, 20, { fill: '#fff', stroke: '#fff', w: 0 })); elem(cv, tp, cx, busTop - 30, false, '', null); });
    const xs = []; for (let i = 0; i < n; i++) xs.push(bx + i * 80);
    const endX = xs[xs.length - 1];
    wire(cv, [[bx, busTop - 30], [bx, busTop], [endX, busTop]]); wire(cv, [[bx, busBot + 30], [endX, busBot + 30], [endX + 40, busBot + 30]]); wire(cv, [[bx, busBot + 30], [bx, 320]]);
    wire(cv, [[endX + 40, busBot + 30], [right, busBot + 30]]); wire(cv, [[bx, 320], [left, 320]]);
    xs.forEach((x, i) => {
      const isCap = s.capacitor && i === n - 1; const it = items[i];
      wire(cv, [[x, busTop], [x, (busTop + busBot) / 2 - 30]]); wire(cv, [[x, (busTop + busBot) / 2 + 30], [x, busBot + 30]]);
      cv.add(K.rect(x - 22, (busTop + busBot) / 2 - 30, 44, 60, { fill: '#fff', stroke: '#fff', w: 0 }));
      elem(cv, isCap ? 'capacitor' : it.type, x, (busTop + busBot) / 2, true, isCap ? 'C' : showLabel(it), null);
      junction(cv, x, busTop); junction(cv, x, busBot + 30);
    });
    if (s.voltmeter) { const vx = endX + 70; wire(cv, [[endX, busTop], [vx, busTop], [vx, (busTop + busBot) / 2 - 15]]); wire(cv, [[endX, busBot + 30], [vx, busBot + 30], [vx, (busTop + busBot) / 2 + 15]]); elem(cv, 'voltmeter', vx, (busTop + busBot) / 2, true, '', null); }
    wire(cv, [[right, busBot + 30], [right, 320]]);
    if (allVals) {
      const inv = vals.reduce((a, b) => a + 1 / b, 0); const Rt = 1 / inv; notes.push(`1/R_tđ = ${items.map((i) => `1/${i.name}`).join(' + ')} ⇒ R_tđ = ${f1(Rt)} Ω`);
      if (s.E != null) { const I = s.E / Rt; notes.push(`U = E = ${f1(s.E)} V (hiệu điện thế như nhau); ${items.map((i) => `I${i.name.replace(/^R/, '')} = ${f1(s.E / i.value)} A`).join('; ')}; I = ${f1(I)} A`); }
    }
  }
  if (notes.length) notesPanel(cv, notes, 352);
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

// ---------------------------------------------------------------- Optics
function clipRay(from, to, view, ext = 0) { void view; const d = K.unit(K.sub(to, from)); return [from, K.add(to, K.mul(d, ext))]; }
function renderOptics(s) {
  const cv = new Canvas(W, 400);
  const dev = s.device;
  if (dev === 'refraction') return renderRefraction(s, cv);
  const isLens = dev.endsWith('lens'); const isMirror = dev.endsWith('mirror');
  const plane = dev === 'plane_mirror';
  const f = plane ? Infinity : (s.focal != null ? (dev === 'diverging_lens' || dev === 'convex_mirror' ? -Math.abs(s.focal) : Math.abs(s.focal)) : (dev === 'diverging_lens' || dev === 'convex_mirror' ? -60 : 60));
  const numericF = plane ? true : s.focal != null; const numericD = s.dist != null;
  const d = numericD ? s.dist : (plane ? 100 : (f > 0 ? 2.2 * f : 90));
  if (!(d > 0)) return null;
  if (!plane && Math.abs(d - f) < 1e-9) return null; // vật ở tiêu điểm: ảnh ở vô cực
  const h = s.objH != null ? s.objH : d * 0.28;
  const dp = plane ? -d : (f * d) / (d - f); // dp>0 ảnh thật (thấu kính: bên kia; gương: trước gương)
  const hp = plane ? h : -h * dp / d; // ảnh đảo: hp<0 (thấu kính/gương thật)
  cv.title = { converging_lens: 'Thấu kính hội tụ', diverging_lens: 'Thấu kính phân kì', concave_mirror: 'Gương cầu lõm', convex_mirror: 'Gương cầu lồi', plane_mirror: 'Gương phẳng' }[dev]; cv.desc = cv.title;
  // World: trục x (cm) — thấu kính/gương tại x=0. Vật ở x=-d.
  const imgX = isLens ? dp : (plane ? d : -dp); // mirror: ảnh thật trước gương (x<0)
  const xs = [-d, imgX, Math.abs(f) === Infinity ? 0 : (isLens ? f : -f), isLens ? -f : f]; const xmin = Math.min(...xs.filter(Number.isFinite), -d) * 1.08; const xmax = Math.max(...xs.filter(Number.isFinite), 20) * 1.08;
  const ymaxAbs = Math.max(Math.abs(h), Math.abs(hp)) * 1.5;
  if (Math.abs(imgX) > 8 * d) return null;
  const view = makeView([[Math.min(xmin, -d * 1.1), -ymaxAbs], [Math.max(xmax, d * 0.4), ymaxAbs]], { w: W, h: 400, pad: 50, keepAspect: false });
  const X = (x) => view.X(x); const Y = (y) => view.Y(y);
  // trục chính
  cv.add(K.line(30, Y(0), 530, Y(0), { stroke: COLORS.MUTED, w: 1.4, dash: '8 4' }));
  // thiết bị
  if (isLens) {
    const half = Math.min(Y(0) - 40, ymaxAbs * view.sy * 1.05 + 10); const x0 = X(0);
    cv.add(K.line(x0, Y(0) - half, x0, Y(0) + half, { w: 2.6, stroke: COLORS.BLUE }));
    const tip = 10; const conv = dev === 'converging_lens';
    cv.add(K.path(`M${K.num(x0 - tip)},${K.num(Y(0) - half + (conv ? tip : -tip))} L${K.num(x0)},${K.num(Y(0) - half)} L${K.num(x0 + tip)},${K.num(Y(0) - half + (conv ? tip : -tip))}`, { stroke: COLORS.BLUE, w: 2.4 }));
    cv.add(K.path(`M${K.num(x0 - tip)},${K.num(Y(0) + half - (conv ? tip : -tip))} L${K.num(x0)},${K.num(Y(0) + half)} L${K.num(x0 + tip)},${K.num(Y(0) + half - (conv ? tip : -tip))}`, { stroke: COLORS.BLUE, w: 2.4 }));
  } else {
    const x0 = X(0); const half = Math.min(Y(0) - 40, ymaxAbs * view.sy * 1.05 + 10);
    if (plane) { cv.add(K.line(x0, Y(0) - half, x0, Y(0) + half, { w: 3, stroke: COLORS.BLUE })); for (let y = -half; y < half; y += 12) cv.add(K.line(x0, Y(0) + y, x0 + 9, Y(0) + y + 9, { stroke: COLORS.BLUE, w: 1.3 })); } else {
      const conc = dev === 'concave_mirror'; const bulge = conc ? -14 : 14;
      cv.add(K.path(`M${K.num(x0)},${K.num(Y(0) - half)} Q${K.num(x0 + bulge * 2.2)},${K.num(Y(0))} ${K.num(x0)},${K.num(Y(0) + half)}`, { stroke: COLORS.BLUE, w: 3 }));
    }
  }
  // tiêu điểm
  const marks = [];
  if (!plane && numericF) { const fx = isLens ? f : -f; marks.push([fx, "F'"]); marks.push([-fx, 'F']); if (isMirror) { marks.length = 0; marks.push([-f, 'F']); } }
  if (!plane && !numericF) { const fx = isLens ? f : -f; if (isMirror) marks.push([-f, 'F']); else { marks.push([fx, "F'"]); marks.push([-fx, 'F']); } }
  marks.forEach(([x, name]) => { cv.add(K.circle(X(x), Y(0), 3.2, { fill: COLORS.INK, stroke: COLORS.INK, w: 1 })); cv.add(K.text(X(x), Y(0) + 18, name, { size: 13, bold: true })); });
  cv.add(K.text(X(0), Y(0) + 18, 'O', { size: 13, bold: true }));
  // vật
  const objTop = [X(-d), Y(h)]; const objBase = [X(-d), Y(0)];
  cv.arrow(objBase[0], objBase[1], objTop[0], objTop[1], { stroke: COLORS.GREEN, w: 3 }); cv.add(K.text(objBase[0] - 4, objBase[1] + 18, 'A', { bold: true, size: 14 })); cv.add(K.text(objTop[0] - 4, objTop[1] - 8, 'B', { bold: true, size: 14 }));
  // ảnh
  const imgTop = [X(imgX), Y(hp)]; const imgBase = [X(imgX), Y(0)];
  const virtual = plane || (isLens ? dp < 0 : dp < 0);
  cv.arrow(imgBase[0], imgBase[1], imgTop[0], imgTop[1], { stroke: COLORS.ORANGE, w: 3, dash: virtual ? '6 4' : undefined });
  cv.add(K.text(imgBase[0] - 4, imgBase[1] + (hp < 0 ? -10 : 18), "A'", { bold: true, size: 14, color: COLORS.ORANGE })); cv.add(K.text(imgTop[0] - 4, imgTop[1] + (hp < 0 ? 18 : -8), "B'", { bold: true, size: 14, color: COLORS.ORANGE }));
  // các tia
  const ray = (from, to, dashed, color) => cv.add(K.line(from[0], from[1], to[0], to[1], { stroke: color || COLORS.RED, w: 1.8, dash: dashed ? '6 4' : undefined }));
  const rayColor = COLORS.RED;
  const devPt = (yWorld) => [X(0), Y(yWorld)]; // điểm chạm trên thiết bị (mặt phẳng x=0 — xấp xỉ đủ cho sơ đồ)
  const rays = [];
  rays.push(devPt(h));            // tia song song trục
  rays.push(devPt(0));            // tia qua quang tâm/đỉnh
  if ((isLens && dev === 'converging_lens') || dev === 'concave_mirror') {
    const yF = h + (0 - h) * ((0 - (-d)) / ((isLens ? -f : -f) - (-d))); // tia qua tiêu điểm trước
    if (Number.isFinite(yF) && Math.abs(yF) < ymaxAbs * 1.4) rays.push(devPt(yF));
  }
  rays.forEach((pt, idx) => {
    ray(objTop, pt, false, rayColor);
    const yWorld = view.minY !== undefined ? null : null; void yWorld;
    if (plane) { const refl = K.unit(K.sub(pt, objTop)); const end = [pt[0] - refl[0] * 200, pt[1] + refl[1] * 200]; ray(pt, [Math.max(30, end[0]), end[1]], false, rayColor); ray(pt, imgTop, true, rayColor); return; }
    const dirFromImg = K.unit(K.sub(pt, imgTop)); const L = 240;
    if (!virtual) { const dirTo = K.unit(K.sub(imgTop, pt)); ray(pt, K.add(imgTop, K.mul(dirTo, 46)), false, rayColor); } else { ray(pt, K.add(pt, K.mul(dirFromImg, L)), false, rayColor); ray(pt, imgTop, true, rayColor); }
    void idx;
  });
  const notes = [];
  if (!plane && numericF && numericD) {
    const kk = -dp / d; notes.push(`1/f = 1/d + 1/d' ⇒ d' = ${f1(dp)} cm; k = −d'/d = ${f1(kk)}; ảnh ${dp > 0 ? 'thật' : 'ảo'}, ${kk < 0 ? 'ngược chiều' : 'cùng chiều'}, ${Math.abs(kk) > 1 ? 'lớn hơn' : (Math.abs(kk) < 1 ? 'nhỏ hơn' : 'bằng')} vật`);
  } else if (plane) notes.push("Gương phẳng: ảnh ảo, cùng kích thước, đối xứng với vật qua gương (d' = d)");
  if (notes.length) notesPanel(cv, notes, 380);
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}
function renderRefraction(s, cv) {
  cv.title = 'Khúc xạ ánh sáng'; cv.desc = cv.title;
  const n1 = s.n1 != null ? s.n1 : 1; const n2 = s.n2 != null ? s.n2 : 1.5; const i = s.incidence != null ? s.incidence : 40;
  if (!(i > 0 && i < 90) || !(n1 > 0) || !(n2 > 0)) return null;
  const sinr = n1 * Math.sin(rad(i)) / n2; const tir = sinr > 1;
  const O = [280, 200]; const L = 150;
  cv.add(K.rect(20, 200, 520, 170, { fill: '#e0f2fe', stroke: 'none', w: 0 })); cv.add(K.line(20, 200, 540, 200, { w: 2.4 }));
  cv.add(K.line(280, 40, 280, 370, { stroke: COLORS.MUTED, w: 1.4, dash: '6 4' })); cv.add(K.text(292, 52, 'N', { size: 13, bold: true }));
  const inc = [O[0] - L * Math.sin(rad(i)), O[1] - L * Math.cos(rad(i))];
  cv.arrow(inc[0], inc[1], O[0], O[1], { stroke: COLORS.RED, w: 2.4 });
  if (!tir) { const r = deg(Math.asin(sinr)); const out = [O[0] + L * Math.sin(rad(r)), O[1] + L * Math.cos(rad(r))]; cv.arrow(O[0], O[1], out[0], out[1], { stroke: COLORS.GREEN, w: 2.4 }); cv.add(K.path(K.arcPath(O, [0, 1], K.unit([out[0] - O[0], out[1] - O[1]]), 60), { stroke: COLORS.GREEN, w: 1.6 })); cv.add(K.text(O[0] + 74 * Math.sin(rad(r / 2)), O[1] + 74 * Math.cos(rad(r / 2)) + 4, `r = ${f1(r)}°`, { size: 13, color: COLORS.GREEN, anchor: 'start' })); }
  else { const rf = [O[0] + L * Math.sin(rad(i)), O[1] - L * Math.cos(rad(i))]; cv.arrow(O[0], O[1], rf[0], rf[1], { stroke: COLORS.GREEN, w: 2.4 }); }
  cv.add(K.path(K.arcPath(O, [0, -1], K.unit([inc[0] - O[0], inc[1] - O[1]]), 60), { stroke: COLORS.ORANGE, w: 1.6 }));
  cv.add(K.text(O[0] - 70 * Math.sin(rad(i / 2)) - 4, O[1] - 70 * Math.cos(rad(i / 2)), `i = ${f1(i)}°`, { size: 13, color: COLORS.ORANGE, anchor: 'end' }));
  cv.add(K.text(40, 190, `n₁ = ${f1(n1)}`, { size: 14, anchor: 'start', bold: true })); cv.add(K.text(40, 230, `n₂ = ${f1(n2)}`, { size: 14, anchor: 'start', bold: true }));
  notesPanel(cv, [tir ? `n₁·sin i = ${f1(n1 * Math.sin(rad(i)))} > n₂ ⇒ phản xạ toàn phần (không có tia khúc xạ)` : `n₁·sin i = n₂·sin r ⇒ sin r = ${K.fmt(sinr, 4)} ⇒ r = ${f1(deg(Math.asin(sinr)))}°`], 388);
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

// ---------------------------------------------------------------- Graphs
function niceTicks(max, target = 5) {
  const raw = max / target; const mag = 10 ** Math.floor(Math.log10(raw || 1)); const n = raw / mag; const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  const out = []; for (let v = 0; v <= max + 1e-9; v += step) out.push(v); return { step, ticks: out };
}
function renderGraph(s) {
  const cv = new Canvas(W, H); const type = s.graph;
  const axes = { 'v-t': ['t (s)', 'v (m/s)'], 's-t': ['t (s)', 'x (m)'], 'a-t': ['t (s)', 'a (m/s²)'], 'U-I': ['I (A)', 'U (V)'], 'P-t': ['t (s)', 'P (W)'] }[type];
  cv.title = `Đồ thị ${type}`; cv.desc = cv.title;
  let fn; let xmax; let info = []; let numeric = true;
  if (type === 'v-t') {
    const v0 = s.v0 != null ? s.v0 : (s.v != null && s.a == null ? s.v : 0); const a = s.a != null ? s.a : 0; const T = s.T != null ? s.T : 10;
    if (s.a == null && s.v == null && s.v0 == null) numeric = false;
    fn = (t) => v0 + a * t; xmax = T; info = [`v = v0 + a·t`, s.a != null ? `a = ${f1(a)} m/s²` : ''].filter(Boolean);
    if (!numeric) { fn = (t) => 2 + 0.6 * t; xmax = 10; }
  } else if (type === 's-t') {
    const x0 = s.x0 != null ? s.x0 : 0; const v = s.v != null ? s.v : (s.v0 != null ? s.v0 : null); const a = s.a != null ? s.a : null; const T = s.T != null ? s.T : 10;
    if (v == null && a == null) numeric = false;
    fn = a != null ? (t) => x0 + (v || 0) * t + 0.5 * a * t * t : (t) => x0 + (v ?? 1.2) * t; xmax = T; info = [a != null ? 'x = x0 + v0·t + ½·a·t²' : 'x = x0 + v·t'];
    if (!numeric) { fn = (t) => 1 + 1.2 * t; xmax = 10; }
  } else if (type === 'a-t') {
    const a = s.a != null ? s.a : null; if (a == null) numeric = false; fn = () => (a ?? 2); xmax = s.T != null ? s.T : 10; info = ['a = hằng số'];
  } else if (type === 'U-I') {
    const R = s.R != null ? s.R : null; if (R == null) numeric = false; const Rv = R ?? 10; fn = (I) => Rv * I; xmax = 5; info = ['U = I·R', R != null ? `R = ${f1(R)} Ω (độ dốc của đồ thị)` : ''].filter(Boolean);
  } else {
    const P = s.P != null ? s.P : null; if (P == null) numeric = false; fn = () => (P ?? 40); xmax = s.T != null ? s.T : 10; info = ['P = hằng số'];
  }
  const N = 60; const pts = []; for (let i = 0; i <= N; i++) { const x = xmax * i / N; pts.push([x, fn(x)]); }
  const ymin = Math.min(0, ...pts.map((p) => p[1])); const ymax = Math.max(1e-6, ...pts.map((p) => p[1]));
  const yspan = ymax - ymin || 1;
  const pl = 74; const pr = 520; const pt = 40; const pb = 300;
  const X = (x) => pl + (x / xmax) * (pr - pl); const Y = (y) => pb - ((y - ymin) / (yspan * 1.12)) * (pb - pt);
  // lưới + trục
  const tx = niceTicks(xmax); const ty = niceTicks(ymax > 0 ? ymax * 1.05 : 1);
  if (numeric) {
    tx.ticks.forEach((v) => { cv.add(K.line(X(v), pt, X(v), pb, { stroke: COLORS.GRID, w: 1 })); cv.add(K.text(X(v), pb + 16, K.fmt(v, 2), { size: 11, color: COLORS.MUTED })); });
    ty.ticks.forEach((v) => { cv.add(K.line(pl, Y(v), pr, Y(v), { stroke: COLORS.GRID, w: 1 })); cv.add(K.text(pl - 8, Y(v) + 4, K.fmt(v, 2), { size: 11, color: COLORS.MUTED, anchor: 'end' })); });
  }
  cv.arrow(pl, Y(Math.max(0, ymin)), pr + 14, Y(Math.max(0, ymin)), { stroke: COLORS.INK, w: 1.8 }); cv.arrow(pl, pb, pl, pt - 12, { stroke: COLORS.INK, w: 1.8 });
  cv.add(K.text(pr + 6, Y(Math.max(0, ymin)) + 20, axes[0], { size: 13, italic: true, anchor: 'end' })); cv.add(K.text(pl + 8, pt - 14, axes[1], { size: 13, italic: true, anchor: 'start' }));
  cv.add(K.text(pl - 8, pb + 16, 'O', { size: 13, bold: true }));
  cv.add(K.polyline(pts.map((p) => [X(p[0]), Y(p[1])]), { stroke: COLORS.BLUE, w: 3 }));
  if (numeric && pts[0][1] !== 0) { cv.add(K.circle(X(0), Y(pts[0][1]), 4, { fill: COLORS.RED, stroke: COLORS.RED })); cv.add(K.text(X(0) + 8, Y(pts[0][1]) - 8, K.fmt(pts[0][1], 2), { size: 12, color: COLORS.RED, anchor: 'start' })); }
  if (!numeric) cv.add(K.text(300, 330, 'Đồ thị minh hoạ dạng hàm số (chưa có số liệu cụ thể trong đề)', { size: 12, color: COLORS.MUTED }));
  notesPanel(cv, info, numeric ? 344 : 352);
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function renderPhysics(spec) {
  let r = null;
  switch (spec.kind) {
    case 'forces': r = renderForces(spec); break;
    case 'incline': r = renderIncline(spec); break;
    case 'projectile': r = renderProjectile(spec); break;
    case 'pulley': r = renderPulley(spec); break;
    case 'circuit': r = renderCircuit(spec); break;
    case 'optics': r = renderOptics(spec); break;
    case 'graph': r = renderGraph(spec); break;
    default: throw new Error(`unknown_physics_kind:${spec.kind}`);
  }
  if (!r) { const e = new Error('physics_not_renderable'); e.code = 'physics_not_renderable'; throw e; }
  return r;
}

module.exports = { extractPhysics, renderPhysics, projectileSolve, detectPhysicsKind };
