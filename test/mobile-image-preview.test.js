'use strict';
// Regression cho fix "preview ảnh không hiện trên mobile sau khi chọn ảnh".
// ROOT CAUSE: loadImageFile() cũ await tuần tự FileReader.readAsDataURL() rồi
// chatImageStore.save() (IndexedDB) TRƯỚC KHI render preview — trên mobile (đặc biệt iOS Safari
// sau khi đóng photo-picker/camera), transaction IndexedDB có thể treo vô thời hạn (WebKit bug đã
// biết), khiến preview không bao giờ render, không lỗi, không gì cả.
// FIX: preview dùng URL.createObjectURL(file) tạo NGAY LẬP TỨC/đồng bộ, độc lập hoàn toàn với
// FileReader/IndexedDB; 2 việc còn lại chạy song song có timeout, không chặn preview.
// Đây là test dựa trên source (giống phong cách dom-wiring.test.js/tdz-el-order.test.js hiện có
// trong repo) vì app.js là file chạy trên browser (phụ thuộc window/DOM/el()), không thực thi được
// trực tiếp trong Node.

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

console.log('\n== Regression: preview ảnh mobile độc lập với FileReader/IndexedDB ==');

ok(
  /previewUrl\s*=\s*URL\.createObjectURL\(file\)/.test(appJs),
  'loadImageFile() tạo previewUrl bằng URL.createObjectURL(file) — không dùng data: URL cho preview'
);

ok(
  (() => {
    const fnStart = appJs.indexOf('async function loadImageFile');
    const fnBody = appJs.slice(fnStart, fnStart + 4000);
    const previewIdx = fnBody.indexOf('renderImagePreview()');
    const readerIdx = fnBody.indexOf('readFileAsBase64(file)');
    const saveIdx = fnBody.indexOf('chatImageStore.save(file');
    return fnStart !== -1 && previewIdx !== -1 && readerIdx !== -1 && saveIdx !== -1
      && previewIdx < readerIdx && previewIdx < saveIdx;
  })(),
  'renderImagePreview() được gọi TRƯỚC readFileAsBase64()/chatImageStore.save() (preview không còn bị chặn bởi 2 việc này)'
);

ok(
  /function withTimeout\(/.test(appJs) && /withTimeout\(readFileAsBase64\(file\), \d+, 'read_timeout'\)/.test(appJs)
    && /withTimeout\(rawSavePromise, \d+, 'save_timeout'\)/.test(appJs),
  'đọc base64 và lưu IndexedDB đều được bọc withTimeout() — không treo vô hạn (bug WebKit sau photo-picker)'
);

ok(
  /let imageLoadSeq = 0;/.test(appJs) && /const seq = \+\+imageLoadSeq;/.test(appJs)
    && /state\.pendingImage\.seq !== seq/.test(appJs),
  'có cơ chế sequence token (imageLoadSeq) chống race condition khi thay/xoá ảnh giữa chừng'
);

ok(
  /function revokeImagePreviewUrl\(/.test(appJs) && /URL\.revokeObjectURL\(url\)/.test(appJs),
  'có helper revokeImagePreviewUrl() để dọn Object URL, tránh rò rỉ bộ nhớ'
);

ok(
  (() => {
    const fnStart = appJs.indexOf('function renderImagePreview()');
    const fnBody = appJs.slice(fnStart, fnStart + 1800);
    return fnStart !== -1
      && /document\.createElement\('img'\)/.test(fnBody)
      && !/wrap\.innerHTML = `<div class="img-chip/.test(fnBody);
  })(),
  'renderImagePreview() dựng <img> bằng document.createElement, không còn nội suy URL vào chuỗi innerHTML'
);

ok(
  /img\.onerror = \(\) => \{/.test(appJs) && /pending\.status = 'error'/.test(appJs),
  'renderImagePreview() có img.onerror để phát hiện ảnh không decode được (vd HEIC lạ) và chuyển sang trạng thái lỗi thân thiện, không mất pendingImage'
);

ok(
  /if \(image && image\.status === 'loading'\)/.test(appJs) && /if \(image && image\.status === 'error'\)/.test(appJs),
  'sendMessage() chặn gửi khi ảnh còn đang xử lý hoặc bị lỗi — không gửi thiếu base64 (race condition mục 11)'
);

ok(
  !/file\.type\.startsWith\('image\/'\)\) \{ alert\('Chỉ hỗ trợ dán\/đính kèm file ảnh\.'\); return; \}/.test(appJs)
    && /function guessImageMediaType\(file\)/.test(appJs),
  'không còn từ chối ảnh chỉ vì file.type rỗng — có fallback đoán mediaType theo phần mở rộng tên file (ảnh mobile qua content:// URI)'
);

ok(
  /rawSavePromise\.then\(\(lateId\) => \{/.test(appJs) && /state\.pendingImage\.imageId = lateId;/.test(appJs),
  'save_timeout không làm mất persistence oan — nếu IndexedDB save chỉ chậm rồi tự resolve trễ, imageId vẫn được gắn lại cho ảnh đang pending (thay vì luôn coi là thất bại vĩnh viễn)'
);

ok(
  /window\.addEventListener\('pagehide', revokeThreadBlobImages\)/.test(appJs)
    && (appJs.match(/revokeThreadBlobImages\(\);/g) || []).length >= 2,
  'revokeThreadBlobImages() được gọi trước khi xoá threadEl (chuyển/tạo hội thoại) và khi rời trang — dọn Object URL của ảnh đã gửi/khôi phục, tránh rò rỉ bộ nhớ'
);


if (failed > 0) process.exit(1);
