'use strict';

// ============================================================================================
// TEST — MỤC 4: continuation ordering (case 1-7) + image generation (case 8-19)
// ============================================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ordering = require('../server/utils/answerOrdering');
const { normalizeFinalAnswerOrder } = ordering;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}

/** Thứ tự các nhãn section xuất hiện trong text, để assert gọn. */
function outline(text) {
  return ordering.splitIntoBlocks(text)
    .filter((b) => b.heading)
    .map((b) => ordering.normalizeHeading(b.heading));
}

console.log('\n== Continuation ordering (case 1-7) ==');

test('1. Bước 1/2/3 + Kết luận, rồi continuation thêm Bước 4/Kết quả -> Kết luận phải về CUỐI', () => {
  const joined = [
    '## Bước 1', 'Tính a.', '',
    '## Bước 2', 'Tính b.', '',
    '## Bước 3', 'Tính c.', '',
    '## Kết luận', 'Đáp số 10.', '',
    '---', '',
    '## Bước 4 (tiếp)', 'Tính d.', '',
    '## Kết quả', 'd = 4.'
  ].join('\n');
  const r = normalizeFinalAnswerOrder(joined);
  assert.ok(r.changed, 'phải nhận ra sai thứ tự');
  assert.deepStrictEqual(outline(r.text), ['buoc 1', 'buoc 2', 'buoc 3', 'buoc 4', 'ket qua', 'ket luan']);
  assert.ok(/Tính d\./.test(r.text) && /Đáp số 10\./.test(r.text), 'không được làm mất nội dung');
});

test('2. Continuation bắt đầu lại Bước 2/Bước 3 -> KHÔNG append lặp', () => {
  const joined = [
    '## Bước 1', 'Tính a.', '',
    '## Bước 2', 'Tính b.', '',
    '## Bước 3', 'Tính c.', '',
    '## Bước 2', 'Tính b.', '',
    '## Bước 3', 'Tính c.'
  ].join('\n');
  const r = normalizeFinalAnswerOrder(joined);
  const heads = outline(r.text);
  assert.deepStrictEqual(heads, ['buoc 1', 'buoc 2', 'buoc 3'], `còn section lặp: ${heads.join(' | ')}`);
  assert.strictEqual((r.text.match(/Tính b\./g) || []).length, 1, 'nội dung bị nhân đôi');
});

test('3. Continuation mở "## Kết luận" lần hai -> không tạo hai mục kết luận', () => {
  const joined = [
    '## Bước 1', 'Tính a.', '',
    '## Kết luận', 'Đáp số 10.', '',
    '## Kết luận', 'Đáp số 10.'
  ].join('\n');
  const r = normalizeFinalAnswerOrder(joined);
  assert.strictEqual(outline(r.text).filter((h) => h === 'ket luan').length, 1);
});

test('3b. Kết luận lặp nhưng bản sau DÀI HƠN HẲN -> gộp nội dung, vẫn chỉ một heading', () => {
  const joined = [
    '## Kết luận', 'Đáp số 10.', '',
    '## Kết luận', 'Đáp số 10. Ngoài ra cần kiểm tra lại điều kiện xác định của phương trình trước khi kết luận nghiệm.'
  ].join('\n');
  const r = normalizeFinalAnswerOrder(joined);
  assert.strictEqual(outline(r.text).filter((h) => h === 'ket luan').length, 1);
  assert.ok(/điều kiện xác định/.test(r.text), 'phần bổ sung thật KHÔNG được vứt đi');
});

test('4. Kết luận + citation/nguồn phía sau -> KHÔNG được reorder (tránh dương tính giả)', () => {
  const joined = [
    '## Bước 1', 'Tính a.', '',
    '## Kết luận', 'Đáp số 10.', '',
    '## Nguồn tham khảo', '[1] SGK Toán 10, tr. 45.'
  ].join('\n');
  const r = normalizeFinalAnswerOrder(joined);
  assert.strictEqual(r.changed, false, `không được đụng vào: ${r.reason}`);
  assert.deepStrictEqual(outline(r.text), ['buoc 1', 'ket luan', 'nguon tham khao']);
});

test('5. LaTeX display ngay quanh điểm nối -> không bị phá', () => {
  const joined = [
    '## Bước 1', '$$', '\\int_0^1 x^2 dx = \\frac{1}{3}', '$$', '',
    '## Kết luận', 'Xong.', '',
    '## Bước 2', '\\[', 'E = mc^2', '\\]'
  ].join('\n');
  const r = normalizeFinalAnswerOrder(joined);
  assert.ok(/\\int_0\^1 x\^2 dx = \\frac\{1\}\{3\}/.test(r.text), 'LaTeX $$ bị hỏng');
  assert.ok(/E = mc\^2/.test(r.text), 'LaTeX \\[ \\] bị hỏng');
  assert.strictEqual((r.text.match(/\$\$/g) || []).length, 2, 'số cặp $$ thay đổi');
  assert.deepStrictEqual(outline(r.text), ['buoc 1', 'buoc 2', 'ket luan']);
});

test('6. Bảng markdown -> không bị cắt rời', () => {
  const joined = [
    '## Bước 1', '| Cột A | Cột B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |', '',
    '## Kết luận', 'Xong.', '',
    '## Bước 2', 'Phần còn thiếu.'
  ].join('\n');
  const r = normalizeFinalAnswerOrder(joined);
  const lines = r.text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('| Cột A'));
  assert.ok(first > 0, 'mất bảng');
  ['| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].forEach((row, k) => {
    assert.strictEqual(lines[first + 1 + k], row, `hàng bảng bị tách rời: mong "${row}"`);
  });
});

test('7. Code fence -> không bị phá, "# Bước" bên trong KHÔNG bị coi là heading', () => {
  const joined = [
    '## Bước 1', '```python', '# Bước 99: đây chỉ là comment trong code', 'print(1)', '```', '',
    '## Kết luận', 'Xong.', '',
    '## Bước 2', 'Phần còn thiếu.'
  ].join('\n');
  const r = normalizeFinalAnswerOrder(joined);
  assert.strictEqual((r.text.match(/```/g) || []).length, 2, 'số fence thay đổi');
  assert.ok(/# Bước 99: đây chỉ là comment trong code\nprint\(1\)/.test(r.text), 'nội dung code bị xáo trộn');
  assert.ok(!outline(r.text).includes('buoc 99'), 'comment trong code bị coi là heading');
});

console.log('\n== Bất biến an toàn của normalizer ==');

test('N1. text đã đúng thứ tự -> trả NGUYÊN VĂN, changed=false', () => {
  const ok = '## Bước 1\nA.\n\n## Bước 2\nB.\n\n## Kết luận\nXong.';
  const r = normalizeFinalAnswerOrder(ok);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, ok);
});

test('N2. text không có cấu trúc nào -> không đụng tới', () => {
  const plain = 'Đây là một đoạn trả lời ngắn không có heading nào cả.';
  assert.strictEqual(normalizeFinalAnswerOrder(plain).text, plain);
  assert.strictEqual(normalizeFinalAnswerOrder('').text, '');
});

test('N3. Bước bị lệch số thứ tự liền kề -> sắp lại đúng', () => {
  const r = normalizeFinalAnswerOrder('## Bước 1\nA.\n\n## Bước 3\nC.\n\n## Bước 2\nB.');
  assert.deepStrictEqual(outline(r.text), ['buoc 1', 'buoc 2', 'buoc 3']);
});

test('N4. looksLikeOutOfOrderContinuation: chỉ báo khi ĐÃ có kết luận và đoạn tới mở Bước mới', () => {
  const withConclusion = '## Bước 1\nA.\n\n## Kết luận\nXong.';
  assert.strictEqual(ordering.looksLikeOutOfOrderContinuation(withConclusion, '## Bước 4\nTính d.'), true);
  assert.strictEqual(ordering.looksLikeOutOfOrderContinuation(withConclusion, 'Nguồn: SGK.'), false);
  assert.strictEqual(ordering.looksLikeOutOfOrderContinuation('## Bước 1\nA.', '## Bước 2\nB.'), false);
});

console.log('\n== Điểm chèn: resumableStream + một final answer duy nhất ==');

test('W1. normalize được gọi trong finish() — điểm hội tụ của CẢ hai nhánh stream/non-stream', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'resumableStream.js'), 'utf8');
  assert.ok(/normalizeFinalAnswerOrder\(session\.accumulatedText\)/.test(src));
  const finishIdx = src.indexOf('function finish(');
  assert.ok(finishIdx > 0 && src.indexOf('normalizeFinalAnswerOrder(session.accumulatedText)') > finishIdx,
    'phải nằm TRONG finish(), không phải rải rác ở từng nhánh');
  assert.ok(/session\.accumulatedText = ordering\.text/.test(src),
    'phải ghi đè accumulatedText để cache/history/visual cùng thấy MỘT final answer');
});

test('W2. normalize KHÔNG được gọi trong vòng stream từng delta (giữ hiệu ứng gõ chữ)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'resumableStream.js'), 'utf8');
  // Đếm LỆNH GỌI THẬT, bỏ comment (comment có nhắc tên hàm để giải thích lý do đặt ở đây).
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const count = (code.match(/normalizeFinalAnswerOrder\(/g) || []).length;
  assert.strictEqual(count, 1, `chỉ được gọi ĐÚNG 1 lần, thấy ${count}`);
});

test('W3. chat.js truyền finalAnswer cho visual = text đã normalize (mục 3.8/3.9)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/const full = reconcileRun\.text/.test(src) || /full = reconcileRun\.text/.test(src));
  assert.ok(/finalAnswer: full/.test(src),
    'visual pipeline phải nhận chính biến lấy từ resumableStream (đã normalize trong finish())');
});

test('W4. prompt tiếp nối cảnh báo kết luận TẠM THỜI khi đã có conclusion (mục 3.3)', () => {
  const c = require('../server/utils/continuation');
  const withConc = c.buildMinimalContinuationContext({
    messages: [], priorText: '## Bước 1\nA.\n\n## Kết luận\nXong.', completeness: {}
  });
  const p1 = withConc.messages[withConc.messages.length - 1].content;
  assert.ok(/TẠM THỜI/.test(p1), 'thiếu chỉ thị chống kết luận lần hai');
  const without = c.buildMinimalContinuationContext({
    messages: [], priorText: '## Bước 1\nA.', completeness: {}
  });
  const p2 = without.messages[without.messages.length - 1].content;
  assert.ok(!/TẠM THỜI/.test(p2), 'không được thêm chỉ thị thừa khi chưa có kết luận');
  assert.ok(p2.length < p1.length, 'chỉ thị phải là điều kiện, không phải cố định (tiết kiệm token)');
});

console.log('\n== Image generation: khóa kế thừa + đa provider (case 11, 18) ==');

const CLIENT_PATH = path.join(__dirname, '..', 'server', 'utils', 'visual', 'imageGenerationClient.js');
const IMAGE_ENVS = [
  'GEMINI_IMAGE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENAI_IMAGE_API_KEY', 'OPENAI_API_KEY',
  'GROK_IMAGE_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
  'OPENROUTER_IMAGE_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_IMAGE_MODEL',
  'IMAGE_PROVIDER_ORDER', 'IMAGE_GENERATION_ENABLED'
];

/** Nạp client với một tập env sạch, trả kèm hàm khôi phục. */
function withEnv(envs, fn) {
  const saved = {};
  IMAGE_ENVS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.entries(envs).forEach(([k, v]) => { process.env[k] = v; });
  delete require.cache[require.resolve(CLIENT_PATH)];
  try {
    return fn(require(CLIENT_PATH));
  } finally {
    IMAGE_ENVS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
    delete require.cache[require.resolve(CLIENT_PATH)];
  }
}

test('11. CHỈ có khóa TEXT (không có khóa ảnh riêng) -> image generation VẪN bật', () => {
  withEnv({ GEMINI_API_KEY: 'text-key' }, (c) => {
    assert.strictEqual(c.isConfigured(), true, 'ROOT CAUSE A: khóa text phải dùng được cho ảnh');
    const list = c.listImageProviders();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'gemini-image');
    assert.strictEqual(list[0].keySource, 'text_reuse');
  });
});

test('11b. Khóa ảnh RIÊNG được ưu tiên hơn khóa text', () => {
  withEnv({ GEMINI_API_KEY: 'text-key', GEMINI_IMAGE_API_KEY: 'image-key' }, (c) => {
    const list = c.listImageProviders();
    assert.strictEqual(list[0].keySource, 'image_specific');
    assert.strictEqual(list[0].apiKey, 'image-key');
  });
});

test('11c. Khóa text dạng danh sách nhiều khóa -> lấy khóa đầu, không gửi cả chuỗi', () => {
  withEnv({ OPENAI_API_KEY: 'sk-a, sk-b , sk-c' }, (c) => {
    assert.strictEqual(c.listImageProviders()[0].apiKey, 'sk-a');
  });
});

test('12. Không có khóa nào -> không bật, KHÔNG crash (không phải lỗi)', () => {
  withEnv({}, (c) => {
    assert.strictEqual(c.isConfigured(), false);
    assert.strictEqual(c.activeProviderName(), null);
    assert.deepStrictEqual(c.listImageProviders(), []);
  });
});

test('18a. KHÔNG giới hạn Gemini/OpenAI: chỉ có khóa Grok -> vẫn tạo ảnh được', () => {
  withEnv({ GROK_API_KEY: 'xai-key' }, (c) => {
    assert.strictEqual(c.isConfigured(), true, 'không được ngầm giả định phải có Gemini/OpenAI');
    assert.strictEqual(c.activeProviderName(), 'grok-image');
  });
});

test('18b. Nhiều provider -> thứ tự KẾ THỪA thứ tự ưu tiên của provider text', () => {
  withEnv({ GEMINI_API_KEY: 'a', OPENAI_API_KEY: 'b', GROK_API_KEY: 'c' }, (c) => {
    assert.deepStrictEqual(c.listImageProviders().map((p) => p.name),
      ['gemini-image', 'openai-image', 'grok-image']);
  });
});

test('18c. IMAGE_PROVIDER_ORDER ghi đè thứ tự, KHÔNG âm thầm loại provider nào', () => {
  withEnv({ GEMINI_API_KEY: 'a', OPENAI_API_KEY: 'b', GROK_API_KEY: 'c', IMAGE_PROVIDER_ORDER: 'grok-image,openai-image' }, (c) => {
    const names = c.listImageProviders().map((p) => p.name);
    assert.strictEqual(names[0], 'grok-image');
    assert.strictEqual(names[1], 'openai-image');
    assert.ok(names.includes('gemini-image'), 'provider không được nêu tên vẫn phải còn, chỉ xuống cuối');
  });
});

test('18d. OpenRouter chỉ bật khi chỉ định TƯỜNG MINH model ảnh', () => {
  withEnv({ OPENROUTER_API_KEY: 'or' }, (c) => {
    assert.strictEqual(c.listImageProviders().length, 0, 'không có model -> không được gọi mù');
  });
  withEnv({ OPENROUTER_API_KEY: 'or', OPENROUTER_IMAGE_MODEL: 'some/image-model' }, (c) => {
    assert.strictEqual(c.listImageProviders()[0].name, 'openrouter-image');
  });
});

test('18e. Provider thuần văn bản KHÔNG bị ép vào danh sách ảnh', () => {
  withEnv({ ANTHROPIC_API_KEY: 'a', DEEPSEEK_API_KEY: 'd', MISTRAL_API_KEY: 'm', GROQ_API_KEY: 'g' }, (c) => {
    assert.deepStrictEqual(c.listImageProviders(), [],
      'gọi vào endpoint sinh ảnh không tồn tại sẽ đốt một lượt failover vô ích');
  });
});

test('18f. Công tắc tắt hẳn: có khóa text nhưng IMAGE_GENERATION_ENABLED=false', () => {
  withEnv({ GEMINI_API_KEY: 'a', IMAGE_GENERATION_ENABLED: 'false' }, (c) => {
    assert.strictEqual(c.isConfigured(), false);
  });
});

console.log('\n== Failover qua N provider (case 18) ==');

(async function main() {
  await atest('18g. 3 provider, hai cái đầu 5xx -> thử đúng cái thứ ba, tổng đúng 3 lệnh gọi', async () => {
    await withEnv({ GEMINI_API_KEY: 'a', OPENAI_API_KEY: 'b', GROK_API_KEY: 'c' }, async (c) => {
      const calls = [];
      const realFetch = global.fetch;
      global.fetch = async (url) => {
        calls.push(String(url));
        if (calls.length <= 2) return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
        return {
          ok: true, status: 200,
          json: async () => ({ data: [{ b64_json: 'aGVsbG8=' }] }),
          text: async () => ''
        };
      };
      try {
        const r = await c.generateImage({ prompt: 'một tế bào thực vật' });
        assert.strictEqual(r.ok, true, 'phải thành công ở provider thứ ba');
        assert.strictEqual(calls.length, 3, `đúng 3 lệnh gọi, thấy ${calls.length}`);
        assert.deepStrictEqual(r.providersTried, ['gemini-image', 'openai-image', 'grok-image']);
        assert.ok(/api\.x\.ai/.test(calls[2]), 'lệnh thứ ba phải đi tới endpoint của xAI');
      } finally { global.fetch = realFetch; }
    });
  });

  await atest('18h. Lỗi KHÔNG retryable (nội dung bị chặn) -> dừng ngay, không quét hết provider', async () => {
    await withEnv({ GEMINI_API_KEY: 'a', OPENAI_API_KEY: 'b', GROK_API_KEY: 'c' }, async (c) => {
      let calls = 0;
      const realFetch = global.fetch;
      global.fetch = async () => {
        calls += 1;
        return {
          ok: true, status: 200,
          json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
          text: async () => ''
        };
      };
      try {
        const r = await c.generateImage({ prompt: 'sơ đồ minh hoạ cấu tạo tế bào thực vật' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'content_blocked');
        assert.strictEqual(calls, 1, `nội dung bị chặn thì provider nào cũng chặn, thấy ${calls} lệnh gọi`);
      } finally { global.fetch = realFetch; }
    });
  });

  await atest('13. Provider trả TEXT thay vì ảnh -> failed, KHÔNG giả vờ thành công', async () => {
    await withEnv({ GEMINI_API_KEY: 'a' }, async (c) => {
      const realFetch = global.fetch;
      global.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'Xin lỗi, tôi không tạo được ảnh.' }] } }] }),
        text: async () => ''
      });
      try {
        const r = await c.generateImage({ prompt: 'sơ đồ minh hoạ cấu tạo tế bào thực vật' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'no_image_in_response');
      } finally { global.fetch = realFetch; }
    });
  });

  await atest('8. Thành công base64 -> data_url', async () => {
    await withEnv({ OPENAI_API_KEY: 'b' }, async (c) => {
      const realFetch = global.fetch;
      global.fetch = async () => ({
        ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'aGVsbG8=' }] }), text: async () => ''
      });
      try {
        const r = await c.generateImage({ prompt: 'sơ đồ minh hoạ cấu tạo tế bào thực vật' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.format, 'data_url');
        assert.ok(r.url.startsWith('data:image/'));
      } finally { global.fetch = realFetch; }
    });
  });

  await atest('9. Thành công URL -> image_url (frontend sẽ tải qua proxy /api/visual/download)', async () => {
    await withEnv({ OPENAI_API_KEY: 'b' }, async (c) => {
      const realFetch = global.fetch;
      global.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ data: [{ url: 'https://cdn.openai.com/a.png' }] }), text: async () => ''
      });
      try {
        const r = await c.generateImage({ prompt: 'sơ đồ minh hoạ cấu tạo tế bào thực vật' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.format, 'image_url');
        assert.strictEqual(r.url, 'https://cdn.openai.com/a.png');
      } finally { global.fetch = realFetch; }
    });
  });

  console.log('\n== Root cause B: spec thấy ngữ cảnh stage approach (case 17) ==');

  await atest('17. Thực thể CHỈ có ở stage approach -> vẫn dựng được visual, KHÔNG "failed"', async () => {
    const specBuilder = require('../server/utils/visual/visualSpecBuilder');
    const det = require('../server/utils/visual/deterministicRenderer');
    const decision = {
      visualType: 'biology_diagram', visualPurpose: 'Minh hoạ các hệ cơ quan chính',
      shouldGenerateImage: true
    };
    const detailOnly = 'Hình minh họa mô tả cấu trúc tổng quan của cơ thể người.';
    const approach = [
      '- Da: bao bọc và bảo vệ cơ thể',
      '- Hệ xương: nâng đỡ và tạo khung cho cơ thể',
      '- Hệ cơ: phối hợp với xương để vận động',
      '- Hệ tuần hoàn: vận chuyển máu và chất dinh dưỡng'
    ].join('\n');

    const without = specBuilder.buildVisualSpec({
      decision, question: 'cấu tạo cơ thể người', finalAnswer: detailOnly, subject: 'biology'
    });
    assert.strictEqual((without.data.parts || []).length, 0, 'tiền đề của bug: spec rỗng khi chỉ có detail');

    const withApproach = specBuilder.buildVisualSpec({
      decision, question: 'cấu tạo cơ thể người', finalAnswer: detailOnly,
      approachText: approach, subject: 'biology'
    });
    assert.ok((withApproach.data.parts || []).length >= 4, 'phải trích được thực thể từ Hướng giải');
    const r = det.renderDeterministic(withApproach);
    assert.strictEqual(r.ok, true, 'phải dựng được hình');
  });

  await atest('17b. Spec RỖNG HOÀN TOÀN nhưng có purpose -> concept card tối thiểu, KHÔNG null', async () => {
    const det = require('../server/utils/visual/deterministicRenderer');
    const r = det.renderDeterministic({
      type: 'biology_diagram', title: 'Cấu tạo cơ thể người',
      purpose: 'Minh hoạ vị trí tương đối của các hệ cơ quan chính.', data: {}
    });
    assert.strictEqual(r.ok, true, 'fallback cuối cùng KHÔNG BAO GIỜ được trả null khi đã có purpose');
    assert.ok(/Minh hoạ vị trí tương đối/.test(r.content.replace(/<[^>]+>/g, ' ')),
      'chỉ hiện lại đúng purpose, không bịa thêm dữ kiện');
  });

  console.log('\n== Gate degrade theo necessity (case 19, mục 2.4a) ==');

  await atest('19. degrade=low: NECESSARY vẫn THỬ ảnh AI, OPTIONAL vẫn được bỏ qua', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualPipeline.js'), 'utf8');
    assert.ok(/degrade === 'low' && !highNeed/.test(src),
      'gate low phải phân biệt theo necessity, không chặn cứng mọi mức');
    assert.ok(/necessityNow === 'NECESSARY' \|\| necessityNow === 'USER_REQUESTED'/.test(src));
    assert.ok(/degrade === 'low' \? '512x512' : '1024x1024'/.test(src),
      'mức low phải hạ kích thước thay vì bỏ hẳn ảnh');
    // emergency KHÔNG đổi: vẫn bỏ hình hoàn toàn.
    assert.ok(/degrade === 'emergency'/.test(src) && /deferred_deadline/.test(src));
  });

  await atest('2.4: accuracy-critical LUÔN thắng "ưu tiên ảnh AI"', async () => {
    const router = require('../server/utils/visual/visualRendererRouter');
    ['mathematical_plot', 'geometry_diagram', 'circuit_diagram', 'chart', 'flowchart'].forEach((type) => {
      const r = router.chooseVisualRenderer({ type }, { imageProviderAvailable: true });
      assert.strictEqual(r.accuracyCritical, true, `${type} phải là accuracy-critical`);
      assert.notStrictEqual(r.primary, 'image_generation', `${type} KHÔNG BAO GIỜ được giao cho image model`);
      assert.ok(!r.fallbacks.includes('image_generation'));
    });
    const bio = router.chooseVisualRenderer({ type: 'biology_diagram' }, { imageProviderAvailable: true });
    assert.strictEqual(bio.primary, 'image_generation', 'nhóm minh hoạ: ảnh AI là lựa chọn ĐẦU TIÊN');
  });

  console.log('\n== Không lộ API key (mục 2.8) ==');

  await atest('K1. Telemetry/log chỉ chứa TÊN provider, không bao giờ chứa khóa', async () => {
    await withEnv({ GEMINI_API_KEY: 'SUPER-SECRET-KEY' }, async (c) => {
      const realFetch = global.fetch;
      global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
      try {
        const r = await c.generateImage({ prompt: 'sơ đồ minh hoạ cấu tạo tế bào thực vật' });
        const dump = JSON.stringify(r);
        assert.ok(!/SUPER-SECRET-KEY/.test(dump), 'khóa lọt vào kết quả trả về');
        assert.deepStrictEqual(r.providersTried, ['gemini-image']);
      } finally { global.fetch = realFetch; }
      const listDump = JSON.stringify(c.listImageProviders().map((p) => ({ name: p.name, model: p.model, keySource: p.keySource })));
      assert.ok(!/SUPER-SECRET-KEY/.test(listDump));
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
