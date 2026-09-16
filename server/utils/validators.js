'use strict';

// PHẦN A/G: mọi ngưỡng kích thước & chính sách MIME ảnh đến từ MỘT nguồn duy nhất dùng chung với
// client (public/js/payloadBudget.js) — không còn con số hard-code rải rác ở đây.
const budget = require('./payloadBudget');

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
const MAX_IMAGE_BYTES = budget.MAX_DIRECT_IMAGE_BYTES; // PHẦN A: 5MB cũ chắc chắn 413 trên Vercel
const MAX_SOURCE_MANIFEST_LEN = 4000; // mục A3: manifest chỉ là vài dòng thống kê nhẹ, không phải nội dung
// PDF chỉ chứa ảnh scan (không trích được text): client rasterize từng trang thành ảnh và gửi kèm
// làm "nguồn" cho model đọc trực tiếp bằng vision, thay vì trích dẫn theo đoạn text như PDF thường.
// PHẦN A10/A8: trước đây 6 — cùng gốc với PDF_MAX_RASTER_PAGES ở client, ROOT CAUSE thứ hai của "PDF
// scan bị cụt". Nay client tự chọn trang liên quan nhất cho 1 lượt hỏi (xem collectSourceImages() ở
// app.js) trong trần này — nâng trần lên đủ rộng để 1 câu hỏi có thể kéo nhiều trang khi cần (vd hỏi
// "trang 12 đến 20") mà vẫn chặn được 1 request cố tình nhồi hàng trăm ảnh.
const MAX_SOURCE_IMAGES = budget.MAX_SOURCE_IMAGES;
const MAX_SOURCE_IMAGE_BYTES = budget.MAX_SOURCE_IMAGE_BYTES; // trần/trang, dùng chung với client
// PROMPT V5 — PHẦN Y/AC: MULTI-IMAGE INPUT. `image` (số ít) là ảnh đề bài, giữ NGUYÊN cho tương
// thích ngược (client cũ/gọi API trực tiếp chỉ biết field này). `images[]` là danh sách bổ sung —
// server GỘP cả hai thành đúng MỘT danh sách `images` (PHẦN AC: "không duplicate image + images"),
// với `image` luôn là phần tử đầu tiên khi có mặt. Không throw cứng cho từng ảnh lẻ trong mảng — ảnh
// hỏng bị TỪ CHỐI CÓ KHAI BÁO (PHẦN CX) và trả về trong `imagesRejected`, các ảnh còn lại vẫn dùng
// được thay vì làm hỏng cả request (khác với `image` số ít, vẫn throw để giữ hành vi cũ nguyên vẹn).
const MAX_USER_IMAGES = 8;
const MAX_APPROACH_LEN = 3000;
const ALLOWED_STAGES = ['approach', 'detail'];
// PHẦN 27: chế độ hình minh hoạ do người dùng chọn (đi vào cache key — xem routes/chat.js).
const ALLOWED_VISUAL_MODES = ['auto', 'always', 'never'];

const ALLOWED_IMAGE_TYPES = budget.ALLOWED_IMAGE_TYPES; // PHẦN G: 1 danh sách duy nhất client/server
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
function classifySourceImage(img, index) {
  const mediaType = String((img && img.mediaType) || '');
  const base64 = img && img.base64;
  const page = Number.isFinite(Number(img && img.page)) ? Number(img.page) : null;
  const doc = clip(String((img && img.doc) || ''), MAX_DOC_NAME);
  const reject = (reason) => ({ ok: false, index, page, doc, reason });

  if (budget.REJECTED_IMAGE_TYPES.includes(mediaType)) return reject('image_type_rejected');
  if (budget.TRANSCODE_REQUIRED_IMAGE_TYPES.includes(mediaType)) return reject('image_type_needs_transcode');
  if (!ALLOWED_IMAGE_TYPES.includes(mediaType)) return reject('image_type_unsupported');
  if (typeof base64 !== 'string' || base64.length === 0) return reject('image_empty');
  if (!BASE64_RE.test(base64)) return reject('image_base64_malformed');

  const decodedBytes = budget.base64Bytes(base64);
  if (decodedBytes > MAX_SOURCE_IMAGE_BYTES) return reject('image_too_large');
  // PHẦN G: KHÔNG tin nhãn mediaType do client khai — đọc magic bytes thật. Nhãn sai = từ chối RÕ
  // RÀNG, không bao giờ đẩy một binary lạ vào pipeline vision.
  const head = Buffer.from(base64.slice(0, 64), 'base64');
  const sniffed = sniffImageMime(head);
  if (!sniffed) return reject('image_bytes_not_an_image');
  if (sniffed !== mediaType) return reject('image_mime_mismatch');

  return { ok: true, index, page, doc, bytes: decodedBytes, image: { mediaType, base64, doc, page } };
}

/** Magic bytes -> MIME thật. Không có thư viện ảnh nào trong dependencies, đây là kiểm tra chữ ký
 * cơ bản dùng chung với server/utils/visual/imageBinaryValidator.js (cùng bảng chữ ký). */
function sniffImageMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * PHẦN E — KHÔNG ÂM THẦM BỎ TRANG NGUỒN.
 * Bản cũ dùng `.map(...).filter(Boolean)`: trang sai MIME / base64 hỏng / quá nặng biến mất KHÔNG
 * DẤU VẾT, người dùng vẫn tin "AI đã đọc toàn bộ PDF". NAY trả về CẢ HAI danh sách; mọi route gọi
 * hàm này PHẢI chuyển `rejected` xuống client (xem routes/chat.js, routes/sourceVision.js).
 * @returns {{accepted:Array, rejected:Array<{index:number,page:number|null,doc:string,reason:string}>, bytes:number}}
 */
function parseSourceImagesDetailed(body) {
  const raw = Array.isArray(body && body.sourceImages) ? body.sourceImages : [];
  const accepted = [];
  const rejected = [];
  let bytes = 0;
  raw.forEach((img, i) => {
    if (accepted.length >= MAX_SOURCE_IMAGES) {
      rejected.push({ index: i, page: Number.isFinite(Number(img && img.page)) ? Number(img.page) : null, doc: '', reason: 'too_many_images' });
      return;
    }
    const verdict = classifySourceImage(img, i);
    if (!verdict.ok) { rejected.push({ index: verdict.index, page: verdict.page, doc: verdict.doc, reason: verdict.reason }); return; }
    const wire = budget.base64WireBytes(verdict.image.base64);
    if (bytes + wire > budget.MAX_SOURCE_IMAGES_TOTAL_BYTES) {
      rejected.push({ index: verdict.index, page: verdict.page, doc: verdict.doc, reason: 'total_budget_exceeded' });
      return;
    }
    accepted.push(verdict.image);
    bytes += wire;
  });
  return { accepted, rejected, bytes };
}

/** Tương thích ngược cho call-site chỉ cần danh sách hợp lệ (KHÔNG dùng ở route mới — route phải
 * báo `rejected` cho client). */
function parseSourceImages(body) {
  return parseSourceImagesDetailed(body).accepted;
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

/**
 * PHẦN A7/A8 — cùng một chính sách với client, lỗi CÓ CẤU TRÚC khi vượt.
 * Đo trên chính object đã sanitize (thứ server sẽ thật sự xử lý), không đo trên body thô: nếu
 * request thô lớn hơn mà phần hợp lệ đã nằm trong ngân sách thì không có lý do gì để từ chối.
 */
function assertWithinRequestBudget(sanitized) {
  const check = budget.checkRequestBudget(sanitized);
  if (check.ok) return;
  throw budget.payloadTooLargeError({
    actualSize: check.bytes,
    safeLimit: check.limit,
    suggestedAction: 'reduce_source_images_or_contexts',
    scope: 'request'
  });
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
    // PHẦN A/G: cùng một bộ luật với ảnh trang nguồn — MIME allow-list, base64 đúng bảng chữ cái,
    // magic bytes khớp nhãn, dung lượng tính THẬT (không phải `length * 0.75`).
    const verdict = classifySourceImage({ ...body.image, page: null, doc: '' }, -1);
    if (!verdict.ok) {
      const messages = {
        image_type_rejected: 'Ảnh SVG không được chấp nhận. Hãy chuyển sang PNG/JPEG trước khi gửi.',
        image_type_needs_transcode: 'Định dạng ảnh này (HEIC/HEIF/BMP/TIFF/AVIF) cần được chuyển sang PNG/JPEG trước khi gửi.',
        image_type_unsupported: 'Định dạng ảnh không được hỗ trợ (chỉ nhận PNG/JPEG/WEBP/GIF).',
        image_empty: 'Dữ liệu ảnh không hợp lệ.',
        image_base64_malformed: 'Dữ liệu ảnh không hợp lệ (base64 hỏng).',
        image_bytes_not_an_image: 'Tệp gửi lên không phải ảnh thật.',
        image_mime_mismatch: 'Định dạng ảnh khai báo không khớp với nội dung tệp.',
        image_too_large: `Ảnh vượt quá dung lượng cho phép (tối đa ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024) * 10) / 10}MB).`
      };
      throw new ValidationError(messages[verdict.reason] || 'Dữ liệu ảnh không hợp lệ.');
    }
    if (verdict.bytes > MAX_IMAGE_BYTES) {
      throw new ValidationError(`Ảnh vượt quá dung lượng cho phép (tối đa ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024) * 10) / 10}MB).`);
    }
    image = { mediaType: verdict.image.mediaType, base64: verdict.image.base64 };
  }

  // PHẦN Y/AC — ảnh bổ sung ngoài `image` số ít. Mỗi ảnh đi qua đúng luật MIME/base64/magic-bytes/
  // dung lượng như `image` (KHÔNG nới lỏng chỉ vì đứng trong mảng), nhưng lỗi từng ảnh không làm
  // hỏng cả request — chỉ ảnh đó bị loại, có lý do, người dùng vẫn dùng được các ảnh hợp lệ còn lại.
  const imagesRejected = [];
  const extraAccepted = [];
  const extraRaw = Array.isArray(body.images) ? body.images : [];
  extraRaw.forEach((img, i) => {
    if ((image ? 1 : 0) + extraAccepted.length >= MAX_USER_IMAGES) {
      imagesRejected.push({ index: i, reason: 'too_many_images' });
      return;
    }
    const verdict = classifySourceImage({ ...img, page: null, doc: '' }, i);
    if (!verdict.ok) { imagesRejected.push({ index: i, reason: verdict.reason }); return; }
    if (verdict.bytes > MAX_IMAGE_BYTES) { imagesRejected.push({ index: i, reason: 'image_too_large' }); return; }
    extraAccepted.push({ mediaType: verdict.image.mediaType, base64: verdict.image.base64 });
  });
  // PHẦN AC: server normalize thành MỘT danh sách duy nhất, `image` (nếu có) luôn ở vị trí đầu —
  // giữ đúng thứ tự người dùng đính kèm (PHẦN X) và tránh gửi trùng cùng một ảnh hai lần.
  const images = image ? [image, ...extraAccepted] : extraAccepted;
  // Tương thích ngược: nếu client CHỈ gửi `images[]` (chưa có `image` số ít), code cũ đọc `input.image`
  // vẫn phải thấy đúng ảnh đầu tiên — PHẦN AB: "imageId = first attachment nếu cần".
  if (!image && images.length) image = images[0];

  if (!query && !images.length) {
    throw new ValidationError('Vui lòng nhập câu hỏi hoặc đính kèm ảnh.');
  }

  // sourceImages: ảnh các trang PDF-chỉ-ảnh (scan), KHÁC với `image` (ảnh đề bài người dùng chụp/dán
  // trực tiếp) — validate qua parseSourceImages() dùng chung với /api/generate/*.
  const sourceImagesResult = parseSourceImagesDetailed(body);
  const sourceImages = sourceImagesResult.accepted;
  // PHẦN E: trang bị loại PHẢI đi ngược về client (route gắn vào response/SSE) — không bao giờ để
  // người dùng tin rằng AI đã đọc những trang thực tế đã bị bỏ.
  const sourceImagesRejected = sourceImagesResult.rejected;

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

  const result = { query, deepThinking, crossCheck, image, images, imagesRejected, sourceImages, sourceImagesRejected, rules, contexts, sourceManifest, sourceStatus, historyTurnsRaw, requirementLabels, unmatchedRequirementLabels, settings, history, stage, approachText };
  // PHẦN A7: server dùng ĐÚNG chính sách mà client đã dùng để tự kiểm trước khi gửi. Nếu tới đây vẫn
  // vượt ngân sách (client cũ chưa cập nhật, hoặc gọi API trực tiếp) -> lỗi CÓ CẤU TRÚC, KHÔNG âm
  // thầm cắt bớt dữ liệu rồi trả lời như thể đã đọc đủ.
  assertWithinRequestBudget(result);
  return result;
}

/** Validate body của các endpoint /api/generate/* (flashcards + mindmap dùng chung) */
function validateGenerateBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const content = clip(String(body.content || '').trim(), MAX_GENERATE_CONTENT);
  const { accepted: sourceImages, rejected: sourceImagesRejected } = parseSourceImagesDetailed(body);
  if (!content && !sourceImages.length) throw new ValidationError('Thiếu nội dung để tạo slide/flashcard/mindmap.');
  const out = { content, sourceImages, sourceImagesRejected };
  assertWithinRequestBudget(out);
  return out;
}

/** Validate body của POST /api/generate/outline (đề cương .docx) */
function validateOutlineBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const content = clip(String(body.content || '').trim(), MAX_GENERATE_CONTENT);
  const { accepted: sourceImages, rejected: sourceImagesRejected } = parseSourceImagesDetailed(body);
  if (!content && !sourceImages.length) throw new ValidationError('Thiếu nội dung để tạo đề cương.');
  const includeExercises = body.includeExercises === true;
  const out = { content, sourceImages, sourceImagesRejected, includeExercises };
  assertWithinRequestBudget(out);
  return out;
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
// PHẦN D — KHÔNG còn hằng số "8 trang/lần". 8 trang ảnh scan chữ dày đặc vẫn có thể vượt trần
// payload; 8 trang ảnh nhẹ lại lãng phí lượt gọi. Ràng buộc THẬT là BYTE: batch được chấp nhận khi
// tổng serialized nằm dưới ngân sách an toàn. MAX_VISION_BATCH_PAGES chỉ còn là trần chống DoS.
const MAX_VISION_BATCH_PAGES = budget.MAX_SOURCE_IMAGES;
function validateSourceVisionBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const { accepted, rejected } = parseSourceImagesDetailed({ sourceImages: body.pages });
  const pages = accepted.slice(0, MAX_VISION_BATCH_PAGES);
  accepted.slice(MAX_VISION_BATCH_PAGES).forEach((img, i) => {
    rejected.push({ index: MAX_VISION_BATCH_PAGES + i, page: img.page, doc: img.doc, reason: 'too_many_images' });
  });
  // PHẦN E: batch KHÔNG còn "im lặng bỏ trang" — chỉ lỗi khi KHÔNG CÒN trang nào dùng được, và khi
  // đó nói rõ từng trang hỏng vì lý do gì (client đánh dấu đúng trang đó là failed, không retry mù).
  if (!pages.length) {
    const err = new ValidationError('Không có trang ảnh hợp lệ nào để xử lý.');
    err.rejected = rejected;
    throw err;
  }
  assertWithinRequestBudget({ pages });
  return { pages, rejected };
}

// PHẦN AK/AO — /api/source/web và /api/source/youtube: client chỉ gửi 1 URL, mọi validate nội dung
// (SSRF, protocol, transcript...) nằm bên trong webSource.js/youtubeSource.js — tầng này chỉ chặn
// input rác/quá dài trước khi tốn 1 lệnh gọi mạng.
const MAX_SOURCE_URL_LEN = 2000;
function validateSourceUrlBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Yêu cầu không hợp lệ.');
  const url = clip(String(body.url || '').trim(), MAX_SOURCE_URL_LEN);
  if (!url) throw new ValidationError('Thiếu URL.');
  return { url };
}

module.exports = {
  ValidationError,
  validateChatBody,
  validateGenerateBody,
  validateOutlineBody,
  validateSelfCheckBody,
  validateSimilarBody,
  validateSourceVisionBody,
  validateSourceUrlBody,
  parseSourceImagesDetailed,
  assertWithinRequestBudget,
  normalizeRules,
  normalizeDetail,
  SCHOOL_GRADES,
  ALLOWED_DETAIL,
  LIMITS: {
    MAX_QUERY, MAX_RULE_LEN, MAX_RULES, MAX_CONTEXTS, MAX_CONTEXT_LEN,
    SECURITY_MAX_CONTEXTS, SECURITY_MAX_CONTEXT_LEN, MAX_SOURCE_IMAGES,
    MAX_HISTORY, MAX_IMAGE_BYTES, MAX_GENERATE_CONTENT, MAX_USER_IMAGES,
    MAX_SOURCE_IMAGE_BYTES, MAX_VISION_BATCH_PAGES,
    SAFE_REQUEST_BYTES: budget.SAFE_REQUEST_BYTES,
    SAFE_RESPONSE_BYTES: budget.SAFE_RESPONSE_BYTES
  }
};
