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
      // FIX ROOT CAUSE (iPhone/Safari "Không thể khởi động ứng dụng" — xem index.html): pdf.js,
      // mammoth, KaTeX, math.js, three.js, docx.js giờ tự host trong /public/vendor (cùng-origin),
      // KHÔNG còn tải từ cdnjs.cloudflare.com / cdn.jsdelivr.net nữa — loại bỏ hẳn class lỗi CDN
      // (bị content-blocker chặn domain, SRI mismatch do bug cache Safari, DNS/firewall mạng công
      // ty/trường học...) thay vì chỉ mở CSP cho các domain đó. scriptSrc/styleSrc/fontSrc/
      // workerSrc do đó thu hẹp lại chỉ còn 'self' (+ Google Fonts cho font chữ giao diện, không
      // phải thư viện chức năng nào phụ thuộc cứng vào nó).
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      // pdf.worker.min.js giờ tự host tại /vendor/pdfjs/pdf.worker.min.js (cùng-origin) — 'self' +
      // blob: (Worker tạo qua Blob URL nội bộ của pdf.js) là đủ, không cần domain CDN nào nữa.
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  // FIX P2/N (audit deployment smoke-test): Helmet mặc định X-Frame-Options: SAMEORIGIN, nhưng
  // vercel.json khai báo tường minh DENY cho header edge/static của Vercel — 2 nơi lệch nhau khiến
  // hành vi Express thuần (local `npm start`, hoặc deploy ngoài Vercel như Railway/Render/Fly.io mà
  // README có đề cập) KHÔNG giống Vercel production. Vì CSP ở trên đã có frameAncestors:['none']
  // (tương đương DENY, trình duyệt hiện đại ưu tiên CSP hơn X-Frame-Options) nên đây chỉ là lớp dự
  // phòng cho trình duyệt cũ — nhưng đặt tường minh 'deny' để nhất quán tuyệt đối với vercel.json,
  // đúng tinh thần "local dev cũng có header giống production" đã ghi ở permissionsPolicyHeader bên
  // dưới (phát hiện qua scripts/smoke-test.js chạy trên local server thật, không phải suy đoán).
  frameguard: { action: 'deny' }
});

// Helmet v7 không có tùy chọn tích hợp cho Permissions-Policy (bị bỏ khỏi core) — set thủ công bằng
// middleware nhỏ để local dev (`npm start`) cũng có header này giống production trên Vercel
// (vercel.json đã khai báo cho static/CDN edge, đây là lớp dự phòng khi chạy qua Express).
function permissionsPolicyHeader(req, res, next) {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  next();
}

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

module.exports = { corsOptions, helmetConfig, permissionsPolicyHeader, chatLimiter, generateLimiter, recommendLimiter, appKeyGate };
