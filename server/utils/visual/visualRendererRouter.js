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
    return {
      renderer: imageAvailable ? 'generated_image' : 'svg_diagram',
      primary: imageAvailable ? 'image_generation' : 'deterministic',
      fallbacks: imageAvailable ? ['deterministic', 'concept_card', 'no_visual'] : ['concept_card', 'no_visual'],
      accuracyCritical: false,
      reason: imageAvailable ? 'conceptual_with_image_provider' : 'conceptual_no_image_provider'
    };
  }

  // physics/optics: deterministic trước, image generation chỉ là phương án 2.
  return {
    renderer: 'svg_diagram',
    primary: 'deterministic',
    fallbacks: imageAvailable ? ['image_generation', 'concept_card', 'no_visual'] : ['concept_card', 'no_visual'],
    accuracyCritical: true,
    reason: 'semi_accuracy_critical'
  };
}

module.exports = { chooseVisualRenderer, ACCURACY_CRITICAL, CONCEPTUAL };
