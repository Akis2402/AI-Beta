'use strict';

// ============================================================================================
// PHẦN 19 — VISUAL TYPE ROUTING: chooseVisualRenderer(spec)
// ============================================================================================
// Quy tắc duy nhất:
//
//   ACCURACY-CRITICAL   -> deterministic renderer (SVG dựng từ spec)
//   STRUCTURED DATA     -> chart/table
//   CONCEPTUAL          -> image generation CÓ THỂ phù hợp
//
// KHÔNG ép mọi thứ qua image generation. Đồ thị toán, mạch điện, biểu đồ số liệu, hình hình học,
// vector, flowchart, sơ đồ kỹ thuật — image model không đảm bảo được số/công thức/hướng nên bắt
// buộc đi đường deterministic; nếu deterministic không đủ dữ kiện thì THÀ KHÔNG CÓ HÌNH còn hơn có
// hình sai (PHẦN 18/26).

// Những loại KHÔNG BAO GIỜ được giao cho image generation.
const ACCURACY_CRITICAL = new Set([
  'mathematical_plot',
  'geometry_diagram',
  'geometry_3d',
  'circuit_diagram',
  'chart',
  'flowchart',
  'architecture_diagram',
  'data_structure_diagram',
  'network_diagram'
]);

// Những loại mà hình minh hoạ trực quan/3D/thực tế thực sự có giá trị hơn SVG sơ đồ.
const CONCEPTUAL = new Set([
  'concept_illustration',
  'biology_diagram',
  'chemistry_structure',
  'apparatus_diagram',
  'map_diagram'
]);

// physics_diagram/optics_diagram nằm giữa: có thể vẽ chính xác bằng SVG khi spec đủ dữ kiện
// (lực/góc/quỹ đạo), nhưng minh hoạ trực quan cũng hữu ích. Ưu tiên deterministic trước.

/**
 * chooseVisualRenderer() — quyết định đường render, KHÔNG render.
 *
 * @param {object} spec Kết quả visualSpecBuilder.buildVisualSpec().
 * @param {{imageProviderAvailable?:boolean}} [env]
 * @returns {{renderer:'svg_diagram'|'mathematical_plot'|'generated_image'|'table'|'no_visual',
 *   primary:string, fallbacks:string[], accuracyCritical:boolean, reason:string}}
 */
function chooseVisualRenderer(spec, env = {}) {
  const type = (spec && spec.type) || 'no_visual';
  const imageAvailable = !!env.imageProviderAvailable;

  if (type === 'no_visual') {
    return { renderer: 'no_visual', primary: 'no_visual', fallbacks: [], accuracyCritical: false, reason: 'decision_said_no' };
  }

  if (ACCURACY_CRITICAL.has(type)) {
    return {
      renderer: type === 'mathematical_plot' ? 'mathematical_plot' : 'svg_diagram',
      primary: 'deterministic',
      // KHÔNG có 'generated_image' trong fallback: hình sai còn tệ hơn không có hình (PHẦN 26).
      fallbacks: ['concept_card', 'no_visual'],
      accuracyCritical: true,
      reason: 'accuracy_critical_type'
    };
  }

  if (CONCEPTUAL.has(type)) {
    // Rủi ro #3: đề đòi hình THẬT (lát cắt, giải phẫu, tiêu bản, bản đồ địa hình) mà không có image
    // provider -> sơ đồ SVG vẫn được dựng nhưng phải được đánh dấu là SƠ ĐỒ, không giả vờ là hình
    // thật. `fidelity` đi thẳng vào caption + telemetry.
    const realism = !!(spec && spec.realismRequired);
    return {
      renderer: imageAvailable ? 'generated_image' : 'svg_diagram',
      primary: imageAvailable ? 'image_generation' : 'deterministic',
      fallbacks: imageAvailable ? ['deterministic', 'concept_card', 'no_visual'] : ['concept_card', 'no_visual'],
      accuracyCritical: false,
      realismRequired: realism,
      fidelity: imageAvailable ? 'illustrative' : (realism ? 'schematic_only' : 'schematic'),
      upgradeHint: realism && !imageAvailable
        ? 'Đề này cần hình thực tế (lát cắt/giải phẫu/bản đồ thật). Renderer deterministic chỉ dựng '
          + 'được sơ đồ khái niệm — cấu hình GEMINI_IMAGE_API_KEY hoặc OPENAI_IMAGE_API_KEY để có hình '
          + 'minh hoạ đúng mức. KHÔNG khắc phục bằng cách để renderer tự đoán hình.'
        : null,
      reason: imageAvailable ? 'conceptual_with_image_provider'
        : (realism ? 'conceptual_realism_needed_no_provider' : 'conceptual_no_image_provider')
    };
  }

  // ==========================================================================================
  // MỤC 1.1 — physics/optics và các loại "ở giữa": QUYẾT ĐỊNH THEO DỮ KIỆN, KHÔNG THEO TYPE
  // ==========================================================================================
  // BUG cũ: nhánh này gán CỨNG accuracyCritical=true + primary='deterministic' cho MỌI type không
  // nằm trong 2 tập trên, nên "một vật trượt trên mặt phẳng nghiêng" (định tính, không đòi số đo)
  // vẫn bị đẩy về SVG thô. Nay dùng cờ `spec.needsPreciseGeometry` do visualSpecBuilder tính từ
  // dữ kiện thật (toạ độ/góc cụ thể/plotExpr/quan hệ hình học).
  //
  // Mặc định KHI THIẾU CỜ (spec cũ, caller ngoài pipeline) = true -> giữ nguyên hành vi an toàn cũ.
  const needsPrecise = (spec && spec.needsPreciseGeometry === false) ? false : true;

  if (!needsPrecise && imageAvailable) {
    return {
      renderer: 'generated_image',
      primary: 'image_generation',
      fallbacks: ['deterministic', 'concept_card', 'no_visual'],
      accuracyCritical: false,
      needsPreciseGeometry: false,
      fidelity: 'illustrative',
      reason: 'qualitative_scene_image_preferred'
    };
  }

  return {
    renderer: 'svg_diagram',
    primary: 'deterministic',
    // Không có số đo phải vẽ đúng thì hình minh hoạ vẫn là fallback hợp lệ; còn khi CÓ số đo
    // (needsPrecise=true) thì image model không được đụng vào (hình sai tệ hơn không hình).
    fallbacks: (imageAvailable && !needsPrecise) ? ['image_generation', 'concept_card', 'no_visual'] : ['concept_card', 'no_visual'],
    accuracyCritical: needsPrecise,
    needsPreciseGeometry: needsPrecise,
    reason: needsPrecise ? 'semi_accuracy_critical' : 'qualitative_no_image_provider'
  };
}

module.exports = { chooseVisualRenderer, ACCURACY_CRITICAL, CONCEPTUAL };
