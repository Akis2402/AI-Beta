'use strict';

// ============================================================================================
// PHẦN A + B — NGÂN SÁCH PAYLOAD DÙNG CHUNG (REQUEST & RESPONSE)
// ============================================================================================
// ROOT CAUSE của lớp lỗi "chạy local nhưng 413 trên Vercel": giới hạn kích thước được hard-code
// rải rác ở nhiều nơi (express.json 8mb ở app.js, 5MB ảnh trực tiếp ở validators.js, 3MB base64 ở
// app.js phía client, MAX_VISION_BATCH_PAGES=8 ở validators.js) — mỗi nơi một con số, KHÔNG nơi nào
// tính đúng kích thước THẬT của request đã serialize, và tất cả đều cao hơn trần thật của nền tảng.
//
// Vercel Functions giới hạn body request ~4.5MB VÀ body response ~4.5MB (cùng trần). Base64 làm
// dữ liệu phình ~4/3 lần, cộng thêm contexts/history/metadata trong cùng 1 JSON — nên trần an toàn
// phải tính TRÊN CHUỖI JSON CUỐI CÙNG, không phải trên riêng từng ảnh.
//
// Module này là NGUỒN SỰ THẬT DUY NHẤT cho mọi con số đó. Bản sao phía trình duyệt nằm ở
// public/js/payloadBudget.js và PHẢI khớp từng hằng số — test/payload-budget-parity.test.js so khớp
// 2 file này, build sẽ fail nếu ai đó sửa 1 bên mà quên bên kia.

/** Trần cứng của nền tảng (Vercel Functions, request + response). KHÔNG phải mục tiêu để chạm tới. */
const PLATFORM_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024; // 4_718_592

/**
 * Trần AN TOÀN cho phần thân do ứng dụng kiểm soát. Chừa ~1MB cho: header, SSE framing, phần JSON
 * bao quanh, chênh lệch encoding UTF-8, và sai số của chính phép đo. Có thể hạ (không nâng) bằng env
 * khi chạy sau 1 proxy có trần thấp hơn.
 */
const SAFE_REQUEST_BYTES = clampEnv('PAYLOAD_SAFE_REQUEST_BYTES', 3.5 * 1024 * 1024);
const SAFE_RESPONSE_BYTES = clampEnv('PAYLOAD_SAFE_RESPONSE_BYTES', 3.5 * 1024 * 1024);

/**
 * Trần cho BODY-PARSER (express.json). Cố tình đặt CAO HƠN SAFE_REQUEST_BYTES một khoảng nhỏ: nhờ
 * vậy request vượt ngân sách an toàn vẫn PARSE được và đi tới validator, để client nhận lỗi CÓ CẤU
 * TRÚC (code PAYLOAD_TOO_LARGE + actualSize/safeLimit/suggestedAction) thay vì 413 trần trụi của
 * body-parser không nói được gì. Vượt cả trần này mới bị body-parser chặn (vẫn map về cùng code).
 */
const PARSER_LIMIT_BYTES = Math.min(PLATFORM_BODY_LIMIT_BYTES, Math.round(SAFE_REQUEST_BYTES * 1.2));

/** Ảnh đề bài người dùng gửi trực tiếp (1 ảnh/request). */
const MAX_DIRECT_IMAGE_BYTES = clampEnv('PAYLOAD_MAX_DIRECT_IMAGE_BYTES', 2.5 * 1024 * 1024);
/** 1 trang PDF đã rasterize (client đã downscale + JPEG hoá). */
const MAX_SOURCE_IMAGE_BYTES = clampEnv('PAYLOAD_MAX_SOURCE_IMAGE_BYTES', 1.5 * 1024 * 1024);
/** Tổng các trang nguồn trong 1 request (luôn nhỏ hơn SAFE_REQUEST_BYTES để còn chỗ cho text). */
const MAX_SOURCE_IMAGES_TOTAL_BYTES = clampEnv('PAYLOAD_MAX_SOURCE_IMAGES_TOTAL_BYTES', 2.6 * 1024 * 1024);
/** Số trang nguồn tối đa (trần chống DoS; ràng buộc THẬT là byte ở trên). */
const MAX_SOURCE_IMAGES = 24;
/** Ngân sách cho phần text (query + contexts + history + manifest) của 1 request. */
const MAX_TEXT_PAYLOAD_BYTES = clampEnv('PAYLOAD_MAX_TEXT_BYTES', 700 * 1024);

/** MIME ảnh được chấp nhận — DÙNG CHUNG client/server (PHẦN G). */
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/**
 * MIME ảnh KHÔNG được chấp nhận nhưng client có thể chuyển mã được (PHẦN G/A5): client PHẢI
 * transcode sang PNG/JPEG trước khi gửi; server luôn từ chối RÕ RÀNG, không bao giờ "âm thầm thử".
 */
const TRANSCODE_REQUIRED_IMAGE_TYPES = ['image/bmp', 'image/heic', 'image/heif', 'image/avif', 'image/tiff'];
/** SVG: tuyệt đối không đưa vào vision/image pipeline (là tài liệu XML thực thi được, không phải ảnh raster). */
const REJECTED_IMAGE_TYPES = ['image/svg+xml'];

function clampEnv(name, fallback) {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  // KHÔNG cho phép env nâng vượt trần nền tảng — env sai không được biến thành 413 ở production.
  return Math.min(Math.round(value), PLATFORM_BODY_LIMIT_BYTES);
}

/** Số byte THẬT của 1 chuỗi base64 sau khi giải mã (tính cả padding `=`). */
function base64Bytes(base64) {
  const s = typeof base64 === 'string' ? base64 : '';
  if (!s) return 0;
  const clean = s.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

/** Số byte chuỗi base64 CHIẾM TRONG JSON (đây mới là con số quyết định request có 413 hay không). */
function base64WireBytes(base64) {
  return typeof base64 === 'string' ? base64.length : 0;
}

/**
 * Kích thước THẬT của 1 payload sau khi serialize — đo bằng byte UTF-8 của chính chuỗi JSON sẽ được
 * gửi đi, KHÔNG phải ước lượng `base64.length * 0.75`.
 * @returns {number} byte; -1 nếu không serialize được (vòng lặp tham chiếu...).
 */
function serializedBytes(value) {
  let json;
  try {
    json = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (e) {
    return -1;
  }
  if (typeof json !== 'string') return -1;
  return Buffer.byteLength(json, 'utf8');
}

/** @returns {{ok:boolean, bytes:number, limit:number}} */
function checkRequestBudget(value, limit = SAFE_REQUEST_BYTES) {
  const bytes = serializedBytes(value);
  return { ok: bytes >= 0 && bytes <= limit, bytes, limit };
}

/** @returns {{ok:boolean, bytes:number, limit:number}} */
function checkResponseBudget(value, limit = SAFE_RESPONSE_BYTES) {
  const bytes = serializedBytes(value);
  return { ok: bytes >= 0 && bytes <= limit, bytes, limit };
}

/**
 * Lỗi CÓ CẤU TRÚC cho mọi nơi phát hiện payload vượt ngân sách (PHẦN A8): đủ để client tự giảm tải,
 * KHÔNG lộ chi tiết nội bộ nào (không tên file, không stack, không cấu hình provider).
 */
function payloadTooLargeError({ actualSize, safeLimit, suggestedAction, scope = 'request' }) {
  const err = new Error(`payload_too_large:${scope}`);
  err.status = 413;
  err.code = 'PAYLOAD_TOO_LARGE';
  err.userMessage = 'Yêu cầu quá nặng so với giới hạn của máy chủ. Hãy giảm số trang/ảnh nguồn gửi kèm rồi thử lại.';
  err.payloadInfo = {
    scope,
    actualSize: Math.max(0, Math.round(actualSize || 0)),
    safeLimit: Math.round(safeLimit || SAFE_REQUEST_BYTES),
    suggestedAction: suggestedAction || 'reduce_source_images'
  };
  return err;
}

/**
 * PHẦN D — GOM BATCH THEO BYTE THẬT, không theo số trang cố định.
 * Thêm từng item, serialize lại sau mỗi lần thêm; item nào tự nó vượt ngân sách thì KHÔNG bao giờ
 * bị nhét bừa vào batch (đi vào `oversized` để caller xử lý riêng: nén lại hoặc báo lỗi đúng trang
 * đó) — 1 trang hỏng KHÔNG được làm hỏng cả tài liệu.
 * @param {Array} items
 * @param {{budgetBytes?:number, maxPerBatch?:number, envelopeBytes?:number, sizeOf?:function}} [opts]
 * @returns {{batches:Array<Array>, oversized:Array}}
 */
function planByteBatches(items, opts = {}) {
  const budget = opts.budgetBytes || MAX_SOURCE_IMAGES_TOTAL_BYTES;
  const maxPerBatch = opts.maxPerBatch || MAX_SOURCE_IMAGES;
  const envelope = opts.envelopeBytes || 2048; // chỗ cho phần JSON bao quanh batch
  const sizeOf = opts.sizeOf || ((it) => serializedBytes(it));

  const batches = [];
  const oversized = [];
  let current = [];
  let currentBytes = envelope;

  for (const item of Array.isArray(items) ? items : []) {
    const size = sizeOf(item);
    if (size < 0 || size + envelope > budget) { oversized.push(item); continue; }
    if (current.length && (currentBytes + size > budget || current.length >= maxPerBatch)) {
      batches.push(current);
      current = [];
      currentBytes = envelope;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length) batches.push(current);
  return { batches, oversized };
}

/**
 * PHẦN A6 — cắt danh sách ảnh cho vừa ngân sách byte.
 * KHÁC BẢN CŨ Ở ĐIỂM QUYẾT ĐỊNH: KHÔNG còn luật "luôn giữ ít nhất 1 ảnh dù ảnh đó vượt trần". Ảnh
 * đầu tiên tự nó vượt trần sẽ bị TỪ CHỐI (rơi vào `rejected` kèm lý do) — hàm này KHÔNG BAO GIỜ
 * trả về một mảng đã vượt ngân sách, vì mảng đó chắc chắn tạo ra 413 ở tầng sau.
 * @returns {{kept:Array, rejected:Array<{item:*, reason:string, bytes:number}>, bytes:number}}
 */
function capImagesToByteBudget(images, opts = {}) {
  const totalBudget = opts.totalBytes || MAX_SOURCE_IMAGES_TOTAL_BYTES;
  const perItemBudget = opts.perItemBytes || MAX_SOURCE_IMAGE_BYTES;
  const maxCount = opts.maxCount || MAX_SOURCE_IMAGES;
  const kept = [];
  const rejected = [];
  let total = 0;
  for (const img of Array.isArray(images) ? images : []) {
    const wire = base64WireBytes(img && img.base64);
    const decoded = base64Bytes(img && img.base64);
    if (!wire) { rejected.push({ item: img, reason: 'empty_image', bytes: 0 }); continue; }
    if (decoded > perItemBudget) { rejected.push({ item: img, reason: 'image_too_large', bytes: decoded }); continue; }
    if (kept.length >= maxCount) { rejected.push({ item: img, reason: 'too_many_images', bytes: decoded }); continue; }
    if (total + wire > totalBudget) { rejected.push({ item: img, reason: 'total_budget_exceeded', bytes: decoded }); continue; }
    kept.push(img);
    total += wire;
  }
  return { kept, rejected, bytes: total };
}

module.exports = {
  PLATFORM_BODY_LIMIT_BYTES,
  SAFE_REQUEST_BYTES,
  SAFE_RESPONSE_BYTES,
  PARSER_LIMIT_BYTES,
  MAX_DIRECT_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_BYTES,
  MAX_SOURCE_IMAGES_TOTAL_BYTES,
  MAX_SOURCE_IMAGES,
  MAX_TEXT_PAYLOAD_BYTES,
  ALLOWED_IMAGE_TYPES,
  TRANSCODE_REQUIRED_IMAGE_TYPES,
  REJECTED_IMAGE_TYPES,
  base64Bytes,
  base64WireBytes,
  serializedBytes,
  checkRequestBudget,
  checkResponseBudget,
  payloadTooLargeError,
  planByteBatches,
  capImagesToByteBudget
};
