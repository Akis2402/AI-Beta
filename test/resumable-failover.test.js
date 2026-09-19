'use strict';

// ============================================================================================
// PHẦN S — TEST FAILOVER / RESUME / ROTATION (40 yêu cầu)
// ============================================================================================
// Chạy: node test/resumable-failover.test.js
//
// KHÔNG gọi mạng: `streamFn` được inject vào runResumableStream() dưới dạng stub mô phỏng đúng HỢP
// ĐỒNG của aiProviders.streamWithFailover() sau bản fix PHẦN B (trả text đã sinh + cờ interrupted).
// Các test rotation dùng target giả (chỉ cần .id/.keyId/.modelId/.providerKey) qua rotationManager.

const assert = require('assert');
const { runResumableStream, runResumableNonStream } = require('../server/utils/resumableStream');
const { createStreamSession, STAGE } = require('../server/utils/streamSession');
const rotation = require('../server/utils/rotationManager');
const { validateSolutionCompleteness } = require('../server/utils/completenessCheck');
const { classifyFinalOutcome, STATES } = require('../server/utils/runtimeState');
const { createSeamDedupe, joinContinuation, computeRecoveryBudget, MAX_CONTINUATIONS } = require('../server/utils/continuation');
const throughput = require('../server/utils/throughputStats');
const { createRequestDeadline } = require('../server/utils/requestDeadline');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

// ---------- Hạ tầng mock ----------
function mkTarget(id, providerKey = 'p', modelName = 'm') {
  return {
    id, keyId: providerKey, modelId: `${providerKey}::${modelName}`, providerKey, modelName,
    label: id, supportsWebSearch: false, capabilities: {},
    call: async () => 'ok', callStream: async () => 'ok'
  };
}

/**
 * Tạo stub streamFn theo 1 KỊCH BẢN: mảng các "lượt", mỗi lượt là
 *   { chunks:[...], interrupted?:boolean, finishReason?:'stop'|'length', throwBefore?:Error, target?:string }
 * Lượt thứ n được dùng cho lần gọi thứ n (giống việc rotation trao target khác nhau).
 */
function makeStreamStub(script) {
  let call = 0;
  const log = [];
  const fn = async (providers, args, onDelta) => {
    const step = script[Math.min(call, script.length - 1)];
    call += 1;
    log.push({ maxTokens: args.maxTokens, messages: args.messages, target: step.target || `T${call}` });
    if (step.throwBefore) throw step.throwBefore; // CASE 1: lỗi trước delta đầu tiên (mọi target đều lỗi)
    let text = '';
    for (const c of step.chunks || []) { text += c; onDelta(c); }
    return {
      text,
      provider: mkTarget(step.target || `T${call}`),
      tried: [],
      interrupted: !!step.interrupted,
      finishReason: step.interrupted ? null : (step.finishReason || 'stop')
    };
  };
  fn.log = log;
  fn.calls = () => call;
  return fn;
}

const evaluateSimple = (text, sig) => validateSolutionCompleteness(text, {
  stage: 'detail', finishReason: sig.finishReason, interrupted: sig.interrupted
});

function alwaysAllow(amount = 1500) {
  return () => ({ allow: true, amount });
}

async function run(script, overrides = {}) {
  const streamFn = overrides.streamFn || makeStreamStub(script);
  const out = await runResumableStream({
    providers: [mkTarget('T1'), mkTarget('T2'), mkTarget('T3'), mkTarget('T4')],
    streamFn,
    messages: [{ role: 'user', content: 'Giải bài toán: tính diện tích tam giác ABC.' }],
    // buildArgs do route sở hữu trong code thật (chat.js) — ở test chỉ cần chuyển tiếp messages/maxTokens.
    buildArgs: ({ messages, maxTokens }) => ({ system: 's', messages, maxTokens }),
    onDelta: overrides.onDelta || (() => {}),
    onStatus: overrides.onStatus || (() => {}),
    evaluate: overrides.evaluate || evaluateSimple,
    resolveRecovery: overrides.resolveRecovery || alwaysAllow(),
    deadline: overrides.deadline || createRequestDeadline(60000),
    signal: overrides.signal,
    isDisconnected: overrides.isDisconnected,
    sessionInit: { coreBudget: 2000, totalBudget: 3000, recoveryBudget: 1000, requestStage: 'detail' }
  });
  return { ...out, streamFn };
}

const GOOD_END = ' Vậy diện tích tam giác là 6 cm².';

async function main() {
  console.log('\n== 1-4. Các CASE cơ bản của stream ==');

  await test('1. normal stream complete -> COMPLETE, không continuation nào', async () => {
    const r = await run([{ chunks: ['Bước 1: ta có AB = 3.', GOOD_END], finishReason: 'stop' }]);
    assert.strictEqual(r.completeness.status, 'COMPLETE');
    assert.strictEqual(r.continuations, 0, 'không được gọi AI thêm khi đã xong');
    assert.strictEqual(r.streamFn.calls(), 1, 'đúng 1 lệnh gọi provider');
  });

  await test('2. provider lỗi TRƯỚC delta đầu tiên -> lỗi nổi lên từ streamWithFailover (CASE 1 do tầng dưới xử lý)', async () => {
    const err = Object.assign(new Error('connect fail'), { status: 503 });
    let thrown = null;
    try { await run([{ throwBefore: err }]); } catch (e) { thrown = e; }
    assert.ok(thrown, 'lỗi trước delta đầu tiên phải nổi lên (không có gì để resume)');
  });

  await test('3. provider timeout SAU delta -> KHÔNG FAILED ngay, giữ text và chuyển RESUME', async () => {
    const r = await run([
      { chunks: ['Bước 1: AB = 3 cm.'], interrupted: true, target: 'A' },
      { chunks: [' Bước 2: S = 6 cm².' + GOOD_END], finishReason: 'stop', target: 'B' }
    ]);
    assert.ok(r.text.includes('Bước 1: AB = 3 cm.'), 'phần đã sinh KHÔNG được mất');
    assert.ok(r.text.includes('Bước 2'), 'phần tiếp nối phải được ghép vào');
    assert.strictEqual(r.resumes, 1, 'phải đúng 1 lượt RESUME');
    assert.strictEqual(r.completeness.status, 'COMPLETE');
  });

  await test('4. network error sau delta -> interrupted là HARD, buộc recovery (không âm thầm coi là xong)', async () => {
    // Text kết thúc "gọn" (sau dấu chấm) — heuristic hình thức sẽ tưởng đã xong nếu KHÔNG có cờ interrupted.
    const cutText = 'Bước 1: ta có AB = 3 cm.';
    const withoutFlag = validateSolutionCompleteness(cutText, { stage: 'detail', finishReason: 'stop' });
    const withFlag = validateSolutionCompleteness(cutText, { stage: 'detail', finishReason: 'stop', interrupted: true });
    assert.strictEqual(withoutFlag.status, 'COMPLETE', 'chứng minh root cause: không có cờ thì bị coi là COMPLETE');
    assert.strictEqual(withFlag.severity, 'HARD', 'có cờ interrupted phải là HARD');
    assert.ok(withFlag.hardReasons.includes('stream_interrupted'));
  });

  console.log('\n== 5-7. Chuỗi resume nhiều provider (PHẦN L) ==');

  await test('5. A partial -> B resume: người dùng thấy MỘT chuỗi delta liên tục', async () => {
    const seen = [];
    const r = await run([
      { chunks: ['Phần A: x = 1.'], interrupted: true, target: 'A' },
      { chunks: [' Phần B: y = 2.' + GOOD_END], finishReason: 'stop', target: 'B' }
    ], { onDelta: (p) => seen.push(p) });
    assert.ok(seen.length >= 2, 'delta phải được phát ra liên tục qua cả 2 provider');
    assert.strictEqual(seen.join(''), r.text, 'text người dùng thấy phải KHỚP CHÍNH XÁC text cuối cùng');
  });

  await test('6. A partial -> B partial -> C hoàn thành (A->B->C)', async () => {
    const r = await run([
      { chunks: ['A: bước 1, x = 1.'], interrupted: true, target: 'A' },
      { chunks: [' B: bước 2, y = 2.'], interrupted: true, target: 'B' },
      { chunks: [' C: bước 3, z = 3.' + GOOD_END], finishReason: 'stop', target: 'C' }
    ]);
    assert.strictEqual(r.streamFn.calls(), 3, 'đúng 3 lượt gọi (A, B, C)');
    assert.strictEqual(r.resumes, 2, '2 lượt RESUME');
    assert.ok(r.text.includes('A:') && r.text.includes('B:') && r.text.includes('C:'), 'cả 3 phần phải có trong câu trả lời cuối');
    assert.strictEqual(r.completeness.status, 'COMPLETE');
  });

  await test('7. A->B->C->D vẫn hoạt động (chuỗi 4 provider)', async () => {
    const r = await run([
      { chunks: ['A1 x = 1.'], interrupted: true, target: 'A' },
      { chunks: [' B1 y = 2.'], interrupted: true, target: 'B' },
      { chunks: [' C1 z = 3.'], interrupted: true, target: 'C' },
      { chunks: [' D1 t = 4.' + GOOD_END], finishReason: 'stop', target: 'D' }
    ]);
    assert.strictEqual(r.streamFn.calls(), 4);
    assert.strictEqual(r.resumes, 3);
    assert.strictEqual(r.completeness.status, 'COMPLETE');
  });

  console.log('\n== 8-12. Continuation theo LÝ DO (finish_reason / cấu trúc) ==');

  await test('8. finishReason=length -> continuation (không phải interrupted)', async () => {
    const r = await run([
      { chunks: ['Bước 1: AB = 3 cm.'], finishReason: 'length', target: 'A' },
      { chunks: [' Bước 2 xong.' + GOOD_END], finishReason: 'stop', target: 'B' }
    ]);
    assert.strictEqual(r.resumes, 0, 'length không phải interrupted -> không tính là RESUME');
    assert.strictEqual(r.continuations, 1, 'nhưng vẫn phải continuation 1 lượt');
    assert.strictEqual(r.completeness.status, 'COMPLETE');
  });

  await test('9. unclosed LaTeX -> continuation', async () => {
    const r = await run([
      { chunks: ['Ta có $$S = \\frac{1}{2}ab'], finishReason: 'stop', target: 'A' },
      { chunks: ['\\sin C$$' + GOOD_END], finishReason: 'stop', target: 'B' }
    ]);
    assert.ok(r.continuations >= 1, 'LaTeX chưa đóng phải kích hoạt continuation');
    assert.strictEqual(r.completeness.status, 'COMPLETE');
  });

  await test('10. unclosed code fence -> continuation', async () => {
    const r = await run([
      { chunks: ['Kết quả:\n```\nx = 1'], finishReason: 'stop', target: 'A' },
      { chunks: ['\n```' + GOOD_END], finishReason: 'stop', target: 'B' }
    ]);
    assert.ok(r.continuations >= 1);
    assert.strictEqual(r.completeness.status, 'COMPLETE');
  });

  await test('11. drawing block chưa đóng -> continuation', async () => {
    const r = await run([
      { chunks: ['Hình:\n```shape\n{"ops":[{"op":"point","id":"A","x":0,"y":0}'], finishReason: 'stop', target: 'A' },
      { chunks: [']}\n```' + GOOD_END], finishReason: 'stop', target: 'B' }
    ]);
    assert.ok(r.continuations >= 1);
    assert.strictEqual(r.completeness.status, 'COMPLETE');
  });

  await test('12. SOFT warning KHÔNG trigger recovery (tiết kiệm token)', async () => {
    // finishReason=stop + thiếu từ khoá kết luận => chỉ SOFT.
    const r = await run([{ chunks: ['Bước 1: AB = 3 cm. Diện tích bằng 6 cm2 tất cả đều rõ ràng rồi.'], finishReason: 'stop' }]);
    assert.strictEqual(r.streamFn.calls(), 1, 'SOFT không được gọi thêm AI');
    assert.strictEqual(r.continuations, 0);
    assert.ok(classifyFinalOutcome(r.completeness, { textLength: r.text.length }).deliverable);
  });

  await test('13. continuation > 2 lượt được phép khi còn ngân sách (không còn cap cứng = 2)', async () => {
    const r = await run([
      { chunks: ['P1 a = 1.'], finishReason: 'length' },
      { chunks: [' P2 b = 2.'], finishReason: 'length' },
      { chunks: [' P3 c = 3.'], finishReason: 'length' },
      { chunks: [' P4 d = 4.' + GOOD_END], finishReason: 'stop' }
    ]);
    assert.strictEqual(r.continuations, 3, 'phải cho phép tới lượt thứ 3+');
    assert.strictEqual(r.completeness.status, 'COMPLETE');
  });

  console.log('\n== 14-17. ROTATION FAIRNESS (PHẦN K) ==');

  await test('14. rotation fairness: 4 target khoẻ -> R1..R4 mỗi target đúng 1 lần, R5 quay lại T1', async () => {
    rotation._resetRotationStateForTest();
    const targets = [mkTarget('T1'), mkTarget('T2'), mkTarget('T3'), mkTarget('T4')];
    const heads = [];
    for (let i = 0; i < 5; i++) {
      const ordered = rotation.orderByRotation(rotation.getEligibleTargets(targets, {}));
      heads.push(ordered[0].id);
      rotation.markSuccess(ordered[0], 100); // mô phỏng lượt gọi thành công thật
    }
    assert.deepStrictEqual(heads, ['T1', 'T2', 'T3', 'T4', 'T1'], `thứ tự thực tế: ${heads.join(' -> ')}`);
  });

  await test('15. cooldown KHÔNG reset cursor: T2 cooldown -> T3/T4 tiếp tục, KHÔNG quay về T1', async () => {
    rotation._resetRotationStateForTest();
    const targets = [mkTarget('T1', 'k1'), mkTarget('T2', 'k2'), mkTarget('T3', 'k3'), mkTarget('T4', 'k4')];
    // R1 -> T1
    let ordered = rotation.orderByRotation(rotation.getEligibleTargets(targets, {}));
    assert.strictEqual(ordered[0].id, 'T1');
    rotation.markSuccess(ordered[0], 100);
    // T2 vào cooldown (429 theo khóa riêng của nó)
    rotation.markFailure(targets[1], Object.assign(new Error('rate'), { status: 429, detail: 'try again in 60s' }));
    // R2 phải là T3 (T2 không eligible) — KHÔNG được là T1 (đó là hành vi reset cursor cũ)
    ordered = rotation.orderByRotation(rotation.getEligibleTargets(targets, {}));
    assert.notStrictEqual(ordered[0].id, 'T1', 'tập eligible đổi KHÔNG được làm rotation quay lại T1');
    assert.strictEqual(ordered[0].id, 'T3', `phải tiếp tục vòng xoay tại T3 (thấy ${ordered[0].id})`);
    rotation.markSuccess(ordered[0], 100);
    // R3 -> T4
    ordered = rotation.orderByRotation(rotation.getEligibleTargets(targets, {}));
    assert.strictEqual(ordered[0].id, 'T4');
  });

  await test('16. key cooldown: 401 -> mọi target dùng khóa đó bị loại khỏi rotation', async () => {
    rotation._resetRotationStateForTest();
    const targets = [mkTarget('A1', 'badkey', 'm1'), mkTarget('A2', 'badkey', 'm2'), mkTarget('B1', 'okkey', 'm1')];
    rotation.markFailure(targets[0], Object.assign(new Error('unauthorized'), { status: 401 }));
    const eligible = rotation.getEligibleTargets(targets, {});
    assert.deepStrictEqual(eligible.map((t) => t.id), ['B1'], 'cả 2 target của khóa lỗi phải bị loại');
  });

  await test('17. model cooldown: model overloaded -> mọi khóa dùng model đó bị loại, khóa+model khác vẫn dùng được', async () => {
    rotation._resetRotationStateForTest();
    const targets = [mkTarget('K1M1', 'k1', 'm1'), mkTarget('K2M1', 'k2', 'm1'), mkTarget('K1M2', 'k1', 'm2')];
    rotation.markFailure(targets[0], new Error('model is overloaded'));
    const eligible = rotation.getEligibleTargets(targets, {});
    assert.ok(!eligible.find((t) => t.modelId === 'k1::m1'), 'target dùng model lỗi bị loại');
    assert.ok(eligible.find((t) => t.id === 'K1M2'), 'cùng khóa nhưng model khác vẫn dùng được');
  });

  console.log('\n== 18-21. Hủy / cache / ngân sách ==');

  await test('18. invalid_request KHÔNG retry vô ích (scope invalid_request không cooldown, dừng sớm)', async () => {
    rotation._resetRotationStateForTest();
    const t = mkTarget('X');
    const cls = rotation.markFailure(t, Object.assign(new Error('bad payload'), { status: 400 }));
    assert.strictEqual(cls.scope, 'invalid_request');
    assert.strictEqual(rotation.getEligibleTargets([t], {}).length, 1, 'không cooldown target vì lỗi nằm ở request');
  });

  await test('19. client disconnect -> DỪNG, không gọi thêm provider nào', async () => {
    let disconnected = false;
    const r = await run([
      { chunks: ['P1 x = 1.'], finishReason: 'length' },
      { chunks: [' P2 y = 2.' + GOOD_END], finishReason: 'stop' }
    ], {
      isDisconnected: () => disconnected,
      onDelta: () => { disconnected = true; } // ngắt ngay sau delta đầu
    });
    assert.strictEqual(r.streamFn.calls(), 1, 'không được gọi continuation sau khi client đã ngắt');
  });

  await test('20. abort signal -> không gọi continuation', async () => {
    const ac = new AbortController();
    const r = await run([
      { chunks: ['P1 x = 1.'], finishReason: 'length' },
      { chunks: [' P2' + GOOD_END], finishReason: 'stop' }
    ], { signal: ac.signal, onDelta: () => ac.abort() });
    assert.strictEqual(r.streamFn.calls(), 1);
  });

  await test('21. partial (hết ngân sách recovery) -> state PARTIAL, KHÔNG mất text, KHÔNG cache', async () => {
    const longPartial = 'Bước 1: AB = 3 cm. '.repeat(40); // > 400 ký tự => đủ để giao ra
    const r = await run([{ chunks: [longPartial], interrupted: true }], {
      resolveRecovery: () => ({ allow: false, amount: 0 }) // reserve cạn ngay
    });
    const outcome = classifyFinalOutcome(r.completeness, { textLength: r.text.length });
    assert.strictEqual(outcome.state, STATES.PARTIAL, 'phải là PARTIAL, không phải FAILED');
    assert.strictEqual(outcome.partial, true, 'cờ partial dùng để CHẶN ghi cache (xem chat.js)');
    assert.ok(r.text.length > 400, 'toàn bộ phần đã sinh phải được giữ lại');
    assert.notStrictEqual(r.completeness.status, 'COMPLETE', 'KHÔNG được nói dối là đã hoàn thành');
  });

  await test('22. text quá ngắn / INVALID -> FAILED (không giao ra thứ vô nghĩa)', async () => {
    const outcome = classifyFinalOutcome({ status: 'INVALID', severity: 'HARD' }, { textLength: 5 });
    assert.strictEqual(outcome.state, STATES.FAILED);
    assert.strictEqual(outcome.deliverable, false);
  });

  console.log('\n== 23-26. Ngữ cảnh continuation gọn + không lặp text ==');

  await test('23. compact continuation: lượt tiếp nối KHÔNG gửi lại toàn bộ answer cũ', async () => {
    const bigChunk = ('Đoạn diễn giải rất dài không mang dữ liệu nào cả và chỉ để giải thích thêm cho người đọc. '.repeat(30));
    const r = await run([
      { chunks: [bigChunk + '\nx = 5\n'], finishReason: 'length' },
      { chunks: ['Phần tiếp.' + GOOD_END], finishReason: 'stop' }
    ]);
    const contMessages = r.streamFn.log[1].messages;
    const assistantTurn = contMessages[contMessages.length - 2].content;
    assert.ok(assistantTurn.length < bigChunk.length, 'ngữ cảnh gửi lại phải NGẮN HƠN phần đã sinh');
    assert.ok(assistantTurn.includes('x = 5'), 'nhưng vẫn phải giữ dữ liệu (x = 5)');
  });

  await test('24. KHÔNG duplicate content ở điểm nối (seam dedupe)', async () => {
    let out = '';
    const seam = createSeamDedupe('…áp dụng định lý Pytago cho tam giác vuông ABC', (t) => { out += t; });
    'cho tam giác vuông ABC, ta được BC = 5 cm.'.split('').forEach((c) => seam.feed(c));
    seam.flush();
    assert.ok(!out.startsWith('cho tam giác vuông ABC'), 'phần lặp phải bị cắt trước khi phát ra');
    assert.ok(out.includes('BC = 5 cm'), 'phần mới phải được giữ');
    assert.ok(seam.removedChars > 0, 'phải ghi nhận số ký tự trùng đã cắt');
  });

  await test('25. giữ nguyên variables: prompt tiếp nối yêu cầu rõ, và text cũ không bị sửa', async () => {
    const r = await run([
      { chunks: ['Đặt x_1 = 7 và x_2 = 11.'], interrupted: true },
      { chunks: [' Do đó x_1 + x_2 = 18.' + GOOD_END], finishReason: 'stop' }
    ]);
    assert.ok(r.text.includes('x_1 = 7'), 'biến đã đặt phải còn nguyên trong text cuối');
    const contMessages = r.streamFn.log[1].messages;
    const prompt = contMessages[contMessages.length - 1].content;
    assert.ok(/GIỮ NGUYÊN/i.test(prompt) && /ký hiệu/i.test(prompt));
  });

  await test('26. giữ drawing state qua resume (khối vẽ nguyên vẹn trong ngữ cảnh tiếp nối)', async () => {
    const block = '```shape\n{"ops":[{"op":"point","id":"Q","x":2,"y":5}]}\n```';
    const filler = 'Một đoạn diễn giải dài để buộc phần đầu bị nén lại chứ không gửi nguyên văn nữa. '.repeat(25);
    const r = await run([
      { chunks: [filler + block + '\nS = 12'], finishReason: 'length' },
      { chunks: [GOOD_END], finishReason: 'stop' }
    ]);
    const contMessages = r.streamFn.log[1].messages;
    const assistantTurn = contMessages[contMessages.length - 2].content;
    assert.ok(assistantTurn.includes('{"op":"point","id":"Q","x":2,"y":5}'), 'canonical drawing state phải nguyên vẹn');
  });

  await test('27. joinContinuation không chèn newline làm đứt từ/công thức', () => {
    assert.strictEqual(joinContinuation('nửa tích hai cạ', 'nh góc vuông'), 'nửa tích hai cạnh góc vuông');
    assert.strictEqual(joinContinuation('Kết quả:', ' 42'), 'Kết quả: 42');
    assert.strictEqual(joinContinuation('Xong.', 'Tiếp'), 'Xong.\nTiếp');
  });

  console.log('\n== 28-32. Trạng thái cuối + deadline + hard cap ==');

  await test('28. stop + hợp lệ => COMPLETE (completion-first, không đòi từ khoá kết luận)', () => {
    const r = validateSolutionCompleteness('Diện tích tam giác bằng 6', { stage: 'detail', finishReason: 'stop' });
    assert.strictEqual(r.status, 'COMPLETE');
  });

  await test('29. length => recovery (luôn HARD dù text trông đã đóng)', () => {
    const r = validateSolutionCompleteness('Vậy diện tích bằng 6 cm².', { stage: 'detail', finishReason: 'length' });
    assert.strictEqual(r.severity, 'HARD');
    assert.ok(r.hardReasons.includes('finish_reason_length'));
  });

  await test('30. deadline CHUNG: hết thời gian -> computeRecoveryBudget chặn continuation', async () => {
    const shortDeadline = createRequestDeadline(50);
    await new Promise((r) => setTimeout(r, 80));
    const r = await run([
      { chunks: ['P1 x = 1.'], finishReason: 'length' },
      { chunks: [' P2' + GOOD_END], finishReason: 'stop' }
    ], { deadline: shortDeadline });
    assert.strictEqual(r.streamFn.calls(), 1, 'hết deadline chung -> không gọi thêm provider');
  });

  await test('31. token hard cap: safety cap chặn vòng lặp vô hạn khi provider lặp lại lỗi y hệt', async () => {
    // Provider luôn trả về đúng 1 lỗi cấu trúc (fence chưa đóng) -> HARD mãi mãi.
    const stub = makeStreamStub([{ chunks: ['```\nx = 1'], finishReason: 'length' }]);
    const r = await run(null, { streamFn: stub, resolveRecovery: alwaysAllow(500) });
    assert.ok(r.continuations <= MAX_CONTINUATIONS, `không được vượt safety cap ${MAX_CONTINUATIONS} (thấy ${r.continuations})`);
    assert.ok(stub.calls() <= MAX_CONTINUATIONS + 1, 'tổng lệnh gọi bị chặn trần');
  });

  await test('32. adaptive continuation budget: lô token cấp cho lượt tiếp nối theo phần CÒN THIẾU', async () => {
    const granted = [];
    const r = await run([
      { chunks: ['P1 x = 1.'], interrupted: true },
      { chunks: [' P2 xong.' + GOOD_END], finishReason: 'stop' }
    ], {
      resolveRecovery: (completeness, session) => {
        const amount = Math.max(400, 3000 - session.outputTokens);
        granted.push(amount);
        return { allow: true, amount };
      }
    });
    assert.ok(granted.length === 1);
    assert.ok(granted[0] > 400, 'phần còn thiếu lớn -> lô token phải lớn, không phải sàn tối thiểu');
    assert.strictEqual(r.completeness.status, 'COMPLETE');
  });

  await test('33. short question tiết kiệm token: 1 lệnh gọi duy nhất, không recovery', async () => {
    const r = await run([{ chunks: ['Kết quả: 4. Vậy đáp số là 4.'], finishReason: 'stop' }]);
    assert.strictEqual(r.streamFn.calls(), 1);
    assert.strictEqual(r.session.continuationTokens, 0, 'không tốn token continuation nào');
  });

  await test('34. long question đủ budget: nhiều lượt nối liên tiếp cho tới khi thực sự xong', async () => {
    const r = await run([
      { chunks: ['a) x = 1.'], finishReason: 'length' },
      { chunks: [' b) y = 2.'], finishReason: 'length' },
      { chunks: [' c) z = 3.'], interrupted: true },
      { chunks: [' d) t = 4.' + GOOD_END], finishReason: 'stop' }
    ]);
    assert.strictEqual(r.completeness.status, 'COMPLETE');
    assert.strictEqual(r.continuations, 3);
    assert.strictEqual(r.resumes, 1, 'đúng 1 trong 3 lượt là RESUME (do interrupted)');
  });

  console.log('\n== 35-40. Telemetry / throughput / non-stream ==');

  await test('35. telemetry chính xác: snapshot có đủ field PHẦN Q', async () => {
    const r = await run([
      { chunks: ['P1 x = 1.'], interrupted: true, target: 'A' },
      { chunks: [' P2 xong.' + GOOD_END], finishReason: 'stop', target: 'B' }
    ]);
    const snap = r.session.snapshot();
    ['stage', 'attempts', 'inputTokens', 'compressedInputTokens', 'compressionRatio', 'outputTokens',
      'finishReason', 'interrupted', 'continuationCount', 'continuationTokens', 'totalBudget',
      'recoveryBudget', 'recoveryUsed', 'deadlineRemaining', 'triedTargets', 'failedTargets', 'recoveryReason']
      .forEach((f) => assert.ok(f in snap, `telemetry thiếu field ${f}`));
    assert.strictEqual(snap.attempts, 2);
    assert.strictEqual(snap.interrupted, false, 'sau khi resume xong, cờ interrupted phải được xoá');
    assert.ok(snap.failedTargets.length >= 1, 'target đã chết phải được ghi nhận');
    assert.ok(snap.outputTokens > 0);
  });

  await test('36. telemetry KHÔNG chứa API key / nội dung câu trả lời', async () => {
    const r = await run([{ chunks: ['secret-answer-body 42. Vậy đáp số 42.'], finishReason: 'stop' }]);
    const dumped = JSON.stringify(r.session.snapshot());
    assert.ok(!dumped.includes('secret-answer-body'), 'không được log nội dung câu trả lời');
    assert.ok(!/sk-|api[_-]?key/i.test(dumped), 'không được log khóa API');
  });

  await test('37. throughput theo provider/model khác nhau -> ước lượng budget khác nhau', () => {
    throughput._resetForTest();
    const fast = mkTarget('F', 'pfast', 'mfast');
    const slow = mkTarget('S', 'pslow', 'mslow');
    for (let i = 0; i < 3; i++) {
      throughput.recordThroughput(fast, { outputTokens: 1100, elapsedMs: 10000 }); // ~110 tok/s
      throughput.recordThroughput(slow, { outputTokens: 300, elapsedMs: 10000 });  // ~30 tok/s
    }
    const rf = throughput.getThroughput(fast);
    const rs = throughput.getThroughput(slow);
    assert.ok(rf > rs + 30, `provider nhanh phải có throughput cao hơn rõ rệt (${rf} vs ${rs})`);
    assert.ok(rf <= throughput.MAX_TOKENS_PER_SEC && rs >= throughput.MIN_TOKENS_PER_SEC, 'phải nằm trong bound');
  });

  await test('38. throughput bỏ qua mẫu quá nhỏ (không đại diện, chống nhiễu)', () => {
    throughput._resetForTest();
    const t = mkTarget('Z', 'pz', 'mz');
    throughput.recordThroughput(t, { outputTokens: 10, elapsedMs: 50 }); // quá nhỏ -> bỏ
    assert.strictEqual(throughput.getThroughput(t), throughput.DEFAULT_TOKENS_PER_SEC, 'phải vẫn dùng mặc định');
  });

  await test('39. continuation qua nhiều provider ở nhánh NON-STREAM cũng hoạt động', async () => {
    let call = 0;
    const out = await runResumableNonStream({
      callFn: async () => {
        call += 1;
        if (call === 1) return { text: ' Bước 2: y = 2.', provider: mkTarget('B'), finishReason: 'length' };
        return { text: ' Bước 3: z = 3.' + GOOD_END, provider: mkTarget('C'), finishReason: 'stop' };
      },
      buildArgs: ({ messages, maxTokens }) => ({ messages, maxTokens }),
      messages: [{ role: 'user', content: 'đề' }],
      initialResult: { text: 'Bước 1: x = 1.', provider: mkTarget('A'), finishReason: 'length' },
      evaluate: evaluateSimple,
      resolveRecovery: alwaysAllow(1200),
      deadline: createRequestDeadline(60000)
    });
    assert.strictEqual(out.completeness.status, 'COMPLETE');
    assert.strictEqual(out.continuations, 2, 'A -> B -> C ở nhánh JSON');
    assert.ok(out.text.includes('Bước 1') && out.text.includes('Bước 2') && out.text.includes('Bước 3'));
  });

  await test('40. non-stream: sentinel reserveExhausted -> dừng ngay, giữ text đã có', async () => {
    const out = await runResumableNonStream({
      callFn: async () => ({ reserveExhausted: true }),
      buildArgs: ({ messages, maxTokens }) => ({ messages, maxTokens }),
      messages: [{ role: 'user', content: 'đề' }],
      initialResult: { text: 'Bước 1: x = 1.', provider: mkTarget('A'), finishReason: 'length' },
      evaluate: evaluateSimple,
      resolveRecovery: alwaysAllow(1200),
      deadline: createRequestDeadline(60000)
    });
    assert.strictEqual(out.continuations, 0, 'sentinel không được tính là 1 lượt continuation');
    assert.strictEqual(out.text, 'Bước 1: x = 1.', 'text đã có phải giữ nguyên');
    assert.strictEqual(out.session.recoveryReason, 'reserve_exhausted');
  });

  await test('41. StreamSession: absorbAttempt xoá cờ interrupted khi lượt sau chạy trọn (chống loop vĩnh viễn)', () => {
    const s = createStreamSession({ deadline: createRequestDeadline(1000) });
    s.absorbAttempt({ interrupted: true, provider: mkTarget('A'), tried: [] }, { mode: STAGE.INITIAL });
    assert.strictEqual(s.interrupted, true);
    s.absorbAttempt({ interrupted: false, finishReason: 'stop', provider: mkTarget('B'), tried: [] }, { mode: STAGE.RESUME });
    assert.strictEqual(s.interrupted, false, 'nếu giữ cờ cũ thì completeness sẽ HARD mãi mãi');
    assert.strictEqual(s.finishReason, 'stop');
  });

  await test('42. interrupted KHÔNG BAO GIỜ bị finishReason=stop ghi đè', () => {
    const s = createStreamSession({});
    s.absorbAttempt({ interrupted: true, finishReason: 'stop', provider: mkTarget('A'), tried: [] }, { mode: STAGE.INITIAL });
    assert.strictEqual(s.finishReason, null, 'bị ngắt thì provider chưa kịp gửi stop_reason -> phải là null');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main();
