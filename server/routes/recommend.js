'use strict';

const express = require('express');
const router = express.Router();

// ============================================================================================
// REWORK: trước đây route này gọi AI (callClaudeWebSearch) CHẠY SONG SONG với lượt AI đang giải
// bài ở /api/chat mỗi khi người dùng gửi câu hỏi — tốn thêm 1 lượt gọi AI, cạnh tranh hạn mức/độ
// trễ với chính câu trả lời chính, mà kết quả cuối cùng (khi không tìm được/lỗi/hết giờ) vẫn luôn
// rơi về đúng danh sách link Google tìm-giới-hạn-theo-site bên dưới (buildSuggestedLinks).
//
// Giờ bỏ HẲN bước gọi AI: route CHỈ còn tạo trực tiếp danh sách link "site:<domain> + câu hỏi" trỏ
// tới các trang tài liệu/bài tập tiếng Việt uy tín — không cần AI, không cần tìm kiếm web thật, trả
// về NGAY LẬP TỨC. Link dạng "site:" luôn hợp lệ và ra kết quả thật do Google tự tìm, không có rủi
// ro link chết/bịa như khi để AI tự "nhớ" ra 1 URL cụ thể.
// ============================================================================================

const PRIORITY_SITES = [
  'studocu.vn', 'loigiaihay.com', 'vietjack.com', 'tailieumoi.vn',
  'hoc247.net', 'download.vn', 'thuvienhoclieu.com', 'hocmai.vn', 'doctailieu.com'
];

const MAX_QUERY_LEN = 800;
const MAX_LINKS = 6;

// Sinh danh sách link gợi ý — mỗi phần tử là 1 link tìm kiếm Google giới hạn trong đúng 1 trang uy
// tín (site:domain + nội dung câu hỏi), kèm 1 link "tìm trên toàn bộ Google" (không giới hạn site)
// đặt cuối cùng, phòng trường hợp các trang ưu tiên không có tài liệu phù hợp cho chủ đề hiếm gặp.
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

router.post('/', (req, res, next) => {
  try {
    const rawQuery = String((req.body && req.body.query) || '').trim();
    if (!rawQuery) return res.status(400).json({ error: 'Thiếu nội dung câu hỏi cần tìm tài liệu liên quan.' });
    const query = rawQuery.slice(0, MAX_QUERY_LEN);
    const topic = query.length > 90 ? query.slice(0, 90) + '…' : query;
    const links = buildSuggestedLinks(query);
    res.json({ topic, links });
  } catch (err) { next(err); }
});

module.exports = router;
