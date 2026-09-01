'use strict';

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// ---------- CORS ----------
// LỖI GỐC (khi deploy lên Vercel): danh sách allowedOrigins mặc định chỉ có
// 'http://localhost:3000'. Khi lên Vercel, frontend gọi API bằng fetch('/api/...')
// — CÙNG origin với domain Vercel (vd https://ten-app.vercel.app) — nhưng trình duyệt
// vẫn gửi kèm header Origin cho các request POST/JSON, và vì domain Vercel đó không
// nằm trong danh sách whitelist (không ai cấu hình ALLOWED_ORIGINS trong .env trên Vercel)
// nên middleware `cors` từ chối ngay lập tức => lỗi "Origin không được phép bởi chính
// sách CORS." xuất hiện trên MỌI request, kể cả request cùng-origin hợp lệ.
//
// FIX: tự động cho phép mọi origin CÙNG HOST với chính request đó (so khớp với header
// Host mà Vercel/Express nhận được) — đây là trường hợp phổ biến nhất vì dự án này
// phục vụ chung frontend + backend trên cùng 1 domain. Danh sách ALLOWED_ORIGINS trong
// .env vẫn được tôn trọng để mở rộng thêm cho các domain KHÁC (vd domain frontend tách
// riêng, custom domain, app di động...).
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isSameHostOrigin(origin, req) {
  try {
    const originHost = new URL(origin).host; // vd "ten-app.vercel.app"
    const reqHost = req.headers['x-forwarded-host'] || req.headers.host; // Vercel set x-forwarded-host
    return !!reqHost && originHost === String(reqHost).split(',')[0].trim();
  } catch (e) {
    return false;
  }
}

const corsOptions = cors((req, callback) => {
  const origin = req.header('Origin');
  let allow = true; // không có Origin (Postman, curl, cùng-origin không gửi header) => cho phép
  if (origin) {
    allow = configuredOrigins.includes(origin) || isSameHostOrigin(origin, req);
  }
  callback(null, {
    origin: allow,
    methods: ['GET', 'POST'],
    credentials: false
  });
});

// ---------- Helmet: thiết lập các HTTP header bảo mật + Content-Security-Policy ----------
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // LỖI GỐC: docx.js được nạp từ https://cdn.jsdelivr.net (xem public/index.html) nhưng
      // scriptSrc ở đây trước đó chỉ cho phép 'self' và cdnjs.cloudflare.com => trình duyệt CHẶN
      // script docx theo đúng Content-Security-Policy => biến toàn cục "docx" không tồn tại =>
      // "docx is not defined" khi buildOutlineDocxBlob() chạy. FIX: thêm cdn.jsdelivr.net vào danh
      // sách nguồn script được phép (không phải lỗi CORS/mạng, mà là CSP tự chặn tài nguyên hợp lệ).
      scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:', 'https://cdnjs.cloudflare.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
});

// ---------- Rate limit: chống spam & giới hạn chi phí gọi Anthropic API ----------
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_CHAT || 40),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Bạn đã gửi quá nhiều câu hỏi. Vui lòng thử lại sau ít phút.' }
});

const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_GENERATE || 15),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Bạn đã tạo quá nhiều slide/flashcard. Vui lòng thử lại sau ít phút.' }
});

// Giới hạn RIÊNG cho "Đề xuất ôn tập" (tách khỏi chatLimiter) — request này chạy NGẦM song song mỗi
// khi người dùng gửi câu hỏi (xem public/js/app.js scheduleRecommend()), nên cần hạn mức RỘNG hơn
// (gần bằng chatLimiter) để không bị chặn giữa chừng trong một phiên hỏi nhiều câu bình thường.
const recommendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_RECOMMEND || 40),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Bạn đã tìm quá nhiều lượt đề xuất tài liệu. Vui lòng thử lại sau ít phút.' }
});

// ---------- Khóa dùng chung tùy chọn (basic gate, không phải xác thực người dùng thật sự) ----------
function appKeyGate(req, res, next) {
  const required = process.env.APP_SHARED_KEY;
  if (!required) return next(); // không bật nếu chưa cấu hình trong .env
  const provided = req.header('x-app-key');
  if (provided !== required) {
    return res.status(401).json({ error: 'Thiếu hoặc sai khóa truy cập ứng dụng.' });
  }
  next();
}

module.exports = { corsOptions, helmetConfig, chatLimiter, generateLimiter, recommendLimiter, appKeyGate };
