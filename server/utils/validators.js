'use strict';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const MAX_QUERY = 4000;
const MAX_RULE_LEN = 300;
const MAX_RULES = 20;
const MAX_CONTEXTS = 8;
const MAX_CONTEXT_LEN = 1200;
const MAX_DOC_NAME = 120;
const MAX_HISTORY = 20;
const MAX_HISTORY_ITEM = 4000;
const MAX_GENERATE_CONTENT = 6000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB sau khi giải mã base64
const MAX_APPROACH_LEN = 3000;
const ALLOWED_STAGES = ['approach', 'detail'];

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ALLOWED_LANGS = ['Tiếng Việt', 'English', 'tự động theo câu hỏi'];
// VẤN ĐỀ 1 (mục 1): trước đây có 3 mức ('ngắn gọn'/'tiêu chuẩn'/'rất chi tiết'). Mức "rất chi tiết"
// không tạo giá trị tương xứng: dễ lặp nội dung giữa Hướng giải/Lời giải, tăng output token, tăng
// nguy cơ timeout/truncated. CHỈ CÒN đúng 2 mức hợp lệ — mọi giá trị khác (kể cả 'rất chi tiết' cũ
// từ localStorage/client cũ) đều migrate về 'tiêu chuẩn' (xem nhánh settings bên dưới).
const ALLOWED_DETAIL = ['ngắn gọn', 'tiêu chuẩn'];
const LEGACY_DETAIL_MIGRATION = { 'rất chi tiết': 'tiêu chuẩn' };
function normalizeDetail(value) {
  if (ALLOWED_DETAIL.includes(value)) return value;
  if (LEGACY_DETAIL_MIGRATION[value]) return LEGACY_DETAIL_MIGRATION[value];
  return 'tiêu chuẩn';
}

// ---------- Mục 4: normalizeRules() — chuẩn hoá ĐỒNG NHẤT tại 1 nơi duy nhất ----------
// Rules trước đây chỉ được clip độ dài ở validateChatBody, không trim/dedupe/loại rỗng một cách
// nhất quán — đây là nguồn gốc khả dĩ của hiện tượng "lúc có lúc không" (2 rule chỉ khác nhau ở
// khoảng trắng bị coi là 2 rule riêng, rule rỗng vẫn lọt qua...). Mọi nơi cần rules (chat, self-check,
// similar) đều PHẢI đi qua đúng hàm này để nhận cùng 1 danh sách đã chuẩn hoá.
function normalizeRules(rawRules) {
  if (!Array.isArray(rawRules)) return [];
  const seen = new Set();
  const out = [];
  for (const r of rawRules) {
    const cleaned = clip(String(r || '').trim().replace(/\s+/g, ' '), MAX_RULE_LEN);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue; // loại duplicate (không phân biệt hoa/thường/khoảng trắng thừa)
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

// Cấp học/khối lớp (mục V/VI master prompt v2 — P0): PHẢI khớp đúng window.SCHOOL_LEVELS /
// window.GRADE_LABELS ở public/js/formulas.js. Trước bản sửa này, validateChatBody() chỉ giữ lại
// settings.lang/settings.detail rồi bỏ hẳn settings.school/settings.grade — nghĩa là backend/AI
// KHÔNG BAO GIỜ biết học sinh đang học lớp mấy dù frontend đã có UI chọn đầy đủ (school/grade "chết"
// ở UI, không đi xuyên hết pipeline UI -> request -> validate -> promptBuilder -> AI). Định nghĩa
// allow-list ở đây để validate + chống giá trị lạ/injection, đồng thời áp dụng đúng quan hệ
// school -> danh sách grade hợp lệ (giống hệt logic ở app.js khi đổi school thì reset grade).
const SCHOOL_GRADES = {
  'tieu-hoc': ['1', '2', '3', '4', '5'],
  'thcs': ['6', '7', '8', '9'],
  'thpt': ['10', '11', '12'],
  'dai-hoc': ['dai-hoc']
};
const DEFAULT_SCHOOL = 'thpt';
const DEFAULT_GRADE = '10';

function clip(str, max) {
  if (typeof str !== 'string') return '';
  // loại bỏ ký tự điều khiển nguy hiểm, giữ nguyên xuống dòng thường
  const cleaned = str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return cleaned.slice(0, max);
}

/**
 * Validate + sanitize body của POST /api/chat.
 * QUAN TRỌNG: client KHÔNG được phép tự gửi "system prompt" — server luôn tự dựng lại
 * system prompt từ các trường đã được kiểm duyệt bên dưới (xem promptBuilder.js).
 */
function validateChatBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');

  const query = clip(String(body.query || '').trim(), MAX_QUERY);
  // "Suy nghĩ sâu" (AI tự phản biện nội bộ) và "Đối chiếu đa hướng" (giải nhiều lượt độc lập rồi
  // tổng hợp) giờ là 2 công tắc ĐỘC LẬP — client mới gửi rõ 2 trường riêng. Trường "deep" cũ (gộp
  // chung cả 2) vẫn được nhận diện để tương thích ngược với client cũ chưa cập nhật (cache trình
  // duyệt, tab cũ chưa tải lại...): nếu client chỉ gửi "deep":true mà không gửi 2 trường mới, coi
  // như bật cả hai — giữ đúng hành vi cũ thay vì âm thầm tắt mất 1 nửa tính năng.
  const legacyDeep = body.deep === true;
  const deepThinking = typeof body.deepThinking === 'boolean' ? body.deepThinking : legacyDeep;
  const crossCheck = typeof body.crossCheck === 'boolean' ? body.crossCheck : legacyDeep;
  const stage = ALLOWED_STAGES.includes(body.stage) ? body.stage : 'detail';
  const approachText = clip(String(body.approachText || '').trim(), MAX_APPROACH_LEN);

  let image = null;
  if (body.image) {
    const mediaType = body.image.mediaType;
    const base64 = body.image.base64;
    if (!ALLOWED_IMAGE_TYPES.includes(mediaType)) {
      throw new ValidationError('Định dạng ảnh không được hỗ trợ (chỉ nhận PNG/JPEG/WEBP/GIF).');
    }
    if (typeof base64 !== 'string' || base64.length === 0) {
      throw new ValidationError('Dữ liệu ảnh không hợp lệ.');
    }
    // ước lượng dung lượng gốc từ độ dài chuỗi base64
    const approxBytes = Math.floor(base64.length * 0.75);
    if (approxBytes > MAX_IMAGE_BYTES) {
      throw new ValidationError('Ảnh vượt quá dung lượng cho phép (tối đa 5MB).');
    }
    image = { mediaType, base64 };
  }

  if (!query && !image) {
    throw new ValidationError('Vui lòng nhập câu hỏi hoặc đính kèm ảnh.');
  }

  const rules = normalizeRules(body.rules);

  const contexts = Array.isArray(body.contexts)
    ? body.contexts.slice(0, MAX_CONTEXTS).map((c) => {
        const rawText = String((c && c.text) || '');
        return {
          doc: clip(String((c && c.doc) || ''), MAX_DOC_NAME),
          id: Number.isFinite(Number(c && c.id)) ? Number(c.id) : 1,
          text: clip(rawText, MAX_CONTEXT_LEN),
          // mục 9: RAW SOURCE vs RETRIEVED/SELECTED/COMPRESSED CONTEXT — client gửi context đã là 1
          // EXCERPT chọn sẵn, KHÔNG phải toàn bộ tài liệu gốc. Đánh dấu rõ khi excerpt này còn bị cắt
          // thêm ở đây (vượt MAX_CONTEXT_LEN) — downstream (sourceCoverage.js) PHẢI coi trường hợp
          // này là "còn khả năng thiếu", KHÔNG được kết luận "source không có X" chỉ vì X nằm ngoài
          // đúng phần excerpt hiện có.
          truncated: rawText.length > MAX_CONTEXT_LEN
        };
      }).filter((c) => c.text)
    : [];

  const bodySettings = body.settings || {};
  const school = Object.prototype.hasOwnProperty.call(SCHOOL_GRADES, bodySettings.school)
    ? bodySettings.school
    : DEFAULT_SCHOOL;
  const gradesForSchool = SCHOOL_GRADES[school];
  const grade = gradesForSchool.includes(bodySettings.grade) ? bodySettings.grade : gradesForSchool[0];
  const settings = {
    lang: ALLOWED_LANGS.includes(bodySettings.lang) ? bodySettings.lang : 'Tiếng Việt',
    detail: normalizeDetail(bodySettings.detail),
    school,
    grade
  };

  const history = Array.isArray(body.history)
    ? body.history.slice(-MAX_HISTORY).map((h) => ({
        role: h && h.role === 'assistant' ? 'assistant' : 'user',
        content: clip(String((h && h.content) || ''), MAX_HISTORY_ITEM)
      })).filter((h) => h.content)
    : [];

  return { query, deepThinking, crossCheck, image, rules, contexts, settings, history, stage, approachText };
}

/** Validate body của các endpoint /api/generate/* */
function validateGenerateBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const content = clip(String(body.content || '').trim(), MAX_GENERATE_CONTENT);
  if (!content) throw new ValidationError('Thiếu nội dung để tạo slide/flashcard/mindmap.');
  return { content };
}

/** Validate body của POST /api/generate/outline (đề cương .docx) */
function validateOutlineBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const content = clip(String(body.content || '').trim(), MAX_GENERATE_CONTENT);
  if (!content) throw new ValidationError('Thiếu nội dung để tạo đề cương.');
  const includeExercises = body.includeExercises === true;
  return { content, includeExercises };
}

// ---------- Mục 3A/3C: payload TỐI THIỂU cho self-check / similar ----------
// KHÔNG tái dùng validateChatBody() — 2 tác vụ nhỏ này KHÔNG được đi qua field set đầy đủ của
// pipeline giải bài (history/image/contexts đầy đủ...), chỉ nhận đúng field thực sự cần (mục 3
// QUY TẮC TOKEN: "Không gửi history/toàn bộ contexts/approachText/cross-check...").
const MAX_SELFCHECK_FIELD = 4000;
const MAX_STUDENT_ATTEMPT = 4000;

function validateSelfCheckBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const problem = clip(String(body.problem || '').trim(), MAX_SELFCHECK_FIELD);
  const referenceSolution = clip(String(body.referenceSolution || '').trim(), MAX_SELFCHECK_FIELD);
  const studentAttempt = clip(String(body.studentAttempt || '').trim(), MAX_STUDENT_ATTEMPT);
  if (!problem) throw new ValidationError('Thiếu đề bài để kiểm tra.');
  if (!studentAttempt) throw new ValidationError('Vui lòng nhập bài làm cần kiểm tra.');
  const lang = ALLOWED_LANGS.includes(body.language) ? body.language : 'Tiếng Việt';
  return { problem, referenceSolution, studentAttempt, language: lang };
}

function validateSimilarBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const problem = clip(String(body.problem || '').trim(), MAX_SELFCHECK_FIELD);
  const solutionMetadata = clip(String(body.solutionMetadata || '').trim(), MAX_SELFCHECK_FIELD);
  if (!problem) throw new ValidationError('Thiếu đề bài gốc để tạo bài tương tự.');
  const lang = ALLOWED_LANGS.includes(body.language) ? body.language : 'Tiếng Việt';
  const difficulty = ['easier', 'same', 'harder'].includes(body.difficulty) ? body.difficulty : 'same';
  return { problem, solutionMetadata, language: lang, difficulty };
}

module.exports = {
  ValidationError,
  validateChatBody,
  validateGenerateBody,
  validateOutlineBody,
  validateSelfCheckBody,
  validateSimilarBody,
  normalizeRules,
  normalizeDetail,
  SCHOOL_GRADES,
  ALLOWED_DETAIL,
  LIMITS: {
    MAX_QUERY, MAX_RULE_LEN, MAX_RULES, MAX_CONTEXTS, MAX_CONTEXT_LEN,
    MAX_HISTORY, MAX_IMAGE_BYTES, MAX_GENERATE_CONTENT
  }
};
