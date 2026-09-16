'use strict';

// File này CHỈ dùng khi chạy ở local (npm start / npm run dev).
// Khi deploy lên Vercel, entry point thật sự là api/index.js (Vercel tự gọi,
// không chạy qua app.listen vì Vercel là nền tảng serverless).
const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Trợ Giải đang chạy tại http://localhost:${PORT}`);
  console.log(`   Môi trường: ${process.env.NODE_ENV || 'development'}`);
});
