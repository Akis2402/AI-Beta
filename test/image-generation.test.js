'use strict';

// ============================================================================================
// TEST — IMAGE GENERATION CLIENT & ĐƯỜNG FALLBACK (PHẦN 20/26/29)
// ============================================================================================
// Rủi ro trước đây: đường image generation chưa từng được chạy vì môi trường phát triển không có
// khóa ảnh. File này nạp provider giả lập với ĐÚNG hình dạng response thật của Gemini Image và
// OpenAI Images, rồi kiểm tra mọi nhánh:
//
//   thành công (inline base64 / b64_json / url) · HTTP lỗi · response không có ảnh ·
//   timeout · bị hủy · không cấu hình provider · repair/fallback · ảnh không qua quality gate
//
// Bất biến xuyên suốt: image client KHÔNG BAO GIỜ throw, và ảnh hỏng KHÔNG BAO GIỜ làm hỏng text.

const assert = require('assert');
const path = require('path');

const results = [];
async function atest(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const CLIENT_PATH = path.join(__dirname, '..', 'server', 'utils', 'visual', 'imageGenerationClient.js');
const PIPELINE_PATH = path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualPipeline.js');

/** Nạp lại client với biến môi trường mới (client đọc env lúc require). */
function loadClient(env) {
  delete require.cache[require.resolve(CLIENT_PATH)];
  delete require.cache[require.resolve(PIPELINE_PATH)];
  const saved = {};
  ['GEMINI_IMAGE_API_KEY', 'OPENAI_IMAGE_API_KEY', 'GEMINI_IMAGE_MODEL', 'OPENAI_IMAGE_MODEL'].forEach((k) => {
    saved[k] = process.env[k];
    if (env && k in env) process.env[k] = env[k]; else delete process.env[k];
  });
  const mod = require(CLIENT_PATH);
  return { mod, restore: () => Object.entries(saved).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }) };
}

async function withFetch(stub, fn) {
  const real = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = real; }
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';

(async function main() {
  // ---------- 1. Không cấu hình provider = KHÔNG PHẢI lỗi ----------
  await atest('1. Không có khóa ảnh -> isConfigured()=false, generateImage trả reason rõ ràng (không throw)', async () => {
    const { mod, restore } = loadClient({});
    try {
      assert.strictEqual(mod.isConfigured(), false);
      assert.strictEqual(mod.activeProviderName(), null);
      const r = await mod.generateImage({ prompt: 'vẽ sơ đồ tế bào thực vật' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'no_image_provider');
    } finally { restore(); }
  });

  // ---------- 2. Gemini Image: shape response THẬT ----------
  await atest('2. Gemini Image: inlineData -> data_url hợp lệ, gửi khóa qua header (không lộ trong URL)', async () => {
    const { mod, restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k-img', GEMINI_IMAGE_MODEL: 'gemini-2.5-flash-image' });
    try {
      let seenUrl = '', seenHeaders = null, seenBody = null;
      const r = await withFetch(async (url, opts) => {
        seenUrl = String(url); seenHeaders = opts.headers; seenBody = JSON.parse(opts.body);
        return {
          ok: true, status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] })
        };
      }, () => mod.generateImage({ prompt: 'sơ đồ tế bào' }));
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.format, 'data_url');
      assert.ok(r.url.startsWith('data:image/png;base64,'));
      assert.ok(!seenUrl.includes('k-img'), 'PHẦN 29: khóa API KHÔNG được nằm trong query string');
      assert.strictEqual(seenHeaders['x-goog-api-key'], 'k-img');
      assert.ok(seenBody.contents, 'phải gửi đúng payload generateContent, không phải payload text chat');
    } finally { restore(); }
  });

  await atest('3. Gemini Image: response KHÔNG có ảnh -> ok=false, không throw', async () => {
    const { mod, restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    try {
      const r = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'xin lỗi' }] } }] }) }),
        () => mod.generateImage({ prompt: 'sơ đồ tế bào' }));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'no_image_in_response');
    } finally { restore(); }
  });

  await atest('4. Gemini Image: HTTP lỗi -> reason mang mã status, không lộ body thô', async () => {
    const { mod, restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    try {
      const r = await withFetch(async () => ({ ok: false, status: 429, text: async () => 'quota billing detail', json: async () => ({}) }),
        () => mod.generateImage({ prompt: 'sơ đồ tế bào' }));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'http_429');
      assert.ok(!/billing/.test(JSON.stringify(r)), 'không được rò chi tiết thô của provider ra ngoài');
    } finally { restore(); }
  });

  // ---------- 3. OpenAI Images: cả 2 shape ----------
  await atest('5. OpenAI Images: b64_json -> data_url', async () => {
    const { mod, restore } = loadClient({ OPENAI_IMAGE_API_KEY: 'k-oa', OPENAI_IMAGE_MODEL: 'gpt-image-1' });
    try {
      let body = null, headers = null;
      const r = await withFetch(async (url, opts) => {
        body = JSON.parse(opts.body); headers = opts.headers;
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG_B64 }] }) };
      }, () => mod.generateImage({ prompt: 'sơ đồ tế bào', size: '1024x1024' }));
      assert.strictEqual(r.ok, true);
      assert.ok(r.url.startsWith('data:image/png;base64,'));
      assert.strictEqual(body.model, 'gpt-image-1');
      assert.ok(!('messages' in body) && !('input' in body), 'PHẦN 29: không gửi payload text sang endpoint ảnh');
      assert.strictEqual(headers.Authorization, 'Bearer k-oa');
    } finally { restore(); }
  });

  await atest('6. OpenAI Images: url -> format image_url', async () => {
    const { mod, restore } = loadClient({ OPENAI_IMAGE_API_KEY: 'k' });
    try {
      const r = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ url: 'https://example.com/i.png' }] }) }),
        () => mod.generateImage({ prompt: 'sơ đồ tế bào' }));
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.format, 'image_url');
    } finally { restore(); }
  });

  // ---------- 4. Lỗi mạng / timeout / hủy ----------
  await atest('7. Lỗi mạng -> provider_error, KHÔNG throw ra ngoài', async () => {
    const { mod, restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    try {
      const r = await withFetch(async () => { throw new Error('ECONNRESET'); }, () => mod.generateImage({ prompt: 'sơ đồ tế bào' }));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'provider_error');
    } finally { restore(); }
  });

  await atest('8. Người dùng hủy giữa chừng -> reason=cancelled, KHÔNG throw', async () => {
    const { mod, restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    try {
      const ac = new AbortController();
      ac.abort();
      const r = await withFetch(async (url, opts) => {
        const e = new Error('aborted'); e.name = 'AbortError';
        if (opts.signal && opts.signal.aborted) throw e;
        return { ok: true, status: 200, json: async () => ({}) };
      }, () => mod.generateImage({ prompt: 'sơ đồ tế bào', signal: ac.signal }));
      assert.strictEqual(r.ok, false);
      assert.ok(['cancelled', 'provider_error'].includes(r.reason));
    } finally { restore(); }
  });

  await atest('9. Prompt rỗng bị chặn TRƯỚC khi tốn 1 lệnh gọi API', async () => {
    const { mod, restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    try {
      let called = 0;
      const r = await withFetch(async () => { called++; return { ok: true, status: 200, json: async () => ({}) }; },
        () => mod.generateImage({ prompt: '' }));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'empty_prompt');
      assert.strictEqual(called, 0, 'không được gọi API với prompt rỗng');
    } finally { restore(); }
  });

  // ---------- 5. Pipeline: loại conceptual đi qua image generation thật ----------
  await atest('10. Pipeline: loại conceptual + có provider -> dùng ảnh sinh, telemetry đúng', async () => {
    const { restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    const pipeline = require(PIPELINE_PATH);
    require(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualCache.js'))._resetForTest();
    try {
      let promptSent = '';
      const r = await withFetch(async (url, opts) => {
        promptSent = JSON.parse(opts.body).contents[0].parts[0].text;
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] }) };
      }, () => pipeline.runVisualPipeline({
        question: 'Trình bày cấu tạo của tế bào nhân thực',
        finalAnswer: 'Tế bào nhân thực gồm:\n- **Ti thể**: hô hấp tế bào\n- **Lục lạp**: quang hợp\n- **Nhân tế bào**: chứa ADN',
        subject: 'biology', answerComplete: true
      }));
      assert.strictEqual(r.status, 'ready');
      assert.strictEqual(r.visuals[0].renderer, 'generated_image');
      assert.strictEqual(r.telemetry.visualRenderer, 'generated_image');
      assert.ok(r.telemetry.visualPromptTokens > 0);
      assert.ok(promptSent.length < 900, 'PHẦN 17: prompt ảnh phải tối thiểu');
      assert.ok(!promptSent.includes('Ti thể: hô hấp tế bào\nLục lạp'), 'không nhét cả lời giải vào prompt');
    } finally { restore(); }
  });

  await atest('11. Pipeline: ảnh LỖI -> tự động rơi về deterministic, text vẫn có hình hợp lệ', async () => {
    const { restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    const pipeline = require(PIPELINE_PATH);
    require(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualCache.js'))._resetForTest();
    try {
      const r = await withFetch(async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) }),
        () => pipeline.runVisualPipeline({
          question: 'Trình bày cấu tạo của tế bào nhân thực',
          finalAnswer: 'Tế bào nhân thực gồm:\n- **Ti thể**: hô hấp tế bào\n- **Lục lạp**: quang hợp\n- **Nhân tế bào**: chứa ADN',
          subject: 'biology', answerComplete: true
        }));
      assert.strictEqual(r.status, 'ready', 'ảnh lỗi KHÔNG được làm mất hình: phải fallback deterministic');
      assert.notStrictEqual(r.visuals[0].renderer, 'generated_image');
      assert.strictEqual(r.visuals[0].format, 'svg');
    } finally { restore(); }
  });

  await atest('12. Pipeline: MỌI đường ảnh đều hỏng -> status failed, visuals rỗng, KHÔNG throw', async () => {
    const { restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    const pipeline = require(PIPELINE_PATH);
    require(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualCache.js'))._resetForTest();
    try {
      const events = [];
      const r = await withFetch(async () => { throw new Error('down'); }, () => pipeline.runVisualPipeline({
        // Lời giải không có thành phần/đại lượng nào -> deterministic cũng không đủ dữ kiện.
        question: 'Minh họa khái niệm sự sống',
        finalAnswer: 'Sự sống là một khái niệm rộng.',
        subject: 'biology', answerComplete: true, onEvent: (e) => events.push(e.type)
      }));
      assert.ok(['failed', 'skipped'].includes(r.status));
      assert.deepStrictEqual(r.visuals, []);
      if (r.status === 'failed') assert.ok(events.includes('visual:error'), 'phải phát visual:error để UI hiện ghi chú');
    } finally { restore(); }
  });

  await atest('13. PHẦN 18: loại accuracy-critical KHÔNG BAO GIỜ chạm image API dù có provider', async () => {
    const { restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    const pipeline = require(PIPELINE_PATH);
    require(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualCache.js'))._resetForTest();
    try {
      let apiCalls = 0;
      const r = await withFetch(async () => { apiCalls++; return { ok: true, status: 200, json: async () => ({}) }; },
        () => pipeline.runVisualPipeline({
          question: 'Khảo sát và vẽ đồ thị hàm số y = x^2 - 2x - 3',
          finalAnswer: 'Ta có y = x^2-2x-3, đỉnh I(1;-4).',
          subject: 'math', answerComplete: true
        }));
      assert.strictEqual(r.status, 'ready');
      assert.strictEqual(apiCalls, 0, 'đồ thị toán TUYỆT ĐỐI không được giao cho image generation');
      assert.strictEqual(r.visuals[0].format, 'svg');
    } finally { restore(); }
  });

  // ---------- 6. Quality gate chặn ảnh sai ----------
  await atest('14. PHẦN 26: ảnh qua image gen vẫn phải qua quality gate (ảnh rỗng bị loại)', async () => {
    const { restore } = loadClient({ GEMINI_IMAGE_API_KEY: 'k' });
    const pipeline = require(PIPELINE_PATH);
    require(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualCache.js'))._resetForTest();
    try {
      const r = await withFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: '' } }] } }] })
      }), () => pipeline.runVisualPipeline({
        question: 'Trình bày cấu tạo của tế bào nhân thực',
        finalAnswer: 'Tế bào nhân thực gồm:\n- **Ti thể**: hô hấp tế bào\n- **Lục lạp**: quang hợp',
        subject: 'biology', answerComplete: true
      }));
      // data rỗng -> client coi là không có ảnh -> fallback deterministic (vẫn ready) hoặc failed.
      if (r.status === 'ready') assert.notStrictEqual(r.visuals[0].renderer, 'generated_image');
    } finally { restore(); }
  });

  // ---------- 7. Judge (TẦNG 3) ----------
  await atest('15. TẦNG 3: judge đảo được quyết định borderline, và lỗi judge KHÔNG ảnh hưởng gì', async () => {
    const { createVisualJudge, parseJudgeVerdict } = require(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualJudge.js'));
    assert.deepStrictEqual(
      parseJudgeVerdict('```json\n{"useful":true,"confidence":0.8,"visualType":"physics_diagram"}\n```'),
      { useful: true, confidence: 0.8, visualType: 'physics_diagram' }
    );
    assert.strictEqual(parseJudgeVerdict('không phải json'), null);

    const judgeOk = createVisualJudge({ callFn: async () => ({ text: '{"useful":true,"confidence":0.9}' }) });
    const v = await judgeOk({ question: 'q', subject: 'physics', decision: { visualType: 'physics_diagram' } });
    assert.strictEqual(v.useful, true);

    const judgeFail = createVisualJudge({ callFn: async () => { throw new Error('provider down'); } });
    assert.strictEqual(await judgeFail({ question: 'q', subject: 'physics', decision: {} }), null, 'judge lỗi -> null, giữ heuristic');

    assert.strictEqual(createVisualJudge({}), null, 'không có callFn -> tầng 3 tắt hẳn');
  });

  await atest('16. TẦNG 3 CHỈ được gọi cho case borderline (không đốt token cho case hiển nhiên)', async () => {
    const pipeline = require(PIPELINE_PATH);
    require(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualCache.js'))._resetForTest();
    let judgeCalls = 0;
    const judge = async () => { judgeCalls++; return { useful: true, confidence: 0.9 }; };

    await pipeline.runVisualPipeline({
      question: '2 + 3 bằng bao nhiêu?', finalAnswer: 'Bằng 5.', subject: 'math', answerComplete: true, judge
    });
    assert.strictEqual(judgeCalls, 0, 'case hiển nhiên KHÔNG được gọi model');

    await pipeline.runVisualPipeline({
      question: 'Con lắc lò xo dao động điều hòa với biên độ 5 cm, chu kỳ 2 s. Viết phương trình dao động.',
      finalAnswer: 'Phương trình: x = 5cos(πt) cm.', subject: 'physics', answerComplete: true, judge
    });
    assert.strictEqual(judgeCalls, 1, 'case borderline PHẢI được model phân xử');
  });

  let passed = 0, failed = 0;
  console.log('\n== Image generation client + fallback + tầng 3 judge ==');
  results.forEach((r) => {
    if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
    else { failed++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
