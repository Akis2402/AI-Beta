'use strict';

// ============================================================================================
// V6.16.2/26/31 — server/utils/source/linkGrounding.js (dùng bởi /api/recommend)
// ============================================================================================
// AUDIT phát hiện: anthropicClient.callClaudeWebSearch() (hàm DUY NHẤT trong codebase trả về URL
// thật từ web_search_tool_result) được export nhưng KHÔNG nơi nào gọi — recommend.js tin thẳng
// URL do model tự viết trong JSON, không đối chiếu với bất kỳ registry nào (fetchAiLinks() cũ chỉ
// validate FORMAT url, không validate NGUỒN GỐC). Test này khoá lại 3 bất biến sau khi vá — chạy
// thuần Node, 0 dependency (module tách riêng khỏi recommend.js chính vì lý do này, cùng quy ước
// citationValidator.js/sourceProvenance.js):
//   1. sanitizeGroundedLinks() CHỈ giữ URL khớp đúng 1 URL thật trong registry (verifiedUrls).
//   2. URL "gần giống" (đúng domain, khác path) KHÔNG được coi là khớp — không đoán hộ.
//   3. domainOnlySearchLinks() KHÔNG BAO GIỜ phát URL gốc của model — luôn là link
//      google.com/search?q=site:<domain> (Google tự resolve, không có rủi ro link chết/bịa).

const assert = require('assert');
const { sanitizeGroundedLinks, domainOnlySearchLinks, normalizeUrlForMatch, sanitizeAiLinks } = require('../server/utils/source/linkGrounding');

const results = [];
function test(name, fn) { try { fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, error: e.message }); } }

console.log('\n== linkGrounding.js — URL grounding cho /api/recommend (V6.16) ==');

test('1. URL khớp đúng registry -> được giữ', () => {
  const raw = [{ url: 'https://vietjack.com/toan-lop-9/bai-1.jsp', title: 'Bài 1', note: 'x' }];
  const out = sanitizeGroundedLinks(raw, ['https://vietjack.com/toan-lop-9/bai-1.jsp']);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].url, 'https://vietjack.com/toan-lop-9/bai-1.jsp');
});

test('2. URL KHÔNG có trong registry (model tự bịa) -> bị loại', () => {
  const raw = [{ url: 'https://fake-domain.example/article', title: 'Bịa', note: 'x' }];
  const out = sanitizeGroundedLinks(raw, ['https://vietjack.com/toan-lop-9/bai-1.jsp']);
  assert.strictEqual(out.length, 0);
});

test('3. Cùng domain nhưng KHÁC path -> vẫn bị loại (không đoán hộ URL gần đúng)', () => {
  const raw = [{ url: 'https://vietjack.com/toan-lop-9/bai-99-khac.jsp', title: 'Khác bài', note: 'x' }];
  const out = sanitizeGroundedLinks(raw, ['https://vietjack.com/toan-lop-9/bai-1.jsp']);
  assert.strictEqual(out.length, 0, 'path khác là tài liệu khác — không được coi là "gần đúng nên chấp nhận"');
});

test('4. registry rỗng (search không trả kết quả nào) -> không giữ link nào, không throw', () => {
  const raw = [{ url: 'https://vietjack.com/x', title: 'x', note: 'y' }];
  const out = sanitizeGroundedLinks(raw, []);
  assert.strictEqual(out.length, 0);
});

test('5. nhiều link, chỉ 1 cái có trong registry -> chỉ giữ đúng 1 cái đó (không "vơ" cả nhóm)', () => {
  const raw = [
    { url: 'https://real.com/a', title: 'thật' },
    { url: 'https://fake.example/b', title: 'giả' }
  ];
  const out = sanitizeGroundedLinks(raw, ['https://real.com/a']);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].domain, 'real.com');
});

test('6. normalizeUrlForMatch bỏ qua www./trailing-slash nhưng KHÔNG bỏ query có ý nghĩa', () => {
  assert.strictEqual(normalizeUrlForMatch('https://www.a.com/x/'), normalizeUrlForMatch('https://a.com/x'));
  assert.notStrictEqual(normalizeUrlForMatch('https://a.com/x?id=1'), normalizeUrlForMatch('https://a.com/x?id=2'));
});

test('7. normalizeUrlForMatch trên URL hỏng -> null, không throw (fail-closed, không khớp gì cả)', () => {
  assert.strictEqual(normalizeUrlForMatch('không-phải-url'), null);
});

test('8. domainOnlySearchLinks KHÔNG BAO GIỜ phát URL gốc của model — luôn là google.com/search', () => {
  const raw = [{ url: 'https://some-unverified-site.example/deep/path?x=1', title: 'Bài học', note: 'ghi chú' }];
  const out = domainOnlySearchLinks(raw, 'đạo hàm của x^2');
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].url.startsWith('https://www.google.com/search?q='), 'phải là link tìm kiếm Google, không phải URL gốc chưa xác minh');
  assert.ok(!out[0].url.includes('some-unverified-site.example/deep/path'), 'không được lộ path gốc của model ra URL cuối');
  assert.strictEqual(out[0].domain, 'some-unverified-site.example', 'vẫn giữ domain để hiển thị cho người dùng biết nguồn gợi ý');
});

test('9. domainOnlySearchLinks bỏ trùng domain và giới hạn MAX_LINKS', () => {
  const raw = Array.from({ length: 10 }, (_, i) => ({ url: `https://site${i % 3}.com/p${i}`, title: `t${i}` }));
  const out = domainOnlySearchLinks(raw, 'x');
  assert.ok(out.length <= 6, 'không vượt trần MAX_LINKS');
  const domains = out.map((o) => o.domain);
  assert.strictEqual(new Set(domains).size, domains.length, 'không trùng domain');
});

test('10. sanitizeAiLinks (đường CŨ, chỉ còn dùng nội bộ khi ĐÃ xác minh) vẫn đúng format như trước — không regression', () => {
  const raw = [{ url: 'https://a.com/x', title: 'A', note: 'n' }, { url: 'not-a-url', title: 'bad' }, { url: 'javascript:alert(1)', title: 'xss' }];
  const out = sanitizeAiLinks(raw);
  assert.strictEqual(out.length, 1, 'chỉ url http(s) hợp lệ được giữ — javascript: và chuỗi không phải URL đều bị loại');
  assert.strictEqual(out[0].domain, 'a.com');
});

let passed = 0;
let failed = 0;
results.forEach((r) => {
  if (r.pass) { passed += 1; console.log('  ok  - ' + r.name); }
  else { failed += 1; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
