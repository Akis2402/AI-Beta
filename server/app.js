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
app.use(express.json({ limit: '8mb' })); // đủ chứa ảnh base64 (validators.js giới hạn chặt hơn: 5MB)

// ---------- API ----------
// Đây là nơi để thêm các route API mới trong tương lai:
// const myFeatureRoutes = require('./routes/myFeature');
// app.use('/api/my-feature', myFeatureRoutes);
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api', appKeyGate); // cổng khóa dùng chung tùy chọn (đọc từ .env, mặc định tắt)
app.use('/api/chat', chatLimiter, chatRoutes);
app.use('/api/generate', generateLimiter, generateRoutes);
app.use('/api/recommend', recommendLimiter, recommendRoutes);
// Mục 3A/3C: /api/study/* KHÔNG chạy qua chatLimiter (giới hạn dành cho pipeline giải bài nặng hơn
// nhiều) — dùng chung generateLimiter (giới hạn cho các tác vụ nhỏ/JSON ngắn) cho hợp lý mức chi phí.
app.use('/api/study', generateLimiter, studyRoutes);

// ---------- Frontend tĩnh ----------
// Lưu ý: khi deploy trên Vercel, thư mục public/ được Vercel phục vụ trực tiếp
// (xem vercel.json - outputDirectory), request tĩnh sẽ KHÔNG đi qua function này.
// Đoạn dưới đây chủ yếu phục vụ khi chạy `npm run dev` / `npm start` ở local.
const publicDir = path.join(__dirname, '..', 'public');
<<<<<<< HEAD
<<<<<<< HEAD
app.use(express.static(publicDir, { maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
=======
// FIX (bootErrorScreen "<<" + duplicate ACTIVE_3D): maxAge:'1h' áp cho MỌI file tĩnh, kể cả
// index.html. Khi deploy bản fix mới, trình duyệt vẫn phục vụ index.html CŨ từ cache tới 1h,
// trỏ tới /js/storage.js và /js/app.js KHÔNG có ?v=... -> nạp lại bản JS cũ (đã bị cache riêng),
// chồng lên bản mới -> vừa lỗi cú pháp bản cũ vừa "Identifier ... already been declared".
// -> index.html (và mọi *.html) PHẢI luôn revalidate; chỉ asset tĩnh có filename cố định
// (js/css/vendor) mới nên cache dài hạn.
app.use(
  express.static(publicDir, {
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
=======

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
>>>>>>> 82d1200 (Anotherther)
      }
    },
  })
);
<<<<<<< HEAD
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'index.html'));
});
>>>>>>> d5e845a (Another)
=======
>>>>>>> 82d1200 (Anotherther)

// ---------- Xử lý lỗi ----------
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
