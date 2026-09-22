'use strict';

const express = require('express');
const router = express.Router();
const { getActiveProviders, ensureProvidersReady, callWithFailover } = require('../utils/aiProviders');
const anthropicClient = require('../utils/anthropicClient');
const { buildRecommendSystemPrompt } = require('../utils/promptBuilder');
const { parseJSONSafe } = require('../utils/jsonSafe');
const { createRecommendCache } = require('../utils/recommendCache');

// ============================================================================================
// REWORK (lần 2): route này từng gọi AI CHẠY SONG SONG với lượt AI đang giải bài ở /api/chat mỗi
// khi người dùng gửi câu hỏi, rồi frontend TỰ ĐỘNG MỞ khung "Đề xuất ôn tập" ngay khi request bắt
// đầu — gây cảm giác "popup" làm phiền mỗi lượt chat. Bản trước đó (REWORK lần 1, xem lịch sử) đã
// bỏ hẳn AI để tránh vấn đề "chờ lâu + tốn hạn mức", nhưng đổi lại link chỉ còn là "site:<domain> +
// câu hỏi" — không phải kết quả tìm kiếm thật, không có tiêu đề/mô tả sát nội dung.
//
// Giờ đưa AI + tìm kiếm web THẬT trở lại, nhưng xử lý đúng 2 vấn đề gốc theo hướng khác:
//  1) "Cần cấu hình Claude" — KHÔNG còn đúng: route này lọc TẤT CẢ provider đang hoạt động
//     (getActiveProviders(), gồm cả provider bổ sung khai trong extraProviders.js) có
//     `supportsWebSearch === true`, rồi dùng callWithFailover() — hàm này đã XÁO TRỘN NGẪU NHIÊN
//     thứ tự thử (xem shuffle() trong aiProviders.js) nên KHÔNG có provider nào (kể cả Claude) được
//     ưu tiên cố định; hễ có ÍT NHẤT 1 provider hỗ trợ web search cấu hình khóa API là dùng được,
//     bất kể đó là Claude/GPT/Gemini hay provider bổ sung nào hỗ trợ web search.
//  2) "Popup gây khó chịu khi AI đang trả lời" — xử lý ở FRONTEND (public/js/app.js,
//     scheduleRecommend()): request này giờ chạy NGẦM, không tự mở panel; kết quả được lặng lẽ nạp
//     vào khung, kèm 1 dấu chấm báo (badge) nhỏ trên nút mở — người dùng chủ động bấm nút để xem.
//
// Vẫn giữ buildSuggestedLinks() (site: link tĩnh) làm PHƯƠNG ÁN DỰ PHÒNG — dùng khi: chưa có
// provider nào hỗ trợ web search được cấu hình khóa API, TẤT CẢ provider đó lỗi/timeout, hoặc AI
// không trả về JSON hợp lệ/không tìm ra link nào — đảm bảo khung "Đề xuất ôn tập" KHÔNG BAO GIỜ
// trống trơn dù AI có trục trặc.
// ============================================================================================

const PRIORITY_SITES = [
  'studocu.vn', 'loigiaihay.com', 'vietjack.com', 'tailieumoi.vn',
  'hoc247.net', 'download.vn', 'thuvienhoclieu.com', 'hocmai.vn', 'doctailieu.com'
];

const MAX_QUERY_LEN = 800;
const MAX_LINKS = 6;
// Timeout riêng cho lượt gọi AI TÌM KIẾM này — độc lập với REQUEST_TIMEOUT_MS dùng cho /api/chat.
// Vì giờ chạy NGẦM (không chặn UI chính, xem comment ở trên), chấp nhận chờ lâu hơn 1 chút để có
// cơ hội tìm kiếm web thật xong trước khi rơi về fallback tĩnh.
const RECOMMEND_TIMEOUT_MS = Number(process.env.RECOMMEND_TIMEOUT_MS) || 14000;

// PHẦN 17 FIX: CACHE THEO NORMALIZED QUERY — trước đây MỌI lượt bấm mở khung "Đề xuất ôn tập" đều
// gọi AI mới hoàn toàn, kể cả khi 2 người dùng (hoặc cùng 1 người load lại trang) hỏi ĐÚNG 1 câu.
// "CACHE BEFORE CALL" (nguyên tắc #1) — cache hit trả thẳng, KHÔNG gọi AI. TTL vừa đủ để tài liệu
// gợi ý không bị lỗi thời quá lâu (nội dung ôn tập ít thay đổi theo giờ/ngày).
const RECOMMEND_CACHE_TTL_MS = Number(process.env.RECOMMEND_CACHE_TTL_MS) || 30 * 60 * 1000; // 30 phút
const recommendCache = createRecommendCache({ ttlMs: RECOMMEND_CACHE_TTL_MS, promptVersion: 'recommend-v1' });

// Sinh danh sách link DỰ PHÒNG — mỗi phần tử là 1 link tìm kiếm Google giới hạn trong đúng 1 trang
// uy tín (site:domain + nội dung câu hỏi), kèm 1 link "tìm trên toàn bộ Google" (không giới hạn
// site) đặt cuối cùng. Không cần AI, không có rủi ro link chết/bịa vì Google tự tìm kết quả thật.
function buildSuggestedLinks(query) {
  const shortQuery = query.slice(0, 120);
  const q = encodeURIComponent(shortQuery);
  const siteLinks = PRIORITY_SITES.slice(0, MAX_LINKS - 1).map((domain) => ({
    url: `https://www.google.com/search?q=${encodeURIComponent('site:' + domain)}+${q}`,
    title: `Tìm trên ${domain}`,
    note: `Kết quả tìm kiếm Google giới hạn trong ${domain}`,
    domain
  }));
  siteLinks.push({
    url: `https://www.google.com/search?q=${q}+bài+tập+tài+liệu`,
    title: 'Tìm rộng hơn trên Google',
    note: 'Không giới hạn theo trang cụ thể — dùng khi các trang trên chưa có kết quả phù hợp',
    domain: 'google.com'
  });
  return siteLinks;
}

// ============================================================================================
// V6.16.2/V6.16.26 — GAP ĐÃ PHÁT HIỆN QUA AUDIT: `anthropicClient.callClaudeWebSearch()` (hàm DUY
// NHẤT trong codebase trả về URL THẬT từ web_search_tool_result) được export nhưng KHÔNG NƠI NÀO
// gọi. Route này (TRƯỚC KHI vá) gọi callWithFailover() (generic, đa provider) rồi TIN THẲNG URL
// model tự viết ra trong JSON — vi phạm "model says 'Nguồn: url' không đủ, phải có tool result
// chứa URL đó" (V6.16.26). Phần sanitize/grounding thuần (0 dependency) đã tách ra
// server/utils/source/linkGrounding.js để test trực tiếp không cần `npm install` — cùng quy ước
// với citationValidator.js/sourceProvenance.js. Chi tiết 2 đường GROUNDED/UNGROUNDED: xem comment
// đầu file linkGrounding.js.
const { sanitizeGroundedLinks, domainOnlySearchLinks } = require('../utils/source/linkGrounding');

/**
 * Đường CÓ GROUNDING THẬT: chỉ dùng khi ANTHROPIC_API_KEY được cấu hình. Gọi thẳng
 * callClaudeWebSearch() (không qua callWithFailover, vì đây là hàm DUY NHẤT trả về `results` —
 * danh sách URL thật mà Anthropic đã tự query) rồi sanitizeGroundedLinks() đối chiếu.
 * Trả về null nếu không cấu hình/lỗi/không có link nào khớp registry — KHÔNG throw.
 */
async function fetchGroundedLinks(query) {
  if (!anthropicClient.isConfigured()) return null;
  try {
    const { text, results } = await anthropicClient.callClaudeWebSearch({
      system: buildRecommendSystemPrompt(),
      messages: [{ role: 'user', content: query }],
      maxTokens: 1350,
      timeoutMs: RECOMMEND_TIMEOUT_MS
    });
    const parsed = parseJSONSafe(text);
    const links = sanitizeGroundedLinks(parsed.links, (results || []).map((r) => r.url));
    return links.length ? links : null;
  } catch (err) {
    return null;
  }
}

// Gọi AI + web search (đa provider, KHÔNG có grounding URL thật — xem ghi chú đầu file) để tìm
// domain liên quan tới câu hỏi. Trả về null (KHÔNG throw) khi không có provider phù hợp/AI lỗi/
// không tìm ra domain nào — để router bên dưới rơi thẳng về fallback tĩnh.
async function fetchAiLinks(query) {
  await ensureProvidersReady();
  const webSearchProviders = getActiveProviders().filter((p) => p.supportsWebSearch && p.providerKey !== 'anthropic');
  if (!webSearchProviders.length) return null; // chưa cấu hình provider nào hỗ trợ web search

  try {
    const { text } = await callWithFailover(webSearchProviders, {
      system: buildRecommendSystemPrompt(),
      messages: [{ role: 'user', content: query }],
      maxTokens: 1350,
      webSearch: true,
      timeoutMs: RECOMMEND_TIMEOUT_MS
    });
    const parsed = parseJSONSafe(text);
    // KHÔNG tin URL model viết ra ở đây: OpenAI/Gemini qua callWithFailover chỉ trả text tổng hợp,
    // codebase hiện chưa parse được tool-result URL thật của 2 provider này (khác Anthropic). Hạ
    // cấp về link "site:domain" (Google tự resolve thật, không có rủi ro link chết/bịa).
    const links = domainOnlySearchLinks(parsed.links, query);
    return links.length ? links : null;
  } catch (err) {
    return null; // mọi lỗi (timeout, tất cả provider lỗi, JSON hỏng...) đều rơi về fallback tĩnh
  }
}

router.post('/', async (req, res, next) => {
  try {
    const rawQuery = String((req.body && req.body.query) || '').trim();
    if (!rawQuery) return res.status(400).json({ error: 'Thiếu nội dung câu hỏi cần tìm tài liệu liên quan.' });
    const query = rawQuery.slice(0, MAX_QUERY_LEN);
    const topic = query.length > 90 ? query.slice(0, 90) + '…' : query;

    // PHẦN 17 FIX: CACHE BEFORE CALL — cache hit trả thẳng, KHÔNG gọi AI, KHÔNG cả ensureProvidersReady().
    // PHẦN I: đọc L1 trước, rồi L2 (KV) nếu có — cache hit ở BẤT KỲ tầng nào cũng trả thẳng, KHÔNG
    // gọi AI. Không có L2 -> hành vi y hệt trước (best-effort, process-local).
    const cached = await recommendCache.getAsync(query);
    if (cached) return res.json({ ...cached, fromCache: true, cacheTier: recommendCache.tiers() });

    const aiLinks = (await fetchGroundedLinks(query)) || (await fetchAiLinks(query));
    const links = aiLinks || buildSuggestedLinks(query);
    const payload = { topic, links, source: aiLinks ? 'ai' : 'fallback' };
    await recommendCache.setAsync(query, payload); // ghi cả L1 và L2 (nếu có); L2 lỗi không chặn response
    res.json(payload);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.__test__ = { buildSuggestedLinks, recommendCache };
