'use strict';
// ---------- REGRESSION: FINAL AUDIT section M — CDN supply-chain -> self-host /public/vendor ----------
// LỊCH SỬ: trước đây 6 thư viện phía client (pdf.js/mammoth/KaTeX/math.js/three.js/docx) được tải
// từ cdnjs.cloudflare.com / cdn.jsdelivr.net kèm SRI (sha384). Trên iPhone/Safari, class lỗi này vẫn
// làm app không boot được trong 1 số trường hợp thực tế (bug cache phân vùng theo origin của Safari
// khiến script cross-origin có integrity đôi khi bị đối chiếu SAI với bản cache cũ và bị chặn dù
// hash đúng; content-blocker Safari chặn thẳng domain CDN; mạng công ty/trường học chặn DNS/
// firewall) — không phải lỗi trong code app.js. FIX ĐÚNG GỐC: bỏ hẳn phụ thuộc CDN cho 6 thư viện
// này, tự host nguyên văn trong /public/vendor (cùng-origin, không cần SRI vì không còn qua origin
// thứ 3 nào có thể bị compromise/MITM).
//
// Test này giờ khẳng định NGƯỢC LẠI bài test cũ: public/index.html KHÔNG còn <script src> hay
// <link href> nào trỏ tới cdnjs.cloudflare.com/cdn.jsdelivr.net cho các thư viện này, đồng thời mọi
// file vendor cần thiết tồn tại thật trên đĩa và export đúng global mà public/js/app.js đang dùng
// (window.pdfjsLib, window.mammoth, window.katex/renderMathInElement, window.math, window.THREE,
// window.docx) — tránh tái diễn lỗi "tưởng đã tự host nhưng thực ra copy nhầm file" (như vụ
// mathjs/dist/math.js là file deprecated chỉ throw, phải dùng lib/browser/math.js).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

const publicDir = path.join(__dirname, '..', 'public');
const htmlPath = path.join(publicDir, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

console.log('\n== Regression P2/M (self-host): index.html không còn phụ thuộc CDN bên thứ 3 ==');

// Chỉ kiểm tra THẺ THẬT (src=/href= trỏ ra ngoài), không phải chuỗi trong comment giải thích lý do
// fix — nên strip toàn bộ <!-- ... --> trước khi so khớp domain CDN.
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
ok(!/(?:src|href)="https:\/\/cdnjs\.cloudflare\.com/.test(htmlNoComments), 'index.html không còn thẻ <script src>/<link href> nào trỏ tới cdnjs.cloudflare.com cho pdf.js/mammoth/KaTeX/mathjs/three');
ok(!/(?:src|href)="https:\/\/cdn\.jsdelivr\.net/.test(htmlNoComments), 'index.html không còn thẻ <script src> nào trỏ tới cdn.jsdelivr.net (docx.js)');

const VENDOR_FILES = [
  'vendor/pdfjs/pdf.min.js',
  'vendor/pdfjs/pdf.worker.min.js',
  'vendor/mammoth/mammoth.browser.min.js',
  'vendor/katex/katex.min.js',
  'vendor/katex/contrib/auto-render.min.js',
  'vendor/katex/katex.min.css',
  'vendor/mathjs/math.js',
  'vendor/three/three.min.js',
  'vendor/docx/index.umd.js'
];

console.log('\n== Mọi file vendor được index.html tham chiếu phải tồn tại thật trên đĩa (không phải link chết) ==');
VENDOR_FILES.forEach((rel) => {
  const full = path.join(publicDir, rel);
  const exists = fs.existsSync(full);
  ok(exists, `${rel} tồn tại trên đĩa`);
  if (exists) ok(fs.statSync(full).size > 1000, `${rel} có kích thước hợp lý (không phải file rỗng/lỗi tải)`);
  // pdf.worker.min.js KHÔNG được nạp bằng thẻ <script> — pdf.js tự spawn Worker tới URL gán ở
  // pdfjsLib.GlobalWorkerOptions.workerSrc (xem app.js), nên không cần xuất hiện trong index.html.
  if (rel !== 'vendor/pdfjs/pdf.worker.min.js') ok(html.includes('/' + rel), `index.html có tham chiếu /${rel}`);
});

// Kiểm tra tĩnh, KHÔNG cần chạy code: mathjs@12.4.0 "dist/math.js" (khác "lib/browser/math.js")
// chỉ chứa 3 dòng ném lỗi ngay ("removed since mathjs@8.0.0..."). Đảm bảo vendor không vô tình bị
// copy nhầm về đúng cái bẫy này lần nữa trong tương lai.
const mathJsContent = fs.readFileSync(path.join(publicDir, 'vendor/mathjs/math.js'), 'utf8');
ok(!/removed since mathjs@8\.0\.0/.test(mathJsContent), 'vendor/mathjs/math.js KHÔNG phải file "dist/math.js" deprecated (không chứa thông báo throw đã biết)');

// Kiểm tra tĩnh cho pdf.min.js: bản "legacy build" của pdf.js@3.x tự kiểm tra 1 loạt API DOM/Web
// (Image, OffscreenCanvas, ReadableStream...) NGAY khi file được nạp để quyết định polyfill nào cần
// dùng — mô phỏng đầy đủ môi trường đó trong 1 vm sandbox tối giản là không thực tế và dễ tạo lỗi
// giả (sandbox thiếu API chứ không phải bundle sai). Nên ở đây xác nhận tĩnh bằng regex: bundle có
// đúng dòng UMD gán "t.pdfjsLib=e()" (t = global object khi chạy trực tiếp bằng thẻ <script>, không
// qua module bundler) hay không — đủ để phát hiện nếu lỡ tay copy nhầm file/bản build khác không
// export đúng tên biến toàn cục mà app.js đang dùng (window.pdfjsLib).
const pdfJsContent = fs.readFileSync(path.join(publicDir, 'vendor/pdfjs/pdf.min.js'), 'utf8');
ok(/\.pdfjsLib=/.test(pdfJsContent), 'vendor/pdfjs/pdf.min.js có dòng UMD gán "*.pdfjsLib=..." — đúng bundle export global window.pdfjsLib khi chạy bằng <script> thường (không phải bundle ES module)');

console.log('\n== Mỗi bundle vendor thực sự gán đúng global khi chạy (không phải file deprecated/stub) ==');
function runInSandbox(files) {
  // QUAN TRỌNG: trong trình duyệt thật, `window === globalThis === this` (đối tượng global và
  // window LÀ MỘT, không phải 2 object khác nhau) — UMD wrapper của các thư viện này gán biến toàn
  // cục kiểu `this.math = ...` / `e.math=t()` (với e=this ở top-level = global object). Nếu sandbox
  // tạo `window` như 1 object TÁCH RIÊNG khỏi global context, `this.math=...` sẽ gán vào global
  // context chứ KHÔNG vào window, khiến test False-negative (tưởng bundle lỗi nhưng thực ra sandbox
  // sai). Nên ở đây context CHÍNH LÀ window (tự trỏ vào chính nó), giống hệt browser thật.
  // QUAN TRỌNG (tránh 1 lỗi sandbox tinh vi): KHÔNG gán Object/Array/Symbol/Promise/... từ realm
  // chính của Node vào sandbox — nếu làm vậy, các built-in NGUYÊN THỦY này bị DÙNG CHUNG giữa nhiều
  // lần gọi runInSandbox() khác nhau, nên nếu 1 bundle (vd core-js trong mathjs) polyfill/patch lên
  // Object.prototype dùng chung đó, nó sẽ RÒ RỈ sang sandbox của bundle chạy SAU (vd docx), gây lỗi
  // giả ("Cannot convert a Symbol value to a string"...) không liên quan gì tới bản thân file docx.
  // vm.createContext() tự cấp intrinsics (Object/Array/Symbol/Promise/JSON/Math...) RIÊNG BIỆT, cô
  // lập hoàn toàn cho mỗi context nếu KHÔNG override — nên ở đây chỉ thêm đúng những Web API mà
  // pdf.js cần và KHÔNG thuộc ECMAScript chuẩn (không tự có trong vm context trần).
  const ctx = {
    document: { createElement: () => ({ setAttribute() {}, appendChild() {} }), currentScript: null },
    navigator: { userAgent: 'node' }, console,
    URLSearchParams, TextEncoder, TextDecoder, URL
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  files.forEach((rel) => {
    const code = fs.readFileSync(path.join(publicDir, rel), 'utf8');
    try { vm.runInContext(code, ctx, { filename: rel }); } catch (e) { /* 1 vài bundle kiểm tra DOM lúc load, bỏ qua lỗi runtime không liên quan tới export global */ }
  });
  return ctx.window;
}

ok(typeof runInSandbox(['vendor/mammoth/mammoth.browser.min.js']).mammoth === 'object', 'mammoth.browser.min.js gán window.mammoth khi chạy');
ok(typeof runInSandbox(['vendor/katex/katex.min.js']).katex === 'object', 'katex.min.js gán window.katex khi chạy');
{
  const w = runInSandbox(['vendor/katex/katex.min.js', 'vendor/katex/contrib/auto-render.min.js']);
  ok(typeof w.renderMathInElement === 'function', 'auto-render.min.js gán window.renderMathInElement khi chạy sau katex.min.js');
}
{
  // LƯU Ý: mathjs dùng hệ thống "lazy factory" — chỉ TRUY CẬP thuộc tính như .evaluate mới kích
  // hoạt quá trình dựng hàm thật (typed-function), và hệ thống đó cần môi trường trình duyệt đầy đủ
  // hơn 1 vm sandbox tối giản của Node (không phải lỗi của bundle) — nên KHÔNG gọi/đọc .evaluate ở
  // đây, chỉ xác nhận window.math tồn tại + đúng shape của bundle thật (object có .import, đặc trưng
  // của mathjs), khác hẳn "dist/math.js" (chỉ throw ngay khi require, không tạo ra object nào cả).
  const w = runInSandbox(['vendor/mathjs/math.js']);
  ok(typeof w.math === 'object' && w.math !== null && typeof w.math.import === 'function',
    'vendor/mathjs/math.js gán window.math LÀ bundle thật (có math.import) — KHÔNG phải file "dist/math.js" deprecated (chỉ throw ngay dòng đầu, xem comment index.html)');
}
ok(typeof runInSandbox(['vendor/three/three.min.js']).THREE === 'object', 'three.min.js gán window.THREE khi chạy');
{
  const w = runInSandbox(['vendor/docx/index.umd.js']);
  ok(typeof w.docx === 'object' && typeof w.docx.Document === 'function',
    'index.umd.js gán window.docx CÓ Document constructor thật — đúng file build/index.umd.js, không phải build/index.js (không tồn tại)');
}

console.log('\n== app.js không còn trỏ pdf.worker tới CDN ==');
const appJs = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');
const appJsNoComments = appJs.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/cdnjs\.cloudflare\.com/.test(appJsNoComments), 'app.js (ngoài comment) không còn chuỗi cdnjs.cloudflare.com nào (kể cả workerSrc)');
ok(appJs.includes("'/vendor/pdfjs/pdf.worker.min.js'"), 'app.js trỏ pdfjsLib.GlobalWorkerOptions.workerSrc về file tự host cùng-origin');

console.log('\n== CSP (vercel.json + server/middleware/security.js) đã thu hẹp, không còn domain CDN không cần thiết ==');
const vercelJson = fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8');
const securityJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'middleware', 'security.js'), 'utf8');
const securityJsNoComments = securityJs.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/cdnjs\.cloudflare\.com/.test(vercelJson), 'vercel.json CSP không còn cdnjs.cloudflare.com');
ok(!/cdn\.jsdelivr\.net/.test(vercelJson), 'vercel.json CSP không còn cdn.jsdelivr.net');
ok(!/cdnjs\.cloudflare\.com/.test(securityJsNoComments), 'server/middleware/security.js CSP directive thực tế (ngoài comment) không còn cdnjs.cloudflare.com');
ok(!/cdn\.jsdelivr\.net/.test(securityJsNoComments), 'server/middleware/security.js CSP directive thực tế (ngoài comment) không còn cdn.jsdelivr.net');
ok(vercelJson.includes('fonts.googleapis.com') && securityJs.includes('fonts.googleapis.com'),
  'Google Fonts (không phải thư viện chức năng, không CÓ global JS nào phụ thuộc) vẫn được giữ trong CSP style-src/font-src');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
