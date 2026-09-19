'use strict';

const assert = require('assert');
const {
  estimateImageTokens,
  estimateImageCostUsd,
  estimateImageInputTokens,
  GEMINI_IMAGE_COST,
  OPENAI_IMAGE_COST
} = require('../server/utils/visual/imageCostTable');

const {
  resolveImagePlan,
  canAffordImage,
  DOWNGRADE_LADDER
} = require('../server/utils/visual/imageCostPolicy');

const {
  calculateRequestCostUsd,
  getCacheDiscount,
  TEXT_PRICING
} = require('../server/utils/pricing/requestCostCalculator');

const {
  estimateGeminiRequest,
  countGeminiRequestIfNeeded,
  resolveGeminiOutputBudget
} = require('../server/utils/geminiTokenBudget');

const {
  rememberInteraction,
  getInteraction,
  getLatestInteraction,
  _clearForTest
} = require('../server/utils/visual/imageInteractionStore');

const {
  assertImageModelSupported
} = require('../server/utils/visual/imageGenerationClient');

const {
  getImageInputCapability,
  planImages
} = require('../server/utils/imageBudgetPlanner');

(async () => {
  console.log('== Bắt đầu kiểm tra Image Cost, Token Budget & Interaction Store ==');

  // 1. imageCostTable
  assert.strictEqual(estimateImageTokens({ size: '1K' }), 1120);
  assert.strictEqual(estimateImageTokens({ size: '2K' }), 2000);
  assert.strictEqual(estimateImageTokens({ size: '4K' }), 4000);
  assert.strictEqual(estimateImageCostUsd({ provider: 'gemini', size: '1K' }), 0.03);
  assert.strictEqual(estimateImageCostUsd({ provider: 'openai', size: '1024x1024' }), 0.04);
  console.log('  ok - 1. imageCostTable: token & USD estimation chính xác theo bảng giá');

  // 2. imageCostPolicy
  const plan1 = resolveImagePlan({ requiresReadableLabels: true, remainingBudgetUsd: 0.1 });
  assert.strictEqual(plan1.size, '2K');
  assert.strictEqual(plan1.quality, 'high');

  const plan2 = resolveImagePlan({ requiresReadableLabels: true, remainingBudgetUsd: 0.02 });
  assert.strictEqual(plan2.size, '0.5K'); // Downgraded due to budget constraint

  assert.strictEqual(canAffordImage({ provider: 'gemini', size: '1K', remainingBudgetUsd: 0.05 }), true);
  assert.strictEqual(canAffordImage({ provider: 'gemini', size: '1K', remainingBudgetUsd: 0.01 }), false);
  console.log('  ok - 2. imageCostPolicy: giải quyết plan & downgrade ladder theo ngân sách còn lại');

  // 3. requestCostCalculator
  const reqCost = calculateRequestCostUsd({
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    promptTokens: 1000,
    cachedTokens: 500,
    outputTokens: 200,
    images: [{ provider: 'gemini', size: '1K' }]
  });
  assert.ok(reqCost.totalCostUsd > 0);
  assert.ok(reqCost.imageCostUsd === 0.03);
  assert.ok(reqCost.textCostUsd > 0);
  assert.strictEqual(getCacheDiscount('gemini'), 0.75);
  assert.strictEqual(getCacheDiscount('openai'), 0.5);
  console.log('  ok - 3. requestCostCalculator: tính chi phí USD gộp cả text, cache và ảnh');

  // 4. geminiTokenBudget
  const est = estimateGeminiRequest({
    systemPrompt: 'You are an educational assistant.',
    contents: 'Giải thích định lý Pythagoras và vẽ hình minh họa.'
  });
  assert.ok(est.estimatedInputTokens > 0);
  assert.strictEqual(est.hasImages, false);

  const budget = resolveGeminiOutputBudget({}, { answerBudget: 2048 });
  assert.strictEqual(budget, 2048);
  console.log('  ok - 4. geminiTokenBudget: ước tính token pre-flight 0 I/O an toàn');

  // 5. imageInteractionStore
  _clearForTest();
  rememberInteraction('v1', { interactionId: 'inter_123', provider: 'gemini-interactions-image', model: 'gemini-3.1-flash-image' });
  const stored = getInteraction('v1');
  assert.ok(stored);
  assert.strictEqual(stored.interactionId, 'inter_123');

  const latest = getLatestInteraction();
  assert.ok(latest);
  assert.strictEqual(latest.interactionId, 'inter_123');
  console.log('  ok - 5. imageInteractionStore: lưu trữ và truy xuất interaction state cho multi-turn edit');

  // 6. model deprecation guard
  const guard25 = assertImageModelSupported('gemini-2.5-flash-image');
  assert.strictEqual(guard25.deprecated, true);
  assert.strictEqual(guard25.suggestedModel, 'gemini-3.1-flash-image');

  const guard31 = assertImageModelSupported('gemini-3.1-flash-image');
  assert.strictEqual(guard31.deprecated, false);
  console.log('  ok - 6. assertImageModelSupported: cảnh báo deprecated model 2.5 và gợi ý model 3.1');

  // 7. imageBudgetPlanner provider capabilities
  const geminiCap = getImageInputCapability('gemini');
  assert.strictEqual(geminiCap.maxReferenceImages, 14);
  const openaiCap = getImageInputCapability('openai');
  assert.strictEqual(openaiCap.maxReferenceImages, 4);

  const planned = planImages([
    { id: '1', base64: 'abc', role: 'decorative' },
    { id: '2', base64: 'xyz', role: 'diagram' }
  ], { tokenBudget: 200 });
  assert.strictEqual(planned.selected.length, 1);
  assert.strictEqual(planned.selected[0].id, '2'); // diagram ưu tiên cao hơn decorative (rolePriority: 2 vs 6)
  assert.strictEqual(planned.estimatedImageInputTokens > 0, true);
  console.log('  ok - 7. imageBudgetPlanner: sắp xếp thứ tự ưu tiên theo role và tôn trọng provider caps');

  console.log('== TẤT CẢ TEST ĐÃ VƯỢT QUA 100% ==');
})();
