'use strict';

// ---------- B5 (test G): NÉN CANDIDATE CHO RECONCILE KHÔNG ĐƯỢC MẤT KHẢ NĂNG PHÁT HIỆN LỖI ----------
// Token saving ở đây phải đến từ việc BỎ PROSE KHÔNG PHỤC VỤ VERIFICATION, không phải bỏ dữ kiện.
// Test so sánh TRƯỚC/SAU khi nén trên cùng một bộ case lỗi đã biết: mọi dấu hiệu để phát hiện
// candidate sai (đáp số, công thức, dấu, điều kiện, đơn vị, số trung gian) phải còn nguyên.

const assert = require('assert');
const {
  buildVerificationPacket, renderVerificationPacket, compactCandidatesForReconcile, PACKET_MIN_CHARS
} = require('../server/utils/verificationPacket');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  - ' + name); }
  catch (e) { failed++; console.log(' FAIL - ' + name + '\n        ' + e.message); }
}

const FILLER = 'Chúng ta cùng nhau đi qua từng bước một cách thật cẩn thận để hiểu rõ bản chất của bài toán này nhé.\n'.repeat(20);

const GOOD = `Xin chào! Dưới đây là lời giải chi tiết của mình.
## Tóm tắt đề bài
Giải phương trình bậc hai $x^2 - 5x + 6 = 0$.
${FILLER}
## Lời giải
Bước 1: Tính biệt thức $\\Delta = b^2 - 4ac = 25 - 24 = 1$.
${FILLER}
Bước 2: Vì $\\Delta > 0$ nên phương trình có 2 nghiệm phân biệt.
Điều kiện xác định: mọi x thuộc R.
Bước 3: $x_1 = 3$, $x_2 = 2$.
## Kết luận
Nghiệm của phương trình là **x = 2 hoặc x = 3**.
## Lỗi sai thường gặp
- Học sinh hay nhầm dấu khi tính Delta.
- Học sinh hay quên điều kiện xác định.`;

// Candidate SAI: sai dấu ở Delta -> ra nghiệm khác. Đây là case lỗi "đã biết".
const WRONG = GOOD
  .replace('25 - 24 = 1', '25 + 24 = 49')
  .replace('$x_1 = 3$, $x_2 = 2$', '$x_1 = 6$, $x_2 = -1$')
  .replace('**x = 2 hoặc x = 3**', '**x = 6 hoặc x = -1**');

test('G1. Packet giữ NGUYÊN VĂN đáp số cuối, công thức, điều kiện, số trung gian', () => {
  const p = buildVerificationPacket({ label: 'Claude', text: GOOD });
  const rendered = renderVerificationPacket(p);
  assert.ok(/x = 2 hoặc x = 3/.test(p.finalAnswer), 'đáp số cuối phải được trích đúng');
  assert.ok(/25 - 24 = 1/.test(rendered), 'biệt thức (dữ kiện để bắt sai dấu) phải còn');
  assert.ok(/Bước 1/.test(rendered) && /Bước 3/.test(rendered), 'các bước chính phải còn');
  assert.ok(/[Đđ]iều kiện xác định/.test(rendered), 'điều kiện phải còn');
});

test('G2. Packet BỎ phần không phục vụ verification (lời chào, prose lặp, mục cho học sinh)', () => {
  const rendered = renderVerificationPacket(buildVerificationPacket({ label: 'A', text: GOOD }));
  assert.ok(!/Xin chào/.test(rendered), 'lời chào phải bị bỏ');
  assert.ok(!/cùng nhau đi qua từng bước/.test(rendered), 'prose lặp phải bị bỏ');
  assert.ok(!/Học sinh hay nhầm dấu/.test(rendered), 'mục "Lỗi sai thường gặp" là tutorial, không phải dữ kiện verify');
  assert.ok(rendered.length < GOOD.length * 0.6, `phải nhỏ hơn đáng kể: ${rendered.length} vs ${GOOD.length}`);
});

test('G3. TRƯỚC/SAU khi nén: vẫn phân biệt được candidate ĐÚNG và candidate SAI', () => {
  const before = [GOOD, WRONG];
  const after = before.map((t) => renderVerificationPacket(buildVerificationPacket({ label: 'x', text: t })));
  // Tín hiệu để reconcile phát hiện bất đồng: đáp số cuối khác nhau + biệt thức khác nhau.
  assert.notStrictEqual(after[0], after[1], 'hai packet phải khác nhau, nếu không reconcile mù');
  assert.ok(/x = 2 hoặc x = 3/.test(after[0]) && /x = 6 hoặc x = -1/.test(after[1]),
    'đáp số bất đồng phải nhìn thấy được sau khi nén');
  assert.ok(/25 - 24 = 1/.test(after[0]) && /25 \+ 24 = 49/.test(after[1]),
    'bước biến đổi sai dấu phải nhìn thấy được sau khi nén (nếu mất, reconcile không truy được NGUYÊN NHÂN sai)');
});

test('G4. Candidate NGẮN -> KHÔNG nén (an toàn > tiết kiệm vặt)', () => {
  const short = { label: 'A', text: 'Đáp số: **x = 2**' };
  const out = compactCandidatesForReconcile([short]);
  assert.strictEqual(out.candidates[0].text, short.text, 'dưới ngưỡng thì giữ nguyên văn');
  assert.strictEqual(out.stats.compressedCount, 0);
  assert.ok(PACKET_MIN_CHARS > 0);
});

test('G5. Candidate DÀI -> nén, và có rollback khi packet không đủ tốt', () => {
  const out = compactCandidatesForReconcile([{ label: 'A', text: GOOD }, { label: 'B', text: WRONG }]);
  assert.strictEqual(out.stats.compressedCount, 2);
  assert.ok(out.stats.packedChars < out.stats.rawChars * 0.8, 'phải tiết kiệm thật');
  // Rollback: văn bản dài nhưng không có đáp số/dữ kiện nào -> giữ nguyên văn thay vì gửi packet rỗng.
  const proseOnly = { label: 'C', text: 'Bài này rất thú vị. '.repeat(400) };
  const r2 = compactCandidatesForReconcile([proseOnly]);
  assert.strictEqual(r2.candidates[0].text, proseOnly.text, 'packet không đủ tốt -> rollback nguyên văn');
});

test('G6. Khối vẽ hình giữ NGUYÊN VĂN (toạ độ là dữ liệu, không được tóm tắt)', () => {
  const withShape = { label: 'A', text: GOOD + '\n```shape\n{"type":"polygon","points":[[0,0],[4,0],[2,3]]}\n```' };
  const rendered = renderVerificationPacket(buildVerificationPacket(withShape));
  assert.ok(/"points":\[\[0,0\],\[4,0\],\[2,3\]\]/.test(rendered), 'toạ độ phải còn nguyên từng ký tự');
});

console.log('\n== B5: verification packet (nén candidate cho reconcile) ==');
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
