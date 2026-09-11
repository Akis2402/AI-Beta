'use strict';

// ---------- FINISH REASON NORMALIZATION (mục 1/2 — completion-first) ----------
// TRƯỚC ĐÂY không client nào đọc/forward finish_reason/stop_reason của provider — completenessCheck
// chỉ đoán mò response có "trông" hoàn chỉnh hay không dựa trên HEURISTIC HÌNH THỨC (ký tự cuối, có
// từ khoá "vậy/kết luận"...). Hệ quả: model CHỦ ĐỘNG kết thúc đúng ý (stop_reason='end_turn') vẫn có
// thể bị coi là INCOMPLETE chỉ vì không dùng đúng từ khoá kết luận quen thuộc — sai hoàn toàn về bản
// chất: provider đã xác nhận đây là điểm dừng tự nhiên của model, không phải bị cắt giữa chừng.
//
// Mỗi provider có tên field/giá trị khác nhau cho cùng 1 khái niệm:
//   Anthropic:  data.stop_reason        'end_turn' | 'stop_sequence' | 'max_tokens' | 'tool_use'
//   OpenAI(Responses): data.status      'completed' | 'incomplete' (+ incomplete_details.reason)
//   Gemini:     candidate.finishReason  'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | ...
//   OpenAI-compatible (Chat Completions): choices[0].finish_reason  'stop' | 'length' | 'content_filter' | 'tool_calls'
//
// normalizeFinishReason() gộp tất cả về đúng 3 giá trị mà completenessCheck/continuation thực sự cần
// phân biệt: 'stop' (model chủ động kết thúc — tín hiệu completion-first mạnh nhất), 'length' (bị cắt
// vì hết max_tokens/max_output_tokens — tín hiệu HARD_INCOMPLETE chắc chắn), 'other' (lý do khác:
// tool_use, safety filter, recitation... không phải "kết thúc thành công" cũng không hẳn là truncation
// do hết token, coi thận trọng là không xác định).

/**
 * @param {string|null|undefined} raw Giá trị thô lấy trực tiếp từ response provider.
 * @returns {'stop'|'length'|'other'|null} null nếu provider không trả field này (client cũ/lỗi
 *   parse) — completenessCheck khi đó KHÔNG được giả định 'stop' (an toàn: heuristic vẫn chạy như cũ).
 */
function normalizeFinishReason(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === 'end_turn' || s === 'stop' || s === 'stop_sequence' || s === 'completed') return 'stop';
  if (s === 'max_tokens' || s === 'length' || s === 'max_output_tokens') return 'length';
  return 'other';
}

/**
 * OpenAI Responses API dùng cấu trúc {status, incomplete_details:{reason}} thay vì 1 field đơn —
 * cần gộp lại trước khi normalize.
 * @param {{status?:string, incomplete_details?:{reason?:string}}} data
 */
function finishReasonFromResponsesApi(data) {
  if (!data) return null;
  if (data.status === 'completed') return 'stop';
  if (data.status === 'incomplete') {
    const reason = data.incomplete_details && data.incomplete_details.reason;
    return reason === 'max_output_tokens' ? 'length' : 'other';
  }
  return null;
}

module.exports = { normalizeFinishReason, finishReasonFromResponsesApi };

// ============================================================================================
// PHẦN 5 (spec mới) — FINISH REASON PHẢI PHẢN ÁNH NGUYÊN NHÂN THẬT
// ============================================================================================
// normalizeFinishReason() ở trên cố tình chỉ trả 3 giá trị ('stop'|'length'|'other') vì đó là thứ
// completenessCheck/continuation cần để quyết định HARD/SOFT — KHÔNG đổi hợp đồng đó (mọi test cũ
// so sánh trực tiếp 3 giá trị này).
//
// Nhưng telemetry/recovery cần biết CHÍNH XÁC vì sao lượt gọi kết thúc: hết token, hết thời gian,
// bị người dùng hủy, provider lỗi, hay stream đứt sau khi đã phát delta. Trước đây mọi thứ không
// phải 'stop'/'length' đều rơi vào 'other' -> recovery không phân biệt được "đổi provider" (stream
// đứt) với "cấp thêm token" (hết max_tokens) với "dừng hẳn" (bị hủy).
const FINISH = Object.freeze({
  STOP: 'STOP',
  MAX_TOKENS: 'MAX_TOKENS',
  TIMEOUT: 'TIMEOUT',
  ABORT: 'ABORT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  STREAM_INTERRUPTED: 'STREAM_INTERRUPTED',
  CONTENT_FILTER: 'CONTENT_FILTER',
  UNKNOWN: 'UNKNOWN'
});

/**
 * classifyFinish() — gộp MỌI tín hiệu sẵn có thành đúng 1 mã nguyên nhân.
 * Thứ tự ưu tiên phản ánh độ TIN CẬY của tín hiệu: tín hiệu tầng vận chuyển (hủy/đứt kết nối) luôn
 * thắng tín hiệu nội dung, vì khi stream đứt provider KHÔNG kịp gửi stop_reason nào cả.
 *
 * @param {{raw?:string, interrupted?:boolean, cancelled?:boolean, timedOut?:boolean,
 *   error?:Error, producedText?:boolean}} sig
 * @returns {string} một trong FINISH.*
 */
function classifyFinish(sig = {}) {
  const { raw, interrupted, cancelled, timedOut, error, producedText } = sig;
  if (cancelled) return FINISH.ABORT;
  if (timedOut) return FINISH.TIMEOUT;
  if (interrupted) return FINISH.STREAM_INTERRUPTED;
  if (error) {
    if (error.cancelled) return FINISH.ABORT;
    if (error.status === 504 || /timeout|quá chậm/i.test(error.message || '')) return FINISH.TIMEOUT;
    return producedText ? FINISH.STREAM_INTERRUPTED : FINISH.PROVIDER_ERROR;
  }
  const norm = normalizeFinishReason(raw);
  if (norm === 'stop') return FINISH.STOP;
  if (norm === 'length') return FINISH.MAX_TOKENS;
  if (raw && /safety|content_filter|recitation|blocked/i.test(String(raw))) return FINISH.CONTENT_FILTER;
  return raw ? FINISH.UNKNOWN : FINISH.UNKNOWN;
}

/** Nguyên nhân nào ĐÁNG tiếp tục bằng cách cấp thêm token (thay vì đổi provider/dừng hẳn). */
function needsMoreTokens(code) { return code === FINISH.MAX_TOKENS; }
/** Nguyên nhân nào ĐÁNG failover sang provider khác (giữ nguyên phần text đã có). */
function needsFailover(code) {
  return code === FINISH.STREAM_INTERRUPTED || code === FINISH.PROVIDER_ERROR || code === FINISH.TIMEOUT;
}
/** Nguyên nhân nào PHẢI dừng hẳn, không recovery. */
function isTerminal(code) { return code === FINISH.ABORT; }

module.exports.FINISH = FINISH;
module.exports.classifyFinish = classifyFinish;
module.exports.needsMoreTokens = needsMoreTokens;
module.exports.needsFailover = needsFailover;
module.exports.isTerminal = isTerminal;
