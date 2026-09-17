'use strict';

// ============================================================================================
// IMAGE STUDIO V2 — POST /api/visual/generate-v2
// ============================================================================================
// Route HOÀN TOÀN MỚI, tách biệt khỏi server/routes/visual.js (route cũ phục vụ pipeline hình
// minh hoạ chính của ứng dụng: /download, /asset/:id, /hq, /status, /retry). Không sửa, không xoá
// bất kỳ route nào của file cũ. Được mount thêm vào server/app.js dưới cùng prefix /api/visual
// (Express cho phép nhiều router cùng prefix, khớp theo path cụ thể — không trùng path nào ở đây).

const express = require('express');
const { generateImage } = require('../utils/visual/imageGenerationClientV2');
const { enhanceImagePrompt } = require('../utils/visual/visualSpecBuilderV2');

const router = express.Router();

const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16'];

router.post('/generate-v2', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const aspectRatio = VALID_ASPECT_RATIOS.includes(body.aspectRatio) ? body.aspectRatio : '1:1';
    const style = typeof body.style === 'string' ? body.style : null;
    const negativePrompt = typeof body.negativePrompt === 'string' ? body.negativePrompt.trim() : '';

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Thiếu prompt. Vui lòng nhập mô tả hình ảnh bạn muốn tạo.' });
    }

    const enhancedPrompt = enhanceImagePrompt(prompt, style);

    const generationOptions = {
      aspectRatio,
      numberOfImages: 1,
      safetySettings: { safetyFilterLevel: 'BLOCK_MEDIUM_AND_ABOVE', personGeneration: 'ALLOW_ADULT' }
    };
    if (negativePrompt) {
      generationOptions.negativePrompt = negativePrompt;
    }

    const result = await generateImage(enhancedPrompt, generationOptions);

    return res.status(200).json({
      success: true,
      data: {
        images: result.images,
        provider: result.provider,
        model: result.model
      }
    });
  } catch (error) {
    console.error('[routes/visualV2] Lỗi khi tạo ảnh (cả Primary và Fallback đều thất bại):', error && error.message ? error.message : error);
    return res.status(500).json({
      success: false,
      error: 'Hệ thống tạo ảnh hiện đang quá tải, vui lòng thử lại sau.'
    });
  }
});

module.exports = router;
