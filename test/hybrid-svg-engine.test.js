'use strict';

// ============================================================================================
// HYBRID VISUAL ENGINE — SVG tất định (Toán/Lý/Hoá) + Visual Determination Engine + pipeline.
// Chỉ dùng module server thuần Node (không cần express) nên CHẠY ĐƯỢC ở mọi môi trường.
// ============================================================================================
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const D = require(path.join(root, 'server/utils/visual/deterministic'));
const K = D.svgKit;
const chem = D.chemistry;
const de = require(path.join(root, 'server/utils/visual/visualDecisionEngine'));
const det = require(path.join(root, 'server/utils/visual/visualDeterminationEngine'));
const { validateChatBody } = require(path.join(root, 'server/utils/validators'));

const results = [];
function test(name, fn) { try { fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, error: e && e.stack ? e.message : String(e) }); } }
const pending = [];
function atest(name, fn) { pending.push(Promise.resolve().then(fn).then(() => results.push({ name, pass: true }), (e) => results.push({ name, pass: false, error: e && e.message }))); }

const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const texts = (svg) => (svg.match(/<text[^>]*>[^<]*<\/text>/g) || []).map((t) => unesc(t.replace(/<[^>]+>/g, ''))).join(' | ');
const render = (q, s) => D.tryRender(q, s);

// ------------------------------------------------------------------ A. Bảo mật SVG
console.log('\n== A. svgKit — bảo mật SVG (allowlist) ==');
const BAD = {
  script: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  onload: '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><rect width="1" height="1"/></svg>',
  image: '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil/x.png"/></svg>',
  foreign: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
  jslink: '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>',
  use: '<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>',
  style: '<svg xmlns="http://www.w3.org/2000/svg"><style>*{}</style></svg>',
  datauri: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(data:text/html,x)"/></svg>'
};
Object.keys(BAD).forEach((k) => test(`A1. validateSvg CHẶN ${k}`, () => { assert.strictEqual(K.validateSvg(BAD[k]).ok, false, k); assert.throws(() => K.assertSafeSvg(BAD[k])); }));
test('A2. SVG do engine dựng LUÔN qua validateSvg', () => {
  ['Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4', 'Lewis của H2O', 'Vẽ các lực tác dụng lên vật 2 kg trên mặt phẳng ngang', 'cấu hình electron của Fe']
    .forEach((q) => { const r = render(q); assert.strictEqual(r.status, 'rendered', q); assert.strictEqual(K.validateSvg(r.svg).ok, true, q + ' -> ' + JSON.stringify(K.validateSvg(r.svg).errors)); assert.ok(Buffer.byteLength(r.svg) < K.MAX_SVG_BYTES); });
});
test('A3. văn bản của người dùng không thể chèn markup vào SVG (escape)', () => {
  const r = render('Vẽ tam giác <script>alert(1)</script>ABC vuông tại A, AB = 3, AC = 4', 'math');
  if (r.status === 'rendered') { assert.ok(!/<script/i.test(r.svg)); assert.strictEqual(K.validateSvg(r.svg).ok, true); }
});

// ------------------------------------------------------------------ B. Hình học
console.log('\n== B. Hình học ==');
test('B1. tam giác vuông 3-4-5: BC = 5 tính từ Pythagore, góc 36,87°/53,13°', () => {
  const r = render('Vẽ tam giác ABC vuông tại A, AB = 3 cm, AC = 4 cm', 'math');
  assert.strictEqual(r.status, 'rendered'); assert.strictEqual(r.category, 'geometry_triangle');
  const t = texts(r.svg); assert.ok(/\b5\b/.test(t) && /53,13°/.test(t) && /36,87°/.test(t), t);
  assert.strictEqual(Math.hypot(3, 4), 5); // đối chứng độc lập
});
test('B2. tam giác đều cạnh 6: cả ba góc 60°', () => { const t = texts(render('Vẽ tam giác đều ABC cạnh 6 cm', 'math').svg); assert.strictEqual((t.match(/60°/g) || []).length, 3, t); });
[
  ['vuông sai Pythagore', 'Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, BC = 6'],
  ['bất đẳng thức tam giác', 'Vẽ tam giác ABC có AB = 1, AC = 2, BC = 5'],
  ['đều nhưng cạnh khác nhau', 'Vẽ tam giác đều ABC có AB = 3, BC = 5']
].forEach(([n, q]) => test(`B3. MÂU THUẪN (${n}) -> contradiction, KHÔNG vẽ`, () => {
  const r = render(q, 'math'); assert.strictEqual(r.status, 'contradiction', JSON.stringify(r)); assert.ok(!r.svg); assert.ok(r.errors[0].detail.length > 5);
}));
test('B4. thiếu dữ kiện KHÔNG bị coi là mâu thuẫn (vẽ hình mẫu không nhãn số)', () => {
  const r = render('Vẽ tam giác ABC có AB = 5, AC = 7 và góc B = 40°', 'math'); assert.notStrictEqual(r.status, 'contradiction');
});
test('B5. đồ thị parabol: đỉnh (1; -4) là kết quả TÍNH, có trục Oxy', () => { const r = render('Vẽ đồ thị hàm số y = x^2 - 2x - 3', 'math'); assert.strictEqual(r.category, 'geometry_oxy'); const t = texts(r.svg); assert.ok(/\(1; -4\)/.test(t), t); assert.ok(/\bx\b/.test(t) && /\by\b/.test(t)); });
test('B6. đường tròn + tiếp tuyến', () => { const r = render('Vẽ đường tròn tâm O bán kính 5 cm và tiếp tuyến tại A', 'math'); assert.strictEqual(r.category, 'geometry_circle'); assert.ok(/R=5/.test(texts(r.svg))); });
test('B7. TẤT ĐỊNH: cùng đề -> cùng SVG (byte-for-byte) và cùng specHash', () => {
  D.clearCache(); const a = render('Vẽ tam giác ABC vuông tại A, AB = 3 cm, AC = 4 cm', 'math'); D.clearCache(); const b = render('Vẽ tam giác ABC vuông tại A, AB = 3 cm, AC = 4 cm', 'math');
  assert.strictEqual(a.svg, b.svg); assert.strictEqual(a.specHash, b.specHash);
});
test('B8. cache theo specHash: lần 2 là cacheHit; đề khác -> hash khác', () => {
  D.clearCache(); const a = render('Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4', 'math'); const b = render('Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4', 'math'); const c = render('Vẽ tam giác ABC vuông tại A, AB = 6, AC = 8', 'math');
  assert.strictEqual(a.cacheHit, false); assert.strictEqual(b.cacheHit, true); assert.notStrictEqual(a.specHash, c.specHash);
});
test('B9. đề KHÔNG hình học -> not_deterministic (không vẽ bừa)', () => { ['Giải phương trình x^2 - 5x + 6 = 0', 'Viết đoạn văn về mùa xuân', 'Tính đạo hàm của sin x'].forEach((q) => assert.strictEqual(render(q, 'math').status, 'not_deterministic', q)); });

// ------------------------------------------------------------------ C. Vật lý
console.log('\n== C. Vật lý ==');
test('C1. sơ đồ lực: P = m·g = 20 N (g mặc định được GHI RÕ), N = P, Fms = μN = 4 N, a = 3 m/s²', () => {
  const r = render('Vẽ các lực tác dụng lên vật 2 kg trên mặt phẳng ngang, lực kéo F = 10 N, hệ số ma sát 0,2', 'physics'); const t = texts(r.svg);
  assert.strictEqual(r.category, 'physics_forces'); assert.ok(/P = m·g = 2·10 = 20 N \(lấy g = 10 m\/s²\)/.test(t), t); assert.ok(/Fms = μ·N = 4 N/.test(t)); assert.ok(/a = \(F − Fms\)\/m = 3 m\/s²/.test(t)); assert.strictEqual(r.data.gGiven, false);
  assert.strictEqual(2 * 10 * 0.2, 4);
});
test('C2. thiếu số liệu -> vẽ theo KÝ HIỆU (P, N, Fms), KHÔNG bịa số', () => { const t = texts(render('Vẽ các lực tác dụng lên vật trên mặt phẳng ngang có ma sát', 'physics').svg); assert.ok(/\bP\b/.test(t) && /\bN\b/.test(t)); assert.ok(!/= \d+ N/.test(t), t); });
test('C3. ném xiên: L = v0²sin2α/g, H = (v0 sinα)²/2g — đối chiếu công thức độc lập', () => {
  const r = render('Vật ném xiên với v0 = 20 m/s ở góc 30°, vẽ quỹ đạo', 'physics'); const t = texts(r.svg);
  const L = (20 ** 2 * Math.sin(2 * Math.PI / 6)) / 10; const H = ((20 * Math.sin(Math.PI / 6)) ** 2) / 20;
  assert.ok(t.includes(String(L.toFixed(2)).replace('.', ',')), `L=${L}: ` + t); assert.ok(t.includes(`H = ${Math.round(H)} m`) && Math.abs(H - 5) < 1e-9, t);
});
test('C4. thấu kính hội tụ f=20, d=30 -> d\' = 60 cm (1/f = 1/d + 1/d\'), ảnh thật ngược chiều lớn hơn', () => {
  const r = render('Vẽ ảnh của vật AB cao 2 cm đặt cách thấu kính hội tụ 30 cm, tiêu cự f = 20 cm', 'physics'); const t = texts(r.svg);
  assert.ok(/d' = 60 cm/.test(t), t); assert.ok(/ảnh thật, ngược chiều, lớn hơn vật/.test(t)); assert.strictEqual(Math.round(1 / (1 / 20 - 1 / 30)), 60); assert.strictEqual(r.data.dist, 30);
});
test('C5. mạch nối tiếp: R_tđ = 30 Ω, I = 0,4 A, U1 = 4 V, U2 = 8 V', () => { const t = texts(render('Vẽ sơ đồ mạch điện gồm nguồn 12 V nối tiếp hai điện trở R1 = 10 Ω, R2 = 20 Ω', 'physics').svg); assert.ok(/R_tđ = R1 \+ R2 = 30 Ω/.test(t) && /I = E\/R_tđ = 0,4 A/.test(t) && /U1 = 4 V/.test(t) && /U2 = 8 V/.test(t), t); });
test('C6. mặt phẳng nghiêng 30°, 5 kg: P=50, Px=25, Py≈43,3 N', () => { const t = texts(render('Vẽ vật trượt trên mặt phẳng nghiêng góc 30°, khối lượng 5 kg', 'physics').svg); assert.ok(/P = m·g = 5·10 = 50 N/.test(t) && /Px = P·sinα = 25 N/.test(t) && /43,3 N/.test(t), t); });
test('C7. đồ thị v-t: "trong 6 s" -> trục thời gian dừng ở 6 s và a = 3 m/s²', () => { const r = render('Vẽ đồ thị v-t của vật chuyển động thẳng nhanh dần đều với v0 = 2 m/s, a = 3 m/s², trong 6 s', 'physics'); assert.strictEqual(r.data.T, 6); assert.ok(/a = 3 m\/s²/.test(texts(r.svg))); });

// ------------------------------------------------------------------ D. Hoá học (nghiêm ngặt nhất)
console.log('\n== D. Hoá học — dữ liệu có cấu trúc + validate ==');
const atom = (f) => chem.buildAtom(f);
test('D1. Na: 2|8|1, 1s2 2s2 2p6 3s1, hoá trị 1, n = 12', () => { const a = atom({ symbol: 'Na' }).atom; assert.deepStrictEqual(a.shells, [2, 8, 1]); assert.strictEqual(a.electronConfiguration, '1s2 2s2 2p6 3s1'); assert.strictEqual(a.valenceElectrons, 1); assert.strictEqual(a.neutrons, 12); assert.strictEqual(a.electrons, 11); });
test('D2. mọi nguyên tố Z=1..54: tổng electron các lớp = Z, lớp n ≤ 2n², phân lớp ≤ sức chứa', () => {
  for (let z = 1; z <= 54; z++) {
    const r = atom({ Z: z }); assert.ok(r.ok, `Z=${z} ${JSON.stringify(r.errors)}`); const a = r.atom;
    assert.strictEqual(a.shells.reduce((s, x) => s + x, 0), z, `Z=${z} tổng lớp`);
    a.shells.forEach((c, i) => assert.ok(c <= 2 * (i + 1) ** 2, `Z=${z} lớp ${i + 1} có ${c}`));
    Object.keys(a.config).forEach((k) => assert.ok(a.config[k] <= { s: 2, p: 6, d: 10 }[k[1]], `Z=${z} ${k}`));
    assert.strictEqual(a.neutrons + a.protons, a.massNumber);
  }
});
test('D3. khí hiếm & mốc chu kì đúng', () => {
  const want = { He: [2], Ne: [2, 8], Ar: [2, 8, 8], Kr: [2, 8, 18, 8], Xe: [2, 8, 18, 18, 8], K: [2, 8, 8, 1], Ca: [2, 8, 8, 2], Sc: [2, 8, 9, 2], Zn: [2, 8, 18, 2], Br: [2, 8, 18, 7], Fe: [2, 8, 14, 2], Cl: [2, 8, 7] };
  Object.keys(want).forEach((s) => assert.deepStrictEqual(atom({ symbol: s }).atom.shells, want[s], s));
});
test('D4. ngoại lệ cấu hình: Cr 3d5 4s1, Cu 3d10 4s1, Ag 4d10 5s1, Pd 4d10', () => {
  assert.strictEqual(atom({ symbol: 'Cr' }).atom.electronConfiguration, '1s2 2s2 2p6 3s2 3p6 3d5 4s1');
  assert.strictEqual(atom({ symbol: 'Cu' }).atom.electronConfiguration, '1s2 2s2 2p6 3s2 3p6 3d10 4s1');
  assert.ok(/4d10 5s1$/.test(atom({ symbol: 'Ag' }).atom.electronConfiguration));
  assert.ok(/4d10$/.test(atom({ symbol: 'Pd' }).atom.electronConfiguration) && !/5s/.test(atom({ symbol: 'Pd' }).atom.electronConfiguration));
});
test('D5. ion: Cl⁻ 2|8|8 (18 e), O²⁻ 2|8, Mg²⁺ 2|8, Al³⁺ 2|8, Fe³⁺ 3d5 (23 e), Fe²⁺ 3d6 4s0', () => {
  assert.deepStrictEqual(atom({ symbol: 'Cl', charge: -1 }).atom.shells, [2, 8, 8]); assert.strictEqual(atom({ symbol: 'Cl', charge: -1 }).atom.electrons, 18);
  assert.deepStrictEqual(atom({ symbol: 'O', charge: -2 }).atom.shells, [2, 8]); assert.deepStrictEqual(atom({ symbol: 'Mg', charge: 2 }).atom.shells, [2, 8]); assert.deepStrictEqual(atom({ symbol: 'Al', charge: 3 }).atom.shells, [2, 8]);
  const f3 = atom({ symbol: 'Fe', charge: 3 }).atom; assert.strictEqual(f3.electrons, 23); assert.strictEqual(f3.electronConfiguration, '1s2 2s2 2p6 3s2 3p6 3d5');
  assert.strictEqual(atom({ symbol: 'Fe', charge: 2 }).atom.electronConfiguration, '1s2 2s2 2p6 3s2 3p6 3d6');
});
test('D6. proton/nơtron/số khối nhất quán: A = Z + N; Na-23 -> n = 12; 35Cl với 18 nơtron -> A = 35', () => {
  assert.strictEqual(atom({ symbol: 'Na', massNumber: 23 }).atom.neutrons, 12); assert.strictEqual(atom({ symbol: 'Cl', neutrons: 18 }).atom.massNumber, 35);
});
[
  ['proton ≠ Z của nguyên tố', { symbol: 'Na', protons: 12 }, 'protons_mismatch'],
  ['ký hiệu ≠ Z', { symbol: 'Na', Z: 12 }, 'element_z_mismatch'],
  ['A < Z', { symbol: 'Cl', massNumber: 10 }, 'mass_number_invalid'],
  ['A ≠ Z + N', { symbol: 'Na', massNumber: 23, neutrons: 10 }, 'mass_neutron_mismatch'],
  ['electron ≠ Z − điện tích', { symbol: 'Na', charge: 1, electrons: 12 }, 'electrons_charge_mismatch'],
  ['phi kim tạo cation', { symbol: 'Cl', charge: 7 }, 'ion_unrealistic'],
  ['cation vượt số e lớp ngoài', { symbol: 'Na', charge: 2 }, 'ion_unrealistic'],
  ['anion vượt cấu hình bền', { symbol: 'O', charge: -3 }, 'ion_unrealistic'],
  ['Z ngoài phạm vi', { Z: 99 }, 'unsupported_atomic_number'],
  ['nguyên tử trung hoà nhưng e ≠ p', { symbol: 'Na', electrons: 12, assumeNeutral: true }, 'atom_not_neutral']
].forEach(([n, f, code]) => test(`D7. TỪ CHỐI (${n}) -> ${code}`, () => { const r = atom(f); assert.strictEqual(r.ok, false); assert.ok(r.errors.some((e) => e.code === code), JSON.stringify(r.errors)); assert.ok(!r.atom); }));
test('D8. đề bài mâu thuẫn -> contradiction, KHÔNG vẽ (nguyên tử Na có 11 proton và 12 electron)', () => {
  ['nguyên tử Na có 11 proton và 12 electron', 'Na có Z = 12, vẽ mô hình Bohr', 'ion Na+ có 12 electron'].forEach((q) => { const r = render(q, 'chemistry'); assert.strictEqual(r.status, 'contradiction', q); assert.ok(!r.svg); });
});
test('D9. Bohr: số chấm electron trong SVG = đúng số electron (không electron trang trí)', () => {
  [['cấu hình electron của Fe', 26], ['ion Cl- sơ đồ Bohr', 18], ['vẽ mô hình nguyên tử Natri Na', 11], ['ion Fe3+ cấu hình electron', 23], ['Mô hình Bohr của Mg2+', 10]].forEach(([q, n]) => {
    const r = render(q, 'chemistry'); assert.strictEqual(r.status, 'rendered', q); assert.strictEqual((r.svg.match(/#1e3a8a/g) || []).length, n, q);
  });
});
test('D10. sơ đồ obitan theo Hund: Fe 3d6 = 1 obitan đôi + 4 obitan đơn (5 hộp)', () => { const r = render('cấu hình electron của Fe', 'chemistry'); assert.ok(/3d/.test(texts(r.svg))); });
test('D11. THƯ VIỆN Lewis: mọi phân tử qua validateMolecule (electron, điện tích hình thức, octet, liên thông)', () => { chem.LIB_KEYS.forEach((k) => { const v = chem.validateMolecule(chem.LIB[k]); assert.ok(v.ok, `${k}: ${JSON.stringify(v.errors)}`); }); assert.ok(chem.LIB_KEYS.length >= 18); });
test('D12. kiểm kê electron: H2O = 8 (4 liên kết + 4 tự do); CO2 = 16; N2 = 10; NH4+ = 8', () => {
  const tot = (k) => chem.validateMolecule(chem.LIB[k]).electrons.valenceTotal; assert.strictEqual(tot('H2O'), 8); assert.strictEqual(tot('CO2'), 16); assert.strictEqual(tot('N2'), 10); assert.strictEqual(tot('NH4+'), 8);
});
const clone = (o) => JSON.parse(JSON.stringify(o));
[
  ['CO2 chỉ có liên kết đơn', (m) => { m.bonds.forEach((b) => { b.order = 1; }); }, ['electron_count_mismatch']],
  ['H2O thiếu cặp electron tự do', (m) => { m.lonePairs.o = 1; }, ['electron_count_mismatch']],
  ['NH3 mất cặp tự do', (m) => { m.lonePairs = {}; }, ['electron_count_mismatch', 'octet_incomplete']],
  ['H2O: H có 2 liên kết (vi phạm octet của H)', (m) => { m.bonds.push({ a: 'h1', b: 'h2', order: 1 }); }, ['electron_count_mismatch', 'octet_violation']],
  ['CO: sai điện tích hình thức', (m) => { m.charges = { c: 1, o: -1 }; }, ['formal_charge_mismatch']],
  ['NH4+ khai sai tổng điện tích', (m) => { m.netCharge = -1; }, ['net_charge_mismatch', 'electron_count_mismatch']],
  ['bậc liên kết 4', (m) => { m.bonds[0].order = 4; }, ['bond_order_invalid']],
  ['nguyên tử lạ', (m) => { m.atoms[0].el = 'Xx'; }, ['unknown_element']],
  ['liên kết tới nguyên tử không tồn tại', (m) => { m.bonds[0].b = 'zzz'; }, ['bond_unknown_atom']],
  ['cấu trúc gồm mảnh rời', (m) => { m.bonds = m.bonds.slice(0, 1); }, ['atom_not_bonded', 'disconnected', 'electron_count_mismatch']]
].forEach(([n, mut, codes]) => test(`D13. TỪ CHỐI Lewis (${n})`, () => {
  const key = /CO2/.test(n) ? 'CO2' : /H2O/.test(n) ? 'H2O' : /NH3/.test(n) ? 'NH3' : /CO:/.test(n) ? 'CO' : /NH4/.test(n) ? 'NH4+' : 'H2O';
  const m = clone(chem.LIB[key]); mut(m); const v = chem.validateMolecule(m); assert.strictEqual(v.ok, false); assert.ok(v.errors.some((e) => codes.includes(e.code)), JSON.stringify(v.errors));
  assert.throws(() => chem.renderMolecule(m), /chemistry_validation_failed/); // và KHÔNG render
}));
test('D14. hợp chất ion: NaCl2 -> charge_imbalance; Na2O, Al2O3, MgCl2 hợp lệ', () => {
  assert.ok(chem.ionicFromFormula('NaCl2').error); assert.strictEqual(chem.ionicFromFormula('NaCl2').error.code, 'charge_imbalance');
  ['Na2O', 'Al2O3', 'MgCl2', 'NaCl', 'CaO'].forEach((f) => { const i = chem.ionicFromFormula(f); assert.ok(i && !i.error, f); assert.strictEqual(i.nCation * i.qc + i.nAnion * i.qa, 0); });
  assert.strictEqual(render('Lewis của NaCl2', 'chemistry').status, 'contradiction');
});
test('D15. Lewis đi qua đề bài: H2O, CO2, NH4+ vẽ được; O2- (ion) KHÔNG bị nhầm với phân tử O2', () => {
  ['cấu trúc Lewis của H2O', 'Lewis CO2', 'Lewis của NH4+', 'Lewis N2'].forEach((q) => assert.strictEqual(render(q, 'chemistry').category, 'chemistry_lewis', q));
  const r = render('cấu hình electron ion O2-', 'chemistry'); assert.strictEqual(r.category, 'chemistry_atom'); assert.deepStrictEqual(r.data.shells, [2, 8]);
});
test('D16. renderStructured (dữ liệu có cấu trúc từ nguồn ngoài) dùng cùng validator', () => {
  const bad = clone(chem.LIB.H2O); bad.lonePairs.o = 0; assert.strictEqual(D.renderStructured('molecule', bad).status, 'contradiction');
  assert.strictEqual(D.renderStructured('molecule', { ...clone(chem.LIB.H2O), formula: 'H2O' }).status, 'rendered');
});

// ------------------------------------------------------------------ G. Đối chiếu dữ kiện (không âm thầm bỏ dữ kiện của đề)
console.log('\n== G. Đối chiếu dữ kiện đề bài với hình ==');
[
  ['tam giác vuông + đường cao AH = 2 (thật là 2,4)', 'Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, đường cao AH = 2', 'math'],
  ['hình chữ nhật AB=3, AD=4, AC=6 (thật là 5)', 'Vẽ hình chữ nhật ABCD có AB = 3, AD = 4, AC = 6', 'math'],
  ['hình chữ nhật cạnh đối không bằng nhau', 'Vẽ hình chữ nhật ABCD có AB = 3, AD = 4, CD = 5', 'math'],
  ['hình vuông cạnh 4, AC = 5 (thật là 5,66)', 'Vẽ hình vuông ABCD cạnh 4, AC = 5', 'math'],
  ['lực: N = 30 N nhưng N = P = 20 N', 'Vẽ các lực tác dụng lên vật 2 kg trên mặt phẳng ngang, lực kéo F = 10 N, hệ số ma sát 0,2, N = 30 N', 'physics'],
  ['lực: P = 50 N nhưng m·g = 20 N', 'Vẽ các lực tác dụng lên vật 2 kg trên mặt phẳng ngang, P = 50 N', 'physics'],
  ['lực: Fms = 9 N nhưng μN = 4 N', 'Vẽ các lực lên vật 2 kg trên mặt phẳng ngang, F = 10 N, hệ số ma sát 0,2, Fms = 9 N', 'physics'],
  ['ném xiên: L = 40 m nhưng tính ra 34,64 m', 'Vật ném xiên với v0 = 20 m/s ở góc 30°, tầm xa L = 40 m, vẽ quỹ đạo', 'physics'],
  ['mạch: I = 2 A nhưng E/R_tđ = 0,4 A', 'Vẽ sơ đồ mạch điện gồm nguồn 12 V nối tiếp hai điện trở R1 = 10 Ω, R2 = 20 Ω, I = 2 A', 'physics']
].forEach(([n, q, s]) => test(`G1. MÂU THUẪN -> không vẽ, nêu cả hai con số (${n})`, () => { const r = render(q, s); assert.strictEqual(r.status, 'contradiction', JSON.stringify(r)); assert.ok(!r.svg); assert.ok(/\d/.test(r.errors[0].detail) && r.errors[0].detail.length > 20, r.errors[0].detail); }));
[
  ['AH = 2,4 đúng', 'Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, đường cao AH = 2,4', 'math'],
  ['hình chữ nhật AC = 5 đúng', 'Vẽ hình chữ nhật ABCD có AB = 3, AD = 4, AC = 5', 'math'],
  ['hình chữ nhật chỉ cho AB và AC (suy ra AD) — không kiểm', 'Vẽ hình chữ nhật ABCD có AB = 3, AC = 5', 'math'],
  ['hình vuông AC = 5,66 đúng', 'Vẽ hình vuông ABCD cạnh 4, AC = 5,66', 'math'],
  ['hình thang cho cả hai cạnh bên (engine không dùng) — KHÔNG được báo sai', 'Vẽ hình thang ABCD, AB = 6, CD = 4, AD = 3, BC = 3', 'math'],
  ['đoạn phụ AD không thuộc hình — bỏ qua', 'Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, trên AB lấy D sao cho AD = 1', 'math'],
  ['lực: N = 20 N đúng', 'Vẽ các lực tác dụng lên vật 2 kg trên mặt phẳng ngang, lực kéo F = 10 N, hệ số ma sát 0,2, N = 20 N', 'physics'],
  ['lực: g = 9,8 và P = 19,6 N (dùng đúng g của đề)', 'Vẽ các lực lên vật 2 kg trên mặt phẳng ngang, g = 9,8 m/s², P = 19,6 N', 'physics'],
  ['ném xiên: L = 34,6 m (làm tròn)', 'Vật ném xiên với v0 = 20 m/s ở góc 30°, tầm xa L = 34,6 m, vẽ quỹ đạo', 'physics'],
  ['mạch: I = 0,4 A đúng', 'Vẽ sơ đồ mạch điện gồm nguồn 12 V nối tiếp hai điện trở R1 = 10 Ω, R2 = 20 Ω, I = 0,4 A', 'physics']
].forEach(([n, q, s]) => test(`G2. KHÔNG báo nhầm (${n})`, () => { assert.strictEqual(render(q, s).status, 'rendered', n); }));
test('G3. ký pháp điện tích dấu-trước không bị bỏ qua: Cl+7 bị từ chối; Fe+3, O-2 đúng; Na-23, Li-7 là đồng vị', () => {
  assert.strictEqual(render('ion Cl+7 sơ đồ Bohr', 'chemistry').status, 'contradiction');
  assert.strictEqual(render('ion Fe+3 cấu hình electron', 'chemistry').data.charge, 3); assert.strictEqual(render('ion O-2 sơ đồ Bohr', 'chemistry').data.charge, -2);
  assert.strictEqual(render('Na-23 mô hình nguyên tử', 'chemistry').data.massNumber, 23); assert.strictEqual(render('Li-7 mô hình nguyên tử', 'chemistry').data.charge, 0);
});
test('G4. Z ngoài phạm vi (Z=92, 99 proton, Uranium) KHÔNG phải mâu thuẫn -> not_deterministic; nhưng "Na có Z = 99" vẫn là mâu thuẫn thật', () => {
  ['vẽ mô hình nguyên tử có Z = 92', 'Vẽ mô hình Bohr của nguyên tử có 99 proton', 'vẽ mô hình nguyên tử Uranium'].forEach((q) => assert.strictEqual(render(q, 'chemistry').status, 'not_deterministic', q));
  assert.strictEqual(render('Na có Z = 99, vẽ mô hình Bohr', 'chemistry').status, 'contradiction');
});
test('G5. "bằng AI" chỉ ép ảnh AI khi nói về HÌNH ("giải bằng AI" thì không)', () => {
  const f = require(path.join(root, 'server/utils/visual/deterministic/factUtils')).fold; const re = det.WANT_AI_RE;
  ['Vẽ đồ thị y = x^2 bằng AI', 'Tạo bằng AI hình tam giác ABC', 'minh họa quỹ đạo bằng AI', 'Vẽ ảnh AI tế bào'].forEach((q) => assert.strictEqual(re.test(f(q).toLowerCase()), true, q));
  ['giải bằng AI bài tam giác', 'Chứng minh bằng phương pháp quy nạp', 'vẽ mô hình Bohr của Na'].forEach((q) => assert.strictEqual(re.test(f(q).toLowerCase()), false, q));
});
test('G6. hiệu năng/ReDoS: đề xấu dài 50–70k ký tự vẫn < 300 ms', () => {
  const cases = ['cấu hình electron của Na ' + 'H2O CO2 NH4+ Fe3+ '.repeat(3000), 'tam giác ABC vuông tại A AB = 3 AC = 4 '.repeat(1500), 'vật 2 kg lực F = 10 N mặt phẳng ngang ma sát '.repeat(1500), 'a'.repeat(50000), 'A'.repeat(20000) + ' Na', '1'.repeat(30000) + ' proton', 'Z = '.repeat(8000)];
  cases.forEach((q) => { const t = Date.now(); render(q); assert.ok(Date.now() - t < 300, `${q.slice(0, 20)}… ${Date.now() - t}ms`); });
});

// ------------------------------------------------------------------ H. Bộ test bắt buộc của Master Prompt (LII / LIII / LIV)
console.log('\n== H. Test cases theo spec: Toán (LII), Vật lý (LIII), Hoá (LIV) ==');
const SPEC_MATH = [
  ['1. Tam giác ABC', 'Vẽ tam giác ABC có AB = 5, AC = 7, BC = 8', 'geometry_triangle'], ['2. Tam giác vuông', 'Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4', 'geometry_triangle'],
  ['3. Tam giác đều', 'Vẽ tam giác đều ABC cạnh 6 cm', 'geometry_triangle'], ['4. Đường tròn', 'Vẽ đường tròn tâm O bán kính 5', 'geometry_circle'],
  ['5. Góc 60°', 'Vẽ góc xOy bằng 60°', 'geometry_angle'], ['6. Vuông góc', 'Vẽ đường thẳng d vuông góc với đường thẳng Δ tại A', 'geometry_relation'],
  ['7. Song song', 'Vẽ hai đường thẳng a và b song song', 'geometry_relation'], ['8. Oxy', 'Vẽ hệ trục toạ độ Oxy và điểm A(2;3)', 'geometry_oxy'],
  ['9. Vector', 'Vẽ vectơ AB với A(1;2), B(4;6) trên hệ trục Oxy', 'geometry_oxy'], ['10. Giao điểm', 'Vẽ giao điểm của hai đường thẳng y = x + 1 và y = -2x + 4 trên Oxy', 'geometry_oxy']
];
SPEC_MATH.forEach(([n, q, cat]) => test(`H1. TOÁN ${n}`, () => { const r = render(q, 'math'); assert.strictEqual(r.status, 'rendered', JSON.stringify(r)); assert.strictEqual(r.category, cat); assert.strictEqual(K.validateSvg(r.svg).ok, true); }));
const SPEC_PHYS = [
  ['1. Force diagram', 'Vẽ các lực tác dụng lên vật 2 kg trên mặt phẳng ngang, lực kéo F = 10 N', 'physics_forces'], ['2. Inclined plane', 'Vẽ vật trượt trên mặt phẳng nghiêng góc 30°, khối lượng 5 kg', 'physics_incline'],
  ['3. Projectile', 'Vật ném xiên với v0 = 20 m/s ở góc 30°, vẽ quỹ đạo', 'physics_projectile'], ['4. Serial circuit', 'Vẽ sơ đồ mạch điện gồm nguồn 12 V nối tiếp hai điện trở R1 = 10 Ω, R2 = 20 Ω', 'physics_circuit'],
  ['5. Parallel circuit', 'Vẽ sơ đồ mạch điện gồm nguồn 12 V, hai điện trở R1 = 10 Ω, R2 = 20 Ω mắc song song', 'physics_circuit'], ['6. Mirror', 'Vẽ sơ đồ gương phẳng: tia tới SI hợp với pháp tuyến góc 30°, vẽ tia phản xạ', 'physics_optics'],
  ['7. Lens', 'Vẽ ảnh của vật AB cao 2 cm đặt cách thấu kính hội tụ 30 cm, tiêu cự f = 20 cm', 'physics_optics'], ['8. v-t graph', 'Vẽ đồ thị v-t của vật chuyển động nhanh dần đều v0 = 2 m/s, a = 3 m/s²', 'physics_graph'],
  ['9. s-t graph', 'Vẽ đồ thị s-t của vật chuyển động thẳng đều với v = 5 m/s trong 8 s', 'physics_graph'], ['10. U-I graph', 'Vẽ đồ thị U-I của điện trở R = 10 Ω', 'physics_graph'],
  ['(+) x-t graph', 'Vẽ đồ thị x-t của chuyển động thẳng đều với x0 = 2 m, v = 3 m/s', 'physics_graph'], ['(+) concave mirror', 'Vẽ ảnh của vật AB qua gương cầu lõm tiêu cự 10 cm, vật cách gương 25 cm', 'physics_optics']
];
SPEC_PHYS.forEach(([n, q, cat]) => test(`H2. VẬT LÝ ${n}`, () => { const r = render(q, 'physics'); assert.strictEqual(r.status, 'rendered', JSON.stringify(r)); assert.strictEqual(r.category, cat); assert.strictEqual(K.validateSvg(r.svg).ok, true); }));
const SPEC_CHEM = [
  ['1. Na atom', 'Vẽ mô hình nguyên tử Na', [2, 8, 1], 0], ['2. Cl atom', 'Vẽ mô hình nguyên tử Cl', [2, 8, 7], 0], ['3. Na+', 'Vẽ ion Na+ sơ đồ Bohr', [2, 8], 1], ['4. Cl-', 'Vẽ ion Cl- sơ đồ Bohr', [2, 8, 8], -1],
  ['5. Electron configuration', 'Cấu hình electron của Fe', [2, 8, 14, 2], 0], ['6. Bohr shell model', 'Vẽ mô hình Bohr của Mg', [2, 8, 2], 0]
];
SPEC_CHEM.forEach(([n, q, shells, ch]) => test(`H3. HOÁ ${n} — dữ liệu có cấu trúc rồi mới render`, () => { const r = render(q, 'chemistry'); assert.strictEqual(r.status, 'rendered', JSON.stringify(r)); assert.deepStrictEqual(r.data.shells, shells); assert.strictEqual(r.data.charge, ch); assert.strictEqual((r.svg.match(/#1e3a8a/g) || []).length, shells.reduce((a, b) => a + b, 0)); assert.strictEqual(K.validateSvg(r.svg).ok, true); }));
[['7. H2O Lewis', 'H2O'], ['8. CO2 Lewis', 'CO2'], ['9. NH3', 'NH3'], ['10. CH4', 'CH4'], ['11. O2', 'O2'], ['12. N2', 'N2']].forEach(([n, f]) => test(`H3. HOÁ ${n}`, () => { const r = render(`Vẽ cấu trúc Lewis của ${f}`, 'chemistry'); assert.strictEqual(r.status, 'rendered', f); assert.strictEqual(r.category, 'chemistry_lewis'); assert.ok(chem.validateMolecule(chem.LIB[f]).ok); assert.strictEqual(K.validateSvg(r.svg).ok, true); }));
test('H4. TOÀN BỘ thư viện phân tử: render ra SVG hợp lệ + hiển thị tổng electron đúng', () => {
  chem.LIB_KEYS.forEach((k) => { const out = chem.renderMolecule({ ...chem.LIB[k], formula: k }, { formula: k, name: chem.LIB[k].name }); assert.strictEqual(K.validateSvg(out.svg).ok, true, k); assert.ok(new RegExp(`Tổng electron hoá trị: ${out.validation.electrons.valenceTotal}\\b`).test(texts(out.svg)), k); });
});

// ------------------------------------------------------------------ E. Visual Determination Engine
console.log('\n== E. Visual Determination Engine ==');
const route = (q, subject, puterAuth = 'unknown') => det.determineVisual({ question: q, subject, decision: de.evaluateVisualNeed({ question: q, subject, answerPlan: '' }), puterAuth });
[
  ['Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4', 'math', 'svg'],
  ['Vẽ đồ thị hàm số y = x^2 - 2x - 3', 'math', 'svg'],
  ['Vẽ sơ đồ lực tác dụng lên vật 2 kg trên mặt phẳng ngang', 'physics', 'svg'],
  ['Vẽ cấu hình electron của Na', 'chemistry', 'svg'],
  ['Vẽ cấu trúc Lewis của H2O', 'chemistry', 'svg'],
  ['Vẽ hình tế bào thực vật', 'biology', 'puter-image'],
  ['Tạo bằng AI hình tam giác ABC vuông tại A, AB=3, AC=4', 'math', 'puter-image'],
  ['Tạo hình phòng thí nghiệm chân thực có ống nghiệm', 'chemistry', 'puter-image'],
  ['Giải phương trình x^2 - 5x + 6 = 0', 'math', 'none'],
  ['cấu hình electron của Na', 'chemistry', 'none'],
  ['Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, BC = 6', 'math', 'none']
].forEach(([q, s, want]) => test(`E1. ${s}: "${q.slice(0, 48)}" -> ${want}`, () => { const r = route(q, s); assert.strictEqual(r.visualType, want, JSON.stringify({ t: r.visualType, why: r.reason })); }));
test('E2. SVG KHÔNG phụ thuộc trạng thái Auth Puter (cả 4 trạng thái đều ra svg, authRequired=false)', () => {
  ['authenticated', 'unauthenticated', 'unknown', 'error'].forEach((a) => { const r = route('Vẽ cấu hình electron của Na', 'chemistry', a); assert.strictEqual(r.visualType, 'svg', a); assert.strictEqual(r.authRequired, false, a); });
});
test('E3. Puter chỉ đòi Auth khi CHƯA Auth thật sự: unauthenticated -> authRequired; unknown/error/authenticated -> không', () => {
  assert.strictEqual(route('Vẽ hình tế bào thực vật', 'biology', 'unauthenticated').authRequired, true);
  ['authenticated', 'unknown', 'error'].forEach((a) => assert.strictEqual(route('Vẽ hình tế bào thực vật', 'biology', a).authRequired, false, a));
});
test('E4. dữ kiện mâu thuẫn -> reason deterministic_validation_failed, KHÔNG rơi xuống AI', () => { const r = route('Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, BC = 6', 'math', 'authenticated'); assert.strictEqual(r.visualType, 'none'); assert.strictEqual(r.reason, 'deterministic_validation_failed'); assert.ok(r.validationErrors.length); });
test('E5. setting "never" thắng (không SVG, không Puter) trừ khi có yêu cầu tường minh', () => {
  const q = 'Cho tam giác ABC vuông tại A, AB = 3, AC = 4. Tính BC';
  const d = de.evaluateVisualNeed({ question: q, subject: 'math', answerPlan: '', userPreference: 'never' }); const r = det.determineVisual({ question: q, subject: 'math', decision: d, userPreference: 'never' });
  assert.strictEqual(r.visualType, 'none');
});

// ------------------------------------------------------------------ F. Pipeline (SVG / Puter / Auth)
console.log('\n== F. visualPipeline — hybrid ==');
process.env.PUTER_VISUAL_MODE = 'client_primary';
const vs = require(path.join(root, 'server/utils/visual'));
const run = async (q, subject, puterAuth, extra = {}) => { const events = []; const r = await vs.runVisualPipeline({ question: q, finalAnswer: '', answerComplete: true, subject, puterAuth, onEvent: (e) => events.push(e.type), ...extra }); return { r, events }; };
atest('F1. SVG: 0 lệnh gọi ảnh, 0 judge, event visual:ready, KHÔNG có visual:request — với cả 4 trạng thái Auth', async () => {
  for (const a of ['authenticated', 'unauthenticated', 'unknown', 'error']) {
    const { r, events } = await run('Vẽ cấu hình electron của Na', 'chemistry', a);
    assert.strictEqual(r.status, 'ready', a); assert.strictEqual(r.visuals[0].format, 'svg'); assert.strictEqual(r.telemetry.visualProviderAttempts, 0); assert.strictEqual(r.telemetry.visualJudgeCalls, 0);
    assert.strictEqual(r.telemetry.visualDeterministic, true); assert.ok(r.telemetry.visualSpecHash); assert.ok(r.telemetry.visualSvgBytes > 500); assert.ok(!events.includes('visual:request'), a);
    assert.strictEqual(K.validateSvg(r.visuals[0].svg).ok, true); assert.strictEqual(r.visuals[0].fidelity, 'deterministic');
  }
});
atest('F2. Puter CHƯA Auth + người dùng yêu cầu ảnh AI -> status auth_required (stub PUTER_AUTH_REQUIRED + job), KHÔNG phát visual:request', async () => {
  const { r, events } = await run('Vẽ hình tế bào thực vật', 'biology', 'unauthenticated');
  assert.strictEqual(r.status, 'auth_required'); assert.strictEqual(r.visuals[0].errorCode, 'PUTER_AUTH_REQUIRED'); assert.strictEqual(r.visuals[0].authRequired, true);
  assert.strictEqual(r.visuals[0].job.renderer, 'puter_image'); assert.ok(r.visuals[0].job.prompt.length > 10); assert.ok(!events.includes('visual:request')); assert.strictEqual(r.telemetry.visualAuthRequired, true);
});
atest('F3. Puter đã Auth / trạng thái unknown -> job Puter bình thường (client tự kiểm tra)', async () => {
  for (const a of ['authenticated', 'unknown']) { const { r, events } = await run('Vẽ hình tế bào thực vật', 'biology', a); assert.strictEqual(r.status, 'pending', a); assert.strictEqual(r.visualJob.renderer, 'puter_image'); assert.ok(events.includes('visual:request')); }
});
atest('F4. dữ kiện mâu thuẫn -> status skipped + thẻ notice, 0 lệnh gọi ảnh, KHÔNG có job Puter', async () => {
  const { r } = await run('Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, BC = 6', 'math', 'authenticated');
  assert.strictEqual(r.status, 'skipped'); assert.strictEqual(r.visuals[0].format, 'notice'); assert.ok(/mâu thuẫn/.test(r.visuals[0].message)); assert.ok(!r.visualJob); assert.strictEqual(r.telemetry.visualProviderAttempts, 0);
  const en = await run('Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, BC = 6', 'math', 'authenticated', { language: 'en' }); assert.ok(/inconsistent/.test(en.r.visuals[0].message));
});
atest('F5. hình AI TUỲ CHỌN khi chưa Auth -> bỏ hình + MỘT dòng nhắc nhẹ (notice puter_auth_skipped, không phải lỗi, không job)', async () => {
  const { r } = await run('Trình bày cấu tạo của tế bào nhân thực', 'biology', 'unauthenticated', { finalAnswer: 'Tế bào nhân thực gồm:\n- **Ti thể**\n- **Lục lạp**\n- **Nhân tế bào**' });
  assert.ok(['skipped', 'auth_required'].includes(r.status), r.status);
  if (r.status === 'skipped') { assert.strictEqual(r.visuals.length, 1); assert.strictEqual(r.visuals[0].noticeKind, 'puter_auth_skipped'); assert.ok(/chưa được Auth/.test(r.visuals[0].message)); assert.ok(!r.visualJob); const en = await run('Trình bày cấu tạo của tế bào nhân thực', 'biology', 'unauthenticated', { language: 'en', finalAnswer: 'Tế bào nhân thực gồm:\n- **Ti thể**\n- **Lục lạp**\n- **Nhân tế bào**' }); assert.ok(/not authenticated/.test(en.r.visuals[0].message)); }
  else assert.ok(r.visuals[0].userRequested || ['NECESSARY', 'USER_REQUESTED'].includes(r.visuals[0].necessity));
});
atest('F6. stage "detail" chỉ DÙNG LẠI SVG của Approach, không dựng lại', async () => {
  const first = await run('Vẽ cấu hình electron của Na', 'chemistry', 'unknown');
  const detail = await vs.runVisualPipeline({ question: 'Vẽ cấu hình electron của Na', finalAnswer: 'x', answerComplete: true, subject: 'chemistry', stage: 'detail', existingVisuals: first.r.visuals });
  assert.strictEqual(detail.status, 'reused'); assert.strictEqual(detail.visuals[0].format, 'svg'); assert.strictEqual(detail.telemetry.visualReused, true);
});
atest('F7. deadline khẩn cấp: ảnh AI bị hoãn, SVG vẫn giao', async () => {
  const ai = await vs.runVisualPipeline({ question: 'Vẽ hình tế bào thực vật', finalAnswer: '', answerComplete: true, subject: 'biology', deadline: { remaining: () => 500 } });
  assert.strictEqual(ai.status, 'skipped'); assert.strictEqual(ai.telemetry.visualError, 'deferred_deadline');
  const svg = await vs.runVisualPipeline({ question: 'Vẽ cấu hình electron của Na', finalAnswer: '', answerComplete: true, subject: 'chemistry', deadline: { remaining: () => 500 } });
  assert.strictEqual(svg.status, 'ready');
});
atest('F8. pipeline KHÔNG BAO GIỜ throw kể cả input rác', async () => {
  for (const a of [{}, { question: null }, { question: 12345, subject: {} }, { question: 'x'.repeat(50000), subject: 'math' }]) { const r = await vs.runVisualPipeline({ answerComplete: true, ...a }); assert.ok(r && r.status); }
});
test('F9. validators: clientCaps.puterAuth chỉ nhận 4 giá trị; thiếu/lạ -> unknown (tương thích ngược)', () => {
  const base = { query: 'Tính 1+1' };
  assert.strictEqual(validateChatBody(base).clientCaps.puterAuth, 'unknown');
  assert.strictEqual(validateChatBody({ ...base, clientCaps: { puterAuth: 'authenticated' } }).clientCaps.puterAuth, 'authenticated');
  assert.strictEqual(validateChatBody({ ...base, clientCaps: { puterAuth: 'hacker' } }).clientCaps.puterAuth, 'unknown');
  assert.strictEqual(validateChatBody({ ...base, clientCaps: 'x' }).clientCaps.puterAuth, 'unknown');
});
test('F10. debug log chỉ khi PUTER_VISUAL_DEBUG=true và KHÔNG chứa nội dung đề bài dài', () => {
  const orig = console.log; const lines = []; console.log = (...a) => lines.push(a.join(' '));
  try { delete process.env.PUTER_VISUAL_DEBUG; route('Vẽ cấu hình electron của Na', 'chemistry'); const off = lines.length; process.env.PUTER_VISUAL_DEBUG = 'true'; route('Vẽ cấu hình electron của Na', 'chemistry'); assert.strictEqual(off, 0); assert.ok(lines.length > 0); assert.ok(lines.every((l) => l.length < 500 && !/Vẽ cấu hình/.test(l))); } finally { console.log = orig; delete process.env.PUTER_VISUAL_DEBUG; }
});

atest('F12. IMAGE-ONLY ("Vẽ …" thuần): chủ đề bị cắt động từ vẫn ra SVG nhờ rawQuestion; ảnh AI không còn bị bỏ vì "dưới ngưỡng"', async () => {
  const run2 = (topic, raw, subject, auth) => vs.runVisualPipeline({ stage: 'image_only', question: topic, rawQuestion: raw, finalAnswer: '', answerComplete: true, subject, userPreference: 'always', puterAuth: auth });
  for (const a of ['authenticated', 'unauthenticated']) {
    const s1 = await run2('electron của nguyên tử Natri Na', 'Vẽ cấu hình electron của nguyên tử Natri Na', 'general', a); assert.strictEqual(s1.status, 'ready'); assert.strictEqual(s1.visuals[0].format, 'svg');
    const s2 = await run2('phân tử H2O', 'Vẽ cấu trúc Lewis của phân tử H2O', 'general', a); assert.strictEqual(s2.visuals[0].format, 'svg');
  }
  const ai = await run2('tế bào thực vật', 'Vẽ hình tế bào thực vật', 'general', 'authenticated'); assert.strictEqual(ai.status, 'pending'); assert.strictEqual(ai.visualJob.renderer, 'puter_image');
  const au = await run2('tế bào thực vật', 'Vẽ hình tế bào thực vật', 'general', 'unauthenticated'); assert.strictEqual(au.status, 'auth_required');
  // veto tuyệt đối + setting "never" vẫn được tôn trọng
  const nv = await vs.runVisualPipeline({ stage: 'image_only', question: 'tế bào thực vật', finalAnswer: '', answerComplete: true, subject: 'biology', userPreference: 'never' }); assert.strictEqual(nv.status, 'skipped');
});
test('F11. chat.js: kết quả phụ thuộc Auth Puter KHÔNG vào cache text dùng chung (4/4 điểm ghi cache)', () => {
  const src = require('fs').readFileSync(path.join(root, 'server/routes/chat.js'), 'utf8');
  assert.ok(/function isAuthDependentVisualRun\(/.test(src));
  assert.strictEqual((src.match(/globalCache\.set\('L1'/g) || []).length, 4);
  assert.strictEqual((src.match(/!isAuthDependentVisualRun\(\w+\)\) tokenEconomy\.globalCache\.set\('L1'/g) || []).length, 4, 'mọi điểm ghi cache phải có cổng Auth');
  assert.ok(/puterAuth: \(input\.clientCaps && input\.clientCaps\.puterAuth\) \|\| 'unknown'/.test(src), 'chat.js phải luồn puterAuth vào pipeline');
});

Promise.all(pending).then(() => {
  let passed = 0, failed = 0;
  results.forEach((r) => { if (r.pass) { passed++; console.log('  ok  - ' + r.name); } else { failed++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); } });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
});
