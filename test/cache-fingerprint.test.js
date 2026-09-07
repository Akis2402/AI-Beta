'use strict';

// ---------- REGRESSION: cache fingerprint không được collision (mục PHẦN 2/18.1) ----------
// TRƯỚC ĐÂY cacheKeyParts chỉ gồm {stage, normalizedProblem, deepThinking, crossCheck, approachFp}
// -> cùng đề bài nhưng khác lang/school/grade/detail/source/model-tier vẫn tính ra CÙNG 1 cache key,
// nguy cơ trả nhầm kết quả. Test này gọi thẳng runTokenEconomyPipeline() (không cần server thật) và
// khẳng định các trường khác nhau kể trên luôn sinh ra key khác nhau.

const assert = require('assert');
const te = require('../server/utils/tokenEconomy');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
  }
}

function baseInput(overrides = {}) {
  return {
    problemText: 'Giải phương trình bậc 2: x^2 - 5x + 6 = 0',
    historyText: '', contextsText: '', approachText: '',
    contexts: [], history: [], stage: 'detail',
    hasImage: false, hasDrawing: false, deepThinking: false, crossCheck: false,
    remainingMs: 60000, requirements: [],
    cacheKeyExtra: {
      promptVersion: 'chat-prompt-v3', lang: 'Tiếng Việt', detail: 'normal',
      school: 'THPT', grade: '10', approachFp: te.fingerprint(''), rulesFp: te.fingerprint(''),
      sourceIdsFp: te.fingerprint(''), contextsFp: te.fingerprint('')
    },
    ...overrides
  };
}

function keyOf(input) {
  const plan = te.runTokenEconomyPipeline(input);
  return te.globalCache._keyOf(plan.cacheKeyParts);
}

test('cache key: same problem + different source (sourceIdsFp) does not collide', () => {
  const k1 = keyOf(baseInput({ contexts: [{ doc: 'A.pdf', id: 1, text: 'x' }], cacheKeyExtra: { ...baseInput().cacheKeyExtra, sourceIdsFp: te.fingerprint('A.pdf#1') } }));
  const k2 = keyOf(baseInput({ contexts: [{ doc: 'B.pdf', id: 1, text: 'x' }], cacheKeyExtra: { ...baseInput().cacheKeyExtra, sourceIdsFp: te.fingerprint('B.pdf#1') } }));
  assert.notStrictEqual(k1, k2);
});

test('cache key: same problem + different language does not collide', () => {
  const k1 = keyOf(baseInput({ cacheKeyExtra: { ...baseInput().cacheKeyExtra, lang: 'Tiếng Việt' } }));
  const k2 = keyOf(baseInput({ cacheKeyExtra: { ...baseInput().cacheKeyExtra, lang: 'English' } }));
  assert.notStrictEqual(k1, k2);
});

test('cache key: same problem + different detail mode does not collide', () => {
  const k1 = keyOf(baseInput({ cacheKeyExtra: { ...baseInput().cacheKeyExtra, detail: 'short' } }));
  const k2 = keyOf(baseInput({ cacheKeyExtra: { ...baseInput().cacheKeyExtra, detail: 'long' } }));
  assert.notStrictEqual(k1, k2);
});

test('cache key: same problem + different grade does not collide', () => {
  const k1 = keyOf(baseInput({ cacheKeyExtra: { ...baseInput().cacheKeyExtra, grade: '10' } }));
  const k2 = keyOf(baseInput({ cacheKeyExtra: { ...baseInput().cacheKeyExtra, grade: '12' } }));
  assert.notStrictEqual(k1, k2);
});

test('cache key: same problem + different approach fingerprint does not collide', () => {
  const k1 = keyOf(baseInput({ approachText: 'hướng A', cacheKeyExtra: { ...baseInput().cacheKeyExtra, approachFp: te.fingerprint('hướng A') } }));
  const k2 = keyOf(baseInput({ approachText: 'hướng B', cacheKeyExtra: { ...baseInput().cacheKeyExtra, approachFp: te.fingerprint('hướng B') } }));
  assert.notStrictEqual(k1, k2);
});

test('cache key: different modelTier (deepThinking on) does not collide with off', () => {
  const k1 = keyOf(baseInput({ deepThinking: false }));
  const k2 = keyOf(baseInput({ deepThinking: true }));
  assert.notStrictEqual(k1, k2);
});

test('image requests bypass L1 cache entirely (cacheBypassed=true, no false hit)', () => {
  const input = baseInput({ hasImage: true });
  const plan1 = te.runTokenEconomyPipeline(input);
  assert.strictEqual(plan1.cacheBypassed, true);
  assert.strictEqual(plan1.cacheHit, false);
  // Even after "writing" nothing changes: a second identical image request must also miss.
  const plan2 = te.runTokenEconomyPipeline(input);
  assert.strictEqual(plan2.cacheHit, false);
});

test('non-image requests still cache-hit correctly when fully identical', () => {
  const input = baseInput();
  const plan1 = te.runTokenEconomyPipeline(input);
  assert.strictEqual(plan1.cacheHit, false);
  te.globalCache.set('L1', plan1.cacheKeyParts, { text: 'cached answer' });
  const plan2 = te.runTokenEconomyPipeline(input);
  assert.strictEqual(plan2.cacheHit, true);
  assert.strictEqual(plan2.cachedValue.text, 'cached answer');
});

// ---------- PHẦN 20 FIX: image request VỚI imageFp (SHA-256 thật) -> cache AN TOÀN, không bypass ----------
test('imageFingerprint() sinh SHA-256 ổn định (cùng input -> cùng hash)', () => {
  const h1 = te.imageFingerprint('AAAA', 'image/png');
  const h2 = te.imageFingerprint('AAAA', 'image/png');
  assert.strictEqual(h1, h2);
  assert.strictEqual(typeof h1, 'string');
  assert.strictEqual(h1.length, 64); // hex SHA-256
});

test('imageFingerprint() phân biệt 2 ảnh khác nhau (không collision)', () => {
  const h1 = te.imageFingerprint('AAAA_noi_dung_anh_1', 'image/png');
  const h2 = te.imageFingerprint('BBBB_noi_dung_anh_2', 'image/png');
  assert.notStrictEqual(h1, h2);
});

test('hasImage=true + imageFp -> KHÔNG bypass cache nữa (cacheBypassed=false, an toàn vì đã phân biệt theo ảnh)', () => {
  const imageFp = te.imageFingerprint('noi_dung_anh_A', 'image/png');
  const input = baseInput({ hasImage: true, cacheKeyExtra: { ...baseInput().cacheKeyExtra, imageFp } });
  const plan = te.runTokenEconomyPipeline(input);
  assert.strictEqual(plan.cacheBypassed, false);
});

test('2 ảnh KHÁC NHAU (imageFp khác nhau) cùng problemText -> cache KHÔNG collide (không trả nhầm)', () => {
  const imageFpA = te.imageFingerprint('noi_dung_anh_A', 'image/png');
  const imageFpB = te.imageFingerprint('noi_dung_anh_B', 'image/png');
  const inputA = baseInput({ hasImage: true, cacheKeyExtra: { ...baseInput().cacheKeyExtra, imageFp: imageFpA } });
  const inputB = baseInput({ hasImage: true, cacheKeyExtra: { ...baseInput().cacheKeyExtra, imageFp: imageFpB } });
  const planA = te.runTokenEconomyPipeline(inputA);
  te.globalCache.set('L1', planA.cacheKeyParts, { text: 'answer for image A' });
  const planBAfterASet = te.runTokenEconomyPipeline(inputB);
  assert.strictEqual(planBAfterASet.cacheHit, false, 'ảnh B không được trúng cache của ảnh A');
});

test('cùng 1 ảnh (imageFp giống nhau) gửi lại -> cache HIT thật (tiết kiệm 1 lệnh gọi AI)', () => {
  const imageFp = te.imageFingerprint('noi_dung_anh_giong_het', 'image/png');
  const input = baseInput({ hasImage: true, cacheKeyExtra: { ...baseInput().cacheKeyExtra, imageFp } });
  const plan1 = te.runTokenEconomyPipeline(input);
  assert.strictEqual(plan1.cacheHit, false);
  te.globalCache.set('L1', plan1.cacheKeyParts, { text: 'answer for repeated image' });
  const plan2 = te.runTokenEconomyPipeline(input);
  assert.strictEqual(plan2.cacheHit, true);
  assert.strictEqual(plan2.cachedValue.text, 'answer for repeated image');
});

test('hasImage=true KHÔNG có imageFp (caller cũ chưa cập nhật) -> vẫn bypass như cũ (backward-safe)', () => {
  const input = baseInput({ hasImage: true }); // không set imageFp trong cacheKeyExtra
  const plan = te.runTokenEconomyPipeline(input);
  assert.strictEqual(plan.cacheBypassed, true);
});

// ---------- FIX P0 (audit): cache key PHẢI phân biệt theo conversation history ----------
// TRƯỚC ĐÂY: historyText/history được truyền vào runTokenEconomyPipeline() nhưng KHÔNG hề nằm
// trong cacheKeyParts -> Conversation A (history=H_A) và Conversation B (history=H_B) hỏi cùng
// 1 câu Q, cùng settings => cache key giống hệt nhau => B có thể nhận nhầm response được sinh
// cho A (sai ngữ cảnh). Nay historyText luôn được băm vào `historyFp` trong cacheKeyParts.
test('cache key: same question + different history (A vs B) does not collide', () => {
  const kA = keyOf(baseInput({ historyText: 'User: hỏi về đạo hàm\nAI: đạo hàm là...' }));
  const kB = keyOf(baseInput({ historyText: 'User: hỏi về tích phân\nAI: tích phân là...' }));
  assert.notStrictEqual(kA, kB, 'cache key phải khác nhau khi history khác nhau');
});

test('cache key: same history + different query does not collide', () => {
  const sameHistory = 'User: câu hỏi trước\nAI: trả lời trước';
  const k1 = keyOf(baseInput({ historyText: sameHistory, problemText: 'Giải x^2 - 5x + 6 = 0' }));
  const k2 = keyOf(baseInput({ historyText: sameHistory, problemText: 'Giải x^2 + 2x + 1 = 0' }));
  assert.notStrictEqual(k1, k2);
});

test('cache key: same query + different history does not collide (isolated variable)', () => {
  const k1 = keyOf(baseInput({ historyText: 'lịch sử hội thoại A' }));
  const k2 = keyOf(baseInput({ historyText: 'lịch sử hội thoại B khác hẳn' }));
  assert.notStrictEqual(k1, k2);
});

test('cache key: empty history is stable and does not collide with non-empty history', () => {
  const kEmpty1 = keyOf(baseInput({ historyText: '' }));
  const kEmpty2 = keyOf(baseInput({ historyText: '' }));
  const kNonEmpty = keyOf(baseInput({ historyText: 'có lịch sử' }));
  assert.strictEqual(kEmpty1, kEmpty2, 'history rỗng phải cho ra key ổn định giữa các request');
  assert.notStrictEqual(kEmpty1, kNonEmpty);
});

test('cache key: long history produces a stable fingerprint (same long history -> same key)', () => {
  const longHistory = Array.from({ length: 500 }, (_, i) => `User: câu hỏi số ${i}\nAI: trả lời số ${i} với nội dung dài hơn để mô phỏng lịch sử hội thoại lớn.`).join('\n');
  const k1 = keyOf(baseInput({ historyText: longHistory }));
  const k2 = keyOf(baseInput({ historyText: longHistory }));
  assert.strictEqual(k1, k2);
});

test('cache key: history with Unicode/LaTeX content produces a stable fingerprint', () => {
  const unicodeHistory = 'User: Giải phương trình \\(x^2 - \\sqrt{5}x + \\pi = 0\\) với ký tự đặc biệt: ∫∑√≠≤≥ và tiếng Việt có dấu.';
  const k1 = keyOf(baseInput({ historyText: unicodeHistory }));
  const k2 = keyOf(baseInput({ historyText: unicodeHistory }));
  assert.strictEqual(k1, k2);
  // và vẫn phải khác với history khác (không phải collision ẩn do lỗi encode)
  const k3 = keyOf(baseInput({ historyText: 'User: Giải phương trình khác \\(y^2 = 4\\)' }));
  assert.notStrictEqual(k1, k3);
});

test('end-to-end: conversation A cache write does not leak into conversation B with different history (same question)', () => {
  const question = 'Giải phương trình bậc 2: x^2 - 5x + 6 = 0';
  const inputA = baseInput({ problemText: question, historyText: 'User: đã học đạo hàm\nAI: ok' });
  const inputB = baseInput({ problemText: question, historyText: 'User: đã học tích phân\nAI: ok' });

  const planA = te.runTokenEconomyPipeline(inputA);
  assert.strictEqual(planA.cacheHit, false);
  te.globalCache.set('L1', planA.cacheKeyParts, { text: 'answer tailored to conversation A (đạo hàm context)' });

  const planB = te.runTokenEconomyPipeline(inputB);
  assert.strictEqual(planB.cacheHit, false, 'conversation B (history khác) KHÔNG được cache-hit vào response của A');

  te.globalCache.set('L1', planB.cacheKeyParts, { text: 'answer tailored to conversation B (tích phân context)' });
  const planAAgain = te.runTokenEconomyPipeline(inputA);
  assert.strictEqual(planAAgain.cacheHit, true);
  assert.strictEqual(planAAgain.cachedValue.text, 'answer tailored to conversation A (đạo hàm context)', 'A phải vẫn nhận đúng response của chính nó, không bị B ghi đè');
});

let passed = 0, failed = 0;
console.log('\n== Regression: cache fingerprint không collision (mục PHẦN 2) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
