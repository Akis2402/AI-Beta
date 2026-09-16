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
// PHẦN A8 (SOURCE-COMPLETE): TRƯỚC đây MAX_CONTEXTS/MAX_CONTEXT_LEN là 1 CẶP SỐ DUY NHẤT làm luôn cả
// 2 việc — "chặn payload quá tải" (security) VÀ "AI chỉ được thấy N đoạn trong toàn bộ PDF" (source
// processing) — ROOT CAUSE khiến dù client đã sửa retrieveContext() gửi nhiều đoạn hơn, server vẫn
// âm thầm cắt về đúng 8. NAY tách rõ 2 tầng: SECURITY_* là trần THẬT SỰ vì lý do bảo mật/DoS (chặn 1
// request cố tình gửi hàng chục nghìn context để làm nghẽn server) — đặt CAO hơn hẳn nhu cầu bình
// thường, không phải "mức nên đạt tới"; nhu cầu SOURCE PROCESSING thật (client giờ có thể gửi hàng
// chục/hàng trăm đoạn cho 1 PDF dài) được phục vụ TRONG trần security đó, không bị coi là 2 khái
// niệm trùng nhau nữa.
const SECURITY_MAX_CONTEXTS = 300; // trần bảo mật cứng — KHÔNG được xuống dưới nhu cầu 1 PDF dài thật
const SECURITY_MAX_CONTEXT_LEN = 4000; // trần bảo mật/đơn vị 1 đoạn — cao hơn hẳn 1200 cũ để giảm số
// context bị đánh dấu `truncated` (mục A7: "LOSSLESS FOR EVIDENCE, LOSSY ONLY FOR REDUNDANCY"), vẫn
// giữ 1 trần hữu hạn để 1 đoạn dị thường không tự nó nuốt hết ngân sách token của cả request.
// Giữ tên cũ làm alias (tương thích ngược với nơi khác trong code còn require đúng tên cũ).
const MAX_CONTEXTS = SECURITY_MAX_CONTEXTS;
const MAX_CONTEXT_LEN = SECURITY_MAX_CONTEXT_LEN;
const MAX_DOC_NAME = 120;
const MAX_HISTORY = 20;
const MAX_HISTORY_ITEM = 4000;
const MAX_GENERATE_CONTENT = 6000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB sau khi giải mã base64
const MAX_SOURCE_MANIFEST_LEN = 4000; // mục A3: manifest chỉ là vài dòng thống kê nhẹ, không phải nội dung
// PDF chỉ chứa ảnh scan (không trích được text): client rasterize từng trang thành ảnh và gửi kèm
// làm "nguồn" cho model đọc trực tiếp bằng vision, thay vì trích dẫn theo đoạn text như PDF thường.
// PHẦN A10/A8: trước đây 6 — cùng gốc với PDF_MAX_RASTER_PAGES ở client, ROOT CAUSE thứ hai của "PDF
// scan bị cụt". Nay client tự chọn trang liên quan nhất cho 1 lượt hỏi (xem collectSourceImages() ở
// app.js) trong trần này — nâng trần lên đủ rộng để 1 câu hỏi có thể kéo nhiều trang khi cần (vd hỏi
// "trang 12 đến 20") mà vẫn chặn được 1 request cố tình nhồi hàng trăm ảnh.
const MAX_SOURCE_IMAGES = 24;
const MAX_SOURCE_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB/trang sau khi giải mã base64 (đã downscale ở client)
const MAX_APPROACH_LEN = 3000;
const ALLOWED_STAGES = ['approach', 'detail'];
// PHẦN 27: chế độ hình minh hoạ do người dùng chọn (đi vào cache key — xem routes/chat.js).
const ALLOWED_VISUAL_MODES = ['auto', 'always', 'never'];

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

// Mục 14.3: 'auto' (mặc định, AI tự nhận diện môn) hoặc 1 trong các subject id cố định (chọn thủ công).
const { ALLOWED_SUBJECT_IDS } = require('./subjects');
function normalizeSubject(value) {
  return ALLOWED_SUBJECT_IDS.includes(value) ? value : 'auto';
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
 * sourceImages: dùng chung cho /api/chat VÀ /api/generate/outline + /api/generate/mindmap (PDF-chỉ-
 * ảnh cũng cần đọc được khi soạn đề cương/mindmap, không chỉ lúc giải bài) — tách thành hàm dùng
 * chung để các nơi validate luôn NHẤT QUÁN 1 bộ giới hạn, không lệch nhau nếu sau này chỉnh ngưỡng.
 */
function parseSourceImages(body) {
  return Array.isArray(body && body.sourceImages)
    ? body.sourceImages.slice(0, MAX_SOURCE_IMAGES).map((img) => {
        const mediaType = img && img.mediaType;
        const base64 = img && img.base64;
        if (!ALLOWED_IMAGE_TYPES.includes(mediaType)) return null;
        if (typeof base64 !== 'string' || base64.length === 0) return null;
        const approxBytes = Math.floor(base64.length * 0.75);
        if (approxBytes > MAX_SOURCE_IMAGE_BYTES) return null; // âm thầm bỏ qua trang lỗi/quá nặng, không chặn cả yêu cầu
        return {
          mediaType,
          base64,
          doc: clip(String((img && img.doc) || ''), MAX_DOC_NAME),
          page: Number.isFinite(Number(img && img.page)) ? Number(img.page) : null
        };
      }).filter(Boolean)
    : [];
}

/**
 * Validate + sanitize body của POST /api/chat.
 * QUAN TRỌNG: client KHÔNG được phép tự gửi "system prompt" — server luôn tự dựng lại
 * system prompt từ các trường đã được kiểm duyệt bên dưới (xem promptBuilder.js).
 */
// PHẦN F/N: tập giá trị hợp lệ cho provenance + vòng đời nguồn (khớp public/js/app.js).
const ALLOWED_EXTRACTION_METHODS = ['text', 'vision', 'none', 'unknown'];
const ALLOWED_EXTRACTION_STATUSES = ['ok', 'failed', 'pending', 'placeholder'];
const ALLOWED_SOURCE_STATUSES = ['UPLOADING', 'PARSING', 'RASTERIZING', 'EXTRACTING', 'VERIFYING', 'READY', 'INCOMPLETE', 'ERROR'];
const ALLOWED_AVAILABILITY_STATUSES = ['UNAVAILABLE', 'PARTIAL', 'AVAILABLE'];
const ALLOWED_PROCESSING_STATUS_AXIS = ['IDLE', 'PROCESSING', 'DONE', 'ERROR'];
const ALLOWED_VERIFICATION_STATUSES = ['UNVERIFIED', 'PARTIAL', 'VERIFIED'];
const MAX_SOURCE_STATUS_ENTRIES = 20;
function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

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

  // sourceImages: ảnh các trang PDF-chỉ-ảnh (scan), KHÁC với `image` (ảnh đề bài người dùng chụp/dán
  // trực tiếp) — validate qua parseSourceImages() dùng chung với /api/generate/*.
  const sourceImages = parseSourceImages(body);

  const rules = normalizeRules(body.rules);

  const contexts = Array.isArray(body.contexts)
    ? body.contexts.slice(0, SECURITY_MAX_CONTEXTS).map((c) => {
        const rawText = String((c && c.text) || '');
        const page = Number.isFinite(Number(c && c.page)) ? Number(c.page) : null;
        const startPage = Number.isFinite(Number(c && c.startPage)) ? Number(c.startPage) : page;
        const endPage = Number.isFinite(Number(c && c.endPage)) ? Number(c.endPage) : page;
        return {
          doc: clip(String((c && c.doc) || ''), MAX_DOC_NAME),
          id: Number.isFinite(Number(c && c.id)) ? Number(c.id) : 1,
          text: clip(rawText, SECURITY_MAX_CONTEXT_LEN),
          // mục A2/A9: giữ metadata trang/vị trí chunk để citation truy nguyên đúng trang, và để
          // sourceCoverage/completenessCheck biết đúng đoạn nào thuộc trang nào khi báo cáo coverage.
          page, startPage, endPage,
          sourceId: (c && c.sourceId != null) ? clip(String(c.sourceId), MAX_DOC_NAME) : null,
          chunkIndex: Number.isFinite(Number(c && c.chunkIndex)) ? Number(c.chunkIndex) : null,
          totalChunks: Number.isFinite(Number(c && c.totalChunks)) ? Number(c.totalChunks) : null,
          // PHẦN F (provenance): mỗi evidence tự khai nó đến từ đâu và bằng cách nào. Nhờ đó
          // citationMap/validator không phải suy luận lại theo vị trí mảng, và ta chặn được
          // citation trỏ vào chunk lỗi/placeholder ngay tại cổng vào.
          evidenceId: (c && c.evidenceId != null) ? clip(String(c.evidenceId), MAX_DOC_NAME) : null,
          extractionMethod: ALLOWED_EXTRACTION_METHODS.includes(c && c.extractionMethod) ? c.extractionMethod : 'unknown',
          extractionStatus: ALLOWED_EXTRACTION_STATUSES.includes(c && c.extractionStatus) ? c.extractionStatus : 'ok',
          retrievalTier: Number.isFinite(Number(c && c.retrievalTier)) ? Number(c.retrievalTier) : null,
          // mục 9: RAW SOURCE vs RETRIEVED/SELECTED/COMPRESSED CONTEXT — client gửi context đã là 1
          // EXCERPT chọn sẵn, KHÔNG phải toàn bộ tài liệu gốc. Đánh dấu rõ khi excerpt này còn bị cắt
          // thêm ở đây (vượt SECURITY_MAX_CONTEXT_LEN) — downstream (sourceCoverage.js) PHẢI coi
          // trường hợp này là "còn khả năng thiếu", KHÔNG được kết luận "source không có X" chỉ vì X
          // nằm ngoài đúng phần excerpt hiện có.
          truncated: rawText.length > SECURITY_MAX_CONTEXT_LEN
        };
      }).filter((c) => c.text)
    : [];

  // mục A3: SOURCE MANIFEST — metadata nhẹ tóm tắt coverage (số trang/đoạn/% đã đọc) của các nguồn
  // đang active, KHÔNG phải nội dung thật (nội dung thật vẫn nằm trong `contexts`/`sourceImages`).
  const sourceManifest = clip(String(body.sourceManifest || '').trim(), MAX_SOURCE_MANIFEST_LEN);

  // PHẦN N/S: TRẠNG THÁI THẬT của từng nguồn (vòng đời lifecycle phía client). Server dùng nó để
  // (1) cấm model kết luận "tài liệu không có thông tin" khi nguồn chưa đọc xong, (2) log
  // sourceReady/sourceCoverage, (3) đưa extractionVersion vào cache key (PHẦN T).
  const sourceStatus = Array.isArray(body.sourceStatus)
    ? body.sourceStatus.slice(0, MAX_SOURCE_STATUS_ENTRIES).map((s0) => ({
      sourceId: clip(String((s0 && s0.sourceId) || ''), MAX_DOC_NAME),
      name: clip(String((s0 && s0.name) || ''), MAX_DOC_NAME),
      status: ALLOWED_SOURCE_STATUSES.includes(s0 && s0.status) ? s0.status : 'INCOMPLETE',
      // PHẦN III/N (progressive ingestion): 3 trục mới + cờ usableNow — nếu thiếu (client cũ chưa
      // nâng cấp), để undefined/false chứ KHÔNG suy đoán true, downstream (isSourceUsableFromStatus)
      // tự fallback về status==='READY' khi usableNow không phải boolean (xem sourceProvenance.js).
      availabilityStatus: ALLOWED_AVAILABILITY_STATUSES.includes(s0 && s0.availabilityStatus) ? s0.availabilityStatus : undefined,
      processingStatus: ALLOWED_PROCESSING_STATUS_AXIS.includes(s0 && s0.processingStatus) ? s0.processingStatus : undefined,
      verificationStatus: ALLOWED_VERIFICATION_STATUSES.includes(s0 && s0.verificationStatus) ? s0.verificationStatus : undefined,
      usableNow: typeof (s0 && s0.usableNow) === 'boolean' ? s0.usableNow : undefined,
      extractionMethod: ALLOWED_EXTRACTION_METHODS.includes(s0 && s0.extractionMethod) ? s0.extractionMethod : 'unknown',
      extractionVersion: Number.isFinite(Number(s0 && s0.extractionVersion)) ? Number(s0.extractionVersion) : 0,
      totalPages: nonNegInt(s0 && s0.totalPages),
      parsedPages: nonNegInt(s0 && s0.parsedPages),
      renderedPages: nonNegInt(s0 && s0.renderedPages),
      extractedPages: nonNegInt(s0 && s0.extractedPages),
      verifiedPages: nonNegInt(s0 && s0.verifiedPages),
      failedPages: Array.isArray(s0 && s0.failedPages) ? s0.failedPages.slice(0, 50).map((p) => nonNegInt(p)) : [],
      renderCoverage: nonNegInt(s0 && s0.renderCoverage),
      readCoverage: nonNegInt(s0 && s0.readCoverage),
      verifiedCoverage: nonNegInt(s0 && s0.verifiedCoverage)
    })).filter((s0) => s0.sourceId || s0.name)
    : [];
  // Số lượt history GỐC phía client (trước khi selectRelevantHistory() lọc) — chỉ để telemetry
  // historyTurnsRaw vs historyTurnsSent (PHẦN S), KHÔNG ảnh hưởng nội dung prompt.
  const historyTurnsRaw = nonNegInt(body.historyTurnsRaw);

  // PHẦN F BỔ SUNG — CHỐNG BỊA BÀI TẬP CÓ SỐ THỨ TỰ CỤ THỂ.
  // Root cause thật đã xảy ra: user hỏi "giải bài 1.9 đến 1.11", retrieval KHÔNG tìm thấy evidence
  // đúng nhãn "1.9" (OCR/format khác), rơi xuống tầng khớp từ khoá chung và tình cờ lấy trúng đoạn
  // của MỤC KHÁC trong cùng tài liệu (hệ thức Chasles) — model trình bày nhầm nội dung đó như thể là
  // bài 1.9 thật. `unmatchedRequirementLabels` là danh sách nhãn KHÔNG có bằng chứng thật, dùng để
  // cấm cứng hành vi này ở promptBuilder + gắn cờ ở completenessCheck nếu model vẫn lỡ làm.
  const clipLabel = (x) => clip(String(x || ''), 40);
  const requirementLabels = Array.isArray(body.requirementLabels)
    ? body.requirementLabels.slice(0, 30).map(clipLabel).filter(Boolean) : [];
  const unmatchedRequirementLabels = Array.isArray(body.unmatchedRequirementLabels)
    ? body.unmatchedRequirementLabels.slice(0, 30).map(clipLabel).filter(Boolean) : [];

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
    grade,
    subject: normalizeSubject(bodySettings.subject),
    // PHẦN 27: "Visual explanations" — Auto (mặc định) | Always when useful | Never.
    // Giá trị lạ/thiếu (client cũ) -> 'auto', KHÔNG bao giờ throw để không phá tương thích ngược.
    visual: ALLOWED_VISUAL_MODES.includes(bodySettings.visual) ? bodySettings.visual : 'auto'
  };

  const history = Array.isArray(body.history)
    ? body.history.slice(-MAX_HISTORY).map((h) => ({
        role: h && h.role === 'assistant' ? 'assistant' : 'user',
        content: clip(String((h && h.content) || ''), MAX_HISTORY_ITEM)
      })).filter((h) => h.content)
    : [];

  return { query, deepThinking, crossCheck, image, sourceImages, rules, contexts, sourceManifest, sourceStatus, historyTurnsRaw, requirementLabels, unmatchedRequirementLabels, settings, history, stage, approachText };
}

/** Validate body của các endpoint /api/generate/* (flashcards + mindmap dùng chung) */
function validateGenerateBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const content = clip(String(body.content || '').trim(), MAX_GENERATE_CONTENT);
  const sourceImages = parseSourceImages(body);
  if (!content && !sourceImages.length) throw new ValidationError('Thiếu nội dung để tạo slide/flashcard/mindmap.');
  return { content, sourceImages };
}

/** Validate body của POST /api/generate/outline (đề cương .docx) */
function validateOutlineBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const content = clip(String(body.content || '').trim(), MAX_GENERATE_CONTENT);
  const sourceImages = parseSourceImages(body);
  if (!content && !sourceImages.length) throw new ValidationError('Thiếu nội dung để tạo đề cương.');
  const includeExercises = body.includeExercises === true;
  return { content, sourceImages, includeExercises };
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

/**
 * PHẦN A6/A11: batch xử lý ảnh trang PDF-chỉ-ảnh — validate riêng cho /api/source/vision-extract
 * (khác /api/chat: ở đây KHÔNG cần query/contexts, chỉ cần đúng 1 batch ảnh trang, tối đa 8 trang/
 * request — khớp PDF_RASTER_BATCH_SIZE ở client — để 1 request vision không phình quá lớn/lâu).
 */
const MAX_VISION_BATCH_PAGES = 8;
function validateSourceVisionBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const pages = parseSourceImages({ sourceImages: body.pages }).slice(0, MAX_VISION_BATCH_PAGES);
  if (!pages.length) throw new ValidationError('Không có trang ảnh hợp lệ nào để xử lý.');
  return { pages };
}

module.exports = {
  ValidationError,
  validateChatBody,
  validateGenerateBody,
  validateOutlineBody,
  validateSelfCheckBody,
  validateSimilarBody,
  validateSourceVisionBody,
  normalizeRules,
  normalizeDetail,
  SCHOOL_GRADES,
  ALLOWED_DETAIL,
  LIMITS: {
    MAX_QUERY, MAX_RULE_LEN, MAX_RULES, MAX_CONTEXTS, MAX_CONTEXT_LEN,
    SECURITY_MAX_CONTEXTS, SECURITY_MAX_CONTEXT_LEN, MAX_SOURCE_IMAGES,
    MAX_HISTORY, MAX_IMAGE_BYTES, MAX_GENERATE_CONTENT
  }
};
