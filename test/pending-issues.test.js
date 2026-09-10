'use strict';

// ============================================================================================
// TEST cho 4 VẤN ĐỀ CÒN TỒN ĐỌNG đã xử lý ở vòng này
//   #1 Stable citation index -> bật được context dedupe (trước đây là dead code)
//   #2 Nén nội dung đoạn trích nguồn (nâng tỷ lệ nén cho request nhiều nguồn)
//   #3 Rotation store dùng chung -> fairness/cooldown qua nhiều serverless instance
//   #4 Token counter tự hiệu chỉnh từ `usage` thật của provider (thay hằng số 3.2)
// Chạy: node test/pending-issues.test.js
// ============================================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { buildCitationIndex, resolveCiteNo } = require('../server/utils/citationIndex');
const { validateCitations } = require('../server/utils/citationValidator');
const { validateSolutionCompleteness } = require('../server/utils/completenessCheck');
const { citeNoRangeLabel } = require('../server/utils/promptBuilder');
const cc = require('../server/utils/contextCompressor');
const rotation = require('../server/utils/rotationManager');
const rotationStore = require('../server/utils/rotationStore');
const tokenCounter = require('../server/utils/tokenCounter');
const { estimateTokens } = require('../server/utils/adaptiveBudget');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

const PYTAGO = 'Định lý Pytago: trong tam giác vuông, a^2 + b^2 = c^2 với c là cạnh huyền.';
const HERON = 'Công thức Heron: diện tích tam giác theo ba cạnh a, b, c và nửa chu vi p.';
const AREA = 'Diện tích tam giác vuông bằng nửa tích hai cạnh góc vuông.';

function sampleContexts() {
  return [
    { doc: 'SGK9', id: 1, text: PYTAGO },
    { doc: 'SGK9', id: 2, text: AREA },
    { doc: 'ThamKhao', id: 9, text: PYTAGO },   // TRÙNG với [1]
    { doc: 'SGK10', id: 3, text: HERON }
  ];
}

console.log('\n== VẤN ĐỀ #1 — Stable citation index + context dedupe ==');

test('1.1 đoạn trùng được gộp, citeNo của các đoạn còn lại KHÔNG bị dịch', () => {
  const idx = buildCitationIndex(sampleContexts());
  assert.strictEqual(idx.duplicatesMerged, 1);
  assert.strictEqual(idx.effectiveContexts.length, 3, 'gửi cho model 3 đoạn thay vì 4');
  // Đây chính là điểm mấu chốt: Heron vẫn là [4], KHÔNG tụt xuống [3] như khi dedupe bằng cách
  // bỏ phần tử khỏi mảng (cách đó là lý do dedupe không thể bật được ở các bản trước).
  assert.deepStrictEqual(idx.validCiteNos, [1, 2, 4]);
  const heron = idx.effectiveContexts.find((c) => c.text === HERON);
  assert.strictEqual(heron.citeNo, 4);
});

test('1.2 citeNo của đoạn bị gộp trở thành ALIAS, không bị coi là citation bịa', () => {
  const idx = buildCitationIndex(sampleContexts());
  assert.strictEqual(idx.aliasOf[3], 1, '[3] (bản trùng của Pytago) phải trỏ về [1]');
  const v = validateCitations('Theo [3] ta có a^2 + b^2 = c^2.', idx.effectiveContexts, idx);
  assert.strictEqual(v.valid, true, 'số cũ vẫn resolve được, không bị báo là bịa');
  assert.deepStrictEqual(v.invalidCitations, []);
});

test('1.3 citation THẬT SỰ bịa vẫn bị bắt', () => {
  const idx = buildCitationIndex(sampleContexts());
  const v = validateCitations('Theo [9] và [12] ta có…', idx.effectiveContexts, idx);
  assert.strictEqual(v.valid, false);
  assert.deepStrictEqual(v.invalidCitations, [9, 12]);
});

test('1.4 validate theo TẬP chứ không theo KHOẢNG (lỗi kinh điển khi tập không liên tục)', () => {
  const idx = buildCitationIndex(sampleContexts());
  // Sau gộp còn 3 đoạn. Nếu validate theo khoảng 1..length=3 thì [4] (thật) sẽ bị coi là BỊA.
  const v = validateCitations('Theo [4] công thức Heron…', idx.effectiveContexts, idx);
  assert.strictEqual(v.valid, true, '[4] là số thật của Heron, không được coi là bịa');
});

test('1.5 prompt liệt kê ĐÚNG tập số khi không liên tục (không mời model bịa số trống)', () => {
  const idx = buildCitationIndex(sampleContexts());
  assert.strictEqual(citeNoRangeLabel(idx.effectiveContexts), '[1], [2], [4]');
  // Trường hợp liên tục vẫn dùng dạng khoảng gọn để đỡ token.
  assert.strictEqual(citeNoRangeLabel([{ citeNo: 1 }, { citeNo: 2 }, { citeNo: 3 }]), '[1]-[3]');
});

test('1.6 completenessCheck chuyển tiếp validCiteNos/aliasOf xuống validator', () => {
  const idx = buildCitationIndex(sampleContexts());
  const r = validateSolutionCompleteness('Ta dùng [4] để tính. Vậy S = 6.', {
    stage: 'detail', finishReason: 'stop',
    contexts: idx.effectiveContexts, validCiteNos: idx.validCiteNos, aliasOf: idx.aliasOf
  });
  assert.ok(r.citationValidation, 'phải có kết quả validate citation');
  assert.strictEqual(r.citationValidation.valid, true, '[4] hợp lệ nhờ validCiteNos được truyền xuống');
  assert.ok(!r.hardReasons.includes('invalid_citation'));
});

test('1.7 KHÔNG truyền validCiteNos -> hành vi cũ (tương thích ngược)', () => {
  const v = validateCitations('Theo [2]', [{ text: 'a' }, { text: 'b' }]);
  assert.strictEqual(v.valid, true);
  const v2 = validateCitations('Theo [5]', [{ text: 'a' }, { text: 'b' }]);
  assert.strictEqual(v2.valid, false);
});

test('1.8 chat.js THỰC SỰ dùng effectiveContexts (dedupe không còn là dead code)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(src.includes('buildCitationIndex(input.contexts)'), 'phải build citation index từ contexts đầu vào');
  assert.ok(src.includes('input.contexts = effectiveContexts'), 'phải thay contexts bằng bản đã gộp');
  assert.ok(src.includes('citationMap: citationIndex.citationMap'), 'payload phải trả citationMap cho client');
});

test('1.9 client dùng citationMap thay vì suy ra theo vị trí mảng', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(/function getUsedContexts\(contexts, answerText, citationMap\)/.test(src));
  assert.ok(src.includes('entry.originalIndexes'), 'phải map citeNo -> chỉ số gốc trong mảng client');
  assert.ok(src.includes('approachCitationMap') && src.includes('detailCitationMap'),
    'phải lưu citationMap để render lại từ lịch sử vẫn đúng đoạn');
});

test('1.10 resolveCiteNo xử lý đúng số hợp lệ / alias / bịa', () => {
  const idx = buildCitationIndex(sampleContexts());
  assert.strictEqual(resolveCiteNo(2, idx), 2);
  assert.strictEqual(resolveCiteNo(3, idx), 1);
  assert.strictEqual(resolveCiteNo(99, idx), null);
});

console.log('\n== VẤN ĐỀ #2 — Nén nội dung đoạn trích nguồn ==');

function excerptsWithBoilerplate(n) {
  const header = 'Tài liệu ôn tập — Trường THPT chuyên';
  const footer = 'Bản quyền thuộc tổ Toán, lưu hành nội bộ';
  return Array.from({ length: n }, (_, i) => ({
    doc: 'OnTap', id: i + 1, citeNo: i + 1,
    text: `${header}\n${footer}\nNội dung đoạn ${i + 1}: chu vi hình tròn bằng hai pi R.\nR_${i + 1} = ${(i + 1) * 5} cm`
  }));
}

test('2.1 header/footer lặp giữa các đoạn bị loại, nội dung học thuật giữ nguyên', () => {
  const src = excerptsWithBoilerplate(5);
  const r = cc.compressSourceExcerpts(src);
  assert.ok(r.droppedBoilerplateLines > 0, 'phải loại được dòng boilerplate lặp');
  assert.ok(r.compressedTokens < r.rawTokens, 'phải tiết kiệm token');
  r.contexts.forEach((c, i) => {
    assert.ok(c.text.includes(`Nội dung đoạn ${i + 1}`), 'nội dung thật phải còn');
    assert.ok(c.text.includes(`R_${i + 1} = ${(i + 1) * 5} cm`), 'dòng dữ liệu phải còn');
  });
});

test('2.2 KHÔNG BAO GIỜ loại bỏ cả một đoạn (gộp nguồn là việc của citationIndex)', () => {
  const src = excerptsWithBoilerplate(5);
  const r = cc.compressSourceExcerpts(src);
  assert.strictEqual(r.contexts.length, src.length);
  assert.deepStrictEqual(r.contexts.map((c) => c.citeNo), src.map((c) => c.citeNo), 'citeNo không được đổi');
});

test('2.3 không mất số/công thức nào (quality gate)', () => {
  const src = excerptsWithBoilerplate(6);
  const r = cc.compressSourceExcerpts(src);
  const nums = (t) => new Set(t.match(/-?\d+(?:[.,]\d+)?/g) || []);
  const before = src.map((c) => c.text).join('\n');
  const after = r.contexts.map((c) => c.text).join('\n');
  assert.deepStrictEqual([...nums(before)].filter((n) => !nums(after).has(n)), []);
});

test('2.4 đoạn đã bị cắt (truncated) chỉ được nén LOSSLESS, không bớt thêm', () => {
  const src = excerptsWithBoilerplate(3).map((c, i) => (i === 0 ? { ...c, truncated: true } : c));
  const r = cc.compressSourceExcerpts(src);
  assert.ok(r.contexts[0].text.includes('Tài liệu ôn tập'), 'đoạn truncated giữ nguyên cả boilerplate');
});

test('2.5 chỉ có 1 đoạn -> không có khái niệm "lặp giữa các đoạn", chỉ normalize', () => {
  const one = [{ doc: 'D', id: 1, citeNo: 1, text: 'Header\n\n\n\nNội dung: S = 12 cm²   ' }];
  const r = cc.compressSourceExcerpts(one);
  assert.strictEqual(r.droppedBoilerplateLines, 0);
  assert.ok(r.contexts[0].text.includes('Header'), 'không được bỏ dòng khi chưa biết nó có lặp không');
  assert.ok(r.contexts[0].text.includes('S = 12 cm²'));
});

test('2.6 dòng lặp CÓ dữ liệu thì KHÔNG bị loại (dù lặp)', () => {
  const src = [1, 2, 3].map((i) => ({
    doc: 'D', id: i, citeNo: i,
    text: 'Hằng số g = 9.8 m/s²\nNội dung riêng của đoạn ' + i
  }));
  const r = cc.compressSourceExcerpts(src);
  r.contexts.forEach((c) => assert.ok(c.text.includes('g = 9.8'), 'dòng có dữ liệu không được loại dù lặp'));
});

console.log('\n== VẤN ĐỀ #3 — Rotation store dùng chung (cross-instance) ==');

const mkT = (id, k, m) => ({ id, keyId: k, modelId: `${k}::${m}`, providerKey: k, modelName: m, label: id, capabilities: {} });

test('3.1 không cấu hình ROTATION_STORE_* -> tắt hoàn toàn, hành vi cũ giữ nguyên', () => {
  assert.strictEqual(rotationStore.isEnabled(), false);
  assert.strictEqual(rotationStore.getStoreStats().enabled, false);
});

test('3.2 hydrate() không bao giờ throw khi store tắt/lỗi', async () => {
  const p = rotationStore.hydrate();
  assert.ok(p instanceof Promise);
});

test('3.3 exportSnapshot KHÔNG chứa khóa API hay nội dung request', () => {
  rotation._resetRotationStateForTest();
  const T = [mkT('T1', 'k1', 'm'), mkT('T2', 'k2', 'm')];
  rotation.markSuccess(T[0], 100);
  rotation.markFailure(T[1], Object.assign(new Error('rate'), { status: 429 }));
  const dumped = JSON.stringify(rotation.exportSnapshot());
  assert.ok(!/sk-|Bearer|apiKey|api_key/i.test(dumped), 'không được lộ khóa');
  assert.ok(dumped.includes('T1'), 'phải có mốc LRU của target');
});

test('3.4 applySnapshot MERGE cooldown theo hướng THẬN TRỌNG (lấy giá trị lớn hơn)', () => {
  rotation._resetRotationStateForTest();
  const T = [mkT('T1', 'k1', 'm'), mkT('T2', 'k2', 'm'), mkT('T3', 'k3', 'm')];
  const future = Date.now() + 60000;
  // Instance khác vừa thấy 429 cho khóa k2 -> instance này phải tôn trọng cooldown đó.
  rotation.applySnapshot({ v: 1, seq: 3, lru: {}, key: { k2: { cooldownUntil: future } } });
  const eligible = rotation.getEligibleTargets(T, {});
  assert.deepStrictEqual(eligible.map((t) => t.id), ['T1', 'T3'], 'T2 phải bị loại nhờ cooldown từ instance khác');
});

test('3.5 applySnapshot MERGE mốc LRU (không "làm mới" oan target vừa được instance khác dùng)', () => {
  rotation._resetRotationStateForTest();
  const T = [mkT('T1', 'k1', 'm'), mkT('T2', 'k2', 'm'), mkT('T3', 'k3', 'm')];
  rotation.applySnapshot({ v: 1, seq: 10, lru: { T1: 10, T2: 9 }, key: {}, model: {}, target: {} });
  const head = rotation.orderByRotation(rotation.getEligibleTargets(T, {}))[0];
  assert.strictEqual(head.id, 'T3', 'T3 chưa từng được dùng ở đâu -> phải đi đầu');
});

test('3.6 applySnapshot không bao giờ XOÁ cooldown đang có tại local', () => {
  rotation._resetRotationStateForTest();
  const T = [mkT('T1', 'k1', 'm')];
  rotation.markFailure(T[0], Object.assign(new Error('rate'), { status: 429 }));
  const beforeCount = rotation.getEligibleTargets(T, {}).length;
  rotation.applySnapshot({ v: 1, seq: 1, lru: {}, key: { k1: { cooldownUntil: 0 } } });
  assert.strictEqual(rotation.getEligibleTargets(T, {}).length, beforeCount,
    'snapshot có cooldownUntil=0 không được xoá cooldown local');
});

test('3.7 ensureProvidersReady() hydrate store trước khi chọn target', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'aiProviders.js'), 'utf8');
  assert.ok(/await rotationStore\.hydrate\(\)/.test(src), 'phải hydrate ở đầu vòng đời request');
});

console.log('\n== VẤN ĐỀ #4 — Token counter tự hiệu chỉnh ==');

test('4.1 chưa có mẫu -> giữ ĐÚNG hằng số cũ 3.2 (không đổi hành vi/test hiện có)', () => {
  tokenCounter._resetForTest();
  const s = 'x'.repeat(320);
  assert.strictEqual(tokenCounter.charsPerToken('anthropic'), tokenCounter.DEFAULT_CHARS_PER_TOKEN);
  assert.strictEqual(estimateTokens(s), 100);
});

test('4.2 học được tỷ lệ thật từ usage của provider', () => {
  tokenCounter._resetForTest();
  for (let i = 0; i < 4; i++) tokenCounter.recordUsage('anthropic', { chars: 2400, tokens: 1000 });
  assert.ok(Math.abs(tokenCounter.charsPerToken('anthropic') - 2.4) < 0.05,
    `phải hội tụ về ~2.4 (thấy ${tokenCounter.charsPerToken('anthropic')})`);
});

test('4.3 tỷ lệ khác nhau theo provider (mỗi hãng 1 tokenizer)', () => {
  tokenCounter._resetForTest();
  for (let i = 0; i < 4; i++) {
    tokenCounter.recordUsage('anthropic', { chars: 2400, tokens: 1000 }); // 2.4
    tokenCounter.recordUsage('gemini', { chars: 4000, tokens: 1000 });    // 4.0
  }
  const a = estimateTokens('y'.repeat(1000), { provider: 'anthropic' });
  const g = estimateTokens('y'.repeat(1000), { provider: 'gemini' });
  assert.ok(a > g, `cùng độ dài, provider có tỷ lệ thấp phải cho nhiều token hơn (${a} vs ${g})`);
});

test('4.4 bỏ qua mẫu quá ngắn và giá trị vô lý (chống nhiễu)', () => {
  tokenCounter._resetForTest();
  tokenCounter.recordUsage('openai', { chars: 50, tokens: 20 });   // quá ngắn
  tokenCounter.recordUsage('openai', { chars: 1000, tokens: 0 });  // tokens không hợp lệ
  assert.strictEqual(tokenCounter.charsPerToken('openai'), tokenCounter.DEFAULT_CHARS_PER_TOKEN);
});

test('4.5 tỷ lệ luôn bị kẹp trong bound an toàn', () => {
  tokenCounter._resetForTest();
  for (let i = 0; i < 6; i++) tokenCounter.recordUsage('weird', { chars: 100000, tokens: 1 });
  const r = tokenCounter.charsPerToken('weird');
  assert.ok(r <= tokenCounter.MAX_CHARS_PER_TOKEN && r >= tokenCounter.MIN_CHARS_PER_TOKEN, `bound: ${r}`);
});

test('4.6 cả 3 client đều trích xuất usage thật vào meta', () => {
  const dir = path.join(__dirname, '..', 'server', 'utils');
  const a = fs.readFileSync(path.join(dir, 'anthropicClient.js'), 'utf8');
  const o = fs.readFileSync(path.join(dir, 'openaiCompatibleClient.js'), 'utf8');
  const g = fs.readFileSync(path.join(dir, 'geminiClient.js'), 'utf8');
  assert.ok(a.includes('data.usage.input_tokens'), 'anthropic: usage non-stream');
  assert.ok(a.includes('evt.usage.output_tokens'), 'anthropic: usage stream');
  assert.ok(o.includes('data.usage.prompt_tokens'), 'openai-compatible: usage');
  assert.ok(g.includes('promptTokenCount'), 'gemini: usageMetadata');
});

test('4.7 aiProviders ưu tiên token THẬT hơn ước lượng khi tính throughput', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'aiProviders.js'), 'utf8');
  assert.ok(src.includes('tokenCounter.recordUsage'), 'phải nạp mẫu hiệu chỉnh');
  assert.ok(/meta\.usage && Number\(meta\.usage\.outputTokens\)/.test(src), 'phải đọc usage thật');
});

test('4.8 snapshot telemetry không lộ nội dung', () => {
  tokenCounter._resetForTest();
  tokenCounter.recordUsage('anthropic', { text: 'nội dung bí mật '.repeat(30), tokens: 200 });
  const dumped = JSON.stringify(tokenCounter.snapshot());
  assert.ok(!dumped.includes('bí mật'), 'không được log nội dung');
});

console.log('\n== VÒNG 3 — Fairness TUYỆT ĐỐI + hiệu chỉnh theo loại nội dung + chia sẻ calibration ==');

test('V3.1 slot toàn cục -> round-robin XÁC ĐỊNH (fairness tuyệt đối, không còn eventual)', () => {
  rotation._resetRotationStateForTest();
  const T = [mkT('T1', 'k1', 'm'), mkT('T2', 'k2', 'm'), mkT('T3', 'k3', 'm'), mkT('T4', 'k4', 'm')];
  const heads = [];
  for (let slot = 1; slot <= 8; slot++) {
    rotation.setGlobalRotationSlot(slot);
    heads.push(rotation.orderByRotation(T)[0].id);
  }
  assert.deepStrictEqual(heads, ['T2', 'T3', 'T4', 'T1', 'T2', 'T3', 'T4', 'T1']);
});

test('V3.2 cùng slot -> cùng target trên MỌI instance (không phụ thuộc thứ tự mảng đầu vào)', () => {
  rotation._resetRotationStateForTest();
  const T = [mkT('A', 'k1', 'm'), mkT('B', 'k2', 'm'), mkT('C', 'k3', 'm')];
  rotation.setGlobalRotationSlot(5);
  const h1 = rotation.orderByRotation(T)[0].id;
  rotation.setGlobalRotationSlot(5);
  const h2 = rotation.orderByRotation([...T].reverse())[0].id;
  assert.strictEqual(h1, h2, 'nếu khác nhau thì 2 instance sẽ map cùng slot vào 2 target -> vỡ fairness');
});

test('V3.3 không có slot (store tắt/lỗi) -> quay về LRU local, vẫn công bằng', () => {
  rotation._resetRotationStateForTest();
  rotation.setGlobalRotationSlot(null);
  const T = [mkT('T1', 'k1', 'm'), mkT('T2', 'k2', 'm'), mkT('T3', 'k3', 'm')];
  const heads = [];
  for (let i = 0; i < 4; i++) {
    const h = rotation.orderByRotation(rotation.getEligibleTargets(T, {}))[0];
    heads.push(h.id);
    rotation.markSuccess(h, 50);
  }
  assert.deepStrictEqual(heads, ['T1', 'T2', 'T3', 'T1']);
});

test('V3.4 slot vẫn tôn trọng cooldown (chỉ xoay trong tập ELIGIBLE)', () => {
  rotation._resetRotationStateForTest();
  const T = [mkT('T1', 'k1', 'm'), mkT('T2', 'k2', 'm'), mkT('T3', 'k3', 'm')];
  rotation.markFailure(T[1], Object.assign(new Error('rate'), { status: 429 }));
  const eligible = rotation.getEligibleTargets(T, {});
  for (let slot = 1; slot <= 6; slot++) {
    rotation.setGlobalRotationSlot(slot);
    const head = rotation.orderByRotation(eligible)[0];
    assert.notStrictEqual(head.id, 'T2', 'target đang cooldown không bao giờ được chọn dù slot trỏ vào nó');
  }
});

test('V3.5 phân lớp nội dung: văn xuôi vs LaTeX/JSON', () => {
  assert.strictEqual(
    tokenCounter.classifyContent('Cho tam giác ABC vuông tại A, tính diện tích tam giác đó theo a.'),
    tokenCounter.CONTENT_CLASS.PROSE
  );
  assert.strictEqual(
    tokenCounter.classifyContent('$$S = \\frac{1}{2}ab\\sin C$$ {"ops":[{"op":"point","id":"A","x":0,"y":0}]}'),
    tokenCounter.CONTENT_CLASS.SYMBOLIC
  );
});

test('V3.6 hiệu chỉnh RIÊNG theo loại nội dung (LaTeX tốn token hơn văn xuôi cùng độ dài)', () => {
  tokenCounter._resetForTest();
  for (let i = 0; i < 4; i++) {
    tokenCounter.recordUsage('anthropic', { chars: 2400, tokens: 1000, contentClass: 'prose' });
    tokenCounter.recordUsage('anthropic', { chars: 1400, tokens: 1000, contentClass: 'symbolic' });
  }
  const prose = estimateTokens('a'.repeat(1000), { provider: 'anthropic', contentClass: 'prose' });
  const sym = estimateTokens('a'.repeat(1000), { provider: 'anthropic', contentClass: 'symbolic' });
  assert.ok(sym > prose, `cùng 1000 ký tự, LaTeX phải cho nhiều token hơn (${sym} vs ${prose})`);
});

test('V3.7 lớp chưa đủ mẫu -> fallback về mức provider, rồi về hằng số (không bao giờ trả giá trị vô nghĩa)', () => {
  tokenCounter._resetForTest();
  for (let i = 0; i < 4; i++) tokenCounter.recordUsage('openai', { chars: 3000, tokens: 1000, contentClass: 'prose' });
  // lớp 'symbolic' chưa có mẫu riêng -> phải rơi về mức provider (3.0), không phải 3.2
  assert.ok(Math.abs(tokenCounter.charsPerToken('openai', 'symbolic') - 3.0) < 0.05);
  // provider hoàn toàn mới -> hằng số mặc định
  assert.strictEqual(tokenCounter.charsPerToken('unknown-provider', 'prose'), tokenCounter.DEFAULT_CHARS_PER_TOKEN);
});

test('V3.8 chia sẻ calibration qua snapshot: instance mới KHÔNG phải học lại từ đầu', () => {
  tokenCounter._resetForTest();
  for (let i = 0; i < 5; i++) tokenCounter.recordUsage('anthropic', { chars: 2400, tokens: 1000, contentClass: 'prose' });
  const shared = tokenCounter.snapshot();
  tokenCounter._resetForTest(); // mô phỏng cold start ở instance khác
  assert.strictEqual(tokenCounter.charsPerToken('anthropic', 'prose'), tokenCounter.DEFAULT_CHARS_PER_TOKEN);
  tokenCounter.applySnapshot(shared);
  assert.ok(Math.abs(tokenCounter.charsPerToken('anthropic', 'prose') - 2.4) < 0.05);
});

test('V3.9 merge calibration lấy bên NHIỀU MẪU HƠN (không trung bình mù)', () => {
  tokenCounter._resetForTest();
  tokenCounter.recordUsage('anthropic', { chars: 5000, tokens: 1000, contentClass: 'prose' }); // 1 mẫu nhiễu, ratio 5.0
  tokenCounter.applySnapshot({ 'anthropic::prose': { charsPerToken: 2.4, samples: 200 } });
  assert.ok(Math.abs(tokenCounter.charsPerToken('anthropic', 'prose') - 2.4) < 0.05,
    '200 mẫu ổn định phải thắng 1 mẫu nhiễu');
  // và ngược lại: snapshot ít mẫu KHÔNG được ghi đè dữ liệu local nhiều mẫu
  tokenCounter.applySnapshot({ 'anthropic::prose': { charsPerToken: 5.9, samples: 2 } });
  assert.ok(Math.abs(tokenCounter.charsPerToken('anthropic', 'prose') - 2.4) < 0.05);
});

test('V3.10 rotationStore chia sẻ calibration qua CÙNG snapshot (không thêm lượt gọi mạng)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'rotationManager.js'), 'utf8');
  assert.ok(src.includes("registerExtra"), 'phải đăng ký tokenCalib vào snapshot dùng chung');
  assert.ok(src.includes("name: 'tokenCalib'"));
});

test('V3.11 ngưỡng gộp nguồn cấu hình được và luôn bị kẹp an toàn', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'citationIndex.js'), 'utf8');
  assert.ok(src.includes('CITATION_NEAR_DUP_THRESHOLD'), 'phải đọc được từ .env');
  assert.ok(/Math\.max\(0\.75/.test(src), 'phải kẹp sàn 0.75 để không thể gộp bừa');
});

test('V3.12 appendContinuationTurn được đánh dấu @deprecated và KHÔNG còn nằm trên đường chạy thật', () => {
  const contSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'continuation.js'), 'utf8');
  assert.ok(/@deprecated[\s\S]{0,900}function appendContinuationTurn/.test(contSrc), 'phải có ghi chú @deprecated');
  const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/appendContinuationTurn\(/.test(chatSrc), 'chat.js không được GỌI hàm cũ nữa');
});

test('V3.13 có script live-smoke để kiểm bằng API key thật (thứ mock không thể thay thế)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['live-smoke'], 'package.json phải có npm run live-smoke');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'live-smoke.js'), 'utf8');
  assert.ok(src.includes('usage'), 'phải kiểm chứng trường usage thật của provider');
  assert.ok(src.includes('runResumableStream'), 'phải kiểm continuation thật xuyên provider');
  assert.ok(src.includes('KHÔNG lặp câu ở điểm nối'), 'phải kiểm lặp text ở điểm nối bằng dữ liệu thật');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
