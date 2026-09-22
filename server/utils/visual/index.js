'use strict';

// Điểm vào DUY NHẤT của hệ thống hình minh họa (module rõ ràng, không circular dependency).
// Kiến trúc HYBRID: visualDeterminationEngine chọn renderer — SVG tất định (deterministic/, cho
// Toán/Lý/Hoá dựng được chính xác) hoặc ảnh AI (imageGenerationClient/Puter); 3D tương tác do
// Three.js ở frontend đảm nhiệm.
// routes/chat.js chỉ import file này, không import trực tiếp từng module con.
module.exports = {
  ...require('./visualPipeline'),
  policy: require('./visualPolicy'),
  decisionEngine: require('./visualDecisionEngine'),
  determinationEngine: require('./visualDeterminationEngine'),
  deterministic: require('./deterministic'),
  specBuilder: require('./visualSpecBuilder'),
  rendererRouter: require('./visualRendererRouter'),
  validator: require('./visualValidator'),
  cache: require('./visualCache'),
  imageClient: require('./imageGenerationClient'),
  judge: require('./visualJudge'),
  // MỤC 33: canonical visual state phía server — Approach ghi, Detail đọc (không bao giờ sinh lại).
  stateStore: require('./visualStateStore'),
  scoringConfig: require('./visualScoringConfig')
};
