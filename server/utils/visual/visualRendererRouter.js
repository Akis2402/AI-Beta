'use strict';

// ============================================================================================
// VISUAL TYPE ROUTING — NHÁNH ẢNH AI của Hybrid Visual Engine
// ============================================================================================
// PHẠM VI: file này CHỈ phân giải nhánh ảnh AI. Việc chọn giữa SVG tất định / Puter AI Image /
// không hình nằm ở visualDeterminationEngine (điểm quyết định canonical duy nhất); router này chỉ
// được visualPipeline gọi SAU KHI nhánh 'puter-image' đã được chọn — nó KHÔNG tự chọn SVG và
// không cạnh tranh với determination engine. SVG tất định dựng bằng code ở ./deterministic/.
//
// Trong nhánh ảnh AI chỉ còn ĐÚNG 3 renderer:
//
//   generated_image  — MỌI hình minh hoạ 2D TĨNH (hình học, đồ thị, mạch điện, flowchart, chart,
//                      sơ đồ sinh/hoá/địa, concept illustration...). Nguồn duy nhất: AI image
//                      provider (PNG/JPEG/WebP thật, đã validate magic bytes).
//   interactive_3d   — scene 3D TƯƠNG TÁC (Three.js: solid3d.js / scene3d.js). Ảnh AI không thay
//                      thế được xoay/zoom/pan nên KHÔNG bao giờ đổi 3D interactive thành ảnh.
//   no_visual        — không cần hình.
//
// KHÔNG CÒN: 'svg_diagram', 'mathematical_plot' (với tư cách renderer), 'deterministic',
// 'concept_card'. Không còn bất kỳ đường nào sinh <svg> cho nội dung câu trả lời, và không còn
// fallback im lặng từ ảnh AI về SVG: ảnh hỏng -> failover provider -> trạng thái lỗi + retry.
//
// LƯU Ý: 'mathematical_plot' vẫn tồn tại với tư cách spec.type (loại hình), chỉ không còn là
// renderer. Các loại đòi độ chính xác cao vẫn được ĐÁNH DẤU `highPrecisionRequired` để
// visualSpecBuilder siết prompt và visualValidator soi kỹ dữ kiện — nhưng renderer vẫn là ảnh AI.

// Các loại cần độ chính xác cao: prompt phải kèm dữ kiện chính xác, validator soi kỹ, cho phép
// tối đa 1 lần repair. KHÔNG còn bị ép sang deterministic SVG.
const HIGH_PRECISION = new Set([
  'mathematical_plot',
  'geometry_diagram',
  'circuit_diagram',
  'chart',
  'flowchart',
  'architecture_diagram',
  'data_structure_diagram',
  'network_diagram'
]);

// Các loại có thể là scene 3D tương tác — CHỈ khi spec mang schema interactive thật sự.
const INTERACTIVE_3D_TYPES = new Set(['geometry_3d', 'solid3d', 'scene3d']);

// Giữ tên cũ để các module/telemetry ngoài không gãy khi đọc danh mục loại hình.
const CONCEPTUAL = new Set([
  'concept_illustration',
  'biology_diagram',
  'chemistry_structure',
  'apparatus_diagram',
  'map_diagram'
]);

/**
 * isInteractive3dSpec() — spec có phải scene 3D TƯƠNG TÁC (Three.js) không?
 * Chỉ true khi có schema interactive thật (scene3d/solid3d/objects 3D), không suy từ mỗi `type`:
 * một câu hỏi hình không gian vẫn có thể chỉ cần MỘT ảnh minh hoạ tĩnh.
 * @param {object} spec
 * @returns {boolean}
 */
function isInteractive3dSpec(spec) {
  if (!spec) return false;
  if (spec.interactive3d === true) return true;
  const d = spec.data || {};
  return !!(d.scene3d || d.solid3d || (Array.isArray(d.solids) && d.solids.length));
}

/**
 * chooseVisualRenderer() — quyết định đường render, KHÔNG render.
 *
 * @param {object} spec Kết quả visualSpecBuilder.buildVisualSpec().
 * @param {{imageProviderAvailable?:boolean}} [env]
 * @returns {{renderer:'generated_image'|'interactive_3d'|'no_visual', primary:string,
 *   fallbacks:string[], highPrecisionRequired:boolean, imageProviderAvailable:boolean,
 *   blocked:string|null, fidelity:string, realismRequired:boolean, upgradeHint:string|null,
 *   reason:string}}
 */
function chooseVisualRenderer(spec, env = {}) {
  const type = (spec && spec.type) || 'no_visual';
  const imageAvailable = !!env.imageProviderAvailable;
  const puterAvailable = !!env.puterImageAvailable;

  if (type === 'no_visual') {
    return {
      renderer: 'no_visual', primary: 'no_visual', fallbacks: [],
      highPrecisionRequired: false, imageProviderAvailable: imageAvailable, puterImageAvailable: puterAvailable, blocked: null,
      fidelity: 'none', realismRequired: false, upgradeHint: null, reason: 'decision_said_no'
    };
  }

  // ---------- 3D TƯƠNG TÁC: Three.js, không đụng tới ----------
  if (INTERACTIVE_3D_TYPES.has(type) && isInteractive3dSpec(spec)) {
    return {
      renderer: 'interactive_3d', primary: 'interactive_3d', fallbacks: [],
      highPrecisionRequired: false, imageProviderAvailable: imageAvailable, puterImageAvailable: puterAvailable, blocked: null,
      fidelity: 'interactive', realismRequired: false, upgradeHint: null,
      reason: 'interactive_3d_schema'
    };
  }

  // ---------- Mọi hình 2D TĨNH còn lại: CHỈ ảnh AI ----------
  const highPrecision = HIGH_PRECISION.has(type) || !!(spec && spec.needsPreciseGeometry);
  const realism = !!(spec && spec.realismRequired);

  return {
    renderer: 'generated_image',
    primary: 'image_generation',
    // Failover nằm TRONG imageGenerationClient (provider A -> B -> C). Ở tầng router không còn
    // renderer thay thế nào: hết provider là hết, KHÔNG quay về SVG.
    fallbacks: [],
    highPrecisionRequired: highPrecision,
    imageProviderAvailable: imageAvailable,
    puterImageAvailable: puterAvailable,
    // Không có provider ảnh = KHÔNG có hình. Nói thẳng ra ở đây để pipeline phát trạng thái lỗi
    // rõ ràng + nút thử lại, thay vì lặng lẽ dựng một sơ đồ SVG thay thế.
    blocked: puterAvailable || imageAvailable ? null : 'no_image_provider',
    fidelity: 'ai_generated',
    realismRequired: realism,
    upgradeHint: puterAvailable || imageAvailable ? null
      : 'Chưa cấu hình nhà cung cấp ảnh AI (GEMINI_IMAGE_API_KEY / OPENAI_IMAGE_API_KEY). '
        + 'Hệ thống KHÔNG dựng hình thay thế bằng SVG — hãy cấu hình khoá ảnh rồi bấm "Thử tạo lại".',
    reason: puterAvailable || imageAvailable
      ? (highPrecision ? 'static_visual_image_high_precision' : 'static_visual_image')
      : 'no_image_provider'
  };
}

module.exports = {
  chooseVisualRenderer, isInteractive3dSpec,
  HIGH_PRECISION, INTERACTIVE_3D_TYPES, CONCEPTUAL
};
