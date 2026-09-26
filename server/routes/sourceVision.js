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
const { validateSourceVisionBody, validateSourceUrlBody, validateNotebookGuideBody } = require('../utils/validators');
const { VISION_EXTRACT_SYSTEM, parseVisionJson } = require('../utils/visionExtract');
const { fetchWebSource } = require('../utils/source/webSource');
const { fetchYoutubeSource } = require('../utils/source/youtubeSource');
const { generateNotebookGuide } = require('../utils/source/notebookGuide');
const singleFlight = require('../utils/singleFlight');
const { contentFingerprint } = require('../utils/queryFingerprint');
const globalWorkerPool = require('../utils/globalWorkerPool');

// ---------- V6.21.19/.87 (audit): 3 route trong file này ĐỀU là việc CHUẨN BỊ NGUỒN (background) ----------
// không phải pipeline trả lời chat trực tiếp (interactive) — client gọi các route này RIÊNG lúc
// upload/thêm nguồn, không phải lúc chờ câu trả lời. Trước audit này, cả 3 route KHÔNG qua bất kỳ
// admission control nào chung với '/api/chat' — nếu nhiều lượt "thêm nguồn" chạy đồng thời (vd nhiều
// tab cùng thêm PDF/YouTube), chúng cạnh tranh CPU/network của CÙNG 1 tiến trình Node với chat request
// đang chờ, đúng kịch bản sự cố V6.21.19 mô tả. Gắn priority=background vào Global Worker Pool
// (globalWorkerPool.js) để '/api/chat' (priority=interactive, đã wiring từ trước) luôn được xếp hàng
// trước. release() do pool.acquire() trả về đã TỰ idempotent (xem globalWorkerPool.js) — không cần
// tự theo dõi thêm ở đây, chỉ cần gắn thẳng vào res.on('finish')/res.on('close') (CÙNG idiom chat.js).
async function acquireBackgroundSlot(res, timeoutMs) {
  const release = await globalWorkerPool.defaultPool.acquire({
    priority: globalWorkerPool.PRIORITY.BACKGROUND, timeoutMs
  });
  res.on('finish', release);
  res.on('close', release);
}

// Vision extraction là tác vụ PHỤ (chuẩn bị cache), không phải pipeline giải bài chính — ngân sách
// thời gian ngắn hơn hẳn GLOBAL_REQUEST_DEADLINE_MS của /api/chat, và giới hạn concurrency để không
// spam nhà cung cấp AI khi 1 PDF nhiều batch được xử lý gần như đồng thời.
const VISION_BATCH_DEADLINE_MS = Number(process.env.VISION_BATCH_DEADLINE_MS) || 45000;
const VISION_PAGE_CONCURRENCY = Number(process.env.VISION_PAGE_CONCURRENCY) || 3;

router.post('/vision-extract', async (req, res, next) => {
  try {
    const input = validateSourceVisionBody(req.body);
    await acquireBackgroundSlot(res, VISION_BATCH_DEADLINE_MS);
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
        const visionKey = contentFingerprint(pageImg.base64);
        // QUAN TRỌNG: giá trị dùng chung qua single-flight KHÔNG được chứa `page` — 2 caller có thể
        // gán cùng 1 ảnh cho 2 SỐ TRANG khác nhau (2 tài liệu khác nhau), share `page` sẽ trả nhầm
        // số trang cho caller thứ hai. `page` được gắn RIÊNG cho từng caller sau khi promise settle.
        const evidence = await singleFlight.scoped('vision')(visionKey, async () => {
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
          return parsed ? { ok: true, ...parsed } : { ok: false, reason: 'invalid_response_shape' };
        });
        return { page: pageImg.page, ...evidence };
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

// ============================================================================================
// PHẦN AK/AN — POST /api/source/web
// ============================================================================================
// Trước bản vá này, `webSource.js` (SSRF-safe fetch + HTML->text sạch + chunk + single-flight +
// cache theo content-hash) đã có module + test riêng nhưng KHÔNG có đường vào từ request thật
// (đúng như AUDIT-REPORT-V5-TOKEN-ECONOMY.md mục 5 đã nêu). Route này là đường vào đó: nhận 1 URL,
// trả evidence ĐÃ SẠCH (không phải HTML thô) để client tự add vào `contexts[]` của /api/chat —
// KHÔNG tự động chèn vào pipeline giải bài ở đây (giữ đúng ranh giới 1 route = 1 việc).
router.post('/web', async (req, res, next) => {
  try {
    const { url } = validateSourceUrlBody(req.body);
    await acquireBackgroundSlot(res, VISION_BATCH_DEADLINE_MS);
    const result = await fetchWebSource(url);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ============================================================================================
// PHẦN AO/AP/AQ/FC-11 — POST /api/source/youtube
// ============================================================================================
// Không có transcript = `status: 'INCOMPLETE'` + `userMessage` nói thẳng chưa đọc được video —
// KHÔNG suy ra nội dung từ tiêu đề (PHẦN FA cấm tuyệt đối việc này). Route chỉ chuyển tiếp đúng
// nguyên trạng kết quả của youtubeSource.js, không tự "làm mềm" status.
router.post('/youtube', async (req, res, next) => {
  try {
    const { url } = validateSourceUrlBody(req.body);
    await acquireBackgroundSlot(res, VISION_BATCH_DEADLINE_MS);
    const result = await fetchYoutubeSource(url);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ============================================================================================
// MỤC IV/LIV/LV (rework notebook) — POST /api/source/guide (Notebook Guide)
// ============================================================================================
// Cùng loại việc với /vision-extract, /web, /youtube: CHUẨN BỊ nguồn (background priority), không
// phải pipeline trả lời chat trực tiếp — client gọi route này khi người dùng bấm "Tạo Guide"/
// "Regenerate" trong Source Workspace (mục XXIII: KHÔNG tự động gọi sau mỗi câu hỏi), không phải mỗi
// lượt hỏi. Toàn bộ logic nén/cache/gọi AI nằm trong notebookGuide.js — route chỉ validate input và
// chuyển tiếp, đúng ranh giới "1 route = 1 việc" đã áp dụng cho /web và /youtube ở trên.
const GUIDE_DEADLINE_MS = Number(process.env.GUIDE_DEADLINE_MS) || 60000;
router.post('/guide', async (req, res, next) => {
  try {
    const input = validateNotebookGuideBody(req.body);
    await acquireBackgroundSlot(res, GUIDE_DEADLINE_MS);
    await ensureProvidersReady();
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error('Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào.');
      err.status = 500;
      throw err;
    }
    const deadline = createDeadline(GUIDE_DEADLINE_MS);
    const result = await generateNotebookGuide(input, activeProviders, {
      callWithFailover, requestId: req.requestId, deadline, noCache: req.body && req.body.noCache === true
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

