'use strict';

// ============================================================================================
// MỤC 1.4 — GET /api/visual/download?url=... : TẢI HỘ ẢNH DO IMAGE PROVIDER TRẢ VỀ
// ============================================================================================
// Vì sao cần route này (không phải tiện tay thêm):
//   - CSP của app (`img-src 'self' data: blob:`, `connect-src 'self'`) CỐ Ý không mở cho domain
//     bên thứ 3. Ảnh `format:'data_url'` (Gemini) client tự xử lý được; ảnh `format:'image_url'`
//     (OpenAI trả link https có hạn) thì client KHÔNG fetch được — CORS lẫn CSP đều chặn.
//   - Nới CSP cho cả domain provider là đổi bề mặt bảo mật của toàn bộ app chỉ để phục vụ 1 nút
//     tải. Proxy server-side hẹp hơn nhiều.
//
// RÀNG BUỘC CHỐNG SSRF (bắt buộc, không nới):
//   1. Chỉ chấp nhận https.
//   2. Hostname phải khớp WHITELIST CỨNG dưới đây (so khớp chính xác hoặc subdomain thật sự).
//   3. Không theo redirect ra ngoài whitelist (kiểm tra lại hostname ở mỗi chặng, tối đa 3 chặng).
//   4. Chặn size quá lớn, chặn content-type không phải image/*.
// Không có tham số nào khác được truyền tiếp lên upstream.

const express = require('express');
// MỤC 5/6 (đợt audit 2) — validator nhị phân DÙNG CHUNG. Trước đây route này chỉ kiểm
// `Content-Type` header (provider/CDN nào cũng có thể khai sai hoặc trả trang lỗi HTML với header
// content-type bị cấu hình nhầm) mà KHÔNG hề đọc byte thật. Nay bắt buộc đi qua đúng 1 hàm dùng
// chung với imageGenerationClient.js/live-image-check.js.
const { validateImageBuffer } = require('../utils/visual/imageBinaryValidator');

const router = express.Router();

/** MIME thật (đã validate) -> extension file tải xuống. Không bao giờ dùng .png cho binary khác. */
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** MỤC 6 (đợt audit 2): lấy MIME THẬT đã validate từ kết quả generateImage() để đặt tên file
 * đúng extension — không đoán, không mặc định .png. */
function mimeOfImgResult(img) {
  if (img.verifiedMime) return img.verifiedMime; // format:'image_url' — đã tự tải+validate ở imageGenerationClient.
  if (img.format === 'data_url' && typeof img.url === 'string') {
    const m = /^data:([^;]+);base64,/.exec(img.url);
    if (m) return m[1]; // Đây LÀ mime đã qua verifyImageBytes() ở imageGenerationClient (chữ ký byte thật, không phải nhãn provider).
  }
  return null;
}

// Domain ĐƯỢC PHÉP tải hộ. Thêm domain mới phải sửa đúng ở đây, không đọc từ env (env bị đổi là
// mở toang SSRF).
const ALLOWED_HOSTS = [
  'oaidalleapiprodscus.blob.core.windows.net', // OpenAI images (gpt-image-1 / dall-e)
  'cdn.openai.com',
  'generativelanguage.googleapis.com',         // Gemini file endpoint
  'storage.googleapis.com'
];

const MAX_BYTES = 12 * 1024 * 1024; // 12MB: ảnh 1024x1024 PNG thực tế < 3MB, đây là trần an toàn.
const FETCH_TIMEOUT_MS = 15000;

/** @returns {boolean} hostname có nằm trong whitelist (khớp đúng hoặc subdomain thật sự). */
function isAllowedHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => h === allowed || h.endsWith('.' + allowed));
}

/** @returns {URL|null} URL hợp lệ + được phép, null nếu không. */
function parseAllowedUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (!isAllowedHost(u.hostname)) return null;
  return u;
}

/**
 * Tên file tải xuống: `<subject>-<visualId>.<ext>` — KHÔNG chứa câu hỏi/dữ liệu nhạy cảm.
 *
 * MỤC 6 (đợt audit 2) — ROOT CAUSE: hàm cũ LUÔN gắn cứng `.png` bất kể binary thật là gì. Nếu
 * provider trả JPEG/WebP (item.output_format khác 'png'), người dùng bấm "Tải PNG" sẽ nhận một file
 * `.png` nhưng bên trong là JPEG/WebP thật — mở được (hầu hết hệ điều hành không kiểm extension) nên
 * lỗi ẩn, nhưng vẫn là GIẢ MẠO định dạng. Dự án CHƯA có thư viện convert ảnh (không có sharp/jimp
 * trong package.json — kiểm tra kỹ, không đoán) nên chọn lựa chọn A của yêu cầu: extension PHẢI
 * khớp ĐÚNG MIME thật đã validate, không giả vờ là .png khi không phải.
 * @param {string} subject
 * @param {string} visualId
 * @param {string} [detectedMime] MIME đã qua validateImageBuffer/validateImageBase64. Thiếu ->
 *   mặc định 'png' CHỈ ở call-site nào đã tự đảm bảo binary là PNG thật ở nơi khác (không dùng cho
 *   dữ liệu chưa validate).
 */
function safeFilename(subject, visualId, detectedMime) {
  const clean = (s, fallback) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || fallback;
  const ext = EXT_BY_MIME[String(detectedMime || '').toLowerCase()] || 'png';
  return `${clean(subject, 'visual')}-${clean(visualId, 'image')}.${ext}`;
}

router.get('/download', async (req, res) => {
  const target = parseAllowedUrl(req.query.url);
  if (!target) return res.status(400).json({ error: 'url_not_allowed' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let current = target;
    let upstream = null;
    for (let hop = 0; hop < 3; hop++) {
      upstream = await fetch(current.toString(), { redirect: 'manual', signal: controller.signal });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
        const next = parseAllowedUrl(new URL(upstream.headers.get('location'), current).toString());
        if (!next) return res.status(400).json({ error: 'redirect_not_allowed' });
        current = next;
        continue;
      }
      break;
    }
    if (!upstream || !upstream.ok) return res.status(502).json({ error: 'upstream_failed' });

    // Header content-type CHỈ dùng để loại nhanh trường hợp rõ ràng không phải ảnh (vd text/html của
    // trang lỗi) — KHÔNG bao giờ dùng làm bằng chứng cuối cùng để quyết định trả file cho client.
    const ctypeHeader = String(upstream.headers.get('content-type') || '');
    if (ctypeHeader && !/^image\//i.test(ctypeHeader)) {
      return res.status(415).json({ error: 'not_an_image', detail: 'content-type header: ' + ctypeHeader });
    }
    const len = Number(upstream.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

    // ============================================================================================
    // MỤC 5 (đợt audit 2) — ROOT CAUSE: route cũ dừng lại ở `content-type startsWith 'image/'`.
    // Header content-type đến từ CHÍNH upstream (provider/CDN) — nếu upstream trả trang lỗi/hết hạn
    // URL với header bị cấu hình sai (hoặc cố tình sai), client vẫn nhận "thành công" và tải về một
    // file .png rác. NAY: đọc byte thật bằng validator dùng chung — HTTP 200 + có content-type ảnh
    // KHÔNG BAO GIỜ được coi là đủ; chỉ khi magic bytes khớp mới trả file cho client.
    const validated = validateImageBuffer(buf, ctypeHeader);
    if (!validated.valid) {
      return res.status(502).json({ error: 'invalid_image_body', reason: validated.reason });
    }

    const filename = safeFilename(req.query.subject, req.query.visualId, validated.detectedMime);
    res.setHeader('Content-Type', validated.detectedMime); // MIME THẬT (chữ ký byte), không phải header upstream tự khai.
    res.setHeader('Content-Length', String(buf.length));
    // `inline=1`: dùng cho thẻ <img> (CSP img-src chỉ cho 'self'), không phải tải về.
    const inline = String(req.query.inline || '') === '1';
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(buf);
  } catch (e) {
    return res.status(502).json({ error: 'upstream_error' });
  } finally {
    clearTimeout(timer);
  }
});

// ============================================================================================
// MỤC 2.2 — POST /api/visual/hq : DỰNG LẠI ẢNH Ở 2048x2048, CHỈ KHI NGƯỜI DÙNG BẤM TƯỜNG MINH
// ============================================================================================
// Mặc định của hệ thống KHÔNG đổi: vẫn 1024x1024. Endpoint này chỉ chạy khi có thao tác tường minh
// và VẪN đi qua cost-gate theo `imageNecessity` giống hệt luồng chính — hình "có cũng được"
// (OPTIONAL/NONE) không được phép đốt một lượt gọi ảnh giá cao.
const hqStore = require('../utils/visual/visualHqStore');
const imageClient = require('../utils/visual/imageGenerationClient');

const HQ_SIZE = '2048x2048';

router.post('/hq', express.json({ limit: '4kb' }), async (req, res) => {
  const visualId = req.body && req.body.visualId;
  const ctx = hqStore.get(visualId);
  // Không còn ngữ cảnh (hết TTL, hoặc instance serverless khác) -> nói thẳng, KHÔNG đoán prompt.
  if (!ctx) return res.status(404).json({ error: 'visual_context_expired' });
  if (!imageClient.isConfigured()) return res.status(503).json({ error: 'no_image_provider' });

  // Cost-gate y hệt visualPipeline: 2048 luôn rơi vào nhóm chi phí cao hơn, nên chỉ hình THỰC SỰ
  // cần (NECESSARY) hoặc do người dùng yêu cầu mới được dựng lại.
  const costClass = imageClient.classifyImageCost({
    provider: imageClient.activeProviderName(), size: HQ_SIZE, renderer: 'image_generation'
  });
  const allowed = ctx.necessity === 'NECESSARY' || ctx.necessity === 'USER_REQUESTED';
  if (costClass === imageClient.IMAGE_COST.HIGH && !allowed) {
    return res.status(429).json({ error: 'cost_gate_low_benefit', necessity: ctx.necessity });
  }

  const img = await imageClient.generateImage({ prompt: ctx.prompt, size: HQ_SIZE, timeoutMs: 30000 });
  // MỤC 9 (đợt audit 2): img.ok=true GIỜ ĐÃ tương đương "binary thật, đã validate" (xem mục 3/8 ở
  // imageGenerationClient.js — cả nhánh base64 lẫn image_url đều tự validate trước khi trả ok:true).
  // Route này KHÔNG cần validate lại — chỉ cần không bao giờ trả ok:true khi img.ok=false.
  if (!img.ok) return res.status(502).json({ ok: false, error: img.reason || 'image_failed' });
  return res.json({
    ok: true, format: img.format, url: img.url, size: HQ_SIZE,
    renderer: 'generated_image', origin: 'ai_generated', model: img.model,
    filename: safeFilename(ctx.subject, visualId, mimeOfImgResult(img))
  });
});

// ============================================================================================
// MỤC 7 — GET /api/visual/status : DEBUG/OBSERVABILITY AN TOÀN (KHÔNG BAO GIỜ LỘ API KEY)
// ============================================================================================
router.get('/status', (req, res) => {
  const providers = imageClient.listImageProviders().map((p) => ({
    name: p.name,
    configured: true,
    model: p.model,
    keySource: p.keySource, // 'image_specific' | 'text_reuse' — không phải khóa, chỉ nguồn gốc.
    capability: 'text-to-image',
    costClass: p.costClass,
    status: 'ready'
  }));
  res.json({
    imageGenerationEnabled: imageClient.isConfigured(),
    activeProvider: imageClient.activeProviderName(),
    providers
  });
});

// ============================================================================================
// MỤC 17 — POST /api/visual/retry : TẠO LẠI ĐÚNG 1 HÌNH ĐÃ THẤT BẠI, KHÔNG ĐỘNG VÀO TEXT ANSWER
// ============================================================================================
// Dùng lại visualHqStore (visualPipeline.js đã `remember()` prompt/necessity/title/subject của
// đúng hình vừa fail, kể cả khi generation KHÔNG thành công — xem mục 16/17 trong visualPipeline.js).
// Ở mức 1024x1024 (mặc định), khác /hq (2048x2048, chỉ khi bấm tường minh "Tải chất lượng cao").
// Failover giữa các provider ảnh đã có sẵn trong imageClient.generateImage() — không cần lặp ở đây.
router.post('/retry', express.json({ limit: '4kb' }), async (req, res) => {
  const visualId = req.body && req.body.visualId;
  const ctx = hqStore.get(visualId);
  if (!ctx) return res.status(404).json({ error: 'visual_context_expired' });
  if (!imageClient.isConfigured()) return res.status(503).json({ error: 'no_image_provider' });

  const img = await imageClient.generateImage({ prompt: ctx.prompt, size: '1024x1024', timeoutMs: 20000 });
  if (!img.ok) {
    return res.status(502).json({ error: img.reason || 'image_generation_failed', providersTried: img.providersTried || [] });
  }
  // Ghi lại ngữ cảnh dưới CHÍNH visualId cũ: nếu client bấm "Thử tạo lại" hoặc "Tải chất lượng cao"
  // lần nữa sau khi đã thành công, ngữ cảnh vẫn còn (TTL được làm mới).
  hqStore.remember(visualId, ctx);
  return res.json({
    ok: true, visualId,
    format: img.format, url: img.url, model: img.model,
    renderer: 'generated_image', origin: 'ai_generated', fidelity: 'illustrative',
    necessity: ctx.necessity, subject: ctx.subject, title: ctx.title
  });
});

module.exports = router;
module.exports.isAllowedHost = isAllowedHost;
module.exports.parseAllowedUrl = parseAllowedUrl;
module.exports.safeFilename = safeFilename;
module.exports.ALLOWED_HOSTS = ALLOWED_HOSTS;
