'use strict';

// Điểm vào DUY NHẤT của hệ thống hình minh họa (module rõ ràng, không circular dependency).
// Kiến trúc AI image-first: KHÔNG còn deterministicRenderer — hình 2D tĩnh chỉ đến từ
// imageGenerationClient (ảnh AI thật), 3D tương tác do Three.js ở frontend đảm nhiệm.
// routes/chat.js chỉ import file này, không import trực tiếp từng module con.
module.exports = {
  ...require('./visualPipeline'),
  decisionEngine: require('./visualDecisionEngine'),
  specBuilder: require('./visualSpecBuilder'),
  rendererRouter: require('./visualRendererRouter'),
  validator: require('./visualValidator'),
  cache: require('./visualCache'),
  imageClient: require('./imageGenerationClient'),
  judge: require('./visualJudge'),
  scoringConfig: require('./visualScoringConfig')
};
