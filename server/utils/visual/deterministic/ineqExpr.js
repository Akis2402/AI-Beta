'use strict';

// ============================================================================================
// BIỂU THỨC ĐA THỨC (bậc ≤ 2) + TRỊ TUYỆT ĐỐI — parser an toàn, KHÔNG dùng eval / new Function
// ============================================================================================
// Hỗ trợ: số, x, y, + - * /, ngoặc, ^2 (và ²), |...|, nhân ngầm ("2x", "3(x+1)", "(x+1)(x-2)", "2|x|").
// Từ chối (trả null): hàm (sin, log...), mũ khác 2, chia cho biểu thức chứa ẩn, tổng bậc > 2, biến khác x/y.
// Cây cú pháp (AST) là dữ liệu thuần JSON -> băm/cache được; `compile` dựng closure để tính số.

const MAX_NODES = 80;

class ParseError extends Error {}

function tokenize(src) {
  const toks = []; let i = 0; let space = false;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { space = true; i += 1; continue; }
    if (/\d/.test(ch)) {
      let j = i; while (j < src.length && /\d/.test(src[j])) j += 1;
      if (src[j] === '.' && /\d/.test(src[j + 1] || '')) { j += 1; while (j < src.length && /\d/.test(src[j])) j += 1; }
      toks.push({ t: 'num', v: Number(src.slice(i, j)), space }); i = j; space = false; continue;
    }
    if (/[xyXY]/.test(ch)) { toks.push({ t: 'var', v: ch.toLowerCase(), space }); i += 1; space = false; continue; }
    if (ch === '²') { toks.push({ t: '^', space }); toks.push({ t: 'num', v: 2, space: false }); i += 1; space = false; continue; }
    if ('+-*/()^|'.includes(ch)) { toks.push({ t: ch, space }); i += 1; space = false; continue; }
    return null;
  }
  return toks;
}

const node = (t, f, deg) => ({ t, ...f, deg });

function parse(src) {
  const toks = tokenize(String(src).trim());
  if (!toks || !toks.length) return null;
  let p = 0; let count = 0; let absDepth = 0;
  const peek = () => toks[p];
  const bump = () => { count += 1; if (count > MAX_NODES) throw new ParseError('too_big'); };
  const chk = (n) => { if (n.deg > 2) throw new ParseError('degree'); return n; };

  function expr() {
    let left = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p].t; p += 1; const right = term(); bump();
      left = chk(node(op === '+' ? 'add' : 'sub', { a: left, b: right }, Math.max(left.deg, right.deg)));
    }
    return left;
  }
  function term() {
    let left = factor();
    for (;;) {
      const nx = peek(); if (!nx) break;
      if (nx.t === '|' && absDepth > 0) break;                         // dấu | đóng của giá trị tuyệt đối
      let op = null;
      if (nx.t === '*' || nx.t === '/') { op = nx.t; p += 1; }
      else if ((nx.t === 'var' || nx.t === '(') && !nx.space) op = 'imp'; // "2x", "3(x+1)", "(x+1)(x-2)"
      else if (nx.t === '|' && absDepth === 0) op = 'imp';              // "2|x|"
      else break;
      const right = op === 'imp' ? power() : factor(); bump();
      if (op === '/') {
        if (right.deg !== 0) throw new ParseError('divide_by_variable');
        const k = evalNode(right, 0, 0);
        if (!Number.isFinite(k) || Math.abs(k) < 1e-12) throw new ParseError('divide_by_zero');
        left = node('divc', { a: left, k: right }, left.deg);
      } else {
        left = chk(node('mul', { a: left, b: right }, left.deg + right.deg));
      }
    }
    return left;
  }
  function factor() {
    const nx = peek(); if (!nx) throw new ParseError('eof');
    if (nx.t === '+') { p += 1; return factor(); }
    if (nx.t === '-') { p += 1; const f = factor(); bump(); return node('neg', { a: f }, f.deg); }
    return power();
  }
  function power() {
    const base = atom();
    if (peek() && peek().t === '^') {
      p += 1; const e = peek();
      if (!e || e.t !== 'num' || (e.v !== 2 && e.v !== 1)) throw new ParseError('exponent');
      p += 1; bump();
      return e.v === 1 ? base : chk(node('sq', { a: base }, base.deg * 2));
    }
    return base;
  }
  function atom() {
    const nx = peek(); if (!nx) throw new ParseError('eof');
    bump();
    if (nx.t === 'num') { p += 1; return node('num', { v: nx.v }, 0); }
    if (nx.t === 'var') { p += 1; return node('var', { n: nx.v }, 1); }
    if (nx.t === '(') {
      p += 1; const saved = absDepth; absDepth = 0;
      const e = expr(); absDepth = saved;
      if (!peek() || peek().t !== ')') throw new ParseError('paren');
      p += 1; return e;
    }
    if (nx.t === '|') {
      p += 1; absDepth += 1;
      const e = expr(); absDepth -= 1;
      if (!peek() || peek().t !== '|') throw new ParseError('abs');
      p += 1; return node('abs', { a: e }, e.deg);
    }
    throw new ParseError('unexpected');
  }

  try {
    const root = expr();
    if (p !== toks.length) return null;
    const vars = new Set(); let hasAbs = false;
    (function walk(n) {
      if (n.t === 'var') vars.add(n.n);
      if (n.t === 'abs') hasAbs = true;
      if (n.a) walk(n.a); if (n.b) walk(n.b); if (n.k) walk(n.k);
    }(root));
    return { node: root, deg: root.deg, vars: [...vars].sort(), hasAbs };
  } catch (e) {
    if (e instanceof ParseError) return null;
    throw e;
  }
}

function evalNode(n, x, y) {
  switch (n.t) {
    case 'num': return n.v;
    case 'var': return n.n === 'x' ? x : y;
    case 'add': return evalNode(n.a, x, y) + evalNode(n.b, x, y);
    case 'sub': return evalNode(n.a, x, y) - evalNode(n.b, x, y);
    case 'mul': return evalNode(n.a, x, y) * evalNode(n.b, x, y);
    case 'divc': return evalNode(n.a, x, y) / evalNode(n.k, 0, 0);
    case 'neg': return -evalNode(n.a, x, y);
    case 'abs': return Math.abs(evalNode(n.a, x, y));
    case 'sq': { const v = evalNode(n.a, x, y); return v * v; }
    default: return NaN;
  }
}

/** Dựng closure tính nhanh (x,y) => số. */
function compile(n) {
  switch (n.t) {
    case 'num': { const v = n.v; return () => v; }
    case 'var': return n.n === 'x' ? (x) => x : (x, y) => y;
    case 'add': { const a = compile(n.a); const b = compile(n.b); return (x, y) => a(x, y) + b(x, y); }
    case 'sub': { const a = compile(n.a); const b = compile(n.b); return (x, y) => a(x, y) - b(x, y); }
    case 'mul': { const a = compile(n.a); const b = compile(n.b); return (x, y) => a(x, y) * b(x, y); }
    case 'divc': { const a = compile(n.a); const k = evalNode(n.k, 0, 0); return (x, y) => a(x, y) / k; }
    case 'neg': { const a = compile(n.a); return (x, y) => -a(x, y); }
    case 'abs': { const a = compile(n.a); return (x, y) => Math.abs(a(x, y)); }
    case 'sq': { const a = compile(n.a); return (x, y) => { const v = a(x, y); return v * v; }; }
    default: return () => NaN;
  }
}

// ---------------- đa thức một biến (hệ số tăng dần: [c0, c1, c2]) ----------------
const trim = (a) => { const r = a.slice(); while (r.length > 1 && Math.abs(r[r.length - 1]) < 1e-12) r.pop(); return r; };
function padd(a, b) { const r = []; for (let i = 0; i < Math.max(a.length, b.length); i += 1) r.push((a[i] || 0) + (b[i] || 0)); return r; }
function pscale(a, k) { return a.map((v) => v * k); }
function pmul(a, b) {
  const r = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) for (let j = 0; j < b.length; j += 1) r[i + j] += a[i] * b[j];
  const t = trim(r); if (t.length > 3) throw new ParseError('degree'); return t;
}

/** Tất cả nút abs (kể cả lồng nhau), theo thứ tự duyệt ổn định. */
function collectAbs(root) {
  const out = [];
  (function walk(n) { if (n.t === 'abs') out.push(n); if (n.a) walk(n.a); if (n.b) walk(n.b); }(root));
  return out;
}

/**
 * Quy một biểu thức MỘT biến `v` về đa thức, với dấu cho từng nút abs (Map abs -> +1/-1).
 * Ném ParseError nếu có biến khác hoặc bậc > 2.
 */
function toPoly(n, v, signs) {
  switch (n.t) {
    case 'num': return [n.v];
    case 'var': if (n.n !== v) throw new ParseError('other_variable'); return [0, 1];
    case 'add': return trim(padd(toPoly(n.a, v, signs), toPoly(n.b, v, signs)));
    case 'sub': return trim(padd(toPoly(n.a, v, signs), pscale(toPoly(n.b, v, signs), -1)));
    case 'mul': return pmul(toPoly(n.a, v, signs), toPoly(n.b, v, signs));
    case 'divc': return trim(pscale(toPoly(n.a, v, signs), 1 / evalNode(n.k, 0, 0)));
    case 'neg': return trim(pscale(toPoly(n.a, v, signs), -1));
    case 'sq': { const a = toPoly(n.a, v, signs); return pmul(a, a); }
    case 'abs': { const s = signs.get(n); if (s === undefined) throw new ParseError('abs_sign'); return trim(pscale(toPoly(n.a, v, signs), s)); }
    default: throw new ParseError('unknown');
  }
}

module.exports = { parse, compile, evalNode, toPoly, collectAbs, ParseError, trim };
