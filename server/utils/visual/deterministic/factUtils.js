'use strict';

// Tiện ích trích xuất dữ kiện (0 token, 0 mạng) dùng chung cho geometry/physics/chemistry.
// fold() bỏ dấu tiếng Việt THEO TỪNG KÝ TỰ nên độ dài chuỗi không đổi -> chỉ số regex trên bản fold
// vẫn trỏ đúng vào chuỗi gốc (cần khi phải lấy tên điểm viết HOA như "ABC" từ đề bài).

function foldChar(c) {
  if (c === 'đ') return 'd';
  if (c === 'Đ') return 'D';
  const f = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return f.length === 1 ? f : c;
}
function fold(s) {
  return Array.from(String(s == null ? '' : s)).map(foldChar).join('');
}

const NUM_SRC = '(\\d+(?:[.,]\\d+)?)';
function toNum(s) {
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function isUpperName(s) { return /^[A-Z]+$/.test(s); }
function sortPair(a, b) { return a < b ? a + b : b + a; }

/** Trích mọi ràng buộc độ dài dạng "AB = 3", "AB = AC = 5", "AB dài 3cm". @returns {Object<string,number>} khoá là cặp đã sắp xếp. */
function extractLengths(folded) {
  const out = {};
  const re = new RegExp(`((?:\\b[A-Z]{2}\\b\\s*(?:=|bang|dai|la)\\s*)+)${NUM_SRC}\\s*(?:cm|mm|dm|km|m\\b)?`, 'g');
  let m;
  while ((m = re.exec(folded))) {
    const val = toNum(m[2]);
    if (val == null) continue;
    const names = m[1].match(/\b[A-Z]{2}\b/g) || [];
    names.forEach((n) => { out[sortPair(n[0], n[1])] = val; });
  }
  return out;
}

/** Trích góc: "góc A = 60°", "∠BAC = 45", "A = 60°". @returns {Object<string,number>} khoá = đỉnh. */
function extractAngles(folded) {
  const out = {};
  let m;
  const re1 = new RegExp(`(?:goc|∠)\\s*([A-Z]{1,3})\\s*(?:=|bang|la)\\s*${NUM_SRC}\\s*(?:°|do\\b|deg)?`, 'gi');
  while ((m = re1.exec(folded))) {
    const name = m[1];
    if (!isUpperName(name)) continue;
    const v = toNum(m[2]);
    if (v == null) continue;
    out[name.length === 3 ? name[1] : name[0]] = v;
  }
  const re2 = new RegExp(`\\b([A-Z])\\s*=\\s*${NUM_SRC}\\s*(?:°|độ|do\\b)`, 'g');
  while ((m = re2.exec(folded))) {
    const v = toNum(m[2]);
    if (v != null && out[m[1]] === undefined) out[m[1]] = v;
  }
  return out;
}

/** Điểm có toạ độ: A(1;2), B(-3, 4). @returns {Array<{name:string,x:number,y:number}>} */
function extractPoints(folded) {
  const out = []; const seen = new Set();
  const re = /\b([A-Z][A-Za-z]?\d?)\s*\(\s*([+-]?\d+(?:[.,]\d+)?)\s*[;,]\s*([+-]?\d+(?:[.,]\d+)?)\s*\)/g;
  let m;
  while ((m = re.exec(folded))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ name: m[1], x: toNum(m[2]), y: toNum(m[3]) });
  }
  return out;
}

/** Số kèm đơn vị: valueOf(text, ['m','khoi luong'], ['kg']) -> số đầu tiên. */
function findQuantity(folded, symbolRe, unitRe) {
  const re = new RegExp(`(?:${symbolRe})\\s*(?:=|bang|la|:)?\\s*${NUM_SRC}\\s*(?:${unitRe})`, 'i');
  const m = re.exec(folded);
  return m ? toNum(m[1]) : null;
}

function has(folded, re) { return re.test(folded); }

module.exports = { fold, foldChar, toNum, NUM_SRC, isUpperName, sortPair, extractLengths, extractAngles, extractPoints, findQuantity, has };
