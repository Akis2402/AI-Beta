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
