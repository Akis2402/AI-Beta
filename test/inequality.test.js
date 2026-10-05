'use strict';
// Test bộ vẽ bất phương trình (trục số + miền nghiệm): parser, giải đại số, validate toán học, SVG allowlist.
// Chạy: node test/inequality.test.js

const path = require('path');
const D = path.join(__dirname, '..', 'server', 'utils', 'visual', 'deterministic');
const I = require(path.join(D, 'inequality'));
const K = require(path.join(D, 'svgKit'));

let pass = 0; let fail = 0;
const ok = (c, n, e) => { if (c) { pass += 1; console.log('  PASS', n); } else { fail += 1; console.log('  FAIL', n, e === undefined ? '' : JSON.stringify(e).slice(0, 300)); } };
const T = I._test;
const E = (t) => I.extractInequality(t);

console.log('# parseLinear');
const p = (s) => T.parseLinear(s);
ok(JSON.stringify(p('2x+3')) === '{"x":2,"y":0,"c":3}', '2x+3');
ok(JSON.stringify(p('x/2 - y')) === '{"x":0.5,"y":-1,"c":0}', 'x/2 - y');
ok(JSON.stringify(p('3(x-1)+2y')) === '{"x":3,"y":2,"c":-3}', '3(x-1)+2y');
ok(JSON.stringify(p('-(x+y)')) === '{"x":-1,"y":-1,"c":0}', '-(x+y)');
['xy', 'x*x', '1/x', '0 y', '2x+', 'x/0', 'z+1'].forEach((s) => ok(p(s) === null, `"${s}" -> null (không tuyến tính/sai cú pháp)`));

console.log('# extract: 1 ẩn');
let e = E('Giải bất phương trình 2x - 3 > 5 và biểu diễn tập nghiệm trên trục số');
ok(e && e.kind === 'number_line' && e.variable === 'x' && e.ineqs.length === 1, '2x-3>5', e);
e = E('Biểu diễn trên trục số tập nghiệm của bất phương trình −1 < x ≤ 3');
ok(e && e.kind === 'number_line' && e.ineqs.length === 2, 'chuỗi −1 < x ≤ 3', e);
e = E('Biểu diễn miền nghiệm trên trục số: 3x + 2 <= 5x - 4');
ok(e && e.ineqs[0].A === -2 && e.ineqs[0].C === 6, '3x+2<=5x-4 -> -2x+6<=0', e && e.ineqs);

console.log('# extract: 2 ẩn');
e = E('Biểu diễn miền nghiệm của hệ bất phương trình: x + 2y ≤ 4, x ≥ 0, y ≥ 0');
ok(e && e.kind === 'region' && e.ineqs.length === 3, 'hệ 3 BPT', e && e.ineqs.length);
e = E('Miền nghiệm của hệ bất phương trình x + y <= 5; 2x - y >= 1; x, y >= 0');
ok(e && e.kind === 'region' && e.ineqs.length === 4, '"x, y >= 0" tách thành 2', e && e.ineqs.map((i) => i.label));
e = E('Hệ bất phương trình 0,5x + y ≤ 3 và x ≥ 0 có miền nghiệm; điểm M(1; 1) có thuộc miền không?');
ok(e && e.points.length === 1 && e.points[0].name === 'M' && e.ineqs[0].A === 0.5, 'dấu phẩy thập phân + điểm M(1;1)', e);

console.log('# extract: phải KHÔNG nhận (không vẽ bừa)');
ok(E('Tam giác ABC có AB < 5, AC > 3. Tính diện tích') === null, 'hình học có < > nhưng không có từ khoá');
ok(E('Giải bất phương trình x² - 4 < 0') === null, 'phi tuyến x²');
ok(E('Giải bất phương trình |x| < 3') === null, '|x|');
ok(E('Giải bất phương trình x < 1 hoặc x > 5') === null, 'hợp "hoặc"');
ok(E('Giải bất phương trình x + y = 4 và x ≥ 0') === null, 'có phương trình "="');
ok(E('Giải bất phương trình 2z + 1 > 3') === null, 'ẩn z');
ok(E('Hệ bất phương trình x ≥ 0, xy ≤ 4') === null, 'xy (không vẽ thiếu ràng buộc)');
ok(E('Giải bất phương trình x + y ≠ 3 trong mặt phẳng, hệ bất phương trình x ≥ 0') === null, '≠ 2 ẩn');

console.log('# giải 1 ẩn');
const S = (t) => T.solveInterval(E(t));
let r = S('Bất phương trình −2x + 6 < 0'); ok(r.lo === 3 && !r.loIncl && r.hi === Infinity, '-2x+6<0 -> x>3 (đảo chiều)', r);
r = S('bất phương trình -1 < x ≤ 3 trên trục số'); ok(r.lo === -1 && !r.loIncl && r.hi === 3 && r.hiIncl, '(−1;3]', r);
r = S('bất phương trình x ≥ 2 và x ≤ 2 trên trục số'); ok(r.lo === 2 && r.hi === 2 && r.loIncl && r.hiIncl, 'điểm {2}', r);
r = S('bất phương trình x > 3 và x < 1 trên trục số'); ok(r.empty === true, 'mâu thuẫn -> rỗng', r);
r = S('bất phương trình x > 2 và x ≥ 2 trên trục số'); ok(r.lo === 2 && !r.loIncl, 'chặt thắng không chặt cùng biên', r);
r = S('bất phương trình 0x + 3 < 0 trên trục số'); ok(r.empty === true, '0·x+3<0 sai -> rỗng', r);
r = S('bất phương trình x ≠ 1 và x > 0 trên trục số'); ok(r.excl && r.excl[0] === 1, 'x≠1 trong (0;+∞)', r);
ok(T.intervalNotation(S('bất phương trình x ≠ 1 và x > 0 trên trục số')) === '(0; 1) ∪ (1; +∞)', 'ký hiệu (0;1) ∪ (1;+∞)');
ok(T.intervalNotation(S('bất phương trình -1 < x ≤ 3 trên trục số')) === '(−1; 3]', 'ký hiệu (−1; 3]');

console.log('# render + SVG allowlist');
const render = (t) => { const q = E(t); const err = I.validateInequality(q); if (err) return { err }; return { o: I.renderInequality(q), q }; };
[
  ['trục số x>3', 'bất phương trình 2x - 3 > 3 biểu diễn trên trục số'],
  ['trục số (−1;3]', 'tập nghiệm của bất phương trình -1 < x ≤ 3 trên trục số'],
  ['trục số x≠1', 'bất phương trình x ≠ 1 và x > 0 trên trục số'],
  ['miền tam giác', 'Biểu diễn miền nghiệm của hệ bất phương trình: x + 2y ≤ 4, x ≥ 0, y ≥ 0'],
  ['miền không chặn', 'Biểu diễn miền nghiệm của hệ bất phương trình: x + y ≥ 2; x ≥ 0; y ≥ 0'],
  ['miền biên chặt', 'miền nghiệm của hệ bất phương trình x + y < 4; x > 0; y > 0'],
  ['miền + điểm', 'Hệ bất phương trình x + y <= 5; x - y >= -1; x, y >= 0 điểm A(1; 1), B(4; 4)'],
  ['nửa mặt phẳng', 'Biểu diễn miền nghiệm của bất phương trình 2x - y > 3 trên mặt phẳng tọa độ, nửa mặt phẳng'],
  ['dải 1 ẩn y', 'miền nghiệm của hệ bất phương trình y ≥ 100; y ≤ 105'],
  ['dải 2 ẩn xa gốc', 'miền nghiệm của hệ bất phương trình x ≥ 100; x ≤ 105; y ≥ 0; y ≤ 2']
].forEach(([name, t]) => {
  const x = render(t);
  if (x.err) { ok(false, `${name} (validate)`, x.err); return; }
  const v = K.validateSvg(x.o.svg);
  ok(v.ok, `${name}: SVG hợp lệ allowlist (${v.bytes}B)`, v.errors);
  ok(/<title>/.test(x.o.svg) && /role="img"/.test(x.o.svg) && /aria-label=/.test(x.o.svg), `${name}: có role=img + aria-label + title`);
  if (name === 'miền tam giác') {
    ok(x.o.vertices.length === 3 && x.o.vertices.some((q) => Math.abs(q[0] - 4) < 1e-9 && Math.abs(q[1]) < 1e-9) && x.o.vertices.some((q) => Math.abs(q[0]) < 1e-9 && Math.abs(q[1] - 2) < 1e-9), '3 đỉnh (0;0),(4;0),(0;2)', x.o.vertices);
    ok(x.o.unbounded === false, 'miền bị chặn');
  }
  if (name === 'miền không chặn') ok(x.o.unbounded === true && /không bị chặn/.test(x.o.svg), 'miền không chặn được ghi chú');
  if (name === 'miền biên chặt') ok(/stroke-dasharray/.test(x.o.svg) && /nét đứt/.test(x.o.svg), 'biên chặt -> nét đứt + chú giải');
  if (name === 'miền + điểm') ok(/A\(1; 1\)/.test(x.o.desc) && /thuộc miền/.test(x.o.desc) && /B\(4; 4\) không thuộc/.test(x.o.desc), 'A thuộc, B không thuộc', x.o.desc);
  if (name === 'trục số (−1;3]') ok(/S = \(−1; 3\]/.test(x.o.svg), 'SVG ghi S = (−1; 3]');
  if (name === 'dải 1 ẩn y') ok(/S = \[100; 105\]/.test(x.o.svg) && /biến y/.test(x.o.desc), '1 ẩn y -> trục số theo y', x.o.desc);
  if (name === 'dải 2 ẩn xa gốc') ok(x.o.vertices.length === 4 && x.o.vertices.some((q) => Math.abs(q[0] - 105) < 1e-9 && Math.abs(q[1] - 2) < 1e-9), 'hình chữ nhật xa gốc: 4 đỉnh trong viewport', x.o.vertices);
});

console.log('# mâu thuẫn -> báo, không vẽ');
let c = render('miền nghiệm của hệ bất phương trình x + y ≤ 1; x + y ≥ 3'); ok(c.err && c.err.code === 'inequality_contradiction:empty_region', 'x+y≤1 & x+y≥3', c.err);
c = render('miền nghiệm của hệ bất phương trình x ≥ 0; x ≤ -1; y ≥ 0'); ok(c.err && c.err.code === 'inequality_contradiction:empty_region', 'x≥0 & x≤-1', c.err);
c = render('miền nghiệm của hệ bất phương trình x + y ≥ 2; x + y ≤ 2'); ok(!!c.err, 'chỉ là đoạn thẳng (diện tích 0)', c.err);
c = render('tập nghiệm của bất phương trình x > 3 và x < 1 trên trục số'); ok(c.err && c.err.code === 'inequality_contradiction:empty_solution', 'trục số mâu thuẫn', c.err);

console.log(`\nKẾT QUẢ: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
