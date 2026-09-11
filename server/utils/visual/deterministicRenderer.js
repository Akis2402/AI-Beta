'use strict';

// ============================================================================================
// PHẦN 18 — HÌNH CẦN ĐỘ CHÍNH XÁC PHẢI DÙNG DETERMINISTIC RENDERER, KHÔNG DÙNG IMAGE GENERATION
// ============================================================================================
// Image generation model KHÔNG đảm bảo được: số đúng, công thức đúng, hướng lực đúng, quan hệ hình
// học đúng. Với đồ thị toán, mạch điện, biểu đồ số liệu, hình hình học, vector, flowchart — một
// renderer xác định (SVG dựng từ spec) luôn đúng theo định nghĩa, cache được, test được, và tốn
// 0 token.
//
// Mọi text đi vào SVG PHẢI qua esc() — SVG được nhúng thẳng vào DOM ở client (xem app.js), nên đây
// là ranh giới chống XSS giống hệt renderMarkdownLite.

const W = 720;
const H = 420;
const PAD = 46;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function num(n, d = 2) {
  const v = Number(n);
  return Number.isFinite(v) ? Number(v.toFixed(d)) : 0;
}

function svgShell(inner, { title = '', width = W, height = H } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}">`
    + `<defs><marker id="vz-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
    + `<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>`
    + `<g fill="none" stroke="currentColor" stroke-width="1.6" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="13">`
    + (title ? `<text x="${width / 2}" y="22" text-anchor="middle" font-size="15" font-weight="600" stroke="none" fill="currentColor">${esc(title)}</text>` : '')
    + inner + `</g></svg>`;
}

// ---------- Bộ đánh giá biểu thức AN TOÀN (KHÔNG eval/new Function) ----------
// Chỉ chấp nhận +,-,*,/,^,(,), số và biến x. Parser đệ quy xuống — không có đường nào để chèn code.
function evalExpression(expr, x) {
  let i = 0;
  const s = String(expr).replace(/\s+/g, '');
  function parseExpr() {
    let v = parseTerm();
    while (i < s.length && (s[i] === '+' || s[i] === '-')) {
      const op = s[i++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (i < s.length && (s[i] === '*' || s[i] === '/')) {
      const op = s[i++];
      const r = parseFactor();
      v = op === '*' ? v * r : (r === 0 ? NaN : v / r);
    }
    return v;
  }
  function parseFactor() {
    let v = parseUnary();
    if (i < s.length && s[i] === '^') { i++; v = Math.pow(v, parseFactor()); }
    return v;
  }
  function parseUnary() {
    if (s[i] === '-') { i++; return -parseUnary(); }
    if (s[i] === '+') { i++; return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {
    if (s[i] === '(') {
      i++;
      const v = parseExpr();
      if (s[i] === ')') i++;
      return v;
    }
    if (s[i] === 'x' || s[i] === 'X') {
      i++;
      // Nhân ngầm: "2x", "x(x+1)" -> đã xử lý ở normalizeImplicitMultiplication trước khi vào đây.
      return x;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (i === start) { i++; return NaN; }
    return parseFloat(s.slice(start, i));
  }
  const out = parseExpr();
  return Number.isFinite(out) ? out : NaN;
}

/** "2x^2-3x+1" -> "2*x^2-3*x+1" (chèn dấu nhân ngầm để parser ở trên không phải đoán). */
function normalizeImplicitMultiplication(expr) {
  return String(expr)
    .replace(/\s+/g, '')
    .replace(/(\d)(x|\()/gi, '$1*$2')
    .replace(/(x|\))(\()/gi, '$1*$2')
    .replace(/(\))(x|\d)/gi, '$1*$2');
}

// ============================== mathematical_plot ==============================
function renderPlot(spec) {
  const exprRaw = spec.data && spec.data.plotExpr;
  if (!exprRaw) return null;
  const expr = normalizeImplicitMultiplication(exprRaw);

  const xMin = -6, xMax = 6, steps = 240;
  const pts = [];
  let yMin = Infinity, yMax = -Infinity;
  for (let k = 0; k <= steps; k++) {
    const x = xMin + (xMax - xMin) * (k / steps);
    const y = evalExpression(expr, x);
    if (!Number.isFinite(y) || Math.abs(y) > 1e6) { pts.push(null); continue; }
    pts.push({ x, y });
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const real = pts.filter(Boolean);
  if (real.length < 20) return null;
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
  // Giới hạn tầm nhìn để đồ thị không bị "dẹt" bởi 1 giá trị cực lớn.
  const span = Math.min(yMax - yMin, 40);
  const yc = (yMax + yMin) / 2;
  yMin = yc - span / 2 - span * 0.1;
  yMax = yc + span / 2 + span * 0.1;

  const sx = (x) => PAD + ((x - xMin) / (xMax - xMin)) * (W - 2 * PAD);
  const sy = (y) => (H - PAD) - ((y - yMin) / (yMax - yMin)) * (H - 2 * PAD - 20);

  let grid = '';
  for (let gx = Math.ceil(xMin); gx <= xMax; gx++) {
    grid += `<line x1="${num(sx(gx))}" y1="${PAD + 16}" x2="${num(sx(gx))}" y2="${H - PAD}" stroke-width="0.5" opacity="0.22"/>`;
  }
  const yStep = Math.max(1, Math.round((yMax - yMin) / 8));
  for (let gy = Math.ceil(yMin); gy <= yMax; gy += yStep) {
    grid += `<line x1="${PAD}" y1="${num(sy(gy))}" x2="${W - PAD}" y2="${num(sy(gy))}" stroke-width="0.5" opacity="0.22"/>`;
  }

  const y0 = Math.min(Math.max(sy(0), PAD + 16), H - PAD);
  const x0 = Math.min(Math.max(sx(0), PAD), W - PAD);
  const axes =
    `<line x1="${PAD}" y1="${num(y0)}" x2="${W - PAD}" y2="${num(y0)}" stroke-width="1.4" marker-end="url(#vz-arrow)"/>`
    + `<line x1="${num(x0)}" y1="${H - PAD}" x2="${num(x0)}" y2="${PAD + 16}" stroke-width="1.4" marker-end="url(#vz-arrow)"/>`
    + `<text x="${W - PAD + 6}" y="${num(y0) + 4}" stroke="none" fill="currentColor">x</text>`
    + `<text x="${num(x0) + 6}" y="${PAD + 14}" stroke="none" fill="currentColor">y</text>`;

  let d = '';
  let pen = false;
  pts.forEach((p) => {
    if (!p) { pen = false; return; }
    const X = num(sx(p.x)), Y = num(sy(p.y));
    if (Y < PAD || Y > H - PAD + 2) { pen = false; return; }
    d += (pen ? ' L ' : ' M ') + X + ' ' + Y;
    pen = true;
  });

  const legend = `<text x="${W - PAD}" y="${PAD + 4}" text-anchor="end" stroke="none" fill="currentColor" font-size="13">y = ${esc(exprRaw)}</text>`;
  return svgShell(grid + axes + `<path d="${d}" stroke-width="2.2"/>` + legend, { title: spec.title });
}

// ============================== geometry_diagram ==============================
function renderGeometry(spec) {
  const labels = (spec.labels || []).slice(0, 6);
  if (labels.length < 3) return null;
  const cx = W / 2, cy = H / 2 + 10, R = 140;
  const n = labels.length;
  const verts = labels.map((_, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) * 0.82 };
  });
  const poly = verts.map((v) => `${num(v.x)},${num(v.y)}`).join(' ');
  let inner = `<polygon points="${poly}" stroke-width="2" fill="currentColor" fill-opacity="0.05"/>`;
  verts.forEach((v, k) => {
    inner += `<circle cx="${num(v.x)}" cy="${num(v.y)}" r="3.4" fill="currentColor" stroke="none"/>`;
    const ox = v.x > cx ? 12 : v.x < cx ? -12 : 0;
    const oy = v.y > cy ? 18 : -10;
    inner += `<text x="${num(v.x + ox)}" y="${num(v.y + oy)}" text-anchor="middle" stroke="none" fill="currentColor" font-size="14" font-weight="600">${esc(labels[k])}</text>`;
  });
  if ((spec.relationships || []).includes('midpoint') && verts.length >= 2) {
    const m = { x: (verts[0].x + verts[1].x) / 2, y: (verts[0].y + verts[1].y) / 2 };
    inner += `<circle cx="${num(m.x)}" cy="${num(m.y)}" r="2.8" fill="currentColor" stroke="none"/>`;
  }
  const note = (spec.relationships || []).length
    ? `<text x="${W / 2}" y="${H - 14}" text-anchor="middle" stroke="none" fill="currentColor" font-size="12" opacity="0.75">${esc(spec.relationships.join(' · '))}</text>`
    : '';
  return svgShell(inner + note, { title: spec.title });
}

// ============================== physics_diagram ==============================
function renderPhysics(spec) {
  const qty = spec.objects || [];
  const hasAngle = qty.some((o) => o.unit === '°');
  const angle = hasAngle ? (qty.find((o) => o.unit === '°').value || 45) : 45;
  const isProjectile = /ném|quỹ đạo|projectile/i.test(spec.purpose + ' ' + spec.title);

  if (isProjectile) {
    const x0 = PAD + 20, y0 = H - PAD - 20;
    const L = W - 2 * PAD - 60;
    let d = `M ${x0} ${y0}`;
    for (let k = 1; k <= 60; k++) {
      const t = k / 60;
      const x = x0 + L * t;
      const y = y0 - (4 * (H - 2 * PAD - 60) * t * (1 - t));
      d += ` L ${num(x)} ${num(y)}`;
    }
    const rad = (angle * Math.PI) / 180;
    let inner =
      `<line x1="${PAD}" y1="${y0}" x2="${W - PAD}" y2="${y0}" stroke-width="1.6"/>`
      + `<path d="${d}" stroke-width="2.2" stroke-dasharray="0"/>`
      + `<line x1="${x0}" y1="${y0}" x2="${num(x0 + 70 * Math.cos(rad))}" y2="${num(y0 - 70 * Math.sin(rad))}" stroke-width="2" marker-end="url(#vz-arrow)"/>`
      + `<text x="${num(x0 + 78 * Math.cos(rad))}" y="${num(y0 - 74 * Math.sin(rad))}" stroke="none" fill="currentColor" font-size="13">v₀</text>`
      + `<path d="M ${x0 + 34} ${y0} A 34 34 0 0 0 ${num(x0 + 34 * Math.cos(rad))} ${num(y0 - 34 * Math.sin(rad))}" stroke-width="1.2"/>`
      + `<text x="${x0 + 42}" y="${y0 - 10}" stroke="none" fill="currentColor" font-size="12">${esc(angle)}°</text>`
      + `<circle cx="${x0}" cy="${y0}" r="4" fill="currentColor" stroke="none"/>`;
    inner += quantityLegend(qty);
    return svgShell(inner, { title: spec.title });
  }

  // Mặc định: khối vật + các vector lực.
  const bx = W / 2 - 45, by = H / 2 - 20, bw = 90, bh = 60;
  const cx = bx + bw / 2, cy = by + bh / 2;
  let inner = `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="4" stroke-width="2" fill="currentColor" fill-opacity="0.06"/>`;
  const forces = [
    { dx: 0, dy: 95, name: 'P' },
    { dx: 0, dy: -95, name: 'N' },
    { dx: 110, dy: 0, name: 'F' },
    { dx: -80, dy: 0, name: 'Fms' }
  ];
  forces.forEach((f) => {
    inner += `<line x1="${cx}" y1="${cy}" x2="${num(cx + f.dx)}" y2="${num(cy + f.dy)}" stroke-width="2" marker-end="url(#vz-arrow)"/>`
      + `<text x="${num(cx + f.dx * 1.14)}" y="${num(cy + f.dy * 1.14 + 4)}" text-anchor="middle" stroke="none" fill="currentColor" font-size="13" font-weight="600">${esc(f.name)}</text>`;
  });
  inner += `<line x1="${PAD}" y1="${by + bh}" x2="${W - PAD}" y2="${by + bh}" stroke-width="1.4" opacity="0.6"/>`;
  inner += quantityLegend(qty);
  return svgShell(inner, { title: spec.title });
}

function quantityLegend(qty) {
  if (!qty || !qty.length) return '';
  const items = qty.slice(0, 5).map((o) => `${o.symbol} = ${o.value}${o.unit ? ' ' + o.unit : ''}`);
  return items.map((txt, k) =>
    `<text x="${PAD}" y="${PAD + 4 + k * 18}" stroke="none" fill="currentColor" font-size="12.5" opacity="0.85">${esc(txt)}</text>`
  ).join('');
}

// ============================== circuit_diagram ==============================
function renderCircuit(spec) {
  const resistors = (spec.objects || []).filter((o) => o.unit === 'Ω' || /^R\d*$/i.test(o.symbol)).slice(0, 3);
  const parallel = (spec.relationships || []).includes('parallel_circuit');
  const left = PAD + 30, right = W - PAD - 30, top = 110, bottom = H - 90;
  let inner = `<line x1="${left}" y1="${top}" x2="${right}" y2="${top}" stroke-width="2"/>`
    + `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke-width="2"/>`
    + `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke-width="2"/>`
    + `<line x1="${right}" y1="${top}" x2="${right}" y2="${bottom}" stroke-width="2"/>`
    // nguồn
    + `<line x1="${left - 12}" y1="${(top + bottom) / 2 - 14}" x2="${left + 12}" y2="${(top + bottom) / 2 - 14}" stroke-width="2.6"/>`
    + `<line x1="${left - 7}" y1="${(top + bottom) / 2 + 2}" x2="${left + 7}" y2="${(top + bottom) / 2 + 2}" stroke-width="1.6"/>`
    + `<text x="${left - 22}" y="${(top + bottom) / 2 + 22}" stroke="none" fill="currentColor" font-size="13">U</text>`;

  const list = resistors.length ? resistors : [{ symbol: 'R1', value: '', unit: '' }, { symbol: 'R2', value: '', unit: '' }];
  if (parallel) {
    const midX = (left + right) / 2;
    list.slice(0, 2).forEach((r, k) => {
      const y = top + 60 + k * 70;
      inner += `<line x1="${midX - 90}" y1="${y}" x2="${midX + 90}" y2="${y}" stroke-width="2"/>`
        + `<rect x="${midX - 28}" y="${y - 13}" width="56" height="26" stroke-width="2" fill="none"/>`
        + `<text x="${midX}" y="${y - 20}" text-anchor="middle" stroke="none" fill="currentColor" font-size="12.5">${esc(r.symbol)}${r.value !== '' ? ' = ' + esc(r.value) + ' Ω' : ''}</text>`
        + `<line x1="${midX - 90}" y1="${top}" x2="${midX - 90}" y2="${bottom}" stroke-width="2"/>`
        + `<line x1="${midX + 90}" y1="${top}" x2="${midX + 90}" y2="${bottom}" stroke-width="2"/>`;
    });
  } else {
    const gap = (right - left) / (list.length + 1);
    list.forEach((r, k) => {
      const x = left + gap * (k + 1);
      inner += `<rect x="${num(x - 28)}" y="${top - 13}" width="56" height="26" stroke-width="2" fill="none"/>`
        + `<text x="${num(x)}" y="${top - 22}" text-anchor="middle" stroke="none" fill="currentColor" font-size="12.5">${esc(r.symbol)}${r.value !== '' ? ' = ' + esc(r.value) + ' Ω' : ''}</text>`;
    });
  }
  return svgShell(inner, { title: spec.title });
}

// ============================== flowchart ==============================
function renderFlowchart(spec) {
  const steps = ((spec.data && spec.data.steps) || []).slice(0, 6);
  if (steps.length < 2) return null;
  const boxH = 46, gap = 18;
  const height = 60 + steps.length * (boxH + gap);
  const boxW = W - 2 * PAD - 40;
  let inner = '';
  steps.forEach((s, k) => {
    const y = 50 + k * (boxH + gap);
    inner += `<rect x="${PAD + 20}" y="${y}" width="${boxW}" height="${boxH}" rx="8" stroke-width="1.8" fill="currentColor" fill-opacity="0.05"/>`
      + `<text x="${PAD + 34}" y="${y + boxH / 2 + 5}" stroke="none" fill="currentColor" font-size="13.5">${esc(truncate(s, 62))}</text>`;
    if (k < steps.length - 1) {
      inner += `<line x1="${W / 2}" y1="${y + boxH}" x2="${W / 2}" y2="${y + boxH + gap - 2}" stroke-width="1.8" marker-end="url(#vz-arrow)"/>`;
    }
  });
  return svgShell(inner, { title: spec.title, height });
}

function truncate(s, n) { return String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s); }

// ============================== chart (bar) ==============================
function renderChart(spec) {
  const data = (spec.objects || []).filter((o) => Number.isFinite(o.value)).slice(0, 8);
  if (data.length < 2) return null;
  const max = Math.max(...data.map((d) => Math.abs(d.value))) || 1;
  const bw = (W - 2 * PAD) / data.length;
  let inner = `<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke-width="1.6"/>`;
  data.forEach((d, k) => {
    const h = (Math.abs(d.value) / max) * (H - 2 * PAD - 40);
    const x = PAD + k * bw + bw * 0.18;
    const w = bw * 0.64;
    inner += `<rect x="${num(x)}" y="${num(H - PAD - h)}" width="${num(w)}" height="${num(h)}" stroke-width="1.4" fill="currentColor" fill-opacity="0.22"/>`
      + `<text x="${num(x + w / 2)}" y="${H - PAD + 16}" text-anchor="middle" stroke="none" fill="currentColor" font-size="12">${esc(d.symbol)}</text>`
      + `<text x="${num(x + w / 2)}" y="${num(H - PAD - h - 6)}" text-anchor="middle" stroke="none" fill="currentColor" font-size="11.5">${esc(d.value)}${esc(d.unit || '')}</text>`;
  });
  return svgShell(inner, { title: spec.title });
}

// ============================== concept card (fallback deterministic) ==============================
// Không bịa hình. Chỉ trình bày CÓ CẤU TRÚC những dữ kiện đã được xác thực — luôn đúng, luôn hữu ích
// hơn một hình sai, và không bao giờ fail.
function renderConceptCard(spec) {
  const rows = [];
  if (spec.labels && spec.labels.length) rows.push(['Ký hiệu', spec.labels.join(', ')]);
  (spec.objects || []).slice(0, 6).forEach((o) => rows.push([o.symbol, `${o.value}${o.unit ? ' ' + o.unit : ''}`]));
  (spec.requiredEquations || []).slice(0, 3).forEach((e, i) => rows.push([`Công thức ${i + 1}`, e]));
  ((spec.data && spec.data.parts) || []).slice(0, 6).forEach((p) => rows.push([p.name, p.note || '']));
  ((spec.data && spec.data.regions) || []).slice(0, 6).forEach((r, i) => rows.push([`Vùng ${i + 1}`, r]));
  if (rows.length < 2) {
    ((spec.data && spec.data.steps) || []).slice(0, 6).forEach((st, i) => rows.push([`Bước ${i + 1}`, st]));
  }
  if (!rows.length) return null;
  const height = 72 + rows.length * 34;
  let inner = `<rect x="${PAD - 16}" y="40" width="${W - 2 * PAD + 32}" height="${height - 62}" rx="10" stroke-width="1.6" fill="currentColor" fill-opacity="0.04"/>`;
  rows.forEach((r, k) => {
    const y = 76 + k * 34;
    inner += `<text x="${PAD}" y="${y}" stroke="none" fill="currentColor" font-size="13" font-weight="600">${esc(truncate(r[0], 22))}</text>`
      + `<text x="${PAD + 160}" y="${y}" stroke="none" fill="currentColor" font-size="13">${esc(truncate(r[1], 52))}</text>`
      + `<line x1="${PAD}" y1="${y + 10}" x2="${W - PAD}" y2="${y + 10}" stroke-width="0.6" opacity="0.2"/>`;
  });
  return svgShell(inner, { title: spec.title, height });
}


// ============================== chemistry_structure ==============================
// Dựng mô hình liên kết từ CÔNG THỨC PHÂN TỬ có trong lời giải (không bịa cấu trúc).
// Nguyên tử trung tâm = nguyên tố KHÔNG phải H có số lượng ít nhất; các nguyên tử còn lại xếp đều
// quanh nó. Đây là "mô hình liên kết sơ đồ" — đủ để học sinh thấy thành phần và số liên kết, và
// tuyệt đối không khẳng định hình học phân tử thật (ghi rõ trong chú thích).
function renderChemistry(spec) {
  const mol = spec.data && spec.data.molecule;
  if (!mol || !mol.atoms || mol.atoms.length < 2) return null;
  const heavy = mol.atoms.filter((a) => a.symbol !== 'H');
  const center = (heavy.sort((a, b) => a.count - b.count)[0] || mol.atoms[0]);
  const others = [];
  mol.atoms.forEach((a) => {
    const n = a.symbol === center.symbol ? a.count - 1 : a.count;
    for (let i = 0; i < Math.min(n, 8); i++) others.push(a.symbol);
  });
  if (!others.length) return null;

  const cx = W / 2, cy = H / 2 + 6, R = 120;
  let inner = `<circle cx="${cx}" cy="${cy}" r="26" stroke-width="2" fill="currentColor" fill-opacity="0.08"/>`
    + `<text x="${cx}" y="${cy + 5}" text-anchor="middle" stroke="none" fill="currentColor" font-size="15" font-weight="700">${esc(center.symbol)}</text>`;
  others.slice(0, 8).forEach((sym, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / Math.min(others.length, 8);
    const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a) * 0.8;
    inner += `<line x1="${num(cx + 26 * Math.cos(a))}" y1="${num(cy + 26 * Math.sin(a) * 0.8)}" x2="${num(x - 19 * Math.cos(a))}" y2="${num(y - 19 * Math.sin(a) * 0.8)}" stroke-width="2"/>`
      + `<circle cx="${num(x)}" cy="${num(y)}" r="19" stroke-width="1.8" fill="currentColor" fill-opacity="0.04"/>`
      + `<text x="${num(x)}" y="${num(y + 5)}" text-anchor="middle" stroke="none" fill="currentColor" font-size="13.5" font-weight="600">${esc(sym)}</text>`;
  });
  inner += `<text x="${W / 2}" y="${H - 16}" text-anchor="middle" stroke="none" fill="currentColor" font-size="12" opacity="0.75">`
    + `${esc(mol.formula)} — sơ đồ thành phần và liên kết, không thể hiện hình học không gian thật</text>`;
  return svgShell(inner, { title: spec.title });
}

// ============================== biology_diagram ==============================
// Sơ đồ có chú thích: một hình bao (tế bào/cơ quan) với các thành phần ĐƯỢC NÊU TÊN TRONG LỜI GIẢI,
// mỗi thành phần có đường dẫn tới nhãn. Không vẽ chi tiết giải phẫu (dễ sai) — chỉ thể hiện đúng
// quan hệ "thành phần nằm trong chỉnh thể" và tên/chức năng đã xác thực.
function renderBiology(spec) {
  const parts = ((spec.data && spec.data.parts) || []).slice(0, 6);
  if (parts.length < 2) return null;
  const cx = 250, cy = H / 2 + 6, rx = 165, ry = 132;
  let inner = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" stroke-width="2.2" fill="currentColor" fill-opacity="0.04"/>`;
  parts.forEach((p, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / parts.length;
    const px = cx + (rx * 0.55) * Math.cos(a);
    const py = cy + (ry * 0.55) * Math.sin(a);
    const ly = 66 + k * ((H - 110) / Math.max(1, parts.length - 1 || 1));
    const lx = W - 250;
    inner += `<circle cx="${num(px)}" cy="${num(py)}" r="12" stroke-width="1.8" fill="currentColor" fill-opacity="0.12"/>`
      + `<text x="${num(px)}" y="${num(py + 4)}" text-anchor="middle" stroke="none" fill="currentColor" font-size="11">${k + 1}</text>`
      + `<line x1="${num(px + 12)}" y1="${num(py)}" x2="${num(lx - 8)}" y2="${num(ly - 4)}" stroke-width="1" opacity="0.5"/>`
      + `<text x="${num(lx)}" y="${num(ly)}" stroke="none" fill="currentColor" font-size="12.5" font-weight="600">${k + 1}. ${esc(truncate(p.name, 22))}</text>`;
    if (p.note) {
      inner += `<text x="${num(lx)}" y="${num(ly + 15)}" stroke="none" fill="currentColor" font-size="11" opacity="0.72">${esc(truncate(p.note, 28))}</text>`;
    }
  });
  return svgShell(inner, { title: spec.title });
}

// ============================== map_diagram ==============================
// LƯỢC ĐỒ SƠ ĐỒ HOÁ (không phải bản đồ địa lý thật): các vùng được nêu trong lời giải xếp thành
// lưới có nhãn. Cố ý KHÔNG vẽ đường biên giới/hình dạng lãnh thổ — vẽ sai ranh giới là loại lỗi
// nguy hiểm nhất trong môn Địa, và một renderer xác định không thể biết hình dạng thật.
function renderMap(spec) {
  const regions = ((spec.data && spec.data.regions) || []).slice(0, 6);
  if (regions.length < 2) return null;
  const cols = regions.length <= 4 ? 2 : 3;
  const rows = Math.ceil(regions.length / cols);
  const bw = (W - 2 * PAD - (cols - 1) * 14) / cols;
  const bh = Math.min(86, (H - 100 - (rows - 1) * 14) / rows);
  let inner = '';
  regions.forEach((r, k) => {
    const c = k % cols, rw = Math.floor(k / cols);
    const x = PAD + c * (bw + 14);
    const y = 56 + rw * (bh + 14);
    inner += `<rect x="${num(x)}" y="${num(y)}" width="${num(bw)}" height="${num(bh)}" rx="10" stroke-width="1.8" fill="currentColor" fill-opacity="${0.04 + (k % 3) * 0.035}"/>`
      + `<text x="${num(x + bw / 2)}" y="${num(y + bh / 2 + 5)}" text-anchor="middle" stroke="none" fill="currentColor" font-size="13">${esc(truncate(r, 24))}</text>`;
  });
  inner += `<text x="${W / 2}" y="${H - 14}" text-anchor="middle" stroke="none" fill="currentColor" font-size="11.5" opacity="0.7">`
    + 'Lược đồ sơ đồ hoá — không thể hiện ranh giới/tỉ lệ địa lý thật</text>';
  return svgShell(inner, { title: spec.title });
}

// ============================== apparatus_diagram ==============================
// Bố trí thí nghiệm dạng sơ đồ khối có mũi tên — dựng từ các bước/thiết bị nêu trong lời giải.
function renderApparatus(spec) {
  const items = ((spec.data && spec.data.parts) || []).map((p) => p.name)
    .concat((spec.data && spec.data.steps) || []).slice(0, 4);
  if (items.length < 2) return null;
  const bw = (W - 2 * PAD - (items.length - 1) * 40) / items.length;
  const y = H / 2 - 40;
  let inner = '';
  items.forEach((it, k) => {
    const x = PAD + k * (bw + 40);
    inner += `<rect x="${num(x)}" y="${y}" width="${num(bw)}" height="80" rx="8" stroke-width="1.8" fill="currentColor" fill-opacity="0.05"/>`
      + `<text x="${num(x + bw / 2)}" y="${y + 45}" text-anchor="middle" stroke="none" fill="currentColor" font-size="12.5">${esc(truncate(it, 18))}</text>`;
    if (k < items.length - 1) {
      inner += `<line x1="${num(x + bw + 6)}" y1="${y + 40}" x2="${num(x + bw + 32)}" y2="${y + 40}" stroke-width="1.8" marker-end="url(#vz-arrow)"/>`;
    }
  });
  return svgShell(inner, { title: spec.title });
}

const RENDERERS = {
  mathematical_plot: renderPlot,
  geometry_diagram: renderGeometry,
  geometry_3d: renderGeometry,
  physics_diagram: renderPhysics,
  optics_diagram: renderPhysics,
  circuit_diagram: renderCircuit,
  flowchart: renderFlowchart,
  architecture_diagram: renderFlowchart,
  data_structure_diagram: renderFlowchart,
  network_diagram: renderFlowchart,
  chart: renderChart,
  chemistry_structure: renderChemistry,
  biology_diagram: renderBiology,
  map_diagram: renderMap,
  apparatus_diagram: renderApparatus
};

/**
 * renderDeterministic() — dựng SVG từ spec.
 * @returns {{ok:boolean, format:'svg', content?:string, renderer:string, reason?:string}}
 *   ok=false nghĩa là spec KHÔNG đủ dữ kiện để vẽ CHÍNH XÁC — caller phải fallback (image gen hoặc
 *   bỏ hình). TUYỆT ĐỐI không "vẽ đại" khi thiếu dữ liệu (PHẦN 18: không được để image generator
 *   tự bịa dữ kiện — quy tắc này áp dụng cho cả renderer của chính chúng ta).
 */
// Khi renderer CHÍNH không đủ dữ kiện, thử renderer khác mà dữ liệu SẴN CÓ thực sự hỗ trợ — vẫn
// hoàn toàn deterministic và vẫn chỉ dùng dữ liệu đã trích từ lời giải, không bịa thêm gì.
function alternateRenderers(spec) {
  const d = spec.data || {};
  const alts = [];
  if ((d.regions || []).length >= 2) alts.push('map_diagram');
  if ((d.parts || []).length >= 2) alts.push('biology_diagram');
  if ((d.steps || []).length >= 2) alts.push('flowchart');
  if ((spec.objects || []).filter((o) => Number.isFinite(o.value)).length >= 2) alts.push('chart');
  if ((spec.labels || []).length >= 3) alts.push('geometry_diagram');
  return alts.filter((a) => a !== spec.type);
}

function renderDeterministic(spec) {
  const fn = RENDERERS[spec.type];
  try {
    let svg = fn ? fn(spec) : null;
    if (svg) return { ok: true, format: 'svg', content: svg, renderer: spec.type };
    for (const alt of alternateRenderers(spec)) {
      svg = RENDERERS[alt] ? RENDERERS[alt]({ ...spec, type: alt }) : null;
      if (svg) return { ok: true, format: 'svg', content: svg, renderer: alt };
    }
    const card = renderConceptCard(spec);
    if (card) return { ok: true, format: 'svg', content: card, renderer: 'concept_card' };
    return { ok: false, format: 'svg', renderer: spec.type, reason: 'insufficient_spec_data' };
  } catch (e) {
    return { ok: false, format: 'svg', renderer: spec.type, reason: 'render_error:' + (e && e.message) };
  }
}

module.exports = {
  renderDeterministic, evalExpression, normalizeImplicitMultiplication, esc,
  renderPlot, renderGeometry, renderPhysics, renderCircuit, renderFlowchart, renderChart, renderConceptCard,
  renderChemistry, renderBiology, renderMap, renderApparatus, alternateRenderers
};
