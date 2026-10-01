'use strict';

// P2 — Placeholder ô tìm nguồn từng hiện nguyên key "sources.searchPlaceholder".
// Hai lớp nguyên nhân, mỗi lớp một nhóm test riêng:
//   1. DỮ LIỆU: mọi key trong data-i18n* của public/index.html phải có bản dịch ở MỌI ngôn ngữ.
//   2. HÀNH VI: khi vẫn thiếu bản dịch, applyStaticTranslations() phải GIỮ giá trị sẵn có trong HTML
//      (fallback tiếng Việt) thay vì ghi đè bằng chính key; nhưng bản dịch cố ý là chuỗi rỗng thì vẫn
//      phải được áp dụng.
// Chạy: node test/i18n-static-keys.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const translationsSrc = fs.readFileSync(path.join(root, 'public/js/i18n/translations.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(root, 'public/js/i18n/i18n.js'), 'utf8');

// ---------------------------------------------------------------- 1. DỮ LIỆU
const sandbox = { window: {} };
vm.runInNewContext(translationsSrc, sandbox);
const TRANSLATIONS = sandbox.window.TRANSLATIONS;

const ATTR_RE = /\sdata-i18n(?:-(?:html|placeholder|title|aria-label))?="([^"]+)"/g;
const keys = [...new Set([...html.matchAll(ATTR_RE)].map((m) => m[1]))].sort();
const langs = Object.keys(TRANSLATIONS);

test('index.html có key data-i18n* và translations.js có ít nhất vi + en', () => {
  assert.ok(keys.length > 50, `chỉ tìm thấy ${keys.length} key — regex có thể đã hỏng`);
  assert.ok(langs.includes('vi') && langs.includes('en'), `ngôn ngữ hiện có: ${langs.join(',')}`);
});

langs.forEach((lang) => {
  test(`mọi key data-i18n* trong index.html đều có bản dịch "${lang}"`, () => {
    const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(TRANSLATIONS[lang], k));
    assert.deepStrictEqual(missing, [], `Thiếu key ở "${lang}": ${missing.join(', ')}`);
  });
});

// ---------------------------------------------------------------- 2. HÀNH VI
// DOM giả tối thiểu — đủ cho applyStaticTranslations() (querySelectorAll theo thuộc tính, không cần jsdom).
function makeEl(attrs, initial) {
  const a = { ...attrs };
  return {
    textContent: initial.textContent || '',
    innerHTML: initial.innerHTML || '',
    placeholder: initial.placeholder || '',
    title: initial.title || '',
    getAttribute: (n) => (n in a ? a[n] : null),
    setAttribute: (n, v) => { a[n] = String(v); },
    _attrs: a
  };
}

function loadI18n(dictionaries, lang, elements) {
  const doc = {
    addEventListener() {},
    querySelectorAll(sel) {
      const m = /^\[([a-z0-9-]+)\]$/.exec(sel);
      return m ? elements.filter((el) => m[1] in el._attrs) : [];
    }
  };
  const win = {
    TRANSLATIONS: dictionaries,
    languageStore: { getUILanguage: () => lang, subscribe() {} }
  };
  const ctx = { window: win, document: doc, String, Object, RegExp };
  vm.runInNewContext(i18nSrc, ctx);
  return win;
}

const dicts = () => ({
  vi: { 'a.has': 'Có bản dịch VI', 'a.empty': '' },
  en: { 'a.has': 'Has EN translation', 'a.empty': '' }
});

test('thiếu bản dịch: placeholder/textContent/title/aria-label GIỮ nguyên giá trị HTML, không bị ghi đè bằng key', () => {
  const ph = makeEl({ 'data-i18n-placeholder': 'x.missing' }, { placeholder: 'Tìm trong tài liệu…' });
  const tx = makeEl({ 'data-i18n': 'x.missing' }, { textContent: 'Chữ dự phòng' });
  const ti = makeEl({ 'data-i18n-title': 'x.missing' }, { title: 'Tiêu đề dự phòng' });
  const ar = makeEl({ 'data-i18n-aria-label': 'x.missing', 'aria-label': 'Nhãn dự phòng' }, {});
  const win = loadI18n(dicts(), 'en', [ph, tx, ti, ar]);
  win.applyStaticTranslations();
  assert.strictEqual(ph.placeholder, 'Tìm trong tài liệu…');
  assert.strictEqual(tx.textContent, 'Chữ dự phòng');
  assert.strictEqual(ti.title, 'Tiêu đề dự phòng');
  assert.strictEqual(ar.getAttribute('aria-label'), 'Nhãn dự phòng');
});

test('có bản dịch: vẫn ghi đè bình thường', () => {
  const ph = makeEl({ 'data-i18n-placeholder': 'a.has' }, { placeholder: 'cũ' });
  const win = loadI18n(dicts(), 'en', [ph]);
  win.applyStaticTranslations();
  assert.strictEqual(ph.placeholder, 'Has EN translation');
});

test('bản dịch CỐ Ý là chuỗi rỗng vẫn được áp dụng (khác với "thiếu bản dịch")', () => {
  const tx = makeEl({ 'data-i18n': 'a.empty' }, { textContent: 'sẽ bị xoá' });
  const win = loadI18n(dicts(), 'en', [tx]);
  win.applyStaticTranslations();
  assert.strictEqual(tx.textContent, '');
});

test('key chỉ có ở tiếng Việt: ngôn ngữ khác vẫn dùng fallback tiếng Việt của từ điển (hành vi cũ giữ nguyên)', () => {
  const d = dicts(); d.vi['only.vi'] = 'Chỉ có VI';
  const tx = makeEl({ 'data-i18n': 'only.vi' }, { textContent: 'cũ' });
  const win = loadI18n(d, 'en', [tx]);
  win.applyStaticTranslations();
  assert.strictEqual(tx.textContent, 'Chỉ có VI');
});

test('t() cho key không tồn tại trả về chính key (JS động không bao giờ nhận "undefined")', () => {
  const win = loadI18n(dicts(), 'en', []);
  assert.strictEqual(win.t('x.missing'), 'x.missing');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
