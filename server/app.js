'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const compression = require('compression');

const { corsOptions, helmetConfig, chatLimiter, generateLimiter, recommendLimiter, appKeyGate } = require('./middleware/security');
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
app.use(express.static(publicDir, { maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ---------- Xử lý lỗi ----------
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
