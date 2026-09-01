'use strict';

const express = require('express');
const router = express.Router();
const { getActiveProviders, callWithFailover } = require('../utils/aiProviders');
const { buildRecommendSystemPrompt } = require('../utils/promptBuilder');
const { parseJSONSafe } = require('../utils/jsonSafe');

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

// Lọc + chuẩn hoá danh sách link AI trả về: chỉ giữ url http(s) hợp lệ, cắt độ dài title/note, bỏ
// trùng domain (AI đôi khi trả nhiều link cùng 1 trang), giới hạn tối đa MAX_LINKS.
function sanitizeAiLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) return [];
  const seenDomains = new Set();
  const out = [];
  for (const item of rawLinks) {
    if (!item || typeof item.url !== 'string') continue;
    let url;
    try { url = new URL(item.url); } catch (e) { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const domain = url.hostname.replace(/^www\./, '');
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    out.push({
      url: url.toString(),
      title: String(item.title || domain).trim().slice(0, 120),
      note: String(item.note || '').trim().slice(0, 200),
      domain
    });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

// Gọi AI + web search thật để tìm link liên quan tới câu hỏi. Trả về null (KHÔNG throw) khi không
// có provider phù hợp/AI lỗi/không tìm ra link nào — để router bên dưới rơi thẳng về fallback tĩnh
// mà không cần try/catch lồng nhau ở nơi gọi.
async function fetchAiLinks(query) {
  const webSearchProviders = getActiveProviders().filter((p) => p.supportsWebSearch);
  if (!webSearchProviders.length) return null; // chưa cấu hình provider nào hỗ trợ web search

  try {
    const { text } = await callWithFailover(webSearchProviders, {
      system: buildRecommendSystemPrompt(),
      messages: [{ role: 'user', content: query }],
      maxTokens: 900,
      webSearch: true,
      timeoutMs: RECOMMEND_TIMEOUT_MS
    });
    const parsed = parseJSONSafe(text);
    const links = sanitizeAiLinks(parsed.links);
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

    const aiLinks = await fetchAiLinks(query);
    const links = aiLinks || buildSuggestedLinks(query);
    res.json({ topic, links, source: aiLinks ? 'ai' : 'fallback' });
  } catch (err) { next(err); }
});

module.exports = router;
