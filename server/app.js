'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const compression = require('compression');

const { corsOptions, helmetConfig, permissionsPolicyHeader, chatLimiter, generateLimiter, recommendLimiter, appKeyGate } = require('./middleware/security');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const chatRoutes = require('./routes/chat');
const generateRoutes = require('./routes/generate');
const recommendRoutes = require('./routes/recommend');
const studyRoutes = require('./routes/study');
const visualRoutes = require('./routes/visual');
const sourceVisionRoutes = require('./routes/sourceVision');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // cần thiết khi deploy sau reverse proxy / load balancer (Render, Vercel, Nginx...)

// ---------- Lớp bảo mật áp dụng toàn cục ----------
app.use(helmetConfig);
app.use(permissionsPolicyHeader);
app.use(corsOptions);
// LƯU Ý QUAN TRỌNG: compression() mặc định ĐỆM (buffer) dữ liệu trước khi nén rồi mới gửi đi —
// nếu áp dụng cho cả route streaming (SSE, Content-Type: text/event-stream) ở /api/chat, hiệu ứng
// "gõ chữ" thời gian thực sẽ vô nghĩa vì các đoạn văn bản bị dồn cục lại rồi gửi 1 lần thay vì
// từng đoạn nhỏ như AI sinh ra. Dùng filter để bỏ qua nén cho riêng các phản hồi SSE, giữ nguyên
// nén (tiết kiệm băng thông) cho mọi response JSON/tĩnh khác.
app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type') === 'text/event-stream; charset=utf-8') return false;
    return compression.filter(req, res);
  }
}));
// ---------- PHẦN F: THỨ TỰ BODY-PARSER ----------
// TRƯỚC ĐÂY: express.json({limit:'8mb'}) mount TOÀN CỤC ở đây, nên `express.json({limit:'4kb'})`
// khai trong routes/visual.js KHÔNG BAO GIỜ có tác dụng — body đã được parse xong (với trần 8mb)
// từ lâu trước khi request tới router đó. Đó là một lớp bảo vệ CHẾT: comment nói có, thực tế không.
// NAY: KHÔNG có parser toàn cục. Mỗi nhóm route tự khai trần đúng nhu cầu của nó, và trần đó là
// trần THẬT vì không còn parser nào chạy trước.
//   - PARSER_LIMIT_BYTES (~4.2MB) chỉ dành cho route có ảnh; cố tình CAO HƠN ngân sách an toàn một
//     chút để request hơi quá vẫn parse được và nhận lỗi CÓ CẤU TRÚC từ validator (PHẦN A8) thay vì
//     413 trần trụi của body-parser.
//   - route JSON nhỏ giữ trần nhỏ thật sự.
const payloadBudget = require('./utils/payloadBudget');
const jsonLarge = express.json({ limit: payloadBudget.PARSER_LIMIT_BYTES });
const jsonSmall = express.json({ limit: '64kb' });
// (routes/visual.js tự khai express.json({limit:'4kb'}) cho /hq và /retry — nay là trần THẬT.)

// ---------- API ----------
// Đây là nơi để thêm các route API mới trong tương lai:
// const myFeatureRoutes = require('./routes/myFeature');
// app.use('/api/my-feature', myFeatureRoutes);
// PHẦN N: log runtime THẬT sau deploy (không đoán theo cấu hình). PHẦN H/I/J: nói rõ tầng trạng
// thái nào đang bền vững — health endpoint là nơi kiểm chứng sau khi deploy, không phải nơi quảng cáo.
app.get('/api/health', (req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  nodeVersion: process.version,
  runtime: process.env.VERCEL ? 'vercel' : 'self-hosted',
  distributedStore: require('./utils/kvStore').isEnabled(),
  rateLimitScope: require('./middleware/rateLimit').isGlobalScope() ? 'global' : 'instance'
}));

// Chuẩn hoá tiền tố /api khi chạy sau serverless adapter hoặc reverse proxy (nếu /api bị tước)
app.use((req, res, next) => {
  const apiPrefixes = ['/chat', '/generate', '/recommend', '/study', '/visual', '/source', '/health'];
  if (apiPrefixes.some((p) => req.url === p || req.url.startsWith(p + '/') || req.url.startsWith(p + '?'))) {
    req.url = '/api' + req.url;
  }
  next();
});

app.use('/api', appKeyGate); // cổng khóa dùng chung tùy chọn (đọc từ .env, mặc định tắt)
app.use('/api/chat', chatLimiter, jsonLarge, chatRoutes);
app.use('/api/generate', generateLimiter, jsonLarge, generateRoutes);
app.use('/api/recommend', recommendLimiter, jsonSmall, recommendRoutes);
// Mục 3A/3C: /api/study/* KHÔNG chạy qua chatLimiter (giới hạn dành cho pipeline giải bài nặng hơn
// nhiều) — dùng chung generateLimiter (giới hạn cho các tác vụ nhỏ/JSON ngắn) cho hợp lý mức chi phí.
app.use('/api/study', generateLimiter, jsonSmall, studyRoutes);
// MỤC 1.4: proxy tải hộ ảnh do image provider trả về (CSP/CORS chặn client fetch thẳng). Whitelist
// domain CỨNG trong routes/visual.js — dùng generateLimiter vì đây là tác vụ nhẹ, không phải
// pipeline giải bài.
app.use('/api/visual', generateLimiter, visualRoutes); // parser khai TRONG router: /hq và /retry dùng jsonTiny 4kb THẬT
// PHẦN A6/A11: batch vision-extraction cho PDF scan (đọc trang 1 lần, cache evidence text ở client
// để KHÔNG phải gửi lại ảnh base64 mỗi lượt hỏi) — dùng chatLimiter (không phải generateLimiter) vì
// đây là lệnh gọi AI thật (vision), cùng nhóm chi phí với pipeline giải bài chính, không phải tác
// vụ nhẹ.
app.use('/api/source', chatLimiter, jsonLarge, sourceVisionRoutes);

// ---------- Frontend tĩnh ----------
// Lưu ý: khi deploy trên Vercel, thư mục public/ được Vercel phục vụ trực tiếp
// (xem vercel.json - outputDirectory), request tĩnh sẽ KHÔNG đi qua function này.
// Đoạn dưới đây chủ yếu phục vụ khi chạy `npm run dev` / `npm start` ở local.
const publicDir = path.join(__dirname, '..', 'public');

// ROOT CAUSE FIX (P0 — "Unexpected token '<'" / bootErrorScreen giả trên iPhone):
// TRƯỚC ĐÂY có `app.get('*', (req,res) => res.sendFile(index.html))` ở CUỐI stack — một fallback
// kiểu "SPA" nhận MỌI request không khớp route nào khác (kể cả 1 URL /js/*.js bị gõ sai, bị 404,
// hoặc lọt qua static middleware vì lý do bất kỳ) và trả về... index.html — TỨC LÀ TRẢ HTML CHO 1
// REQUEST ĐANG XIN JAVASCRIPT. Trình duyệt nhận `<!DOCTYPE html>...` tại nơi nó mong đợi
// `const ACTIVE_3D = [...]` và ném thẳng "Uncaught SyntaxError: Unexpected token '<'" — ĐÚNG Y HỆT
// lỗi console đang gặp. App này KHÔNG có client-side router (không có nhiều "trang" ảo cần fallback
// về index.html) — chỉ có DUY NHẤT 1 trang thật ở "/". Vì vậy fallback này không có lý do tồn tại
// và bị XOÁ HẲN (không che bằng try/catch, không đổi Content-Type thủ công): mọi request tĩnh
// không khớp file thật sẽ rơi xuống notFoundHandler bên dưới, trả về đúng 404 thật — KHÔNG BAO GIỜ
// còn trả HTML nơi trình duyệt đang mong đợi JS. GET "/" vẫn phục vụ index.html bình thường qua
// hành vi mặc định của express.static (index: 'index.html').
//
// FIX cache/versioning (mục PHẦN 4): trước đây maxAge:'1h' áp CHUNG cho mọi asset tĩnh, kể cả các
// file *.js/*.css KHÔNG được đặt tên theo content-hash → sau khi bumping code, trình duyệt vẫn có
// thể phục vụ bản JS CŨ từ cache tới 1h dưới CÙNG URL /js/storage.js, chồng lên bản mới nếu tab cũ
// vẫn còn mở → "Identifier ... already been declared". Nay pipeline build (scripts/build.js, chạy
// tự động mỗi lần `npm run build`/deploy) gắn content-hash vào tên các asset core (vd
// app.<hash>.js) TRƯỚC khi thư mục public được deploy, nên:
//   - asset ĐÃ fingerprint (tên chứa hash 10 ký tự hex) → an toàn cache "immutable" dài hạn, vì nội
//     dung đổi = tên file đổi = URL khác hẳn, không bao giờ có xung đột cũ/mới dưới cùng 1 URL.
//   - index.html (và asset CHƯA fingerprint) → luôn no-store, không được cache, để trình duyệt
//     LUÔN lấy bản index.html mới nhất (trỏ đúng tên file đã hash của lần deploy đó).
// Vercel phục vụ static trực tiếp qua CDN edge nên header thật sự áp dụng cho production là ở
// vercel.json; các dòng dưới đây chỉ đảm bảo `npm start`/`npm run dev` (local, không qua Vercel)
// có cùng hành vi cache, không lệch giữa 2 môi trường.
const HASHED_ASSET_RE = /\.[0-9a-f]{10}\.(js|css)$/i;
app.use(
  express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
      } else if (HASHED_ASSET_RE.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.includes(`${path.sep}vendor${path.sep}`)) {
        // Thư viện self-host bên thứ 3, KHÔNG fingerprint theo nội dung (version pin qua đường dẫn
        // package, hiếm khi đổi) — cache vừa phải, luôn revalidate, không "immutable".
        res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  })
);

// ---------- Xử lý lỗi ----------
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
