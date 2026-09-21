'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const app = read('public/js/app.js');
const pipeline = read('server/utils/visual/visualPipeline.js');
const manager = read('public/js/visual/puterVisualManager.js');
const adapter = read('public/js/providers/puterAdapter.js');
const imageClient = read('server/utils/visual/imageGenerationClient.js');
const visualRoute = read('server/routes/visual.js');

assert.ok(!app.includes('Promise.all(clientVisualJobs)'), 'SSE client must not await visual jobs');
assert.ok(app.includes('onVisualRequest') && app.includes('onVisualReady'), 'visual callbacks must exist');
assert.ok(pipeline.includes('inputImageIds') && !pipeline.includes('inputImages: Array.isArray(inputImages)'), 'job must not carry image bytes');
assert.ok(manager.includes('MAX_VISUAL_LIFECYCLE_ATTEMPTS'), 'retry limit required');
assert.ok(manager.includes('generationAttemptId'), 'attempt identity required');
assert.ok(adapter.includes('puter.ai.txt2img'), 'canonical Puter image API required');
assert.ok(adapter.includes('DEFAULT_PUTER_IMAGE_PROVIDER'), 'default API provider required');
assert.ok(imageClient.includes('server_image_generation_forbidden_in_client_primary'), 'server image guard required');
assert.ok(visualRoute.includes('clientPrimary'), 'retry/HQ client-primary route required');
assert.ok(!app.includes('data.visuals = results.filter(Boolean)'), 'client must not merge awaited visual jobs into text result');
console.log('Puter primary contract: PASS');
