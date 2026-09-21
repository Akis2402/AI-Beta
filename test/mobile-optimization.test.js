'use strict';

// ============================================================================================
// TEST — TỐI ƯU ĐIỆN THOẠI
// ============================================================================================
// Đây là các bất biến dễ bị phá âm thầm khi ai đó chỉnh CSS/renderer sau này: vùng chạm tụt xuống
// dưới ngưỡng, textarea tụt dưới 16px làm iOS tự zoom, hình minh hoạ quay lại lưới 2 cột không đọc
// nổi trên màn hình hẹp. Không test được "trông đẹp không", nhưng ba thứ trên thì đo được.

const assert = require('assert');
const fs = require('fs');
const path = require('path');


let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

/** Lấy nội dung các khối @media có max-width <= `maxPx`. */
function mobileBlocks(maxPx) {
  const out = [];
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    if (Number(m[1]) > maxPx) continue;
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}

const MOBILE_CSS = mobileBlocks(640).join('\n');

console.log('\n== Viewport & zoom ==');

test('M1. viewport meta cho phép co giãn theo thiết bị và tôn trọng notch', () => {
  const meta = (html.match(/<meta name="viewport"[^>]*>/) || [])[0] || '';
  assert.ok(meta, 'thiếu thẻ viewport');
  assert.ok(/width=device-width/.test(meta));
  assert.ok(/viewport-fit=cover/.test(meta), 'cần viewport-fit=cover để dùng env(safe-area-inset-*)');
  assert.ok(!/user-scalable\s*=\s*no/.test(meta), 'KHÔNG được chặn người dùng phóng to (yêu cầu tiếp cận)');
  assert.ok(!/maximum-scale\s*=\s*1/.test(meta), 'maximum-scale=1 cũng chặn phóng to trên iOS');
});

test('M2. textarea >= 16px trên màn hình hẹp — nếu nhỏ hơn, iOS Safari tự phóng to trang', () => {
  const rule = /#qInput\s*\{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/.exec(MOBILE_CSS);
  assert.ok(rule, 'thiếu quy tắc font-size cho #qInput ở màn hình hẹp');
  assert.ok(Number(rule[1]) >= 16, `font-size=${rule[1]}px sẽ khiến iOS zoom khi focus`);
});

console.log('\n== Vùng chạm ==');

test('M3. nút công cụ (ảnh, microphone) có vùng chạm >= 44px', () => {
  assert.ok(/\.tool-btn::after\s*\{[^}]*width:\s*44px/.test(MOBILE_CSS),
    'cần vùng chạm ảo 44px; 32-36px là dưới ngưỡng của cả iOS lẫn Android');
  assert.ok(/\.tool-btn::after\s*\{[^}]*height:\s*44px/.test(MOBILE_CSS));
  assert.ok(/\.tool-btn\s*\{\s*position:relative/.test(MOBILE_CSS) || /\.tool-btn\{position:relative/.test(MOBILE_CSS),
    '::after cần position:relative ở phần tử cha, nếu không vùng chạm neo sai chỗ');
});

test('M4. nút gửi cao hơn và rộng hơn trên điện thoại (bấm bằng ngón cái)', () => {
  const send = /#sendBtn,#stopBtn\s*\{([^}]*)\}/.exec(MOBILE_CSS);
  assert.ok(send, 'thiếu quy tắc mobile cho #sendBtn');
  const h = /height:\s*(\d+)px/.exec(send[1]);
  assert.ok(h && Number(h[1]) >= 40, `nút gửi cao ${h && h[1]}px, cần >= 40px`);
  assert.ok(/min-width:\s*\d+px/.test(send[1]), 'cần bề ngang tối thiểu để không bị bóp còn vài chục px');
});

test('M5. hàng công cụ được phép XUỐNG DÒNG thay vì đẩy nút gửi ra ngoài màn hình', () => {
  assert.ok(/#chatBarTools\s*\{[^}]*flex-wrap:\s*wrap/.test(MOBILE_CSS),
    'ở ~360px hàng (môn học + ảnh + mic + Giải bài) tràn ngang nếu không cho wrap');
});

test('M6. bỏ hiệu ứng hover nhấc lên trên cảm ứng (hover bị "dính" sau khi nhả tay)', () => {
  assert.ok(/\.tool-btn:hover\s*\{\s*transform:\s*none/.test(MOBILE_CSS));
  assert.ok(/#sendBtn:hover:not\(:disabled\),#stopBtn:hover\s*\{\s*transform:\s*none/.test(MOBILE_CSS));
});

test('M7. composer tôn trọng vùng an toàn dưới (thanh home iPhone)', () => {
  assert.ok(/#composer\s*\{[^}]*env\(safe-area-inset-bottom\)/.test(css),
    'thiếu env(safe-area-inset-bottom) -> nút gửi nằm dưới thanh home');
});

console.log('\n== Trạng thái voice trên màn hình hẹp ==');

test('M8. dải "Đang nghe…" được phép xuống dòng, không đẩy layout ngang', () => {
  assert.ok(/#voiceStatus\s*\{[^}]*flex-wrap:\s*wrap/.test(MOBILE_CSS));
});

test('M9. KHÔNG còn nhãn "sơ đồ thay thế" (cơ chế fallback SVG đã bị loại bỏ)', () => {
  assert.ok(!/visual-fallback-badge/.test(css), 'CSS còn tàn dư của cơ chế fallback SVG');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(!/fallbackSchematic/.test(app), 'app.js còn tàn dư fallbackSchematic');
});

console.log('\n== Hình minh hoạ trên màn hình hẹp ==');

test('M10. thẻ hình AI co theo bề ngang, không tràn ngang trên điện thoại', () => {
  assert.ok(/\.visual-card-image img\s*\{[^}]*max-width:\s*100%/.test(MOBILE_CSS)
    || /\.visual-img\s*\{[^}]*max-width:\s*100%/.test(css),
  'ảnh AI phải co theo bề ngang màn hình');
});

test('M11. KHÔNG còn CSS của đường SVG nhúng-DOM cũ (.draw-wrap svg, .visual-svg-inline); SVG tất định chỉ qua <img>', () => {
  assert.ok(!/\.draw-wrap svg/.test(css), 'CSS còn selector của hình SVG nhúng-DOM cũ');
  assert.ok(!/\.visual-svg-inline/.test(css), 'không được có CSS cho SVG nhúng trực tiếp');
  // Đường mới (Hybrid): SVG tất định hiển thị qua <img src=data:image/svg+xml> -> CSS nhắm vào img.
  assert.ok(/\.visual-svg-wrap\s+\.visual-svg-img/.test(css), 'thiếu CSS cho thẻ SVG tất định (img)');
  assert.ok(!/\.visual-svg-wrap\s+svg\b/.test(css), 'CSS SVG tất định không được nhắm vào <svg> nhúng-DOM');
});

test('M12. CSS 3D tương tác vẫn còn nguyên (không xoá nhầm khi dọn SVG)', () => {
  ['.draw-wrap-3d', '.scene3d-wrap', '.scene3d-toolbar', '.scene3d-canvas-host', '.scene3d-fallback']
    .forEach((sel) => assert.ok(css.includes(sel), 'mất CSS 3D: ' + sel));
});

test('M13. ảnh AI bị giới hạn chiều cao để không chiếm trọn màn hình dọc', () => {
  assert.ok(/\.visual-card-image img\s*\{[^}]*max-height:\s*\d+vh/.test(MOBILE_CSS));
  assert.ok(/\.visual-card-image img\s*\{[^}]*object-fit:\s*contain/.test(MOBILE_CSS),
    'cover sẽ cắt mất nội dung hình minh hoạ');
});

console.log('\n== Bố cục chung ==');

test('M14. sidebar là drawer trượt bằng transform (không animate left)', () => {
  const blocks = mobileBlocks(760).join('\n');
  assert.ok(/#sidebar\{[^}]*position:fixed/.test(blocks));
  assert.ok(/#sidebar\{[^}]*transform:translateX\(-100%\)/.test(blocks));
});

test('M15. tôn trọng prefers-reduced-motion cho mọi animation đã thêm', () => {
  assert.ok(/@media \(prefers-reduced-motion/.test(css));
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(/#micBtn\.recording::after/.test(rm), 'animation microphone phải nằm trong nhóm tắt được');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
