'use strict';

// Điểm vào DUY NHẤT của hệ thống hình minh họa (PHẦN 35: module rõ ràng, không circular dependency).
// routes/chat.js chỉ import file này, không import trực tiếp từng module con.
module.exports = {
  ...require('./visualPipeline'),
  decisionEngine: require('./visualDecisionEngine'),
  specBuilder: require('./visualSpecBuilder'),
  rendererRouter: require('./visualRendererRouter'),
  deterministicRenderer: require('./deterministicRenderer'),
  validator: require('./visualValidator'),
  cache: require('./visualCache'),
  imageClient: require('./imageGenerationClient'),
  judge: require('./visualJudge'),
  scoringConfig: require('./visualScoringConfig')
};
