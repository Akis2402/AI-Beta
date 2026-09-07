'use strict';

// Không có trình duyệt thật trong môi trường sandbox này để test UI end-to-end — bù lại bằng kiểm
// tra TĨNH: mọi id DOM mà public/js/app.js gọi qua el('...') cho tính năng Subject (mục 14) phải
// thực sự tồn tại trong public/index.html, và script /js/subjects.js phải nạp TRƯỚC /js/app.js (vì
// app.js đọc window.SUBJECTS/window.getSubjectInfo ngay ở top-level lúc parse).
// Chạy: node test/dom-wiring.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const subjectsJs = fs.readFileSync(path.join(__dirname, '../public/js/subjects.js'), 'utf8');

function htmlHasId(id) {
  return new RegExp(`id=["']${id}["']`).test(html);
}

// ---------- Mọi id mới cho Subject Selector/badge/history filter phải có mặt trong index.html ----------
const requiredIds = ['subjectBtnWrap', 'subjectBtn', 'subjectPopover', 'historySubjectFilter'];
requiredIds.forEach((id) => {
  test(`id="${id}" tồn tại trong public/index.html`, () => {
    assert.ok(htmlHasId(id), `Không tìm thấy id="${id}"`);
  });
});

// ---------- Mọi el('id') mà app.js gọi cho tính năng Subject phải trỏ tới id có thật ----------
test("app.js el('subjectBtn')/el('subjectPopover')/el('subjectBtnWrap')/el('historySubjectFilter') đều có id tương ứng trong HTML", () => {
  const calls = [...appJs.matchAll(/el\('([a-zA-Z0-9_-]+)'\)/g)].map((m) => m[1]);
  const subjectCalls = calls.filter((id) => /subject|Subject/.test(id));
  assert.ok(subjectCalls.length > 0, 'app.js không có lệnh el(...) nào liên quan subject — có thể đã xoá nhầm wiring');
  subjectCalls.forEach((id) => {
    assert.ok(htmlHasId(id), `app.js gọi el('${id}') nhưng index.html không có id="${id}"`);
  });
});

// ---------- Thứ tự script: subjects.js PHẢI nạp trước app.js (app.js dùng window.SUBJECTS lúc parse) ----------
test('index.html nạp /js/subjects.js TRƯỚC /js/app.js', () => {
  const idxSubjects = html.indexOf('src="/js/subjects.js"');
  const idxApp = html.indexOf('src="/js/app.js"');
  assert.ok(idxSubjects !== -1, 'thiếu thẻ <script src="/js/subjects.js">');
  assert.ok(idxApp !== -1, 'thiếu thẻ <script src="/js/app.js">');
  assert.ok(idxSubjects < idxApp, 'subjects.js phải nạp trước app.js');
});

// ---------- app.js phải THỰC SỰ dùng window.SUBJECTS/window.getSubjectInfo (không phải file mồ côi) ----------
test('app.js có sử dụng window.SUBJECTS và window.getSubjectInfo từ subjects.js', () => {
  assert.ok(/window\.SUBJECTS/.test(appJs));
  assert.ok(/window\.getSubjectInfo|getSubjectInfo\(/.test(appJs));
});

// ---------- subjects.js (client) phải khớp ĐÚNG bộ id với server/utils/subjects.js (trừ 'auto') ----------
test('id môn học ở public/js/subjects.js khớp với server/utils/subjects.js (không lệch danh sách)', () => {
  const { SUBJECTS: serverSubjects } = require('../server/utils/subjects');
  const clientIdsMatch = [...subjectsJs.matchAll(/id:\s*'([a-zA-Z0-9-]+)'/g)].map((m) => m[1]);
  const clientIds = clientIdsMatch.filter((id) => id !== 'auto').sort();
  const serverIds = serverSubjects.map((s) => s.id).sort();
  assert.deepStrictEqual(clientIds, serverIds);
});

// ---------- CSS: mọi class mới (subject-badge/subject-opt/hist-subject-filter) phải có định nghĩa ----------
test('public/css/styles.css có định nghĩa .subject-badge/.subject-opt/.hist-subject-filter/#subjectPopover', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');
  ['.subject-badge', '.subject-opt', '.hist-subject-filter', '#subjectPopover'].forEach((sel) => {
    assert.ok(css.includes(sel), `thiếu CSS cho ${sel}`);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
