// Re-export and TypeScript interfaces for AI Providers and Models
export interface AIProviderConfig {
  name: string;
  model: string;
  configured: boolean;
}

export function getAIProviders() {
  const { getActiveProviders } = require('../../server/utils/aiProviders');
  return getActiveProviders();
}
