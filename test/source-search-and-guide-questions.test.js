'use strict';

// ============================================================================================
// MỤC LX/LXI (rework notebook) — Source Search + câu hỏi gợi ý bấm được trong Notebook Guide
// ============================================================================================
// Không có trình duyệt thật trong sandbox (xem test/dom-wiring.test.js) -> kiểm tra TĨNH: đúng id
// DOM tồn tại, đúng hàm được định nghĩa ĐÚNG MỘT LẦN (bug vừa gặp: sửa renderGuidePanelHtml bằng
// str_replace lỡ để lại 2 định nghĩa trùng tên — hàm sau âm thầm đè hàm trước, không lỗi cú pháp nên
// rất dễ lọt qua nếu không có test khoá lại), và luồng dữ liệu nối đúng chỗ.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('public/index.html');
const app = read('public/js/app.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.stack || e.message); }
}

function countOccurrences(src, re) {
  const m = src.match(re);
  return m ? m.length : 0;
}

console.log('\n== JS hợp lệ, không còn hàm định nghĩa trùng (bug vừa tự gây ra rồi tự sửa) ==');

test('1. node --check public/js/app.js không lỗi cú pháp', () => {
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['--check', path.join(root, 'public/js/app.js')]);
});

test('2. renderGuidePanelHtml/openNotebookGuide chỉ định nghĩa ĐÚNG 1 LẦN (chống trùng lặp âm thầm)', () => {
  assert.strictEqual(countOccurrences(app, /function renderGuidePanelHtml\(/g), 1);
  assert.strictEqual(countOccurrences(app, /function openNotebookGuide\(/g), 1);
});

console.log('\n== MỤC LX — Source Search: DOM + hàm cốt lõi tồn tại, dùng lại normalizeForMatch/highlightSnippet ==');

test('3. #sourceSearchInput và #sourceSearchResults tồn tại trong index.html, nằm trong panel Nguồn', () => {
  assert.ok(/id="sourceSearchInput"/.test(html));
  assert.ok(/id="sourceSearchResults"/.test(html));
  const panelIdx = html.indexOf('id="sourcesPanel"');
  const inputIdx = html.indexOf('id="sourceSearchInput"');
  assert.ok(panelIdx > 0 && inputIdx > panelIdx && inputIdx < panelIdx + 2000, 'search box phải nằm trong panel Nguồn, gần đầu');
});

test('4. searchAllSources() tồn tại, KHÔNG viết lại logic chuẩn hoá — dùng chung normalizeForMatch()', () => {
  const m = /function searchAllSources\(query\)\s*\{[\s\S]{0,900}?\n\}/.exec(app);
  assert.ok(m, 'không tìm thấy searchAllSources()');
  assert.ok(/normalizeForMatch\(/.test(m[0]));
  assert.ok(/state\.docs/.test(m[0]) && /state\.urlSources/.test(m[0]), 'phải quét CẢ 2 nguồn: file (docs) và URL (urlSources)');
});

test('5. renderSourceSearchResults() dùng lại highlightSnippet() để tô sáng từ khớp (không viết lại)', () => {
  const i = app.indexOf('function renderSourceSearchResults(');
  assert.ok(i >= 0);
  const block = app.slice(i, i + 900);
  assert.ok(/highlightSnippet\(/.test(block));
});

test('6. jumpToSourceCard() nhắm đúng selector khớp dataset đã gắn ở renderSources()/renderUrlSources()', () => {
  assert.ok(/li\.dataset\.docId\s*=\s*String\(doc\.id\)/.test(app), 'renderSources() phải gắn dataset.docId cho mỗi source-card');
  assert.ok(/li\.dataset\.urlSourceId\s*=\s*String\(s\.id\)/.test(app), 'renderUrlSources() phải gắn dataset.urlSourceId');
  const m = /function jumpToSourceCard\([\s\S]{0,700}?\n\}/.exec(app);
  assert.ok(m);
  assert.ok(/data-doc-id/.test(m[0]) && /data-url-source-id/.test(m[0]));
});

test('7. input#sourceSearchInput có wiring sự kiện input thật (không phải chỉ khai báo suông)', () => {
  const needle = "el('sourceSearchInput').addEventListener('input'";
  const i = app.indexOf(needle);
  assert.ok(i >= 0, 'phải có addEventListener(\'input\', ...) gắn trực tiếp trên #sourceSearchInput');
  const block = app.slice(i, i + 250);
  assert.ok(/searchAllSources\(/.test(block) && /renderSourceSearchResults\(/.test(block));
});

console.log('\n== MỤC LXI — Câu hỏi gợi ý trong Guide bấm được, đổ thẳng vào #qInput ==');

test('8. FAQ question và deepQuestions được render thành button.guide-ask-q có data-q', () => {
  const m = /function renderGuidePanelHtml\([\s\S]{0,2200}?\n\}/.exec(app);
  assert.ok(m);
  assert.ok(/class="guide-ask-q guide-faq-q" data-q=/.test(m[0]), 'FAQ question phải là guide-ask-q');
  assert.ok(/askableList/.test(m[0]) && /class="guide-ask-q" data-q=/.test(m[0]), 'deepQuestions phải qua askableList() -> guide-ask-q');
});

test('9. click .guide-ask-q -> set #qInput.value + dispatch input event (đúng convention chèn transcript đã có)', () => {
  const m = /async function openNotebookGuide\([\s\S]{0,1800}?\n\}/.exec(app);
  assert.ok(m);
  assert.ok(/closest\('\.guide-ask-q'\)/.test(m[0]));
  assert.ok(/input\.value\s*=\s*askBtn\.dataset\.q/.test(m[0]));
  assert.ok(/dispatchEvent\(new Event\('input'\)\)/.test(m[0]));
});

test('10. .guide-regen vẫn hoạt động sau khi thêm .guide-ask-q (không bị đè mất do gộp chung 1 handler)', () => {
  const m = /async function openNotebookGuide\([\s\S]{0,1800}?\n\}/.exec(app);
  assert.ok(/closest\('\.guide-regen'\)/.test(m[0]));
  assert.ok(/openNotebookGuide\(panelEl, descriptor, \{ force: true \}\)/.test(m[0]));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
