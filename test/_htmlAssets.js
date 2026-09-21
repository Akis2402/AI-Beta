'use strict';

// Helper dùng chung cho các test kiểm THỨ TỰ NẠP SCRIPT trong index.html.
//
// Vì sao cần: `npm run build` (chạy tự động trước mỗi deploy Vercel) đổi tên asset thành dạng
// content-hash — `/js/app.js` -> `/js/app.6b4f2c1d90.js`. Các test so khớp CHUỖI CỨNG vì vậy sẽ
// xanh trên cây chưa build và đỏ trên cây đã build, trong khi BẤT BIẾN cần kiểm (script nạp bằng
// thẻ src bên ngoài, đúng thứ tự phụ thuộc) không hề đổi. Chuẩn hoá tên về dạng KHÔNG hash để test
// kiểm đúng bất biến đó ở CẢ HAI trạng thái cây mã, thay vì nới lỏng hoặc bỏ test.

/** '/js/app.6b4f2c1d90.js' -> '/js/app.js' */
function stripFingerprint(src) {
  return String(src || '').replace(/\.[0-9a-f]{10}\.(js|css)$/i, '.$1');
}

/** Danh sách src của MỌI thẻ <script src> thật, theo đúng thứ tự xuất hiện, đã bỏ hash. */
function scriptSrcs(html) {
  return [...String(html).matchAll(/<script\s+src="([^"]+)"/g)].map((m) => stripFingerprint(m[1]));
}

/** Vị trí nạp của 1 asset (theo tên chưa hash); -1 nếu không được nạp. */
function scriptIndex(html, src) {
  return scriptSrcs(html).indexOf(src);
}

module.exports = { stripFingerprint, scriptSrcs, scriptIndex };
