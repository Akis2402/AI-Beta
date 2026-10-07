'use strict';
// Test bộ vẽ bất phương trình: parser an toàn, giải ĐẠI SỐ chính xác (bậc ≤ 2, |..|, "hoặc"), miền thẳng, miền cong (lưới),
// validate toán học, SVG allowlist, a11y, lớp bật/tắt lưới-trục. Chạy: node test/inequality.test.js

const path = require('path');
const D = path.join(__dirname, '..', 'server', 'utils', 'visual', 'deterministic');
const I = require(path.join(D, 'inequality'));
const X = require(path.join(D, 'ineqExpr'));
const K = require(path.join(D, 'svgKit'));

let pass = 0; let fail = 0;
const ok = (c, n, e) => { if (c) { pass += 1; console.log('  PASS', n); } else { fail += 1; console.log('  FAIL', n, e === undefined ? '' : JSON.stringify(e).slice(0, 300)); } };
const E = (t) => I.extractInequality(t);
const NOTE = (t) => { const q = E(t); return q && q.kind === 'number_line' ? I._test.intervalNotation(q.intervals) : (q ? q.kind : null); };

console.log('# parser biểu thức (an toàn, không eval)');
const P = (s) => X.parse(s);
ok(P('x^2-4').deg === 2 && P('x²-4').deg === 2 && P('(x+1)(x-2)').deg === 2, 'bậc 2: ^2, ², tích hai nhị thức');
ok(P('2|x|').hasAbs && P('|x-1|+2').hasAbs, 'trị tuyệt đối và nhân ngầm 2|x|');
['x^3', 'x*x*x', '1/x', 'x/y', 'sin(x)', 'x^y', '|x', 'x||', 'z+1', 'x^2^2', '(x+1)^2*x', 'process.exit()', 'constructor', '__proto__'].forEach((s) => ok(P(s) === null, `"${s}" -> null`));
ok(X.evalNode(P('3(x-1)+2y').node, 2, 5) === 13, '3(x-1)+2y tại (2,5) = 13');
ok(JSON.stringify(P('x^2').node).indexOf('function') === -1, 'AST là dữ liệu thuần JSON');

console.log('# extract: phân loại');
let e = E('Giải bất phương trình 2x - 3 > 5 và biểu diễn tập nghiệm trên trục số');
ok(e && e.kind === 'number_line' && e.variable === 'x' && I._test.intervalNotation(e.intervals) === '(4; +∞)', '2x-3>5 -> (4; +∞)', e);
e = E('Biểu diễn miền nghiệm của hệ bất phương trình: x + 2y ≤ 4, x ≥ 0, y ≥ 0');
ok(e && e.kind === 'region' && e.ineqs.length === 3, 'hệ tuyến tính 2 ẩn -> region (đa giác chính xác)', e && e.kind);
e = E('Miền nghiệm của hệ bất phương trình x + y <= 5; 2x - y >= 1; x, y >= 0');
ok(e && e.kind === 'region' && e.ineqs.length === 4, '"x, y >= 0" tách thành 2', e && e.ineqs && e.ineqs.map((i) => i.label));
e = E('Hệ bất phương trình 0,5x + y ≤ 3 và x ≥ 0 có miền nghiệm; điểm M(1; 1) có thuộc miền không?');
ok(e && e.points.length === 1 && e.points[0].name === 'M' && Math.abs(e.ineqs[0].A - 0.5) < 1e-12, 'dấu phẩy thập phân + điểm M(1;1)', e);
ok(E('miền nghiệm của hệ bất phương trình x² + y² ≤ 9').kind === 'region_curved', 'đường tròn -> region_curved');

console.log('# giải 1 ẩn — chính xác (bậc 2, |..|, hoặc, chuỗi, ≠)');
[
  ['3x + 2 <= 5x - 4', '[3; +∞)'], ['2y - 6 ≤ 0', '(−∞; 3]'], ['x/2 + 1 ≥ 0', '[−2; +∞)'],
  ['x² - 4 < 0', '(−2; 2)'], ['x² - 4 ≥ 0', '(−∞; −2] ∪ [2; +∞)'], ['x^2 - 2x + 1 > 0', '(−∞; 1) ∪ (1; +∞)'], ['x^2 - 2x + 1 ≤ 0', '{1}'],
  ['x^2 + 1 < 0', '∅'], ['x^2 + 1 > 0', 'ℝ'], ['(x-1)(x+2) > 0', '(−∞; −2) ∪ (1; +∞)'], ['3x² ≤ 12', '[−2; 2]'], ['x(x-3) < 0', '(0; 3)'],
  ['x² - 2 ≤ 0', '[−1.414; 1.414]'],
  ['|x| < 3', '(−3; 3)'], ['|x - 1| ≥ 2', '(−∞; −1] ∪ [3; +∞)'], ['|2x - 1| ≤ 5', '[−2; 3]'], ['|x - 1| < 2x + 3', '(−2/3; +∞)'],
  ['|x| > -1', 'ℝ'], ['|x| < -1', '∅'], ['|x² - 1| < 3', '(−2; 2)'], ['|x| + |x - 2| ≤ 4', '[−1; 3]'], ['|x - 2| < 1 và x² > 4', '(2; 3)'],
  ['x < 1 hoặc x > 5', '(−∞; 1) ∪ (5; +∞)'], ['x > 0 hoặc x < 1', 'ℝ'],
  ['-1 < x ≤ 3', '(−1; 3]'], ['x ≥ 1 và x ≤ 1', '{1}'], ['x ≥ 2 và x ≤ 2', '{2}'], ['x > 2 và x ≥ 2', '(2; +∞)'], ['x > 3 và x < 1', '∅'],
  ['0x + 3 < 0', '∅'], ['x ≠ 1 và x > 0', '(0; 1) ∪ (1; +∞)']
].forEach(([t, exp]) => ok(NOTE(`bất phương trình ${t} trên trục số`) === exp, `${t}  =>  ${exp}`, NOTE(`bất phương trình ${t} trên trục số`)));

console.log('# phải null — không vẽ bừa');
[
  'bất phương trình x³ - 8 < 0', 'bất phương trình sin(x) > 0', 'bất phương trình 1/x > 2', 'bất phương trình x^4 < 16', 'bất phương trình √x < 3',
  'bất phương trình 2z + 1 > 3', 'bất phương trình x + y = 4 và x ≥ 0', 'bất phương trình x ≥ 0 hoặc y ≥ 0', 'hệ bất phương trình x ≥ 0 ; log(x) > 1',
  'bất phương trình |x| < 3 và |x ≥ 2', 'bất phương trình x(x+1)(x+2) > 0', 'Giải bất phương trình x + y ≠ 3 trong mặt phẳng, hệ bất phương trình x ≥ 0',
  'miền nghiệm của hệ bất phương trình x² + y² ≠ 4', 'miền nghiệm x² + y² ≤ 9 hoặc x ≥ 5', 'miền nghiệm của hệ bất phương trình x^2*y ≤ 1',
  'Tam giác ABC có AB < 5, AC > 3. Tính diện tích'
].forEach((t) => ok(E(t) === null, `null: ${t}`, E(t) && E(t).kind));
ok(E('miền nghiệm của hệ bất phương trình x² + y² ≤ -1') === null, 'miền cong rỗng => null (KHÔNG kết luận vô nghiệm bằng lưới thô)');

console.log('# render + SVG allowlist + a11y + lớp lưới/trục');
const render = (t) => { const q = E(t); const err = I.validateInequality(q); if (err) return { err }; return { o: I.renderInequality(q), q }; };
[
  ['trục số x>3', 'bất phương trình 2x - 3 > 3 biểu diễn trên trục số'],
  ['trục số (−1;3]', 'tập nghiệm của bất phương trình -1 < x ≤ 3 trên trục số'],
  ['trục số hợp', 'bất phương trình x² - 4 ≥ 0 trên trục số'],
  ['trục số điểm', 'bất phương trình x^2 - 2x + 1 ≤ 0 trên trục số'],
  ['trục số ℝ', 'bất phương trình x^2 + 1 > 0 trên trục số'],
  ['miền tam giác', 'Biểu diễn miền nghiệm của hệ bất phương trình: x + 2y ≤ 4, x ≥ 0, y ≥ 0'],
  ['miền không chặn', 'Biểu diễn miền nghiệm của hệ bất phương trình: x + y ≥ 2; x ≥ 0; y ≥ 0'],
  ['miền biên chặt', 'miền nghiệm của hệ bất phương trình x + y < 4; x > 0; y > 0'],
  ['miền + điểm', 'Hệ bất phương trình x + y <= 5; x - y >= -1; x, y >= 0 điểm A(1; 1), B(4; 4)'],
  ['dải 1 ẩn y', 'miền nghiệm của hệ bất phương trình y ≥ 100; y ≤ 105'],
  ['dải 2 ẩn xa gốc', 'miền nghiệm của hệ bất phương trình x ≥ 100; x ≤ 105; y ≥ 0; y ≤ 2'],
  ['đĩa', 'Biểu diễn miền nghiệm của bất phương trình x² + y² ≤ 9'],
  ['parabol', 'Biểu diễn miền nghiệm của hệ bất phương trình: y ≥ x² - 2x ; y ≤ 3'],
  ['vành khuyên', 'miền nghiệm của hệ bất phương trình x² + y² ≥ 1 ; x² + y² < 9 điểm A(2; 0), B(0; 0)'],
  ['trị tuyệt đối 2 ẩn', 'miền nghiệm của hệ bất phương trình y ≥ |x| ; y ≤ 3'],
  ['hypebol', 'miền nghiệm của hệ bất phương trình x*y ≥ 4 ; x > 0'],
  ['elip', 'miền nghiệm của hệ bất phương trình x²/4 + y² ≤ 1'],
  ['hỗn hợp', 'miền nghiệm của hệ bất phương trình x² + y² ≤ 16 ; x + y ≥ 2 ; x ≥ 0']
].forEach(([name, t]) => {
  const x = render(t);
  if (x.err) { ok(false, `${name} (validate)`, x.err); return; }
  const v = K.validateSvg(x.o.svg);
  ok(v.ok && v.bytes < 85000, `${name}: SVG hợp lệ allowlist (${v.bytes}B)`, v.errors);
  ok(/<title>/.test(x.o.svg) && /role="img"/.test(x.o.svg) && /aria-label=/.test(x.o.svg), `${name}: role=img + aria-label + title`);
  if (x.q.kind !== 'number_line') ok(/id="layer-grid"/.test(x.o.svg) && /id="layer-axes"/.test(x.o.svg), `${name}: có lớp layer-grid + layer-axes để bật/tắt`);
  if (name === 'miền tam giác') ok(x.o.vertices.length === 3 && x.o.unbounded === false, '3 đỉnh, bị chặn');
  if (name === 'miền không chặn') ok(x.o.unbounded === true && /không bị chặn/.test(x.o.svg), 'miền không chặn được ghi chú');
  if (name === 'miền biên chặt') ok(/stroke-dasharray/.test(x.o.svg) && /nét đứt/.test(x.o.svg), 'biên chặt -> nét đứt + chú giải');
  if (name === 'miền + điểm') ok(/A\(1; 1\)/.test(x.o.desc) && /thuộc miền/.test(x.o.desc) && /B\(4; 4\) không thuộc/.test(x.o.desc), 'A thuộc, B không', x.o.desc);
  if (name === 'trục số (−1;3]') ok(/S = \(−1; 3\]/.test(x.o.svg), 'SVG ghi S = (−1; 3]');
  if (name === 'trục số hợp') ok(/S = \(−∞; −2\] /.test(x.o.svg) && /\[2; \+∞\)/.test(x.o.svg) && /<path/.test(x.o.svg), 'tập hợp hai khoảng, ký hiệu ∪ vẽ bằng path');
  if (name === 'dải 1 ẩn y') ok(/S = \[100; 105\]/.test(x.o.svg) && /biến y/.test(x.o.desc), '1 ẩn y -> trục số theo y');
  if (name === 'dải 2 ẩn xa gốc') ok(x.o.vertices.length === 4, 'hình chữ nhật xa gốc: 4 đỉnh trong viewport', x.o.vertices);
  if (name === 'vành khuyên') ok(/A\(2; 0\) thuộc/.test(x.o.desc) && /B\(0; 0\) không thuộc/.test(x.o.desc) && /stroke-dasharray/.test(x.o.svg), 'vành khuyên: A thuộc, tâm không; biên ngoài đứt');
  if (name === 'đĩa') ok(x.o.unbounded === false, 'đĩa bị chặn');
});

console.log('# mâu thuẫn -> báo, không vẽ');
let c = render('miền nghiệm của hệ bất phương trình x + y ≤ 1; x + y ≥ 3'); ok(c.err && c.err.code === 'inequality_contradiction:empty_region', 'x+y≤1 & x+y≥3', c.err);
c = render('miền nghiệm của hệ bất phương trình x ≥ 0; x ≤ -1; y ≥ 0'); ok(c.err && c.err.code === 'inequality_contradiction:empty_region', 'x≥0 & x≤-1', c.err);
c = render('miền nghiệm của hệ bất phương trình x + y ≥ 2; x + y ≤ 2'); ok(!!c.err, 'chỉ là đoạn thẳng (diện tích 0)', c.err);
c = render('tập nghiệm của bất phương trình x > 3 và x < 1 trên trục số'); ok(c.err && c.err.code === 'inequality_contradiction:empty_solution', 'trục số mâu thuẫn', c.err);
c = render('tập nghiệm của bất phương trình x² + 1 < 0 trên trục số'); ok(c.err && c.err.code === 'inequality_contradiction:empty_solution', 'x²+1<0 vô nghiệm', c.err);

console.log(`\nKẾT QUẢ: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
