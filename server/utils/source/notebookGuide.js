'use strict';

// ============================================================================================
// MỤC IV/XIX/XXIV (rework notebook) — NOTEBOOK GUIDE
// ============================================================================================
// Guide = { summary, faq, deepQuestions, brief, topics } cho MỘT nguồn, sinh bằng ĐÚNG 1 lệnh gọi AI
// (không phải 5 lệnh cho 5 phần — mục IV cấm rõ điều này), và dùng lại nguyên hạ tầng đã có thay vì
// tạo pipeline riêng:
//   - sourceContentCache: cache theo (fingerprint, extractorVersion, extra) — TTL dài, có lớp KV nếu
//     cấu hình, y hệt cách webSource.js/youtubeSource.js cache nội dung đã trích.
//   - singleFlight: chống 2 request đồng thời cùng 1 nguồn cùng sinh guide 2 lần.
//   - aiProviders.callWithFailover: gọi model, model-agnostic — route không tự chọn provider.
//
// Cache key CỐ Ý không có sourceId (id chỉ tồn tại trong 1 phiên client) — dùng fingerprint nội dung
// để 2 người dùng khác nhau upload TRÙNG một tài liệu vẫn hit cache, đúng tinh thần "đọc 1 lần".
//
// Nén trước khi gọi AI là BƯỚC DETERMINISTIC (buildSynopsis), không phải một lượt AI phụ — giữ đúng
// pipeline mục IV: "RAW SOURCE -> indexed chunks -> deterministic source statistics -> compressed
// source synopsis -> ONE batched AI generation -> Guide JSON". Nguồn cực dài (hierarchical multi-pass
// summarization) KHÔNG được implement ở bản này — xem giới hạn ở cuối file.

const sourceContentCache = require('./sourceContentCache');
const singleFlight = require('../singleFlight');

const GUIDE_VERSION = 'guide-v1';

// Ngân sách ký tự đưa vào 1 lệnh gọi AI để sinh guide — RỘNG hơn 1 lượt trả lời chat thường (guide
// cần nhìn được "cả nguồn", không phải chỉ evidence khớp 1 câu hỏi), nhưng vẫn có trần để 1 PDF vài
// trăm trang không thổi bay context window. Env override cho triển khai có model context lớn hơn.
const SYNOPSIS_CHAR_BUDGET = Number(process.env.GUIDE_SYNOPSIS_CHAR_BUDGET) || 42000;
const MAX_OUTPUT_TOKENS = Number(process.env.GUIDE_MAX_OUTPUT_TOKENS) || 2200;

// Trần độ dài từng phần trong JSON trả về — chặn model trả lan man, và chặn 1 phản hồi hỏng làm
// payload phình bất thường trước khi lưu cache.
const LIMITS = {
  SUMMARY_CHARS: 2200,
  FAQ_ITEMS: 8,
  FAQ_Q_CHARS: 300,
  FAQ_A_CHARS: 900,
  DEEP_QUESTIONS: 8,
  DEEP_QUESTION_CHARS: 300,
  BRIEF_LIST_ITEMS: 10,
  BRIEF_ITEM_CHARS: 400,
  TOPICS: 12,
  TOPIC_CHARS: 80
};

const BRIEF_KEYS = ['coreIdeas', 'formulas', 'definitions', 'misconceptions', 'keyData', 'conclusions'];

function clip(str, max) {
  const s = typeof str === 'string' ? str : '';
  return s.length > max ? s.slice(0, max) : s;
}

function clipList(arr, maxItems, maxChars) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => typeof x === 'string' && x.trim())
    .slice(0, maxItems)
    .map((x) => clip(x.trim(), maxChars));
}

/**
 * Thống kê THUẦN (không AI) trên tập chunk đã index — dùng để hiển thị + để quyết định có cần nén
 * synopsis hay không.
 * @param {Array<{text:string}>} chunks
 */
function computeSourceStats(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const totalChars = list.reduce((a, c) => a + (c && typeof c.text === 'string' ? c.text.length : 0), 0);
  return {
    totalChunks: list.length,
    totalChars,
    avgChunkChars: list.length ? Math.round(totalChars / list.length) : 0
  };
}

/**
 * Nén 1 nguồn về tối đa `budgetChars` ký tự, DETERMINISTIC (không AI). Nếu vừa ngân sách, ghép
 * nguyên văn theo thứ tự. Nếu không, lấy mẫu cách đều (đầu -> giữa -> cuối) để synopsis vẫn phản ánh
 * toàn bộ tài liệu thay vì chỉ phần đầu (lỗi thường gặp khi "cắt" thay vì "lấy mẫu").
 * @param {Array<{text:string, locator?:string, chunkIndex?:number}>} chunks
 * @param {number} budgetChars
 * @returns {{synopsis:string, sampled:boolean, coverageRatio:number, includedChunks:number}}
 */
function buildSynopsis(chunks, budgetChars = SYNOPSIS_CHAR_BUDGET) {
  const list = (Array.isArray(chunks) ? chunks : []).filter((c) => c && typeof c.text === 'string' && c.text.trim());
  const label = (c, i) => c.locator || (c.chunkIndex != null ? `#${c.chunkIndex}` : `#${i + 1}`);
  const totalChars = list.reduce((a, c) => a + c.text.length, 0);

  if (!list.length) return { synopsis: '', sampled: false, coverageRatio: 0, includedChunks: 0 };

  if (totalChars <= budgetChars) {
    const synopsis = list.map((c, i) => `[${label(c, i)}] ${c.text.trim()}`).join('\n\n');
    return { synopsis, sampled: false, coverageRatio: 1, includedChunks: list.length };
  }

  // Lấy mẫu cách đều theo STRIDE trên danh sách chunk (không theo ký tự) — giữ tính đại diện đều
  // khắp tài liệu. Luôn ép có chunk đầu và chunk cuối để synopsis có "mở bài" và "kết luận" thật:
  // chunk bị bỏ qua vì vượt ngân sách chỉ được `continue` (bỏ qua CHÍNH NÓ), không `break` cả vòng
  // lặp — nếu không, chunk cuối (force) không bao giờ tới lượt vì vòng lặp đã thoát sớm hơn.
  const stride = Math.max(1, Math.floor(totalChars / budgetChars));
  const estimatedCount = Math.max(2, Math.ceil(list.length / stride));
  const perChunkBudget = Math.max(200, Math.floor(budgetChars / estimatedCount));
  const forceIndices = new Set([0, list.length - 1]);

  const picked = [];
  let used = 0;
  for (let i = 0; i < list.length; i += 1) {
    const mustInclude = forceIndices.has(i);
    if (!mustInclude && i % stride !== 0) continue;
    const c = list[i];
    const piece = clip(c.text.trim(), perChunkBudget);
    const entry = `[${label(c, i)}] ${piece}`;
    if (!mustInclude && used + entry.length > budgetChars) continue; // bỏ mẫu này, KHÔNG dừng vòng lặp
    picked.push(entry);
    used += entry.length;
  }
  // picked đã theo đúng thứ tự i tăng dần (vòng lặp for tuần tự) — không cần sort lại.
  const synopsis = picked.join('\n\n');

  return {
    synopsis,
    sampled: true,
    coverageRatio: Math.min(1, used / totalChars),
    includedChunks: picked.length
  };
}

function guideSystemPrompt(language) {
  const lang = language || 'vi';
  return [
    `Bạn là công cụ tạo "Notebook Guide" cho một nguồn tài liệu học tập. Ngôn ngữ trả lời: ${lang}.`,
    'Bạn CHỈ được nhận input là các trích đoạn (không phải toàn văn) của nguồn — có thể là một mẫu đại',
    'diện nếu nguồn dài. TUYỆT ĐỐI KHÔNG bịa nội dung không suy ra được từ các trích đoạn này.',
    '',
    'Trả về ĐÚNG 1 khối JSON hợp lệ (không markdown code fence, không text nào khác), đúng shape:',
    '{',
    '  "summary": "tóm tắt ngắn gọn toàn bộ nội dung nguồn",',
    '  "faq": [{"question": "...", "answer": "..."}],',
    '  "deepQuestions": ["câu hỏi đào sâu tư duy dựa trên nội dung, không phải câu hỏi tra cứu đơn thuần"],',
    '  "brief": {',
    '    "coreIdeas": ["..."], "formulas": ["..."], "definitions": ["..."],',
    '    "misconceptions": ["..."], "keyData": ["..."], "conclusions": ["..."]',
    '  },',
    '  "topics": ["chủ đề liên quan xuất hiện trong chính nguồn"]',
    '}',
    '',
    '- faq: câu hỏi + trả lời NGẮN GỌN, đúng những gì nguồn thực sự đề cập.',
    '- brief: nếu nguồn không có công thức/số liệu thì để mảng rỗng tương ứng, KHÔNG bịa thêm cho đủ.',
    '- Nếu các trích đoạn không đủ để trả lời một mục nào đó, để mảng/giá trị rỗng thay vì đoán.'
  ].join('\n');
}

/** Parse JSON guide từ model — chịu được model lỡ bọc ```json``` dù đã dặn không dùng. Trả null nếu
 * không parse được hoặc sai shape cơ bản; caller phải coi đó là lỗi (không cache, không giả vờ OK). */
function parseGuideJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  const brief = {};
  const rawBrief = parsed.brief && typeof parsed.brief === 'object' ? parsed.brief : {};
  BRIEF_KEYS.forEach((key) => {
    brief[key] = clipList(rawBrief[key], LIMITS.BRIEF_LIST_ITEMS, LIMITS.BRIEF_ITEM_CHARS);
  });

  const faq = Array.isArray(parsed.faq)
    ? parsed.faq
      .filter((x) => x && typeof x.question === 'string' && typeof x.answer === 'string' && x.question.trim())
      .slice(0, LIMITS.FAQ_ITEMS)
      .map((x) => ({ question: clip(x.question.trim(), LIMITS.FAQ_Q_CHARS), answer: clip(x.answer.trim(), LIMITS.FAQ_A_CHARS) }))
    : [];

  return {
    summary: clip(typeof parsed.summary === 'string' ? parsed.summary.trim() : '', LIMITS.SUMMARY_CHARS),
    faq,
    deepQuestions: clipList(parsed.deepQuestions, LIMITS.DEEP_QUESTIONS, LIMITS.DEEP_QUESTION_CHARS),
    brief,
    topics: clipList(parsed.topics, LIMITS.TOPICS, LIMITS.TOPIC_CHARS)
  };
}

/** true nếu guide parse được nhưng KHÔNG có nội dung thật nào (mọi phần rỗng) — coi như lỗi để
 * không cache một guide rỗng và trả lại cho người dùng như thể đã tạo thành công (mục XXIX). */
function isEmptyGuide(guide) {
  if (!guide) return true;
  const briefHasContent = BRIEF_KEYS.some((k) => (guide.brief[k] || []).length > 0);
  return !guide.summary && !guide.faq.length && !guide.deepQuestions.length && !guide.topics.length && !briefHasContent;
}

/**
 * @param {{sourceId?:string, name?:string, fingerprint:string, extractionVersion?:string|number,
 *   language?:string, chunks:Array<{text:string, locator?:string, chunkIndex?:number}>}} input
 * @param {Array} providers   danh sách provider active (từ aiProviders.getActiveProviders())
 * @param {{callWithFailover:Function, requestId?:string, noCache?:boolean, deadline?:any}} deps
 * @returns {Promise<{ok:boolean, reason?:string, fromCache?:boolean, guideVersion:string,
 *   fingerprint:string, language:string, stats:object, sampled:boolean, coverageRatio:number,
 *   summary?:string, faq?:Array, deepQuestions?:Array, brief?:object, topics?:Array}>}
 */
async function generateNotebookGuide(input, providers, deps) {
  const fingerprint = String((input && input.fingerprint) || '').trim();
  if (!fingerprint) return { ok: false, reason: 'missing_fingerprint' };
  const chunks = Array.isArray(input.chunks) ? input.chunks : [];
  if (!chunks.length) return { ok: false, reason: 'no_content' };
  if (!providers || !providers.length) return { ok: false, reason: 'no_provider' };

  const language = input.language || 'vi';
  const extractionVersion = input.extractionVersion != null ? String(input.extractionVersion) : '';
  const cacheParts = {
    url: `guide::${fingerprint}`,
    extractorVersion: GUIDE_VERSION,
    extra: `${extractionVersion}|${language}`
  };

  return singleFlight.scoped('notebookGuide')(`${fingerprint}|${extractionVersion}|${language}`, async () => {
    if (!deps || !deps.noCache) {
      const cached = await sourceContentCache.get(cacheParts);
      if (cached && cached.value) return { ...cached.value, fromCache: true };
    }

    const stats = computeSourceStats(chunks);
    const { synopsis, sampled, coverageRatio } = buildSynopsis(chunks, SYNOPSIS_CHAR_BUDGET);
    if (!synopsis) return { ok: false, reason: 'no_content' };

    const resp = await deps.callWithFailover(
      providers,
      {
        system: guideSystemPrompt(language),
        messages: [{ role: 'user', content: `Nguồn: ${input.name || fingerprint}\n\n${synopsis}` }],
        maxTokens: MAX_OUTPUT_TOKENS,
        // PHẦN S: token này thuộc chi phí index nguồn (1 lần), không phải chi phí 1 lượt chat.
        stage: 'source_indexing_notebook_guide',
        requestId: deps.requestId
      },
      { deadline: deps.deadline }
    );

    const guide = parseGuideJson(resp && resp.text);
    if (!guide || isEmptyGuide(guide)) return { ok: false, reason: 'invalid_response_shape' };

    const payload = {
      ok: true,
      guideVersion: GUIDE_VERSION,
      fingerprint,
      language,
      stats,
      sampled,
      coverageRatio: Math.round(coverageRatio * 1000) / 1000,
      generatedAt: Date.now(),
      ...guide
    };
    await sourceContentCache.set(cacheParts, payload, {});
    return payload;
  });
}

// GIỚI HẠN ĐÃ BIẾT: với nguồn cực dài (vượt SYNOPSIS_CHAR_BUDGET nhiều lần), buildSynopsis() lấy MẪU
// đại diện thay vì tóm tắt phân cấp (chunk-summaries -> hierarchical compression) mà mục IV mô tả cho
// trường hợp "source rất dài" — nghĩa là các đoạn KHÔNG được lấy mẫu sẽ không xuất hiện trong guide.
// `sampled`/`coverageRatio` trả về đúng để UI có thể cảnh báo "guide dựa trên X% nội dung".

module.exports = {
  GUIDE_VERSION,
  SYNOPSIS_CHAR_BUDGET,
  MAX_OUTPUT_TOKENS,
  LIMITS,
  BRIEF_KEYS,
  computeSourceStats,
  buildSynopsis,
  guideSystemPrompt,
  parseGuideJson,
  isEmptyGuide,
  generateNotebookGuide
};
