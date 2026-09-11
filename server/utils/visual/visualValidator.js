'use strict';

// ============================================================================================
// PHẦN 18/26 — VISUAL QUALITY GATE: ảnh PHẢI ăn khớp với câu trả lời
// ============================================================================================
// Hình sai nguy hiểm hơn không có hình: học sinh tin vào hình. Trước khi hiển thị BẤT KỲ hình nào,
// đối chiếu spec + output render với FINAL ANSWER:
//
//   - số liệu trong hình phải có trong lời giải (không bịa)
//   - đơn vị không được sai
//   - nhãn/ký hiệu phải là ký hiệu đã dùng trong lời giải
//   - công thức hiển thị phải trùng công thức trong lời giải
//   - số lượng đối tượng hợp lý (không vẽ 20 lực cho 1 bài 2 lực)
//   - đúng ngôn ngữ yêu cầu
//
// Fail -> theo PHẦN 26: (1) thử deterministic renderer, (2) repair prompt NGẮN, (3) bỏ hình, GIỮ TEXT.

const MAX_OBJECTS_RENDERED = 16;

function normalizeNumber(v) {
  return String(v).replace(',', '.').replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * validateVisual() — cổng chất lượng.
 *
 * @param {object} args
 * @param {object} args.spec
 * @param {{format:string, content?:string, url?:string, renderer:string}} args.output
 * @param {string} args.finalAnswer Văn bản CUỐI CÙNG người dùng đọc.
 * @param {string} [args.expectedLanguage='vi']
 * @returns {{valid:boolean, issues:string[], severity:'HARD'|'SOFT'|null, checks:object}}
 */
function validateVisual({ spec, output, finalAnswer = '', expectedLanguage = 'vi' }) {
  const issues = [];
  const checks = {};

  if (!output || (!output.content && !output.url)) {
    return { valid: false, issues: ['empty_output'], severity: 'HARD', checks };
  }

  // ---------- 1. SVG phải là SVG hợp lệ, không chứa script/handler (ranh giới XSS) ----------
  if (output.format === 'svg') {
    const svg = String(output.content || '');
    checks.svgWellFormed = /^<svg[\s>]/i.test(svg.trim()) && /<\/svg>\s*$/i.test(svg.trim());
    if (!checks.svgWellFormed) issues.push('svg_malformed');
    if (/<script|javascript:|\son\w+\s*=/i.test(svg)) issues.push('svg_unsafe_content');
    if (/<foreignObject/i.test(svg)) issues.push('svg_unsafe_content');
  }

  // ---------- 2. Mọi SỐ hiển thị phải có trong lời giải (không bịa dữ kiện) ----------
  const answer = String(finalAnswer);
  const specNumbers = (spec.objects || []).map((o) => normalizeNumber(o.value));
  const unknownNumbers = specNumbers.filter((n) => {
    if (!n || n.length < 2) return false; // số 1 chữ số quá dễ trùng ngẫu nhiên, bỏ qua
    return !answer.includes(n) && !answer.includes(n.replace('.', ','));
  });
  checks.numbersGrounded = unknownNumbers.length === 0;
  if (!checks.numbersGrounded) issues.push('ungrounded_numbers:' + unknownNumbers.slice(0, 3).join(','));

  // ---------- 3. Ký hiệu/nhãn phải xuất hiện trong lời giải ----------
  const unknownLabels = (spec.labels || []).filter((l) => !new RegExp(`(^|[^A-Za-z])${l.replace(/[’']/g, "['’]")}([^A-Za-z]|$)`).test(answer));
  checks.labelsGrounded = unknownLabels.length === 0;
  if (!checks.labelsGrounded) issues.push('ungrounded_labels:' + unknownLabels.slice(0, 3).join(','));

  // ---------- 4. Công thức hiển thị phải trùng lời giải ----------
  const badEquations = (spec.requiredEquations || []).filter((e) => {
    const core = e.replace(/\s+/g, '');
    return !answer.replace(/\s+/g, '').includes(core);
  });
  checks.equationsGrounded = badEquations.length === 0;
  if (!checks.equationsGrounded) issues.push('ungrounded_equations');

  // ---------- 5. Đơn vị ----------
  const badUnits = (spec.objects || []).filter((o) => {
    if (!o.unit) return false;
    return !answer.includes(o.unit);
  });
  checks.unitsGrounded = badUnits.length === 0;
  if (!checks.unitsGrounded) issues.push('unit_mismatch');

  // ---------- 6. Số lượng đối tượng hợp lý ----------
  checks.objectCountOk = (spec.objects || []).length <= MAX_OBJECTS_RENDERED;
  if (!checks.objectCountOk) issues.push('too_many_objects');

  // ---------- 7. Ngôn ngữ ----------
  checks.languageOk = !expectedLanguage || spec.language === (expectedLanguage === 'English' ? 'en' : expectedLanguage);
  if (!checks.languageOk) issues.push('language_mismatch');

  // ---------- 8. Liên quan: hình phải có ít nhất 1 điểm neo vào lời giải ----------
  // "Điểm neo" = bất kỳ dữ kiện nào ĐÃ TRÍCH TỪ LỜI GIẢI mà hình sẽ hiển thị. Bản đầu chỉ xét
  // labels/objects/steps/plotExpr nên hình sinh học (neo bằng `parts`), hoá học (neo bằng
  // `molecule`) và địa lý (neo bằng `regions`) luôn bị đánh trượt 'not_relevant' — lỗi do bộ test
  // image-generation phát hiện. Mọi nguồn neo đều phải được tính.
  const d = spec.data || {};
  checks.relevant = (spec.labels || []).length > 0 || (spec.objects || []).length > 0
    || ((spec.requiredEquations || []).length > 0)
    || ((d.steps || []).length > 0) || !!d.plotExpr
    || ((d.parts || []).length > 0) || ((d.regions || []).length > 0) || !!d.molecule;
  if (!checks.relevant) issues.push('not_relevant');

  // HARD = không được hiển thị. SOFT = hiển thị được nhưng ghi nhận cảnh báo.
  const HARD = ['empty_output', 'svg_malformed', 'svg_unsafe_content', 'not_relevant'];
  const hard = issues.filter((i) => HARD.includes(i) || i.startsWith('ungrounded_numbers') || i.startsWith('ungrounded_equations'));
  const severity = hard.length ? 'HARD' : (issues.length ? 'SOFT' : null);

  return { valid: hard.length === 0, issues, severity, checks };
}

/**
 * PHẦN 26 — repair prompt NGẮN (chỉ cho đường image generation). Không gửi lại lời giải, chỉ nêu
 * đúng lỗi cần sửa. Dùng tối đa 1 lần; thất bại -> bỏ hình, giữ text.
 */
function buildVisualRepairPrompt(spec, issues) {
  const fixes = [];
  if (issues.some((i) => i.startsWith('ungrounded_numbers'))) fixes.push('chỉ dùng đúng các số đã cho, không thêm số mới');
  if (issues.includes('unit_mismatch')) fixes.push('ghi đúng đơn vị như đã liệt kê');
  if (issues.some((i) => i.startsWith('ungrounded_labels'))) fixes.push('chỉ dùng đúng các nhãn đã liệt kê');
  if (issues.includes('language_mismatch')) fixes.push(`mọi nhãn phải bằng ngôn ngữ "${spec.language}"`);
  if (issues.includes('too_many_objects')) fixes.push('giảm số đối tượng, chỉ giữ phần cốt lõi');
  if (!fixes.length) fixes.push('vẽ lại đúng theo đặc tả, không thêm chi tiết nào ngoài đặc tả');
  return `Vẽ lại hình theo đúng đặc tả, sửa các lỗi sau: ${fixes.join('; ')}.`;
}

module.exports = { validateVisual, buildVisualRepairPrompt, MAX_OBJECTS_RENDERED };
