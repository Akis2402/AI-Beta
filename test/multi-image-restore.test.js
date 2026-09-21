'use strict';

// PROMPT V5 — PHẦN Y/AB: mở rộng nốt 2 việc để lại từ vòng "UI multi-image" (xem
// AUDIT-REPORT-MULTI-IMAGE-WIRING.md mục 10, phần "CỐ Ý GIỮ NGUYÊN"):
//   1. F5-restore cho tin nhắn nhiều ảnh (trước: chỉ ảnh đầu).
//   2. Lượt "Giải chi tiết" (fetchDetail) mang theo đủ ảnh (trước: chỉ ảnh đầu).
// Repo không có hạ tầng test DOM/browser thật (đã ghi rõ ở AUDIT-REPORT mục 9/10) — bộ test này theo
// ĐÚNG kiểu static-analysis mà mobile-image-preview.test.js/tdz-el-order.test.js đã dùng cho app.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { console.log('  ok  - ' + name); passed++; }
  else { console.log(' FAIL - ' + name); failed++; }
}

console.log('\n== PHẦN Y/AB: lưu + khôi phục imageIds[] (không chỉ imageId số ít) ==');

ok(
  /const imageIds = images\.map\(\(img\) => img\.imageId\)\.filter\(Boolean\);/.test(appJs)
    && /const userMsgObj = \{ role: 'user', text: query, hadImage: !!image, imageId: image \? image\.imageId : null, imageIds \};/.test(appJs),
  'sendMessage() lưu imageIds[] (đủ ảnh) VÀO CÙNG userMsgObj, không chỉ imageId số ít'
);

ok(
  /id: uid\(\), role: 'ai', query, approach: '', detail: null, contexts, crossChecked: false, imageId: image \? image\.imageId : null, imageIds,/.test(appJs),
  'aiMsgObj cũng lưu imageIds[] — để fetchDetail()/F5-restore tra được đủ ảnh từ message AI'
);

ok(
  /async function restoreMessageImages\(imageIds\) \{/.test(appJs)
    && /for \(const id of ids\) \{/.test(appJs),
  'có restoreMessageImages() khôi phục NHIỀU ảnh theo đúng thứ tự (không dùng Promise.all — giữ thứ tự PHẦN X)'
);

ok(
  /if \(msg\.imageIds && msg\.imageIds\.length\) \{/.test(appJs)
    && /const \{ images: restoredImgs, missingCount \} = await restoreMessageImages\(msg\.imageIds\);/.test(appJs)
    && /addUserMsg\(msg\.text, restoredImgs\.map\(\(r\) => r\.url\)\);/.test(appJs),
  'loadConversation() khôi phục ĐỦ ảnh cho tin nhắn có imageIds[] (F5-restore multi-image)'
);

ok(
  // Tương thích ngược: tin nhắn CŨ (trước bản vá) chỉ có imageId số ít vẫn phải khôi phục đúng như
  // hành vi gốc — không được yêu cầu cả imageIds[] mới chịu khôi phục (sẽ làm hỏng dữ liệu người
  // dùng đã lưu trước khi có tính năng này).
  /} else if \(msg\.imageId\) \{\s*\n\s*const restored = await restoreMessageImage\(msg\.imageId\);/.test(appJs),
  'loadConversation() vẫn khôi phục đúng tin nhắn CŨ (chỉ có imageId số ít, trước bản vá multi-image) — không phá dữ liệu đã lưu'
);

console.log('\n== PHẦN 9 (cleanup): xoá hội thoại phải dọn HẾT ảnh IndexedDB, không chỉ ảnh đầu ==');

ok(
  /if \(m\.imageId\) imageIds\.add\(m\.imageId\);/.test(appJs)
    && /if \(Array\.isArray\(m\.imageIds\)\) m\.imageIds\.forEach\(\(id\) => \{ if \(id\) imageIds\.add\(id\); \}\);/.test(appJs),
  'deleteConversation() dọn CẢ imageIds[] lẫn imageId — tránh ảnh mồ côi (orphan) trong IndexedDB khi xoá hội thoại nhiều-ảnh'
);

console.log('\n== PHẦN Y/AC: fetchDetail() mang theo ĐỦ ảnh, không chỉ ảnh đầu ==');

ok(
  /async function fetchDetail\(btn, aiRow, contentEl, msgObj, images\) \{/.test(appJs)
    && /const image = images && images\[0\];/.test(appJs),
  'fetchDetail() nhận `images` (mảng) thay vì `image` (1 ảnh) — ảnh đầu vẫn suy ra được cho các chỗ dùng cũ'
);

ok(
  (() => {
    const fnStart = appJs.indexOf("async function fetchDetail(btn, aiRow, contentEl, msgObj, images)");
    // Cửa sổ đọc rộng ra 6000 ký tự: BẤT BIẾN cần kiểm (payload mang images[] từ ảnh thứ 2) không
    // đổi, chỉ có phần đầu fetchDetail() dài thêm sau khi bổ sung clientRequestId cho job store
    // (PHẦN BG/21). Cửa sổ 3000 cũ là chi tiết kỹ thuật của test, không phải hợp đồng của code.
    const fnBody = appJs.slice(fnStart, fnStart + 6000);
    return fnStart !== -1 && /images: \(images \|\| \[\]\)\.slice\(1\)\.map\(\(img\) => \(\{ mediaType: img\.mediaType, base64: img\.base64 \}\)\),/.test(fnBody);
  })(),
  'payload /api/chat của fetchDetail() gửi images[] (ảnh 2 trở đi) — trước đây chỉ gửi 1 ảnh duy nhất ở lượt "Giải chi tiết"'
);

ok(
  /const ids = \(msg\.imageIds && msg\.imageIds\.length\) \? msg\.imageIds : \(msg\.imageId \? \[msg\.imageId\] : \[\]\);/.test(appJs),
  'handleDetailClickWithRestore() ưu tiên imageIds[] (nhiều ảnh), fallback imageId số ít cho tin nhắn cũ'
);

ok(
  /detailBtn\.onclick = \(\) => fetchDetail\(detailBtn, aiRow, contentEl, aiMsgObj, images\);/.test(appJs),
  'nút "Giải chi tiết" ở lượt vừa hỏi xong (chưa qua F5) truyền ĐỦ `images` (mảng), không chỉ ảnh đầu'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
