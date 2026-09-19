'use strict';

// Đây là entry point mà Vercel tìm và chạy như một Serverless Function.
// Nó chỉ đơn giản export lại toàn bộ Express app (đã cấu hình routes, bảo mật, v.v.
// trong server/app.js) — Vercel sẽ tự bọc app này để xử lý request/response.
module.exports = require('../server/app');
