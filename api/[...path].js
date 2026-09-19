'use strict';

// ============================================================================================
// PHẦN M — ĐỊNH TUYẾN /api/* TRÊN VERCEL MÀ KHÔNG GIẢ ĐỊNH GÌ VỀ REWRITE
// ============================================================================================
// TRƯỚC ĐÂY vercel.json có: { "source": "/api/:path*", "destination": "/api" }. Rewrite này gộp mọi
// đường dẫn con về đúng một đích "/api" — một GIẢ ĐỊNH về việc Express vẫn nhìn thấy path gốc, và
// giả định đó không được bảo đảm ở đâu cả: nếu nền tảng viết lại req.url thành "/api", toàn bộ
// router con (/api/chat, /api/generate/flashcards, /api/visual/status...) rơi xuống notFoundHandler.
//
// NAY dùng ĐÚNG cơ chế định tuyến theo tệp của Vercel: tệp catch-all này khớp mọi /api/<subpath> và
// nhận nguyên vẹn URL gốc trong req.url, nên Express định tuyến y hệt khi chạy local. Không còn
// rewrite nào cho /api trong vercel.json (xem tệp đó), tức là không còn giả định nào để sai.
//
// /api (không có subpath) do api/index.js phục vụ — cùng một app Express.
module.exports = require('../server/app');
