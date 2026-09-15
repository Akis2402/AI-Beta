'use strict';

// ============================================================================================
// VISUAL QUALITY GATE — DÀNH RIÊNG CHO ẢNH AI (không còn nhánh SVG nào)
// ============================================================================================
// Hình sai nguy hiểm hơn không có hình: học sinh tin vào hình. Trước khi hiển thị BẤT KỲ hình nào:
//
//   A. HÌNH PHẢI LÀ ẢNH THẬT
//      - renderer === 'generated_image' và origin === 'ai_generated'
//      - format ∈ {data_url, image_url}; MIME ∈ image/png|jpeg|webp|gif
//      - data URL phải qua magic-bytes (imageBinaryValidator) — text/HTML/SVG gắn đuôi .png TRƯỢT
//      - KHÔNG chấp nhận chuỗi SVG/HTML làm nội dung hình
//
//   B. HÌNH PHẢI ĂN KHỚP LỜI GIẢI
//      - số liệu / nhãn / công thức / đơn vị đều phải có trong final answer (không bịa)
//      - số lượng đối tượng hợp lý, đúng ngôn ngữ, có ít nhất 1 điểm neo vào lời giải
//
// Fail HARD -> KHÔNG hiển thị. Xử lý tiếp: tối đa 1 lần repair bằng image AI / failover provider
// khác; vẫn sai -> trạng thái failed + retry, GIỮ NGUYÊN TEXT. Không có đường SVG nào để lùi về.

const { validateImageBase64 } = require('./imageBinaryValidator');

const MAX_OBJECTS_RENDERED = 16;
const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ALLOWED_FORMATS = ['data_url', 'image_url'];

function normalizeNumber(v) {
  return String(v).replace(',', '.').replace(/0+$/, '').replace(/\.$/, '');
}

/** Chuỗi có phải markup (SVG/HTML) giả dạng ảnh không? */
function looksLikeMarkup(s) {
  return /^\s*(<\?xml|<svg[\s>]|<!doctype|<html[\s>]|<div[\s>])/i.test(String(s || ''));
}

/**
 * validateImageOutput() — TẦNG A: output có phải ẢNH AI THẬT không.
 * Tách riêng để test được độc lập với phần đối chiếu nội dung.
 * @param {{format?:string, url?:string, content?:string, renderer?:string, origin?:string,
 *   model?:string, verifiedMime?:string, urlVerified?:boolean}} output
 * @returns {{valid:boolean, issues:string[], checks:object}}
 */
function validateImageOutput(output) {
  const issues = [];
  const checks = {};

  if (!output || (!output.url && !output.content)) {
    return { valid: false, issues: ['empty_output'], checks };
  }

  // 1. renderer/origin — nhãn "ảnh AI" không được phép gắn cho thứ không do image model sinh.
  checks.rendererOriginConsistent = output.renderer === 'generated_image' && output.origin === 'ai_generated';
  if (!checks.rendererOriginConsistent) issues.push('renderer_origin_mismatch');

  // 2. Không bao giờ nhận markup (SVG/HTML) làm nội dung hình.
  checks.noMarkupContent = !output.content || !looksLikeMarkup(output.content);
  if (!checks.noMarkupContent) issues.push('markup_not_an_image');
  if (output.format === 'svg') issues.push('svg_format_rejected');

  // 3. format hợp lệ.
  checks.formatOk = ALLOWED_FORMATS.includes(output.format);
  if (!checks.formatOk) issues.push('invalid_image_format');

  // 4. Binary/MIME thật.
  checks.mimeOk = false;
  checks.binaryVerified = false;
  if (output.format === 'data_url') {
    const url = String(output.url || '');
    const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(url);
    if (!m) {
      issues.push('invalid_data_url');
    } else if (!ALLOWED_IMAGE_MIME.includes(m[1].toLowerCase())) {
      issues.push('unsupported_image_mime:' + m[1]);
    } else {
      checks.mimeOk = true;
      // Chữ ký byte THẬT là bằng chứng duy nhất; nhãn mime trong data URL không đủ.
      const bin = validateImageBase64(m[2], m[1]);
      checks.binaryVerified = !!bin.valid;
      if (!bin.valid) issues.push('invalid_image_binary:' + (bin.reason || 'unknown'));
    }
  } else if (output.format === 'image_url') {
    const url = String(output.url || '');
    checks.mimeOk = !output.verifiedMime || ALLOWED_IMAGE_MIME.includes(String(output.verifiedMime).toLowerCase());
    if (!checks.mimeOk) issues.push('unsupported_image_mime:' + output.verifiedMime);
    if (!/^https:\/\//i.test(url)) issues.push('image_url_not_https');
    // imageGenerationClient đã tải + validate byte trước khi trả ok:true (urlVerified=true).
    checks.binaryVerified = output.urlVerified === true;
    if (!checks.binaryVerified) issues.push('image_url_not_verified');
  }

  // 5. Telemetry provider/model — cần cho retry/quan sát, thiếu là cảnh báo mềm.
  checks.providerTelemetry = !!output.model;
  if (!checks.providerTelemetry) issues.push('missing_provider_telemetry');

  const HARD = issues.filter((i) => i !== 'missing_provider_telemetry');
  return { valid: HARD.length === 0, issues, checks };
}

/**
 * validateVisual() — cổng chất lượng đầy đủ (ảnh thật + ăn khớp lời giải).
 *
 * @param {object} args
 * @param {object} args.spec
 * @param {object} args.output {format, url, renderer, origin, model, urlVerified, verifiedMime}
 * @param {string} args.finalAnswer Văn bản CUỐI CÙNG người dùng đọc.
 * @param {string} [args.expectedLanguage='vi']
 * @returns {{valid:boolean, issues:string[], severity:'HARD'|'SOFT'|null, checks:object}}
 */
function validateVisual({ spec, output, finalAnswer = '', expectedLanguage = 'vi' }) {
  const imageCheck = validateImageOutput(output);
  const issues = imageCheck.issues.slice();
  const checks = { ...imageCheck.checks };
  if (!imageCheck.valid) return { valid: false, issues, severity: 'HARD', checks };

  const answer = String(finalAnswer);

  // ---------- Mọi SỐ hiển thị phải có trong lời giải (không bịa dữ kiện) ----------
  const specNumbers = (spec.objects || []).map((o) => normalizeNumber(o.value));
  const unknownNumbers = specNumbers.filter((n) => {
    if (!n || n.length < 2) return false; // số 1 chữ số quá dễ trùng ngẫu nhiên, bỏ qua
    return !answer.includes(n) && !answer.includes(n.replace('.', ','));
  });
  checks.numbersGrounded = unknownNumbers.length === 0;
  if (!checks.numbersGrounded) issues.push('ungrounded_numbers:' + unknownNumbers.slice(0, 3).join(','));

  // ---------- Ký hiệu/nhãn phải xuất hiện trong lời giải ----------
  const unknownLabels = (spec.labels || []).filter((l) => !new RegExp(`(^|[^A-Za-z])${l.replace(/[’']/g, "['’]")}([^A-Za-z]|$)`).test(answer));
  checks.labelsGrounded = unknownLabels.length === 0;
  if (!checks.labelsGrounded) issues.push('ungrounded_labels:' + unknownLabels.slice(0, 3).join(','));

  // ---------- Công thức hiển thị phải trùng lời giải ----------
  const badEquations = (spec.requiredEquations || []).filter((e) => {
    const core = e.replace(/\s+/g, '');
    return !answer.replace(/\s+/g, '').includes(core);
  });
  checks.equationsGrounded = badEquations.length === 0;
  if (!checks.equationsGrounded) issues.push('ungrounded_equations');

  // ---------- Đơn vị ----------
  const badUnits = (spec.objects || []).filter((o) => {
    if (!o.unit) return false;
    return !answer.includes(o.unit);
  });
  checks.unitsGrounded = badUnits.length === 0;
  if (!checks.unitsGrounded) issues.push('unit_mismatch');

  // ---------- Số lượng đối tượng hợp lý ----------
  checks.objectCountOk = (spec.objects || []).length <= MAX_OBJECTS_RENDERED;
  if (!checks.objectCountOk) issues.push('too_many_objects');

  // ---------- Ngôn ngữ nhãn ----------
  checks.languageOk = !expectedLanguage || spec.language === (expectedLanguage === 'English' ? 'en' : expectedLanguage);
  if (!checks.languageOk) issues.push('language_mismatch');

  // ---------- Liên quan: hình phải có ít nhất 1 điểm neo vào lời giải ----------
  const d = spec.data || {};
  const hasAnyAnchor = (spec.labels || []).length > 0 || (spec.objects || []).length > 0
    || ((spec.requiredEquations || []).length > 0)
    || ((d.steps || []).length > 0) || !!d.plotExpr
    || ((d.parts || []).length > 0) || ((d.regions || []).length > 0) || !!d.molecule;
  // Câu hỏi khái niệm tổng quan không có dữ kiện để trích: purpose/title vẫn là điểm neo hợp lệ,
  // ảnh AI vẫn minh hoạ được. Đây KHÔNG phải "không liên quan".
  const isConceptual = !hasAnyAnchor && !!(spec.purpose || spec.title);
  checks.relevant = hasAnyAnchor || isConceptual;
  if (!checks.relevant) issues.push('not_relevant');

  // HARD = không được hiển thị. SOFT = hiển thị được nhưng ghi nhận cảnh báo.
  const SOFT = ['missing_provider_telemetry', 'unit_mismatch', 'too_many_objects', 'language_mismatch'];
  const hard = issues.filter((i) => !SOFT.includes(i)
    && (i === 'not_relevant' || i.startsWith('ungrounded_numbers') || i.startsWith('ungrounded_equations')
      || i.startsWith('ungrounded_labels')));
  const severity = hard.length ? 'HARD' : (issues.length ? 'SOFT' : null);

  return { valid: hard.length === 0, issues, severity, checks };
}

/**
 * buildVisualRepairPrompt() — prompt sửa NGẮN cho đúng 1 lần repair bằng image AI.
 * Không gửi lại lời giải, chỉ nêu đúng lỗi cần sửa. Thất bại -> failover provider -> bỏ hình,
 * giữ text. KHÔNG BAO GIỜ chuyển sang SVG.
 */
function buildVisualRepairPrompt(spec, issues) {
  const fixes = [];
  if (issues.some((i) => i.startsWith('ungrounded_numbers'))) fixes.push('chỉ dùng đúng các số đã cho, không thêm số mới');
  if (issues.includes('unit_mismatch')) fixes.push('ghi đúng đơn vị như đã liệt kê');
  if (issues.some((i) => i.startsWith('ungrounded_labels'))) fixes.push('chỉ dùng đúng các nhãn đã liệt kê, không đổi tên');
  if (issues.includes('language_mismatch')) fixes.push(`mọi nhãn phải bằng ngôn ngữ "${spec.language}"`);
  if (issues.includes('too_many_objects')) fixes.push('giảm số đối tượng, chỉ giữ phần cốt lõi');
  if (issues.some((i) => i.startsWith('invalid_image') || i.startsWith('unsupported_image_mime'))) {
    fixes.push('trả về đúng một ảnh raster (PNG/JPEG/WebP), không trả văn bản hay mã SVG');
  }
  if (!fixes.length) fixes.push('vẽ lại đúng theo đặc tả, không thêm chi tiết nào ngoài đặc tả');
  return `Vẽ lại hình theo đúng đặc tả, sửa các lỗi sau: ${fixes.join('; ')}.`;
}

module.exports = {
  validateVisual, validateImageOutput, buildVisualRepairPrompt,
  MAX_OBJECTS_RENDERED, ALLOWED_IMAGE_MIME, ALLOWED_FORMATS
};
