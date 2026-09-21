// Source processing, citation and vision extract helpers
export function extractVision(params: any) {
  const { VISION_EXTRACT_SYSTEM } = require('../../server/utils/visionExtract');
  return VISION_EXTRACT_SYSTEM;
}
