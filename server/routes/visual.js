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

const router = express.Router();

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

/** Tên file tải xuống: `<subject>-<visualId>.png` — KHÔNG chứa câu hỏi/dữ liệu nhạy cảm. */
function safeFilename(subject, visualId) {
  const clean = (s, fallback) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || fallback;
  return `${clean(subject, 'visual')}-${clean(visualId, 'image')}.png`;
}

router.get('/download', async (req, res) => {
  const target = parseAllowedUrl(req.query.url);
  if (!target) return res.status(400).json({ error: 'url_not_allowed' });

  const filename = safeFilename(req.query.subject, req.query.visualId);
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

    const ctype = String(upstream.headers.get('content-type') || '');
    if (!/^image\//i.test(ctype)) return res.status(415).json({ error: 'not_an_image' });
    const len = Number(upstream.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

    res.setHeader('Content-Type', ctype);
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
  if (!img.ok) return res.status(502).json({ error: img.reason || 'image_failed' });
  return res.json({
    ok: true, format: img.format, url: img.url, size: HQ_SIZE,
    filename: safeFilename(ctx.subject, visualId)
  });
});

module.exports = router;
module.exports.isAllowedHost = isAllowedHost;
module.exports.parseAllowedUrl = parseAllowedUrl;
module.exports.safeFilename = safeFilename;
module.exports.ALLOWED_HOSTS = ALLOWED_HOSTS;
