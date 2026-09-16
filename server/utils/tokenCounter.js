'use strict';

// ============================================================================================
// TOKEN COUNTER TỰ HIỆU CHỈNH (Vấn đề #4)
// ============================================================================================
// VẤN ĐỀ: mọi ước lượng token trong hệ thống dùng hằng số `độ dài / 3.2`. Con số 3.2 là ước lượng
// cho văn bản Latin thông thường và SAI khá xa với thực tế của app này:
//   - Tiếng Việt có dấu: mỗi ký tự có dấu thường tốn nhiều byte/token hơn tiếng Anh → 3.2 ước lượng
//     THIẾU (thực tế ~2.2-2.8 ký tự/token) → maxTokens bị đặt CAO hơn khả năng thật → dễ chạm giới
//     hạn context của model.
//   - LaTeX/JSON/code: dày ký hiệu, tỷ lệ ký tự/token còn thấp hơn nữa.
//   - Mỗi nhà cung cấp dùng tokenizer khác nhau (Claude / GPT / Gemini) → KHÔNG có 1 hằng số nào
//     đúng cho cả ba.
//
// TẠI SAO KHÔNG DÙNG THƯ VIỆN TOKENIZER: `tiktoken` chỉ đúng cho OpenAI; Anthropic và Google không
// công bố tokenizer chạy offline. Thêm 1-2MB dependency để rồi vẫn sai cho 2/3 provider là đánh đổi
// tồi cho 1 app deploy serverless (cold start + bundle size).
//
// CÁCH LÀM Ở ĐÂY — HIỆU CHỈNH TỪ SỐ LIỆU THẬT: mọi provider đều TRẢ VỀ số token thật trong trường
// `usage` của response. Ta đối chiếu (số token thật) với (độ dài ký tự) của chính lượt gọi đó để học
// ra tỷ lệ `charsPerToken` THỰC TẾ cho từng provider, bằng EMA. Không cần dependency, và càng chạy
// càng chính xác — với đúng dữ liệu của người dùng thật, ngôn ngữ thật, loại nội dung thật.
//
// AN TOÀN: khi chưa đủ mẫu (< MIN_SAMPLES), hàm trả về ĐÚNG kết quả cũ (`/3.2`) — nên toàn bộ hành
// vi hiện tại và mọi test hiện có không đổi cho tới khi có số liệu thật.

const DEFAULT_CHARS_PER_TOKEN = 3.2;
// Chặn trên/dưới: tỷ lệ ký tự/token nằm ngoài khoảng này gần như chắc chắn là do đo sai (vd response
// rỗng, hoặc usage đếm cả token của ảnh/tool) — bỏ qua thay vì để nó bóp méo mọi ước lượng sau đó.
const MIN_CHARS_PER_TOKEN = 1.2;
const MAX_CHARS_PER_TOKEN = 6.0;
const EMA_ALPHA = 0.2;
const MIN_SAMPLES = 3;
// Mẫu quá ngắn không đại diện (overhead khung message chiếm tỷ trọng lớn).
const MIN_SAMPLE_CHARS = 200;

// ---------- HIỆU CHỈNH THEO LOẠI NỘI DUNG (sửa tồn đọng #3 của vòng trước) ----------
// Vòng trước chỉ hiệu chỉnh theo provider. Nhưng trong CÙNG 1 provider, tỷ lệ ký tự/token phụ thuộc
// rất mạnh vào LOẠI nội dung:
//   - văn xuôi tiếng Việt : ~2.2-2.8 ký tự/token
//   - LaTeX/code/JSON     : thấp hơn nhiều (dày ký hiệu, mỗi ký hiệu thường là 1 token riêng)
// Gộp cả hai vào 1 EMA làm ước lượng sai cả hai chiều: response nặng công thức bị đánh giá THIẾU
// token (dễ vỡ giới hạn), response văn xuôi bị đánh giá THỪA (cắt sớm không cần thiết).
// Nay khoá hiệu chỉnh là `${provider}::${contentClass}`, có fallback dần: lớp cụ thể -> provider ->
// hằng số mặc định. Nhờ vậy vừa chính xác hơn, vừa không cần chờ đủ mẫu cho mọi lớp mới hoạt động.
const CONTENT_CLASS = Object.freeze({ PROSE: 'prose', SYMBOLIC: 'symbolic', MIXED: 'mixed' });

/**
 * classifyContent() — phân loại 1 đoạn text theo mật độ ký hiệu toán/code.
 * Rẻ (1 lần quét), không phụ thuộc ngôn ngữ.
 * @param {string} str
 * @returns {string} một trong CONTENT_CLASS
 */
function classifyContent(str) {
  const s = String(str || '');
  if (!s) return CONTENT_CLASS.PROSE;
  const sample = s.length > 4000 ? s.slice(0, 4000) : s; // đủ đại diện, không quét cả câu trả lời dài
  const symbols = (sample.match(/[\\{}$_^=<>()[\]|/*+#"']/g) || []).length;
  const density = symbols / sample.length;
  // Ngưỡng lấy từ quan sát thực tế: văn xuôi tiếng Việt ~1-3% ký hiệu; khối LaTeX/JSON thường >12%.
  if (density >= 0.12) return CONTENT_CLASS.SYMBOLIC;
  if (density >= 0.05) return CONTENT_CLASS.MIXED;
  return CONTENT_CLASS.PROSE;
}

const calib = new Map(); // `${providerKey}::${contentClass}` hoặc providerKey -> { emaCharsPerToken, samples }

function clampRatio(r) {
  return Math.max(MIN_CHARS_PER_TOKEN, Math.min(MAX_CHARS_PER_TOKEN, r));
}

/**
 * recordUsage() — nạp 1 mẫu đo THẬT từ response của provider.
 * @param {string} providerKey 'anthropic' | 'openai' | 'gemini' | ...
 * @param {{text?:string, chars?:number, tokens:number}} sample
 *   text/chars: độ dài phần văn bản tương ứng; tokens: số token THẬT provider báo.
 */
function bumpKey(key, ratio) {
  const prev = calib.get(key);
  if (!prev) { calib.set(key, { emaCharsPerToken: ratio, samples: 1 }); return; }
  calib.set(key, {
    emaCharsPerToken: prev.emaCharsPerToken * (1 - EMA_ALPHA) + ratio * EMA_ALPHA,
    samples: prev.samples + 1
  });
}

function recordUsage(providerKey, { text, chars, tokens, contentClass } = {}) {
  if (!providerKey) return;
  const n = Number.isFinite(chars) ? chars : String(text || '').length;
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return;
  if (n < MIN_SAMPLE_CHARS) return;
  const ratio = clampRatio(n / t);
  // Ghi vào CẢ HAI mức: lớp nội dung cụ thể (chính xác) và mức provider (fallback khi lớp đó chưa đủ
  // mẫu). Nếu chỉ ghi mức lớp, mọi lớp mới đều phải học lại từ đầu; nếu chỉ ghi mức provider thì mất
  // đúng cái độ chính xác mà thay đổi này nhắm tới.
  const cls = contentClass || (text != null ? classifyContent(text) : null);
  if (cls) bumpKey(`${providerKey}::${cls}`, ratio);
  bumpKey(providerKey, ratio);
}

/**
 * charsPerToken() — tỷ lệ hiệu chỉnh cho 1 provider; mặc định 3.2 khi chưa đủ mẫu.
 */
function charsPerToken(providerKey, contentClass) {
  if (providerKey && contentClass) {
    const specific = calib.get(`${providerKey}::${contentClass}`);
    if (specific && specific.samples >= MIN_SAMPLES) return clampRatio(specific.emaCharsPerToken);
  }
  const c = providerKey && calib.get(providerKey);
  if (c && c.samples >= MIN_SAMPLES) return clampRatio(c.emaCharsPerToken);
  return DEFAULT_CHARS_PER_TOKEN;
}

/**
 * countTokens() — ước lượng token cho 1 đoạn text.
 * @param {string} str
 * @param {{provider?:string}} [opts] Không truyền provider -> dùng tỷ lệ mặc định (hành vi cũ y hệt).
 * @returns {number}
 */
function countTokens(str, opts = {}) {
  if (!str) return 0;
  const text = String(str);
  // Chỉ phân loại khi đã có provider (không có provider thì mọi mức đều rơi về hằng số mặc định,
  // phân loại chỉ tốn CPU vô ích).
  const cls = opts.provider ? (opts.contentClass || classifyContent(text)) : null;
  return Math.ceil(text.length / charsPerToken(opts.provider, cls));
}

/** Snapshot cho telemetry — không chứa nội dung hay khóa. */
function snapshot() {
  const out = {};
  calib.forEach((v, k) => {
    out[k] = { charsPerToken: Number(v.emaCharsPerToken.toFixed(2)), samples: v.samples };
  });
  return out;
}

/**
 * applySnapshot() — MERGE dữ liệu hiệu chỉnh từ instance khác (sửa tồn đọng #4 của vòng trước:
 * calibration là in-memory per-instance nên mỗi instance mới/cold start lại phải "học lại" bằng 3
 * request đầu tiên, tức 3 request đầu của mỗi instance luôn dùng hằng số 3.2 thiếu chính xác).
 *
 * Merge có chủ đích: lấy bên nào có NHIỀU MẪU HƠN (tin cậy hơn) thay vì trung bình mù — trung bình
 * giữa 1 mẫu nhiễu và 200 mẫu ổn định sẽ làm hỏng cái ổn định.
 */
function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  Object.entries(snap).forEach(([k, v]) => {
    const ratio = Number(v && v.charsPerToken);
    const samples = Number(v && v.samples);
    if (!Number.isFinite(ratio) || !Number.isFinite(samples) || samples <= 0) return;
    const cur = calib.get(k);
    if (!cur || samples > cur.samples) {
      calib.set(k, { emaCharsPerToken: clampRatio(ratio), samples });
    }
  });
}

function _resetForTest() { calib.clear(); }

module.exports = {
  recordUsage, charsPerToken, countTokens, snapshot, applySnapshot, _resetForTest,
  classifyContent, CONTENT_CLASS,
  DEFAULT_CHARS_PER_TOKEN, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN, MIN_SAMPLES
};
