'use strict';
// ---------- Tối ưu trích nguồn PDF (nhanh + ít token): kiểm hành vi của mã THẬT trong public/js/app.js ----------
// Cắt đúng các hàm thuần từ app.js (không viết lại) rồi chạy: không cần trình duyệt, pdf.js hay mạng.
// Chạy: node test/pdf-extraction-optimizations.test.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
function slice(from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`Không tìm thấy mốc "${from}" .. "${to}" trong app.js (đã đổi cấu trúc?)`);
  return src.slice(a, b);
}

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  - ' + msg); } else { failed++; console.log('  FAIL - ' + msg); } }

const pdfLib = new Function(slice('const PDF_TEXT_CONCURRENCY', 'async function parsePDF(file)') + '; return { extractPdfPageLines, stripRepeatedPageLines };')();
const chunkLib = new Function(slice('const CONTROL_OR_PUA_RE', 'const PDF_TEXT_MIN_CHARS_PER_PAGE').replace(/\/\/ FIX: PDF[\s\S]*$/, '') + '; return { chunkText };')();
const scoreLib = new Function(slice('const NORM_CACHE', 'function collectAvailableEvidence') + '; function normalizeForMatch(s){return String(s).toLowerCase();} return { applyIdfScores, normOfChunk };')();

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
// Dòng thân KHÔNG được lặp theo khuôn (chỉ khác chữ số) giữa các trang, nếu không đó chính là header theo định nghĩa.
const mkPage = (n, header, footer, bodyLines) => ({ page: n, lines: [header, ...Array.from({ length: bodyLines }, (_, i) => `noi dung ${LETTERS[i]} trang ${LETTERS[n % 26]}${LETTERS[(n * 7) % 26]}`), footer] });

(async () => {
  console.log('\n== stripRepeatedPageLines: bỏ header/footer lặp, giữ nội dung ==');
  let sets = Array.from({ length: 10 }, (_, i) => mkPage(i + 1, 'Toán 11 – Chân trời sáng tạo', `Trang ${i + 1}`, 6));
  pdfLib.stripRepeatedPageLines(sets);
  const all = sets.map((s) => s.lines.join('|')).join('\n');
  ok(!/Chân trời sáng tạo/.test(all), 'header lặp bị bỏ');
  ok(!/Trang \d+/.test(all), 'footer "Trang N" (số đổi mỗi trang) bị bỏ');
  ok(sets.every((s) => s.lines.length === 6 && /noi dung f trang/.test(s.lines.join('|'))), 'nội dung giữ nguyên 100% (6 dòng/trang)');

  console.log('\n== stripRepeatedPageLines: KHÔNG làm mất nội dung ==');
  sets = Array.from({ length: 10 }, (_, i) => mkPage(i + 1, `Bài ${i + 1}`, `Trang ${i + 1}`, 6));
  pdfLib.stripRepeatedPageLines(sets);
  ok(sets.every((s, i) => s.lines[0] === `Bài ${i + 1}`), 'nhãn "Bài N" ở đầu mỗi trang được GIỮ (retrieval tầng 1 cần)');
  sets = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, lines: [`Trang ${i + 1}. Bài 2.${i + 1} yêu cầu tính diện tích hình thang.`] }));
  pdfLib.stripRepeatedPageLines(sets);
  ok(sets.every((s) => s.lines.length === 1), 'PDF mỗi trang chỉ 1 "dòng" (không có hasEOL) KHÔNG bị xóa trắng (hồi quy đã bắt được)');
  sets = Array.from({ length: 4 }, (_, i) => mkPage(i + 1, 'H', 'F', 6));
  pdfLib.stripRepeatedPageLines(sets);
  ok(sets.every((s) => s.lines[0] === 'H'), 'tài liệu < 5 trang không bị bỏ dòng nào');
  // Dòng ngắn giống hệt nhau ở MỌI trang nhưng nằm GIỮA trang (vd. "Giải") là nội dung thật, không bao giờ bị bóc.
  sets = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, lines: [`A ${LETTERS[i]}`, `B ${LETTERS[(i + 3) % 26]}`, 'mot', 'Giải', 'hai', 'ba', `C ${LETTERS[(i + 5) % 26]}`, `D ${LETTERS[(i + 7) % 26]}`] }));
  pdfLib.stripRepeatedPageLines(sets);
  ok(sets.every((s) => s.lines.length === 8 && s.lines[3] === 'Giải' && s.lines[2] === 'mot'), 'dòng lặp ở GIỮA trang ("Giải") không bị bóc; chỉ xét 2 dòng đầu/2 dòng cuối');

  console.log('\n== extractPdfPageLines: song song nhưng đúng thứ tự, an toàn ==');
  let inFlight = 0, maxInFlight = 0, cleaned = 0;
  const fakePdf = (n, withCleanup, failAt) => ({
    numPages: n,
    getPage: async (p) => ({
      getTextContent: async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, p % 3));
        inFlight--;
        if (p === failAt) throw new Error('trang lỗi');
        return { items: [{ str: `A${p}`, hasEOL: false }, { str: `B${p}`, hasEOL: true }, { str: `C${p}` }] };
      },
      ...(withCleanup ? { cleanup() { cleaned++; } } : {})
    })
  });
  const r = await pdfLib.extractPdfPageLines(fakePdf(30, true));
  ok(r.length === 30 && r.every((s, i) => s.page === i + 1), '30 trang: đủ và đúng thứ tự dù đọc song song');
  ok(r[4].lines.length === 2 && r[4].lines[0] === 'A5 B5' && r[4].lines[1] === 'C5', 'tách dòng theo hasEOL');
  ok(maxInFlight > 1 && maxInFlight <= 6, `đọc song song có giới hạn (tối đa ${maxInFlight} trang cùng lúc, trần 6)`);
  ok(cleaned === 30, 'mọi trang đều được cleanup()');
  const r2 = await pdfLib.extractPdfPageLines(fakePdf(3, false));
  ok(r2.length === 3, 'pdf.js không có page.cleanup vẫn chạy bình thường');
  let threw = false; try { await pdfLib.extractPdfPageLines(fakePdf(10, true, 7)); } catch (e) { threw = /trang lỗi/.test(e.message); }
  ok(threw, '1 trang lỗi vẫn làm parsePDF() ném lỗi như cũ (không nuốt lỗi)');

  console.log('\n== chunkText: cắt ở ranh giới từ ==');
  const text = Array.from({ length: 400 }, (_, i) => `tu${i}`).join(' ');
  const chunks = chunkLib.chunkText([{ page: 3, text }], { sourceId: 9 }, 900);
  ok(chunks.length > 1 && chunks.every((c) => c.text.length <= 900), 'mỗi chunk <= size');
  ok(chunks.every((c) => /^tu\d+$/.test(c.text.split(' ')[0]) && /^tu\d+$/.test(c.text.split(' ').pop())), 'không chunk nào bắt đầu/kết thúc giữa chữ');
  ok(chunks.map((c) => c.text).join(' ') === text, 'ghép lại đúng nguyên văn (không mất/đổi chữ nào)');
  ok(chunks.every((c) => c.page === 3 && c.startPage === 3 && c.endPage === 3 && c.sourceId === 9), 'metadata trang/nguồn giữ nguyên');

  console.log('\n== applyIdfScores: từ hiếm quyết định thứ hạng ==');
  const mk = (arr) => arr.map((hits) => ({ score: hits.slice() }));
  const ev = mk([[0], [0], [0], [0, 1], [0]]); // từ 0 có ở cả 5 chunk, từ 1 chỉ có ở chunk #3
  scoreLib.applyIdfScores(ev, ['bài', 'pitago']);
  ok(ev.every((c) => typeof c.score === 'number' && c.score > 0), 'mọi chunk có khớp đều có điểm số > 0');
  const best = ev.reduce((b, c, i) => (c.score > ev[b].score ? i : b), 0);
  ok(best === 3, 'chunk chứa từ HIẾM đứng đầu (trước đây hòa điểm theo thứ tự chèn)');
  ok(ev[3].score > 3 * ev[0].score, 'từ có ở mọi chunk gần như không đóng góp');
  const none = [{ score: [] }, { score: [] }]; scoreLib.applyIdfScores(none, ['x']);
  ok(none.every((c) => c.score === 0), 'không khớp từ nào => điểm 0');
  const ch = { text: 'Abc' }; const n1 = scoreLib.normOfChunk(ch); ch.text = 'XYZ';
  ok(n1 === 'abc' && scoreLib.normOfChunk(ch) === 'xyz', 'cache chuẩn hóa tự làm mới khi text của chunk đổi');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
