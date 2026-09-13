'use strict';

// ============================================================================================
// VALIDATOR NHỊ PHÂN DÙNG CHUNG CHO TOÀN BỘ IMAGE PIPELINE
// ============================================================================================
// ROOT CAUSE (đợt audit 2) — verifyImageBytes() bản cũ có nhánh THOÁT HIỂM nguy hiểm:
//
//   const real = detectImageSignature(b64);
//   if (real) return real;
//   return claimedMime && /^image\//i.test(claimedMime) ? claimedMime : null;   // <-- BUG
//
// Khi KHÔNG nhận diện được magic bytes (binary lạ/hỏng/rác), hàm cũ vẫn PASS nếu provider tự xưng
// `mimeType: "image/png"` — nhưng đó CHÍNH LÀ trường hợp nguy hiểm nhất: provider có thể nhét bất
// cứ gì (kể cả text lỗi bị encode base64 tình cờ khớp bảng ký tự) vào field ảnh kèm nhãn mime giả.
// "Có nhãn mime" không phải bằng chứng — CHỈ magic bytes mới là bằng chứng không giả mạo được.
//
// QUY TẮC MỚI, TUYỆT ĐỐI, ÁP DỤNG Ở MỌI ĐIỂM VÀO CỦA HỆ THỐNG:
//   - Nhận diện được chữ ký nhị phân (PNG/JPEG/WEBP/GIF) -> valid=true, detectedMime = CHỮ KÝ THẬT
//     (không phải nhãn provider tự xưng — kể cả khi 2 giá trị khác nhau, chữ ký thật luôn thắng).
//   - KHÔNG nhận diện được chữ ký -> valid=false, BẤT KỂ claimedMime nói gì. Không có ngoại lệ.
//
// Dùng CHUNG bởi: imageGenerationClient.js (ngay sau khi provider trả base64),
// server/routes/visual.js (/download, /retry, /hq), scripts/live-image-check.js.
// Chỉ có ĐÚNG 1 bảng magic-bytes, ĐÚNG 1 hàm quyết định valid/invalid trong toàn bộ codebase.

const MAGIC_SIGNATURES = [
  { mime: 'image/png', format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', format: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  // WEBP: 'RIFF' ở byte 0-3, kích thước 4 byte, rồi 'WEBP' ở byte 8-11 — phải kiểm cả hai đoạn để
  // không nhận nhầm file RIFF khác (WAV/AVI) là ảnh.
  { mime: 'image/webp', format: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], webp: true }
];

/**
 * detectSignatureFromBuffer() — so khớp magic bytes THẬT trên một Buffer đã decode sẵn.
 * @param {Buffer} buf
 * @returns {{mime:string, format:string}|null}
 */
function detectSignatureFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  for (const sig of MAGIC_SIGNATURES) {
    const matches = sig.bytes.every((byte, i) => buf[i] === byte);
    if (!matches) continue;
    if (sig.webp) {
      if (buf.length < 12 || buf.toString('ascii', 8, 12) !== 'WEBP') continue;
    }
    return { mime: sig.mime, format: sig.format };
  }
  return null;
}

/**
 * validateImageBuffer() — HÀM DUY NHẤT quyết định một Buffer có phải ảnh thật hay không.
 * KHÔNG BAO GIỜ tin claimedMime khi chữ ký byte không khớp — kể cả khi claimedMime trông hợp lệ.
 *
 * @param {Buffer} buffer Binary ĐÃ DECODE (không phải base64/data URL).
 * @param {string} [claimedMime] Nhãn mime provider/response header tự khai — chỉ dùng để LOG đối
 *   chiếu khi có sai lệch, không bao giờ dùng để quyết định valid=true.
 * @returns {{valid:true, detectedMime:string, format:string, bytes:number, mimeMismatch:boolean}
 *   | {valid:false, reason:string, bytes:number}}
 */
function validateImageBuffer(buffer, claimedMime) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from([]);
  if (!buf.length) return { valid: false, reason: 'empty_body', bytes: 0 };

  const sig = detectSignatureFromBuffer(buf);
  if (!sig) {
    // Không có chữ ký nhị phân nào khớp -> FAIL VÔ ĐIỀU KIỆN, không xét claimedMime (mục 1 yêu cầu
    // đợt audit 2: "unknown binary + claimedMime=image/png => FAIL").
    return { valid: false, reason: 'invalid_magic_bytes', bytes: buf.length };
  }

  const claimed = String(claimedMime || '').toLowerCase().split(';')[0].trim();
  const mimeMismatch = !!claimed && claimed !== sig.mime;
  // claimedMime='image/png' nhưng binary thật là JPEG -> KHÔNG coi là PNG. detectedMime luôn là
  // chữ ký thật; caller (imageGenerationClient/routes) tự quyết định normalize hay từ chối.
  return { valid: true, detectedMime: sig.mime, format: sig.format, bytes: buf.length, mimeMismatch };
}

/**
 * validateImageBase64() — tiện ích cho đường base64 (Gemini inlineData, OpenAI b64_json...).
 * @param {string} b64
 * @param {string} [claimedMime]
 */
function validateImageBase64(b64, claimedMime) {
  let buf;
  try {
    if (typeof b64 !== 'string' || b64.length < 4) return { valid: false, reason: 'not_base64', bytes: 0 };
    // Bảng ký tự base64 hợp lệ trước khi decode — chuỗi rác/prose (có khoảng trắng, dấu tiếng Việt)
    // không được đưa vào Buffer.from (Node âm thầm bỏ ký tự lạ thay vì lỗi, dễ đọc nhầm là "decode
    // được" trong khi thực ra chỉ decode được một phần rác).
    if (!/^[A-Za-z0-9+/\r\n=]+$/.test(b64.slice(0, 512))) return { valid: false, reason: 'not_base64', bytes: 0 };
    buf = Buffer.from(b64, 'base64');
  } catch (e) {
    return { valid: false, reason: 'base64_decode_error', bytes: 0 };
  }
  return validateImageBuffer(buf, claimedMime);
}

module.exports = {
  MAGIC_SIGNATURES, detectSignatureFromBuffer, validateImageBuffer, validateImageBase64
};
