// Token economy and adaptive budget helpers
export function calculateBudget(params: any) {
  const { calculateAdaptiveBudget } = require('../../server/utils/adaptiveBudget');
  return calculateAdaptiveBudget(params);
}
