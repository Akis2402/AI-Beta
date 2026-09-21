'use strict';

// ============================================================================================
// HOÁ HỌC — dữ liệu có cấu trúc + VALIDATE nghiêm ngặt + renderer tất định.
// KHÔNG có "hạt nhân + vài vòng tròn + electron rải ngẫu nhiên": mọi electron đều đến từ cấu hình
// electron tính bằng quy tắc Aufbau/Pauli/Hund; mọi cấu trúc Lewis đều phải qua kiểm kê electron,
// điện tích hình thức và quy tắc octet. Dữ liệu mâu thuẫn -> {ok:false, errors} và KHÔNG vẽ gì.
// ============================================================================================

const K = require('./svgKit');
const U = require('./factUtils');

const { Canvas, COLORS } = K;

// ---------------------------------------------------------------- Bảng tuần hoàn (Z = 1..54)
// [Z, ký hiệu, tên tiếng Anh, tên tiếng Việt, số khối của đồng vị phổ biến nhất]
const RAW = [
  [1, 'H', 'hydrogen', 'hidro', 1], [2, 'He', 'helium', 'heli', 4], [3, 'Li', 'lithium', 'liti', 7], [4, 'Be', 'beryllium', 'beri', 9],
  [5, 'B', 'boron', 'bo', 11], [6, 'C', 'carbon', 'cacbon', 12], [7, 'N', 'nitrogen', 'nito', 14], [8, 'O', 'oxygen', 'oxi', 16],
  [9, 'F', 'fluorine', 'flo', 19], [10, 'Ne', 'neon', 'neon', 20], [11, 'Na', 'sodium', 'natri', 23], [12, 'Mg', 'magnesium', 'magie', 24],
  [13, 'Al', 'aluminium', 'nhom', 27], [14, 'Si', 'silicon', 'silic', 28], [15, 'P', 'phosphorus', 'photpho', 31], [16, 'S', 'sulfur', 'luu huynh', 32],
  [17, 'Cl', 'chlorine', 'clo', 35], [18, 'Ar', 'argon', 'agon', 40], [19, 'K', 'potassium', 'kali', 39], [20, 'Ca', 'calcium', 'canxi', 40],
  [21, 'Sc', 'scandium', 'scandi', 45], [22, 'Ti', 'titanium', 'titan', 48], [23, 'V', 'vanadium', 'vanadi', 51], [24, 'Cr', 'chromium', 'crom', 52],
  [25, 'Mn', 'manganese', 'mangan', 55], [26, 'Fe', 'iron', 'sat', 56], [27, 'Co', 'cobalt', 'coban', 59], [28, 'Ni', 'nickel', 'niken', 58],
  [29, 'Cu', 'copper', 'dong', 63], [30, 'Zn', 'zinc', 'kem', 64], [31, 'Ga', 'gallium', 'gali', 69], [32, 'Ge', 'germanium', 'gecmani', 74],
  [33, 'As', 'arsenic', 'asen', 75], [34, 'Se', 'selenium', 'selen', 80], [35, 'Br', 'bromine', 'brom', 79], [36, 'Kr', 'krypton', 'kripton', 84],
  [37, 'Rb', 'rubidium', 'rubidi', 85], [38, 'Sr', 'strontium', 'stronti', 88], [39, 'Y', 'yttrium', 'ytri', 89], [40, 'Zr', 'zirconium', 'ziriconi', 90],
  [41, 'Nb', 'niobium', 'niobi', 93], [42, 'Mo', 'molybdenum', 'molipden', 98], [43, 'Tc', 'technetium', 'tecneti', 98], [44, 'Ru', 'ruthenium', 'rutheni', 102],
  [45, 'Rh', 'rhodium', 'rodi', 103], [46, 'Pd', 'palladium', 'paladi', 106], [47, 'Ag', 'silver', 'bac', 107], [48, 'Cd', 'cadmium', 'cadimi', 114],
  [49, 'In', 'indium', 'indi', 115], [50, 'Sn', 'tin', 'thiec', 120], [51, 'Sb', 'antimony', 'antimon', 121], [52, 'Te', 'tellurium', 'telu', 130],
  [53, 'I', 'iodine', 'iot', 127], [54, 'Xe', 'xenon', 'xenon', 132]
];
const ELEMENTS = {}; const BY_SYMBOL = {}; const BY_NAME = {};
RAW.forEach(([z, sym, en, vi, a]) => {
  const e = { Z: z, symbol: sym, nameEn: en, nameVi: vi, defaultMass: a };
  ELEMENTS[z] = e; BY_SYMBOL[sym] = e; BY_NAME[en] = e; BY_NAME[vi] = e;
});
BY_NAME.nitrogen = ELEMENTS[7]; BY_NAME.nito = ELEMENTS[7]; BY_NAME.nitro = ELEMENTS[7]; BY_NAME.aluminum = ELEMENTS[13]; BY_NAME.hiđro = ELEMENTS[1]; BY_NAME.hydro = ELEMENTS[1];
const DISPLAY_VI = { H: 'Hiđro', He: 'Heli', Li: 'Liti', Be: 'Beri', B: 'Bo', C: 'Cacbon', N: 'Nitơ', O: 'Oxi', F: 'Flo', Ne: 'Neon', Na: 'Natri', Mg: 'Magie', Al: 'Nhôm', Si: 'Silic', P: 'Photpho', S: 'Lưu huỳnh', Cl: 'Clo', Ar: 'Agon', K: 'Kali', Ca: 'Canxi', Sc: 'Scandi', Ti: 'Titan', V: 'Vanadi', Cr: 'Crom', Mn: 'Mangan', Fe: 'Sắt', Co: 'Coban', Ni: 'Niken', Cu: 'Đồng', Zn: 'Kẽm', Ga: 'Gali', Ge: 'Gecmani', As: 'Asen', Se: 'Selen', Br: 'Brom', Kr: 'Kripton', Rb: 'Rubidi', Sr: 'Stronti', Y: 'Ytri', Zr: 'Ziriconi', Nb: 'Niobi', Mo: 'Molipđen', Tc: 'Tecneti', Ru: 'Rutheni', Rh: 'Rođi', Pd: 'Paladi', Ag: 'Bạc', Cd: 'Cadimi', In: 'Indi', Sn: 'Thiếc', Sb: 'Antimon', Te: 'Telu', I: 'Iot', Xe: 'Xenon' };

const NOBLE_Z = [2, 10, 18, 36, 54];
const METALS = new Set(['Li', 'Be', 'Na', 'Mg', 'Al', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn']);
const isTransition = (z) => (z >= 21 && z <= 30) || (z >= 39 && z <= 48);

// ---------------------------------------------------------------- Cấu hình electron (Aufbau + ngoại lệ)
const AUFBAU = ['1s', '2s', '2p', '3s', '3p', '4s', '3d', '4p', '5s', '4d', '5p'];
const CAP = { s: 2, p: 6, d: 10 };
const EXCEPTIONS = {
  24: { '4s': 1, '3d': 5 }, 29: { '4s': 1, '3d': 10 }, 41: { '5s': 1, '4d': 4 }, 42: { '5s': 1, '4d': 5 },
  44: { '5s': 1, '4d': 7 }, 45: { '5s': 1, '4d': 8 }, 46: { '5s': 0, '4d': 10 }, 47: { '5s': 1, '4d': 10 }
};
function subOrder(a, b) { const na = Number(a[0]); const nb = Number(b[0]); return na !== nb ? na - nb : 'spd'.indexOf(a[1]) - 'spd'.indexOf(b[1]); }

function neutralConfig(Z) {
  const cfg = {}; let left = Z;
  for (const sub of AUFBAU) {
    if (left <= 0) break;
    const put = Math.min(CAP[sub[1]], left); cfg[sub] = put; left -= put;
  }
  if (left > 0) throw new Error('config_out_of_range');
  if (EXCEPTIONS[Z]) Object.assign(cfg, EXCEPTIONS[Z]);
  Object.keys(cfg).forEach((k) => { if (cfg[k] === 0) delete cfg[k]; });
  return cfg;
}
/** Áp dụng điện tích: cation bỏ electron từ lớp ngoài (n lớn nhất, rồi l lớn nhất); anion thêm theo Aufbau. */
function ionConfig(Z, charge) {
  const cfg = neutralConfig(Z);
  if (charge > 0) {
    let rm = charge;
    const order = Object.keys(cfg).sort((a, b) => -subOrder(a, b) || 0).sort((a, b) => (Number(b[0]) - Number(a[0])) || ('spd'.indexOf(b[1]) - 'spd'.indexOf(a[1])));
    for (const sub of order) { if (rm <= 0) break; const t = Math.min(cfg[sub], rm); cfg[sub] -= t; rm -= t; if (cfg[sub] === 0) delete cfg[sub]; }
    if (rm > 0) throw new Error('ion_removes_too_many');
  } else if (charge < 0) {
    let add = -charge;
    for (const sub of AUFBAU) { if (add <= 0) break; const cur = cfg[sub] || 0; const t = Math.min(CAP[sub[1]] - cur, add); if (t > 0) { cfg[sub] = cur + t; add -= t; } }
    if (add > 0) throw new Error('ion_adds_too_many');
  }
  return cfg;
}
function shellsOf(cfg) {
  const out = [];
  Object.keys(cfg).forEach((k) => { const n = Number(k[0]); out[n - 1] = (out[n - 1] || 0) + cfg[k]; });
  return Array.from(out, (v) => v || 0);
}
function fmtFormula(f) {
  const m = /^(.*?)([+-])$/.exec(f); const body = m ? m[1] : f; const charge = m ? m[2] : '';
  const subd = body.replace(/(\D)(\d+)/g, (x, a, d) => a + d.replace(/\d/g, (c) => '₀₁₂₃₄₅₆₇₈₉'[c]));
  return subd + (charge === '+' ? '⁺' : (charge === '-' ? '⁻' : ''));
}
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻' };
function sup(s) { return String(s).split('').map((c) => SUP[c] || c).join(''); }
function chargeLabel(c) { if (!c) return ''; const a = Math.abs(c); return sup(`${a > 1 ? a : ''}${c > 0 ? '+' : '-'}`); }
function configString(cfg) { return Object.keys(cfg).sort(subOrder).map((k) => `${k}${sup(cfg[k])}`).join(' '); }
function configPlain(cfg) { return Object.keys(cfg).sort(subOrder).map((k) => `${k}${cfg[k]}`).join(' '); }

// ---------------------------------------------------------------- Nguyên tử / ion: build + validate
/**
 * buildAtom() — nhận dữ kiện có cấu trúc, TỰ KIỂM TRA mọi ràng buộc, trả về nguyên tử hoàn chỉnh.
 * @param {{Z?:number,symbol?:string,protons?:number,neutrons?:number,electrons?:number,massNumber?:number,charge?:number}} facts
 * @returns {{ok:boolean, errors:Array<{code:string,detail:string}>, atom?:Object}}
 */
function buildAtom(facts) {
  const errors = []; const err = (code, detail) => errors.push({ code, detail });
  let el = null;
  if (facts.symbol) el = BY_SYMBOL[facts.symbol];
  if (facts.symbol && !el) err('unknown_element', `Không có dữ liệu cho ký hiệu "${facts.symbol}" (hỗ trợ Z = 1–54).`);
  if (facts.Z != null) {
    if (!Number.isInteger(facts.Z) || facts.Z < 1) err('invalid_atomic_number', `Z = ${facts.Z} không hợp lệ.`);
    else if (el && el.Z !== facts.Z) err('element_z_mismatch', `${el.symbol} có Z = ${el.Z}, không phải ${facts.Z}.`); // mâu thuẫn THẬT (kể cả khi Z nằm ngoài bảng)
    else if (!ELEMENTS[facts.Z]) err('unsupported_atomic_number', `Z = ${facts.Z} nằm ngoài phạm vi hỗ trợ (1–54).`);
    else if (!el) el = ELEMENTS[facts.Z];
  }
  if (facts.protons != null) {
    if (el && el.Z !== facts.protons) err('protons_mismatch', `Số proton (${facts.protons}) phải bằng Z = ${el.Z} của ${el.symbol}.`);
    else if (!el) { if (ELEMENTS[facts.protons]) el = ELEMENTS[facts.protons]; else err('unsupported_atomic_number', `Số proton ${facts.protons} nằm ngoài phạm vi hỗ trợ (1–54).`); }
  }
  if (!el) { if (!errors.length) err('element_unknown', 'Không xác định được nguyên tố.'); return { ok: false, errors }; }
  const Z = el.Z;
  let charge = facts.charge != null ? facts.charge : null;
  if (facts.electrons != null) {
    const ch = Z - facts.electrons;
    if (charge != null && charge !== ch) err('electrons_charge_mismatch', `${facts.electrons} electron với Z = ${Z} cho điện tích ${ch > 0 ? `+${ch}` : ch}, không phải ${charge > 0 ? `+${charge}` : charge}.`);
    charge = ch;
  }
  if (facts.assumeNeutral && facts.charge == null && facts.electrons != null && facts.electrons !== Z) err('atom_not_neutral', `Nguyên tử trung hoà phải có số electron bằng số proton (Z = ${Z}), nhưng đề cho ${facts.electrons} electron.`);
  if (charge == null) charge = 0;
  if (!Number.isInteger(charge)) err('invalid_charge', 'Điện tích phải là số nguyên.');
  const electrons = Z - charge;
  if (electrons < 0) err('negative_electrons', `Z = ${Z} không thể mang điện tích +${charge} (electron < 0).`);
  // Tính thực tế của ion (chỉ để CẢNH BÁO khi phi thực tế -> từ chối, tránh vẽ ion không tồn tại trong chương trình phổ thông)
  if (charge > 0 && errors.length === 0) {
    const isMetal = METALS.has(el.symbol) || el.symbol === 'H';
    if (!isMetal) err('ion_unrealistic', `${el.symbol} là phi kim, không tạo cation ${el.symbol}${chargeLabel(charge)} trong phạm vi hỗ trợ.`);
    else if (isTransition(Z) && charge > 4) err('ion_unrealistic', `Điện tích +${charge} của ${el.symbol} vượt phạm vi hỗ trợ (≤ +4 cho kim loại chuyển tiếp).`);
    else if (!isTransition(Z) && Z > 1) { const v = shellsOf(neutralConfig(Z)).slice(-1)[0]; if (charge > v) err('ion_unrealistic', `${el.symbol} chỉ có ${v} electron lớp ngoài cùng, không thể mang điện tích +${charge}.`); }
    else if (Z === 1 && charge > 1) err('ion_unrealistic', 'H chỉ có thể tạo H⁺.');
  }
  if (charge < 0 && errors.length === 0) {
    const need = { H: 1, C: 4, N: 3, O: 2, F: 1, P: 3, S: 2, Cl: 1, Se: 2, Br: 1, Te: 2, I: 1, As: 3, Si: 4, Ge: 4 }[el.symbol];
    if (need == null) err('ion_unrealistic', `${el.symbol} không tạo anion trong phạm vi hỗ trợ.`);
    else if (-charge > need) err('ion_unrealistic', `${el.symbol} chỉ nhận tối đa ${need} electron để đạt cấu hình bền.`);
  }
  // Số khối / nơtron
  let A = facts.massNumber != null ? facts.massNumber : null; let N = facts.neutrons != null ? facts.neutrons : null;
  if (A != null && (!Number.isInteger(A) || A < Z)) err('mass_number_invalid', `Số khối A = ${A} phải là số nguyên ≥ Z = ${Z}.`);
  if (A != null && N != null && A !== Z + N) err('mass_neutron_mismatch', `A = Z + N: ${Z} + ${N} = ${Z + N}, khác A = ${A}.`);
  if (N != null && (!Number.isInteger(N) || N < 0)) err('neutrons_invalid', 'Số nơtron phải là số nguyên không âm.');
  let massGiven = A != null || N != null;
  if (A == null && N != null) A = Z + N;
  if (A == null) A = el.defaultMass;
  if (N == null) N = A - Z;
  if (N < 0) err('neutrons_negative', 'Số nơtron âm.');
  if (errors.length) return { ok: false, errors };
  let cfg;
  try { cfg = charge === 0 ? neutralConfig(Z) : ionConfig(Z, charge); } catch (e) { return { ok: false, errors: [{ code: e.message, detail: `Không dựng được cấu hình electron cho ${el.symbol}${chargeLabel(charge)}.` }] }; }
  const sum = Object.values(cfg).reduce((s, x) => s + x, 0);
  if (sum !== electrons) return { ok: false, errors: [{ code: 'config_electron_mismatch', detail: `Cấu hình có ${sum} electron nhưng cần ${electrons}.` }] };
  const shells = shellsOf(cfg);
  if (shells.reduce((s, x) => s + x, 0) !== electrons) return { ok: false, errors: [{ code: 'shell_sum_mismatch', detail: 'Tổng electron các lớp không khớp.' }] };
  const outer = shells.length ? shells[shells.length - 1] : 0;
  const mainGroup = !isTransition(Z);
  const valence = mainGroup && charge === 0 ? outer : null;
  return {
    ok: true, errors: [],
    atom: {
      element: el.symbol, nameVi: DISPLAY_VI[el.symbol], nameEn: el.nameEn, atomicNumber: Z, massNumber: A, massGiven, protons: Z, neutrons: N, electrons, charge,
      shells, electronConfiguration: configPlain(cfg), config: cfg, valenceElectrons: valence, outerShellElectrons: outer
    }
  };
}

// ---------------------------------------------------------------- Lewis / phân tử: validate
const VALENCE = (sym) => { const el = BY_SYMBOL[sym]; if (!el || isTransition(el.Z) || el.Z > 54) return null; return shellsOf(neutralConfig(el.Z)).slice(-1)[0]; };
/**
 * validateMolecule() — kiểm kê electron + điện tích hình thức + octet + liên thông.
 * @param {{atoms:Array<{id:string,el:string}>, bonds:Array<{a:string,b:string,order:number}>, lonePairs?:Object<string,number>, charges?:Object<string,number>, netCharge?:number}} m
 */
function validateMolecule(m) {
  const errors = []; const err = (code, detail) => errors.push({ code, detail });
  if (!m || !Array.isArray(m.atoms) || !m.atoms.length) return { ok: false, errors: [{ code: 'no_atoms', detail: 'Thiếu danh sách nguyên tử.' }] };
  const ids = new Set(); const byId = {};
  m.atoms.forEach((a) => { if (ids.has(a.id)) err('duplicate_atom', `Trùng id nguyên tử ${a.id}.`); ids.add(a.id); byId[a.id] = a; if (!BY_SYMBOL[a.el]) err('unknown_element', `Nguyên tố ${a.el} không có trong dữ liệu.`); else if (VALENCE(a.el) == null) err('unsupported_element', `${a.el} không nằm trong nhóm chính được hỗ trợ.`); });
  const lp = m.lonePairs || {}; const ch = m.charges || {};
  const seenBond = new Set(); const bondSum = {}; ids.forEach((i) => { bondSum[i] = 0; });
  (m.bonds || []).forEach((b) => {
    if (!ids.has(b.a) || !ids.has(b.b)) { err('bond_unknown_atom', `Liên kết ${b.a}-${b.b} tham chiếu nguyên tử không tồn tại.`); return; }
    if (b.a === b.b) err('bond_self', `Liên kết nối nguyên tử ${b.a} với chính nó.`);
    if (![1, 2, 3].includes(b.order)) err('bond_order_invalid', `Bậc liên kết ${b.order} không hợp lệ (chỉ 1, 2, 3).`);
    const key = [b.a, b.b].sort().join('|'); if (seenBond.has(key)) err('bond_duplicate', `Liên kết ${b.a}-${b.b} bị khai báo hai lần.`); seenBond.add(key);
    bondSum[b.a] += b.order; bondSum[b.b] += b.order;
  });
  Object.keys(lp).forEach((k) => { if (!ids.has(k)) err('lonepair_unknown_atom', `Cặp electron tự do gán cho nguyên tử không tồn tại: ${k}.`); else if (!Number.isInteger(lp[k]) || lp[k] < 0) err('lonepair_invalid', `Số cặp electron tự do của ${k} không hợp lệ.`); });
  Object.keys(ch).forEach((k) => { if (!ids.has(k)) err('charge_unknown_atom', `Điện tích gán cho nguyên tử không tồn tại: ${k}.`); });
  if (errors.length) return { ok: false, errors };
  const net = Object.values(ch).reduce((s, x) => s + x, 0);
  if (m.netCharge != null && m.netCharge !== net) err('net_charge_mismatch', `Tổng điện tích hình thức = ${net}, khác điện tích ion khai báo ${m.netCharge}.`);
  const totalValence = m.atoms.reduce((s, a) => s + VALENCE(a.el), 0) - net;
  const bonding = Object.values(bondSum).reduce((s, x) => s + x, 0); // mỗi liên kết đếm 2 lần (2 đầu) × 1 = order×2 electron
  const nonbonding = m.atoms.reduce((s, a) => s + 2 * (lp[a.id] || 0), 0);
  const used = bonding + nonbonding;
  if (used !== totalValence) err('electron_count_mismatch', `Tổng electron hoá trị cần ${totalValence}, nhưng cấu trúc dùng ${used} (liên kết ${bonding} + không liên kết ${nonbonding}).`);
  m.atoms.forEach((a) => {
    const v = VALENCE(a.el); const nb = 2 * (lp[a.id] || 0); const fc = v - nb - bondSum[a.id];
    if (fc !== (ch[a.id] || 0)) err('formal_charge_mismatch', `Điện tích hình thức của ${a.el}(${a.id}) tính được ${fc}, khai báo ${ch[a.id] || 0}.`);
    const around = nb + 2 * bondSum[a.id]; const Zn = BY_SYMBOL[a.el].Z;
    if (Zn <= 2) { if (around > 2) err('octet_violation', `${a.el} (${a.id}) có ${around} electron xung quanh, tối đa 2.`); else if (bondSum[a.id] + (lp[a.id] || 0) === 0 && (m.atoms.length > 1)) err('isolated_atom', `${a.el} (${a.id}) không có liên kết.`); }
    else if (Zn <= 10) { if (around > 8) err('octet_violation', `${a.el} (${a.id}) có ${around} electron xung quanh, vượt quy tắc octet (8).`); else if (['C', 'N', 'O', 'F'].includes(a.el) && around !== 8) err('octet_incomplete', `${a.el} (${a.id}) chỉ có ${around} electron xung quanh, cần 8.`); }
    else if (around > 8 && !m.allowExpandedOctet) err('octet_violation', `${a.el} (${a.id}) có ${around} electron xung quanh (mở rộng octet chưa được hỗ trợ).`);
    if (bondSum[a.id] === 0 && m.atoms.length > 1) err('atom_not_bonded', `${a.el} (${a.id}) không nối với nguyên tử nào.`);
  });
  // liên thông
  const adj = {}; ids.forEach((i) => { adj[i] = []; });
  (m.bonds || []).forEach((b) => { adj[b.a].push(b.b); adj[b.b].push(b.a); });
  const start = m.atoms[0].id; const seen = new Set([start]); const stack = [start];
  while (stack.length) { const c = stack.pop(); adj[c].forEach((n) => { if (!seen.has(n)) { seen.add(n); stack.push(n); } }); }
  if (seen.size !== ids.size) err('disconnected', 'Cấu trúc gồm nhiều mảnh rời nhau.');
  return { ok: errors.length === 0, errors, electrons: { valenceTotal: totalValence, bonding, nonbonding }, netCharge: net };
}

// ---------------------------------------------------------------- Thư viện phân tử (dữ liệu tay, đều phải qua validateMolecule)
const P = (x, y) => ({ x, y });
function atomsAt(list) { return list.map(([id, el, x, y]) => ({ id, el, ...P(x, y) })); }
const bent = (half, len) => [Math.sin(K.rad(half)) * len, Math.cos(K.rad(half)) * len];
const [wx, wy] = bent(52.25, 78); const [sx, sy] = bent(46, 84);
const LIB = {
  H2: { name: 'Hiđro', shape: 'Phân tử hai nguyên tử', atoms: atomsAt([['a', 'H', -36, 0], ['b', 'H', 36, 0]]), bonds: [{ a: 'a', b: 'b', order: 1 }], lonePairs: {} },
  O2: { name: 'Oxi', shape: 'Phân tử hai nguyên tử', atoms: atomsAt([['a', 'O', -40, 0], ['b', 'O', 40, 0]]), bonds: [{ a: 'a', b: 'b', order: 2 }], lonePairs: { a: 2, b: 2 } },
  N2: { name: 'Nitơ', shape: 'Phân tử hai nguyên tử', atoms: atomsAt([['a', 'N', -40, 0], ['b', 'N', 40, 0]]), bonds: [{ a: 'a', b: 'b', order: 3 }], lonePairs: { a: 1, b: 1 } },
  F2: { name: 'Flo', shape: 'Phân tử hai nguyên tử', atoms: atomsAt([['a', 'F', -40, 0], ['b', 'F', 40, 0]]), bonds: [{ a: 'a', b: 'b', order: 1 }], lonePairs: { a: 3, b: 3 } },
  Cl2: { name: 'Clo', shape: 'Phân tử hai nguyên tử', atoms: atomsAt([['a', 'Cl', -42, 0], ['b', 'Cl', 42, 0]]), bonds: [{ a: 'a', b: 'b', order: 1 }], lonePairs: { a: 3, b: 3 } },
  HF: { name: 'Hiđro florua', shape: 'Phân tử hai nguyên tử', atoms: atomsAt([['a', 'H', -42, 0], ['b', 'F', 42, 0]]), bonds: [{ a: 'a', b: 'b', order: 1 }], lonePairs: { b: 3 } },
  HCl: { name: 'Hiđro clorua', shape: 'Phân tử hai nguyên tử', atoms: atomsAt([['a', 'H', -44, 0], ['b', 'Cl', 44, 0]]), bonds: [{ a: 'a', b: 'b', order: 1 }], lonePairs: { b: 3 } },
  H2O: { name: 'Nước', shape: 'Gấp khúc, góc HOH ≈ 104,5°', atoms: atomsAt([['o', 'O', 0, -26], ['h1', 'H', -wx, -26 + wy], ['h2', 'H', wx, -26 + wy]]), bonds: [{ a: 'o', b: 'h1', order: 1 }, { a: 'o', b: 'h2', order: 1 }], lonePairs: { o: 2 } },
  H2S: { name: 'Hiđro sunfua', shape: 'Gấp khúc, góc HSH ≈ 92°', atoms: atomsAt([['s', 'S', 0, -26], ['h1', 'H', -sx, -26 + sy], ['h2', 'H', sx, -26 + sy]]), bonds: [{ a: 's', b: 'h1', order: 1 }, { a: 's', b: 'h2', order: 1 }], lonePairs: { s: 2 } },
  NH3: { name: 'Amoniac', shape: 'Chóp tam giác, góc HNH ≈ 107°', atoms: atomsAt([['n', 'N', 0, 0], ['h1', 'H', -66, 44], ['h2', 'H', 66, 44], ['h3', 'H', 0, -74]]), bonds: [{ a: 'n', b: 'h1', order: 1 }, { a: 'n', b: 'h2', order: 1 }, { a: 'n', b: 'h3', order: 1 }], lonePairs: { n: 1 } },
  CH4: { name: 'Metan', shape: 'Tứ diện đều, góc HCH ≈ 109,5°', atoms: atomsAt([['c', 'C', 0, 0], ['h1', 'H', -70, 0], ['h2', 'H', 70, 0], ['h3', 'H', 0, -70], ['h4', 'H', 0, 70]]), bonds: ['h1', 'h2', 'h3', 'h4'].map((h) => ({ a: 'c', b: h, order: 1 })), lonePairs: {} },
  CO2: { name: 'Cacbon đioxit', shape: 'Thẳng, góc OCO = 180°', atoms: atomsAt([['o1', 'O', -96, 0], ['c', 'C', 0, 0], ['o2', 'O', 96, 0]]), bonds: [{ a: 'c', b: 'o1', order: 2 }, { a: 'c', b: 'o2', order: 2 }], lonePairs: { o1: 2, o2: 2 } },
  CO: { name: 'Cacbon monoxit', shape: 'Phân tử hai nguyên tử', atoms: atomsAt([['c', 'C', -42, 0], ['o', 'O', 42, 0]]), bonds: [{ a: 'c', b: 'o', order: 3 }], lonePairs: { c: 1, o: 1 }, charges: { c: -1, o: 1 } },
  HCN: { name: 'Hiđro xianua', shape: 'Thẳng', atoms: atomsAt([['h', 'H', -96, 0], ['c', 'C', 0, 0], ['n', 'N', 96, 0]]), bonds: [{ a: 'h', b: 'c', order: 1 }, { a: 'c', b: 'n', order: 3 }], lonePairs: { n: 1 } },
  C2H2: { name: 'Axetilen', shape: 'Thẳng', atoms: atomsAt([['h1', 'H', -112, 0], ['c1', 'C', -38, 0], ['c2', 'C', 38, 0], ['h2', 'H', 112, 0]]), bonds: [{ a: 'h1', b: 'c1', order: 1 }, { a: 'c1', b: 'c2', order: 3 }, { a: 'c2', b: 'h2', order: 1 }], lonePairs: {} },
  C2H4: { name: 'Etilen', shape: 'Phẳng, góc HCH ≈ 120°', atoms: atomsAt([['c1', 'C', -40, 0], ['c2', 'C', 40, 0], ['h1', 'H', -84, -56], ['h2', 'H', -84, 56], ['h3', 'H', 84, -56], ['h4', 'H', 84, 56]]), bonds: [{ a: 'c1', b: 'c2', order: 2 }, { a: 'c1', b: 'h1', order: 1 }, { a: 'c1', b: 'h2', order: 1 }, { a: 'c2', b: 'h3', order: 1 }, { a: 'c2', b: 'h4', order: 1 }], lonePairs: {} },
  CH2O: { name: 'Fomanđehit', shape: 'Phẳng tam giác', atoms: atomsAt([['c', 'C', 0, 0], ['o', 'O', 0, -78], ['h1', 'H', -68, 44], ['h2', 'H', 68, 44]]), bonds: [{ a: 'c', b: 'o', order: 2 }, { a: 'c', b: 'h1', order: 1 }, { a: 'c', b: 'h2', order: 1 }], lonePairs: { o: 2 } },
  'NH4+': { name: 'Amoni', shape: 'Tứ diện đều', atoms: atomsAt([['n', 'N', 0, 0], ['h1', 'H', -70, 0], ['h2', 'H', 70, 0], ['h3', 'H', 0, -70], ['h4', 'H', 0, 70]]), bonds: ['h1', 'h2', 'h3', 'h4'].map((h) => ({ a: 'n', b: h, order: 1 })), lonePairs: {}, charges: { n: 1 }, netCharge: 1 },
  'H3O+': { name: 'Hiđroni', shape: 'Chóp tam giác', atoms: atomsAt([['o', 'O', 0, 0], ['h1', 'H', -66, 44], ['h2', 'H', 66, 44], ['h3', 'H', 0, -74]]), bonds: [{ a: 'o', b: 'h1', order: 1 }, { a: 'o', b: 'h2', order: 1 }, { a: 'o', b: 'h3', order: 1 }], lonePairs: { o: 1 }, charges: { o: 1 }, netCharge: 1 },
  'OH-': { name: 'Hiđroxit', shape: 'Phân tử hai nguyên tử (ion)', atoms: atomsAt([['o', 'O', -34, 0], ['h', 'H', 40, 0]]), bonds: [{ a: 'o', b: 'h', order: 1 }], lonePairs: { o: 3 }, charges: { o: -1 }, netCharge: -1 }
};
const LIB_KEYS = Object.keys(LIB);

// ---------------------------------------------------------------- Hợp chất ion nhị phân (kiểm tra cân bằng điện tích)
const CATION = { Li: 1, Na: 1, K: 1, Rb: 1, Ag: 1, Mg: 2, Ca: 2, Sr: 2, Zn: 2, Al: 3 };
const ANION = { F: -1, Cl: -1, Br: -1, I: -1, O: -2, S: -2, N: -3, P: -3 };
function ionicFromFormula(formula) {
  const m = /^([A-Z][a-z]?)(\d*)([A-Z][a-z]?)(\d*)$/.exec(formula);
  if (!m) return null;
  const cs = m[1]; const ca = m[2] ? Number(m[2]) : 1; const as = m[3]; const aa = m[4] ? Number(m[4]) : 1;
  if (!(cs in CATION) || !(as in ANION)) return null;
  const qc = CATION[cs]; const qa = ANION[as];
  if (ca * qc + aa * qa !== 0) return { error: { code: 'charge_imbalance', detail: `${formula}: ${ca}×(+${qc}) + ${aa}×(${qa}) = ${ca * qc + aa * qa} ≠ 0 — công thức không trung hoà điện tích.` } };
  return { cation: cs, anion: as, nCation: ca, nAnion: aa, qc, qa };
}

// ---------------------------------------------------------------- Rendering: nguyên tử / ion
const CW = 720; const CH = 440;
function orbitalRows(cfg) {
  return Object.keys(cfg).sort(subOrder).map((sub) => {
    const boxes = { s: 1, p: 3, d: 5 }[sub[1]]; const e = cfg[sub]; const fill = new Array(boxes).fill(0);
    for (let i = 0; i < e; i++) fill[i % boxes] += 1; // Hund: mỗi obitan 1 electron trước, rồi mới ghép cặp
    if (e > boxes) { for (let i = 0; i < boxes; i++) fill[i] = i < e - boxes ? 2 : 1; }
    return { sub, boxes, fill };
  });
}
function upArrow(cv, x, y, h, col) { cv.add(K.path(`M${K.num(x)},${K.num(y + h)} L${K.num(x)},${K.num(y)} M${K.num(x - 3.4)},${K.num(y + 4.6)} L${K.num(x)},${K.num(y)} L${K.num(x + 3.4)},${K.num(y + 4.6)}`, { stroke: col, w: 1.6 })); }
function downArrow(cv, x, y, h, col) { cv.add(K.path(`M${K.num(x)},${K.num(y)} L${K.num(x)},${K.num(y + h)} M${K.num(x - 3.4)},${K.num(y + h - 4.6)} L${K.num(x)},${K.num(y + h)} L${K.num(x + 3.4)},${K.num(y + h - 4.6)}`, { stroke: col, w: 1.6 })); }

function renderAtom(atom) {
  const cv = new Canvas(CW, CH);
  const label = `${atom.element}${chargeLabel(atom.charge)}`;
  cv.title = `${atom.charge ? 'Ion' : 'Nguyên tử'} ${label} (${atom.nameVi})`;
  cv.desc = `${cv.title}: Z = ${atom.atomicNumber}, A = ${atom.massNumber}, ${atom.protons} proton, ${atom.neutrons} nơtron, ${atom.electrons} electron; lớp electron ${atom.shells.join(', ')}; cấu hình ${atom.electronConfiguration}.`;
  const cx = 190; const cy = 230; const nShells = Math.max(1, atom.shells.length);
  const rMax = 168; const rMin = 52; const step = nShells > 1 ? Math.min(34, (rMax - rMin) / (nShells - 1)) : 0;
  const rs = atom.shells.map((_, i) => rMin + i * step);
  // vỏ
  rs.forEach((r) => cv.add(K.circle(cx, cy, r, { stroke: '#94a3b8', w: 1.4 })));
  // hạt nhân
  cv.add(K.circle(cx, cy, 30, { fill: '#fee2e2', stroke: COLORS.RED, w: 2.2 }));
  cv.add(K.text(cx, cy - 3, `${atom.protons}p⁺`, { size: 13, bold: true, color: COLORS.RED }));
  cv.add(K.text(cx, cy + 13, `${atom.neutrons}n`, { size: 13, bold: true, color: COLORS.MUTED }));
  // electron: phân bố đều theo góc, mỗi lớp xoay lệch cố định (tất định)
  atom.shells.forEach((cnt, i) => {
    for (let k = 0; k < cnt; k++) {
      const ang = -Math.PI / 2 + (2 * Math.PI * k) / cnt + i * 0.31;
      cv.add(K.circle(cx + rs[i] * Math.cos(ang), cy + rs[i] * Math.sin(ang), 5, { fill: COLORS.BLUE, stroke: '#1e3a8a', w: 1 }));
    }
    cv.add(K.text(cx + rs[i] * 0.72, cy - rs[i] * 0.72 - 6, `${cnt}e`, { size: 11, color: COLORS.MUTED, anchor: 'start' }));
  });
  cv.add(K.text(cx, 34, `${label}`, { size: 22, bold: true }));
  cv.add(K.text(cx, 56, `Mô hình Bohr — ${nShells} lớp electron (K, L, M, ...)`, { size: 12, color: COLORS.MUTED }));
  // thông tin
  const x0 = 420; let y = 44;
  cv.add(K.text(x0, y, `${atom.element}${chargeLabel(atom.charge)} — ${atom.nameVi}`, { size: 20, bold: true, anchor: 'start' })); y += 26;
  const rows = [
    `Z = ${atom.atomicNumber}   ·   A = ${atom.massNumber}${atom.massGiven ? '' : ' (đồng vị phổ biến nhất)'}`,
    `p = ${atom.protons}   ·   n = ${atom.neutrons}   ·   e = ${atom.electrons}`,
    `Cấu hình: ${configString(atom.config)}`,
    `Số electron mỗi lớp: ${atom.shells.join(' | ')}`,
    atom.valenceElectrons != null ? `Electron hoá trị: ${atom.valenceElectrons}` : `Electron lớp ngoài cùng: ${atom.outerShellElectrons}`
  ];
  rows.forEach((t) => { cv.add(K.text(x0, y, t, { size: 13.5, anchor: 'start' })); y += 21; });
  if (atom.charge) { cv.add(K.text(x0, y, `Điện tích ${atom.charge > 0 ? '+' : ''}${atom.charge}: ${atom.charge > 0 ? `mất ${atom.charge} electron` : `nhận ${-atom.charge} electron`} (e = Z ${atom.charge > 0 ? '−' : '+'} ${Math.abs(atom.charge)})`, { size: 12, color: COLORS.ORANGE, anchor: 'start' })); y += 20; }
  // giản đồ obitan
  y += 10; cv.add(K.text(x0, y, 'Sơ đồ obitan (quy tắc Hund, nguyên lí Pauli):', { size: 12, bold: true, anchor: 'start', color: COLORS.MUTED })); y += 14;
  const orb = orbitalRows(atom.config); const perCol = Math.ceil(orb.length / 2); const colW = 150; const rowH = 24;
  orb.forEach((row, i) => {
    const col = Math.floor(i / perCol); const r = i % perCol; const bx = x0 + col * colW + 30; const by = y + r * rowH;
    cv.add(K.text(bx - 6, by + 15, row.sub, { size: 12, bold: true, anchor: 'end' }));
    for (let b = 0; b < row.boxes; b++) {
      const x = bx + b * 20; cv.add(K.rect(x, by, 20, 20, { fill: '#fff', stroke: COLORS.INK, w: 1.3 }));
      const n = row.fill[b];
      if (n === 1) upArrow(cv, x + 10, by + 3, 14, COLORS.BLUE);
      if (n === 2) { upArrow(cv, x + 6.5, by + 3, 14, COLORS.BLUE); downArrow(cv, x + 13.5, by + 3, 14, COLORS.RED); }
    }
  });
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

// ---------------------------------------------------------------- Rendering: Lewis
const R_ATOM = 15;
function slotAngles(atomPos, bondDirs, count) {
  // Chọn tổ hợp `count` hướng (bước 30°) sao cho khoảng cách góc tới liên kết/cặp khác lớn nhất
  // (khoảng cách nhỏ nhất trước, rồi độ đều của các khoảng trống) — tất định, không random.
  void atomPos;
  const cand = []; for (let a = 0; a < 360; a += 30) cand.push(a);
  const gapsOf = (dirs) => { const s = [...dirs].sort((x, y) => x - y); return s.map((d, i) => (i === s.length - 1 ? s[0] + 360 - d : s[i + 1] - d)); };
  let best = null; let bestKey = null;
  const rec = (start, chosen) => {
    if (chosen.length === count) {
      const all = [...bondDirs, ...chosen]; const g = all.length > 1 ? gapsOf(all) : [360];
      const minGap = Math.min(...g); const mean = g.reduce((x, y) => x + y, 0) / g.length; const varc = g.reduce((x, y) => x + (y - mean) ** 2, 0) / g.length;
      const minBond = bondDirs.length ? Math.min(...chosen.map((c) => Math.min(...bondDirs.map((bd) => { const d = Math.abs(c - bd) % 360; return d > 180 ? 360 - d : d; })))) : 180;
      const key = [minGap, minBond, -varc];
      if (!bestKey || key[0] > bestKey[0] + 1e-9 || (Math.abs(key[0] - bestKey[0]) < 1e-9 && (key[1] > bestKey[1] + 1e-9 || (Math.abs(key[1] - bestKey[1]) < 1e-9 && key[2] > bestKey[2] + 1e-9)))) { best = chosen.slice(); bestKey = key; }
      return;
    }
    for (let i = start; i < cand.length; i++) { chosen.push(cand[i]); rec(i + 1, chosen); chosen.pop(); }
  };
  rec(0, []);
  return best || [];
}
function lewisBody(cv, mol, view) {
  const pos = {}; mol.atoms.forEach((a) => { pos[a.id] = view(a); });
  const ang = (p, q) => { const d = Math.atan2(-(q[1] - p[1]), q[0] - p[0]); return ((d * 180 / Math.PI) + 360) % 360; };
  const dirs = {}; mol.atoms.forEach((a) => { dirs[a.id] = []; });
  mol.bonds.forEach((b) => { dirs[b.a].push(ang(pos[b.a], pos[b.b])); dirs[b.b].push(ang(pos[b.b], pos[b.a])); });
  // liên kết
  mol.bonds.forEach((b) => {
    const p = pos[b.a]; const q = pos[b.b]; const d = K.unit(K.sub(q, p)); const n = [-d[1], d[0]];
    const s = K.add(p, K.mul(d, R_ATOM)); const e = K.sub(q, K.mul(d, R_ATOM));
    const offs = b.order === 1 ? [0] : (b.order === 2 ? [-3.5, 3.5] : [-6, 0, 6]);
    offs.forEach((o) => cv.add(K.line(s[0] + n[0] * o, s[1] + n[1] * o, e[0] + n[0] * o, e[1] + n[1] * o, { w: 2.2 })));
  });
  // cặp electron tự do
  mol.atoms.forEach((a) => {
    const cnt = (mol.lonePairs || {})[a.id] || 0; if (!cnt) return;
    const slots = slotAngles(pos[a.id], dirs[a.id], cnt);
    slots.forEach((sa) => {
      const r = 25; const t = K.rad(sa); const c = [pos[a.id][0] + r * Math.cos(t), pos[a.id][1] - r * Math.sin(t)]; const tang = [-Math.sin(t) * -1, -Math.cos(t) * -1];
      const tx = Math.sin(t); const ty = Math.cos(t);
      cv.add(K.circle(c[0] + tx * 4.2, c[1] + ty * 4.2, 2.6, { fill: COLORS.BLUE, stroke: COLORS.BLUE, w: 0.5 })); cv.add(K.circle(c[0] - tx * 4.2, c[1] - ty * 4.2, 2.6, { fill: COLORS.BLUE, stroke: COLORS.BLUE, w: 0.5 }));
      void tang;
    });
  });
  // nguyên tử + điện tích hình thức
  mol.atoms.forEach((a) => {
    const p = pos[a.id]; cv.add(K.circle(p[0], p[1], 12.5, { fill: '#fff', stroke: 'none', w: 0 }));
    cv.add(K.text(p[0], p[1] + 8, a.el, { size: 25, bold: true }));
    const c = (mol.charges || {})[a.id];
    if (c) { const lx = p[0] + 17; const ly = p[1] - 15; cv.add(K.circle(lx, ly, 8, { fill: '#fff', stroke: c > 0 ? COLORS.RED : COLORS.BLUE, w: 1.4 })); cv.add(K.text(lx, ly + 4.5, c > 0 ? (c > 1 ? `${c}+` : '+') : (c < -1 ? `${-c}−` : '−'), { size: 11, bold: true, color: c > 0 ? COLORS.RED : COLORS.BLUE })); }
  });
  return pos;
}
function renderMolecule(mol, meta = {}) {
  const v = validateMolecule(mol);
  if (!v.ok) { const e = new Error(`chemistry_validation_failed:${v.errors.map((x) => x.code).join(',')}`); e.code = 'chemistry_validation_failed'; e.errors = v.errors; throw e; }
  if (mol.atoms.some((a) => typeof a.x !== 'number' || typeof a.y !== 'number')) { const e = new Error('chemistry_layout_required'); e.code = 'chemistry_layout_required'; throw e; }
  const w = 560; const h = 380; const cv = new Canvas(w, h);
  const xs = mol.atoms.map((a) => a.x); const ys = mol.atoms.map((a) => a.y);
  const minX = Math.min(...xs) - 44; const maxX = Math.max(...xs) + 44; const minY = Math.min(...ys) - 44; const maxY = Math.max(...ys) + 44;
  const sc = Math.min(1.35, (w - 150) / (maxX - minX), (h - 200) / (maxY - minY));
  const ox = w / 2 - ((minX + maxX) / 2) * sc; const oy = 196 - ((minY + maxY) / 2) * sc;
  const view = (a) => [ox + a.x * sc, oy + a.y * sc];
  const formula = meta.formula || mol.formula || mol.atoms.map((a) => a.el).join('');
  cv.title = `Cấu trúc Lewis của ${fmtFormula(formula)}${meta.name ? ` (${meta.name})` : ''}`;
  cv.desc = `${cv.title}. Tổng electron hoá trị ${v.electrons.valenceTotal}: ${v.electrons.bonding} electron ở liên kết, ${v.electrons.nonbonding} electron không liên kết.`;
  const pos = lewisBody(cv, mol, view);
  if (mol.netCharge) {
    const px = Object.values(pos); const l = Math.min(...px.map((p) => p[0])) - 52; const r = Math.max(...px.map((p) => p[0])) + 52; const t = Math.min(...px.map((p) => p[1])) - 46; const b = Math.max(...px.map((p) => p[1])) + 46;
    cv.add(K.path(`M${K.num(l + 12)},${K.num(t)} L${K.num(l)},${K.num(t)} L${K.num(l)},${K.num(b)} L${K.num(l + 12)},${K.num(b)}`, { w: 2 }));
    cv.add(K.path(`M${K.num(r - 12)},${K.num(t)} L${K.num(r)},${K.num(t)} L${K.num(r)},${K.num(b)} L${K.num(r - 12)},${K.num(b)}`, { w: 2 }));
    cv.add(K.text(r + 8, t + 14, `${Math.abs(mol.netCharge) > 1 ? Math.abs(mol.netCharge) : ''}${mol.netCharge > 0 ? '+' : '−'}`, { size: 18, bold: true, anchor: 'start' }));
  }
  cv.add(K.text(w / 2, 34, `${fmtFormula(formula)}${meta.name ? ` — ${meta.name}` : ''}`, { size: 20, bold: true }));
  if (meta.shape) cv.add(K.text(w / 2, 56, `Hình học: ${meta.shape}`, { size: 12.5, color: COLORS.MUTED }));
  const e = v.electrons;
  cv.add(K.text(24, h - 42, `Tổng electron hoá trị: ${e.valenceTotal}   ·   trong liên kết: ${e.bonding}   ·   cặp electron tự do: ${e.nonbonding / 2} cặp (${e.nonbonding} e)`, { size: 12.5, color: COLORS.MUTED, anchor: 'start' }));
  cv.add(K.text(24, h - 22, `Gạch = cặp electron liên kết; chấm đôi = cặp electron tự do; vòng nhỏ = điện tích hình thức.`, { size: 11.5, color: COLORS.MUTED, anchor: 'start' }));
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc, validation: v };
}

function renderLewisAtom(atom) {
  const cv = new Canvas(360, 300);
  const v = atom.valenceElectrons != null ? atom.valenceElectrons : atom.outerShellElectrons;
  cv.title = `Ký hiệu chấm Lewis của ${atom.element}${chargeLabel(atom.charge)}`; cv.desc = `${cv.title}: ${v} electron lớp ngoài cùng.`;
  const cx = 180; const cy = 140;
  const sides = [[0, -1], [1, 0], [0, 1], [-1, 0]]; const count = new Array(4).fill(0);
  let left = v;
  if (v <= 2) count[0] = v; else { for (let i = 0; i < 4 && left > 0; i++) { count[i] += 1; left -= 1; } for (let i = 0; i < 4 && left > 0; i++) { count[i] += 1; left -= 1; } }
  const inner = atom.charge ? 8 : 0; void inner;
  cv.add(K.text(cx, cy + 10, atom.element, { size: 40, bold: true }));
  sides.forEach(([dx, dy], i) => {
    const r = i % 2 === 0 ? 36 : 40; const px = cx + dx * r; const py = cy - 4 + dy * r; const tx = dy !== 0 ? 1 : 0; const ty = dx !== 0 ? 1 : 0;
    if (count[i] >= 1) cv.add(K.circle(px - (count[i] === 2 ? tx * 5 : 0), py - (count[i] === 2 ? ty * 5 : 0), 3.6, { fill: COLORS.BLUE, stroke: COLORS.BLUE, w: 0.5 }));
    if (count[i] === 2) cv.add(K.circle(px + tx * 5, py + ty * 5, 3.6, { fill: COLORS.BLUE, stroke: COLORS.BLUE, w: 0.5 }));
  });
  if (atom.charge) { cv.add(K.path(`M${K.num(cx - 62)},${K.num(cy - 66)} L${K.num(cx - 74)},${K.num(cy - 66)} L${K.num(cx - 74)},${K.num(cy + 66)} L${K.num(cx - 62)},${K.num(cy + 66)}`, { w: 2 })); cv.add(K.path(`M${K.num(cx + 62)},${K.num(cy - 66)} L${K.num(cx + 74)},${K.num(cy - 66)} L${K.num(cx + 74)},${K.num(cy + 66)} L${K.num(cx + 62)},${K.num(cy + 66)}`, { w: 2 })); cv.add(K.text(cx + 82, cy - 56, `${Math.abs(atom.charge) > 1 ? Math.abs(atom.charge) : ''}${atom.charge > 0 ? '+' : '−'}`, { size: 20, bold: true, anchor: 'start' })); }
  cv.add(K.text(cx, 250, `${atom.element}${chargeLabel(atom.charge)} — ${v} electron lớp ngoài cùng`, { size: 13, color: COLORS.MUTED }));
  cv.add(K.text(cx, 30, `Ký hiệu chấm Lewis`, { size: 15, bold: true }));
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

function renderIonic(ion, formula) {
  const items = [];
  for (let i = 0; i < ion.nCation; i++) items.push({ sym: ion.cation, q: ion.qc });
  for (let i = 0; i < ion.nAnion; i++) items.push({ sym: ion.anion, q: ion.qa });
  const w = Math.max(560, items.length * 150 + 60); const cv = new Canvas(w, 320);
  cv.title = `Liên kết ion trong ${fmtFormula(formula)}`; cv.desc = `${cv.title}: ${ion.nCation} ion ${ion.cation}${chargeLabel(ion.qc)} và ${ion.nAnion} ion ${ion.anion}${chargeLabel(ion.qa)}.`;
  const x0 = (w - items.length * 150) / 2 + 75;
  items.forEach((it, i) => {
    const cx = x0 + i * 150; const cy = 150; const isAnion = it.q < 0;
    cv.add(K.path(`M${K.num(cx - 42)},${K.num(cy - 50)} L${K.num(cx - 54)},${K.num(cy - 50)} L${K.num(cx - 54)},${K.num(cy + 50)} L${K.num(cx - 42)},${K.num(cy + 50)}`, { w: 2 }));
    cv.add(K.path(`M${K.num(cx + 42)},${K.num(cy - 50)} L${K.num(cx + 54)},${K.num(cy - 50)} L${K.num(cx + 54)},${K.num(cy + 50)} L${K.num(cx + 42)},${K.num(cy + 50)}`, { w: 2 }));
    cv.add(K.text(cx, cy + 10, it.sym, { size: 32, bold: true }));
    cv.add(K.text(cx + 62, cy - 34, `${Math.abs(it.q) > 1 ? Math.abs(it.q) : ''}${it.q > 0 ? '+' : '−'}`, { size: 20, bold: true, anchor: 'start', color: it.q > 0 ? COLORS.RED : COLORS.BLUE }));
    if (isAnion) { // 8 electron lớp ngoài (4 cặp) — anion đạt octet
      [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([dx, dy]) => { const px = cx + dx * 34; const py = cy - 6 + dy * 34; const tx = dy !== 0 ? 1 : 0; const ty = dx !== 0 ? 1 : 0; cv.add(K.circle(px - tx * 4.5, py - ty * 4.5, 3.2, { fill: COLORS.BLUE, stroke: COLORS.BLUE, w: 0.5 })); cv.add(K.circle(px + tx * 4.5, py + ty * 4.5, 3.2, { fill: COLORS.BLUE, stroke: COLORS.BLUE, w: 0.5 })); });
    }
  });
  const ca = BY_SYMBOL[ion.cation]; const an = BY_SYMBOL[ion.anion];
  cv.add(K.text(w / 2, 34, `${fmtFormula(formula)}`, { size: 20, bold: true }));
  cv.add(K.text(w / 2, 252, `${ion.cation} → ${ion.cation}${chargeLabel(ion.qc)} + ${ion.qc}e     ·     ${ion.anion} + ${-ion.qa}e → ${ion.anion}${chargeLabel(ion.qa)}`, { size: 13.5, color: COLORS.MUTED }));
  cv.add(K.text(w / 2, 276, `Tổng điện tích: ${ion.nCation}×(+${ion.qc}) + ${ion.nAnion}×(${ion.qa}) = 0  (${ca.nameVi}/${an.nameVi})`, { size: 12.5, color: COLORS.MUTED }));
  return { svg: cv.toSvg(), title: cv.title, desc: cv.desc };
}

// ---------------------------------------------------------------- Trích xuất từ đề bài
function normalizeChem(s) {
  return String(s)
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(c)))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)))
    .replace(/⁺/g, '+').replace(/⁻/g, '-').replace(/[−–]/g, '-').replace(/\^/g, '');
}
function extractChemistry(original) {
  const raw = normalizeChem(original); const f = U.fold(raw); const lower = f.toLowerCase();
  const wantsLewis = /lewis|cong thuc electron|cong thuc cau tao|lien ket|phan tu\b|cau truc phan tu|molecule|bonding|lien ket ion|hop chat ion/.test(lower);
  const wantsAtom = /cau hinh electron|lop electron|phan lop|obitan|orbital|mo hinh|cau tao nguyen tu|so do nguyen tu|electron hoa tri|vo electron|electron configuration|bohr|proton|neutron|notron|so hieu|so khoi|nguyen tu\b|\bion\b|atom\b|z\s*=|dien tich hat nhan|electron/.test(lower);
  const wantsDot = /ky hieu (?:cham )?lewis|electron dot|cong thuc electron cua nguyen tu|cham lewis/.test(lower) || (/lewis/.test(lower) && !/phan tu|lien ket/.test(lower));

  // 1) phân tử / ion đa nguyên tử trong thư viện
  const formulaTok = /(?<![A-Za-z0-9])((?:NH4|H3O|OH)[+-]|(?:[A-Z][a-z]?\d*){1,5})(?![A-Za-z0-9])/g;
  const cand = []; let m;
  while ((m = formulaTok.exec(raw))) { let t = m[1]; { const nx0 = raw[m.index + t.length]; if ((nx0 === '+' || nx0 === '-') && !/^(NH4|H3O|OH)$/.test(t) && !/[+-]$/.test(t)) continue; } if (/^(NH4|H3O|OH)$/.test(t)) { const nx = raw[m.index + t.length]; if (nx === '+' || nx === '-') t += nx; } if (LIB[t] || (ionicFromFormula(t) && /[A-Z][a-z]?\d*[A-Z]/.test(t))) cand.push({ t, i: m.index }); }
  const target = /(?:lewis|cong thuc electron|cong thuc cau tao|cau truc|lien ket|phan tu|molecule|cua|for|of)\s*(?:cua\s*)?(?:phan tu|ion|hop chat)?\s*((?:NH4|H3O|OH)[+-]|(?:[A-Z][a-z]?\d*){1,5})(?![A-Za-z0-9])/.exec(raw);
  const uniq = [...new Set(cand.map((c) => c.t))];
  let formula = null;
  if (target && (LIB[target[1]] || ionicFromFormula(target[1]))) formula = target[1];
  else if (uniq.length === 1) formula = uniq[0];
  if (formula && (wantsLewis || /\b(ve|so do|minh hoa|draw|hinh ve)\b/.test(lower))) {
    if (LIB[formula]) return { kind: 'molecule', formula };
    const ion = ionicFromFormula(formula);
    if (ion && ion.error) return { kind: 'ionic', formula, error: ion.error };
    if (ion) return { kind: 'ionic', formula, ion };
  }
  // ionic charge imbalance for formulas with explicit "liên kết ion"
  if (uniq.length >= 1 && /lien ket ion|hop chat ion/.test(lower)) { const t = uniq.find((x) => ionicFromFormula(x)); if (t) { const ion = ionicFromFormula(t); return ion.error ? { kind: 'ionic', formula: t, error: ion.error } : { kind: 'ionic', formula: t, ion }; } }

  // 2) nguyên tử / ion đơn nguyên tử
  if (!wantsAtom && !wantsDot) return null;
  const facts = {};
  const zm = /(?:\bZ\s*=\s*|so hieu nguyen tu\s*(?:\(?Z\)?)?\s*(?:=|bang|la)?\s*|dien tich hat nhan\s*(?:=|bang|la)?\s*\+?)(\d{1,3})/i.exec(f);
  if (zm) facts.Z = Number(zm[1]);
  const pm = /(\d{1,3})\s*proton/i.exec(f); if (pm) facts.protons = Number(pm[1]);
  const nm = /(\d{1,3})\s*(?:neutron|notron|nowtron)/i.exec(f); if (nm) facts.neutrons = Number(nm[1]);
  const em = /(\d{1,3})\s*electron/i.exec(f); if (em) facts.electrons = Number(em[1]);
  const am = /(?:so khoi\s*(?:\(?A\)?)?\s*(?:=|bang|la)?\s*|\bA\s*=\s*)(\d{1,3})/i.exec(f); if (am) facts.massNumber = Number(am[1]);
  // ký hiệu: ion có điện tích trước
  const symRe = /(?<![A-Za-z])([A-Z][a-z]?)(\d?)([+-])(?![A-Za-z0-9])/g; let sm; let ionSym = null;
  while ((sm = symRe.exec(raw))) { if (BY_SYMBOL[sm[1]] && !ionSym) { ionSym = { symbol: sm[1], charge: (sm[3] === '+' ? 1 : -1) * (sm[2] ? Number(sm[2]) : 1) }; } }
  if (!ionSym) {
    // Ký pháp dấu-trước: "Cl+7", "Fe+3", "O-2". '-' + số ≥ Z là ĐỒNG VỊ (Na-23, Li-7) chứ không phải điện tích.
    const sf = /(?<![A-Za-z0-9])([A-Z][a-z]?)([+-])(\d{1,2})(?![A-Za-z0-9])/.exec(raw);
    if (sf && BY_SYMBOL[sf[1]]) { const n = Number(sf[3]); if (sf[2] === '+' || n < BY_SYMBOL[sf[1]].Z) ionSym = { symbol: sf[1], charge: (sf[2] === '+' ? 1 : -1) * n }; }
  }
  if (ionSym) { facts.symbol = ionSym.symbol; facts.charge = ionSym.charge; }
  const cm = /(?:dien tich|charge)\s*(?:=|la)?\s*([+-]?\d)\s*([+-])?/i.exec(f);
  if (cm && facts.charge == null) { const n = Number(cm[1]); facts.charge = cm[2] ? (cm[2] === '-' ? -Math.abs(n) : Math.abs(n)) : n; }
  const iso = /(?<![A-Za-z0-9])([A-Z][a-z]?)-(\d{1,3})(?![A-Za-z0-9])/.exec(raw) || /(?<![A-Za-z0-9])(\d{1,3})([A-Z][a-z]?)(?![a-z0-9])/.exec(raw);
  if (!facts.symbol && iso) { if (BY_SYMBOL[iso[1]] && /^\d+$/.test(iso[2])) { facts.symbol = iso[1]; facts.massNumber = facts.massNumber ?? Number(iso[2]); } else if (BY_SYMBOL[iso[2]] && /^\d+$/.test(iso[1])) { facts.symbol = iso[2]; facts.massNumber = facts.massNumber ?? Number(iso[1]); } }
  if (!facts.symbol) {
    // tên nguyên tố (tiếng Việt / Anh, đã bỏ dấu)
    const names = Object.keys(BY_NAME).sort((a, b) => b.length - a.length);
    const nmH = names.find((n) => new RegExp(`(?:^|[^a-z])${n}(?![a-z])`).test(lower));
    if (nmH) facts.symbol = BY_NAME[nmH].symbol;
  }
  if (!facts.symbol) {
    // "Na có Z = 12", "Na có 11 proton" — ký hiệu đứng ngay trước mệnh đề dữ kiện (kể cả khi đã có Z/proton để bắt mâu thuẫn).
    const has = /(?<![A-Za-z0-9])([A-Z][a-z]?)\s+(?:co|has|with)\s+(?:so hieu|Z\b|\d{1,3}\s*(?:proton|electron|notron|neutron))/.exec(f);
    if (has && BY_SYMBOL[has[1]]) facts.symbol = has[1];
  }
  if (!facts.symbol && facts.Z == null && facts.protons == null) {
    const ctx = /(?:cua|nguyen to|nguyen tu|ion|atom of|for|element)\s+(?:nguyen tu\s+|nguyen to\s+)?([A-Z][a-z]?)(?![A-Za-z])/.exec(f);
    if (ctx && BY_SYMBOL[ctx[1]]) facts.symbol = ctx[1];
    else { const toks = [...f.matchAll(/(?<![A-Za-z0-9])([A-Z][a-z]?)(?![A-Za-z0-9])/g)].map((x) => x[1]).filter((t) => BY_SYMBOL[t] && !['I', 'A'].includes(t)); if (toks.length === 1) facts.symbol = toks[0]; }
  }
  if (!facts.symbol && facts.Z == null && facts.protons == null) return null;
  if (/nguyen tu\b|\batom\b/.test(lower) && !/\bion\b/.test(lower) && facts.charge == null) facts.assumeNeutral = true;
  if (wantsDot && !/cau hinh|bohr|lop electron|proton/.test(lower)) return { kind: 'lewis_atom', facts };
  return { kind: 'atom', facts };
}

function buildChemistry(spec) {
  if (spec.kind === 'atom' || spec.kind === 'lewis_atom') {
    const r = buildAtom(spec.facts);
    if (!r.ok) return { ok: false, errors: r.errors };
    const out = spec.kind === 'atom' ? renderAtom(r.atom) : renderLewisAtom(r.atom);
    return { ok: true, ...out, data: r.atom, category: spec.kind === 'atom' ? 'chemistry_atom' : 'chemistry_lewis_atom' };
  }
  if (spec.kind === 'molecule') {
    const lib = LIB[spec.formula]; if (!lib) return { ok: false, errors: [{ code: 'molecule_not_supported', detail: spec.formula }] };
    try { const out = renderMolecule({ ...lib, formula: spec.formula }, { formula: spec.formula, name: lib.name, shape: lib.shape }); return { ok: true, ...out, data: { formula: spec.formula }, category: 'chemistry_lewis' }; }
    catch (e) { return { ok: false, errors: e.errors || [{ code: e.code || 'render_failed', detail: e.message }] }; }
  }
  if (spec.kind === 'ionic') {
    if (spec.error) return { ok: false, errors: [spec.error] };
    return { ok: true, ...renderIonic(spec.ion, spec.formula), data: { formula: spec.formula, ...spec.ion }, category: 'chemistry_ionic' };
  }
  if (spec.kind === 'structured') { // dữ liệu có cấu trúc từ nguồn ngoài (vd. AI extraction)
    try { const out = renderMolecule(spec.molecule, { formula: spec.molecule.formula }); return { ok: true, ...out, data: { formula: spec.molecule.formula }, category: 'chemistry_lewis' }; }
    catch (e) { return { ok: false, errors: e.errors || [{ code: e.code || 'render_failed', detail: e.message }] }; }
  }
  return { ok: false, errors: [{ code: 'unknown_kind', detail: String(spec.kind) }] };
}

module.exports = {
  extractChemistry, buildChemistry, buildAtom, validateMolecule, renderMolecule, renderAtom, ionicFromFormula,
  neutralConfig, ionConfig, shellsOf, configPlain, ELEMENTS, BY_SYMBOL, LIB_KEYS, LIB
};
