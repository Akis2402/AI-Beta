'use strict';

// ============================================================================================
// PHẦN H + I — CHUẨN HOÁ QUERY VÀ FINGERPRINT
// ============================================================================================
// Mục tiêu: nhiều câu hỏi TƯƠNG ĐƯƠNG phải cho cùng một khoá cache/retrieval, nhưng hai câu hỏi
// KHÁC NGHĨA thì tuyệt đối không được trùng khoá. Vì vậy normalize chỉ động vào phần KHÔNG mang
// nghĩa (khoảng trắng, dấu câu thừa, biến thể cách viết số bài, biến thể URL) — không đụng tới từ.

const crypto = require('crypto');

/** Bỏ dấu tiếng Việt CHỈ để so khớp (không dùng để hiển thị hay gửi cho model). */
function deaccent(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/** Chuẩn hoá URL: bỏ tracking param, bỏ fragment, hạ host về chữ thường, bỏ '/' cuối. */
function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return ''; }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  const drop = /^(utm_|fbclid|gclid|igshid|mc_eid|ref|ref_src|si$|feature$)/i;
  [...u.searchParams.keys()].forEach((k) => { if (drop.test(k)) u.searchParams.delete(k); });
  // '/a/' và '/a' là cùng một trang -> cùng một khoá cache; '/' gốc thì giữ nguyên.
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/**
 * Chuẩn hoá cách viết số bài/trang: "Bài  1.9", "bài1.9", "bai 1 . 9" -> "bài 1.9".
 * Giữ nguyên CON SỐ — chỉ chuẩn hoá cách viết xung quanh nó.
 */
function normalizeItemNotation(s) {
  return String(s || '')
    .replace(/\b(bài|bai|câu|cau|trang|page|ex|exercise|problem)\s*\.?\s*(\d+)\s*\.\s*(\d+)/gi, '$1 $2.$3')
    .replace(/\b(bài|bai|câu|cau|trang|page|ex|exercise|problem)\s*\.?\s*(\d+)/gi, '$1 $2');
}

/**
 * normalizeQuery() — dạng chuẩn dùng cho cache key/retrieval key.
 * KHÔNG dùng để gửi cho model (model vẫn nhận nguyên văn câu hỏi của người dùng).
 */
function normalizeQuery(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/\s+/g, ' ').trim();
  s = normalizeItemNotation(s);
  // URL trong câu hỏi được chuẩn hoá tại chỗ để "cùng một link" không tạo 2 khoá khác nhau.
  // Sau đó URL được GIỮ NGUYÊN qua bước chuẩn hoá dấu câu — nếu không, dấu ':' trong "https://" sẽ
  // bị tách thành "https: //" và mọi URL trở thành một khoá khác nhau.
  const urlSlots = [];
  s = s.replace(/https?:\/\/\S+/gi, (m) => {
    urlSlots.push(normalizeUrl(m) || m);
    return `\u0000U${urlSlots.length - 1}\u0000`;
  });
  s = s.replace(/[ \t]*([,;:!?])[ \t]*/g, '$1 ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\u0000U(\d+)\u0000/g, (m, i) => urlSlots[Number(i)]);
  s = s.replace(/[.\s]+$/g, '');
  return deaccent(s).toLowerCase();
}

function sha(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

/**
 * PHẦN I — queryFingerprint: CHỈ gồm thứ THỰC SỰ ảnh hưởng kết quả.
 * Cố ý KHÔNG đưa vào: requestId, thời gian, thứ tự nguồn không dùng, telemetry, ids nội bộ
 * (PHẦN DU: những thứ đó làm hỏng prompt cache và làm cache key luôn miss).
 */
function buildQueryFingerprint({
  query, subject, language, sourceVersion, sourceSelection,
  imageFingerprints, visualSpec, promptVersion, stage
} = {}) {
  return sha({
    q: normalizeQuery(query),
    subject: subject || '',
    lang: language || '',
    sourceVersion: sourceVersion || '',
    sources: [...(sourceSelection || [])].sort(),
    images: [...(imageFingerprints || [])].sort(),
    visual: visualSpec || '',
    prompt: promptVersion || '',
    stage: stage || ''
  });
}

/** Fingerprint nội dung nhị phân/chuỗi bất kỳ (ảnh, transcript, HTML đã trích). */
function contentFingerprint(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
}

module.exports = { normalizeQuery, normalizeUrl, normalizeItemNotation, deaccent, buildQueryFingerprint, contentFingerprint, sha };
