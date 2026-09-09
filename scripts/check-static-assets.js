'use strict';

/*
 * scripts/check-static-assets.js — PHẦN 9 của yêu cầu audit.
 *
 * Chạy SAU `npm run build` (đúng thứ tự Vercel làm: install -> build -> deploy) để xác nhận, chỉ
 * bằng cách đọc trực tiếp từ đĩa (không đoán, không suy diễn):
 *   1. Mọi asset core mà index.html tham chiếu đều THỰC SỰ TỒN TẠI trên đĩa.
 *   2. index.html trỏ đúng asset đã-hash mới nhất trong public/asset-manifest.json — không còn
 *      sót tham chiếu ?v=... hay tên file cũ.
 *   3. KHÔNG có script nào bị tham chiếu 2 lần (nguồn gốc lỗi "Identifier ... already declared").
 *   4. KHÔNG có <script>/<link> nào trỏ ra domain CDN bên thứ 3 ngoài ý muốn (mục PHẦN 6 — phải
 *      tự host, https://fonts.googleapis.com cho font chữ giao diện là ngoại lệ được cho phép).
 *   5. Nội dung từng file JS core KHÔNG bắt đầu bằng HTML (dấu hiệu server trả nhầm index.html cho
 *      1 request JS) và có đúng "chữ ký" (signature) của đúng file đó.
 *   6. Toàn bộ vendor asset (/public/vendor/**) có mặt trên đĩa.
 *
 * Dùng: `npm run check-static-assets` (hoặc `node scripts/check-static-assets.js`).
 * Thoát mã khác 0 nếu có bất kỳ điều kiện nào ở trên KHÔNG thoả — dùng được trong CI trước khi
 * cho phép deploy.
 */

const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const indexHtmlPath = path.join(publicDir, 'index.html');
const manifestPath = path.join(publicDir, 'asset-manifest.json');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ok  -', name);
  } else {
    failed++;
    console.log(' FAIL -', name, detail ? `\n        ${detail}` : '');
  }
}

console.log('== check-static-assets: xác minh asset build ra đúng, không HTML-giả-JS, không trùng ==\n');

if (!fs.existsSync(manifestPath)) {
  console.error(
    'FAIL - public/asset-manifest.json không tồn tại — có vẻ `npm run build` CHƯA được chạy.\n' +
    '       Chạy `npm run build` trước, rồi chạy lại script này.'
  );
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const html = fs.readFileSync(indexHtmlPath, 'utf8');

// ---------- 1 & 2: mỗi asset trong manifest phải tồn tại trên đĩa VÀ được index.html tham chiếu ----------
for (const [logicalName, urlPath] of Object.entries(manifest.assets)) {
  const diskPath = path.join(publicDir, urlPath.replace(/^\//, ''));
  check(`${logicalName}: file đã-hash tồn tại trên đĩa (${urlPath})`, fs.existsSync(diskPath));

  const tagCount = html.split(urlPath).length - 1;
  check(`${logicalName}: index.html tham chiếu ĐÚNG 1 lần tới ${urlPath}`, tagCount === 1,
    `tìm thấy ${tagCount} lần trong index.html`);
}

// ---------- 3: không có logical script nào bị nạp trùng dưới URL KHÁC (vd tên cũ còn sót) ----------
const CORE_NAMES = ['boot.js', 'storage.js', 'imageStorage.js', 'config.js', 'formulas.js',
  'subjects.js', 'solid3d.js', 'geo2d-engine.js', 'app.js'];
for (const name of CORE_NAMES) {
  const stem = name.replace(/\.js$/, '');
  const re = new RegExp(`src="/js/${stem}(?:\\.[0-9a-f]{10})?\\.js(?:\\?[^"]*)?"`, 'g');
  const matches = html.match(re) || [];
  check(`${name}: KHÔNG bị nạp trùng (chỉ 1 thẻ <script> cho file này, dù tên cũ/mới)`,
    matches.length === 1, `tìm thấy ${matches.length} thẻ: ${matches.join(', ')}`);
}

// ---------- 4: không có <script src> hay <link href> trỏ ra CDN bên thứ 3 ngoài ý muốn ----------
const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
const linkHrefs = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
const ALLOWED_EXTERNAL_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
function originOf(url) {
  try { return new URL(url).origin; } catch (e) { return null; }
}
for (const src of scriptSrcs) {
  const isExternal = /^https?:\/\//.test(src);
  check(`<script src="${src}"> không phải CDN bên thứ 3`, !isExternal,
    'mọi thư viện chức năng phải tự host trong /vendor (PHẦN 6) — không được quay lại CDN ngoài');
}
for (const href of linkHrefs) {
  const isExternal = /^https?:\/\//.test(href);
  if (!isExternal) continue;
  const allowed = ALLOWED_EXTERNAL_ORIGINS.includes(originOf(href));
  check(`<link href="${href}"> chỉ được là Google Fonts (ngoại lệ CSS font, không phải thư viện chức năng)`, allowed);
}

// ---------- 5: nội dung mỗi file JS core KHÔNG bắt đầu bằng HTML + đúng "chữ ký" ----------
const SIGNATURES = {
  'storage.js': 'createDocStore',
  'solid3d.js': 'ACTIVE_3D',
  'app.js': '__appBooted',
  'boot.js': '__appBooted = false',
};
for (const [logicalName, urlPath] of Object.entries(manifest.assets)) {
  if (!logicalName.endsWith('.js')) continue;
  const diskPath = path.join(publicDir, urlPath.replace(/^\//, ''));
  if (!fs.existsSync(diskPath)) continue; // đã báo FAIL ở bước 1, không lặp lại lỗi
  const content = fs.readFileSync(diskPath, 'utf8');
  const trimmed = content.trimStart();
  check(`${logicalName}: nội dung KHÔNG bắt đầu bằng HTML (không phải server trả nhầm index.html)`,
    !/^</.test(trimmed) || trimmed.startsWith('<!--'),
    `100 ký tự đầu: ${JSON.stringify(content.slice(0, 100))}`);
  if (SIGNATURES[logicalName]) {
    check(`${logicalName}: chứa đúng "chữ ký" mong đợi ("${SIGNATURES[logicalName]}")`,
      content.includes(SIGNATURES[logicalName]));
  }
}

// ---------- 6: vendor assets tham chiếu trong index.html tồn tại trên đĩa ----------
const vendorRefs = [...scriptSrcs, ...linkHrefs].filter((s) => s.startsWith('/vendor/'));
for (const ref of vendorRefs) {
  const diskPath = path.join(publicDir, ref.replace(/^\//, ''));
  check(`vendor asset tồn tại trên đĩa: ${ref}`, fs.existsSync(diskPath));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('RESULT: PASS');
