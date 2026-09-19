'use strict';

/* =====================================================================================
   payloadBudget.js — BẢN SAO PHÍA TRÌNH DUYỆT của server/utils/payloadBudget.js
   -------------------------------------------------------------------------------------
   PHẦN A (P0): trước đây client ước lượng kích thước bằng `base64.length * 0.75` và chỉ giới
   hạn SỐ LƯỢNG ảnh — hai phép đo đều sai so với thứ thực sự bị nền tảng chặn: SỐ BYTE UTF-8
   CỦA CHUỖI JSON CUỐI CÙNG. Base64 nằm trong JSON chiếm ĐÚNG `base64.length` byte (không phải
   0.75 lần), cộng thêm contexts/history/metadata bao quanh.

   File này đo kích thước THẬT (JSON.stringify + TextEncoder) và là nơi DUY NHẤT phía client giữ
   các hằng số ngân sách. Mọi con số PHẢI khớp server/utils/payloadBudget.js —
   test/payload-budget-parity.test.js đối chiếu 2 file, lệch một số là test đỏ.
   ===================================================================================== */

(function (global) {
  var PLATFORM_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;
  var SAFE_REQUEST_BYTES = 3.5 * 1024 * 1024;
  var SAFE_RESPONSE_BYTES = 3.5 * 1024 * 1024;
  var MAX_DIRECT_IMAGE_BYTES = 2.5 * 1024 * 1024;
  var MAX_SOURCE_IMAGE_BYTES = 1.5 * 1024 * 1024;
  var MAX_SOURCE_IMAGES_TOTAL_BYTES = 2.6 * 1024 * 1024;
  var MAX_SOURCE_IMAGES = 24;
  var MAX_TEXT_PAYLOAD_BYTES = 700 * 1024;

  var ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  var TRANSCODE_REQUIRED_IMAGE_TYPES = ['image/bmp', 'image/heic', 'image/heif', 'image/avif', 'image/tiff'];
  var REJECTED_IMAGE_TYPES = ['image/svg+xml'];

  /** Số byte THẬT của chuỗi sau khi encode UTF-8. */
  function utf8Bytes(str) {
    if (typeof str !== 'string') return 0;
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).byteLength;
    return unescape(encodeURIComponent(str)).length; // fallback trình duyệt rất cũ
  }

  /** Kích thước THẬT của request body sau serialize. -1 nếu không serialize được. */
  function serializedBytes(value) {
    var json;
    try { json = typeof value === 'string' ? value : JSON.stringify(value); }
    catch (e) { return -1; }
    if (typeof json !== 'string') return -1;
    return utf8Bytes(json);
  }

  /** Byte THẬT sau giải mã base64 (dung lượng ảnh gốc). */
  function base64Bytes(base64) {
    if (typeof base64 !== 'string' || !base64) return 0;
    var clean = base64.replace(/=+$/, '');
    return Math.floor((clean.length * 3) / 4);
  }

  /** Byte mà chuỗi base64 CHIẾM TRONG JSON — con số quyết định 413. */
  function base64WireBytes(base64) {
    return typeof base64 === 'string' ? base64.length : 0;
  }

  /**
   * PHẦN A6 — cắt cho vừa ngân sách. KHÔNG có ngoại lệ "giữ ít nhất 1 ảnh": ảnh đầu tiên tự nó
   * vượt trần bị TỪ CHỐI kèm lý do, không bao giờ trả ra mảng đã vượt ngân sách.
   */
  function capImagesToByteBudget(images, opts) {
    opts = opts || {};
    var totalBudget = opts.totalBytes || MAX_SOURCE_IMAGES_TOTAL_BYTES;
    var perItemBudget = opts.perItemBytes || MAX_SOURCE_IMAGE_BYTES;
    var maxCount = opts.maxCount || MAX_SOURCE_IMAGES;
    var kept = [], rejected = [], total = 0;
    (images || []).forEach(function (img) {
      var wire = base64WireBytes(img && img.base64);
      var decoded = base64Bytes(img && img.base64);
      if (!wire) { rejected.push({ item: img, reason: 'empty_image', bytes: 0 }); return; }
      if (decoded > perItemBudget) { rejected.push({ item: img, reason: 'image_too_large', bytes: decoded }); return; }
      if (kept.length >= maxCount) { rejected.push({ item: img, reason: 'too_many_images', bytes: decoded }); return; }
      if (total + wire > totalBudget) { rejected.push({ item: img, reason: 'total_budget_exceeded', bytes: decoded }); return; }
      kept.push(img); total += wire;
    });
    return { kept: kept, rejected: rejected, bytes: total };
  }

  /**
   * PHẦN D — gom batch theo BYTE THẬT (thay cho hằng số 8 trang/lần).
   * Trang tự nó vượt ngân sách đi vào `oversized` để caller nén lại hoặc đánh dấu lỗi RIÊNG trang
   * đó — không bao giờ làm hỏng cả tài liệu.
   */
  function planByteBatches(items, opts) {
    opts = opts || {};
    var budget = opts.budgetBytes || MAX_SOURCE_IMAGES_TOTAL_BYTES;
    var maxPerBatch = opts.maxPerBatch || MAX_SOURCE_IMAGES;
    var envelope = opts.envelopeBytes || 2048;
    var sizeOf = opts.sizeOf || serializedBytes;
    var batches = [], oversized = [], current = [], currentBytes = envelope;
    (items || []).forEach(function (item) {
      var size = sizeOf(item);
      if (size < 0 || size + envelope > budget) { oversized.push(item); return; }
      if (current.length && (currentBytes + size > budget || current.length >= maxPerBatch)) {
        batches.push(current); current = []; currentBytes = envelope;
      }
      current.push(item); currentBytes += size;
    });
    if (current.length) batches.push(current);
    return { batches: batches, oversized: oversized };
  }

  /**
   * PHẦN A4 — KIỂM TRA TRƯỚC KHI GỬI. Trả về quyết định rõ ràng thay vì để request chắc chắn 413.
   * @returns {{ok:boolean, bytes:number, limit:number, overBy:number}}
   */
  function checkRequestBudget(body, limit) {
    var max = limit || SAFE_REQUEST_BYTES;
    var bytes = serializedBytes(body);
    return { ok: bytes >= 0 && bytes <= max, bytes: bytes, limit: max, overBy: Math.max(0, bytes - max) };
  }

  /**
   * PHẦN A4/A5 — GIẢM TẢI THEO ƯU TIÊN khi body vượt ngân sách. Thứ tự hy sinh (giữ lại thứ quan
   * trọng nhất cho chất lượng trả lời):
   *   1. ảnh trang nguồn từ CUỐI danh sách (trang gợi ý theo câu hỏi đã được xếp lên đầu);
   *   2. lượt history cũ nhất;
   *   3. context ở cuối danh sách (đã xếp theo độ liên quan giảm dần).
   * Ảnh đề bài người dùng gửi trực tiếp (`image`) và `query` KHÔNG BAO GIỜ bị bỏ — nếu chỉ riêng
   * chúng đã vượt trần thì trả ok:false để UI báo lỗi rõ, không gửi request chắc chắn hỏng.
   * @returns {{ok:boolean, body:object, bytes:number, limit:number, dropped:object, reason?:string}}
   */
  function reduceBodyToBudget(body, limit) {
    var max = limit || SAFE_REQUEST_BYTES;
    var working = Object.assign({}, body || {});
    var dropped = { sourceImages: 0, history: 0, contexts: 0 };
    var check = checkRequestBudget(working, max);
    if (check.ok) return { ok: true, body: working, bytes: check.bytes, limit: max, dropped: dropped };

    while (Array.isArray(working.sourceImages) && working.sourceImages.length) {
      working.sourceImages = working.sourceImages.slice(0, working.sourceImages.length - 1);
      dropped.sourceImages += 1;
      check = checkRequestBudget(working, max);
      if (check.ok) return { ok: true, body: working, bytes: check.bytes, limit: max, dropped: dropped };
    }
    while (Array.isArray(working.history) && working.history.length) {
      working.history = working.history.slice(1);
      dropped.history += 1;
      check = checkRequestBudget(working, max);
      if (check.ok) return { ok: true, body: working, bytes: check.bytes, limit: max, dropped: dropped };
    }
    while (Array.isArray(working.contexts) && working.contexts.length > 1) {
      working.contexts = working.contexts.slice(0, working.contexts.length - 1);
      dropped.contexts += 1;
      check = checkRequestBudget(working, max);
      if (check.ok) return { ok: true, body: working, bytes: check.bytes, limit: max, dropped: dropped };
    }
    return {
      ok: false, body: working, bytes: check.bytes, limit: max, dropped: dropped,
      reason: 'irreducible_payload'
    };
  }

  /** Phân loại MIME ảnh theo đúng chính sách dùng chung client/server (PHẦN G). */
  function classifyImageType(mime) {
    var m = String(mime || '').toLowerCase();
    if (ALLOWED_IMAGE_TYPES.indexOf(m) >= 0) return 'accepted';
    if (REJECTED_IMAGE_TYPES.indexOf(m) >= 0) return 'rejected';
    if (TRANSCODE_REQUIRED_IMAGE_TYPES.indexOf(m) >= 0) return 'transcode_required';
    return 'rejected';
  }

  /**
   * PHẦN A5 — nén/thu nhỏ ảnh NGAY TRONG TRÌNH DUYỆT cho tới khi vừa ngân sách.
   * - Ảnh chụp/scan -> JPEG (giữ chữ/công thức đọc được ở q>=0.6, nhẹ hơn PNG nhiều lần).
   * - PNG có alpha giữ PNG khi vẫn vừa trần; vượt trần thì hạ kích thước rồi mới đổi JPEG.
   * - SVG KHÔNG bao giờ đi vào đây (bị chặn ở classifyImageType).
   * @returns {Promise<{ok:boolean, mediaType?:string, base64?:string, bytes?:number, reason?:string}>}
   */
  function compressImageToBudget(blobOrFile, maxBytes, opts) {
    opts = opts || {};
    var budget = maxBytes || MAX_DIRECT_IMAGE_BYTES;
    var kind = classifyImageType(blobOrFile && blobOrFile.type);
    if (kind === 'rejected') {
      return Promise.resolve({ ok: false, reason: 'unsupported_image_type' });
    }
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blobOrFile);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var maxEdge = opts.maxEdge || 2000;
        var scale = Math.min(1, maxEdge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        var quality = opts.quality || 0.82;
        var attempt = 0;
        var out = null;
        while (attempt < 6) {
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
          canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var dataUrl = canvas.toDataURL('image/jpeg', quality);
          var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          out = { mediaType: 'image/jpeg', base64: base64, bytes: base64Bytes(base64) };
          if (base64WireBytes(base64) <= budget) break;
          // Giảm chất lượng trước (giữ kích thước/độ đọc được), sau đó mới thu nhỏ.
          if (quality > 0.55) quality -= 0.12; else scale *= 0.8;
          attempt += 1;
        }
        if (!out || base64WireBytes(out.base64) > budget) {
          resolve({ ok: false, reason: 'image_irreducible' });
          return;
        }
        resolve({ ok: true, mediaType: out.mediaType, base64: out.base64, bytes: out.bytes });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        // HEIC/HEIF/AVIF/TIFF: trình duyệt không decode được -> nói thẳng, không gửi đi để server từ chối.
        resolve({ ok: false, reason: kind === 'transcode_required' ? 'transcode_required' : 'image_decode_failed' });
      };
      img.src = url;
    });
  }

  global.PayloadBudget = {
    PLATFORM_BODY_LIMIT_BYTES: PLATFORM_BODY_LIMIT_BYTES,
    SAFE_REQUEST_BYTES: SAFE_REQUEST_BYTES,
    SAFE_RESPONSE_BYTES: SAFE_RESPONSE_BYTES,
    MAX_DIRECT_IMAGE_BYTES: MAX_DIRECT_IMAGE_BYTES,
    MAX_SOURCE_IMAGE_BYTES: MAX_SOURCE_IMAGE_BYTES,
    MAX_SOURCE_IMAGES_TOTAL_BYTES: MAX_SOURCE_IMAGES_TOTAL_BYTES,
    MAX_SOURCE_IMAGES: MAX_SOURCE_IMAGES,
    MAX_TEXT_PAYLOAD_BYTES: MAX_TEXT_PAYLOAD_BYTES,
    ALLOWED_IMAGE_TYPES: ALLOWED_IMAGE_TYPES,
    TRANSCODE_REQUIRED_IMAGE_TYPES: TRANSCODE_REQUIRED_IMAGE_TYPES,
    REJECTED_IMAGE_TYPES: REJECTED_IMAGE_TYPES,
    utf8Bytes: utf8Bytes,
    serializedBytes: serializedBytes,
    base64Bytes: base64Bytes,
    base64WireBytes: base64WireBytes,
    capImagesToByteBudget: capImagesToByteBudget,
    planByteBatches: planByteBatches,
    checkRequestBudget: checkRequestBudget,
    reduceBodyToBudget: reduceBodyToBudget,
    classifyImageType: classifyImageType,
    compressImageToBudget: compressImageToBudget
  };
})(typeof window !== 'undefined' ? window : globalThis);
