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
const safeHttp = require('../utils/safeHttp');

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

  // PHẦN L: mỗi chặng redirect PHẢI đi lại đủ 3 lớp — whitelist hostname, DNS ra địa chỉ PUBLIC,
  // và kết nối tới ĐÚNG địa chỉ đã kiểm (ghim IP, chống DNS rebinding). Trần byte áp trên luồng.
  let current = target;
  let result = null;
  for (let hop = 0; hop < 3; hop++) {
    result = await safeHttp.fetchPinned(current, { maxBytes: MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS });
    if (!result.ok) {
      if (result.reason === 'too_large') return res.status(413).json({ error: 'too_large' });
      if (result.reason === 'blocked_ip') return res.status(400).json({ error: 'url_not_allowed' });
      if (result.reason === 'dns_failed' || result.reason === 'dns_empty') return res.status(502).json({ error: 'upstream_unreachable' });
      return res.status(502).json({ error: 'upstream_error' });
    }
    if (result.location) {
      let nextUrl;
      try { nextUrl = new URL(result.location, current); } catch (e) { return res.status(400).json({ error: 'redirect_not_allowed' }); }
      const next = parseAllowedUrl(nextUrl.toString());
      if (!next) return res.status(400).json({ error: 'redirect_not_allowed' });
      current = next;
      continue;
    }
    break;
  }
  if (!result || !result.ok || result.location) return res.status(502).json({ error: 'too_many_redirects' });
  if (!result.body || result.status < 200 || result.status >= 300) return res.status(502).json({ error: 'upstream_failed' });

  // Header content-type CHỈ dùng để loại nhanh trường hợp rõ ràng không phải ảnh — KHÔNG bao giờ là
  // bằng chứng cuối cùng (xem validateImageBuffer bên dưới: chữ ký byte thật mới quyết định).
  const ctypeHeader = String(result.headers['content-type'] || '');
  if (ctypeHeader && !/^image\//i.test(ctypeHeader)) {
    return res.status(415).json({ error: 'not_an_image' });
  }
  const buf = result.body;
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

  const validated = validateImageBuffer(buf, ctypeHeader);
  if (!validated.valid) {
    return res.status(502).json({ error: 'invalid_image_body', reason: validated.reason });
  }

  const filename = safeFilename(req.query.subject, req.query.visualId, validated.detectedMime);
  res.setHeader('Content-Type', validated.detectedMime); // MIME THẬT (chữ ký byte), không phải header upstream tự khai.
  res.setHeader('Content-Length', String(buf.length));
  const inline = String(req.query.inline || '') === '1';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(buf);
});

// ============================================================================================
// MỤC 2.2 — POST /api/visual/hq : DỰNG LẠI ẢNH Ở 2048x2048, CHỈ KHI NGƯỜI DÙNG BẤM TƯỜNG MINH
// ============================================================================================
// Mặc định của hệ thống KHÔNG đổi: vẫn 1024x1024. Endpoint này chỉ chạy khi có thao tác tường minh
// và VẪN đi qua cost-gate theo `imageNecessity` giống hệt luồng chính — hình "có cũng được"
// (OPTIONAL/NONE) không được phép đốt một lượt gọi ảnh giá cao.
const hqStore = require('../utils/visual/visualHqStore');
const imageClient = require('../utils/visual/imageGenerationClient');
const assetStore = require('../utils/visual/visualAssetStore');
const responseGuard = require('../utils/visual/visualResponseGuard');

// ============================================================================================
// PHẦN B — GET /api/visual/asset/:id : TRẢ BYTE ẢNH RA NGOÀI RESPONSE JSON
// ============================================================================================
// Ảnh đi bằng request riêng nên KHÔNG bao giờ cộng vào trần 4.5MB của /api/chat. ID do server sinh
// ngẫu nhiên 128 bit, TTL ngắn, không mang thông tin nào về câu hỏi/lời giải.
router.get('/asset/:id', async (req, res) => {
  const found = await assetStore.get(req.params.id);
  if (!found) return res.status(404).json({ error: 'asset_expired' });
  // Byte trong store ĐÃ được validateImageBuffer() ở imageGenerationClient trước khi tới đây; kiểm
  // lại chữ ký một lần nữa vì đây là nơi byte rời khỏi server tới trình duyệt.
  const validated = validateImageBuffer(found.buffer, found.mime);
  if (!validated.valid) return res.status(502).json({ error: 'invalid_image_body', reason: validated.reason });
  res.setHeader('Content-Type', validated.detectedMime);
  res.setHeader('Content-Length', String(found.buffer.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  const inline = String(req.query.inline || '') === '1';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeFilename(req.query.subject, req.params.id, validated.detectedMime)}"`);
  return res.end(found.buffer);
});

const HQ_SIZE = '2048x2048';

router.post('/hq', express.json({ limit: '4kb' }), async (req, res) => {
  const visualId = req.body && req.body.visualId;
  const ctx = await hqStore.get(visualId);
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
  // PHẦN B5: ảnh 2048x2048 base64 gần như chắc chắn vượt trần response nếu nhúng thẳng vào JSON.
  const prepared = await responseGuard.prepareResponsePayload({
    ok: true, size: HQ_SIZE, renderer: 'generated_image', origin: 'ai_generated', model: img.model,
    filename: safeFilename(ctx.subject, visualId, mimeOfImgResult(img)),
    visuals: [{ visualId, format: img.format, url: img.url }]
  });
  const out = prepared.payload;
  const first = (out.visuals || [])[0] || {};
  if (!first.url) return res.status(503).json({ ok: false, error: first.error || 'image_too_large_for_response' });
  return res.json({ ...out, visuals: undefined, format: first.format, url: first.url, assetId: first.assetId });
});

// ============================================================================================
// MỤC 7 — GET /api/visual/status : DEBUG/OBSERVABILITY AN TOÀN (KHÔNG BAO GIỜ LỘ API KEY)
// ============================================================================================
router.get('/status', (req, res) => {
  const circuits = imageClient.circuitSnapshot();
  const providers = imageClient.listImageProviders().map((p) => {
    const c = circuits[p.name];
    return {
      name: p.name,
      configured: true,
      model: p.model,
      keySource: p.keySource, // 'image_specific' | 'text_reuse' — không phải khóa, chỉ nguồn gốc.
      capability: 'text-to-image',
      costClass: p.costClass,
      // MỤC XXII/XXIII (đợt audit 6): trạng thái self-healing circuit breaker — 'cooldown' nghĩa là
      // provider vừa lỗi liên tiếp và đang bị hạ ưu tiên tạm thời, KHÔNG phải bị loại vĩnh viễn.
      status: imageClient.isCircuitOpen(p.name) ? 'cooldown' : 'ready',
      circuitState: c ? c.state : 'closed',
      failureCount: c ? c.consecutiveFailures : 0,
      lastSuccess: c ? c.lastSuccess : null,
      lastFailure: c ? c.lastFailure : null
    };
  });
  res.json({
    imageGenerationEnabled: imageClient.isConfigured(),
    activeProvider: imageClient.activeProviderName(),
    // PHẦN H/B: nói THẬT về khả năng sống qua nhiều instance. `false` nghĩa là retry/HQ/asset chỉ
    // hoạt động chắc chắn khi chạy 1 tiến trình (local/VPS) — không được tuyên bố ngược lại.
    contextStoreDurable: hqStore.isDurable(),
    assetStoreDurable: assetStore.isDurable(),
    multiInstanceRuntime: responseGuard.isMultiInstanceRuntime(),
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
  const ctx = await hqStore.get(visualId);
  if (!ctx) return res.status(404).json({ error: 'visual_context_expired' });
  if (!imageClient.isConfigured()) return res.status(503).json({ error: 'no_image_provider' });

  const img = await imageClient.generateImage({ prompt: ctx.prompt, size: '1024x1024', timeoutMs: 20000 });
  if (!img.ok) {
    return res.status(502).json({ error: img.reason || 'image_generation_failed', providersTried: img.providersTried || [] });
  }
  // Ghi lại ngữ cảnh dưới CHÍNH visualId cũ: nếu client bấm "Thử tạo lại" hoặc "Tải chất lượng cao"
  // lần nữa sau khi đã thành công, ngữ cảnh vẫn còn (TTL được làm mới).
  await hqStore.remember(visualId, ctx);
  const preparedRetry = await responseGuard.prepareResponsePayload({
    ok: true, visualId, model: img.model,
    renderer: 'generated_image', origin: 'ai_generated', fidelity: 'illustrative',
    necessity: ctx.necessity, subject: ctx.subject, title: ctx.title,
    visuals: [{ visualId, format: img.format, url: img.url }]
  });
  const retryOut = preparedRetry.payload;
  const retryFirst = (retryOut.visuals || [])[0] || {};
  if (!retryFirst.url) return res.status(503).json({ ok: false, error: retryFirst.error || 'image_too_large_for_response' });
  return res.json({ ...retryOut, visuals: undefined, format: retryFirst.format, url: retryFirst.url, assetId: retryFirst.assetId });
});

module.exports = router;
module.exports.isAllowedHost = isAllowedHost;
module.exports.parseAllowedUrl = parseAllowedUrl;
module.exports.safeFilename = safeFilename;
module.exports.ALLOWED_HOSTS = ALLOWED_HOSTS;
module.exports.isBlockedAddress = safeHttp.isBlockedAddress;
