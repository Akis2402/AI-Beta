'use strict';
/* ================= server/routes/sourceVision.js =================
 * PHẦN A6 (BATCH SOURCE READING) + A11 (KHÔNG ĐỂ PDF IMAGE BASE64 LÀM REQUEST KHỔNG LỒ):
 *
 * PDF scan/ảnh (không có text layer) trước đây chỉ có 1 cách để AI "đọc": mỗi lượt hỏi, client lại
 * gửi kèm base64 của các trang liên quan (xem collectSourceImages() ở app.js) — nếu người dùng hỏi
 * 5 câu về cùng 1 PDF, cùng những trang đó bị encode+gửi lại 5 lần, và số trang gửi được 1 lượt bị
 * chặn bởi MAX_SOURCE_IMAGES (băng thông/token 1 request).
 *
 * Route này cho phép client (SAU KHI rasterize xong — xem parsePDF() ở app.js) gọi 1 lần/batch
 * (tối đa MAX_VISION_BATCH_PAGES trang, mục A6 "không nổ token 1 request") để model đọc bằng vision
 * và trả về "evidence" dạng TEXT — extractedText/equations/diagrams/confidence — client cache lại
 * (doc.pageEvidence, xem app.js) và TỪ ĐÓ VỀ SAU dùng evidence text này qua retrieveContext() y hệt
 * PDF có text layer (đúng tinh thần A11: "PDF vẫn được dùng toàn bộ, nhưng token request cuối không
 * bị nổ" — vì contexts giờ là text ngắn gọn, không phải base64 ảnh gửi lại).
 *
 * Batch nào lỗi (timeout/AI từ chối/model không hỗ trợ vision) trả `ok:false` cho ĐÚNG các trang lỗi
 * đó — không chặn/không giả vờ các trang khác cũng lỗi theo (mục A10: 1 trang lỗi không được coi là
 * cả PDF lỗi). Client tự quyết định retry hay giữ nguyên fallback gửi ảnh thô (collectSourceImages).
 */

const express = require('express');
const router = express.Router();
const { getActiveProviders, ensureProvidersReady, callWithFailover, mapWithConcurrency, createDeadline } = require('../utils/aiProviders');
const { validateSourceVisionBody } = require('../utils/validators');
const { VISION_EXTRACT_SYSTEM, parseVisionJson } = require('../utils/visionExtract');

// Vision extraction là tác vụ PHỤ (chuẩn bị cache), không phải pipeline giải bài chính — ngân sách
// thời gian ngắn hơn hẳn GLOBAL_REQUEST_DEADLINE_MS của /api/chat, và giới hạn concurrency để không
// spam nhà cung cấp AI khi 1 PDF nhiều batch được xử lý gần như đồng thời.
const VISION_BATCH_DEADLINE_MS = Number(process.env.VISION_BATCH_DEADLINE_MS) || 45000;
const VISION_PAGE_CONCURRENCY = Number(process.env.VISION_PAGE_CONCURRENCY) || 3;

router.post('/vision-extract', async (req, res, next) => {
  try {
    const input = validateSourceVisionBody(req.body);
    await ensureProvidersReady();
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error('Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào.');
      err.status = 500;
      throw err;
    }
    const deadline = createDeadline(VISION_BATCH_DEADLINE_MS);

    const results = await mapWithConcurrency(input.pages, VISION_PAGE_CONCURRENCY, async (pageImg) => {
      try {
        const resp = await callWithFailover(
          activeProviders,
          {
            system: VISION_EXTRACT_SYSTEM,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: pageImg.mediaType, data: pageImg.base64 } },
                { type: 'text', text: `Trích xuất nội dung trang ${pageImg.page != null ? pageImg.page : '(không rõ số)'} theo đúng định dạng JSON đã nêu.` }
              ]
            }],
            maxTokens: 1500,
            // PHẦN S: gắn nhãn stage để tokenTelemetry xếp token này vào sourceIndexing — chi phí
            // đọc nguồn 1 lần lúc upload, KHÔNG được cộng vào token của các lượt chat sau đó.
            stage: 'source_indexing_vision_extract',
            requestId: req.requestId
          },
          { requireVision: true, deadline }
        );
        const parsed = parseVisionJson(resp && resp.text);
        if (!parsed) {
          return { page: pageImg.page, ok: false, reason: 'invalid_response_shape' };
        }
        return { page: pageImg.page, ok: true, ...parsed };
      } catch (e) {
        // 1 trang lỗi KHÔNG được làm hỏng cả batch (mục A10) — trả reason để client ghi vào
        // failedPages, retry theo đúng cơ chế retry-1-lần đã có ở parsePDF() nếu muốn.
        return { page: pageImg.page, ok: false, reason: 'provider_error' };
      }
    });

    // PHẦN E: trang bị loại ở tầng validate (MIME sai, base64 hỏng, quá nặng) đi kèm response —
    // client đánh dấu ĐÚNG trang đó là failed thay vì tưởng đã đọc xong.
    res.json({ results, rejected: input.rejected || [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
